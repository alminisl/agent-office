import { T, characterFrame, helperFrame, critterFrame, drawFloor, drawWall, FURNITURE } from './sprites.js';
import { buildWorld, findPath, projectColor, EXEC_LEVEL } from './world.js';
import { PRESETS, SKINS, HAIRS, SHIRTS, PANTS, HAIR_STYLES, personaFor, styleFor, assignUniqueNames, workStyleFor, ROLES, roleFor } from './personas.js';

const $ = s => document.querySelector(s);
const canvas = $('#office');
const ctx = canvas.getContext('2d');
const viewport = $('#viewport');

const STATUS_COLOR = { busy: '#4cd964', waiting: '#f5b83d', 'your turn': '#c792ff', idle: '#6fb7ff', offline: '#7a7590' };
const WORK_STATES = new Set(['busy', 'waiting']);
// Between turns Claude Code reports "idle" while you read/type. Treat a recently-idle live
// session as "your turn": the agent stays at their desk instead of wandering off.
let YOUR_TURN_MS = 10 * 60 * 1000; // adjustable in dashboard settings
const isYourTurn = s => s.live && s.status === 'idle' && Date.now() - (s.statusSince || 0) < YOUR_TURN_MS;
const displayStatus = s => (isYourTurn(s) ? 'your turn' : s.status);

let allSessions = [];       // everything the server returned
let sessions = [];          // the ones that get a cubicle (respects "show offline")
let world = null;
let staticLayer = null;     // pre-rendered floors + walls
let buffer = null, bctx = null;
let agents = new Map();     // id -> Agent
let helpers = new Map();    // subagent id -> Helper
let particles = [];
let selectedId = null;
let hoverId = null;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let zoom = store.get('zoom', 0); // 0 = auto-fit
let showOffline = store.get('showOffline', true);
YOUR_TURN_MS = store.get('yourTurnMin', 10) * 60000;
let crittersOn = store.get('critters', true);
let time = 0;
let firstLoad = true;
let employeeOfMonth = null;

let BADGES = {};             // achievement id -> {icon, name, hint}
const rand = (a, b) => a + Math.random() * (b - a);
const choice = arr => arr[Math.floor(Math.random() * arr.length)];

// ---------------- data ----------------
async function refresh() {
  let fresh;
  try { fresh = await (await fetch('/api/sessions')).json(); } catch { return; }
  // cubicles are grouped by project ("neighbourhoods"), then ordered by id so seats stay put
  fresh.sort((a, b) => a.project.localeCompare(b.project) || a.id.localeCompare(b.id));
  assignUniqueNames(fresh);
  allSessions = fresh;
  const visible = fresh.filter(s => showOffline || s.live || agents.get(s.id)?.leaving);
  // the layout changes when the set of agents changes or someone moves into a private office
  const layoutKey = list => list.map(s => `${s.id}${(s.level || 1) >= EXEC_LEVEL ? '*' : ''}`).join();
  const changedSet = layoutKey(visible) !== layoutKey(sessions);
  sessions = visible;
  if (changedSet || !world) rebuild();
  for (const s of sessions) agents.get(s.id)?.setSession(s);
  syncHelpers();
  const top = [...allSessions].sort((a, b) => (b.xp || 0) - (a.xp || 0))[0];
  employeeOfMonth = top?.xp ? top.id : null;
  renderStats();
  if (selectedId) updatePanelHeader();
  firstLoad = false;
}

function rebuild() {
  world = buildWorld(sessions);
  buffer = document.createElement('canvas');
  buffer.width = world.W * T; buffer.height = world.H * T;
  bctx = buffer.getContext('2d'); bctx.imageSmoothingEnabled = false;
  staticLayer = document.createElement('canvas');
  staticLayer.width = buffer.width; staticLayer.height = buffer.height;
  const g = staticLayer.getContext('2d');
  for (let y = 0; y < world.H; y++) for (let x = 0; x < world.W; x++) {
    const t = world.tiles[y][x];
    if (t.kind === 'wall') drawWall(g, x, y, world.tiles[y + 1]?.[x] && world.tiles[y + 1][x].kind !== 'wall');
    else drawFloor(g, x, y, t.kind, t.tint);
  }

  const next = new Map();
  for (const room of world.rooms) {
    const s = room.session;
    const existing = agents.get(s.id);
    const a = existing || new Agent(s);
    a.room = room;
    a.setSession(s, true);
    const t = a.tile;
    if (!s.live && !a.leaving) {
      a.away = true; a.release(); a.path = [];     // out of office
    } else if (existing && !a.away && world.walkable[t.y]?.[t.x]) {
      // layout changed: stay where you are and pick something new to do shortly
      a.x = t.x; a.y = t.y; a.path = []; a.spot = null; a.task = null; a.timer = rand(0.3, 2);
    } else if (!existing && !firstLoad) {
      a.enterOffice();                              // a brand new session walks in
    } else {
      a.away = false; a.spot = null; a.placeAt(room.seat);
    }
    next.set(s.id, a);
  }
  agents = next;
  for (const h of helpers.values()) h.replan();
  critters = [];
  resize();
}

// ---------------- agents ----------------
class Agent {
  constructor(session) {
    this.id = session.id;
    this.session = session;
    this.x = 0; this.y = 0; this.dir = 'down'; this.pose = 'stand';
    this.path = []; this.spot = null; this.task = null; this.timer = rand(2, 6);
    this.walkPhase = 0; this.bubble = null; this.bubbleT = 0; this.thinking = false;
    this.quipT = rand(6, 14); this.quip = null; this.celebrateT = 0;
    this.away = false; this.leaving = false;
    this.persona = personaFor(session);
    this.style = styleFor(this.persona);
  }
  setSession(s, silent = false) {
    const prev = this.session;
    this.session = s;
    this.persona = this.draftPersona || personaFor(s); // unsaved edits in the Personality tab win
    this.style = styleFor(this.persona);
    if (!silent && !firstLoad) {
      if (s.level > (prev.level || 0) && prev.level) this.levelUp(s.level);
      const newBadges = (s.badges || []).filter(b => !(prev.badges || []).includes(b));
      if (prev.badges && newBadges.length) this.earn(newBadges);
      if (prev.runState === 'running' && s.runState && s.runState !== 'running') {
        const r = roleFor(this.persona.role);
        this.celebrateT = 3; burst(this.x, this.y, ['#4cd964', '#fff']);
        this.quip = s.runState === 'done' ? '📋 Report is ready!' : '😵 Something went wrong'; this.quipT = -4;
        toast(`${r ? r.icon : '📋'} ${escapeHtml(this.persona.name)} finished${r ? ` the ${escapeHtml(r.label.toLowerCase())} job` : ''}. <a href="#" data-open-report="${this.id}">Read the report</a>`);
      }
      if (prev.live && !s.live) this.leaveOffice();
      if (!prev.live && s.live) this.enterOffice();
    }
    if (prev.status !== s.status && this.working && !this.away && this.spot?.zone !== 'desk') this.goToDesk();
  }
  get working() { return WORK_STATES.has(this.session.status) || isYourTurn(this.session); }
  get offline() { return this.session.status === 'offline'; }
  get tile() { return { x: Math.round(this.x), y: Math.round(this.y) }; }
  get contextPct() { return this.session.contextWindow ? this.session.context / this.session.contextWindow : 0; }
  placeAt(spot) { this.x = spot.x; this.y = spot.y; this.claim(spot); this.arrive(); this.timer = rand(1, 8); }
  claim(spot) { if (this.spot && this.spot !== spot) this.spot.takenBy = null; this.spot = spot; if (spot) spot.takenBy = this.id; }
  release() { if (this.spot) this.spot.takenBy = null; this.spot = null; }

  enterOffice() {
    if (!world) return;
    this.away = false; this.leaving = false;
    this.x = world.spawn.x; this.y = world.spawn.y; this.dir = 'down';
    openElevator();
    this.bubble = choice(['👋', 'Morning!', 'Hi all!']); this.bubbleT = 3;
    this.goToDesk();
  }
  leaveOffice() {
    if (this.away || !world) return;
    this.leaving = true;
    if (!this.goTo(world.spawn, null, 'leave')) { this.away = true; this.leaving = false; }
    else { this.bubble = choice(['👋 Bye!', 'Clocking out', 'See ya']); this.bubbleT = 3; }
  }
  levelUp(level) {
    this.celebrateT = 4;
    this.quip = `⭐ LEVEL UP! Lv ${level}`; this.quipT = -4;
    burst(this.x, this.y, ['#ffe066', '#ff9f43', '#fff', '#7fe3ff']);
    toast(level === EXEC_LEVEL
      ? `🎉 ${escapeHtml(this.persona.name)} reached <b>level ${level}</b> and got promoted to a <b>private office</b>!`
      : `⭐ ${escapeHtml(this.persona.name)} reached <b>level ${level}</b> (${escapeHtml(this.session.rank)})`);
  }
  earn(badges) {
    this.celebrateT = 3;
    burst(this.x, this.y, ['#4cd964', '#fff', '#c792ff']);
    toast(`🏅 ${escapeHtml(this.persona.name)} earned ${badges.map(b => `${BADGES[b]?.icon || ''} <b>${escapeHtml(BADGES[b]?.name || b)}</b>`).join(', ')}`);
  }

  goTo(target, spot = null, task = 'spot') {
    const path = findPath(world, this.tile, target);
    if (!path) return false;
    this.release();
    if (spot) this.claim(spot);
    this.path = path; this.task = task; this.target = target;
    return true;
  }
  goToDesk() { if (this.room?.seat) this.goTo(this.room.seat, this.room.seat, 'desk'); }

  arrive() {
    const sp = this.spot;
    this.path = [];
    if (this.task === 'leave') { this.away = true; this.leaving = false; openElevator(); refresh(); return; }
    if (this.faceTarget) { this.dir = this.faceTarget; this.faceTarget = null; }
    else if (sp) this.dir = sp.dir;
    if (sp?.zone === 'desk') this.timer = rand(15, 40);
    else if (sp) this.timer = rand(...(sp.dur || [6, 14]));
    else this.timer = rand(1, 4);
    this.bubbleT = rand(0.5, 3);
  }

  currentPose() {
    if (this.path.length) return 'walk';
    if (this.celebrateT > 0) return 'stretch';
    const sp = this.spot;
    if (!sp) return 'stand';
    if (sp.zone === 'desk') {
      if (this.session.status === 'busy') return 'type';
      if (this.session.status === 'waiting') return 'raise';
      return 'sit';
    }
    return sp.pose;
  }

  pickActivity() {
    const fav = this.persona.hangout;
    const opts = [
      ['desk', 1], ['kitchen', 2], ['gym', 1.4], ['games', 1.5], ['lounge', 1.5],
      ['wander', 1], ['chat', 1.2], ['visit', 1], ['office', 0.5],
    ].map(([k, w]) => [k, k === fav ? w * 3 : w]);
    let r = Math.random() * opts.reduce((s, o) => s + o[1], 0);
    let pick = opts[0][0];
    for (const [k, w] of opts) { if ((r -= w) <= 0) { pick = k; break; } }

    if (pick === 'desk') return this.goToDesk();
    if (pick === 'wander') { const p = choice(world.wanderPts); if (p) this.goTo(p, null, 'wander'); return; }
    if (pick === 'visit') {
      // peek over a busy colleague's cubicle wall, preferably someone on the same project
      const busy = [...agents.values()].filter(a => a !== this && !a.away && a.session.status === 'busy' && !a.room.visit.takenBy);
      const same = busy.filter(a => a.session.project === this.session.project);
      const target = choice(same.length ? same : busy);
      if (target && this.goTo(target.room.visit, target.room.visit, 'spot')) return;
    }
    if (pick === 'chat') {
      const others = [...agents.values()].filter(a => a !== this && !a.away && !a.working && !a.path.length && a.spot && a.spot.zone !== 'desk');
      const buddy = choice(others);
      if (buddy) {
        const bt = buddy.tile;
        const free = [[0, 1, 'up'], [1, 0, 'left'], [-1, 0, 'right'], [0, -1, 'down']]
          .map(([dx, dy, d]) => ({ x: bt.x + dx, y: bt.y + dy, d }))
          .find(p => world.walkable[p.y]?.[p.x] && !world.spots.some(s => s.x === p.x && s.y === p.y && s.takenBy));
        if (free && this.goTo(free, null, 'chat')) { this.faceTarget = free.d; this.chatWith = buddy; return; }
      }
    }
    const sp = choice(world.spots.filter(s => s.zone === pick && !s.takenBy));
    if (sp) this.goTo(sp, sp, 'spot');
    else { const p = choice(world.wanderPts); if (p) this.goTo(p, null, 'wander'); }
  }

  update(dt) {
    if (this.away) return;
    this.celebrateT -= dt;
    // personality: every so often they mutter something in character
    this.quipT -= dt;
    if (this.quipT <= 0 && this.quip === null) {
      const lines = this.contextPct > 0.8 && this.working ? ['🥵 my head is full…', '🥵 maybe /compact?', '🥵 so… much… context'] : this.working ? this.style.work : this.style.idle;
      this.quip = choice(lines); this.quipT = 3;
    } else if (this.quipT <= 0) { this.quip = null; this.quipT = rand(10, 22); }

    if (this.path.length) {
      const base = this.task === 'leave' ? 3 : this.working ? 4.2 : 2.8 * this.style.speed;
      const speed = base * dt;
      const n = this.path[0];
      const dx = n.x - this.x, dy = n.y - this.y;
      const d = Math.hypot(dx, dy);
      if (Math.abs(dx) > Math.abs(dy)) this.dir = dx > 0 ? 'right' : 'left'; else if (dy) this.dir = dy > 0 ? 'down' : 'up';
      if (d <= speed) { this.x = n.x; this.y = n.y; this.path.shift(); if (!this.path.length) this.arrive(); }
      else { this.x += dx / d * speed; this.y += dy / d * speed; }
      this.walkPhase += speed * 2.2;
      return;
    }
    if (this.leaving) return this.leaveOffice();
    // work always pulls the agent to their desk
    if (this.working) {
      if (this.spot?.zone !== 'desk') this.goToDesk();
      return;
    }
    this.timer -= dt;
    this.bubbleT -= dt;
    if (this.bubbleT <= 0) {
      if (this.bubble) { this.bubble = null; this.bubbleT = rand(4, 10); }
      else { this.bubble = this.idleBubble(); this.bubbleT = rand(2.5, 4); }
    }
    if (this.timer <= 0) {
      this.chatWith = null; this.pickActivity();
      if (!this.path.length) this.timer = rand(1, 3); // couldn't go anywhere: try again a bit later
    }
  }

  idleBubble() {
    if (this.task === 'chat' && this.chatWith) return choice(['💬', '😂', '🤔', '👀', '🙌']);
    if (this.spot?.zone === 'kitchen' && Math.random() < 0.08) return choice(['🔴💊', '🔵💊']);
    return this.spot?.bubble || (this.spot?.zone === 'desk' ? choice(['🤔', '📝', this.style.emoji]) : null);
  }

  styledActivity(label) {
    if (!label) return `${this.style.emoji} working`;
    const [verb, ...rest] = label.split(' ');
    const v = this.style.verbs[verb];
    return v ? `${v} ${rest.join(' ')}` : label;
  }

  bubbleText() {
    if (this.thinking) return '💭 …';
    if (this.quip && this.quipT < 0) return this.quip; // level-up banner
    const s = this.session;
    const atDesk = !this.path.length;
    if (s.status === 'busy' && atDesk) return this.quip ? `${this.style.emoji} ${this.quip}` : this.styledActivity(s.activity);
    if (s.status === 'waiting' && atDesk) return `❗ ${s.waitingFor || 'needs you'}`;
    if (isYourTurn(s) && atDesk) return this.quip ? `${this.style.emoji} ${this.quip}` : '💬 your turn';
    if (this.quip && this.spot && this.spot.zone !== 'desk') return this.quip;
    return this.bubble;
  }

  // small per-personality motion while working
  fidgetOffset() {
    if (this.path.length || this.spot?.zone !== 'desk' || this.session.status !== 'busy') return [0, 0];
    const f = this.contextPct > 0.8 ? 'shake' : this.style.fidget;
    if (f === 'bounce') return [0, -Math.round(Math.abs(Math.sin(time * 7)) * 1.5)];
    if (f === 'shake') return [Math.sin(time * 40) > 0.6 ? 1 : 0, 0];
    if (f === 'sway') return [Math.round(Math.sin(time * 1.6)), 0];
    return [0, 0];
  }

  frameCanvas() {
    const pose = this.currentPose();
    const typing = this.style.typing || 8;
    const f = pose === 'walk' || pose === 'run' ? Math.floor(this.walkPhase) % 4
      : pose === 'type' ? Math.floor(time * typing) % 2
      : ['lift', 'stretch'].includes(pose) ? Math.floor(time * (this.celebrateT > 0 ? 6 : 1.5)) % 2
      : ['paddle', 'punch', 'use'].includes(pose) ? Math.floor(time * 3) % 2 : 0;
    const p = pose === 'run' ? 'walk' : pose;
    return characterFrame(lookFor(this), this.dir, p, pose === 'run' ? Math.floor(time * 10) % 4 : f);
  }
}

// ---------------- helpers (subagents) ----------------
class Helper {
  constructor(info, parent) {
    this.id = info.id; this.info = info; this.parent = parent;
    this.x = world.spawn.x; this.y = world.spawn.y; this.path = []; this.walkPhase = 0; this.done = false;
    openElevator();
    this.replan();
  }
  slot() {
    const siblings = [...helpers.values()].filter(h => h.parent === this.parent && !h.done);
    const k = Math.max(0, siblings.indexOf(this));
    const [x, y] = this.parent.room.helperSlots[k % this.parent.room.helperSlots.length];
    return { x, y };
  }
  replan() {
    if (!this.parent.room) return;
    const target = this.done ? world.spawn : this.slot();
    this.path = findPath(world, { x: Math.round(this.x), y: Math.round(this.y) }, target) || [];
  }
  finish() { if (!this.done) { this.done = true; this.replan(); } }
  update(dt) {
    if (!this.path.length) {
      if (this.done) { helpers.delete(this.id); openElevator(); }
      return;
    }
    const speed = 3.6 * dt, n = this.path[0];
    const dx = n.x - this.x, dy = n.y - this.y, d = Math.hypot(dx, dy);
    if (d <= speed) { this.x = n.x; this.y = n.y; this.path.shift(); } else { this.x += dx / d * speed; this.y += dy / d * speed; }
    this.walkPhase += speed * 2.2;
  }
  bubbleText() {
    if (this.path.length) return this.done ? '✅' : null;
    return Math.floor(time / 4) % 2 ? `🤖 ${this.info.description}` : (this.info.activity || `🤖 ${this.info.description}`);
  }
}

