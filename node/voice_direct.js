'use strict';
// Voice directly on game peer — sends VoiceInfo + Opus frames as event 202
// on the existing game Photon connection, no separate voice peer needed.

const fs = require('fs');
const { spawn } = require('child_process');
const OpusScript = require('opusscript');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const SR = 48000, CH = 1, FRAME_MS = 20;
const FRAME_US = FRAME_MS * 1000;
const FRAME_SAMPLES = SR * FRAME_MS / 1000;
const FRAME_BYTES = FRAME_SAMPLES * 2;
const BITRATE = 24000;
const VOICE_EVENT = 202;

const EVENT_SUBCODE = { VoiceInfo: 1, VoiceRemove: 2, VoiceFrame: 3 };
const EVENT_PARAM = {
  VoiceId: 1, Codec: 2, SamplingRate: 3, Channels: 4,
  FrameDurationUs: 5, Bitrate: 6, UserData: 11, EventNumber: 12
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), '[voice-direct]', ...a);

class VoiceDirectPlayer {
  constructor() {
    this.opusFrames = [];
    this._timer = null;
    this._index = 0;
  }

  async load(input) {
    if (fs.existsSync(input)) return this._loadFile(input);
    if (input.startsWith('http://') || input.startsWith('https://')) return this._loadUrl(input);
    throw new Error(`not found: ${input}`);
  }

  async _loadFile(filePath) {
    const audio = fs.readFileSync(filePath);
    const pcm = await this._decode(audio);
    this.opusFrames = this._encode(pcm);
    log(`loaded ${this.opusFrames.length} Opus frames from ${filePath}`);
  }

  async _loadUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
    const audio = Buffer.from(await resp.arrayBuffer());
    const pcm = await this._decode(audio);
    this.opusFrames = this._encode(pcm);
    log(`loaded ${this.opusFrames.length} Opus frames from ${url}`);
  }

  _decode(buf) {
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        '-i', 'pipe:0', '-f', 's16le', '-acodec', 'pcm_s16le',
        '-ac', String(CH), '-ar', String(SR), 'pipe:1'
      ]);
      const c = [];
      let errBuf = '';
      proc.stdout.on('data', d => c.push(d));
      proc.stderr.on('data', d => errBuf += d.toString());
      proc.on('close', code => {
        if (code) reject(Error(`ffmpeg exit ${code}: ${errBuf.slice(0, 200)}`));
        else resolve(Buffer.concat(c));
      });
      proc.on('error', reject);
      proc.stdin.end(buf);
    });
  }

  _encode(pcm) {
    const enc = new OpusScript(SR, CH, OpusScript.Application.VOIP);
    const out = [];
    for (let off = 0; off + FRAME_BYTES <= pcm.length; off += FRAME_BYTES)
      out.push(Buffer.from(enc.encode(pcm.slice(off, off + FRAME_BYTES), FRAME_SAMPLES)));
    enc.delete();
    return out;
  }

  startOnGamePeer(session, gameUserId) {
    if (!this.opusFrames.length) { log('no audio loaded'); return; }
    const vp = session.client;
    const tag = `actor${session.actorNr}`;

    // Send VoiceInfo via game peer event 202 (subcode 1)
    const voiceInfoDict = {
      __dict: {
        [EVENT_PARAM.VoiceId]: { __byte: 0 },
        [EVENT_PARAM.Codec]: 0,
        [EVENT_PARAM.SamplingRate]: SR,
        [EVENT_PARAM.Channels]: CH,
        [EVENT_PARAM.FrameDurationUs]: { __long: FRAME_US },
        [EVENT_PARAM.Bitrate]: BITRATE,
        [EVENT_PARAM.UserData]: gameUserId || session.userId || '',
        [EVENT_PARAM.EventNumber]: { __byte: 0 }
      },
      __keyType: 3
    };

    const voiceInfoPayload = [
      { __byte: 0 },
      { __byte: EVENT_SUBCODE.VoiceInfo },
      [voiceInfoDict]
    ];

    log(`${tag}: sending VoiceInfo on GAME peer (event 202)...`);
    vp.sendOp(253, {
      244: { __byte: VOICE_EVENT },
      245: voiceInfoPayload,
      250: { __byte: 1 }
    }, false, true);
    log(`${tag}: VoiceInfo sent`);

    // Start streaming audio frames
    this._index = 0;
    let frameCount = 0;
    let evNum = 1;

    this._timer = setInterval(() => {
      if (!vp.connected) {
        clearInterval(this._timer); this._timer = null;
        log(`${tag}: stopped (disconnected)`);
        return;
      }
      const idx = this._index;
      const frame = this.opusFrames[idx];
      if (!frame) {
        this._index = 0;
        frameCount = 0; evNum = 1;
        return;
      }
      this._index = (idx + 1) % this.opusFrames.length;

      const flags = frameCount === 0 ? { __byte: 1 } : { __byte: 0 };
      try {
        vp.sendOp(253, {
          244: { __byte: VOICE_EVENT },
          245: [
            { __byte: 0 },        // voiceId
            { __byte: 3 },        // subcode = 3 (VoiceFrame)
            { __byte: evNum++ },  // eventNumber
            frame,
            flags
          ],
          250: { __byte: 1 }
        }, false, false);
      } catch (e) {
        log(`${tag}: sendOp failed: ${e.message}`);
        clearInterval(this._timer); this._timer = null;
        return;
      }
      frameCount++;
    }, FRAME_MS);

    log(`${tag}: streaming started`);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    log('stopped');
  }
}

module.exports = { VoiceDirectPlayer };
