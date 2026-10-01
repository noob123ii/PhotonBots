'use strict';

// High-level Gorilla Tag lobby session over Photon binary WebSocket.
// Flow: NS authenticate -> master authenticate -> JoinRandomGame ->
// game server authenticate(token) -> JoinGame -> in-room events.

const { EventEmitter } = require('events');
const { PhotonWs } = require('./photon_ws');
const { PhotonUdp } = require('./photon_udp');

const PC = {
  ApplicationId: 224, AppVersion: 220, Region: 210,
  ClientAuthenticationType: 217, ClientAuthenticationParams: 216, ClientAuthenticationData: 214,
  Token: 221, Address: 230, RoomName: 255, ActorNr: 254, ActorList: 252,
  PlayerProperties: 249, GameProperties: 248, UserId: 225, NickName: 202,
  Data: 245, Code: 244, Broadcast: 250, Cache: 247, ReceiverGroup: 246, Group: 240,
  JoinMode: 215 // NOT 223 (223 = MatchMakingType) — voice client uses 215
};

const OP_AUTHENTICATE = 230;
const OP_JOIN_RANDOM_GAME = 225;
const OP_JOIN_GAME = 226;
const OP_LEAVE = 254;
const OP_RAISE_EVENT = 253;

const NS_ADDRESS_WS = 'ns.photonengine.io:19093';
const NS_ADDRESS_UDP = 'ns.photonengine.io:5058';

function waitOp(client, opCode, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error(`op ${opCode} timeout`)); }, timeoutMs);
    const onResp = (r) => {
      if (r.opCode !== opCode) return;
      cleanup();
      if (r.returnCode !== 0) {
        const paramsStr = r.params ? JSON.stringify(r.params).slice(0, 300) : '';
        reject(new Error(`op ${opCode} -> ${r.returnCode}: ${r.debugMessage || ''} params=${paramsStr}`));
      } else {
        resolve(r.params);
      }
    };
    const onClose = () => { cleanup(); reject(new Error(`op ${opCode} aborted (closed)`)); };
    const cleanup = () => {
      clearTimeout(t);
      client.removeListener('opResponse', onResp);
      client.removeListener('closed', onClose);
    };
    client.on('opResponse', onResp);
    client.once('closed', onClose);
  });
}

class GTSession extends EventEmitter {
  constructor({ appId, appVersion, region, authDict, nickname, mintNonce, authType }, log) {
    super();
    this.appId = appId;
    this.appVersion = appVersion;
    this.region = region;
    this.authDict = authDict;
    this.nickname = nickname || 'tracker';
    // tickets are single-use: every full auth needs a freshly minted nonce
    this.mintNonce = mintNonce || null;
    this.authType = authType != null ? authType : 0;
    this.transport = 'udp'; // real clients ride UDP; WS masters are ghost towns
    this.log = log || (() => {});
    this.client = null;
    this.token = null;
    this.userId = null;
    this.actorNr = null;
    this.roomName = null;
    this.actors = new Map();
    this.aborted = false;
  }

  // force-kill all connections immediately — unblocks any pending waitOp
  abort() {
    this.aborted = true;
    try { this.client && this.client.close(); } catch {}
  }

  _authParams(region) {
    const p = {
      [PC.ApplicationId]: this.appId,
      [PC.AppVersion]: this.appVersion,
      [PC.ClientAuthenticationType]: { __byte: this.authType }
    };
    if (this.authType === 0 && this.authDict) {
      p[PC.ClientAuthenticationData] = { __dict: this.authDict };
    }
    p[PC.Region] = region || 'usw';
    return p;
  }

