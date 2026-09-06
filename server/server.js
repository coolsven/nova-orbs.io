"use strict";
/* ============================================================================
   NOVA ORBS — dedicated multiplayer server (single file, alleen `ws` nodig)
   - Host game én server tegelijk: serveert ../index.html op / en WebSocket op /
   - Eén arena, authoritatieve simulatie (20 ticks/s), snapshots naar clients
   - Economie: client legt inzet in (bank lokaal), server beheert alleen beurzen
     in de arena. Cashout = purse * 0.95, dood = inzet kwijt.
   Start lokaal:  npm --prefix server install  &&  node server/server.js
   ========================================================================== */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const WORLD = 5500, EAT = 1.15, CASHOUT = 10, RAKE = 0.05;
const START_MASS = 430, MAX_R = 235, FOOD_TARGET = 1000, ARENA_SIZE = 40;
const MAX_PLAYERS = 12, TICK_MS = 50, SNAP_MS = Math.round(1000 / (Number(process.env.SNAP_HZ) || 20)); // hoger = smoother (10 = zuinig, 20 = standaard)

/* ---------- accounts (username + wachtwoord, saldo op server) ---------- */
const ACC_FILE = path.join(__dirname, "accounts.json");
let ACC = {};
// Permanent: zet UPSTASH_URL + UPSTASH_TOKEN als env vars (gratis via console.upstash.com),
// dan overleven accounts elke herstart. Zonder die vars: gewoon lokaal bestandje.
const UP_URL = process.env.UPSTASH_URL, UP_TOKEN = process.env.UPSTASH_TOKEN;
function saveAcc() {
  const data = JSON.stringify(ACC);
  if (UP_URL && UP_TOKEN) {
    fetch(UP_URL + "/set/nova_orbs_accounts", { method: "POST",
      headers: { Authorization: "Bearer " + UP_TOKEN, "Content-Type": "application/json" }, body: data })
      .catch((e) => console.error("upstash save fail:", e.message));
  } else {
    try { fs.writeFileSync(ACC_FILE, data); } catch (e) {}
  }
}
async function accLoad() {
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(UP_URL + "/get/nova_orbs_accounts", { headers: { Authorization: "Bearer " + UP_TOKEN } });
      const j = await r.json();
      if (j && j.result) { ACC = JSON.parse(j.result); console.log("accounts geladen uit Upstash (" + Object.keys(ACC).length + ")"); return; }
    } catch (e) { console.error("upstash load fail:", e.message); }
  }
  try { ACC = JSON.parse(fs.readFileSync(ACC_FILE, "utf8")) || {}; } catch (e) { ACC = {}; }
}
accLoad();
function hashPass(salt, pass) { return crypto.createHash("sha256").update(salt + "::" + pass).digest("hex"); }
function validUser(u) { return /^[A-Za-z0-9_.-]{3,16}$/.test(u); }

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const rr = (m) => clamp(Math.sqrt(m), 4, MAX_R);
const gainEff = (mass) => 1 / (1 + Math.pow(mass / 2600, 0.7));
const speedFor = (mass, base) => clamp(base * Math.pow(START_MASS / mass, 0.18), 105, 365);

