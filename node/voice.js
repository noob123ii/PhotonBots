'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const OpusScript = require('opusscript');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { GTSession } = require('./gt_session');

const SR = 48000, CH = 1, FRAME_MS = 20;
const FRAME_US = FRAME_MS * 1000;
const FRAME_SAMPLES = SR * FRAME_MS / 1000;
const FRAME_BYTES = FRAME_SAMPLES * 2;
const BITRATE = 24000;
const VOICE_EVENT = 202;

const EVENT_SUBCODE = { VoiceInfo: 1, VoiceRemove: 2 };
const EVENT_PARAM = {
  VoiceId: 1, Codec: 2, SamplingRate: 3, Channels: 4,
  FrameDurationUs: 5, Bitrate: 6, UserData: 11, EventNumber: 12
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), '[voice]', ...a);

class VoicePlayer {
  constructor() {
    this.opusFrames = [];
    this._timers = {};
    this._indices = {};
    this._timerId = 0;
    this._voiceSessions = [];
  }

  async loadFile(filePath) {
    log(`reading "${filePath}"...`);
    const audio = fs.readFileSync(filePath);
    log(`read ${(audio.length / 1024).toFixed(0)} KB from disk, decoding...`);
    const pcm = await this._decode(audio);
    this.opusFrames = this._encode(pcm);
    log(`encoded ${this.opusFrames.length} Opus frames, ~${(this.opusFrames.length * FRAME_MS / 1000).toFixed(1)}s of audio`);
  }