function syncHelpers() {
  if (!world) return;
  const live = new Set();
  for (const s of sessions) {
    const parent = agents.get(s.id);
    if (!parent || parent.away) continue;
    for (const info of s.helpers || []) {
      live.add(info.id);
      const h = helpers.get(info.id);
      if (h) h.info = info; else helpers.set(info.id, new Helper(info, parent));
    }
  }
  for (const h of helpers.values()) if (!live.has(h.id)) h.finish();
}

// ---------------- effects ----------------
let elevatorT = 0;
function openElevator() { elevatorT = 2.2; }
function burst(x, y, colors) {
  for (let i = 0; i < 28; i++) {
    const a = Math.random() * Math.PI * 2, v = rand(20, 55);
    particles.push({ x: x * T + 8, y: y * T - 4, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: rand(0.8, 1.6), c: choice(colors) });
  }
}
function updateEffects(dt) {
  elevatorT -= dt;
  if (world) world.elevator.open = Math.max(0, Math.min(1, elevatorT > 1.6 ? (2.2 - elevatorT) / 0.6 : elevatorT / 0.6));
  for (const p of particles) { p.vy += 90 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
  particles = particles.filter(p => p.life > 0);
}

// ---------------- easter eggs: the Matrix ----------------
const matrix = { on: false, rain: null, rainCtx: null, drops: [], smithT: 25, clones: new Map() };
const SUIT = { shirt: '#141414', pants: '#141414', glasses: true };
const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:=*+-<>¦';

function setMatrix(on) {
  if (matrix.on === on) return;
  matrix.on = on;
  matrix.clones.clear();
  document.body.classList.toggle('matrix', on);
  const cb = document.querySelector('#setMatrix'); if (cb) cb.checked = on;
  toast(on ? '<code>Wake up, Neo… The Matrix has you.</code> (type <code>bluepill</code> to leave)' : 'You wake up in your bed and believe whatever you want to believe.');
  if (on) for (const a of agents.values()) if (!a.away) { a.quip = choice(['Whoa.', 'Déjà vu…', 'There is no spoon']); a.quipT = 3; }
}

// the look an agent is drawn with (Matrix mode puts everyone in a suit)
function lookFor(a) {
  const clone = matrix.clones.get(a.id);
  if (clone) return { ...clone, ...SUIT };
  return matrix.on ? { ...a.persona, ...SUIT } : a.persona;
}

function updateMatrix(dt) {
  if (!matrix.on) return;
  // Agent Smith copies himself onto a coworker every so often
  matrix.smithT -= dt;
  for (const [id, c] of matrix.clones) { c.t -= dt; if (c.t <= 0) matrix.clones.delete(id); }
  if (matrix.smithT <= 0) {
    matrix.smithT = rand(15, 30);
    const smith = [...agents.values()].find(a => a.persona.preset === 'smith' && !a.away);
    const victim = choice([...agents.values()].filter(a => !a.away && a !== smith && !matrix.clones.has(a.id)));
    if (victim) {
      const look = smith ? smith.persona : { skin: '#eab88f', hair: '#2b1b12', hairStyle: 'short' };
      matrix.clones.set(victim.id, { ...victim.persona, skin: look.skin, hair: look.hair, hairStyle: look.hairStyle, t: 8 });
      victim.quip = 'Me too.'; victim.quipT = 3;
      burst(victim.x, victim.y, ['#00ff66', '#0a3']);
    }
  }
}

function drawRain(fs, dpr) {
  const w = canvas.width, h = canvas.height;
  if (!matrix.rain || matrix.rain.width !== w || matrix.rain.height !== h) {
    matrix.rain = document.createElement('canvas'); matrix.rain.width = w; matrix.rain.height = h;
    matrix.rainCtx = matrix.rain.getContext('2d');
    const col = Math.round(fs * 1.2);
    matrix.drops = Array.from({ length: Math.ceil(w / col) }, (_, i) => ({ x: i * col, y: rand(-h, 0), v: rand(0.6, 1.4) }));
  }
  const r = matrix.rainCtx;
  r.fillStyle = 'rgba(0,0,0,0.08)'; r.fillRect(0, 0, w, h);
  r.font = `${fs}px monospace`;
  for (const d of matrix.drops) {
    r.fillStyle = Math.random() < 0.1 ? '#d7ffe0' : '#00ff66';
    r.fillText(GLYPHS[Math.floor(Math.random() * GLYPHS.length)], d.x, d.y);
    d.y += fs * d.v;
    if (d.y > h + fs * 10 && Math.random() < 0.05) d.y = rand(-h / 3, 0);
  }
  // tint the office green, then let the rain glow on top
  ctx.save();
  ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = '#6dff9c'; ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.45; ctx.drawImage(matrix.rain, 0, 0);
  ctx.restore();
}

// White rabbit (click it) and the déjà vu black cat wander through now and then
class Critter {
  constructor(kind, row, repeat = 0) {
    this.kind = kind; this.repeat = repeat; this.row = row;
    this.x = 1; this.y = row; this.dir = 1; this.phase = 0;
    this.path = findPath(world, { x: 1, y: row }, { x: world.W - 2, y: row }) || [];
  }
  update(dt) {
    if (!this.path.length) {
      if (this.repeat > 0) { // déjà vu: exactly the same walk again
        this.repeat--; this.x = 1; this.y = this.row;
        this.path = findPath(world, { x: 1, y: this.row }, { x: world.W - 2, y: this.row }) || [];
        const witness = [...agents.values()].filter(a => !a.away).sort((a, b) => Math.abs(a.y - this.row) - Math.abs(b.y - this.row))[0];
        if (witness) { witness.quip = 'Déjà vu…'; witness.quipT = 3; }
        return true;
      }
      return false;
    }
    const speed = (this.kind === 'rabbit' ? 3.2 : 2) * dt, n = this.path[0];
    const dx = n.x - this.x, dy = n.y - this.y, d = Math.hypot(dx, dy);
    if (dx) this.dir = dx > 0 ? 1 : -1;
    if (d <= speed) { this.x = n.x; this.y = n.y; this.path.shift(); } else { this.x += dx / d * speed; this.y += dy / d * speed; }
    this.phase += speed * 2.5;
    return true;
  }
  draw(g) {
    const img = critterFrame(this.kind, Math.floor(this.phase) % 4);
    const X = Math.round(this.x * T), Y = Math.round(this.y * T);
    if (this.dir < 0) { g.save(); g.translate(X + 16, Y); g.scale(-1, 1); g.drawImage(img, 0, 0); g.restore(); }
    else g.drawImage(img, X, Y);
  }
}
let critters = [];
let critterT = rand(40, 90);
function aisleRows() { const rows = []; for (let y = 1; y < world.yCommon; y++) if (world.walkable[y]?.[1] && world.walkable[y]?.[world.W - 2] && world.tiles[y][10].kind === 'hall') rows.push(y); return rows; }
function spawnCritter(kind) {
  const row = choice(aisleRows());
  if (row) critters.push(new Critter(kind, row, kind === 'cat' ? 1 : 0));
}
function updateCritters(dt) {
  critterT -= dt;
  if (critterT <= 0 && !crittersOn) critterT = 30;
  if (critterT <= 0) { critterT = rand(70, 160); spawnCritter(Math.random() < 0.6 ? 'rabbit' : 'cat'); }
  critters = critters.filter(c => c.update(dt));
}

// typed cheat codes
let typed = '';
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let konami = 0;
document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  konami = e.key === KONAMI[konami] ? konami + 1 : e.key === KONAMI[0] ? 1 : 0;
  if (konami === KONAMI.length) { konami = 0; setMatrix(!matrix.on); }
  if (e.key.length !== 1) return;
  typed = (typed + e.key.toLowerCase()).slice(-12);
  if (/(matrix|redpill|neo)$/.test(typed)) { typed = ''; setMatrix(true); }
  else if (/bluepill$/.test(typed)) { typed = ''; setMatrix(false); }
  else if (/whiterabbit$/.test(typed)) { typed = ''; spawnCritter('rabbit'); }
  else if (/dejavu$/.test(typed)) { typed = ''; spawnCritter('cat'); }
});
console.log('%cWake up, Neo…', 'color:#00ff66;background:#000;font:16px monospace;padding:6px 10px');
console.log('%cThe Matrix has you. Follow the white rabbit. (try typing "matrix" on the office)', 'color:#00ff66;background:#000;font:12px monospace;padding:4px 10px');

// ---------------- rendering ----------------
function scale() {
  if (zoom) return zoom;
  const fit = (viewport.clientWidth - 8) / (world.W * T);
  return Math.max(1.5, Math.min(4, fit));
}