const TYPES = {
  aggressive: { label: "Aggressive", chaseR: 1400, fleeR: 260, foodW: 0.15, huntW: 1.0, risk: 0.95, spd: 1.06 },
  defensive:  { label: "Defensive",  chaseR: 500,  fleeR: 950,  foodW: 0.65, huntW: 0.25, risk: 0.12, spd: 1.0 },
  farmer:     { label: "Farmer",     chaseR: 380,  fleeR: 620,  foodW: 0.95, huntW: 0.08, risk: 0.08, spd: 0.94 },
  hunter:     { label: "Hunter",     chaseR: 1700, fleeR: 480,  foodW: 0.25, huntW: 0.95, risk: 0.7,  spd: 1.03 },
  random:     { label: "Random",     chaseR: 900,  fleeR: 600,  foodW: 0.5,  huntW: 0.5,  risk: 0.5,  spd: 1.0 },
  smart:      { label: "Smart",      chaseR: 1250, fleeR: 750,  foodW: 0.55, huntW: 0.7,  risk: 0.55, spd: 1.0 },
};
const TYPE_KEYS = Object.keys(TYPES);
const DIFFS = {
  chill:    { skill: [0.55, 0.85], react: [200, 480], err: [0.15, 0.40], spd: 0.96 },
  normaal:  { skill: [0.72, 0.96], react: [110, 280], err: [0.05, 0.18], spd: 1.03 },
  moeilijk: { skill: [0.85, 1.00], react: [80, 200],  err: [0.02, 0.08], spd: 1.08 },
  pro:      { skill: [0.95, 1.05], react: [60, 140],  err: [0.00, 0.03], spd: 1.13 },
};
const DIFF = DIFFS[process.env.BOT_DIFF] || DIFFS.normaal;
const BOTNAMES = ["Vex","Milo","Zara","Koda","Juno","Pip","Ravi","Sable","Neo","Lux","Onyx","Finn","Iris","Dax","Elif","Noa","Romy","Stijn","Yara","Bram","Liv","Sem","Tess","Mo","Finn","Jace","Lena","Otto","Nina","Rico","Ivy","Leo","Sana","Daan","Evi","Thijs"];
const PAL = ["#5ef2b8","#5aa8ff","#c792ff","#ff8ab2","#ffd84d","#ff8a5c","#6ee7ff","#9df06e","#ff6b6b","#f2f25e"];
const FOODPAL = ["#5ef2b8","#5aa8ff","#c792ff","#ffd84d","#ff8ab2","#6ee7ff","#9df06e"];

function mkCell(x, y, mass, name, color) {
  return { x, y, mass, r: rr(mass), vx: 0, vy: 0, alive: true, name, color,
    purse: 0, kills: 0, tx: x, ty: y, nextThink: 0, mode: "graze", modeUntil: 0,
    type: "smart", skill: 0.8, err: 0.15, chaseR: 800, fleeR: 600,
    wander: { x: rand(300, WORLD - 300), y: rand(300, WORLD - 300) } };
}
function mkFood() {
  return { x: rand(30, WORLD - 30), y: rand(30, WORLD - 30),
    mass: rand(9, 20), color: FOODPAL[(Math.random() * FOODPAL.length) | 0] };
}
let botSeq = 0, botUid = 0;
function mkBot() {
  const i = botSeq++;
  const tk = TYPE_KEYS[i % TYPE_KEYS.length], t = TYPES[tk];
  const c = mkCell(rand(200, WORLD - 200), rand(200, WORLD - 200),
    START_MASS * rand(0.85, 1.2), BOTNAMES[i % BOTNAMES.length] + "·" + t.label.slice(0, 3), PAL[i % PAL.length]);
  c.bid = ++botUid;
  c.type = tk; c.purse = G.wager;
  c.skill = rand(DIFF.skill[0], DIFF.skill[1]);
  c.err = rand(DIFF.err[0], DIFF.err[1]) * (tk === "random" ? 1.6 : 1);
  c.react = DIFF.react; c.spdMul = DIFF.spd;
  c.chaseR = t.chaseR * rand(0.85, 1.15); c.fleeR = t.fleeR * rand(0.85, 1.15);
  return c;
}

/* ---------- game state ---------- */
const G = {
  wager: 100,               // inzet van dit potje (gezet door eerste speler)
  players: new Map(),       // id -> {cell, ws, input, chargeEl, joinT, done}
  bots: [],
  foods: [],
  respawnAt: [],            // timestamps voor bot-respawns
};
for (let i = 0; i < FOOD_TARGET; i++) G.foods.push(mkFood());
for (let i = 0; i < ARENA_SIZE; i++) G.bots.push(mkBot());

let feedQueue = []; // {html, cls} -> broadcast naar alle clients
function feed(html, cls) { feedQueue.push({ html, cls: cls || "" }); if (feedQueue.length > 20) feedQueue.shift(); }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- bot AI (zelfde 6 types als client) ---------- */
function think(b, now, cells, chargingHumans) {
  if (now < b.nextThink) return;
  const T = TYPES[b.type];
  b.nextThink = now + rand(b.react[0], b.react[1]) / Math.max(0.5, b.skill);
  let danger = null, dd = 1e9, prey = null, pd = 1e9, weakest = null, wm = 1e9;
  for (const e of cells) {
    if (e === b || !e.alive) continue;
    const d = Math.hypot(e.x - b.x, e.y - b.y);
    const mis = Math.random() < b.err * 0.15;
    if (e.mass > b.mass * EAT && !mis && d < dd && d < b.fleeR) { dd = d; danger = e; }
    if (b.mass > e.mass * EAT && !mis && d < pd && d < b.chaseR) { pd = d; prey = e; }
    if (e.mass < wm) { wm = e.mass; weakest = e; }
  }
  let tx = b.x, ty = b.y, mode = "graze";
  const R = Math.random();
  if (b.type === "random" && now > b.modeUntil) {
    b.mode = ["flee", "graze", "hunt", "wander"][(Math.random() * 4) | 0];
    b.modeUntil = now + rand(1500, 4500);
  }
  if (danger && (R < T.risk + 0.55 || b.type === "defensive" || (b.type === "random" && b.mode === "flee"))) {
    if (!(b.type === "aggressive" && Math.random() < 0.45)) {
      tx = b.x + (b.x - danger.x) * 2.4; ty = b.y + (b.y - danger.y) * 2.4; mode = "flee";
    }
  }
  if (mode === "graze") {
    let want = null;
    const ch = chargingHumans.find((h) => Math.hypot(h.x - b.x, h.y - b.y) < 1600);
    if (ch && b.type !== "farmer" && b.type !== "defensive") want = ch;
    else if (b.type === "hunter" && weakest && b.mass > weakest.mass * EAT &&
      Math.hypot(weakest.x - b.x, weakest.y - b.y) < b.chaseR) want = weakest;
    else if (prey && R < T.huntW * b.skill + (b.type === "aggressive" ? 0.25 : 0)) want = prey;
    else if (b.type === "smart" && prey) {
      let safe = true;
      for (const e of cells) {
        if (e !== prey && e.alive && e.mass > b.mass * 1.05 && Math.hypot(e.x - prey.x, e.y - prey.y) < 420) { safe = false; break; }
      }
      if (safe || Math.random() < 0.2) want = prey;
    }
    if (want) {
      const lead = (b.type === "smart" || b.type === "hunter") ? 0.55 * b.skill : 0.2;
      tx = want.x + want.vx * lead; ty = want.y + want.vy * lead; mode = "hunt";
    } else if (R < T.foodW || !prey) {
      let bf = null, bfd = 1e9;
      for (let k = 0; k < 30; k++) {
        const f = G.foods[(Math.random() * G.foods.length) | 0]; if (!f) break;
        const d = Math.hypot(f.x - b.x, f.y - b.y); if (d < bfd) { bfd = d; bf = f; }
      }
      if (bf) { tx = bf.x; ty = bf.y; }
    }
  }
  if (b.type === "random" && b.mode === "wander") { tx = b.wander.x; ty = b.wander.y; mode = "wander"; }
  if (mode === "graze" && tx === b.x) {
    if (Math.hypot(b.wander.x - b.x, b.wander.y - b.y) < 90 || Math.random() < 0.02)
      b.wander = { x: rand(200, WORLD - 200), y: rand(200, WORLD - 200) };
    tx = b.wander.x; ty = b.wander.y; mode = "wander";
  }
  const errPx = (1 - Math.min(1, b.skill)) * 70 + (b.type === "random" ? 40 : 0);
  b.tx = clamp(tx + rand(-errPx, errPx), b.r, WORLD - b.r);
  b.ty = clamp(ty + rand(-errPx, errPx), b.r, WORLD - b.r);
  b.mode = mode;
}
function steer(b, dt) {
  const T = TYPES[b.type];
  const ang = Math.atan2(b.ty - b.y, b.tx - b.x);
  const sp = speedFor(b.mass, 300) * T.spd * (0.9 + 0.2 * b.skill) * (b.spdMul || 1);
  b.vx += (Math.cos(ang) * sp - b.vx) * Math.min(1, dt * 4);
  b.vy += (Math.sin(ang) * sp - b.vy) * Math.min(1, dt * 4);
  b.x = clamp(b.x + b.vx * dt, b.r, WORLD - b.r);
  b.y = clamp(b.y + b.vy * dt, b.r, WORLD - b.r);
}
/* voer eten via grid (veel sneller dan alles-vs-alles) */
const GRID = 220, GW = Math.ceil(WORLD / GRID);
function eatFoodGrid(c, grid) {
  const r = c.r + 6;
  const x0 = Math.max(0, ((c.x - r) / GRID) | 0), x1 = Math.min(GW - 1, ((c.x + r) / GRID) | 0);
  const y0 = Math.max(0, ((c.y - r) / GRID) | 0), y1 = Math.min(GW - 1, ((c.y + r) / GRID) | 0);
  const rr2 = (c.r + 4) * (c.r + 4), ge = gainEff(c.mass);
  for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
    const arr = grid[gy * GW + gx];
    if (!arr) continue;
    for (const i of arr) {
      const f = G.foods[i];
      if (!f) continue;
      const dx = f.x - c.x, dy = f.y - c.y;
      if (dx * dx + dy * dy < rr2) { c.mass += f.mass * ge * 1.7; G.foods[i] = null; }
    }
  }
}
function tryEat(a, b) {
  if (!a.alive || !b.alive || a === b) return false;
  if (a.mass < b.mass * EAT) return false;
  if (Math.hypot(a.x - b.x, a.y - b.y) > a.r - b.r * 0.35) return false;
  a.mass += b.mass * 0.82 * gainEff(a.mass) + 60;
  a.purse += b.purse; a.kills++; b.alive = false;
  return true;
}

