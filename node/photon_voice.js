'use strict';

// Photon Voice client + soundboard pipeline for Gorilla Tag.
// Reverse-engineered from the decompiled game (D:\latest space - ratman4080):
//
//   - voice rides a SEPARATE Photon connection/app: AppIdVoice c5fddf06-...
//     (Resources/PhotonAuthenticatorSettings.asset), same AppVersion + auth
//     dict as PUN (PhotonVoiceNetwork.Connect copies PUN settings/auth)
//   - voice room name = "<roomName>_voice_" (PhotonVoiceNetwork.VoiceRoomNameSuffix),
//     joined with JoinMode.CreateIfNotExists, room IsVisible=false
//   - stream announced with event 202 (VoiceEvent.Code), reliable, channel 2:
//       object[] { (byte)0, (byte)1 /*VoiceInfo subcode*/, object[] { infoDict } }
//     infoDict = Dictionary<byte,object> (PhotonTransportProtocol.EventParam):
//       1 VoiceId, 2 SamplingRate, 3 Channels, 4 FrameDurationUs, 5 Bitrate,
//       6-9 video zeros, 10 UserData, 11 EventNumber, 12 Codec
//   - UserData = rig PhotonView id (PhotonVoiceView sets recorder.UserData =
//     photonView.ViewID; remote clients late-link the voice to the rig speaker)
//   - frames sent with event 203 (VoiceEvent.FrameCode), unreliable, channel 2:
//       byte[] [ dataOffset=4, voiceId, evNumber, flags, ...opusData ]
//     (LoadBalancingTransport2.SendFrame), evNumber wraps at 256
//   - codec from VoiceSettings.asset: Opus 16000 Hz mono, 60 ms frames,
//     ~20 kbps, unencrypted, interest group 0, no config frame for Opus

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const OpusScript = require('opusscript');
const { GTSession, PC } = require('./gt_session');

function resolveFfmpeg() {
  const local = path.join(__dirname, '..', 'ffmpeg.exe');
  if (fs.existsSync(local)) return local;
  try {
    const installer = require('@ffmpeg-installer/ffmpeg');
    if (installer?.path && fs.existsSync(installer.path)) return installer.path;
  } catch {}
  return 'ffmpeg';
}

const VOICE_APP_ID = 'c5fddf06-024c-41f9-81ec-9411dc9c1b27';
const VOICE_ROOM_SUFFIX = '_voice_';

const SAMPLING_RATE = 16000;
const CHANNELS = 1;
const FRAME_DURATION_US = 60000;
const BITRATE = 20000;
const FRAME_SAMPLES = (SAMPLING_RATE * FRAME_DURATION_US) / 1000000; // 960
const FRAME_BYTES = FRAME_SAMPLES * 2; // s16le mono
const FRAME_MS = FRAME_DURATION_US / 1000; // 60

const CODEC_AUDIO_OPUS = 11;
const VOICE_CHANNEL = 2; // 1 + index of AudioOpus in Codec enum (Raw=1, AudioOpus=11)
const EV_VOICE = 202;
const EV_VOICE_FRAME = 203;
const VOICE_ID = 1;
const JOIN_MODE_CREATE_IF_NOT_EXISTS = 1;

const OPUS_SET_BITRATE = 4002;

const OP_RAISE_EVENT = 253;
const OP_JOIN_GAME = 226;

// ---------------------------------------------------------------- audio pipeline

// any media file -> s16le 16 kHz mono PCM via ffmpeg
function decodeToPcm(file, volume = 0.7) {
  const ffmpegBin = resolveFfmpeg();
  const vol = Math.max(0.05, Math.min(2, Number(volume) || 0.7));
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin, [
      '-hide_banner', '-v', 'error',
      '-i', file,
      '-af', `volume=${vol}`,
      '-f', 's16le', '-acodec', 'pcm_s16le',
      '-ar', String(SAMPLING_RATE), '-ac', String(CHANNELS),
      'pipe:1'
    ]);
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', (e) => reject(new Error(`ffmpeg failed to start (${e.message}) — is ffmpeg installed?`)));
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 300)}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

// PCM -> array of opus frames (60 ms each), tail padded with silence
function encodePcm(pcm, log) {
  const enc = new OpusScript(SAMPLING_RATE, CHANNELS, OpusScript.Application.VOIP);
  try { enc.encoderCTL(OPUS_SET_BITRATE, BITRATE); } catch {}
  const frames = [];
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    let chunk = pcm.slice(off, off + FRAME_BYTES);
    if (chunk.length < FRAME_BYTES) {
      chunk = Buffer.concat([chunk, Buffer.alloc(FRAME_BYTES - chunk.length)]);
    }
    frames.push(Buffer.from(enc.encode(chunk, FRAME_SAMPLES)));
  }
  if (log) log(`encoded ${frames.length} opus frames (${(frames.length * FRAME_MS / 1000).toFixed(1)}s)`);
  return frames;
}

