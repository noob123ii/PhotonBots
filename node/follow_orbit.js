'use strict';

// Follow + multi-mode movement for GUI bots.

const RIG_VIEW_COUNT = 4;

const MOVE_MODES = [
  'orbit',    // horizontal circle
  'hover',    // linked formation, smooth up/down bob
  'cycle',    // visit every player one-by-one
  'scar',     // dash into face then yank away fast
  'stick',    // glue beside target
  'swarm',    // tight cluster around target
  'figure8',  // figure-8 path
  'spiral',   // circling while radius pulses
  'train',    // bots in a line behind target
  'mirror',   // mirror offset of target movement
  'cock',     // anatomical formation + tip spray
  'bounce',   // orbit + vertical hop
  'zigzag',   // weave in X while circling
  'halo',     // high circle above head
  'wave',     // line in front with sine height
  'box',      // march around square path
  'tornado',  // rising spiral, tight + fast
  'pendulum', // swing left-right in front
  'helix',    // vertical helix around target
  'scatter',  // jitter around stick ring
  'kiss',     // close in front of face
  'cage',     // box corners/edges around player
  'flower',   // petals expand/contract
  'bob'       // stick ring + shared vertical bob
];

const MODE_ALIASES = {
  'figure-8': 'figure8', figure8: 'figure8',
  'cycle players': 'cycle', cycleplayers: 'cycle', cycle: 'cycle',
  hover: 'hover', scar: 'scar', stick: 'stick', swarm: 'swarm',
  spiral: 'spiral', train: 'train', mirror: 'mirror', orbit: 'orbit',
  cock: 'cock',
  bounce: 'bounce', zigzag: 'zigzag',
  halo: 'halo', wave: 'wave', box: 'box', tornado: 'tornado',
  pendulum: 'pendulum', helix: 'helix', scatter: 'scatter',
  kiss: 'kiss', cage: 'cage', flower: 'flower', bob: 'bob'
};

/**
 * Parse a mode string into a deduped array of valid MOVE_MODES.
 * Accepts separators: + , & |
 * e.g. "orbit", "orbit+hover", "cock,spiral"
 */