/* ---------- simulatie ---------- */
function aliveCells() {
  const out = [];
  for (const p of G.players.values()) if (!p.done && p.cell.alive) out.push(p.cell);
  for (const b of G.bots) if (b.alive) out.push(b);
  return out;
}
function tick() {
  const now = Date.now(), dt = TICK_MS / 1000;
  const cells = aliveCells();
  const charging = [...G.players.values()].filter((p) => !p.done && p.cell.alive && p.input.c).map((p) => p.cell);

  // spelers bewegen + cashout-timers
  for (const [id, p] of G.players) {
    if (p.done || !p.cell.alive) continue;
    const c = p.cell;
    const ang = Math.atan2(p.input.y - c.y, p.input.x - c.x);
    const sp = speedFor(c.mass, 335) * (p.input.c ? 0.92 : 1);
    const dist = Math.hypot(p.input.x - c.x, p.input.y - c.y);
    const tv = dist < 10 ? 0 : sp;
    c.vx += (Math.cos(ang) * tv - c.vx) * Math.min(1, dt * 6);
    c.vy += (Math.sin(ang) * tv - c.vy) * Math.min(1, dt * 6);
    c.x = clamp(c.x + c.vx * dt, c.r, WORLD - c.r);
    c.y = clamp(c.y + c.vy * dt, c.r, WORLD - c.r);
    if (c.mass > 3200) c.mass -= c.mass * 0.012 * dt * (c.mass / 3200);
    c.mass = Math.max(60, c.mass); c.r = rr(c.mass);
    if (p.input.c) {
      p.chargeEl += dt;
      if (p.chargeEl >= CASHOUT) return cashOut(id);
    } else p.chargeEl = 0;
  }
  // bots
  for (const b of G.bots) {
    if (!b.alive) continue;
    think(b, now, cells, charging); steer(b, dt);
    if (b.mass > 3200) b.mass -= b.mass * 0.012 * dt * (b.mass / 3200);
    b.mass = Math.max(60, b.mass); b.r = rr(b.mass);
  }
  // voer eten (grid) + aanvullen
  const grid = new Array(GW * GW);
  for (let i = 0; i < G.foods.length; i++) {
    const f = G.foods[i]; if (!f) continue;
    const k = Math.min(GW - 1, (f.y / GRID) | 0) * GW + Math.min(GW - 1, (f.x / GRID) | 0);
    (grid[k] || (grid[k] = [])).push(i);
  }
  for (const c of aliveCells()) eatFoodGrid(c, grid);
  if (G.foods.some((f) => !f)) G.foods = G.foods.filter(Boolean);
  while (G.foods.length < FOOD_TARGET) G.foods.push(mkFood());
  // kills
  const all = aliveCells();
  for (const a of all) {
    if (!a.alive) continue;
    for (const b of all) {
      if (!tryEat(a, b)) continue;
      const pa = ownerOf(a), pb = ownerOf(b);
      if (pa && pa.isPlayer) feed("💰 <b>" + esc(a.name) + "</b> at <b>" + esc(b.name) + "</b> op · <b>+" + fmt(b.purse) + " 🪙</b>", "good");
      else if (pb && pb.isPlayer) { killPlayer(pb.id, a); return; }
      else if (pa || pb) feed("⚔️ " + esc(a.name) + " at " + esc(b.name) + " op", "");
      if (!isPlayerCell(b)) G.respawnAt.push(now + rand(2000, 4000));
    }
  }
  // ---- bots respawnen: altijd aanvullen tot ARENA_SIZE (continu) ----
  G.respawnAt = G.respawnAt.filter((t) => {
    if (now >= t) { spawnBot(); return false; }
    return true;
  });
  const totalAlive = aliveCells().length;
  if (totalAlive < ARENA_SIZE && G.respawnAt.length === 0) spawnBot(); // vangnet: nooit lege map
}
function isPlayerCell(c) { return !!c.pid; }
function ownerOf(cell) {
  if (cell.pid && G.players.has(cell.pid)) return { isPlayer: true, id: cell.pid };
  return null;
}
function spawnBot() {
  const nb = mkBot();
  // weg van spelers spawnen
  const humans = [...G.players.values()].filter((p) => !p.done && p.cell.alive).map((p) => p.cell);
  if (humans.length) {
    let best = null, bd = -1;
    for (let k = 0; k < 8; k++) {
      const x = rand(200, WORLD - 200), y = rand(200, WORLD - 200);
      let md = 1e9;
      for (const h of humans) md = Math.min(md, Math.hypot(h.x - x, h.y - y));
      if (md > bd) { bd = md; best = { x, y }; }
    }
    nb.x = best.x; nb.y = best.y;
  }
  G.bots.push(nb);
  if (G.bots.length > 120) G.bots = G.bots.filter((b) => b.alive).slice(-120); // cap geheugen
}
function fmt(n) { return Math.round(n).toLocaleString("nl-NL"); }

