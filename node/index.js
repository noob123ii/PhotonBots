'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { SteamSession } = require('./steam');
const { fullAuth } = require('./gtagAuth');
const { GTSession, PC } = require('./gt_session');
const { VoiceSession, prepareSound } = require('./photon_voice');
const { startFollowOrbit, RIG_VIEW_COUNT } = require('./follow_orbit');
const mothership = require('./mothership');
const playfab = require('./playfab');
const { createUI } = require('./ui');

let guiLog = null;
process.on('unhandledRejection', (err) => {
  const m = err?.message || String(err) || '';
  // steam-user throws Invalid JWT inside nextTick — surface it so pool workers can fail
  if (m.includes('Invalid JWT') || m.includes('InvalidJWT')) {
    log('steam JWT rejected:', m.slice(0, 80));
    return;
  }
  log('IGNORED:', m.slice(0, 80));
});

const ROOT = path.join(__dirname, '..');
const TOKENS_FILE = path.join(ROOT, 'tokens.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');
const WORKING_FILE = path.join(ROOT, 'working.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function loadJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function loadWorkingAccounts() { try { return JSON.parse(fs.readFileSync(WORKING_FILE, 'utf8')); } catch { return []; } }
function saveWorkingAccount(username) {
  const list = loadWorkingAccounts();
  if (!list.includes(username)) { list.push(username); fs.writeFileSync(WORKING_FILE, JSON.stringify(list, null, 2)); }
}
function removeWorkingAccount(username) {
  const list = loadWorkingAccounts().filter(u => u !== username);
  fs.writeFileSync(WORKING_FILE, JSON.stringify(list, null, 2));
}

const log = (...a) => {
  const msg = new Date().toISOString().slice(11, 23) + ' ' + a.join(' ');
  if (guiLog) guiLog(msg);
  else console.log(msg);
};

// ─── Position helpers ─────────────────────────────────────────────────────

function unpackPos(p) {
  const v = BigInt(p), m = 0x1FFFFFn;
  return [
    (Number(v & m) - 1048576) / 1024,
    (Number((v >> 21n) & m) - 1048576) / 1024,
    (Number((v >> 42n) & m) - 1048576) / 1024
  ];
}
function packPos(x, y, z) {
  const c = v => Math.max(0, Math.min(2097151, Math.round(v * 1024) + 1048576));
  return BigInt(c(x)) + (BigInt(c(y)) << 21n) + (BigInt(c(z)) << 42n);
}
function isValidPos(p) {
  return p && Math.abs(p[0]) < 200 && Math.abs(p[1]) < 200 && Math.abs(p[2]) < 200;
}

function extractPosition(data) {
  if (!Array.isArray(data) || data.length < 3) return null;
  let viewData;
  if (Array.isArray(data[2])) viewData = data[2];
  else if (typeof data[2] === 'number') viewData = data;
  if (!Array.isArray(viewData) || viewData.length < 9) return null;
  const v = viewData[8];
  if (typeof v !== 'bigint' && typeof v !== 'number') return null;
  try { const p = unpackPos(v); return isValidPos(p) ? p : null; } catch { return null; }
}

/** Spawn Player Network Controller with exact prefab view count (4). */
function spawnRig(session) {
  const viewId = session.actorNr * 1000 + 1;
  const viewIds = [];
  for (let i = 0; i < RIG_VIEW_COUNT; i++) viewIds.push(viewId + i);
  const color = [0.3 + Math.random() * 0.7, 0.3 + Math.random() * 0.7, 0.3 + Math.random() * 0.7];
  session.client.sendOp(253, {
    244: { __byte: 202 },
    245: {
      __hashtable: {
        0: 'Player Network Controller',
        4: { __intArray: viewIds },
        5: color,
        6: Date.now(),
        7: viewId
      }
    },
    247: { __byte: 4 }
  });
  return viewId;
}

async function joinVoiceForSession(result, cfg, roomCode, region) {
  const tag = result.account.username;
  await sleep(1500);
  const voiceVer = cfg.photonVoiceAppVersion || cfg.photonAuthAppVersion || cfg.photonAppVersion;
  const vs = new VoiceSession({
    appVersion: voiceVer,
    region,
    authDict: result.bundle.photonAuthDict(cfg.zones?.[0] || 'forest'),
    nickname: result.account.nickname || tag,
    mintNonce: () => result.bundle.freshNonce(),
    rigViewId: result.viewId
  }, log);
  await vs.join(roomCode);
  result.voice = vs;
  log(`[${tag}] voice connected (rigViewId=${result.viewId}, ver=${voiceVer})`);
}

// ─── Region scan ──────────────────────────────────────────────────────────

async function scanBestRegion(cfg, scanAccount, nickname) {
  const regions = cfg.regions || ['usw/*', 'us/*', 'eu/*'];
  const steam = new SteamSession(scanAccount, DATA_DIR);
  await steam.login();
  const minter = { mint: (id) => steam.createWebApiTicketHex(cfg.steamAppId, id) };
  const bundle = await fullAuth(steam, cfg, () => {}, minter);
  let best = null;
  for (const region of regions) {
    try {
      const session = new GTSession({
        appId: cfg.photonAppId, appVersion: cfg.photonAppVersion,
        region, authDict: bundle.photonAuthDict(cfg.zones?.[0] || 'forest'),
        nickname, mintNonce: bundle.freshNonce
      }, () => {});
      const r = await session.joinRandomRoom();
      const count = r.actors.length - 1;
      session.leave();
      log(`  ${region}: "${r.roomName}" (${count} players)`);
      if (count > (best?.actorCount || -1)) best = { region, roomName: r.roomName, actorCount: count };
    } catch (e) { log(`  ${region}: ${e.message.slice(0, 200)}`); }
  }
  steam.logout();
  return best;
}

// ─── Join one account to a named room ─────────────────────────────────────

const loginSemaphore = { permits: 5, queue: [] };
function acquireLoginPermit() {
  return new Promise(resolve => {
    if (loginSemaphore.permits > 0) { loginSemaphore.permits--; resolve(); }
    else loginSemaphore.queue.push(resolve);
  });
}
function releaseLoginPermit() {
  if (loginSemaphore.queue.length) loginSemaphore.queue.shift()();
  else loginSemaphore.permits++;
}

async function joinOne(account, cfg, roomName, region, nickname, timeoutMs = 30000) {
  const tag = account.username;
  const steam = new SteamSession(account, DATA_DIR);
  const minter = { mint: (id) => steam.createWebApiTicketHex(cfg.steamAppId, id) };
  let loginDone = false;
  try {
    const res = await Promise.race([
      (async () => {
        await acquireLoginPermit();
        try {
          await steam.login();
        } finally {
          loginDone = true;
          releaseLoginPermit();
        }
        const bundle = await fullAuth(steam, cfg, () => {}, minter);
        const session = new GTSession({
          appId: cfg.photonAppId, appVersion: cfg.photonAppVersion,
          region, authDict: bundle.photonAuthDict(cfg.zones?.[0] || 'forest'),
          nickname, mintNonce: bundle.freshNonce
        }, () => {});
        await session.joinNamedRoom(roomName, 0);
        const viewId = spawnRig(session);
        const spawnPos = [
          (Math.random() - 0.5) * 12,
          1.5 + Math.random() * 2,
          (Math.random() - 0.5) * 12
        ];
        log(`[${tag}] JOINED ${roomName} actor=${session.actorNr} view=${viewId}`);
        return { steam, session, account, viewId, sessionTicket: bundle.sessionTicket, pfId: bundle.playFabId, tag, bundle, pos: spawnPos };
      })(),
      sleep(timeoutMs).then(() => { throw new Error('timeout'); })
    ]);
    return res;
  } catch (err) {
    if (!loginDone) releaseLoginPermit(); // release permit on timeout/early error
    const msg = err.message || '';
    log(`[-] ${tag}: ${msg.slice(0, 200)}`);
    try { steam.logout(); } catch {}
    if (msg.includes('Game full') || msg.includes('32765')) return 'FULL';
    if (msg.includes('banned') || msg.includes('AccountBanned')) return 'BANNED';
    if (msg.includes('timeout') || msg.includes('timed out')) return 'TIMEOUT';
    return 'ERROR';
  }
}

// ─── Join using a pre-loaded ready session (already Steam-logged-in) ──────

async function joinFromPool(ready, cfg, roomName, region, nickname) {
  const { account, steam, bundle } = ready;
  const tag = account.username;
  let session = null;
  const makeSession = () => new GTSession({
    appId: cfg.photonAppId, appVersion: cfg.photonAppVersion,
    region, authDict: bundle.photonAuthDict(cfg.zones?.[0] || 'forest'),
    nickname, mintNonce: bundle.freshNonce
  }, () => {});

  try {
    session = makeSession();
    // GTag rooms: PlayerTTL=0 → normal join only (no rejoin)
    await session.joinNamedRoom(roomName, 0);
    const viewId = spawnRig(session);
    const spawnPos = [(Math.random() - 0.5) * 12, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 12];
    log(`[${tag}] JOINED ${roomName} actor=${session.actorNr} view=${viewId}`);
    return { steam, session, account, viewId, sessionTicket: bundle.sessionTicket, pfId: bundle.playFabId, tag, bundle, pos: spawnPos };
  } catch (err) {
    const msg = err.message || '';
    log(`[-] ${tag}: ${msg.slice(0, 200)}`);
    try { session?.abort(); } catch {}
    if (msg.includes('Game full') || msg.includes('32765')) return 'FULL';
    if (msg.includes('banned') || msg.includes('AccountBanned')) {
      try { steam.logout(); } catch {}
      return 'BANNED';
    }
    if (msg.includes('timeout') || msg.includes('timed out')) return 'TIMEOUT';
    // Still occupying a slot from a previous kill — retry after Photon drops the dead peer
    if (
      msg.includes('32746') || /already joined/i.test(msg) ||
      /aborted \(closed\)/i.test(msg) || /PlayerTTL is 0/i.test(msg) ||
      /does not support rejo/i.test(msg)
    ) {
      return 'ALREADY';
    }
    return 'ERROR';
  }
}

// ─── Find actor by name ───────────────────────────────────────────────────

function findActorNr(session, name) {
  name = name.toLowerCase();
  for (const [nr, actor] of session.actors) {
    if (actor.name.toLowerCase() === name) return nr;
  }
  return null;
}

// ─── Report (event 51) ────────────────────────────────────────────────────

function sendReport(session, targetActorNr, reason) {
  session.client.sendOp(253, {
    244: { __byte: 51 },
    245: [targetActorNr, reason, session.userId || '', Date.now()],
    247: { __byte: 1 }
  });
}

// ─── Scanner mode: join random public room, collect player data ──────────

async function runScanner(account, cfg, region, nickname) {
  const tag = account.username;
  const steam = new SteamSession(account, DATA_DIR);
  const minter = { mint: (id) => steam.createWebApiTicketHex(cfg.steamAppId, id) };
  try {
    await steam.login();
    const bundle = await fullAuth(steam, cfg, () => {}, minter);
    const session = new GTSession({
      appId: cfg.photonAppId, appVersion: cfg.photonAppVersion,
      region, authDict: bundle.photonAuthDict(cfg.zones?.[0] || 'forest'),
      nickname, mintNonce: bundle.freshNonce
    }, () => {});
    const room = await session.joinRandomRoom();
    log(`[SCANNER] Joined random room: "${room.roomName}" (${room.actors.length - 1} players)`);

    // List current players
    for (const [nr, actor] of session.actors) {
      if (actor.actorNr !== session.actorNr) {
        log(`[SCANNER] Player: [${actor.actorNr}] "${actor.name}"`);
      }
    }

    // Listen for events
    session.on('customEvent', (code, data, actorNr) => {
      const actor = session.actors.get(actorNr);
      const name = actor ? actor.name : `#${actorNr}`;
      if (code === 201 || code === 206) {
        const p = extractPosition(data);
        if (p) log(`[SCANNER] ${name} @ [${p.map(v => v.toFixed(2)).join(', ')}]`);
      } else if (code === 4) {
        log(`[SCANNER] +JOIN ${name}`);
      } else if (code === 5) {
        log(`[SCANNER] -LEAVE ${name}`);
      }
    });

    // Periodic report
    const ivl = setInterval(() => {
      const count = session.actors.size - 1;
      log(`[SCANNER] ${count} players in "${session.roomName}"`);
    }, 30000);

    // Keep alive movement
    const moveIvl = setInterval(() => {
      if (!session.client?.connected) return;
      const pos = [
        0.5 + Math.random() * 10,
        1.5 + Math.random() * 3,
        0.5 + Math.random() * 10
      ];
      try {
        session.client.sendOp(253, {
          244: { __byte: 206 },
          245: [Date.now(), null, [
            session.actorNr * 1000 + 1, false, null, 469893399, 265158911, false,
            0n, 0n, packPos(pos[0], pos[1], pos[2]), 0, 0, 2815
          ]]
        });
      } catch {}
    }, 3000);

    process.on('SIGINT', () => {
      clearInterval(ivl); clearInterval(moveIvl);
      session.leave();
      steam.logout();
      process.exit(0);
    });

    for (;;) { await sleep(30000); }
  } catch (err) {
    log(`[SCANNER] Error: ${err.message.slice(0, 80)}`);
    try { steam.logout(); } catch {}
    process.exit(1);
  }
}

// ─── Tracker mode: join random rooms, check player cosmetics via PlayFab ────

const TARGET_COSMETICS_FILE = path.join(ROOT, 'targetCosmetics.json');

function loadTargetCosmetics() {
  try { return JSON.parse(fs.readFileSync(TARGET_COSMETICS_FILE, 'utf8')); } catch { return []; }
}

async function getPlayerCosmetics(cfg, sessionTicket, pfId) {
  try {
    const inv = await playfab.getPlayerInventory(cfg.photonAppId || '63FDD', sessionTicket, pfId);
    if (!inv || inv.banned || !inv.items) return [];
    const cosmetics = [];
    for (const [key, item] of Object.entries(inv.items)) {
      if (item.ItemId) cosmetics.push(item.ItemId);
      if (item.DisplayName) cosmetics.push(item.DisplayName);
    }
    return [...new Set(cosmetics)];
  } catch { return []; }
}

function findMatchingCosmetics(playerCosmetics, targetList) {
  const matched = [];
  for (const pc of playerCosmetics) {
    const lower = pc.toLowerCase();
    for (const tc of targetList) {
      if (lower.includes(tc.toLowerCase()) || tc.toLowerCase().includes(lower)) {
        matched.push(tc);
      }
    }
  }
  return matched;
}

async function runTracker(account, cfg, region, nickname) {
  const tag = account.username;
  const targetCosmetics = loadTargetCosmetics();
  if (!targetCosmetics.length) {
    log(`[TRACKER] No target cosmetics found in "${TARGET_COSMETICS_FILE}"`);
    return;
  }
  log(`[TRACKER] Loaded ${targetCosmetics.length} target cosmetics`);

  const steam = new SteamSession(account, DATA_DIR);
  const minter = { mint: (id) => steam.createWebApiTicketHex(cfg.steamAppId, id) };

  try {
    await steam.login();
    const bundle = await fullAuth(steam, cfg, () => {}, minter);
    const sessionTicket = bundle.sessionTicket;
    const myPfId = bundle.playFabId;

    while (true) {
      try {
        const session = new GTSession({
          appId: cfg.photonAppId, appVersion: cfg.photonAppVersion,
          region, authDict: bundle.photonAuthDict(cfg.zones?.[0] || 'forest'),
          nickname, mintNonce: bundle.freshNonce
        }, () => {});

        const room = await session.joinRandomRoom();
        const roomName = room.roomName;
        log(`[TRACKER] Joined room: "${roomName}" (${room.actors.length - 1} players)`);

        for (const [nr, actor] of session.actors) {
          if (actor.actorNr === session.actorNr || !actor.userId) continue;

          const playerName = actor.name || `#${actor.actorNr}`;
          log(`[TRACKER] Checking: "${playerName}" (${actor.userId})`);

          const cosmetics = await getPlayerCosmetics(cfg, sessionTicket, actor.userId);
          if (cosmetics.length === 0) continue;

          const matched = findMatchingCosmetics(cosmetics, targetCosmetics);
          if (matched.length > 0) {
            const matchStr = matched.join(', ');
            log(`[TRACK] player: ${playerName} | room: ${roomName} | region: ${region} | cosmetics: ${matchStr}`);
          }
        }

        session.leave();
        log(`[TRACKER] Done scanning "${roomName}", waiting 15s before next scan...`);
        await sleep(15000);
      } catch (err) {
        log(`[TRACKER] Scan error: ${err.message.slice(0, 200)}`);
        await sleep(10000);
      }
    }
  } catch (err) {
    log(`[TRACKER] Fatal: ${err.message.slice(0, 80)}`);
    try { steam.logout(); } catch {}
    process.exit(1);
  }
}

function saveTokens(tokens) {
  const alive = tokens.accounts.filter(a => !a._dead);
  if (alive.length < 5) log(`SAFETY: tokens.json would have ${alive.length} accounts — skipping write to prevent wipe`);
  else fs.writeFileSync(TOKENS_FILE, JSON.stringify({ accounts: alive }, null, 2));
}

function createPool(tokens, cfg, logStatus, concurrency = 3, maxReady = 6) {
  const pool = {
    readyPool: [],
    poolFailed: new Set(),
    running: true,
    loading: true,
    remaining: tokens.accounts.length,
    inFlight: 0,
    pendingRetries: 0,
    exhausted: false
  };
  const queue = [...tokens.accounts];

  function refreshExhausted() {
    pool.exhausted = pool.remaining <= 0 && pool.inFlight <= 0 && pool.pendingRetries <= 0 && pool.readyPool.length === 0;
  }

  async function worker() {
    while (pool.running) {
      if (!pool.loading) { await sleep(2000); continue; }
      // Only preload what we need — don't burn through the whole accounts.txt
      if (pool.readyPool.length >= maxReady) { await sleep(1500); continue; }

      const account = queue.shift();
      if (!account) {
        refreshExhausted();
        await sleep(1500);
        continue;
      }
      pool.remaining = queue.length;
      if (pool.poolFailed.has(account.username)) {
        refreshExhausted();
        continue;
      }

      pool.inFlight++;
      try {
        if (logStatus) logStatus(account, 'steam');
        const steam = new SteamSession(account, DATA_DIR);
        const minter = { mint: (id) => steam.createWebApiTicketHex(cfg.steamAppId, id) };
        await steam.login();
        if (logStatus) logStatus(account, 'auth');
        const bundle = await fullAuth(steam, cfg, () => {}, minter);
        if (!pool.loading) {
          try { steam.logout(); } catch {}
        } else {
          pool.readyPool.push({ account, steam, bundle });
          saveWorkingAccount(account.username);
          if (logStatus) logStatus(account, 'ok');
        }
      } catch (err) {
        pool.poolFailed.add(account.username);
        removeWorkingAccount(account.username);
        if (logStatus) logStatus(account, 'fail', err);
      } finally {
        pool.inFlight = Math.max(0, pool.inFlight - 1);
        pool.remaining = queue.length;
        refreshExhausted();
      }

      await sleep(1500);
    }
  }

  for (let i = 0; i < concurrency; i++) worker();
  return pool;
}

// ─── Main ─────────────────────────────────────────────────────────────────

/** Parse accounts.txt → only valid signed JWTs. Source of truth for tokens.json. */
function loadAccountsFromTxt() {
  const accPath = path.join(ROOT, 'accounts.txt');
  if (!fs.existsSync(accPath)) return null;
  const validJwt = (s) => typeof s === 'string' && s.split('.').length === 3 && s.startsWith('eyA');
  const decodeExp = (jwt) => {
    try {
      const payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const pad = payload.length % 4 === 2 ? '==' : payload.length % 4 === 3 ? '=' : '';
      const obj = JSON.parse(Buffer.from(payload + pad, 'base64').toString('utf8'));
      return typeof obj.exp === 'number' ? obj.exp : null;
    } catch { return null; }
  };
  const now = Math.floor(Date.now() / 1000);
  const seen = new Set();
  const accounts = [];
  let total = 0, expired = 0, invalid = 0;
  for (const raw of fs.readFileSync(accPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    total++;
    let username = '', refreshToken = '', password = '', sharedSecret = '';
    const colon = line.indexOf(':');
    const dot = line.indexOf('.');
    if (colon > 0 && (dot < 0 || colon < dot)) {
      const parts = line.split(':');
      username = parts[0];
      password = parts[1] || '';
      sharedSecret = parts[2] || '';
      refreshToken = parts.find(p => validJwt(p)) || '';
    } else if (dot > 0) {
      username = line.slice(0, dot);
      refreshToken = line.slice(dot + 1);
    } else {
      invalid++;
      continue;
    }
    if (!username || !validJwt(refreshToken)) { invalid++; continue; }
    const exp = decodeExp(refreshToken);
    if (exp != null && exp < now) { expired++; continue; }
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({ username, password, sharedSecret, refreshToken, nickname: username });
  }
  return { accounts, total, expired, invalid };
}

async function main() {
  const cfg = loadJson(CONFIG_FILE, null);
  if (!cfg) { console.log('missing config.json — copy or create one'); process.exit(1); }

  // accounts.txt is the only source — rebuild tokens.json from it (no extras)
  const fromTxt = loadAccountsFromTxt();
  let tokens = { accounts: [] };
  if (fromTxt) {
    tokens.accounts = fromTxt.accounts;
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
    log(`accounts.txt → tokens.json: ${tokens.accounts.length} working (${fromTxt.expired} expired, ${fromTxt.invalid} invalid of ${fromTxt.total})`);
  } else {
    tokens = loadJson(TOKENS_FILE, { accounts: [] });
    const validJwt = (s) => typeof s === 'string' && s.split('.').length === 3 && s.startsWith('eyA');
    let skipped = 0;
    tokens.accounts = tokens.accounts.filter(a => {
      const ok = validJwt(a.refreshToken);
      if (!ok) skipped++;
      return ok;
    });
    if (skipped) log(`filtered ${tokens.accounts.length} valid accounts (${skipped} skipped — invalid JWT format)`);
  }
  if (!tokens.accounts.length) {
    console.log('no working accounts — put username.JWT lines in accounts.txt');
    process.exit(1);
  }
  // Prefer previously-working accounts first (still only from accounts.txt set)
  const working = loadWorkingAccounts();
  if (working.length) {
    const s = new Set(working);
    const allow = new Set(tokens.accounts.map(a => a.username));
    const front = tokens.accounts.filter(a => s.has(a.username));
    const back = tokens.accounts.filter(a => !s.has(a.username));
    tokens.accounts = [...front, ...back];
    // Drop stale working.json entries that are not in accounts.txt
    const pruned = working.filter(u => allow.has(u));
    if (pruned.length !== working.length) fs.writeFileSync(WORKING_FILE, JSON.stringify(pruned, null, 2));
    log(`loaded ${tokens.accounts.length} accounts from accounts.txt (${front.length} previously working)`);
  } else {
    log(`loaded ${tokens.accounts.length} accounts from accounts.txt`);
  }

  // Parse CLI args: --room, --region, --nick, --count, --follow, --sound, --flood, --scan, --event, --track
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i].replace(/^--?/, '').toLowerCase();
    const v = process.argv[i + 1];
    if (v && !v.startsWith('-')) args[k] = v;
    else { args[k] = true; i--; }
  }

  let roomCode, regionInput, nickname, count, followTarget, soundName, flood, reportTarget, reportReason, customEvent;
  let soundVolume = 0.7;
  let orbitFollow = true;
  let moveMode = 'orbit';

  // ─── Check-Bans mode: verify each account with Mothership auth ──────────
  const BAN_TIMEOUT_MS = 10000;
  const MAX_INFLIGHT = 8;

  let checkStopped = false;
  let inflight = 0;
  const inflightGate = () => new Promise(resolve => {
    const tryPass = () => {
      if (inflight < MAX_INFLIGHT) { inflight++; resolve(); }
      else setTimeout(tryPass, 300);
    };
    tryPass();
  });
  const inflightDone = () => { inflight--; };

  const jitterSleep = (ms) => sleep(ms * (0.7 + Math.random() * 0.6));

  async function checkAccountBan(account, cfg) {
    await inflightGate();
    const steam = new SteamSession(account, DATA_DIR, () => {}, null);
    let timeoutId;
    const timeout = (ms) => new Promise((_, rej) => { timeoutId = setTimeout(() => rej(new Error('timeout')), ms); });

    try {
      await jitterSleep(200);
      await Promise.race([steam.login(), timeout(BAN_TIMEOUT_MS)]);
      clearTimeout(timeoutId);
      const minter = { mint: (id) => steam.createWebApiTicketHex(cfg.steamAppId, id) };
      const msNonce = await mothership.beginSteamLogin(cfg.mothership, log, null);
      const msTicketHex = await minter.mint(msNonce);
      await Promise.race([mothership.completeSteamLogin(cfg.mothership, msNonce, msTicketHex, log, null), timeout(BAN_TIMEOUT_MS)]);
      clearTimeout(timeoutId);
      try { steam.logout(); } catch {}
      inflightDone();
      return { ok: true };
    } catch (err) {
      clearTimeout(timeoutId);
      try { steam.logout(); } catch {}
      inflightDone();
      const msg = (err.message || 'unknown').slice(0, 200);

      if (msg.includes('mothership') && (msg.includes('403') || msg.includes('401')) &&
          (msg.toLowerCase().includes('ban') || msg.toLowerCase().includes('suspended'))) {
        return { ok: false, banned: true, reason: msg };
      }
      if (msg.includes('InvalidPassword') || msg.includes('AccountLoginDenied') || msg.includes('InvalidLogin')) {
        return { ok: false, reason: msg, code: 'INVALID' };
      }
      return { ok: false, reason: msg, code: 'FAILED' };
    }
  }

  if (args['check-bans'] || args.check) {
    const rl_check = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    readline.emitKeypressEvents(process.stdin, rl_check);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    const onKey = (str, key) => {
      if ((key.name === 's' || key.name === 'S') && !checkStopped) {
        checkStopped = true;
      }
    };
    process.stdin.on('keypress', onKey);

    (async () => {
      const UNBANNED_FILE = path.join(ROOT, 'unbanned.json');
      const BANNED_FILE = path.join(ROOT, 'banned.json');

      const seen = new Map();
      for (const acc of tokens.accounts) {
        if (!seen.has(acc.username)) seen.set(acc.username, acc);
      }
      const allAccounts = [...seen.values()];
      const total = allAccounts.length;
      log(`CHECK-BANS MODE: ${total} unique accounts, ${MAX_INFLIGHT} concurrent`);

      if (!total) { log('no accounts to check'); process.exit(0); }

      const unbanned = [], banned = [], failed = [];
      let done = 0;

      function saveProgress() {
        fs.writeFileSync(UNBANNED_FILE, JSON.stringify({ accounts: unbanned }, null, 2));
        fs.writeFileSync(BANNED_FILE, JSON.stringify({ accounts: banned }, null, 2));
        fs.writeFileSync(FAILED_FILE, JSON.stringify({ accounts: failed }, null, 2));
      }

      const FAILED_FILE = path.join(ROOT, 'failed.json');
      const saveIvl = setInterval(saveProgress, 5000);

      let statusInterval;
      function startStatusTimer() {
        statusInterval = setInterval(() => {
          log(`[CHECK] status: ${done}/${total} OK: ${unbanned.length} BANNED: ${banned.length} FAILED: ${failed.length}${checkStopped ? ' (stopping...)' : ''}`);
        }, 3000);
      }
      startStatusTimer();

      async function worker(wi) {
        await sleep(wi * 100 + Math.random() * 100);
        while (allAccounts.length && !checkStopped) {
          const acc = allAccounts.shift();
          if (!acc) break;
          try {
            const result = await checkAccountBan(acc, cfg);
            done++;
            if (result.ok) {
              unbanned.push(acc);
              log(`[CHECK] ${acc.username}: OK (${done}/${total})`);
            } else if (result.banned) {
              banned.push({ username: acc.username, nickname: acc.nickname, reason: result.reason });
              log(`[CHECK] ${acc.username}: BANNED (${done}/${total}) reason: ${result.reason}`);
            } else {
              failed.push({ username: acc.username, nickname: acc.nickname, reason: result.reason, code: result.code || 'FAILED' });
              log(`[CHECK] ${acc.username}: ${result.code || 'FAILED'} (${done}/${total}) reason: ${result.reason}`);
            }
          } catch (e) {
            done++;
            failed.push({ username: acc.username, nickname: acc.nickname, reason: 'worker error' });
            log(`[CHECK] ${acc.username}: FAILED (${done}/${total})`);
          }
        }
      }
      const workers = Array.from({ length: Math.min(MAX_INFLIGHT * 3, total) }, (_, i) => worker(i));
      await Promise.all(workers);
      clearInterval(saveIvl);
      clearInterval(statusInterval);
      saveProgress();
      try { process.stdin.setRawMode(false); process.stdin.removeListener('keypress', onKey); rl_check.close(); } catch {}
      log(`CHECK-BANS COMPLETE: ${unbanned.length} unbanned, ${banned.length} banned, ${failed.length} failed`);
      process.exit(0);
    })().catch(e => { log(`CHECK-BANS FATAL: ${e.message?.slice(0, 80)}`); process.exit(1); });
    return;
  }

  if (args.track) {
    regionInput = args.region || 'eu/*';
    nickname = args.nick || args.n || 'Tracker';
    log(`=== TRACK MODE: region=${regionInput} nick="${nickname}" ===`);
    const account = tokens.accounts[0];
    if (!account) { log('no accounts available'); process.exit(1); }
    await runTracker(account, cfg, regionInput, nickname);
    return;
  }

  if (args.scan) {
    // Scanner mode: join random public room, collect data
    regionInput = args.region || 'eu/*';
    nickname = args.nick || args.n || 'Scanner';
    log(`=== SCANNER MODE: region=${regionInput} nick="${nickname}" ===`);
    const account = tokens.accounts[0];
    if (!account) { log('no accounts available'); process.exit(1); }
    await runScanner(account, cfg, regionInput, nickname);
    return;
  }

  if (args.room || args.r) {
    roomCode = args.room || args.r || '';
    regionInput = args.region || 'eu/*';
    nickname = args.nick || args.n || 'Sigma';
    count = Math.min(parseInt(args.count || args.c || '1') || 1, tokens.accounts.length);
    followTarget = args.follow || args.f || '';
    soundName = args.sound || '';
    soundVolume = Math.max(0.05, Math.min(2, parseFloat(args.volume || args.vol || '0.7') || 0.7));
    orbitFollow = !(args.orbit === 'false' || args.orbit === '0' || args.noorbit);
    moveMode = String(args.move || args.mode || (orbitFollow ? 'orbit' : 'stick')).toLowerCase();
    customEvent = args.event || '';
    flood = !!args.flood;
    reportTarget = '';
    reportReason = 0;
  } else {
    // ── GUI mode (blessed TUI) ──
    const ui = createUI(tokens.accounts);
    guiLog = ui.log;
    const acctIdx = new Map(tokens.accounts.map((a, i) => [a.username, i]));

    const pool = createPool(tokens, cfg, (account, status, err) => {
      const idx = acctIdx.get(account.username);
      if (idx === undefined) return;
      if (status === 'ok') { ui.setAccountStatus(idx, 'ok'); log(`[pool] +${account.username} (${pool.readyPool.length} ready)`); }
      else if (status === 'fail') { ui.setAccountStatus(idx, 'fail'); log(`[pool] -${account.username}: ${err.message || 'unknown'}`); }
      else ui.setAccountStatus(idx, status);
    }, 3, Math.min(8, tokens.accounts.length));
    log('pool starting, checking accounts...');

    // When START is clicked, kick off join
    ui.startBtn.on('press', async () => {
      const vals = ui.getValues();
      if (!vals.room) { ui.log('Enter a room code first'); return; }
      const targetCount = Math.min(vals.count, pool.readyPool.length + tokens.accounts.length);
      if (targetCount < 1) { ui.log('No accounts available'); return; }

      ui.setAllIdle();
      const rooms = vals.room.split(',').map(r => r.trim()).filter(Boolean);
      const region = (vals.region || 'usw') + '/*';
      const nick = 'Sigma';
      const sessions = [];

      for (let i = 0; i < targetCount && pool.running; i++) {
        while (!pool.readyPool.length && pool.running) await sleep(500);
        if (!pool.running) break;
        const ready = pool.readyPool.shift();
        const idx = acctIdx.get(ready.account.username);
        try {
          if (idx !== undefined) ui.setAccountStatus(idx, 'join');
          const r = await joinFromPool(ready, cfg, rooms[i % rooms.length] || rooms[0], region, nick);
          if (r && typeof r === 'object') {
            sessions.push(r);
            if (idx !== undefined) ui.setAccountStatus(idx, 'done');
            ui.updateStats(sessions.length, 0, vals.room);
            ui.log(`+OK ${r.tag} in ${rooms[i % rooms.length]}`);
          } else {
            if (r === 'BANNED') pool.poolFailed.add(ready.account.username);
            if (idx !== undefined) ui.setAccountStatus(idx, 'fail');
            ui.log(`${r} ${ready.account.username}`);
            i--;
          }
        } catch (e) {
          if (idx !== undefined) ui.setAccountStatus(idx, 'fail');
          ui.log(`ERROR ${ready.account.username}: ${e.message || 'unknown'}`);
        }
      }

      saveTokens(tokens);
      pool.loading = false;
      for (const leftover of pool.readyPool.splice(0)) {
        try { leftover.steam.logout(); } catch {}
      }
      ui.log(`Done: ${sessions.length} joined`);
    });

    ui.screen.key(['C-c'], () => { pool.running = false; ui.destroy(); process.exit(0); });
    ui.screen.render();
    await new Promise(() => {}); // keep alive
  }

  const targetCount = Math.min(count, tokens.accounts.length);

  // ── Scan ──
  let region = regionInput || '';
  if (region && !/\*/.test(region)) region += '/*';
  if (!roomCode) {
    log('scanning regions...');
    const best = await scanBestRegion(cfg, tokens.accounts[0], nickname);
    if (!best || best.actorCount < 1) { log('no rooms found'); process.exit(1); }
    roomCode = best.roomName; region = best.region;
    log(`selected: "${roomCode}" in ${region} (${best.actorCount} players)`);
  }

  // ── Normal / flood join ──
  const sessions = [], failedAccounts = [];
  const startTime = Date.now();
  let soundFrames = null;
  let followCtl = null;

  // ── Background pool: only preload what we need for this run ──
  const poolMaxReady = flood ? Math.min(12, tokens.accounts.length) : Math.min(targetCount + 2, tokens.accounts.length);
  const pool = createPool(tokens, cfg, (account, status, err) => {
    if (status === 'ok') log(`[pool] +${account.username} (${pool.readyPool.length} ready)`);
    else if (status === 'fail') log(`[pool] -${account.username}: ${err.message || 'unknown'}`);
  }, 3, poolMaxReady);

  log(`=== ${flood ? 'FLOOD ' : ''}${count}x "${roomCode}" ${region} | nick="${nickname}"${followTarget ? ' | follow=' + followTarget : ''}${moveMode ? ' | move=' + moveMode : ''}${soundName ? ' | voice' : ''}${flood ? ' | flood=3s' : ''} ===\n`);
  log(`game AppVersion: ${cfg.photonAppVersion}`);
  log(`voice AppVersion: ${cfg.photonVoiceAppVersion || cfg.photonAuthAppVersion || cfg.photonAppVersion}`);

  if (soundName) {
    const soundPath = path.isAbsolute(soundName) ? soundName : path.join(ROOT, 'voice', 'soundboard', soundName);
    log(`loading audio from "${soundPath}" (vol=${soundVolume})...`);
    try {
      soundFrames = await prepareSound(soundPath, log, soundVolume);
      log(`sound ready: ${path.basename(soundPath)} (${(soundFrames.length * 60 / 1000).toFixed(1)}s)`);
    } catch (e) {
      log(`voice prepare failed: ${e.message}`);
      soundFrames = null;
    }
  }

  let joined = 0;
  let lastPoolLog = 0;
  const poolStart = Date.now();
  while (joined < targetCount && pool.running) {
    if (!pool.readyPool.length) {
      // All accounts tried and nothing left cooking — stop waiting, start with who joined
      if (pool.exhausted || (pool.remaining <= 0 && pool.inFlight <= 0 && pool.pendingRetries <= 0 && pool.readyPool.length === 0 && pool.poolFailed.size + joined + failedAccounts.length >= tokens.accounts.length)) {
        log(`[pool] no more accounts left (joined ${joined}/${targetCount}, failed ${pool.poolFailed.size}) — continuing`);
        break;
      }
      if (Date.now() - poolStart > 300000) {
        log(`[pool] timed out — no ready accounts after 5 minutes`);
        break;
      }
      if (Date.now() - lastPoolLog > 10000) {
        lastPoolLog = Date.now();
        log(`[pool] waiting for ready accounts... (${pool.poolFailed.size} failed, ${pool.readyPool.length} ready, ${pool.inFlight} in-flight, ${pool.pendingRetries} retrying, ${pool.remaining} queued)`);
      }
      await sleep(1000);
      continue;
    }

    const ready = pool.readyPool.shift();
    const r = await joinFromPool(ready, cfg, roomCode, region, nickname);
    if (r && typeof r === 'object') {
      sessions.push(r);
      if (soundFrames) {
        try {
          await joinVoiceForSession(r, cfg, roomCode, region);
          const delay = 800 + sessions.length * 1000;
          setTimeout(() => {
            if (r.voice?.connected) {
              r.voice.play(soundFrames, true);
              log(`[${r.tag}] auto-play sound`);
            }
          }, delay);
        } catch (e) {
          log(`[${r.tag}] voice fail: ${e.message}`);
        }
      }
      log(`[${joined + 1} ${((Date.now() - startTime) / 1000).toFixed(0)}s] +OK ${r.tag}`);
      joined++;
      await sleep(1500);
    } else {
      failedAccounts.push(ready.account.username);
      if (r === 'BANNED') {
        pool.poolFailed.add(ready.account.username);
        try { ready.steam.logout(); } catch {}
        log(`[${failedAccounts.length} ${((Date.now() - startTime) / 1000).toFixed(0)}s] BANNED ${ready.account.username} (skipping)`);
      } else if (r === 'ALREADY') {
        // Ghost UserId still active (PlayerTTL=0 → must wait for UDP timeout, not rejoin)
        log(`[${failedAccounts.length} ${((Date.now() - startTime) / 1000).toFixed(0)}s] ALREADY ${ready.account.username} — retry in 15s`);
        pool.pendingRetries++;
        setTimeout(() => {
          pool.pendingRetries = Math.max(0, pool.pendingRetries - 1);
          if (pool.running && joined < targetCount) {
            pool.readyPool.push(ready);
            pool.exhausted = false;
          } else {
            try { ready.steam.logout(); } catch {}
          }
        }, 15000);
      } else {
        try { ready.steam.logout(); } catch {}
        log(`[${failedAccounts.length} ${((Date.now() - startTime) / 1000).toFixed(0)}s] ${r} ${ready.account.username}`);
      }
    }
  }

  saveTokens(tokens);
  // Stop preloading more Steam accounts once join target is met (unless flooding)
  if (!flood) {
    pool.loading = false;
    for (const leftover of pool.readyPool.splice(0)) {
      try { leftover.steam.logout(); } catch {}
    }
    log(`[pool] stopped loading (need ${targetCount}, joined ${sessions.length})`);
  }
  log(`\n=== ${sessions.length} joined, ${failedAccounts.length} total fails in ${((Date.now() - startTime) / 1000).toFixed(1)}s ===`);

  // ── Custom event ──
  if (customEvent) {
    log(`sending custom event: ${customEvent}`);
    try {
      const parsed = JSON.parse(customEvent);
      for (const s of sessions) {
        s.session.client.sendOp(253, parsed);
      }
      log(`custom event sent to ${sessions.length} bots`);
    } catch (e) {
      log(`custom event parse/send failed: ${e.message}`);
    }
  }

  if (flood) {
    (async () => {
      while (pool.running) {
        if (!pool.readyPool.length) { await sleep(3000); continue; }
        const ready = pool.readyPool.shift();
        const r = await joinFromPool(ready, cfg, roomCode, region, nickname);
        if (r && typeof r === 'object') {
          sessions.push(r);
          if (soundFrames) {
            try {
              await joinVoiceForSession(r, cfg, roomCode, region);
              if (r.voice) r.voice.play(soundFrames, true);
            } catch {}
          }
        } else if (r !== 'BANNED') {
          pool.readyPool.unshift(ready);
        }
        saveTokens(tokens);
        await sleep(3000);
      }
      const alive = sessions.filter(s => s.session?.client?.connected).length;
      log(`flood: done (${alive} alive)`);
    })();
  }

  for (const s of sessions) {
    const actorList = [...s.session.actors.values()].map(a => `[${a.actorNr}]"${a.name}"`).join(', ');
    log(`  "${s.tag}" in ${s.session.roomName}: ${actorList}`);
  }

  // ── Follow + movement controller (always start so live freeze/mode/sound work) ──
  const wantMove = moveMode && moveMode !== 'none' && moveMode !== 'false';
  if (sessions.length) {
    let target = followTarget || '';
    if (!target && wantMove && moveMode !== 'cycle' && !String(moveMode).includes('cycle')) {
      const ours = new Set(sessions.map(s => s.session?.actorNr).filter(Boolean));
      outer: for (const s of sessions) {
        for (const a of s.session.actors.values()) {
          if (ours.has(a.actorNr) || !a.name) continue;
          target = a.name;
          log(`[move] no follow set — auto-targeting "${target}"`);
          break outer;
        }
      }
    }
    const startMode = wantMove ? moveMode : 'none';
    log(`[move] starting mode=${startMode} on ${sessions.length} bot(s)${target ? ` → ${target}` : ' (cycle/auto/freeze)'}`);
    followCtl = startFollowOrbit(sessions, target, log, {
      mode: startMode,
      orbit: orbitFollow
    });
    if (soundFrames) {
      setTimeout(() => {
        for (const s of sessions) {
          if (!s.voice?.connected) continue;
          try { s.voice._announce(); s.voice.play(soundFrames, true); } catch {}
        }
        log(`[voice] re-kick sound after follow start (${sessions.filter(s => s.voice).length} voices)`);
      }, 8000);
    }
  }

  // Live GUI control via stdin JSON lines: {"cmd":"move","mode":"scar"} etc.
  let disconnectAll = (why) => {
    pool.running = false;
    try { followCtl?.stop(); } catch {}
    log(`disconnecting (${why})...`);
    for (const s of sessions) {
      try { if (s.voice) s.voice.leave(); } catch {}
      try { s.session?.leave(); } catch {}
      try { s.steam?.logout(); } catch {}
    }
  };

  try {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const raw = String(line || '').trim();
      if (!raw) return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const cmd = String(msg.cmd || msg.command || '').toLowerCase();
      if (cmd === 'quit' || cmd === 'stop' || cmd === 'exit') {
        disconnectAll(cmd);
        process.exit(0);
        return;
      }
      if (!followCtl && sessions.length && (cmd === 'move' || cmd === 'follow' || cmd === 'enable')) {
        followCtl = startFollowOrbit(sessions, followTarget || '', log, { mode: moveMode || 'orbit' });
        log(`[move] controller started from live command`);
      }
      if (cmd === 'sound' || cmd === 'voice') {
        (async () => {
          try {
            if (msg.stop) {
              soundFrames = null;
              for (const s of sessions) {
                try { s.voice?.stop?.(); } catch {}
              }
              log(`[voice] LIVE sound stopped`);
              return;
            }
            const name = msg.path || msg.file || msg.sound || msg.value || '';
            if (!name) {
              log(`[voice] sound cmd missing path`);
              return;
            }
            const soundPath = path.isAbsolute(name) ? name : path.join(ROOT, 'voice', 'soundboard', name);
            if (!fs.existsSync(soundPath)) {
              log(`[voice] sound not found: ${soundPath}`);
              return;
            }
            const vol = typeof msg.volume === 'number' ? msg.volume : soundVolume;
            soundVolume = vol;
            soundFrames = await prepareSound(soundPath, log, vol);
            log(`[voice] LIVE sound → ${path.basename(soundPath)} (${(soundFrames.length * 60 / 1000).toFixed(1)}s)`);
            for (const s of sessions) {
              try {
                if (!s.voice?.connected) await joinVoiceForSession(s, cfg, roomCode, region);
                if (s.voice) s.voice.play(soundFrames, true);
              } catch (e) {
                log(`[${s.tag}] voice fail: ${e.message}`);
              }
            }
          } catch (e) {
            log(`[voice] LIVE sound fail: ${e.message}`);
          }
        })();
        return;
      }
      if (cmd === 'volume') {
        const vol = typeof msg.volume === 'number' ? msg.volume : Number(msg.value);
        if (Number.isFinite(vol)) {
          soundVolume = Math.max(0.05, Math.min(2, vol));
          log(`[voice] LIVE volume → ${soundVolume}`);
          // Re-apply current frames at new volume requires re-prepare; just note for next sound swap
        }
        return;
      }
      if (!followCtl) {
        if (cmd === 'move' || cmd === 'follow' || cmd === 'enable') {
          log(`[move] no controller yet (bots not joined?)`);
        }
        return;
      }
      if (cmd === 'move' || cmd === 'mode') {
        followCtl.setMode(msg.mode || msg.value || msg.move);
      } else if (cmd === 'follow') {
        followCtl.setFollow(msg.target || msg.follow || msg.value || '');
      } else if (cmd === 'enable' || cmd === 'pause') {
        const on = cmd === 'pause' ? false : (msg.value !== false && msg.enabled !== false);
        followCtl.setEnabled(on);
      } else if (cmd === 'ping') {
        log(`[move] state ${JSON.stringify(followCtl.getState())}`);
      }
    });
  } catch (e) {
    log(`[move] stdin control unavailable: ${e.message}`);
  }

  (async () => {
    for (;;) {
      await sleep(10000);
      for (const s of sessions) {
        if (!s.session?.client?.connected) {
          log(`reconnecting ${s.tag}...`);
          const re = await joinOne(s.account, cfg, roomCode, region, nickname);
          if (re && typeof re === 'object') {
            Object.assign(s, re);
            if (soundFrames) {
              try {
                await joinVoiceForSession(s, cfg, roomCode, region);
                if (s.voice) s.voice.play(soundFrames, true);
              } catch {}
            }
          }
        }
      }
    }
  })();

  process.on('SIGINT', () => { disconnectAll('SIGINT'); process.exit(0); });
  process.on('SIGTERM', () => { disconnectAll('SIGTERM'); process.exit(0); });

  for (;;) { await sleep(30000); }
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });