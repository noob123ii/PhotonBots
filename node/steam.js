'use strict';

const fs = require('fs');
const path = require('path');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const proto = require('./proto');

const EMSG_CLIENT_GET_TICKET_FOR_WEBAPI = 1641; // response: 1642

// One Steam account = one session = its own tickets. Never shared.
class SteamSession {
  constructor(account, dataDir, log, proxy) {
    this.account = account;           // {username, password, sharedSecret, nickname}
    this.proxy = proxy || null;
    this.log = log || console.log;
    this.sessionFile = path.join(dataDir, 'sessions', `${account.username}.json`);
    this.steamId64 = null;
    this.loggedOn = false;

    const opts = {
      dataDirectory: path.join(dataDir, 'steam'),
      renewRefreshTokens: true,
      machineName: 'gt-tracker',
      protocol: account.tcp ? 1 : 0 // TCP gives us the CM session key (ticket research)
    };
    if (this.proxy) {
      opts.http = { proxy: this.proxy };
    }
    this.user = new SteamUser(opts);

    this.user.on('refreshToken', (token) => this._saveSession({ refreshToken: token }));
    this.user.on('error', () => {});
    this.user.on('disconnected', () => { this.loggedOn = false; });
    this.user.on('steamGuard', (domain, callback) => {
      if (this.account.sharedSecret) {
        callback(SteamTotp.generateAuthCode(this.account.sharedSecret));
      } else if (process.env.GT_GUARD_CODE) {
        callback(process.env.GT_GUARD_CODE);
      } else {
        callback('');
      }
    });
  }

  _loadSession() {
    try {
      return JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
    } catch {
      return {};
    }
  }

  _saveSession(patch) {
    const data = Object.assign(this._loadSession(), patch);
    fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
    fs.writeFileSync(this.sessionFile, JSON.stringify(data, null, 2));
  }

  async login() {
    const saved = this._loadSession();
    let rt = saved.refreshToken || this.account.refreshToken;
    // Strip 'username.' prefix if present (some tools encode as 'username.jwtHeader.jwtPayload.jwtSig')
    if (rt && rt.startsWith(this.account.username + '.')) {
      rt = rt.slice(this.account.username.length + 1);
    }
    // steam-user decodeJwt requires header.payload.signature — unsigned tokens hang forever
    if (rt && rt.split('.').length !== 3) {
      throw new Error('Invalid JWT (refresh token missing signature)');
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const details = rt
        ? { refreshToken: rt }
        : { accountName: this.account.username, password: this.account.password, machineName: 'gt-tracker' };

      this.log(`[steam:${this.account.username}] logging on (${rt ? 'refresh token' : 'password'})`);

      try {
        await new Promise((resolve, reject) => {
          const LOGIN_TIMEOUT_MS = 45000;
          const timer = setTimeout(() => {
            cleanup();
            try { this.user.logOff(); } catch {}
            reject(new Error('Steam login timeout'));
          }, LOGIN_TIMEOUT_MS);
          const onLoggedOn = () => {
            cleanup();
            this.loggedOn = true;
            this.steamId64 = this.user.steamID ? this.user.steamID.getSteamID64() : null;
            this.log(`[steam:${this.account.username}] logged on as ${this.steamId64}`);
            resolve();
          };
          const onError = (err) => {
            cleanup();
            // stale refresh token -> wipe and let caller retry with password
            if (saved.refreshToken) {
              this._saveSession({ refreshToken: null });
            }
            reject(err);
          };
          const cleanup = () => {
            clearTimeout(timer);
            this.user.removeListener('loggedOn', onLoggedOn);
            this.user.removeListener('error', onError);
          };
          this.user.once('loggedOn', onLoggedOn);
          this.user.once('error', onError);
          try {
            this.user.logOn(details);
          } catch (err) {
            cleanup();
            reject(err);
          }
        });
        return; // login succeeded
      } catch (e) {
        this.log(`[steam:${this.account.username}] login failed: ${e.message}`);
        // If refreshToken failed and we have a password, retry with password
        if (attempt === 0 && rt && this.account.password) {
          rt = null;
          continue;
        }
        throw e;
      }
    }
  }

  // Hex-encoded auth session ticket for PlayFab LoginWithSteam.
  // Matches the game's SteamAuthenticator.GetAuthTicket ({0:x2} per byte).
  async createSessionTicketHex(appId) {
    const ticket = async () => this.user.createAuthSessionTicket(appId);
    try {
      const { sessionTicket } = await ticket();
      return sessionTicket.toString('hex');
    } catch (err) {
      // account may not have the (free) license yet - grab it and retry once
      if (typeof this.user.requestFreeLicense === 'function') {
        this.log(`[steam:${this.account.username}] requesting free license for ${appId}`);
        await new Promise((res) => {
          try {
            this.user.requestFreeLicense([appId], () => res());
          } catch { res(); }
        });
        const { sessionTicket } = await ticket();
        return sessionTicket.toString('hex');
      }
      throw err;
    }
  }