function cashOut(id) {
  const p = G.players.get(id); if (!p || p.done) return;
  p.done = true;
  const got = Math.floor(p.cell.purse * (1 - RAKE));
  p.bank += got;
  if (p.acct && ACC[p.acct]) { ACC[p.acct].bank = p.bank; saveAcc(); }
  send(p.ws, { t: "end", kind: "cash", amount: got, wager: p.wager, bank: p.bank,
    kills: p.cell.kills, mass: Math.round(p.cell.mass),
    time: Math.round((Date.now() - p.joinT) / 1000) });
  feed("✅ <b>" + esc(p.cell.name) + "</b> cashte <b>" + fmt(got) + " 🪙</b> uit", "gold");
  G.players.delete(id);
  G.respawnAt.push(Date.now() + 2500);
}
function killPlayer(id, killer) {
  const p = G.players.get(id); if (!p || p.done) return;
  p.done = true;
  send(p.ws, { t: "end", kind: "death", amount: 0, wager: p.wager, bank: p.bank,
    kills: p.cell.kills, mass: Math.round(p.cell.mass),
    time: Math.round((Date.now() - p.joinT) / 1000),
    killer: killer ? killer.name : "—", purse: Math.round(p.cell.purse) });
  feed("☠️ <b>" + esc(killer ? killer.name : "—") + "</b> at <b>" + esc(p.cell.name) + "</b> op", "bad");
  G.players.delete(id);
  G.respawnAt.push(Date.now() + 2500);
}
function send(ws, o) { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} }
function broadcast(o) { for (const p of G.players.values()) send(p.ws, o); }