function resize() {
  if (!world) return;
  const s = scale();
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${Math.floor(world.W * T * s)}px`;
  canvas.style.height = `${Math.floor(world.H * T * s)}px`;
  canvas.width = Math.floor(world.W * T * s * dpr);
  canvas.height = Math.floor(world.H * T * s * dpr);
}

function render() {
  if (!world) return;
  const g = bctx;
  g.drawImage(staticLayer, 0, 0);

  // furniture that sits under characters
  for (const o of world.objects) if (o.under) FURNITURE[o.type](g, o.x * T, o.y * T, o, time);

  // y-sorted: blocking furniture + agents + helpers
  const items = [];
  for (const o of world.objects) {
    if (o.under || o.over) continue;
    const owner = o.type === 'desk' ? agents.get(world.rooms[o.room]?.session?.id) : null;
    const on = owner?.session.status === 'busy';
    items.push({ y: o.y + o.h - 0.5, draw: () => FURNITURE[o.type](g, o.x * T, o.y * T, on ? { ...o, on } : o, time) });
  }
  for (const a of agents.values()) {
    if (a.away) {
      // out of office: little sign on the empty chair
      const seat = a.room.seat;
      items.push({ y: seat.y, draw: () => FURNITURE.oooSign(g, seat.x * T, seat.y * T + 8) });
      continue;
    }
    items.push({ y: a.y, draw: () => {
      const [fx, fy] = a.fidgetOffset();
      const px = Math.round(a.x * T) + fx, py = Math.round(a.y * T) + fy;
      if (a.id === selectedId) { g.fillStyle = 'rgba(217,119,87,0.55)'; g.fillRect(px + 2, py + 13, 12, 3); }
      g.drawImage(a.frameCanvas(), px, py - 10);
      if (a.contextPct > 0.8 && a.working && Math.floor(time * 2) % 2) { g.fillStyle = '#7fd1ff'; g.fillRect(px + 13, py - 6, 1, 2); }
    } });
  }
  for (const c of critters) items.push({ y: c.y, draw: () => c.draw(g) });
  for (const h of helpers.values()) {
    items.push({ y: h.y, draw: () => g.drawImage(helperFrame(h.path.length ? Math.floor(h.walkPhase) % 4 : Math.floor(time * 2) % 2), Math.round(h.x * T), Math.round(h.y * T) - 10) });
  }
  items.sort((p, q) => p.y - q.y).forEach(i => i.draw());
  for (const o of world.objects) if (o.over) FURNITURE[o.type](g, o.x * T, o.y * T, o, time);
  for (const p of particles) { g.fillStyle = p.c; g.fillRect(Math.round(p.x), Math.round(p.y), 2, 2); }

  // blit scaled
  const s = scale() * (window.devicePixelRatio || 1);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(buffer, 0, 0, buffer.width * s, buffer.height * s);
  if (matrix.on) drawRain(Math.max(10, Math.round(s * 5.2)), window.devicePixelRatio || 1);
  drawOverlay(s);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

const contextColor = p => (p > 0.8 ? '#ff6b6b' : p > 0.5 ? '#f5b83d' : '#4cd964');

function drawBubble(text, cx, top, fs, dpr, warm) {
  const emojiOnly = [...text].length <= 3 && !/[a-z]/i.test(text);
  ctx.font = emojiOnly ? `${Math.round(fs * 1.3)}px sans-serif` : `600 ${fs}px Inter, sans-serif`;
  const t = emojiOnly ? text : fit(text, 190 * dpr);
  const tw = ctx.measureText(t).width + 12 * dpr, th = (emojiOnly ? fs * 1.3 : fs) + 8 * dpr;
  const bx = cx - tw / 2, by = top - th - 4 * dpr;
  ctx.fillStyle = warm || '#ffffff';
  roundRect(bx, by, tw, th, 6 * dpr); ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx - 4 * dpr, by + th); ctx.lineTo(cx, by + th + 5 * dpr); ctx.lineTo(cx + 4 * dpr, by + th); ctx.fill();
  ctx.fillStyle = '#1d1b26';
  ctx.fillText(t, bx + 6 * dpr, by + th / 2 + 1);
}

function drawOverlay(s) {
  const dpr = window.devicePixelRatio || 1;
  const fs = Math.max(10, Math.round(s * 5.2));
  ctx.textBaseline = 'middle';

  // cubicle nameplates on the front panel: status, name, project, level, title, context bar
  for (const room of world.rooms) {
    const ss = room.session, a = agents.get(ss.id);
    const h = fs * 2 + 13 * dpr;
    const x = room.plaque.x * T * s, y = room.plaque.y * T * s;
    const w = room.plaque.w * T * s;
    const sel = ss.id === selectedId, hov = ss.id === hoverId;
    ctx.globalAlpha = a?.away && !sel && !hov ? 0.7 : 1;
    ctx.fillStyle = sel ? 'rgba(217,119,87,0.95)' : hov ? 'rgba(45,42,60,0.95)' : 'rgba(29,27,38,0.88)';
    roundRect(x, y, w, h, 4 * dpr); ctx.fill();
    ctx.fillStyle = projectColor(ss.project);
    ctx.fillRect(x, y + 3 * dpr, 3 * dpr, h - 6 * dpr);
    ctx.fillStyle = STATUS_COLOR[displayStatus(ss)] || '#999';
    ctx.beginPath(); ctx.arc(x + 11 * dpr, y + 5 * dpr + fs / 2, 4 * dpr, 0, 7); ctx.fill();
    // level chip on the right
    ctx.font = `700 ${Math.round(fs * 0.85)}px Inter, sans-serif`;
    const lv = `Lv ${ss.level || 1}`;
    const lw = ctx.measureText(lv).width + 8 * dpr;
    ctx.fillStyle = '#ffe066';
    roundRect(x + w - lw - 4 * dpr, y + 4 * dpr, lw, fs + 1 * dpr, 3 * dpr); ctx.fill();
    ctx.fillStyle = '#1d1b26';
    ctx.fillText(lv, x + w - lw, y + 5 * dpr + fs / 2);
    ctx.font = `600 ${fs}px Inter, sans-serif`;
    ctx.fillStyle = '#fff';
    const icon = roleFor(a?.persona.role)?.icon;
    const nm = `${icon ? `${icon} ` : ''}${a?.persona.name || ''}`;
    const who = room.kind === 'office' ? `${nm} · ${ss.rank || ''}` : nm;
    ctx.fillText(fit(who, w - 32 * dpr - lw), x + 19 * dpr, y + 5 * dpr + fs / 2);
    ctx.font = `${Math.round(fs * 0.9)}px Inter, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText(fit(a?.away ? `🌴 Out of office · ${ss.title}` : ss.title, w - 14 * dpr), x + 8 * dpr, y + h - 8 * dpr - fs / 2);
    // context gauge
    const pct = Math.min(1, (ss.context || 0) / (ss.contextWindow || 1));
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x + 8 * dpr, y + h - 5 * dpr, w - 16 * dpr, 2 * dpr);
    ctx.fillStyle = contextColor(pct);
    ctx.fillRect(x + 8 * dpr, y + h - 5 * dpr, (w - 16 * dpr) * pct, 2 * dpr);
    ctx.globalAlpha = 1;
  }

  // zone labels
  ctx.font = `${Math.round(fs * 1.05)}px Silkscreen, monospace`;
  for (const z of world.zones) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.textAlign = 'center';
    ctx.fillText(z.label, (z.x0 + z.x1 + 1) / 2 * T * s, (z.y1 + 0.55) * T * s);
  }
  ctx.textAlign = 'left';

  // bubbles + names
  const sorted = [...agents.values()].filter(a => !a.away).sort((p, q) => p.y - q.y);
  for (const a of sorted) {
    const cx = (a.x * T + 8) * s, top = (a.y * T - 12) * s;
    if (a.id === employeeOfMonth) {
      ctx.font = `${Math.round(fs * 1.1)}px sans-serif`; ctx.textAlign = 'center';
      ctx.fillText('👑', cx, (a.y * T - 13) * s + (a.currentPose() === 'sit' || a.currentPose() === 'type' ? 3 * s : 0));
      ctx.textAlign = 'left';
    }
    if (a.id === hoverId || a.id === selectedId) {
      ctx.font = `600 ${fs}px Inter, sans-serif`;
      const label = `${a.persona.name} · Lv ${a.session.level || 1}`;
      const nw = ctx.measureText(label).width + 12 * dpr;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      roundRect(cx - nw / 2, (a.y * T + 17) * s, nw, fs + 6 * dpr, 4 * dpr); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
      ctx.fillText(label, cx, (a.y * T + 17) * s + (fs + 6 * dpr) / 2);
      ctx.textAlign = 'left';
    }
    const text = a.bubbleText();
    if (!text) continue;
    const warm = a.quipT < 0 && a.quip ? '#fff3b0' : a.session.status === 'waiting' && !a.path.length ? '#fff4d6' : null;
    drawBubble(text, cx, top - (a.id === employeeOfMonth ? 6 * s : 0), fs, dpr, warm);
  }
  for (const h of helpers.values()) {
    const text = h.bubbleText();
    if (text) drawBubble(text, (h.x * T + 8) * s, (h.y * T - 12) * s, Math.round(fs * 0.9), dpr, '#ffe9df');
  }
}