function parseModes(raw, opts = {}) {
  const fallback = opts.fallback !== false;
  const text = String(raw == null ? '' : raw).toLowerCase().trim();
  if (!text || text === 'true') {
    return fallback ? ['orbit'] : [];
  }
  // Explicit freeze / clear all movement
  if (text === 'none' || text === 'freeze' || text === 'off' || text === 'false') {
    return [];
  }
  const parts = text.split(/[+,&|]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const cleaned = part.replace(/[^a-z0-9]/g, '');
    const resolved = MODE_ALIASES[part] || MODE_ALIASES[cleaned] || cleaned;
    if (resolved === 'none' || resolved === 'freeze' || resolved === 'off') continue;
    if (!MOVE_MODES.includes(resolved) || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  if (!out.length) return fallback ? ['orbit'] : [];
  return out;
}

function unpackWorldPos(packed) {
  const v = BigInt(packed), mask = 0x1FFFFFn;
  return [
    (Number(v & mask) - 1048576) / 1024,
    (Number((v >> 21n) & mask) - 1048576) / 1024,
    (Number((v >> 42n) & mask) - 1048576) / 1024
  ];
}

function packWorldPos(x, y, z) {
  const c = (v) => Math.max(0, Math.min(2097151, Math.round(v * 1024) + 1048576));
  return BigInt(c(x)) + (BigInt(c(y)) << 21n) + (BigInt(c(z)) << 42n);
}

function asShort(n) {
  if (n && typeof n.__short === 'number') return n;
  return { __short: (typeof n === 'number' ? n : 0) | 0 };
}

function fixBodyWireTypes(view) {
  if (!Array.isArray(view) || view.length < 12) return view;
  const usingNewIK = view[5] === true;
  if (usingNewIK) {
    if (view.length > 8) { view[7] = asShort(view[7]); view[8] = asShort(view[8]); }
    if (view.length > 14) view[14] = asShort(view[14]);
  } else if (view.length > 11) {
    view[11] = asShort(view[11]);
  }
  return view;
}

function lerp3(cur, tx, ty, tz, a) {
  if (cur.sx == null) { cur.sx = tx; cur.sy = ty; cur.sz = tz; return; }
  cur.sx += (tx - cur.sx) * a;
  cur.sy += (ty - cur.sy) * a;
  cur.sz += (tz - cur.sz) * a;
}

/**
 * Start follow + movement for joined sessions.
 * opts.mode: single or multi — "orbit", "orbit+hover", "cock,spiral", …
 * opts.orbit: legacy bool (false → stick)
 */
function startFollowOrbit(sessions, followName, log, opts = {}) {
  let modes;
  {
    const raw = opts.mode;
    if (raw == null || raw === '' || String(raw).toLowerCase() === 'true') {
      modes = [opts.orbit === false ? 'stick' : 'orbit'];
    } else {
      modes = parseModes(raw);
    }
  }
  const modesJoined = () => (modes.length ? modes.join('+') : 'freeze');

  const CIRCLE_R = opts.radius ?? 1.05;
  const YAW_SPEED = opts.yawSpeed ?? 1.15;
  const LERP = opts.lerp ?? 0.18;
  const sendMs = opts.sendMs ?? 50;
  const cycleSec = opts.cycleSec ?? 6;
  const scarClose = opts.scarClose ?? 0.35;
  const scarFar = opts.scarFar ?? 4.5;
  const hoverAmp = opts.hoverAmp ?? 1.15;
  const hoverSpeed = opts.hoverSpeed ?? 1.35;

  let ev201 = 0, ev206 = 0, moveSent = 0;
  let targetFound = false;
  let targetActorNr = 0;
  const targetViews = new Map();
  const reliableViewIds = new Set();
  let targetEvents = 0;
  let lastTargetEventAt = 0;
  let lastPos = null;
  let bodyViewId = 0;
  let posFieldIndex = -1;
  let targetFacingDeg = 0; // player body yaw — formation forward only
  // Frozen rig snapshot: wire layout + bone offsets from first lock (NOT live head/IK)
  let frozenRig = null; // { template, bodyIdx, bones: [{i,dx,dy,dz}] }

  // All other players' latest positions (for cycle mode)
  const playerPos = new Map(); // actorNr -> { pos, name, at }
  let cycleList = [];
  let cycleIdx = 0;
  let nextCycleAt = Date.now() + cycleSec * 1000;
  let scarPhase = 0; // 0 approach, 1 hold, 2 retreat
  let scarPhaseUntil = 0;
  let sharedBobT = 0;

  let syncedServerTs = 0;
  let syncedServerTsAt = 0;
  function noteServerTs(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    syncedServerTs = v | 0;
    syncedServerTsAt = Date.now();
  }
  function photonTs() {
    if (!syncedServerTsAt) return (Date.now() & 0x7fffffff);
    return (syncedServerTs + (Date.now() - syncedServerTsAt)) | 0;
  }

  function readPos(view) {
    if (!Array.isArray(view)) return null;
    for (const el of view) {
      if (typeof el === 'bigint') {
        try {
          const p = unpackWorldPos(el);
          if (Math.abs(p[0]) < 200 && Math.abs(p[1]) < 200 && Math.abs(p[2]) < 200) return p;
        } catch {}
      }
    }
    return null;
  }
  function findPosIndex(view) {
    if (!Array.isArray(view)) return -1;
    for (let i = 3; i < view.length; i++) {
      if (typeof view[i] !== 'bigint') continue;
      try {
        const p = unpackWorldPos(view[i]);
        if (Math.abs(p[0]) < 200 && Math.abs(p[1]) < 200 && Math.abs(p[2]) < 200) return i;
      } catch {}
    }
    return -1;
  }
  function mergeView(prev, next) {
    const merged = next.slice();
    if (prev) {
      for (let i = 0; i < merged.length && i < prev.length; i++) {
        if (merged[i] === null || merged[i] === undefined) merged[i] = prev[i];
      }
    }
    return merged;
  }

  function ourActorNrs() {
    const set = new Set();
    for (const s of sessions) {
      if (s.session?.actorNr) set.add(s.session.actorNr);
    }
    return set;
  }

  function resolveTargetFromRoster() {
    if (!followName) return 0;
    for (const s of sessions) {
      const list = typeof s.session.actorList === 'function'
        ? s.session.actorList()
        : [...(s.session.actors?.values?.() || [])];
      for (const a of list) {
        if (a.name && a.name.toLowerCase() === followName.toLowerCase()) return a.actorNr;
      }
    }
    return 0;
  }

  function rebuildCycleList() {
    const ours = ourActorNrs();
    const now = Date.now();
    const entries = [];
    for (const [nr, info] of playerPos) {
      if (ours.has(nr)) continue;
      if (now - info.at > 8000) continue;
      entries.push({ nr, name: info.name || `#${nr}`, pos: info.pos });
    }
    // Prefer named follow target first in the rotation
    if (followName) {
      entries.sort((a, b) => {
        const am = a.name.toLowerCase() === followName.toLowerCase() ? 0 : 1;
        const bm = b.name.toLowerCase() === followName.toLowerCase() ? 0 : 1;
        return am - bm || a.nr - b.nr;
      });
    } else {
      entries.sort((a, b) => a.nr - b.nr);
    }
    cycleList = entries;
  }

  targetActorNr = resolveTargetFromRoster();
  if (modes.includes('cycle')) {
    log(`[move] mode=cycle — will rotate through room players`);
  } else if (targetActorNr) {
    log(`[follow] roster: ${followName} = actor ${targetActorNr}`);
  } else if (followName) {
    log(`[follow] roster: ${followName} not in room yet`);
  }

  for (const s of sessions) {
    s.session.on('actorJoin', (info) => {
      if (!info?.name) return;
      if (followName && info.name.toLowerCase() === followName.toLowerCase()) {
        targetActorNr = info.actorNr;
        log(`[follow] ${followName} joined as actor ${targetActorNr}`);
      }
    });

    s.session.on('customEvent', (code, data, actorNr) => {
      if (code === 201) ev201++;
      if (code === 206) ev206++;
      if ((code !== 201 && code !== 206) || !Array.isArray(data)) return;
      noteServerTs(data[0]);

      let senderNr = typeof actorNr === 'number' ? actorNr : undefined;
      if (senderNr === undefined || senderNr === 0) {
        for (let i = 2; i < data.length; i++) {
          const el = data[i];
          const vid = Array.isArray(el) ? el[0] : el;
          if (typeof vid === 'number' && vid > 999) { senderNr = Math.floor(vid / 1000); break; }
        }
      }
      if (!senderNr) return;

      const actor = s.session.actors.get(senderNr);
      const actorName = (actor?.name || '').toLowerCase();
      const anyPos = data.map(readPos).find(Boolean) || null;
      if (anyPos && !ourActorNrs().has(senderNr)) {
        playerPos.set(senderNr, { pos: anyPos, name: actor?.name || '', at: Date.now() });
      }

      const nameMatch = !!followName && actorName === followName.toLowerCase();
      const actorMatch = targetActorNr > 0 && senderNr === targetActorNr;
      const isCycle = modes.includes('cycle');
      const isFocus = isCycle
        ? (targetActorNr > 0 ? senderNr === targetActorNr : nameMatch)
        : (actorMatch || nameMatch);

      if (!isFocus && !isCycle) {
        // still track positions above; don't lock views
        return;
      }
      if (!isFocus && isCycle && !nameMatch && senderNr !== targetActorNr) return;

      if (nameMatch && !isCycle) targetActorNr = senderNr;

      targetEvents++;
      lastTargetEventAt = Date.now();

      for (let i = 2; i < data.length; i++) {
        const view = data[i];
        if (!Array.isArray(view) || typeof view[0] !== 'number') continue;
        const vid = view[0];
        if (Math.floor(vid / 1000) !== senderNr) continue;
        const merged = mergeView(targetViews.get(vid), view);
        targetViews.set(vid, merged);
        if (code === 206) reliableViewIds.add(vid);
        if (vid === senderNr * 1000 + 1) {
          bodyViewId = vid;
          if (posFieldIndex < 0) posFieldIndex = findPosIndex(merged);
          if (typeof merged[10] === 'number') targetFacingDeg = merged[10] & 0x1ff;
          if (!frozenRig) captureFrozenRig(merged);
        }
      }

      if (!targetFound && targetViews.size) {
        targetFound = true;
        log(`[follow] locked — mode=${modesJoined()} views=${targetViews.size} body=${bodyViewId || (targetActorNr * 1000 + 1)}`);
      }

      const body = bodyViewId ? targetViews.get(bodyViewId) : null;
      const p = (body && readPos(body)) || anyPos;
      if (p) {
        if (!lastPos || Math.hypot(p[0] - lastPos[0], p[1] - lastPos[1], p[2] - lastPos[2]) > 0.45) {
          log(`[follow] pos: [${p.map((v) => v.toFixed(2)).join(', ')}]`);
        }
        lastPos = p;
        if (body && posFieldIndex >= 0) {
          body[posFieldIndex] = packWorldPos(p[0], p[1], p[2]);
          targetViews.set(bodyViewId, body);
        }
      }
    });
  }
  log(`[move] listening (${modesJoined()})${followName ? ` follow=${followName}` : ''}...`);

  // Shared formation clock — every bot uses the same angle + an even slot offset
  // so N bots sit at 0, 2π/N, 4π/N, … and stay evenly spaced while rotating.
  let formAngle = 0;
  let lastFormT = Date.now() / 1000;

  function ensureState(s) {
    if (s._orbit) return s._orbit;
    s._orbit = {
      radius: CIRCLE_R,
      sx: null, sy: null, sz: null,
      lastT: Date.now() / 1000,
      trainOffset: 0.9
    };
    return s._orbit;
  }

  function slotAngle(si, total) {
    if (total <= 0) return 0;
    return (si / total) * Math.PI * 2;
  }

  function advanceFormAngle() {
    const now = Date.now() / 1000;
    let dt = now - lastFormT;
    if (dt < 0 || dt > 0.35) dt = 0.055;
    lastFormT = now;
    formAngle += YAW_SPEED * dt;
    sharedBobT += dt;
    return dt;
  }

  /** Absolute target pose for one motion mode (cycle is not a pose mode). */
  function modeTarget(m, base, o, si, total, slot) {
    switch (m) {
      case 'stick': {
        const w = placeLocal(base, 0.7 * Math.cos(slot), 0, 0.7 * Math.sin(slot));
        return { x: w.x, y: w.y, z: w.z, a: LERP };
      }
      case 'hover': {
        const spread = total > 1 ? (si - (total - 1) / 2) * 0.75 : 0;
        const bob = Math.sin(sharedBobT * hoverSpeed) * hoverAmp;
        const w = placeLocal(base, spread, bob, 1.1);
        return { x: w.x, y: w.y, z: w.z, a: 0.12 };
      }
      case 'scar': {
        const now = Date.now();
        if (now >= scarPhaseUntil) {
          scarPhase = (scarPhase + 1) % 3;
          scarPhaseUntil = now + (scarPhase === 0 ? 450 : scarPhase === 1 ? 180 : 700);
        }
        const faceAng = formAngle + slot;
        const dist = scarPhase === 0 || scarPhase === 1 ? scarClose : scarFar;
        return {
          x: base[0] + dist * Math.cos(faceAng),
          y: base[1] + (scarPhase === 1 ? 0.35 : 0),
          z: base[2] + dist * Math.sin(faceAng),
          a: scarPhase === 0 ? 0.55 : scarPhase === 2 ? 0.42 : 0.25
        };
      }
      case 'swarm': {
        const pulse = formAngle * 1.7;
        const r = 0.55 + 0.25 * Math.sin(pulse + slot);
        const ang = formAngle * 1.35 + slot;
        return {
          x: base[0] + r * Math.cos(ang),
          y: base[1] + 0.25 * Math.sin(pulse * 1.2 + slot),
          z: base[2] + r * Math.sin(ang),
          a: 0.22
        };
      }
      case 'figure8': {
        const u = formAngle + slot;
        const scale = 1.4;
        return {
          x: base[0] + scale * Math.sin(u),
          y: base[1],
          z: base[2] + scale * Math.sin(u) * Math.cos(u),
          a: LERP
        };
      }
      case 'spiral': {
        const r = 0.6 + 1.2 * (0.5 + 0.5 * Math.sin(formAngle * 0.55));
        const ang = formAngle + slot;
        return {
          x: base[0] + r * Math.cos(ang),
          y: base[1],
          z: base[2] + r * Math.sin(ang),
          a: LERP
        };
      }
      case 'train': {
        const spacing = 0.85;
        const back = 0.9 + (si + 1) * spacing;
        return {
          x: base[0],
          y: base[1],
          z: base[2] - back,
          a: 0.14
        };
      }
      case 'mirror': {
        const fan = total > 1 ? (si - (total - 1) / 2) * (Math.PI / Math.max(total, 1)) * 0.35 : 0;
        const ang = Math.PI + fan;
        return {
          x: base[0] + CIRCLE_R * Math.cos(ang),
          y: base[1],
          z: base[2] + CIRCLE_R * Math.sin(ang),
          a: LERP
        };
      }
      case 'cock': {
        // Low + close, in FRONT of the player (player-local forward)
        const ballN = Math.min(2, total);
        const afterBalls = total - ballN;
        const headN = Math.min(3, afterBalls);
        const leftover = afterBalls - headN;
        const shaftN = leftover <= 4 ? leftover : 4;
        const sprayN = leftover - shaftN;

        const shaftStart = ballN;
        const headStart = ballN + shaftN;
        const sprayStart = ballN + shaftN + headN;

        const tipZ = 0.35 + Math.max(shaftN, 1) * 0.28;
        const tipY = -0.78;

        let lx = 0, ly = -0.7, lz = 0.4;
        let lerpA = LERP;

        if (si < ballN) {
          const bi = si;
          lx = bi === 0 ? -0.32 : 0.32;
          if (ballN === 1) lx = 0;
          ly = -0.95;
          lz = 0.18;
          lerpA = 0.18;
        } else if (si < shaftStart + shaftN) {
          const ki = si - shaftStart;
          lx = 0;
          ly = -0.82;
          lz = 0.32 + ki * 0.28;
          lerpA = 0.16;
        } else if (si < headStart + headN) {
          const hi = si - headStart;
          if (headN === 1) {
            lx = 0; ly = tipY - 0.02; lz = tipZ + 0.18;
          } else if (headN === 2) {
            lx = hi === 0 ? -0.16 : 0.16;
            ly = tipY;
            lz = tipZ + 0.12;
          } else if (hi === 0) {
            lx = 0; ly = tipY - 0.05; lz = tipZ + 0.22;
          } else if (hi === 1) {
            lx = -0.18; ly = tipY + 0.02; lz = tipZ + 0.08;
          } else {
            lx = 0.18; ly = tipY + 0.02; lz = tipZ + 0.08;
          }
          lerpA = 0.18;
        } else {
          const spi = si - sprayStart;
          const sprayTotal = Math.max(sprayN, 1);
          const fan = ((spi / sprayTotal) - 0.5) * 0.9;
          const cycleLen = 2.2;
          const phase = (sharedBobT * 1.1 + spi * (cycleLen / sprayTotal)) % cycleLen;
          const dist = 0.12 + phase * 0.85;
          lx = fan * dist * 0.45;
          ly = tipY - dist * 0.55;
          lz = tipZ + 0.15 + dist * 0.7;
          lerpA = 0.28;
        }

        const w = placeLocal(base, lx, ly, lz);
        return { x: w.x, y: w.y, z: w.z, a: lerpA };
      }
case 'bounce': {
        const ang = formAngle + slot;
        return {
          x: base[0] + CIRCLE_R * Math.cos(ang),
          y: base[1] + Math.abs(Math.sin(sharedBobT * hoverSpeed)) * 1.2,
          z: base[2] + CIRCLE_R * Math.sin(ang),
          a: LERP
        };
      }
      case 'zigzag': {
        const ang = formAngle + slot;
        const weave = Math.sin(formAngle * 3 + slot) * 0.55;
        return {
          x: base[0] + CIRCLE_R * Math.cos(ang) + weave,
          y: base[1],
          z: base[2] + CIRCLE_R * Math.sin(ang),
          a: LERP
        };
      }
      case 'halo': {
        const ang = formAngle + slot;
        const r = 1.3;
        return {
          x: base[0] + r * Math.cos(ang),
          y: base[1] + 1.6,
          z: base[2] + r * Math.sin(ang),
          a: LERP
        };
      }
      case 'wave': {
        const spread = total > 1 ? (si - (total - 1) / 2) * 0.7 : 0;
        const h = Math.sin(sharedBobT * 2.2 + si * 0.85) * 0.9;
        return {
          x: base[0] + spread,
          y: base[1] + h,
          z: base[2] + 1.2,
          a: LERP
        };
      }
      case 'box': {
        const twoPi = Math.PI * 2;
        const t = ((formAngle + slot) % twoPi + twoPi) % twoPi;
        const side = t / (Math.PI / 2);
        const sideIdx = Math.floor(side) % 4;
        const u = side - Math.floor(side);
        const half = CIRCLE_R;
        let ox, oz;
        if (sideIdx === 0) { ox = -half + u * 2 * half; oz = -half; }
        else if (sideIdx === 1) { ox = half; oz = -half + u * 2 * half; }
        else if (sideIdx === 2) { ox = half - u * 2 * half; oz = half; }
        else { ox = -half; oz = half - u * 2 * half; }
        return { x: base[0] + ox, y: base[1], z: base[2] + oz, a: LERP };
      }
      case 'tornado': {
        const ang = formAngle * 2.8 + slot;
        const r = 0.45;
        const rise = 0.4 + 0.9 * (0.5 + 0.5 * Math.sin(formAngle * 0.9 + slot));
        return {
          x: base[0] + r * Math.cos(ang),
          y: base[1] + rise,
          z: base[2] + r * Math.sin(ang),
          a: 0.22
        };
      }
      case 'pendulum': {
        const swing = Math.sin(formAngle) * (Math.PI / 2.5);
        const fan = total > 1 ? (si - (total - 1) / 2) * 0.12 : 0;
        const ang = swing + fan;
        const r = 1.3;
        return {
          x: base[0] + r * Math.sin(ang),
          y: base[1] + 0.15 * (1 - Math.cos(ang)),
          z: base[2] + 1.0 + r * (1 - Math.cos(ang)) * 0.15,
          a: LERP
        };
      }
      case 'helix': {
        const ang = formAngle * 1.6 + slot;
        const r = CIRCLE_R * 0.85;
        const h = Math.sin(formAngle * 0.7 + slot) * 1.1;
        return {
          x: base[0] + r * Math.cos(ang),
          y: base[1] + h,
          z: base[2] + r * Math.sin(ang),
          a: LERP
        };
      }
      case 'scatter': {
        const seed = si * 12.9898 + sharedBobT * 7.13;
        const jx = (Math.sin(seed * 43758.5453) * 2 - 1) * 0.55;
        const jz = (Math.sin(seed * 24634.1839 + 1.7) * 2 - 1) * 0.55;
        const jy = (Math.sin(seed * 15243.9123 + 3.1) * 2 - 1) * 0.35;
        return {
          x: base[0] + 0.7 * Math.cos(slot) + jx,
          y: base[1] + jy,
          z: base[2] + 0.7 * Math.sin(slot) + jz,
          a: 0.2
        };
      }
      case 'kiss': {
        // One bot: in front → ease in to touch → pull back (player-local forward)
        const cycleDur = 5.2;
        const kisser = total > 0 ? Math.floor(sharedBobT / cycleDur) % total : 0;
        const t = (sharedBobT % cycleDur) / cycleDur;
        const farZ = 1.15;
        const touchZ = 0.18;
        let zOff = farZ;
        if (t < 0.18) zOff = farZ;
        else if (t < 0.48) {
          const u = (t - 0.18) / 0.30;
          const e = u * u * (3 - 2 * u);
          zOff = farZ + (touchZ - farZ) * e;
        } else if (t < 0.62) zOff = touchZ;
        else {
          const u = (t - 0.62) / 0.38;
          const e = u * u * (3 - 2 * u);
          zOff = touchZ + (farZ - touchZ) * e;
        }
        if (si === kisser) {
          const w = placeLocal(base, 0, 0.42, zOff);
          return { x: w.x, y: w.y, z: w.z, a: 0.28 };
        }
        // Waiters stay on a ring in front-plane (player-local)
        const w = placeLocal(base, 1.7 * Math.cos(slot), 0, 1.7 * Math.sin(slot));
        return { x: w.x, y: w.y, z: w.z, a: 0.14 };
      }
case 'cage': {
        const a = slot;
        const c = Math.cos(a), sn = Math.sin(a);
        const m = Math.max(Math.abs(c), Math.abs(sn)) || 1;
        const scale = 1.4;
        return {
          x: base[0] + (c / m) * scale,
          y: base[1],
          z: base[2] + (sn / m) * scale,
          a: LERP
        };
      }
      case 'flower': {
        const pulse = 0.4 + 0.7 * (0.5 + 0.5 * Math.sin(sharedBobT * 1.8));
        return {
          x: base[0] + pulse * Math.cos(slot),
          y: base[1],
          z: base[2] + pulse * Math.sin(slot),
          a: LERP
        };
      }
      case 'bob': {
        return {
          x: base[0] + 0.7 * Math.cos(slot),
          y: base[1] + Math.sin(sharedBobT * hoverSpeed) * hoverAmp,
          z: base[2] + 0.7 * Math.sin(slot),
          a: LERP
        };
      }
      case 'orbit':
      default: {
        const ang = formAngle + slot;
        return {
          x: base[0] + o.radius * Math.cos(ang),
          y: base[1],
          z: base[2] + o.radius * Math.sin(ang),
          a: LERP
        };
      }
    }
  }

  
  // Local offset → world using the follow target's facing (lx=right, ly=up, lz=forward)
  function placeLocal(base, lx, ly, lz) {
    const rad = (targetFacingDeg * Math.PI) / 180;
    const fx = Math.sin(rad);
    const fz = Math.cos(rad);
    const rx = Math.cos(rad);
    const rz = -Math.sin(rad);
    return {
      x: base[0] + rx * lx + fx * lz,
      y: base[1] + ly,
      z: base[2] + rz * lx + fz * lz
    };
  }

  function faceYawToward(from, to) {
    if (!from || !to) return targetFacingDeg & 0x1ff;
    const dx = to[0] - from[0];
    const dz = to[2] - from[2];
    return ((Math.atan2(dx, dz) * 180 / Math.PI) + 360) % 360 | 0;
  }

  // Capture ONE snapshot of the body view for Photon wire shape, then never
  // pull live head/hand animation from the follow target again.
  function captureFrozenRig(view) {
    if (!Array.isArray(view) || view.length < 9) return;
    const bodyIdx = posFieldIndex >= 0 ? posFieldIndex : findPosIndex(view);
    if (bodyIdx < 0) return;
    let bodyPos;
    try { bodyPos = unpackWorldPos(view[bodyIdx]); } catch { return; }

    // Neutral standing offsets (right/up/forward in meters) — no player pose copy
    const neutral = [
      { dx: -0.25, dy: 0.0, dz: 0.05 },  // hand-ish
      { dx: 0.25, dy: 0.0, dz: 0.05 },
      { dx: 0.0, dy: 0.35, dz: 0.0 },   // head-ish
      { dx: -0.15, dy: -0.5, dz: 0.0 }, // foot-ish
      { dx: 0.15, dy: -0.5, dz: 0.0 }
    ];
    const bones = [];
    let ni = 0;
    for (let i = 0; i < view.length; i++) {
      if (i === bodyIdx || typeof view[i] !== 'bigint') continue;
      const n = neutral[Math.min(ni, neutral.length - 1)];
      bones.push({ i, dx: n.dx, dy: n.dy, dz: n.dz });
      ni++;
    }

    frozenRig = {
      template: view.slice(),
      bodyIdx,
      bones
    };
    log(`[move] frozen neutral rig (${bones.length} bones) — head/IK will not follow target`);
  }

  function computePose(base, s, si, total, dt) {
    const o = ensureState(s);
    const slot = slotAngle(si, total);

    if (!modes.length) {
      if (o.sx == null) {
        o.sx = base[0]; o.sy = base[1]; o.sz = base[2];
      }
      return [o.sx, o.sy, o.sz];
    }

    let motionModes = modes.filter((m) => m !== 'cycle');
    if (!motionModes.length) motionModes = ['orbit'];

    let sx = 0, sy = 0, sz = 0, sa = 0;
    for (const m of motionModes) {
      const t = modeTarget(m, base, o, si, total, slot);
      sx += t.x;
      sy += t.y;
      sz += t.z;
      sa += t.a;
    }
    const n = motionModes.length;
    lerp3(o, sx / n, sy / n, sz / n, sa / n);
    return [o.sx, o.sy, o.sz];
  }

  // Own pose only: frozen wire template + our position/yaw. Never live-clone target.
  function synthesizeBody(myBase, pose, lookAt) {
    if (!pose) return null;
    const yaw = faceYawToward(pose, lookAt || lastPos);
    const packed = packWorldPos(pose[0], pose[1], pose[2]);

    if (frozenRig) {
      const clone = frozenRig.template.slice();
      clone[0] = myBase;
      const idx = frozenRig.bodyIdx;
      clone[idx] = packed;
      // Bones follow body with fixed neutral offsets (not the player's live IK)
      const rad = (yaw * Math.PI) / 180;
      const fx = Math.sin(rad), fz = Math.cos(rad);
      const rx = Math.cos(rad), rz = -Math.sin(rad);
      for (const b of frozenRig.bones) {
        const wx = pose[0] + rx * b.dx + fx * b.dz;
        const wy = pose[1] + b.dy;
        const wz = pose[2] + rz * b.dx + fz * b.dz;
        clone[b.i] = packWorldPos(wx, wy, wz);
      }
      if (typeof clone[10] === 'number') {
        clone[10] = (clone[10] & ~0x1ff) | (yaw & 0x1ff);
      } else {
        while (clone.length < 11) clone.push(0);
        clone[10] = yaw & 0x1ff;
      }
      // Drop any leftover live rotation blobs that aren't our controlled fields
      // (floats/arrays past the body often carry head look) — zero safe slots
      for (let i = 1; i < clone.length; i++) {
        if (i === idx || i === 10) continue;
        if (frozenRig.bones.some((b) => b.i === i)) continue;
        if (typeof clone[i] === 'number' && i !== 10) {
          // keep booleans/flags in low indices; clear high mystery numbers that look like continuous look
          if (i > 11 && Number.isFinite(clone[i]) && Math.abs(clone[i]) > 1) clone[i] = 0;
        }
      }
      return fixBodyWireTypes(clone);
    }

    return fixBodyWireTypes([
      myBase, false, null,
      0, 0, false,
      0n, 0n,
      packed,
      0, yaw & 0x1ff, asShort(0)
    ]);
  }

  function autoPickTarget() {
    const ours = ourActorNrs();
    let best = null;
    for (const [nr, info] of playerPos) {
      if (ours.has(nr)) continue;
      if (!info.pos) continue;
      if (!best || info.at > best.at) best = { nr, name: info.name || `#${nr}`, at: info.at, pos: info.pos };
    }
    if (best) return best;
    for (const s of sessions) {
      const list = typeof s.session.actorList === 'function'
        ? s.session.actorList()
        : [...(s.session.actors?.values?.() || [])];
      for (const a of list) {
        if (!a || ours.has(a.actorNr)) continue;
        if (a.name) return { nr: a.actorNr, name: a.name, at: Date.now(), pos: null };
      }
    }
    return null;
  }

  let moveTick = 0;
  const moveIvl = setInterval(() => {
    // Soft-pause (Enable movement off) — stop sending entirely
    if (opts._paused) return;

    const isCycle = modes.includes('cycle');
    const frozen = modes.length === 0;

    // Auto-pick a target if none set (non-cycle modes)
    if (!followName && !isCycle && !frozen) {
      const pick = autoPickTarget();
      if (pick) {
        followName = pick.name;
        targetActorNr = pick.nr;
        if (pick.pos) { lastPos = pick.pos; targetFound = true; }
        log(`[follow] auto-target → ${followName} (actor ${targetActorNr})`);
      }
    }

    // Cycle: rotate focus among players (works alone or blended with other modes)
    if (isCycle) {
      rebuildCycleList();
      if (Date.now() >= nextCycleAt && cycleList.length) {
        cycleIdx = (cycleIdx + 1) % cycleList.length;
        const next = cycleList[cycleIdx];
        targetActorNr = next.nr;
        lastPos = next.pos;
        targetFound = true;
        bodyViewId = next.nr * 1000 + 1;
        targetViews.clear();
        reliableViewIds.clear();
        frozenRig = null;
        nextCycleAt = Date.now() + cycleSec * 1000;
        log(`[cycle] → ${next.name} (actor ${next.nr}) ${cycleIdx + 1}/${cycleList.length}`);
      } else if (!lastPos && cycleList.length) {
        const next = cycleList[0];
        targetActorNr = next.nr;
        lastPos = next.pos;
        targetFound = true;
      }
    }

    if (!frozen && ((!followName && !isCycle) || (!targetFound && !lastPos))) return;
    if (!lastPos && !frozen) return;

    moveTick++;
    const sendReliable = moveTick % 5 === 0;
    const ts = photonTs();
    const active = [];
    for (const s of sessions) {
      if (s.session?.client?.connected && s.viewId) active.push(s);
    }
    const total = active.length;
    if (!total) return;
    const dt = frozen ? 0 : advanceFormAngle();
    const base = lastPos || [0, 0, 0];

    for (let si = 0; si < active.length; si++) {
      const s = active[si];
      try {
        const pose = computePose(base, s, si, total, dt);
        // Synthesize our own body — do NOT remap target views (copies their head/IK)
        const body = synthesizeBody(s.viewId, pose, lastPos);
        if (!body) continue;

        s.session.client.sendOp(253, {
          244: { __byte: 201 },
          245: [ts, null, body],
          250: true
        }, false, 0, false);
        moveSent++;

        if (sendReliable) {
          s.session.client.sendOp(253, {
            244: { __byte: 206 },
            245: [ts, null, body],
            250: true
          });
        }
      } catch (e) {
        if (!s._dbgSendErr) { s._dbgSendErr = true; log(`[follow] send error: ${e.message}`); }
      }
    }
  }, sendMs);

  const statusIvl = setInterval(() => {
    const alive = sessions.filter(s => s.session?.client?.connected).length;
    const rate = `ev201x${ev201} ev206x${ev206} moves=${moveSent}/15s`;
    const staleMs = lastTargetEventAt ? Date.now() - lastTargetEventAt : -1;
    const targetRate = `tgtEvx${targetEvents} stale=${staleMs < 0 ? 'never' : (staleMs / 1000).toFixed(1) + 's'}`;
    ev201 = 0; ev206 = 0; moveSent = 0; targetEvents = 0;
    const posStr = lastPos ? `[${lastPos.map(v => v.toFixed(2)).join(', ')}]` : '(?)';
    const who = modes.includes('cycle') && cycleList[cycleIdx] ? cycleList[cycleIdx].name : (followName || '?');
    const modeLabel = modes.length ? modesJoined() : 'freeze';
    log(`${alive}/${sessions.length} alive | ${modeLabel} ×${alive} slots → ${who} @ ${posStr} | ${rate} | ${targetRate}`);
  }, 15000);

  return {
    stop() {
      clearInterval(moveIvl);
      clearInterval(statusIvl);
    },
    setMode(next) {
      const raw = String(next == null ? '' : next).toLowerCase().trim();
      if (raw === 'none' || raw === 'freeze' || raw === 'off' || raw === 'false' || raw === '') {
        modes = [];
        log(`[move] LIVE mode → freeze (no modes)`);
        return true;
      }
      const parsed = parseModes(next, { fallback: false });
      if (!parsed.length) {
        // Explicit empty from parse (none tokens) → freeze; unknown → reject
        if (/none|freeze|off/.test(raw)) {
          modes = [];
          log(`[move] LIVE mode → freeze`);
          return true;
        }
        log(`[move] unknown mode "${next}" (have: ${MOVE_MODES.join(', ')}; multi: orbit+hover; clear: none)`);
        return false;
      }
      const joined = parsed.join('+');
      if (modesJoined() === joined) return true;
      modes = parsed;
      scarPhase = 0;
      scarPhaseUntil = 0;
      log(`[move] LIVE mode → ${joined}`);
      return true;
    },
    setFollow(name) {
      const n = String(name || '').trim();
      followName = n;
      targetActorNr = resolveTargetFromRoster();
      if (!n) {
        const pick = autoPickTarget();
        if (pick) {
          followName = pick.name;
          targetActorNr = pick.nr;
          if (pick.pos) { lastPos = pick.pos; targetFound = true; }
        }
      } else {
        targetFound = false;
        targetViews.clear();
        reliableViewIds.clear();
        frozenRig = null;
      }
      log(`[move] LIVE follow → ${followName || '(none)'} actor=${targetActorNr || '?'}`);
      return true;
    },
    setEnabled(on) {
      opts._paused = !on;
      log(`[move] LIVE ${on ? 'enabled' : 'paused'}`);
      return true;
    },
    getState() {
      return {
        mode: modesJoined(),
        modes: modes.slice(),
        modesJoined: modesJoined(),
        followName,
        targetActorNr,
        targetFound,
        paused: !!opts._paused
      };
    }
  };
}

module.exports = {
  startFollowOrbit,
  packWorldPos,
  unpackWorldPos,
  RIG_VIEW_COUNT,
  MOVE_MODES,
  parseModes
};