/* ---------- login / registreer / gratis claim (los van een potje) ---------- */
function authUser(user, pass, mode) {
  user = String(user || "").trim(); pass = String(pass || "");
  if (!user) return { ok: true, guest: true, bank: 1000 };
  if (!validUser(user)) return { ok: false, reason: "Naam: 3-16 tekens (letters, cijfers, _ . -)" };
  if (pass.length < 4) return { ok: false, reason: "Wachtwoord: minimaal 4 tekens" };
  if (mode === "register") {
    if (ACC[user]) return { ok: false, reason: "Naam bestaat al — klik Login" };
    const salt = crypto.randomBytes(8).toString("hex");
    ACC[user] = { salt, hash: hashPass(salt, pass), bank: 1000, created: Date.now(), lastClaim: 0 };
    saveAcc(); console.log("register", user);
    return { ok: true, acct: ACC[user], bank: 1000, user };
  }
  const acct = ACC[user];
  if (!acct) return { ok: false, reason: "Account onbekend — klik Registreer" };
  if (acct.hash !== hashPass(acct.salt, pass)) return { ok: false, reason: "Verkeerd wachtwoord" };
  return { ok: true, acct, bank: acct.bank, user };
}

/* ---------- snapshots: binair protocol (veel kleiner + sneller dan JSON) ----------
   header: u16 bots, u16 spelers, u16 voer, u16 meta
   cel: u16 id, i16 x, i16 y, u32 massa, i16 vx10, i16 vy10, u32 beurs, u16 kills (20B)
   voer: i16 x, i16 y, u16 massa (6B)
   jij: i16 x,y, u32 massa, i16 vx,vy, u32 beurs, u16 kills, u8 alive, f32 ce, u8 charging (24B)
   meta: u16 id, u8 len, bytes, u8 kleurIdx */