function fit(text, maxW) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1; }
  return text.slice(0, lo) + '…';
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now; time += dt;
  if (world) { for (const a of agents.values()) a.update(dt); for (const h of helpers.values()) h.update(dt); updateEffects(dt); updateMatrix(dt); updateCritters(dt); render(); }
  requestAnimationFrame(loop);
}

// ---------------- interaction ----------------
function agentAt(evt) {
  const rect = canvas.getBoundingClientRect();
  const s = scale();
  const wx = (evt.clientX - rect.left) / s / T, wy = (evt.clientY - rect.top) / s / T;
  let hit = null;
  for (const a of agents.values()) {
    if (a.away) continue;
    if (wx >= a.x && wx <= a.x + 1 && wy >= a.y - 0.6 && wy <= a.y + 1 && (!hit || a.y > hit.y)) hit = a;
  }
  if (hit) return hit;
  // clicking a nameplate selects that cubicle's agent
  const room = world.rooms.find(r => wy >= r.plaque.y && wy <= r.plaque.y + 0.95 && wx >= r.plaque.x && wx <= r.plaque.x + r.plaque.w);
  return room ? agents.get(room.session.id) : null;
}

canvas.addEventListener('mousemove', e => {
  const a = world && agentAt(e);
  hoverId = a?.id || null;
  canvas.style.cursor = a ? 'pointer' : 'default';
});
canvas.addEventListener('click', e => {
  const rect = canvas.getBoundingClientRect(), sc = scale();
  const wx = (e.clientX - rect.left) / sc / T, wy = (e.clientY - rect.top) / sc / T;
  const rabbit = critters.find(c => c.kind === 'rabbit' && Math.abs(c.x + 0.5 - wx) < 0.8 && Math.abs(c.y + 0.5 - wy) < 0.8);
  if (rabbit) { critters = critters.filter(c => c !== rabbit); setMatrix(true); return; }
  const a = world && agentAt(e);
  if (a) select(a.id, true); else closePanel();
});

function resumeCmd(s) {
  const q = p => `'${String(p).replace(/'/g, `'\\''`)}'`;
  return s.cwd ? `cd ${q(s.cwd)} && claude --resume ${s.id}` : `claude --resume ${s.id}`;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(`Copied <code>${escapeHtml(text.length > 90 ? `${text.slice(0, 90)}…` : text)}</code>`); }
  catch { toast('Could not access clipboard'); }
}

let toastTimer;
function toast(html) {
  const t = $('#toast'); t.innerHTML = html; t.hidden = false;
  const link = t.querySelector('[data-open-report]');
  if (link) link.onclick = e => { e.preventDefault(); select(link.dataset.openReport, false); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, link ? 8000 : 2600);
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function ago(t) {
  const d = (Date.now() - new Date(t).getTime()) / 1000;
  if (d < 60) return 'just now'; if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`; return `${Math.floor(d / 86400)}d ago`;
}

// ---------------- panel ----------------
let detail = null;
const chats = new Map(); // id -> [{who, text}]

async function select(id, doCopy) {
  const a = agents.get(id);
  if (!a) return;
  const switching = selectedId !== id;
  if (switching) discardDraft();
  selectedId = id;
  $('#panel').hidden = false;
  resize();
  if (doCopy) copy(resumeCmd(a.session));
  updatePanelHeader();
  if (switching) { renderChat(); fillPersonaForm(); $('#tab-work').innerHTML = '<p class="muted">Loading…</p>'; }
  const res = await fetch(`/api/session/${id}`).catch(() => null);
  if (selectedId !== id) return;
  if (!res?.ok) { detail = null; $('#tab-work').innerHTML = '<p class="muted">This session is gone (it may have just ended). It will disappear from the office shortly.</p>'; return; }
  detail = await res.json();
  renderWork();
}

function discardDraft() {
  const prev = agents.get(selectedId);
  if (prev?.draftPersona) { prev.draftPersona = null; prev.setSession(prev.session, true); }
}
function closePanel() { discardDraft(); selectedId = null; $('#panel').hidden = true; resize(); }
$('#closePanel').onclick = closePanel;


function updatePanelHeader() {
  const a = agents.get(selectedId);
  if (!a) return closePanel();
  const s = a.session, p = a.persona;
  $('#pName').textContent = p.name;
  const ds = displayStatus(s);
  const st = $('#pStatus'); st.textContent = ds; st.className = `chip ${ds.replace(' ', '-')}`;
  $('#endBtn').hidden = !s.live;
  $('#hideBtn').hidden = s.live;
  $('#openBtn').hidden = s.live;
  const role = roleFor(p.role);
  $('#pPreset').textContent = `${PRESETS.find(x => x.key === p.preset)?.label || 'Custom personality'}${role ? ` · ${role.icon} ${role.label}` : ''}${s.background ? ' · working in the office' : ''}`;
  $('#pTitle').textContent = s.title;
  $('#pMeta').textContent = `${s.project}${s.gitBranch ? ` · ${s.gitBranch}` : ''} · ${ago(s.updatedAt)}`;
  $('#cmdText').textContent = resumeCmd(s);
  const av = $('#avatar').getContext('2d');
  av.imageSmoothingEnabled = false; av.clearRect(0, 0, 64, 104);
  av.drawImage(characterFrame(p, 'down', 'stand', 0), 0, 0, 64, 104);
}
$('#copyCmd').onclick = () => { const a = agents.get(selectedId); if (a) copy(resumeCmd(a.session)); };

function fmtDuration(ms) {
  const m = Math.round((ms || 0) / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtTokens(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round((n || 0) / 1000)}k`; }

function renderWork() {
  const d = detail;
  if (!d) return;
  const prompts = [...d.prompts].reverse().slice(0, 6);
  const replies = [...d.replies].reverse().slice(0, 3);
  const pct = Math.min(1, (d.context || 0) / (d.contextWindow || 1));
  const into = d.xp - d.levelXp, need = d.nextXp - d.levelXp;
  const rep = d.report, role = roleFor(d.personality?.role);
  const reportHtml = d.runState === 'running'
    ? `<h3>📋 Report</h3><p class="muted small">${role ? role.icon : '🏢'} Working on it in the background… the report appears here when they're done.</p>`
    : rep ? `<div class="report-head"><h3>📋 Report${role ? ` · ${role.icon} ${escapeHtml(role.label)}` : ''}</h3><button class="small" id="copyReport">Copy</button></div>
      <div class="report ${rep.ok ? '' : 'failed'}">${escapeHtml(rep.result)}</div>
      <div class="muted small">${rep.ok ? 'Finished' : 'Failed'} ${ago(rep.endedAt)} · ${fmtDuration(rep.endedAt - rep.startedAt)} · $${(rep.cost || 0).toFixed(2)}. Ask follow-ups in the Ask tab, or open them in a terminal to continue.</div>`
    : '';
  $('#tab-work').innerHTML = `
    ${reportHtml}
    <div class="level-card">
      <div class="lv">Lv ${d.level}</div>
      <div class="lv-body">
        <div class="lv-row"><b>${escapeHtml(d.rank)}</b><span class="muted small">${d.xp.toLocaleString()} XP · ${into}/${need} to Lv ${d.level + 1}</span></div>
        <div class="bar"><div style="width:${Math.round(into / need * 100)}%;background:#ffe066"></div></div>
      </div>
    </div>
    <div class="kv">
      <div><b>${fmtDuration(d.workMs)}</b><span>hands-on work</span></div>
      <div><b>${d.toolCount}</b><span>tool calls</span></div>
      <div><b>${d.promptCount}</b><span>prompts</span></div>
    </div>
    <h3>Context</h3>
    <div class="bar big"><div style="width:${(pct * 100).toFixed(1)}%;background:${contextColor(pct)}"></div></div>
    <div class="muted small">${fmtTokens(d.context)} of ${fmtTokens(d.contextWindow)} tokens (${Math.round(pct * 100)}%)${pct > 0.8 ? '. Getting full, consider <code>/compact</code>' : ''}</div>
    <h3>Achievements</h3>
    <div class="badges">${d.achievements.map(b => `<div class="badge ${d.badges.includes(b.id) ? 'got' : ''}" title="${escapeHtml(b.hint)}"><span>${b.icon}</span>${escapeHtml(b.name)}</div>`).join('')}</div>
    <h3>Stats</h3>
    <div class="kv">
      <div><b>$${(d.cost || 0).toFixed(2)}</b><span>spent</span></div>
      <div><b>+${d.linesAdded || 0} / −${d.linesRemoved || 0}</b><span>lines</span></div>
      <div><b>${d.messageCount}</b><span>messages</span></div>
    </div>
    ${d.prs.length ? `<h3>Pull requests</h3>${d.prs.map(p => `<div><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.repo)} #${p.number}</a></div>`).join('')}` : ''}
    <h3>Latest thoughts</h3>
    ${replies.map(r => `<div class="item"><time>${ago(r.at)}</time>${escapeHtml(r.text)}</div>`).join('') || '<p class="muted">Nothing yet.</p>'}
    <h3>What you asked</h3>
    ${prompts.map(r => `<div class="item"><time>${ago(r.at)}</time>${escapeHtml(r.text)}</div>`).join('') || '<p class="muted">No prompts.</p>'}
    ${d.files.length ? `<h3>Files touched</h3><ul class="files">${d.files.map(f => `<li title="${escapeHtml(f.path)}">${escapeHtml(f.path.replace(d.cwd + '/', ''))} <span>×${f.edits}</span></li>`).join('')}</ul>` : ''}
    ${d.tools.length ? `<h3>Favourite tools</h3><div class="muted small">${d.tools.map(t => `${escapeHtml(t.name)} ×${t.n}`).join(' · ')}</div>` : ''}
    ${d.model ? `<h3>Brain</h3><div class="muted small">${escapeHtml(d.model)}</div>` : ''}`;
  const cr = $('#copyReport');
  if (cr) cr.onclick = () => copy(rep.result);
}

// tabs
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== `tab-${b.dataset.tab}`; });
});