// full file -> opus frames, ready to transmit
async function prepareSound(file, log, volume = 0.7) {
  const pcm = await decodeToPcm(file, volume);
  if (!pcm.length) throw new Error('decoded audio is empty');
  return encodePcm(pcm, log);
}

// ---------------------------------------------------------------- voice session

class VoiceSession {
  constructor({ appVersion, region, authDict, nickname, mintNonce, rigViewId }, log) {
    this.log = log || (() => {});
    this.rigViewId = rigViewId;
    this.evNumber = 0;
    this.session = new GTSession({
      appId: VOICE_APP_ID,
      appVersion,
      region,
      authDict,
      nickname,
      mintNonce
    }, log);
    this._playback = null;
    this._pump = null;
  }

  get connected() { return !!(this.session && this.session.client && this.session.client.connected); }

  // NS -> master -> join-or-create "<room>_voice_" -> game server -> join
  async join(roomName) {
    const session = this.session;
    const voiceRoom = roomName + VOICE_ROOM_SUFFIX;

    let resp = await session._authenticateOn('ns.photonengine.io:5058', session.region, false);
    const masterAddress = resp[PC.Address];
    if (!masterAddress) throw new Error('voice NS gave no master address');
    this.log(`[voice] NS ok -> master ${masterAddress}`);
    session.client.close();

    resp = await session._authenticateOn(masterAddress, null, true);
    this.log('[voice] master ok');

    const joinParams = {
      [PC.RoomName]: voiceRoom,
      215: { __byte: JOIN_MODE_CREATE_IF_NOT_EXISTS },          // JoinMode.CreateIfNotExists
      [PC.GameProperties]: { __hashtable: { 254: false } },      // IsVisible=false when created
    };

    let joinResp = await this._joinGame(joinParams, 'voice master');
    const gameAddress = joinResp[PC.Address];
    if (gameAddress && gameAddress !== masterAddress) {
      if (joinResp[PC.Token]) session.token = joinResp[PC.Token];
      session.client.close();
      this.log(`[voice] redirected -> ${gameAddress}`);
      await session._authenticateOn(gameAddress, null, true);
      joinResp = await this._joinGame(joinParams, 'voice game server');
    }

    session.roomName = voiceRoom;
    session._ingestJoin(joinResp);
    const others = [...session.actors.values()]
      .filter((a) => a.actorNr !== session.actorNr)
      .map((a) => `${a.name || '?'}(${a.actorNr})`)
      .join(', ') || '(none yet)';
    this.log(`[voice] joined ${voiceRoom} as actor ${session.actorNr}, peers=${session.actors.size - 1}: ${others}`);

    // late joiners need our stream info re-announced (the real client targets
    // the new player; a re-broadcast is equivalent and simpler — receivers
    // just drop duplicates)
    session.on('actorJoin', (info) => {
      if (info.actorNr && info.actorNr !== session.actorNr) this._announce();
    });

    // diagnostics: seeing OTHER clients' voice events proves we're in the right
    // room and shows us their exact VoiceInfo for comparison
    session.on('customEvent', (code, data, actorNr) => this._logVoiceEvent(code, data, actorNr));
    session.on('actorJoin', (info) => this.log(`[voice] actor ${info.actorNr} "${info.name || '?'}" joined voice room`));
    session.on('actorLeave', (nr) => this.log(`[voice] actor ${nr} left voice room`));

    this._announce();
    // Keep VoiceInfo fresh so late-joining / late-instantiated rigs can link speakers.
    this._announceIvl = setInterval(() => this._announce(), 4000);
    this._pump = setInterval(() => this._pumpFrames(), 20);
    return this;
  }

  _logVoiceEvent(code, data, actorNr) {
    if (code === EV_VOICE && Array.isArray(data) && data[0] === 0) {
      if (data[1] === 1 && Array.isArray(data[2])) {
        for (const info of data[2]) {
          const flat = {};
          for (const [k, v] of Object.entries(info || {})) flat[k] = v;
          this.log(`[voice] <- VoiceInfo from actor ${actorNr}: ${JSON.stringify(flat)}`);
        }
      } else if (data[1] === 2) {
        this.log(`[voice] <- VoiceRemove from actor ${actorNr}`);
      }
    } else if (code === EV_VOICE_FRAME) {
      this._rxFrames = (this._rxFrames || 0) + 1;
      if (this._rxFrames % 100 === 1) {
        this.log(`[voice] <- frames from actor ${actorNr} (${this._rxFrames} so far, last ${data ? data.length : 0}B)`);
      }
    }
  }

