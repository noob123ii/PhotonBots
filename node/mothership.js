'use strict';

// Mothership player auth (verified on the live wire):
//   GET  /v2/player/client/auth/begin/STEAM     (+ mothership headers) -> {Nonce}
//   Steam GetTicketForWebApi(nonce)             -> hex ticket
//   POST /v2/player/client/auth/complete/STEAM  {Nonce, SteamTicket}   -> token + player id

const { ProxyAgent } = require('undici');
const { SocksProxyAgent } = require('socks-proxy-agent');

function headers(ms) {
  return {
    'x-mothership-title-id': ms.titleId,
    'x-mothership-env-id': ms.envId,
    'x-mothership-deployment-id': ms.deploymentId
  };
}

function deepFind(obj, keyPred, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (keyPred(k) && (typeof v === 'string' || typeof v === 'number')) return v;
  }
  for (const v of Object.values(obj)) {
    const found = deepFind(v, keyPred, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function mkFetch(proxy) {
  let dispatcher;
  if (proxy) {
    if (proxy.startsWith('socks')) {
      dispatcher = new SocksProxyAgent(proxy, { keepAlive: false });
    } else {
      dispatcher = new ProxyAgent(proxy);
    }
  }
  return async (url, opts = {}) => {
    if (dispatcher) opts.dispatcher = dispatcher;
    return fetch(url, opts);
  };
}

async function beginSteamLogin(ms, log, proxy) {
  const f = mkFetch(proxy);
  const res = await f(`${ms.base}/v2/player/client/auth/begin/STEAM`, { headers: headers(ms) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`mothership begin -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const nonce = deepFind(json, (k) => k.toLowerCase() === 'nonce');
  if (!nonce) throw new Error('mothership begin: no nonce in response');
  return String(nonce);
}

async function completeSteamLogin(ms, nonce, ticketHex, log, proxy) {
  const f = mkFetch(proxy);
  const res = await f(`${ms.base}/v2/player/client/auth/complete/STEAM`, {
    method: 'POST',
    headers: { ...headers(ms), 'Content-Type': 'application/json' },
    body: JSON.stringify({ Nonce: nonce, SteamTicket: ticketHex })
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`mothership complete -> ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (log) log(`[mothership] complete: ${res.status} OK (token redacted)`);

  const token = deepFind(json, (k) => ['token', 'access_token', 'session_token'].includes(k.toLowerCase()));
  const playerId = deepFind(json, (k) =>
    ['mothership_player_id', 'mothershipid', 'mothership_id', 'player_id', 'mothershipplayerid', 'playerid'].includes(k.toLowerCase()));
  if (!token) throw new Error('mothership complete: no token in response');
  return { token: String(token), mothershipId: playerId ? String(playerId) : '' };
}

module.exports = { beginSteamLogin, completeSteamLogin };
