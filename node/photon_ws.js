'use strict';

// Photon binary client over secure WebSocket (GpBinaryV16 subprotocol).
// Same wire format as the game's own client, no JSON translation layer,
// so the custom-auth dictionary reaches the auth endpoint intact.
// Each WS binary message = [0xF3][msgType][code][params...].

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { T, serParams, Reader } = require('./gpbinary');

const MSG_OPERATION_RESPONSE = 3;
const MSG_EVENT = 4;
const MSG_INTERNAL_RESPONSE = 7;
const INTERNAL_OP_PING = 1;

class PhotonWs extends EventEmitter {
  constructor(log) {
    super();
    this.log = log || (() => {});
    this.ws = null;
    this.connected = false;
    this._pingTimer = null;
  }

  connectWs(serverAddress, appId) {
    return new Promise((resolve, reject) => {
      const addr = serverAddress.startsWith('wss://') || serverAddress.startsWith('ws://')
        ? serverAddress
        : `wss://${serverAddress}`;
      const sep = addr.endsWith('/') ? '' : '/';
      const url = `${addr}${sep}${appId}/?libversion=4.1.6.11&sid=30`;
      this.ws = new WebSocket(url, 'GpBinaryV16', { perMessageDeflate: false });
      const timer = setTimeout(() => { try { this.ws.terminate(); } catch {} reject(new Error('ws connect timeout')); }, 12000);

      this.ws.on('open', () => {
        clearTimeout(timer);
        this.connected = true;
        this._pingTimer = setInterval(() => this._ping(), 5000);
        resolve();
      });
      this.ws.on('message', (d) => this._onMessage(Buffer.from(d)));
      this.ws.on('error', (e) => { clearTimeout(timer); this.emit('socketError', e); if (!this.connected) reject(e); });
      this.ws.on('close', (code, reason) => {
        clearTimeout(timer);
        clearInterval(this._pingTimer);
        this.connected = false;
        this.emit('closed', code, reason && reason.toString());
      });
    });
  }

  _ping() {
    if (!this.connected) return;
    // internal op request: F3 06 <op=1> params{1: timestamp}
    const body = Buffer.concat([
      Buffer.from([0xf3, 6, INTERNAL_OP_PING]),
      serParams({ 1: Date.now() & 0x7fffffff })
    ]);
    try { this.ws.send(body); } catch {}
  }

  sendOp(opCode, params) {
    const body = Buffer.concat([Buffer.from([0xf3, 2, opCode]), serParams(params)]);
    this.ws.send(body);
  }

  _onMessage(msg) {
    try {
      if (msg.length < 2 || msg[0] !== 0xf3) {
        this.emit('rawMessage', msg);
        return;
      }
      const type = msg[1] & 0x7f;
      const r = new Reader(msg, 2);
      if (type === MSG_OPERATION_RESPONSE) {
        const opCode = r.u8();
        const returnCode = r.i16();
        let debugMessage = null;
        if (r.pos < msg.length) {
          const t = msg[r.pos];
          if (t === T.String || t === T.Null) debugMessage = r.value();
        }
        const params = r.params();
        this.emit('opResponse', { opCode, returnCode, debugMessage, params });
      } else if (type === MSG_EVENT) {
        const code = r.u8();
        const params = r.params();
        this.emit('event', { code, params });
      } else if (type === MSG_INTERNAL_RESPONSE) {
        this.emit('internalResponse', { data: msg });
      } else {
        this.emit('rawMessage', { type, data: msg });
      }
    } catch (e) {
      this.emit('protocolError', e);
    }
  }

  close() {
    clearInterval(this._pingTimer);
    try { this.ws && this.ws.close(); } catch {}
    this.connected = false;
    this.emit('closed');
  }
}

module.exports = { PhotonWs };