  _joinGame(joinParams, what) {
    const session = this.session;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { cleanup(); reject(new Error(`${what} join timeout (10s)`)); }, 10000);
      const onResp = (r) => {
        if (r.opCode !== OP_JOIN_GAME) return;
        cleanup();
        if (r.returnCode !== 0) reject(new Error(`${what} join -> ${r.returnCode}: ${r.debugMessage || ''}`));
        else resolve(r.params);
      };
      const onClose = () => { cleanup(); reject(new Error(`${what} connection closed`)); };
      const cleanup = () => {
        clearTimeout(t);
        session.client.removeListener('opResponse', onResp);
        session.client.removeListener('closed', onClose);
      };
      session.client.on('opResponse', onResp);
      session.client.once('closed', onClose);
      session.client.sendOp(OP_JOIN_GAME, joinParams);
    });
  }

  // event 202: broadcast our stream description (Opus 16k mono 60ms, userdata = rig viewId)
  // Wire types MUST match createVoiceInfoFromEventPayload casts:
  //   VoiceId/EventNumber -> (byte), Codec/SamplingRate/Channels/... -> (int)/(Codec)
  // Sending Codec as byte causes InvalidCastException on the real client.
  _announce() {
    if (!this.connected) return;
    const info = {
      __bdict: {
        1: { __byte: VOICE_ID },           // (byte) VoiceId
        2: SAMPLING_RATE | 0,              // (int)
        3: CHANNELS | 0,                   // (int)
        4: FRAME_DURATION_US | 0,          // (int)
        5: BITRATE | 0,                    // (int)
        6: 0, 7: 0, 8: 0, 9: 0,            // (int) video zeros
        10: this.rigViewId | 0,            // (int) UserData = PhotonView id
        11: { __byte: this.evNumber & 0xff }, // (byte) EventNumber
        12: CODEC_AUDIO_OPUS | 0,          // (Codec)/(int) — NOT byte
      }
    };
    const content = [{ __byte: 0 }, { __byte: 1 }, [info]]; // [marker, VoiceInfo subcode, infos]
    this.session.client.sendOp(OP_RAISE_EVENT, {
      [PC.Code]: { __byte: EV_VOICE },
      [PC.Data]: content
    }, false, VOICE_CHANNEL, true);
  }

  // replace whatever is playing with these opus frames
  play(frames, loop = true) {
    if (!frames || !frames.length) return;
    this._playback = { frames, idx: 0, nextAt: Date.now(), loop };
    this._announce();
    this.log(`[voice] play start (${frames.length} frames, loop=${loop})`);
  }

  stop() { this._playback = null; }

  _pumpFrames() {
    const pb = this._playback;
    if (!pb || !this.connected) return;
    const now = Date.now();
    // At most one frame per tick — bursting after lag gets rate-limited / dropped.
    if (pb.idx < pb.frames.length && now >= pb.nextAt) {
      this._sendFrame(pb.frames[pb.idx++]);
      pb.nextAt = Math.max(pb.nextAt + FRAME_MS, now + FRAME_MS - 5);
      this._txCount = (this._txCount || 0) + 1;
    }
    if (pb.idx >= pb.frames.length) {
      if (pb.loop) {
        pb.idx = 0;
        pb.nextAt = Date.now() + 400; // short gap between loops
        this._announce();
      } else {
        this._playback = null;
      }
    }
  }

  // event 203 (VoiceEvent.FrameCode): [dataOffset=4, voiceId, evNumber, flags=0, ...opusData]
  // — matches the live client's frames byte-for-byte (captured: f3 04 cb 02 f5 43 ...)
  _sendFrame(opus) {
    const payload = Buffer.concat([Buffer.from([4, VOICE_ID, this.evNumber & 0xff, 0]), opus]);
    this.session.client.sendOp(OP_RAISE_EVENT, {
      [PC.Code]: { __byte: EV_VOICE_FRAME },
      [PC.Data]: payload
    }, false, VOICE_CHANNEL, false);
    this.evNumber = (this.evNumber + 1) & 0xff;
    if ((this._dbgTx || 0) < 3) {
      this._dbgTx = (this._dbgTx || 0) + 1;
      this.log(`[dbg] tx frame ${payload.length}B, ev=${(this.evNumber - 1) & 0xff}`);
    }
  }

  leave() {
    if (this._pump) { clearInterval(this._pump); this._pump = null; }
    if (this._announceIvl) { clearInterval(this._announceIvl); this._announceIvl = null; }
    this._playback = null;
    try { this.session.leave(); } catch {}
  }
}

module.exports = {
  VoiceSession,
  prepareSound,
  VOICE_APP_ID,
  SAMPLING_RATE,
  FRAME_MS,
};
