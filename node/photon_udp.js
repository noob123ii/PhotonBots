'use strict';

// Photon UDP (eNet-style) client — the protocol real GT clients speak.
// Rebuilt from the game's decompiled Photon3Unity3D.dll (EnetPeer/NCommand).
// Datagram: [peerID:2][flags:1][cmdCount:1][time:4][challenge:4][commands...]
// Command: [type:1][channel:1][flags:1][reserved:1][size:4][reliableSeq:4][...]

const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { T18, serParams, Reader18 } = require('./gpbinary18');

// Oakley 768-bit prime + generator 22, from the game's DiffieHellmanCryptoProvider
const OAKLEY_PRIME_768 = BigInt('0x' + Buffer.from([
  255,255,255,255,255,255,255,255,201,15,218,162,33,104,194,52,196,198,98,139,
  128,220,28,209,41,2,78,8,138,103,204,116,2,11,190,166,59,19,155,34,81,74,
  8,121,142,52,4,221,239,149,25,179,205,58,67,27,48,43,10,109,242,95,20,55,
  79,225,53,109,109,81,194,69,228,133,181,118,98,94,126,198,244,76,66,233,
  166,58,54,32,255,255,255,255,255,255,255,255
]).toString('hex'));
const DH_GENERATOR = 22n;