function snapshotBin(forId, withFood) {
  const me = G.players.get(forId);
  const seen = me ? me.seen : null;
  const bcells = [];
  for (const b of G.bots) if (b.alive) bcells.push(b);
  const pcells = [];
  for (const [id, p] of G.players) if (id !== forId && !p.done && p.cell.alive) pcells.push(p);
  let foods = null;
  if (withFood && me) {
    const px = me.cell.x, py = me.cell.y;
    const near = [];
    for (const f of G.foods) {
      if (!f) continue;
      const dx = f.x - px, dy = f.y - py;
      if (dx * dx + dy * dy < 1200 * 1200) near.push(f);
      if (near.length >= 500) break;
    }
    foods = near.slice(0, 180);
  }
  const metaBufs = [];
  const metaFor = (id, name, color) => {
    if (seen && !seen.has(id)) {
      seen.add(id);
      const nb = Buffer.from(String(name).slice(0, 24), "utf8").slice(0, 64);
      metaBufs.push({ id: id & 0xffff, nb, cidx: Math.max(0, PAL.indexOf(color)) });
      if (seen.size > 5000) seen.clear();
    }
  };
  for (const b of bcells) metaFor(b.bid, b.name, b.color);
  for (const p of pcells) metaFor(p.sid, p.cell.name, p.cell.color);
  const nf = foods ? foods.length : 0;
  const metaSize = metaBufs.reduce((s, m) => s + 2 + 1 + m.nb.length + 1, 0);
  const buf = Buffer.allocUnsafe(8 + 20 * (bcells.length + pcells.length) + 6 * nf + 24 + metaSize);
  let o = 0;
  buf.writeUInt16LE(bcells.length, o); o += 2;
  buf.writeUInt16LE(pcells.length, o); o += 2;
  buf.writeUInt16LE(nf, o); o += 2;
  buf.writeUInt16LE(metaBufs.length, o); o += 2;
  const wcell = (id, x, y, mass, vx, vy, purse, kills) => {
    buf.writeUInt16LE(id & 0xffff, o); o += 2;
    buf.writeInt16LE(clamp(Math.round(x), -30000, 30000), o); o += 2;
    buf.writeInt16LE(clamp(Math.round(y), -30000, 30000), o); o += 2;
    buf.writeUInt32LE(Math.max(0, Math.round(mass)), o); o += 4;
    buf.writeInt16LE(clamp(Math.round(vx * 10), -30000, 30000), o); o += 2;
    buf.writeInt16LE(clamp(Math.round(vy * 10), -30000, 30000), o); o += 2;
    buf.writeUInt32LE(Math.max(0, Math.round(purse)), o); o += 4;
    buf.writeUInt16LE(Math.min(65535, kills || 0), o); o += 2;
  };
  for (const b of bcells) wcell(b.bid, b.x, b.y, b.mass, b.vx, b.vy, b.purse, b.kills);
  for (const p of pcells) wcell(p.sid, p.cell.x, p.cell.y, p.cell.mass, p.cell.vx, p.cell.vy, p.cell.purse, p.cell.kills);
  if (foods) for (const f of foods) {
    buf.writeInt16LE(Math.round(f.x), o); o += 2;
    buf.writeInt16LE(Math.round(f.y), o); o += 2;
    buf.writeUInt16LE(Math.min(65535, Math.round(f.mass)), o); o += 2;
  }
  if (me) {
    const c = me.cell;
    buf.writeInt16LE(Math.round(c.x), o); o += 2;
    buf.writeInt16LE(Math.round(c.y), o); o += 2;
    buf.writeUInt32LE(Math.max(0, Math.round(c.mass)), o); o += 4;
    buf.writeInt16LE(clamp(Math.round(c.vx * 10), -30000, 30000), o); o += 2;
    buf.writeInt16LE(clamp(Math.round(c.vy * 10), -30000, 30000), o); o += 2;
    buf.writeUInt32LE(Math.max(0, Math.round(c.purse)), o); o += 4;
    buf.writeUInt16LE(Math.min(65535, c.kills || 0), o); o += 2;
    buf.writeUInt8(c.alive ? 1 : 0, o); o += 1;
    buf.writeFloatLE(me.chargeEl || 0, o); o += 4;
    buf.writeUInt8(me.input.c ? 1 : 0, o); o += 1;
  } else {
    for (let k = 0; k < 24; k++) { buf.writeUInt8(0, o); o += 1; }
  }
  for (const m of metaBufs) {
    buf.writeUInt16LE(m.id, o); o += 2;
    buf.writeUInt8(m.nb.length, o); o += 1;
    m.nb.copy(buf, o); o += m.nb.length;
    buf.writeUInt8(m.cidx & 0xff, o); o += 1;
  }
  return buf;
}
function sendBin(ws, buf) { try { if (ws.readyState === 1) ws.send(buf); } catch (e) {} }
setInterval(() => { try { tick(); } catch (e) { console.error("tick:", e); } }, TICK_MS);
let snapN = 0;
setInterval(() => {
  const withFood = (snapN++ % 2 === 0); // voer elke 2e snapshot: halveert dataverkeer
  for (const [id] of G.players) {
    const p = G.players.get(id);
    if (p && !p.done) sendBin(p.ws, snapshotBin(id, withFood));
  }
  if (feedQueue.length) { const q = feedQueue; feedQueue = []; for (const m of q) broadcast({ t: "feed", html: m.html, cls: m.cls }); }
}, SNAP_MS);

/* ---------- http (serveert het spel) + websocket ---------- */
const ROOT = path.join(__dirname, "..");
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  let file = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const fp = path.normalize(path.join(ROOT, file));
  if (!fp.startsWith(ROOT) || !fp.endsWith(".html")) { res.writeHead(404); res.end("not found"); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server }); // géén perMessageDeflate: binair is al klein en comprimeren geeft CPU-haperingen op gratis hosting