  // WebApi auth ticket via the SteamKit2 approach: build a type-5 session ticket,
  // register it with CMsgClientAuthList including server_secret = "str:{identity}\0".
  // This is GetAuthTicketForWebApi over CM — no steam_api64.dll or steam.exe needed.
  async createWebApiTicketHex(appId, identity) {
    const StdLib = require('@doctormckay/stdlib');

    // 1. get ownership ticket
    const ownershipResult = await new Promise((res, rej) => {
      this.user.getAppOwnershipTicket(appId, (err, data) => err ? rej(err) : res(data));
    });
    const appOwnershipTicket = ownershipResult.appOwnershipTicket || ownershipResult;
    if (!Buffer.isBuffer(appOwnershipTicket)) throw new Error(`ownership ticket not a buffer: ${typeof appOwnershipTicket}`);

    // 2. wait for GC token if needed
    if (!this.user._gcTokens) this.user._gcTokens = [];
    if (this.user._gcTokens.length === 0) {
      await new Promise((res) => {
        const t = setTimeout(() => res(), 10000);
        this.user.once('_gcTokens', () => { clearTimeout(t); res(); });
      });
    }
    if (!this.user._gcTokens.length) throw new Error('no GC tokens available');
    const gcToken = this.user._gcTokens.splice(0, 1)[0];

    // 3. build auth ticket with type 5 (WebApi) instead of type 2 (session)
    const crypto = require('crypto');
    const sessionHeader = Buffer.alloc(24);
    sessionHeader.writeUInt32LE(1, 0);             // unknown, always 1
    sessionHeader.writeUInt32LE(5, 4);             // ticket type: 5 = WebApi
    crypto.randomFillSync(sessionHeader, 8, 8);    // 8 random bytes (SteamKit2 uses public+private IP; random works)
    if (!this.user._connectTime) this.user._connectTime = Date.now();
    if (!this.user._connectionCount) this.user._connectionCount = 0;
    sessionHeader.writeUInt32LE((Date.now() - this.user._connectTime) & 0xFFFFFFFF, 16);
    sessionHeader.writeUInt32LE(++this.user._connectionCount, 20);

    // auth ticket = [u32 gcToken.length][gcToken][u32 24][sessionHeader]
    const authTicket = Buffer.alloc(4 + gcToken.length + 4 + 24);
    authTicket.writeUInt32LE(gcToken.length, 0);
    gcToken.copy(authTicket, 4);
    authTicket.writeUInt32LE(24, 4 + gcToken.length);
    sessionHeader.copy(authTicket, 4 + gcToken.length + 4);

    // 4. combine: authTicket + [u32 ownershipTicket.length] + ownershipTicket, padded to 2560
    const rawSize = authTicket.length + 4 + appOwnershipTicket.length;
    const fullTicket = Buffer.alloc(Math.max(rawSize, 2560));
    authTicket.copy(fullTicket, 0);
    fullTicket.writeUInt32LE(appOwnershipTicket.length, authTicket.length);
    appOwnershipTicket.copy(fullTicket, authTicket.length + 4);
    if (rawSize < 2560) crypto.randomFillSync(fullTicket, rawSize, 2560 - rawSize);

    // 5. register with ClientAuthList including server_secret for identity binding
    const ticketCrc = StdLib.Hashing.crc32(authTicket);
    const serverSecret = Buffer.from(`str:${identity}\0`, 'utf8');

    const thisTicket = {
      estate: 0,
      steamid: 0,
      gameid: appId,
      h_steam_pipe: this.user._hSteamPipe,
      ticket_crc: ticketCrc,
      ticket: authTicket,
      server_secret: serverSecret
    };

    if (!this.user._activeAuthTickets) this.user._activeAuthTickets = [];
    this.user._activeAuthTickets.push(thisTicket);

    // use steam-user's own _sendAuthList which handles sequencing + ack
    await this.user._sendAuthList(appId);
    return fullTicket.toString('hex');
  }

  // Hex-encoded GetTicketForWebApi ticket via raw EMsg 1641.
  // Older approach — kept as fallback.
  getWebApiTicketHex(identity) {
    return new Promise((resolve, reject) => {
      if (!this.loggedOn) return reject(new Error('not logged on'));

      const body = proto.fieldString(1, identity);
      const timer = setTimeout(() => reject(new Error('GetTicketForWebApi timeout')), 15000);

      try {
        this.user._send({ msg: EMSG_CLIENT_GET_TICKET_FOR_WEBAPI, proto: {} }, body, (resp) => {
          clearTimeout(timer);
          try {
            const buf = Buffer.isBuffer(resp) ? resp : resp.toBuffer();
            const fields = proto.readFields(buf);

            const resultField = fields.find((f) => f.field === 1 && f.wire === 0);
            const result = resultField ? Number(resultField.varint) : -1;
            if (result !== 1) {
              return reject(new Error(`GetTicketForWebApi eresult=${result}`));
            }

            // ticket = largest length-delimited blob on the wire
            const blobs = fields.filter((f) => f.wire === 2 && f.bytes && f.bytes.length > 16);
            if (!blobs.length) return reject(new Error('GetTicketForWebApi: no ticket blob'));
            blobs.sort((a, b) => b.bytes.length - a.bytes.length);
            resolve(blobs[0].bytes.toString('hex'));
          } catch (e) {
            reject(e);
          }
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  logout() {
    try { this.user.logOff(); } catch {}
  }
}

module.exports = { SteamSession };