  async _authenticateOn(address, region, useToken) {
    const client = this.transport === 'udp' ? new PhotonUdp(this.log) : new PhotonWs(this.log);
    this.client = client;
    client.on('event', (e) => this._onEvent(e));
    client.on('closed', (code, reason) => this.emit('closed', code, reason));
    client.on('protocolError', (e) => this.log('[photon] protocol:', e.message));
    if (this.transport === 'udp') {
      // captured from the live client: NS connections init with "NameServer",
      // master/game connections init with the actual app id
      await client.connectUdp(address, region ? 'NameServer' : this.appId);
      // the server kicks plaintext auth ops - wait for the DH exchange
      if (!client._encryptionReady) {
        await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('encryption timeout')), 10000);
          client.once('encryptionReady', () => { clearTimeout(t); res(); });
        });
      }
    } else {
      await client.connectWs(address, this.appId);
    }

    const params = useToken && this.token
      ? { [PC.Token]: this.token }
      : this._authParams(region);

    // full auth: burn a fresh nonce ticket for THIS connection
    if (!useToken && this.mintNonce) {
      params[PC.ClientAuthenticationData] = {
        __dict: { ...this.authDict, Nonce: await this.mintNonce() }
      };
    }

    const respP = waitOp(client, OP_AUTHENTICATE);
    client.sendOp(OP_AUTHENTICATE, params, this.transport === 'udp');
    const resp = await respP;
    if (resp[PC.Token]) this.token = resp[PC.Token];
    if (resp[PC.UserId]) this.userId = resp[PC.UserId];
    return resp;
  }

  async joinRandomRoom(filterProps) {
    let resp = await this._authenticateOn(this.transport === 'udp' ? NS_ADDRESS_UDP : NS_ADDRESS_WS, this.region, false);
    const masterAddress = resp[PC.Address];
    if (!masterAddress) throw new Error('NS auth gave no master address');
    this.log(`[photon] NS ok -> master ${masterAddress}`);
    this.client.close();

    resp = await this._authenticateOn(masterAddress, null, true);
    this.log('[photon] master ok, finding random room');

    const joinP = waitOp(this.client, OP_JOIN_RANDOM_GAME);
    this.client.sendOp(OP_JOIN_RANDOM_GAME, filterProps ? { [PC.GameProperties]: { __hashtable: filterProps } } : {});
    resp = await joinP;
    this._gameAddress = resp[PC.Address];
    this.roomName = resp[PC.RoomName];
    if (resp[PC.Token]) this.token = resp[PC.Token];
    this.log(`[photon] room ${this.roomName} on ${this._gameAddress}`);
    this.client.close();

    await this._authenticateOn(this._gameAddress, null, true);
    this.log('[photon] game server ok, joining');

    const joinGameP = waitOp(this.client, OP_JOIN_GAME);
    const joinParams = { [PC.RoomName]: this.roomName };
    if (this.nickname) {
      joinParams[PC.PlayerProperties] = { __hashtable: { 255: this.nickname } };
      joinParams[PC.Broadcast] = true;
    }
    this.client.sendOp(OP_JOIN_GAME, joinParams);
    resp = await joinGameP;
    this._ingestJoin(resp);
    return { roomName: this.roomName, actors: this.actorList() };
  }

  async joinNamedRoom(roomName, joinMode = 0) {
    // GTag rooms use PlayerTTL=0 → JoinOrRejoin/RejoinOnly are rejected (-3).
    // Use Default (0). If UserId is still active from a killed bot, wait for
    // Photon's disconnect timeout then join again.
    if (!roomName) throw new Error('joinNamedRoom: no room name');

    const doJoin = async (mode) => {
      let resp = await this._authenticateOn(this.transport === 'udp' ? NS_ADDRESS_UDP : NS_ADDRESS_WS, this.region, false);
      const masterAddress = resp[PC.Address];
      if (!masterAddress) throw new Error('NS auth gave no master address');
      this.log(`[photon] NS ok -> master ${masterAddress}`);
      this.client.close();

      resp = await this._authenticateOn(masterAddress, null, true);
      this.log(`[photon] master ok, joining named room (mode=${mode})`);

      const joinP = waitOp(this.client, OP_JOIN_GAME);
      const joinParams = { [PC.RoomName]: roomName };
      if (this.nickname) {
        joinParams[PC.PlayerProperties] = { __hashtable: { 255: this.nickname, didTutorial: true } };
        joinParams[PC.Broadcast] = true;
      }
      // Only send JoinMode when non-default; GTag rejects rejoin modes
      if (mode != null && mode !== 0) joinParams[PC.JoinMode] = { __byte: mode };
      this.client.sendOp(OP_JOIN_GAME, joinParams);
      resp = await joinP;
      this._gameAddress = resp[PC.Address];
      if (resp[PC.Token]) this.token = resp[PC.Token];
      const redirect = this._gameAddress && this._gameAddress !== masterAddress;
      this.log(`[photon] master join: room=${roomName} game=${this._gameAddress}${redirect ? ' (redirect)' : ''}`);
      this.client.close();

      if (redirect) {
        await this._authenticateOn(this._gameAddress, null, true);
        this.log(`[photon] game server ok, joining (mode=${mode})`);

        const joinGameP = waitOp(this.client, OP_JOIN_GAME, 15000);
        const joinParams2 = { [PC.RoomName]: roomName };
        if (this.nickname) {
          joinParams2[PC.PlayerProperties] = { __hashtable: { 255: this.nickname, didTutorial: true } };
          joinParams2[PC.Broadcast] = true;
        }
        if (mode != null && mode !== 0) joinParams2[PC.JoinMode] = { __byte: mode };
        this.client.sendOp(OP_JOIN_GAME, joinParams2);
        resp = await joinGameP;
      }

      this.roomName = roomName;
      this._ingestJoin(resp);
      return { roomName: this.roomName, actors: this.actorList() };
    };

    try {
      return await doJoin(joinMode);
    } catch (err) {
      const msg = err.message || '';
      // Rejoin not supported in this room — fall back to normal join after wait
      if (/PlayerTTL is 0|does not support rejo/i.test(msg)) {
        this.log(`[photon] room has PlayerTTL=0 — normal join after short wait...`);
        try { this.abort(); } catch {}
        await new Promise(r => setTimeout(r, 2500));
        this.aborted = false;
        return await doJoin(0);
      }
      // Still marked present from a dead UDP peer — wait for timeout then join
      if (msg.includes('32746') || /already joined/i.test(msg) || /aborted \(closed\)/i.test(msg)) {
        this.log(`[photon] ghost UserId still in room — waiting 12s for disconnect timeout...`);
        try { this.abort(); } catch {}
        await new Promise(r => setTimeout(r, 12000));
        this.aborted = false;
        return await doJoin(0);
      }
      throw err;
    }
  }

  async createAndJoinRoom(roomName, gameProps) {
    // Create a room via op 227 (master) then op 227 (game server) — needed for voice AppId
    if (!roomName) throw new Error('createAndJoinRoom: no room name');
    let resp = await this._authenticateOn(this.transport === 'udp' ? NS_ADDRESS_UDP : NS_ADDRESS_WS, this.region, false);
    const masterAddress = resp[PC.Address];
    if (!masterAddress) throw new Error('NS auth gave no master address');
    this.log(`[photon] NS ok -> master ${masterAddress}`);
    this.client.close();

    resp = await this._authenticateOn(masterAddress, null, true);
    this.log('[photon] master ok, creating & joining room');

    // Op 227 = CreateGame
    const createP = waitOp(this.client, 227);
    const createParams = { [PC.RoomName]: roomName };
    if (this.nickname) {
      createParams[PC.PlayerProperties] = { __hashtable: { 255: this.nickname } };
      createParams[PC.Broadcast] = true;
    }
    if (gameProps) {
      createParams[PC.GameProperties] = { __hashtable: gameProps };
    }
    this.client.sendOp(227, createParams);
    resp = await createP;
    this._gameAddress = resp[PC.Address];
    if (resp[PC.Token]) this.token = resp[PC.Token];
    const redirect = this._gameAddress && this._gameAddress !== masterAddress;
    this.log(`[photon] create: room=${roomName} game=${this._gameAddress}${redirect ? ' (redirect)' : ''}`);
    this.client.close();

    if (redirect) {
      await this._authenticateOn(this._gameAddress, null, true);
      this.log('[photon] game server ok, creating room');

      const createGameP = waitOp(this.client, 227);
      const createParams2 = { [PC.RoomName]: roomName };
      if (this.nickname) {
        createParams2[PC.PlayerProperties] = { __hashtable: { 255: this.nickname } };
        createParams2[PC.Broadcast] = true;
      }
      if (gameProps) {
        createParams2[PC.GameProperties] = { __hashtable: gameProps };
      }
      this.client.sendOp(227, createParams2);
      resp = await createGameP;
    }

    this.roomName = roomName;
    this._ingestJoin(resp);
    return { roomName: this.roomName, actors: this.actorList() };
  }

  _ingestJoin(params) {
    this.actorNr = params[PC.ActorNr];
    if (this.actorNr) this.actors.set(this.actorNr, { actorNr: this.actorNr, name: '', userId: this.userId || '' });
    // join response carries every occupant's props: {actorNr: {253: userId, 255: name}}
    const props = params[PC.PlayerProperties];
    if (props && typeof props === 'object') {
      for (const [nr, p] of Object.entries(props)) {
        const actorNr = Number(nr);
        if (!p || typeof p !== 'object') continue;
        this.actors.set(actorNr, {
          actorNr,
          name: p[255] ? String(p[255]) : '',
          userId: p[253] ? String(p[253]) : ''
        });
      }
    }
    this.emit('joined', { roomName: this.roomName, actors: this.actorList() });
  }

  _onEvent(e) {
    const { code, params } = e;
    if (code === 255) {
      const actorNr = params[PC.ActorNr];
      const info = { actorNr, name: '', userId: '' };
      const props = params[PC.PlayerProperties];
      if (props) {
        if (props[255]) info.name = String(props[255]);
        if (props[253]) info.userId = String(props[253]);
      }
      this.actors.set(actorNr, info);
      this.emit('actorJoin', info);
    } else if (code === 254) {
      const actorNr = params[PC.ActorNr];
      this.actors.delete(actorNr);
      this.emit('actorLeave', actorNr);
    } else if (code === 253) {
      const actorNr = params[PC.ActorNr];
      const props = params[251] || params[PC.PlayerProperties];
      if (actorNr && this.actors.has(actorNr) && props) {
        const cur = this.actors.get(actorNr);
        if (props[255]) cur.name = String(props[255]);
        if (props[253]) cur.userId = String(props[253]);
        this.actors.set(actorNr, cur);
      }
      this.emit('propsChanged', actorNr, props);
    } else {
      // custom events: 200 = PUN RPC
      this.emit('customEvent', code, params[PC.Data], params[PC.ActorNr]);
    }
  }

  get gameAddress() { return this._gameAddress; }

  // Join/create a room on the already-authenticated server (no reconnect)
  async _joinAfterAuth(roomName, joinMode) {
    this.log(`[photon] joining room "${roomName}" on current server...`);
    const joinP = waitOp(this.client, OP_JOIN_GAME);
    const joinParams = { [PC.RoomName]: roomName };
    if (this.nickname) {
      joinParams[PC.PlayerProperties] = { __hashtable: { 255: this.nickname } };
      joinParams[PC.Broadcast] = true;
    }
    if (joinMode != null) joinParams[PC.JoinMode] = { __byte: joinMode };
    this.client.sendOp(OP_JOIN_GAME, joinParams);
    const resp = await joinP;
    if (resp[PC.Token]) this.token = resp[PC.Token];
    this.roomName = roomName;
    this._ingestJoin(resp);
    return { roomName: this.roomName, actors: this.actorList() };
  }

  // Create a room on the already-authenticated server (no reconnect, uses op 227)
  async _createAfterAuth(roomName, gameProps) {
    this.log(`[photon] creating room "${roomName}" on current server...`);
    const createP = waitOp(this.client, 227);
    const createParams = { [PC.RoomName]: roomName };
    if (this.nickname) {
      createParams[PC.PlayerProperties] = { __hashtable: { 255: this.nickname } };
      createParams[PC.Broadcast] = true;
    }
    if (gameProps) {
      createParams[PC.GameProperties] = { __hashtable: gameProps };
    }
    this.client.sendOp(227, createParams);
    const resp = await createP;
    if (resp[PC.Token]) this.token = resp[PC.Token];
    this.roomName = roomName;
    this._ingestJoin(resp);
    return { roomName: this.roomName, actors: this.actorList() };
  }

  // Connect to NS → master, authenticate, and get a token (no room operations)
  async _authMaster(region) {
    let resp = await this._authenticateOn(this.transport === 'udp' ? NS_ADDRESS_UDP : NS_ADDRESS_WS, region, false);
    const masterAddress = resp[PC.Address];
    if (!masterAddress) throw new Error('NS auth gave no master address');
    this.log(`[photon] NS ok -> master ${masterAddress}`);
    const nsClient = this.client;
    this.client = null;
    nsClient.close();
    resp = await this._authenticateOn(masterAddress, null, true);
    this.log('[photon] master ok, got token');
    const masterClient = this.client;
    this.client = null;
    masterClient.close();
    return this.token;
  }

  // Connect directly to a game server (bypass NS/master) and join/create a room
  async joinRoomOnServer(address, roomName, joinMode) {
    if (!address) throw new Error('joinRoomOnServer: no address');
    if (!roomName) throw new Error('joinRoomOnServer: no room name');
    this.log(`[photon] connecting direct to ${address}...`);
    await this._authenticateOn(address, null, false);
    this.log('[photon] direct server auth ok, joining room');

    const joinP = waitOp(this.client, OP_JOIN_GAME);
    const joinParams = { [PC.RoomName]: roomName };
    if (this.nickname) {
      joinParams[PC.PlayerProperties] = { __hashtable: { 255: this.nickname } };
      joinParams[PC.Broadcast] = true;
    }
    if (joinMode != null) joinParams[PC.JoinMode] = { __byte: joinMode };
    this.client.sendOp(OP_JOIN_GAME, joinParams);
    const resp = await joinP;
    if (resp[PC.Token]) this.token = resp[PC.Token];
    this.roomName = roomName;
    this._ingestJoin(resp);
    return { roomName: this.roomName, actors: this.actorList() };
  }

  actorList() { return [...this.actors.values()]; }
  myActorNr() { return this.actorNr; }

  setProperties(props) {
    if (!this.client || !this.client.connected) return;
    this.client.sendOp(251, {
      251: { __hashtable: props }
    }, true, true);
  }

  leave() {
    try { if (this.client && this.client.connected) this.client.sendOp(OP_LEAVE, {}); } catch {}
    try { this.client && this.client.close(); } catch {}
  }
}

module.exports = { GTSession, PC };