// ask
function renderChat() {
  const log = chats.get(selectedId) || [];
  $('#chat').innerHTML = log.map(m => `<div class="msg ${m.who}${m.thinking ? ' thinking' : ''}">${escapeHtml(m.text)}</div>`).join('');
}

async function ask(question) {
  const id = selectedId, a = agents.get(id);
  if (!a || a.thinking) return;
  const log = chats.get(id) || [];
  chats.set(id, log);
  log.push({ who: 'me', text: question });
  const reply = { who: 'them', text: `${a.persona.name} is thinking…`, thinking: true };
  log.push(reply);
  renderChat();
  a.thinking = true;
  try {
    const res = await fetch(`/api/ask/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `server said ${res.status}`);
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      reply.text = text; reply.thinking = false;
      if (selectedId === id) renderChat();
    }
    if (!text.trim()) reply.text = '(no answer)';
  } catch (e) { reply.text = `⚠️ ${e.message}`; }
  reply.thinking = false;
  a.thinking = false;
  if (selectedId === id) renderChat();
}
$('#askForm').onsubmit = e => { e.preventDefault(); const q = $('#askInput').value.trim(); if (q) { $('#askInput').value = ''; ask(q); } };
document.querySelectorAll('.quick button').forEach(b => b.onclick = () => ask(b.dataset.q));

// personality
$('#presetSelect').innerHTML = PRESETS.map(p => `<option value="${p.key}">${p.label}</option>`).join('') + '<option value="custom">✏️ Custom</option>';
const PALETTES = { skin: SKINS, hair: HAIRS, shirt: SHIRTS, pants: PANTS };
let draft = null;

function fillPersonaForm() {
  const a = agents.get(selectedId);
  if (!a) return;
  draft = { ...a.persona };
  const f = $('#personaForm');
  f.name.value = draft.name; f.preset.value = draft.preset || 'custom'; f.traits.value = draft.traits;
  f.hangout.value = draft.hangout; f.hairStyle.value = draft.hairStyle; f.glasses.checked = !!draft.glasses;
  f.impact.checked = draft.impact !== false;
  renderSwatches(); renderQuirks(); renderWorkStyle();
}
function renderSwatches() {
  document.querySelectorAll('.swatches').forEach(el => {
    const field = el.dataset.field;
    el.innerHTML = PALETTES[field].map(c => `<button type="button" style="background:${c}" data-c="${c}" class="${draft[field] === c ? 'sel' : ''}"></button>`).join('');
    el.querySelectorAll('button').forEach(b => b.onclick = () => { draft[field] = b.dataset.c; renderSwatches(); previewDraft(); });
  });
}
function previewDraft() {
  const a = agents.get(selectedId); if (!a) return;
  const f = $('#personaForm');
  Object.assign(draft, { name: f.name.value, hairStyle: f.hairStyle.value, glasses: f.glasses.checked, hangout: f.hangout.value, traits: f.traits.value, preset: f.preset.value, impact: f.impact.checked });
  renderWorkStyle();
  a.draftPersona = { ...draft };
  a.persona = a.draftPersona; a.style = styleFor(a.persona);
  updatePanelHeader();
}
$('#personaForm').addEventListener('input', previewDraft);
$('#presetSelect').onchange = e => {
  const p = PRESETS.find(x => x.key === e.target.value);
  if (p) { $('#personaForm').traits.value = p.traits; $('#personaForm').hangout.value = p.hangout; draft.quirks = null; renderQuirks(); }
  previewDraft();
};
$('#personaForm').traits.addEventListener('input', () => { $('#presetSelect').value = 'custom'; });
$('#randomize').onclick = () => {
  for (const k of Object.keys(PALETTES)) draft[k] = choice(PALETTES[k]);
  draft.hairStyle = choice(HAIR_STYLES); draft.glasses = Math.random() < 0.35;
  const f = $('#personaForm'); f.hairStyle.value = draft.hairStyle; f.glasses.checked = draft.glasses;
  renderSwatches(); previewDraft();
};
$('#personaForm').onsubmit = async e => {
  e.preventDefault();
  previewDraft();
  const id = selectedId;
  const body = { ...draft, workStyle: draft.impact !== false ? workStyleFor(draft) : '' };
  const saved = await (await fetch(`/api/personality/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const s = sessions.find(x => x.id === id);
  const ag = agents.get(id);
  if (ag) ag.draftPersona = null;
  if (s) { s.personality = saved; ag?.setSession(s, true); }
  toast(`Saved ${escapeHtml(saved.name)}'s personality`);
};

// ---------------- chrome ----------------
function renderStats() {
  const count = st => allSessions.filter(s => displayStatus(s) === st).length;
  $('#stats').innerHTML = ['busy', 'waiting', 'your turn', 'idle', 'offline']
    .map(st => `<span><span class="dot" style="background:${STATUS_COLOR[st]}"></span>${count(st)} ${st}</span>`).join('');
  if (!$('#board').hidden && boardTab !== 'settings') renderBoard();
}

// show offline toggle
$('#showOffline').checked = showOffline;
function setShowOffline(v) { showOffline = v; $('#showOffline').checked = v; $('#setOffline').checked = v; store.set('showOffline', v); refresh(); }
$('#showOffline').onchange = e => setShowOffline(e.target.checked);

// ---------------- office dashboard ----------------
// Motivation is a playful read of the agent's state: busy = in the zone, full context = burned out, etc.
const EAGER = new Set(['intern', 'coach', 'neo']), GRUMPY = new Set(['senior', 'sarcastic', 'smith']);
function motivation(s) {
  const p = personaFor(s), pct = (s.context || 0) / (s.contextWindow || 1);
  const bonus = EAGER.has(p.preset) ? 8 : GRUMPY.has(p.preset) ? -8 : 0;
  const idleMin = (Date.now() - (s.statusSince || s.updatedAt || 0)) / 60000;
  let m;
  if (!s.live) m = { icon: '🌴', label: 'On vacation', score: 10 };
  else if (pct > 0.8) m = { icon: '🥵', label: 'Burned out (context full)', score: 20 };
  else if (s.status === 'busy') m = { icon: '🔥', label: 'In the zone', score: 92 };
  else if (s.status === 'waiting') m = { icon: '🙋', label: 'Blocked on you', score: 60 };
  else if (isYourTurn(s)) m = { icon: '😊', label: 'Eager for the next task', score: 78 };
  else if (idleMin < 60) m = { icon: '☕', label: 'On a break', score: 45 };
  else m = { icon: '😴', label: 'Bored, give them work', score: 25 };
  return { ...m, score: Math.max(0, Math.min(100, m.score + bonus)) };
}
const money = n => `$${(n || 0).toFixed(2)}`;
const agoMs = t => ago(new Date(t || Date.now()));
let boardTab = 'overview';
let empSort = { key: 'status', dir: 1 };
const STATUS_ORDER = { busy: 0, waiting: 1, 'your turn': 2, idle: 3, offline: 4 };

function avatarCell(s) { return `<canvas width="16" height="26" style="width:16px;height:26px" data-av="${s.id}"></canvas>`; }
function paintAvatars(root) {
  root.querySelectorAll('canvas[data-av]').forEach(c => {
    const s = allSessions.find(x => x.id === c.dataset.av);
    if (s) c.getContext('2d').drawImage(characterFrame(personaFor(s), 'down', 'stand', 0), 0, 0);
  });
}
function wireRows(root) {
  root.querySelectorAll('[data-id]').forEach(el => el.onclick = () => {
    $('#board').hidden = true;
    if (agents.has(el.dataset.id)) select(el.dataset.id, false); else toast('That agent is out of office. Turn on <b>Show offline</b> to see their cubicle.');
  });
}

function renderOverview() {
  const list = allSessions, sum = k => list.reduce((t, s) => t + (s[k] || 0), 0);
  const live = list.filter(s => s.live), busy = list.filter(s => s.status === 'busy');
  const workH = sum('workMs') / 3600e3;
  const byProject = {};
  for (const s of list) {
    const p = byProject[s.project] ||= { project: s.project, cost: 0, workMs: 0, agents: 0, live: 0 };
    p.cost += s.cost || 0; p.workMs += s.workMs || 0; p.agents++; if (s.live) p.live++;
  }
  const projects = Object.values(byProject).sort((a, b) => b.cost - a.cost || b.workMs - a.workMs);
  const maxCost = Math.max(...projects.map(p => p.cost), 0.01), maxWork = Math.max(...projects.map(p => p.workMs), 1);
  const needs = list.filter(s => s.status === 'waiting' || isYourTurn(s));
  const avgMot = live.length ? Math.round(live.reduce((t, s) => t + motivation(s).score, 0) / live.length) : 0;
  const pane = document.querySelector('[data-bpane=overview]');
  pane.innerHTML = `
    <div class="kv">
      <div><b>${list.length}</b><span>employees (${live.length} in office)</span></div>
      <div><b>${busy.length}</b><span>working right now</span></div>
      <div><b>${money(sum('cost'))}</b><span>total spend</span></div>
      <div><b>${money(workH ? sum('cost') / workH : 0)}</b><span>per hour of work</span></div>
      <div><b>${fmtDuration(sum('workMs'))}</b><span>hands-on work</span></div>
      <div><b>+${sum('linesAdded').toLocaleString()} / −${sum('linesRemoved').toLocaleString()}</b><span>lines changed</span></div>
      <div><b>${sum('prs')}</b><span>PRs opened</span></div>
      <div><b>${avgMot}%</b><span>office motivation</span></div>
    </div>
    <div class="two">
      <div>
        <h3>Spend by project</h3>
        ${projects.map(p => `<div class="hbar"><span title="${escapeHtml(p.project)}">${escapeHtml(p.project)}</span><div class="bar"><div style="width:${p.cost / maxCost * 100}%;background:${projectColor(p.project)}"></div></div><span>${money(p.cost)}</span></div>`).join('')}
        <h3>Work time by project</h3>
        ${projects.map(p => `<div class="hbar"><span>${escapeHtml(p.project)}</span><div class="bar"><div style="width:${p.workMs / maxWork * 100}%;background:${projectColor(p.project)}"></div></div><span>${fmtDuration(p.workMs)}</span></div>`).join('')}
      </div>
      <div>
        <h3>Working right now</h3>
        <div class="feed">${busy.map(s => `<div data-id="${s.id}">${avatarCell(s)}<b>${escapeHtml(personaFor(s).name)}</b><span class="what">${escapeHtml(s.activity || s.title)}</span></div>`).join('') || '<p class="muted small">Nobody is working. Time to hand out tasks?</p>'}</div>
        <h3>Needs you</h3>
        <div class="feed">${needs.map(s => `<div data-id="${s.id}">${avatarCell(s)}<b>${escapeHtml(personaFor(s).name)}</b><span class="what">${s.status === 'waiting' ? `❗ ${escapeHtml(s.waitingFor || 'waiting for input')}` : '💬 your turn'} · ${escapeHtml(s.title)}</span></div>`).join('') || '<p class="muted small">Nobody is waiting on you. 🎉</p>'}</div>
        <h3>Helpers on the floor</h3>
        <p class="muted small">${helpers.size ? `${helpers.size} 🤖 helper${helpers.size > 1 ? 's' : ''} working for ${new Set([...helpers.values()].map(h => h.parent.persona.name)).size} agent(s)` : 'No helpers right now.'}</p>
      </div>
    </div>`;
}

function renderEmployees() {
  const rows = allSessions.map(s => ({ s, p: personaFor(s), m: motivation(s), ds: displayStatus(s), pct: (s.context || 0) / (s.contextWindow || 1) }));
  const key = {
    name: r => r.p.name, project: r => r.s.project, status: r => STATUS_ORDER[r.ds] ?? 9, level: r => -(r.s.xp || 0),
    cost: r => -(r.s.cost || 0), context: r => -r.pct, motivation: r => -r.m.score, active: r => -(r.s.updatedAt || 0),
  }[empSort.key];
  rows.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * empSort.dir; });
  const th = (k, label) => `<th data-sort="${k}">${label}${empSort.key === k ? (empSort.dir > 0 ? ' ▾' : ' ▴') : ''}</th>`;
  const pane = document.querySelector('[data-bpane=employees]');
  pane.innerHTML = `<table><thead><tr><th></th>${th('name', 'Employee')}${th('project', 'Project')}${th('status', 'Status')}<th>Doing now</th>${th('motivation', 'Motivation')}${th('level', 'Level')}${th('cost', 'Cost')}${th('context', 'Context')}${th('active', 'Last active')}</tr></thead><tbody>
    ${rows.map(({ s, p, m, ds, pct }) => `<tr data-id="${s.id}">
      <td>${avatarCell(s)}</td>
      <td><b>${escapeHtml(p.name)}</b><div class="muted small">${escapeHtml(PRESETS.find(x => x.key === p.preset)?.label || 'Custom')}</div></td>
      <td>${escapeHtml(s.project)}</td>
      <td><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${STATUS_COLOR[ds]}"></span> ${ds === 'offline' ? 'out of office' : ds}</td>
      <td class="muted small" style="max-width:240px">${escapeHtml(s.status === 'busy' ? (s.activity || 'working') : s.title)}</td>
      <td class="mot" title="${escapeHtml(m.label)}">${m.icon} ${m.score}%</td>
      <td>Lv ${s.level || 1}</td>
      <td>${money(s.cost)}</td>
      <td><div class="bar"><div style="width:${Math.min(100, pct * 100)}%;background:${contextColor(pct)}"></div></div><span class="muted small">${fmtTokens(s.context)}</span></td>
      <td class="muted small">${agoMs(s.updatedAt)}</td></tr>`).join('')}
  </tbody></table>`;
  pane.querySelectorAll('th[data-sort]').forEach(h => h.onclick = () => {
    empSort = { key: h.dataset.sort, dir: empSort.key === h.dataset.sort ? -empSort.dir : 1 };
    renderEmployees();
  });
}