  async loadUrl(url) {
    log(`downloading "${url}"...`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
    const audio = Buffer.from(await resp.arrayBuffer());
    log(`downloaded ${(audio.length / 1024).toFixed(0)} KB, decoding...`);
    const pcm = await this._decode(audio);
    this.opusFrames = this._encode(pcm);
    log(`encoded ${this.opusFrames.length} Opus frames`);
  }

  async load(input) {
    if (fs.existsSync(input)) return this.loadFile(input);
    if (input.startsWith('http://') || input.startsWith('https://')) return this.loadUrl(input);
    throw new Error(`not found: ${input}`);
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

  // ── Voice via separate peer (voice AppId) ────────────────────────

  async startOnAll(sessions, cfg, getBundle) {
    if (!this.opusFrames.length) { log('no audio loaded'); return; }
    let ok = 0, fail = 0;
    for (const s of sessions) {
      const r = await this._startOne(s, cfg, getBundle);
      if (r) ok++; else fail++;
    }
    log(`voice started on ${ok}/${sessions.length} bots (${fail} failed)`);
  }

  async _startOne(s, cfg, getBundle) {
    const tag = s.tag;
    if (!s.session?.roomName) { log(`skip ${tag}: no room name`); return false; }
    const bundle = getBundle(s.account.username);
    if (!bundle) { log(`skip ${tag}: no auth bundle`); return false; }

    const gameAddr = s.session.gameAddress;
    if (!gameAddr) { log(`${tag}: no game server address`); return false; }

    const voiceAppId = cfg.voiceAppId || 'c5fddf06-024c-41f9-81ec-9411dc9c1b27';
    const voiceAppVersion = cfg.photonAuthAppVersion || (cfg.photonAppVersion || '').replace(/_2\.\d+$/, '');

    const mkSession = () => new GTSession({
      appId: voiceAppId,
      appVersion: voiceAppVersion,
      region: s.session.region || 'usw',
      authDict: bundle.photonAuthDict(cfg.zones?.[0] || 'forest'),
      nickname: '',
      mintNonce: bundle.freshNonce
    }, (msg) => log(`[${tag}] ${msg}`));

    let vs = mkSession();
    let joined = false;

    // Try join first (game clients may already have a voice room)
    try {
      await vs.joinNamedRoom(s.session.roomName);
      joined = true;
      log(`${tag}: joined existing voice room`);
    } catch (e) {
      log(`${tag}: join failed (${e.message.slice(0, 60)}), creating room...`);
      try { vs.leave(); } catch {}
      vs = mkSession();
      try {
        await vs.createAndJoinRoom(s.session.roomName);
        joined = true;
        log(`${tag}: created voice room`);
      } catch (e2) {
        log(`${tag}: voice peer FAILED: ${e2.message}`);
        try { vs.leave(); } catch {}
        return false;
      }
    }

    log(`${tag}: voice peer joined as actor ${vs.actorNr}`);
    this._voiceSessions.push({ session: vs, tag });
    this._startSending(vs, tag, s.session.userId);
    return true;
  }

  _startSending(session, tag, gameUserId) {
    const id = ++this._timerId;
    this._indices[id] = 0;
    const vp = session.client;

    log(`${tag}: sending VoiceInfo on voice peer...`);

    const voiceId = 0;
    const evNumber = 0;

    const voiceInfoDict = {
      __dict: {
        [EVENT_PARAM.VoiceId]: { __byte: voiceId },
        [EVENT_PARAM.Codec]: 0,
        [EVENT_PARAM.SamplingRate]: SR,
        [EVENT_PARAM.Channels]: CH,
        [EVENT_PARAM.FrameDurationUs]: { __long: FRAME_US },
        [EVENT_PARAM.Bitrate]: BITRATE,
        [EVENT_PARAM.UserData]: gameUserId || session.userId || '',
        [EVENT_PARAM.EventNumber]: { __byte: evNumber }
      },
      __keyType: 3
    };

    const voiceInfoPayload = [
      { __byte: 0 },
      { __byte: EVENT_SUBCODE.VoiceInfo },
      [voiceInfoDict]
    ];

    log(`${tag}: VoiceInfo=${JSON.stringify(voiceInfoDict.__dict)}`);
    try {
      vp.sendOp(253, {
        244: { __byte: VOICE_EVENT },
        245: voiceInfoPayload,
        250: { __byte: 1 }
      }, true, true);
      log(`${tag}: VoiceInfo sent OK`);
    } catch (e) {
      log(`${tag}: VoiceInfo FAILED: ${e.message}`);
      return;
    }

    log(`${tag}: starting audio stream (${this.opusFrames.length} frames, ~${(this.opusFrames.length * FRAME_MS / 1000).toFixed(1)}s)`);
    let frameCount = 0;
    let evNum = 1;
    let lastLogTime = 0;
    let lastLogCount = 0;

    this._timers[id] = setInterval(() => {
      if (!vp.connected) {
        clearInterval(this._timers[id]); delete this._timers[id];
        log(`${tag}: stream STOPPED (disconnected, ${frameCount} frames sent)`);
        return;
      }

      const idx = this._indices[id];
      const frame = this.opusFrames[idx];
      if (!frame) {
        this._indices[id] = 0;
        log(`${tag}: LOOPED at ${frameCount} frames`);
        frameCount = 0;
        evNum = 1;
        lastLogTime = 0;
        lastLogCount = 0;
        return;
      }

      this._indices[id] = (idx + 1) % this.opusFrames.length;
      const isNew = frameCount === 0;
      const flags = isNew ? { __byte: 1 } : { __byte: 0 };

      try {
        vp.sendOp(253, {
          244: { __byte: VOICE_EVENT },
          245: [
            { __byte: voiceId },
            { __byte: 3 },
            { __byte: evNum++ },
            frame,
            flags
          ],
          250: { __byte: 1 }
        }, false, false);
      } catch (e) {
        log(`${tag}: sendOp FAILED at frame ${frameCount}: ${e.message}`);
        clearInterval(this._timers[id]); delete this._timers[id];
        return;
      }

      frameCount++;

      const now = Date.now();
      if (isNew || now - lastLogTime > 500) {
        const rate = frameCount - lastLogCount;
        log(`${tag}: ${frameCount} frames sent (voiceId=${voiceId}, evNum=${evNum - 1}, frame[${idx}].size=${frame.length}B, ${rate}f in ${now - lastLogTime}ms)`);
        lastLogTime = now;
        lastLogCount = frameCount;
      }
    }, FRAME_MS);

    log(`${tag}: timer #${id} created`);
  }

  stop() {
    log(`stopping voice (${Object.keys(this._timers).length} stream timers)...`);
    for (const t of Object.values(this._timers)) clearInterval(t);
    this._timers = {};
    for (const vs of this._voiceSessions) {
      try { vs.session.leave(); } catch {}
    }
    this._voiceSessions = [];
  }
}

module.exports = { VoicePlayer };