function bigIntToBytesBE(n) {
  if (n === 0n) return Buffer.from([0]);
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

const CT_ACK = 1;
const CT_CONNECT = 2;
const CT_VERIFYCONNECT = 3;
const CT_DISCONNECT = 4;
const CT_PING = 5;
const CT_SENDRELIABLE = 6;
const CT_SENDUNRELIABLE = 7;
const CT_SENDFRAGMENT = 8;
const CT_SENDUNSEQUENCED = 11;
const CT_SENDRELIABLE_ENCRYPTED = 14;
const CT_SENDFRAGMENT_ENCRYPTED = 15;
const CT_ACK_UNSEQUENCED = 16;

const MTU = 1200;
const CHANNEL_COUNT = 3; // real client sends 3 (captured from live GT traffic)

class PhotonUdp extends EventEmitter {
  constructor(log) {
    super();
    this.log = log || (() => {});
    this.sock = null;
    this.connected = false;
    this.peerID = -1; // 0xFFFF during connect
    this.challenge = (Math.random() * 0x7fffffff) | 0;
    this.startTime = Date.now();
    this.host = null;
    this.port = null;

    this.outSeq = new Array(256).fill(0);       // per-channel outgoing reliable seq
    this.outUnrelSeq = new Array(256).fill(0);  // per-channel outgoing unreliable seq (server drops non-increasing)
    this.inSeq = new Array(256).fill(0);        // per-channel incoming reliable seq delivered
    this.pendingIn = new Map();                 // channel -> Map(seq -> payload) out-of-order buffer
    this.sentReliable = new Map();              // key channel:seq -> {buf, time, tries}
    this.acks = [];                             // pending 20-byte ack buffers
    this.fragments = new Map();                 // startSeq -> {count, total, parts, channel}
    this._flushTimer = null;
    this._resendTimer = null;
    this._pingTimer = null;
    this._lastSent = Date.now();
  }

  timeInt() { return (Date.now() - this.startTime) & 0x7fffffff; }

  connectUdp(address, appId) {
    const [host, portStr] = address.split(':');
    this.host = host;
    this.port = parseInt(portStr, 10);
    this.appId = appId || 'LoadBalancing';
    return new Promise((resolve, reject) => {
      this.sock = dgram.createSocket('udp4');
      this.sock.on('message', (msg) => this._onDatagram(msg));
      this.sock.on('error', (e) => this.emit('socketError', e));
      const timer = setTimeout(() => reject(new Error('udp connect timeout')), 10000);
      this.sock.connect(this.port, this.host, () => {
        this._sendConnect();
        this._flushTimer = setInterval(() => this._flushAcks(), 15);
        this._resendTimer = setInterval(() => this._resend(), 50);
        this._pingTimer = setInterval(() => {
          if (Date.now() - this._lastSent > 2000) this._queueCommand(CT_PING, 0xff, null, true);
        }, 1000);
        const onVerify = () => {
          clearTimeout(timer);
          this.connected = true;
          // the real client sends a 41-byte Init message (GpBinaryV18, client
          // version 4.1.8.15) as its FIRST op, before anything else
          this._sendInitMessage();
          this._startKeyExchange();
          resolve();
        };
        this.once('verified', onVerify);
      });
    });
  }

  _sendInitMessage() {
    const init = Buffer.alloc(41);
    init[0] = 0xf3;
    init[1] = 0;
    init[2] = 1; init[3] = 8;              // GpBinaryV18 (live client, captured)
    init[4] = 30;                          // ClientSdkId 15 << 1
    init[5] = (4 << 4) | 1;                // clientVersion 4.1.x.x packed
    init[6] = 8; init[7] = 15;             // 4.1.8.15
    init[8] = 0;
    const id = Buffer.from(this.appId, 'ascii');
    id.copy(init, 9, 0, Math.min(32, id.length));
    this._queueCommand(CT_SENDRELIABLE, 0, init, true);
  }

  _startKeyExchange() {
    // DiffieHellmanCryptoProvider: secret 160-bit, pub = 22^secret mod p
    const secretBytes = crypto.randomBytes(20);
    this.dhSecret = BigInt('0x' + secretBytes.toString('hex'));
    const pub = modPow(DH_GENERATOR, this.dhSecret, OAKLEY_PRIME_768);
    const pubBytes = bigIntToBytesBE(pub);
    // internal op request: F3 06 <op=0> params{1: pubkey}
    const payload = Buffer.concat([Buffer.from([0xf3, 6, 0]), serParams({ 1: pubBytes })]);
    this._queueCommand(CT_SENDRELIABLE, 0, payload, true);
  }

  _finishKeyExchange(serverPubBytes) {
    const serverPub = BigInt('0x' + serverPubBytes.toString('hex'));
    const shared = modPow(serverPub, this.dhSecret, OAKLEY_PRIME_768);
    this.aesKey = crypto.createHash('sha256').update(bigIntToBytesBE(shared)).digest();
    this._encryptionReady = true;
    this.emit('encryptionReady');
  }

  _packet(commands) {
    const head = Buffer.alloc(12);
    head.writeInt16BE(this.peerID, 0);
    head[2] = 0; // flags
    head[3] = commands.length;
    head.writeUInt32BE(this.timeInt(), 4);
    head.writeInt32BE(this.challenge, 8);
    return Buffer.concat([head, ...commands]);
  }

  _sendRaw(buf) {
    this._lastSent = Date.now();
    try { this.sock.send(buf); } catch {}
  }

  _sendConnect() {
    const payload = Buffer.alloc(32);
    payload.writeUInt16BE(MTU, 2);
    payload[6] = 128;
    payload[11] = CHANNEL_COUNT;
    payload[22] = 19;
    payload[23] = 136;
    payload[27] = 2;
    payload[31] = 2;
    const cmd = Buffer.alloc(12 + 32);
    cmd[0] = CT_CONNECT;
    cmd[1] = 0xff;
    cmd[2] = 1; // reliable
    cmd[3] = 4;
    cmd.writeUInt32BE(44, 4);
    cmd.writeUInt32BE(++this.outSeq[0xff] || (this.outSeq[0xff] = 1), 8);
    payload.copy(cmd, 12);
    this.sentReliable.set(`255:${this.outSeq[0xff]}`, { buf: this._packet([cmd]), time: Date.now(), tries: 1 });
    this._sendRaw(this._packet([cmd]));
  }

  _queueCommand(type, channel, payload, reliable) {
    const FRAG_LEN = 1000;
    if (payload && payload.length + 12 > FRAG_LEN && reliable) {
      // outbound fragmentation (command type 8, 20-byte fragment header)
      const startSeq = this.outSeq[channel] + 1;
      const fragCount = Math.ceil(payload.length / FRAG_LEN);
      for (let i = 0, fragNum = 0; i < payload.length; i += FRAG_LEN, fragNum++) {
        const part = payload.slice(i, Math.min(i + FRAG_LEN, payload.length));
        const size = 32 + part.length;
        const cmd = Buffer.alloc(size);
        cmd[0] = CT_SENDFRAGMENT;
        cmd[1] = channel;
        cmd[2] = 1;
        cmd[3] = 0;
        cmd.writeUInt32BE(size, 4);
        cmd.writeUInt32BE(++this.outSeq[channel], 8);
        cmd.writeUInt32BE(startSeq, 12);
        cmd.writeUInt32BE(fragCount, 16);
        cmd.writeUInt32BE(fragNum, 20);
        cmd.writeUInt32BE(payload.length, 24);
        cmd.writeUInt32BE(i, 28);
        part.copy(cmd, 32);
        const packet = this._packet([cmd]);
        this.sentReliable.set(`${channel}:${this.outSeq[channel]}`, { buf: packet, time: Date.now(), tries: 1 });
        this._sendRaw(packet);
      }
      return;
    }
    // unreliable commands: 16-byte header [base 12][unreliableSequenceNumber:4].
    // captured from the live client: the offset-8 field carries the channel's
    // CURRENT reliable seq (NOT incremented — server discards the command as a
    // stale duplicate if it's behind), offset-12 carries an incrementing
    // per-channel unreliable counter, reserved byte is 0 (4 on reliable).
    const headerSize = type === CT_SENDUNRELIABLE ? 16 : 12;
    const size = headerSize + (payload ? payload.length : 0);
    const cmd = Buffer.alloc(size);
    cmd[0] = type;
    cmd[1] = channel;
    cmd[2] = reliable ? 1 : 0;
    cmd[3] = reliable ? 4 : 0;
    cmd.writeUInt32BE(size, 4);
    let seq = this.outSeq[channel];
    if (reliable) seq = ++this.outSeq[channel];
    cmd.writeUInt32BE(seq, 8);
    if (type === CT_SENDUNRELIABLE) cmd.writeUInt32BE(++this.outUnrelSeq[channel], 12);
    if (payload) payload.copy(cmd, headerSize);
    const packet = this._packet([cmd]);
    if (reliable) this.sentReliable.set(`${channel}:${seq}`, { buf: packet, time: Date.now(), tries: 1 });
    this._sendRaw(packet);
  }

  sendOp(opCode, params, encrypt, channel = 0, reliable = true) {
    const body = Buffer.concat([Buffer.from([opCode]), serParams(params)]);
    let payload;
    if (encrypt && this._encryptionReady) {
      const cipher = crypto.createCipheriv('aes-256-cbc', this.aesKey, Buffer.alloc(16));
      const enc = Buffer.concat([cipher.update(body), cipher.final()]);
      payload = Buffer.concat([Buffer.from([0xf3, 0x02 | 0x80]), enc]);
    } else {
      payload = Buffer.concat([Buffer.from([0xf3, 0x02]), body]);
    }
    this._queueCommand(reliable ? CT_SENDRELIABLE : CT_SENDUNRELIABLE, channel, payload, reliable);
  }

  _ack(channel, seq, sentTime) {
    const ack = Buffer.alloc(20);
    ack[0] = CT_ACK;
    ack[1] = channel;
    ack[2] = 0;
    ack[3] = 4;
    ack.writeUInt32BE(20, 4);
    ack.writeUInt32BE(0, 8);
    ack.writeUInt32BE(seq, 12);
    ack.writeUInt32BE(sentTime, 16);
    this.acks.push(ack);
  }

  _flushAcks() {
    if (!this.acks.length) return;
    const acks = this.acks.splice(0, this.acks.length);
    this._sendRaw(this._packet(acks));
  }

  _resend() {
    const now = Date.now();
    for (const [key, cmd] of this.sentReliable) {
      const wait = Math.min(100 * Math.pow(2, cmd.tries - 1), 2000);
      if (now - cmd.time > wait) {
        if (cmd.tries > 12) {
          this.sentReliable.delete(key);
          this.emit('closed', 'timeout');
          this.close();
          return;
        }
        cmd.tries++;
        cmd.time = now;
        this._sendRaw(cmd.buf);
      }
    }
  }

  _onDatagram(msg) {
    if (msg.length < 12) return;
    const cmdCount = msg[3];
    const serverTime = msg.readUInt32BE(4);
    const challenge = msg.readInt32BE(8);
    if (challenge !== this.challenge) return;
    let off = 12;
    for (let i = 0; i < cmdCount && off + 12 <= msg.length; i++) {
      const type = msg[off];
      const channel = msg[off + 1];
      const flags = msg[off + 2];
      const size = msg.readUInt32BE(off + 4);
      const seq = msg.readUInt32BE(off + 8);
      const reliable = (flags & 1) !== 0;
      // unreliable/unsequenced commands have a 16-byte header (captured from live traffic)
      const bodyOff = (type === CT_SENDUNRELIABLE || type === CT_SENDUNSEQUENCED) ? off + 16 : off + 12;
      const body = msg.slice(bodyOff, off + size);

      // debug: dump raw wire layout of the first few unreliable commands so we
      // can match the real client's format byte-for-byte
      if ((type === CT_SENDUNRELIABLE || type === CT_SENDUNSEQUENCED) && (this._dbgUnrel || 0) < 6) {
        this._dbgUnrel = (this._dbgUnrel || 0) + 1;
        this.log(`[dbg] rx cmd type=${type} ch=${channel} flags=${flags} reserved=${msg[off + 3]} size=${size} seq@8=${seq} word@12=${msg.readUInt32BE(off + 12)} hex=${msg.slice(off, off + Math.min(size, 48)).toString('hex')}`);
      }

      if (reliable && type !== CT_ACK && type !== CT_ACK_UNSEQUENCED) {
        this._ack(channel, seq, serverTime);
      }

      switch (type) {
        case CT_VERIFYCONNECT: {
          this.peerID = body.readInt16BE(0);
          // server acks our connect; drop it from sent list
          this.sentReliable.clear();
          this.emit('verified');
          break;
        }
        case CT_DISCONNECT: {
          this.emit('closed', 'server disconnect');
          this.close();
          return;
        }
        case CT_ACK:
        case CT_ACK_UNSEQUENCED: {
          const ackSeq = body.length >= 8 ? body.readUInt32BE(0) : msg.readUInt32BE(off + 12);
          this.sentReliable.delete(`${channel}:${ackSeq}`);
          break;
        }
        case CT_SENDRELIABLE:
        case CT_SENDUNRELIABLE:
        case CT_SENDUNSEQUENCED: {
          this._deliver(channel, seq, reliable, body);
          break;
        }
        case CT_SENDFRAGMENT:
        case CT_SENDFRAGMENT_ENCRYPTED: {
          const startSeq = msg.readUInt32BE(off + 12);
          const fragCount = msg.readUInt32BE(off + 16);
          const fragNum = msg.readUInt32BE(off + 20);
          const total = msg.readUInt32BE(off + 24);
          const part = msg.slice(off + 32, off + size);
          // every fragment consumes its own reliable sequence slot
          this._consumeSeq(channel, seq, reliable, null);
          let fr = this.fragments.get(startSeq);
          if (!fr) { fr = { count: fragCount, total, parts: new Map(), channel }; this.fragments.set(startSeq, fr); }
          fr.parts.set(fragNum, part);
          if (fr.parts.size === fr.count) {
            const whole = Buffer.concat([...fr.parts.keys()].sort((a, b) => a - b).map((k) => fr.parts.get(k)));
            this.fragments.delete(startSeq);
            this._handleMessage(whole);
          }
          break;
        }
        default:
          break;
      }
      off += size;
    }
  }

  _deliver(channel, seq, reliable, payload) {
    if (!reliable) {
      this._handleMessage(payload);
      return;
    }
    this._consumeSeq(channel, seq, reliable, payload);
  }

  _consumeSeq(channel, seq, reliable, payload) {
    if (!reliable) return;
    if (seq <= this.inSeq[channel]) return; // duplicate
    if (!this.pendingIn.has(channel)) this.pendingIn.set(channel, new Map());
    this.pendingIn.get(channel).set(seq, payload);
    // drain in order (payload === null marks fragment slots: consume, deliver nothing)
    for (;;) {
      const next = this.inSeq[channel] + 1;
      const m = this.pendingIn.get(channel);
      if (!m.has(next)) break;
      const buf = m.get(next);
      m.delete(next);
      this.inSeq[channel] = next;
      if (buf !== null) this._handleMessage(buf);
    }
  }

  _handleMessage(payload) {
    try {
      if (payload.length < 2 || payload[0] !== 0xf3) return;
      let type = payload[1];
      let body = payload;
      if (type & 0x80) {
        // encrypted payload: decrypt everything after the 2-byte head
        if (!this._encryptionReady) return;
        const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, Buffer.alloc(16));
        const dec = Buffer.concat([decipher.update(payload.slice(2)), decipher.final()]);
        type = type & 0x7f;
        body = Buffer.concat([payload.slice(0, 2), dec]);
      } else {
        type = type & 0x7f;
      }
      const r = new Reader18(body, 2);
      if (type === 3) {
        const opCode = r.u8();
        const returnCode = r.i16le();
        let debugMessage = null;
        if (r.pos < body.length) {
          const t = body[r.pos];
          if (t === T18.String || t === T18.Null) debugMessage = r.value();
        }
        let params = {};
        try { params = r.params(); } catch (pe) { this.emit('protocolError', pe); }
        this.emit('opResponse', { opCode, returnCode, debugMessage, params });
      } else if (type === 4) {
        const code = r.u8();
        let params = {};
        try { params = r.params(); } catch (pe) { this.emit('protocolError', pe); }
        this.emit('event', { code, params });
      } else if (type === 7) {
        // internal op response: InitEncryption carries the server's public key
        const opCode = r.u8();
        r.i16le();
        if (r.pos < body.length) {
          const t = body[r.pos];
          if (t === T18.String || t === T18.Null) r.value(); // debugMessage slot
        }
        let params = {};
        try { params = r.params(); } catch (pe) { this.emit('protocolError', pe); }
        if (opCode === 0 && params[1]) this._finishKeyExchange(params[1]);
        this.emit('internalResponse', { opCode, params });
      } else {
        this.emit('rawMessage', { type, data: body });
      }
    } catch (e) {
      this.emit('protocolError', e);
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._flushTimer);
    clearInterval(this._resendTimer);
    clearInterval(this._pingTimer);
    try { this.sock && this.sock.close(); } catch {}
    this.connected = false;
    this.emit('closed');
  }
}

module.exports = { PhotonUdp };