function renderLeaderboard() {
  const list = [...allSessions].sort((a, b) => (b.xp || 0) - (a.xp || 0));
  const pane = document.querySelector('[data-bpane=leaderboard]');
  pane.innerHTML = `<table><thead><tr><th>#</th><th></th><th>Agent</th><th>Level</th><th>XP</th><th>Work</th><th>Badges</th></tr></thead><tbody>
    ${list.map((s, i) => `<tr data-id="${s.id}"><td>${i === 0 ? '👑' : i + 1}</td><td>${avatarCell(s)}</td>
      <td><b>${escapeHtml(personaFor(s).name)}</b> <span class="muted small">${escapeHtml(s.project)}</span></td>
      <td>Lv ${s.level || 1} <span class="muted small">${escapeHtml(s.rank || '')}</span></td>
      <td>${(s.xp || 0).toLocaleString()}</td><td>${fmtDuration(s.workMs)}</td>
      <td>${(s.badges || []).map(b => `<span title="${escapeHtml(BADGES[b]?.name || b)}">${BADGES[b]?.icon || ''}</span>`).join('')}</td></tr>`).join('')}
  </tbody></table>
  <p class="muted small">XP: 10 per minute of hands-on work, 2 per tool call, ½ per line changed, 5 per prompt, 30 per helper, 250 per PR. 👑 marks the top agent.</p>`;
}

function renderSettings() {
  $('#setOffline').checked = showOffline;
  $('#setMatrix').checked = matrix.on;
  $('#setCritters').checked = crittersOn;
  $('#setYourTurn').value = String(YOUR_TURN_MS / 60000);
  $('#setInfo').innerHTML = `Terminal: <b>${escapeHtml(config.terminal)}</b> · showing sessions from the last <b>${config.maxDays}</b> days (max <b>${config.maxRooms}</b>). Change with <code>MAX_DAYS</code>, <code>MAX_ROOMS</code> and <code>OFFICE_TERMINAL</code> when starting the server.`;
}

function renderBoard() {
  if ($('#board').hidden) return;
  const pane = document.querySelector(`[data-bpane=${boardTab}]`);
  ({ overview: renderOverview, employees: renderEmployees, leaderboard: renderLeaderboard, settings: renderSettings })[boardTab]();
  paintAvatars(pane); wireRows(pane);
}
function openBoard(tab) { if (tab) boardTab = tab; $('#board').hidden = false; showBoardTab(boardTab); }
function showBoardTab(tab) {
  boardTab = tab;
  document.querySelectorAll('#boardTabs button').forEach(b => b.classList.toggle('active', b.dataset.btab === tab));
  document.querySelectorAll('[data-bpane]').forEach(p => { p.hidden = p.dataset.bpane !== tab; });
  renderBoard();
}
document.querySelectorAll('#boardTabs button').forEach(b => b.onclick = () => showBoardTab(b.dataset.btab));
$('#boardBtn').onclick = () => openBoard();
$('#setOffline').onchange = e => setShowOffline(e.target.checked);
$('#setMatrix').onchange = e => setMatrix(e.target.checked);
$('#setCritters').onchange = e => { crittersOn = e.target.checked; store.set('critters', crittersOn); if (!crittersOn) critters = []; };
$('#setYourTurn').onchange = e => { YOUR_TURN_MS = Number(e.target.value) * 60000; store.set('yourTurnMin', Number(e.target.value)); refresh(); };
$('#setUnhide').onclick = async () => { await post('/api/hide/', { hide: false }); toast('All hidden cubicles are back.'); refresh(); };
$('#setFit').onclick = () => setZoom(0);
$('#setHelp').onclick = () => { $('#board').hidden = true; openHelp(); };