let seq = 0, sidSeq = 0;
wss.on("connection", (ws) => {
  try { ws._socket.setNoDelay(true); } catch (e) {} // geen TCP-bundeling = tot 40ms minder vertraging
  let id = null;
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === "join") {
      if (id && G.players.has(id)) return;
      if (G.players.size >= MAX_PLAYERS) {
        send(ws, { t: "end", kind: "full", amount: 0, wager: 0, kills: 0, mass: 0, time: 0, bank: 0 });
        return;
      }
      // --- account: login of registreer (alleen salted hash wordt bewaard) ---
      const r = authUser(m.user, m.pass, m.mode);
      if (!r.ok) { send(ws, { t: "end", kind: "authfail", reason: r.reason }); return; }
      const acct = r.acct || null;
      let bank = r.bank, dname = r.user || null;
      if (bank < 10) { bank += 500; if (acct) { acct.bank = bank; saveAcc(); } } // starterbonus
      if (G.players.size === 0) G.wager = clamp(Math.round(Number(m.wager) || 100), 10, 100000); // eerste speler bepaalt de tafel-inzet
      if (bank < G.wager) { send(ws, { t: "end", kind: "authfail", reason: "Te weinig saldo voor deze tafel (" + fmt(G.wager) + " 🪙 nodig)" }); return; }
      bank -= G.wager; // inzet server-side ingehouden
      if (acct) { acct.bank = bank; saveAcc(); }
      id = "u" + (++seq) + Math.random().toString(36).slice(2, 6);
      const cell = mkCell(WORLD / 2 + rand(-400, 400), WORLD / 2 + rand(-400, 400), START_MASS, dname || ("Gast-" + id.slice(-4).toUpperCase()), PAL[(Math.random() * PAL.length) | 0]);
      cell.pid = id; cell.purse = G.wager;
      // spreid weg van anderen
      for (const p of G.players.values()) {
        const dx = cell.x - p.cell.x, dy = cell.y - p.cell.y;
        if (Math.hypot(dx, dy) < 700) { cell.x = clamp(cell.x + Math.sign(dx || 1) * 900, 60, WORLD - 60); cell.y = clamp(cell.y + Math.sign(dy || 1) * 900, 60, WORLD - 60); }
      }
      G.players.set(id, { cell, ws, input: { x: cell.x, y: cell.y, c: false }, chargeEl: 0, joinT: Date.now(), done: false, wager: G.wager, acct: dname, bank, seen: new Set(), sid: 60000 + (++sidSeq) });
      send(ws, { t: "welcome", id, wager: G.wager, bank, target: ARENA_SIZE });
      feed("🌐 <b>" + esc(cell.name) + "</b> joined the arena", "");
      console.log("join", id, cell.name, "wager", G.wager, "players", G.players.size);
    } else if (m.t === "auth") {
      const r = authUser(m.user, m.pass, m.mode);
      send(ws, r.ok ? { t: "auth", ok: 1, bank: r.acct ? r.acct.bank : 1000 } : { t: "auth", ok: 0, reason: r.reason });
    } else if (m.t === "claim") {
      const r = authUser(m.user, m.pass, "login");
      if (!r.ok || !r.acct) { send(ws, { t: "auth", ok: 0, reason: (r.reason || "Login eerst met een account") }); }
      else if (Date.now() - (r.acct.lastClaim || 0) < 5 * 60 * 1000) { send(ws, { t: "auth", ok: 0, reason: "Nog even wachten (max 1× per 5 min)" }); }
      else { r.acct.lastClaim = Date.now(); r.acct.bank += 500; saveAcc(); send(ws, { t: "auth", ok: 1, bank: r.acct.bank }); }
    } else if (m.t === "ping") {
      send(ws, { t: "pong", t: m.t });
    } else if (m.t === "input" && id && G.players.has(id)) {
      const p = G.players.get(id);
      p.input.x = clamp(Number(m.x) || p.cell.x, 0, WORLD);
      p.input.y = clamp(Number(m.y) || p.cell.y, 0, WORLD);
      p.input.c = !!m.c;
    }
  });
  ws.on("close", () => {
    if (id && G.players.has(id)) {
      const p = G.players.get(id);
      feed("🌐 <b>" + esc(p.cell.name) + "</b> verliet de arena", "");
      G.players.delete(id);
      G.respawnAt.push(Date.now() + 2500);
    }
  });
});
server.listen(PORT, () => console.log("NOVA ORBS server live op poort " + PORT + " · bots: " + (process.env.BOT_DIFF || "normaal") + " · snapshots: " + Math.round(1000 / SNAP_MS) + "/s"));
