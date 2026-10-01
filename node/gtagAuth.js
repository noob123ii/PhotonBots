'use strict';

const mothership = require('./mothership');
const playfab = require('./playfab');
const { ProxyAgent } = require('undici');

// Full Gorilla Tag login chain, mirroring PlayFabAuthenticator:
//   Steam session ticket -> PlayFab LoginWithSteam -> SessionTicket + PlayFabId
//   Mothership begin -> webapi ticket(nonce) -> complete -> Mothership token
//   POST auth-prod/api/CachePlayFabId -> SteamAuthIdForPhoton
//   webapi ticket(SteamAuthIdForPhoton) -> Photon Nonce
// Webapi tickets minted over CM via SteamKit2-style auth list (type 5 + server_secret).
// No steam.exe, no daemon — each steam-user instance mints its own tickets.
async function fullAuth(steam, cfg, log, minter, proxy) {
  const titleId = cfg.playfabTitleId;

  const mkFetch = proxy ? (() => {
    const agent = new ProxyAgent(proxy);
    return async (url, opts = {}) => { opts.dispatcher = agent; return fetch(url, opts); };
  })() : fetch;

  // 1-2) Mothership login (game does this before PlayFab in BeginLoginFlow)
  const msNonce = await mothership.beginSteamLogin(cfg.mothership, log, proxy);
  const msTicketHex = await minter.mint(msNonce);
  const ms = await mothership.completeSteamLogin(cfg.mothership, msNonce, msTicketHex, log, proxy);
  log(`[auth:${steam.account.username}] mothership ok (player ${ms.mothershipId || 'unknown'})`);

  // 3) PlayFab LoginWithSteam
  const steamTicketHex = await steam.createSessionTicketHex(cfg.steamAppId);
  const pf = await playfab.loginWithSteam(titleId, steamTicketHex);
  log(`[auth:${steam.account.username}] playfab ok (${pf.playFabId}${pf.newlyCreated ? ', new account' : ''})`);

  // 4) CachePlayFabId -> SteamAuthIdForPhoton (rotates every call)
  const cacheRes = await mkFetch(`${cfg.authApiBase}/api/CachePlayFabId`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Platform: 'Steam',
      SessionTicket: pf.sessionTicket,
      PlayFabId: pf.playFabId,
      TitleId: titleId,
      MothershipEnvId: cfg.mothership.envId,
      MothershipDeploymentId: cfg.mothership.deploymentId,
      MothershipToken: ms.token,
      MothershipId: ms.mothershipId
    })
  });
  const cacheText = await cacheRes.text();
  let cacheJson;
  try { cacheJson = JSON.parse(cacheText); } catch { cacheJson = { raw: cacheText }; }
  if (!cacheRes.ok) {
    throw new Error(`CachePlayFabId -> ${cacheRes.status}: ${cacheText.slice(0, 300)}`);
  }
  const steamAuthId = cacheJson.SteamAuthIdForPhoton || cacheJson.steamAuthIdForPhoton;
  if (!steamAuthId) throw new Error('CachePlayFabId: no SteamAuthIdForPhoton in response');

  // SteamAuthIdForPhoton rotates per CachePlayFabId call and nonces are
  // single-use: every fresh photon connection needs a fresh cache+mint.
  const freshNonce = async () => {
    const res = await mkFetch(`${cfg.authApiBase}/api/CachePlayFabId`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Platform: 'Steam',
        SessionTicket: pf.sessionTicket,
        PlayFabId: pf.playFabId,
        TitleId: titleId,
        MothershipEnvId: cfg.mothership.envId,
        MothershipDeploymentId: cfg.mothership.deploymentId,
        MothershipToken: ms.token,
        MothershipId: ms.mothershipId
      })
    });
    const json = await res.json().catch(() => ({}));
    const id = json.SteamAuthIdForPhoton || json.steamAuthIdForPhoton;
    if (!id) throw new Error('CachePlayFabId (refresh): no SteamAuthIdForPhoton');
    return minter.mint(id);
  };

  // 5) Photon nonce for the first connection
  const photonNonceHex = await freshNonce();

  // GT's custom auth endpoint expects url-encoded POST data (verified on the
  // live wire: dictionary payloads get "Authentication data type not supported")
  const photonAuthData = (zone) => new URLSearchParams({
    AppId: titleId,
    AppVersion: cfg.photonAuthAppVersion || cfg.photonAppVersion,
    Ticket: pf.sessionTicket,
    Nonce: photonNonceHex,
    MothershipEnvId: cfg.mothership.envId,
    MothershipDeploymentId: cfg.mothership.deploymentId,
    MothershipToken: ms.token,
    Zone: zone || cfg.zone || 'forest',
    SubZone: 'none',
    IsPublic: 'true'
  }).toString();

  // dict form (for the binary photon protocol — this is what actually goes on the wire)
  const photonAuthDict = (zone) => ({
    AppId: titleId,
    AppVersion: cfg.photonAuthAppVersion || cfg.photonAppVersion,
    Ticket: pf.sessionTicket,
    MothershipEnvId: cfg.mothership.envId,
    MothershipDeploymentId: cfg.mothership.deploymentId,
    MothershipToken: ms.token,
    Zone: zone || cfg.zone || 'forest',
    SubZone: 'none',
    IsPublic: true
  });

  log(`[auth:${steam.account.username}] full chain complete, ready for photon`);
  return {
    playFabId: pf.playFabId,
    sessionTicket: pf.sessionTicket,
    steamAuthIdForPhoton: steamAuthId,
    freshNonce,
    photonAuthData,
    photonAuthDict
  };
}

module.exports = { fullAuth };