// personality quirks generated by Claude
function renderWorkStyle() {
  const ws = draft && draft.impact !== false ? workStyleFor(draft) : '';
  $('#workStylePreview').innerHTML = ws ? `<b>Work style</b> (used when you start or resume them from the office): ${escapeHtml(ws)}` : '';
}
function renderQuirks() {
  const q = draft?.quirks;
  $('#quirksPreview').innerHTML = q ? `${escapeHtml(q.emoji || '')} <i>${(q.work || []).slice(0, 3).map(escapeHtml).join(' · ')}</i>` : '';
}
$('#genQuirks').onclick = async () => {
  const f = $('#personaForm'), btn = $('#genQuirks');
  btn.disabled = true; btn.textContent = '✨ Asking Claude…';
  try {
    draft.quirks = await post('/api/quirks', { name: f.name.value, traits: f.traits.value });
    renderQuirks(); previewDraft();
    toast('New quirks ready. Save the personality to keep them.');
  } catch (e) { toast(`Could not generate quirks: ${escapeHtml(e.message)}`); }
  btn.disabled = false; btn.textContent = '✨ Generate quirks with Claude';
};
function setZoom(z) { zoom = z; store.set('zoom', zoom); resize(); }
$('#zoomIn').onclick = () => setZoom(Math.min(5, (zoom || scale()) + 0.5));
$('#zoomOut').onclick = () => setZoom(Math.max(1, (zoom || scale()) - 0.5));

// ---------------- session control ----------------
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function openInTerminal() {
  const a = agents.get(selectedId); if (!a) return;
  try { await post(`/api/open/${a.id}`); toast(`Opening ${escapeHtml(a.persona.name)} in ${escapeHtml(config.terminal)}…`); }
  catch (e) { toast(`Could not open terminal: ${escapeHtml(e.message)}`); }
}
$('#openBtn').onclick = openInTerminal;

let endArmed = null;
$('#endBtn').onclick = async () => {
  const a = agents.get(selectedId); if (!a) return;
  const btn = $('#endBtn');
  if (endArmed !== a.id) { // two-step confirm without a browser dialog
    endArmed = a.id; btn.textContent = `Really end ${a.persona.name}'s session?`;
    setTimeout(() => { endArmed = null; btn.textContent = '⏹ End session'; }, 3500);
    return;
  }
  endArmed = null; btn.textContent = '⏹ End session';
  try { await post(`/api/end/${a.id}`); toast(`${escapeHtml(a.persona.name)} has clocked out. Resume any time with the copied command.`); refresh(); }
  catch (e) { toast(`Could not end session: ${escapeHtml(e.message)}`); }
};

async function hideSelected() {
  const a = agents.get(selectedId); if (!a || a.session.live) return;
  await post(`/api/hide/${a.id}`, { hide: true });
  toast(`${escapeHtml(a.persona.name)}'s cubicle was cleared. Unhide from the help screen (?).`);
  closePanel(); refresh();
}
$('#hideBtn').onclick = hideSelected;

// new session
$('#newPreset').innerHTML = PRESETS.map(p => `<option value="${p.key}">${p.label}</option>`).join('');
$('#newRole').innerHTML = '<option value="">👤 General agent (no role)</option>' + ROLES.map(r => `<option value="${r.key}">${r.icon} ${r.label}</option>`).join('');
function syncNewForm() {
  const f = $('#newForm');
  const bg = f.mode.value === 'background';
  $('#hireBtn').textContent = bg ? 'Hire & start working in the office' : 'Hire & open terminal';
  $('#taskHint').textContent = bg ? '(required for office work)' : '(optional)';
  f.prompt.required = bg;
}
$('#newRole').onchange = e => {
  const f = $('#newForm'), r = roleFor(e.target.value);
  if (r) { f.prompt.value = r.task; f.preset.value = r.preset; f.mode.value = 'background'; }
  syncNewForm();
};
$('#newForm').addEventListener('change', e => { if (e.target.name === 'mode') syncNewForm(); });
async function openNew() {
  const modal = $('#newModal');
  modal.hidden = false;
  const f = $('#newForm');
  f.preset.value = choice(PRESETS).key;
  const projects = await (await fetch('/api/projects')).json().catch(() => []);
  $('#projectList').innerHTML = projects.map(p => `<option value="${escapeHtml(p)}">`).join('');
  if (!f.cwd.value) f.cwd.value = agents.get(selectedId)?.session.cwd || projects[0] || '';
  f.cwd.focus(); f.cwd.select();
}
$('#newBtn').onclick = openNew;
$('#newForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const preset = PRESETS.find(p => p.key === f.preset.value);
  const role = roleFor(f.role.value);
  const persona = { preset: preset.key, traits: preset.traits, hangout: preset.hangout, impact: f.impact.checked, role: role?.key || null };
  persona.name = f.name.value.trim() || choice(['Nova', 'Pixel', 'Byte', 'Echo', 'Juno', 'Orion', 'Kai', 'Zoe']);
  persona.workStyle = persona.impact ? workStyleFor(persona) : '';
  try {
    const background = f.mode.value === 'background';
    await post('/api/new', { cwd: f.cwd.value.trim(), prompt: f.prompt.value.trim(), persona, role: role?.key || null, background });
    $('#newModal').hidden = true; f.prompt.value = ''; f.name.value = ''; f.role.value = ''; f.mode.value = 'terminal'; syncNewForm();
    toast(background
      ? `${role ? role.icon : '🏢'} ${escapeHtml(persona.name)} is on the way to their desk. You'll get a 📋 report when they're done.`
      : `New hire incoming, check ${escapeHtml(config.terminal)}. Their cubicle appears once the session starts.`);
    setTimeout(refresh, 1500);
  } catch (err) { toast(`Could not start session: ${escapeHtml(err.message)}`); }
};

// help
async function openHelp() {
  $('#help').hidden = false;
  const hidden = await (await fetch('/api/hidden')).json().catch(() => null);
  $('#hiddenInfo').innerHTML = hidden?.length
    ? `${hidden.length} hidden cubicle${hidden.length > 1 ? 's' : ''}. <a href="#" id="unhideAll">Bring them back</a>`
    : '';
  const u = $('#unhideAll');
  if (u) u.onclick = async ev => { ev.preventDefault(); await post('/api/hide/', { hide: false }); $('#hiddenInfo').textContent = 'All cubicles restored.'; refresh(); };
}
$('#helpBtn').onclick = openHelp;
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m || e.target.hasAttribute('data-close')) { m.hidden = true; document.activeElement.blur(); } });
});

// keyboard
function cycle(step) {
  const list = world.rooms.map(r => r.session.id);
  if (!list.length) return;
  const i = list.indexOf(selectedId);
  const id = list[(i + step + list.length) % list.length];
  select(id, false);
  const a = agents.get(id);
  const s = scale();
  viewport.scrollTo({ top: a.y * T * s - viewport.clientHeight / 2, left: a.x * T * s - viewport.clientWidth / 2, behavior: 'smooth' });
}
document.addEventListener('keydown', e => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  const modalOpen = [...document.querySelectorAll('.modal')].find(m => !m.hidden);
  if (e.key === 'Escape') {
    if (modalOpen) { modalOpen.hidden = true; document.activeElement.blur(); }
    else if (typing) document.activeElement.blur(); else closePanel();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '?') { e.preventDefault(); openHelp(); return; }
  if (modalOpen) return;
  const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); openNew(); }
  else if (e.key === 'Tab') { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); }
  else if (k === 'd') openBoard();
  else if (k === 's') setShowOffline(!showOffline);
  else if (e.key === '+' || e.key === '=') $('#zoomIn').click();
  else if (e.key === '-') $('#zoomOut').click();
  else if (e.key === '0') setZoom(0);
  else if (!selectedId) return;
  else if (k === 'o') openInTerminal();
  else if (k === 'c') $('#copyCmd').click();
  else if (k === 'h') hideSelected();
  else if (k === 'a') { e.preventDefault(); document.querySelector('.tabs [data-tab=ask]').click(); $('#askInput').focus(); }
});
window.addEventListener('resize', resize);

// debug handle: office.step(30) fast-forwards the simulation 30 seconds
window.office = {
  agents: () => [...agents.values()],
  step(seconds) { for (let i = 0; i < seconds * 20; i++) { time += 0.05; for (const a of agents.values()) a.update(0.05); for (const h of helpers.values()) h.update(0.05); updateEffects(0.05); updateMatrix(0.05); updateCritters(0.05); } render(); },
  matrix: on => setMatrix(on), critter: kind => spawnCritter(kind),
};

const config = await (await fetch('/api/config')).json().catch(() => ({ terminal: 'Terminal', achievements: [] }));
BADGES = Object.fromEntries(config.achievements.map(a => [a.id, a]));
$('#openBtn').textContent = `🖥️ Open in ${config.terminal}`;
await refresh();
if (!store.get('seenHelp', false)) { store.set('seenHelp', true); openHelp(); }
setInterval(refresh, 3000);
requestAnimationFrame(loop);
