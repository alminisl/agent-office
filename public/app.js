import { T, characterFrame, helperFrame, critterFrame, drawFloor, drawWall, FURNITURE, THEMES, setTheme } from './sprites.js';
import { buildWorld, findPath, projectColor, EXEC_LEVEL } from './world.js';
import { PRESETS, SKINS, HAIRS, SHIRTS, PANTS, HAIR_STYLES, personaFor, styleFor, assignUniqueNames, workStyleFor, ROLES, roleFor, PACKS, presetOptions, defaultPersona } from './personas.js';

const $ = s => document.querySelector(s);
const canvas = $('#office');
const ctx = canvas.getContext('2d');
const viewport = $('#viewport');

const STATUS_COLOR = { busy: '#4cd964', waiting: '#f5b83d', 'your turn': '#c792ff', idle: '#6fb7ff', offline: '#7a7590' };
const WORK_STATES = new Set(['busy', 'waiting']);
// Between turns Claude Code reports "idle" while you read/type. Treat a recently-idle live
// session as "your turn": the agent stays at their desk instead of wandering off.
let YOUR_TURN_MS = 5 * 60 * 1000; // adjustable in dashboard settings
const isYourTurn = s => s.live && s.status === 'idle' && officeNow() - (s.statusSince || 0) < YOUR_TURN_MS;
// "now" for the office: the real clock, or the replay cursor while replaying
function officeNow() { return replay.on ? replay.t : Date.now(); }
const replay = { on: false, t: 0, playing: false, speed: 300, data: null, byId: new Map(), applyT: 0 };
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
YOUR_TURN_MS = store.get('yourTurnMinutes', 5) * 60000;
let crittersOn = store.get('critters', true);
let themeKey = store.get('theme', 'classic');
let lightingMode = store.get('lighting', 'auto'); // auto (follows your clock) | day | night
setTheme(themeKey);
let time = 0;
let firstLoad = true;
const standup = { on: false, text: '', running: false };
let employeeOfMonth = null;

let BADGES = {};             // achievement id -> {icon, name, hint}
const rand = (a, b) => a + Math.random() * (b - a);
const choice = arr => arr[Math.floor(Math.random() * arr.length)];

// ---------------- the Product Manager ----------------
// A permanent resident with a desk in the meeting room. Not a Claude session: when you ask them
// something, the server briefs a model on the whole office first.
const PM_DEFAULT = { name: 'Morgan', preset: 'pm', role: 'pm', hangout: 'kitchen', skin: '#eab88f', hair: '#2c3e50', hairStyle: 'short', shirt: '#34495e', pants: '#2d2d2d', glasses: true,
  traits: 'an organised, friendly product manager who keeps track of everyone\'s work, spots blockers early, speaks in clear priorities and loves a tidy board' };
let pmPersonality = null;
const pmSession = () => ({
  id: 'pm', project: 'office', title: 'Product Manager', cwd: null, status: 'idle', live: true, statusSince: Date.now() - 3600e3,
  level: 12, rank: 'Product Manager', xp: 0, levelXp: 0, nextXp: 1, context: 0, contextWindow: 1, badges: [], cost: 0, helpers: [], prs: 0, workMs: 0,
  personality: { ...PM_DEFAULT, ...(pmPersonality || {}) },
});
async function loadPM() {
  try { pmPersonality = await (await fetch('/api/personality/pm')).json(); } catch {}
  if (!pmPersonality) { pmPersonality = { ...PM_DEFAULT }; post('/api/personality/pm', { replace: pmPersonality }).catch(() => {}); }
}

// ---------------- data ----------------
async function refresh() {
  let fresh;
  try { fresh = await (await fetch('/api/sessions')).json(); } catch { return; }
  // cubicles are grouped by project ("neighbourhoods"), then ordered by id so seats stay put
  fresh.sort((a, b) => a.project.localeCompare(b.project) || a.id.localeCompare(b.id));
  assignUniqueNames(fresh);
  persistDefaults(fresh);
  if (!firstLoad) for (const s of fresh) {
    if (!s.hiredBy || allSessions.some(x => x.id === s.id)) continue;
    const boss = fresh.find(x => x.id === s.hiredBy), r = roleFor(s.personality?.role);
    toast(`👥 ${escapeHtml(boss ? personaFor(boss).name : 'A senior agent')} hired <b>${escapeHtml(personaFor(s).name)}</b>${r ? ` (${r.icon} ${escapeHtml(r.label)})` : ''}. They're on their way to a desk.`);
  }
  allSessions = fresh;
  const visible = fresh.filter(s => showOffline || replay.on || s.live || agents.get(s.id)?.leaving);
  // the layout changes when the set of agents changes or someone moves into a private office
  const layoutKey = list => list.map(s => `${s.id}${(s.level || 1) >= EXEC_LEVEL ? '*' : ''}`).join();
  const changedSet = layoutKey(visible) !== layoutKey(sessions);
  sessions = visible;
  if (changedSet || !world) rebuild();
  if (replay.on) applyReplay();
  else for (const s of sessions) agents.get(s.id)?.setSession(s);
  agents.get('pm')?.setSession(pmSession(), true);
  syncHelpers();
  const top = [...allSessions].sort((a, b) => (b.xp || 0) - (a.xp || 0))[0];
  employeeOfMonth = top?.xp ? top.id : null;
  renderStats();
  if (selectedId) updatePanelHeader();
  loadBoard();
  firstLoad = false;
}

// The first time an agent shows up, save their generated name and look, so they keep them
// forever (otherwise names could shuffle when the set of sessions changes). `auto` marks
// these as defaults, so personality packs and "customised" checks still treat them as untouched.
const persisting = new Set();
function persistDefaults(list) {
  const batch = {};
  for (const s of list) {
    if (s.personality || persisting.has(s.id)) continue;
    persisting.add(s.id);
    const p = { ...defaultPersona(s.id), auto: true };
    if (s.uniqueName) p.name = s.uniqueName;
    p.impact = true;
    p.workStyle = workStyleFor(p);
    s.personality = p;
    batch[s.id] = { replace: p };
  }
  // one request, one write on the server
  if (Object.keys(batch).length) post('/api/personalities', batch).catch(() => { for (const id of Object.keys(batch)) persisting.delete(id); });
}

function rebuild() {
  world = buildWorld(sessions, { pm: pmSession() });
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
    } else if (existing && !a.away && world.walkable[t.y]?.[t.x] && findPath(world, t, room.seat)) {
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
function spotLabel(sp) {
  const b = sp.bubble || '';
  if (sp.zone === 'kitchen') return b === '☕' ? '☕ Coffee break' : b === '💧' ? '💧 At the water cooler' : b === '🥪' ? '🥪 Grabbing a snack' : '🍩 Lunch break';
  if (sp.zone === 'gym') return { run: '🏃 On the treadmill', lift: '🏋️ Lifting weights', stretch: '🧘 Yoga', punch: '🥊 Boxing' }[sp.pose] || '💪 Working out';
  if (sp.zone === 'games') return sp.pose === 'paddle' ? '🏓 Playing ping pong' : b === '⚽' ? '⚽ Foosball' : sp.pose === 'sit' ? '📱 Beanbag break' : '🕹️ Playing arcade';
  if (sp.zone === 'lounge') return b === '📖' ? '📖 Reading' : b === '🎧' ? '🎧 Music break' : b === '📺' ? '📺 Watching TV' : sp.id.startsWith('lounge-') ? '📱 Relaxing in the office' : '🛋️ Lounging';
  if (sp.zone === 'office') return '🖨️ At the printer';
  return '☕ On a break';
}

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
      ['desk', this.id === 'pm' ? 6 : 1], ['kitchen', 2], ['gym', 1.4], ['games', 1.5], ['lounge', 1.5],
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
    const sp = choice(world.spots.filter(s => s.zone === pick && !s.takenBy && (!s.owner || s.owner === this.id)));
    if (sp) this.goTo(sp, sp, 'spot');
    else { const p = choice(world.wanderPts); if (p) this.goTo(p, null, 'wander'); }
  }

  update(dt) {
    if (this.away) return;
    this.celebrateT -= dt;
    // personality: every so often they mutter something in character
    this.quipT -= dt;
    if (this.quipT <= 0 && this.quip === null) {
      const nightShift = darkness() > 0.5 && (this.session.badges || []).includes('nightowl') ? ['🦉 Night shift!', '🦉 Best hours to code', '🦉 Who needs sleep'] : [];
      const lines = this.contextPct > 0.8 && this.working ? ['🥵 my head is full…', '🥵 maybe /compact?', '🥵 so… much… context'] : [...(this.working ? this.style.work : this.style.idle), ...nightShift];
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
    // standup: everyone in the office goes to the meeting room, even people who are working
    if (standup.on) {
      if (this.task !== 'meeting') joinMeeting(this);
      return;
    }
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

  // Short human-readable "what are they doing" line for nameplates and the panel.
  statusText() {
    const label = this.baseStatus();
    const s = this.session;
    const onBreakWaiting = s.live && s.status === 'idle' && !isYourTurn(s) && !this.away && !this.leaving && !this.thinking && this.task !== 'meeting' && this.id !== 'pm';
    return onBreakWaiting ? `${label} · waiting for you` : label;
  }

  baseStatus() {
    const s = this.session;
    if (this.task === 'meeting') return this.path.length ? '🚶 Heading to the standup' : this.id === 'pm' ? '🧍 Hosting the standup' : '🧍 In the standup';
    if (this.id === 'pm') {
      if (this.thinking) return '💭 Checking on everyone…';
      if (this.spot?.zone === 'desk' && !this.path.length) return `📋 Keeping track of ${allSessions.filter(x => x.live).length} agents`;
    }
    if (this.away) return '🌴 Out of office';
    if (this.leaving) return '👋 Heading home';
    if (this.thinking) return '💭 Answering your question';
    const walking = this.path.length > 0;
    if (walking && this.task === 'desk') return this.working ? '🏃 Rushing back to work' : '🚶 Heading to desk';
    if (walking && this.task === 'chat') return `🚶 Going to chat with ${this.chatWith?.persona.name || 'someone'}`;
    if (walking && this.task === 'wander') return '🚶 Stretching legs';
    if (walking && this.spot) {
      const where = spotLabel(this.spot);
      return where.includes('On a break') ? '🚶 Off for a break' : `🚶 On the way: ${where.replace(/^\S+\s/, '').toLowerCase()}`;
    }
    if (s.status === 'busy') return !s.activity || s.activity === 'Talking' ? '✍️ Writing a reply' : `⌨️ Working: ${this.styledActivity(s.activity)}`;
    if (s.status === 'waiting') return `🙋 Needs you: ${s.waitingFor || 'input'}`;
    if (isYourTurn(s)) return s.runState === 'done' ? '📋 Report ready' : '💬 Waiting for your reply';
    if (this.task === 'chat' && this.chatWith) return `💬 Chatting with ${this.chatWith.persona.name}`;
    if (this.spot?.zone === 'visit') {
      const host = [...agents.values()].find(a => a.room?.visit === this.spot);
      return `👀 Checking on ${host?.persona.name || 'a colleague'}`;
    }
    if (this.spot?.zone === 'desk') return '🪑 At desk, idle';
    if (this.spot) return spotLabel(this.spot);
    return '🚶 Wandering around';
  }

  styledActivity(label) {
    if (!label) return `${this.style.emoji} working`;
    const [verb, ...rest] = label.split(' ');
    const v = this.style.verbs[verb];
    return v ? `${v} ${rest.join(' ')}` : label;
  }

  bubbleText() {
    if (this.thinking) return '💭 …';
    if (this.task === 'meeting' && !this.path.length) {
      const turn = Math.floor(time / 3.5 + this.room.index * 1.7) % 5;
      return turn === 0 ? `🗣️ ${this.session.title}` : turn === 2 && this.session.status === 'waiting' ? '🙋 I\'m blocked' : null;
    }
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

// ---------------- timeline & replay ----------------
function simulateAt(s, t) {
  const tl = replay.byId.get(s.id);
  const base = { ...s, helpers: [], waitingFor: null, runState: null, activity: null };
  if (!tl) return { ...base, live: false, status: 'offline' };
  const cur = tl.turns.find(([a, b]) => a <= t && t <= b);
  if (cur) {
    let ev = null;
    for (const e of tl.events) { if (e[0] > t) break; ev = e; }
    return { ...base, live: true, status: 'busy', statusSince: cur[0], activity: ev?.[1] || 'Talking' };
  }
  let ended = null;
  for (const turn of tl.turns) if (turn[1] <= t) ended = turn;
  if (ended && t - ended[1] < 45 * 60e3) return { ...base, live: true, status: 'idle', statusSince: ended[1] };
  return { ...base, live: false, status: 'offline' };
}
function applyReplay() {
  for (const s of sessions) agents.get(s.id)?.setSession(simulateAt(s, replay.t));
  updateTimelineUI();
  renderStats();
}
function tickReplay(dt) {
  if (replay.playing) {
    replay.t = Math.min(replay.data.to, replay.t + dt * replay.speed * 1000);
    if (replay.t >= replay.data.to) replay.playing = false;
  }
  replay.applyT -= dt;
  if (replay.applyT <= 0) { replay.applyT = 0.2; applyReplay(); }
}
function updateTimelineUI() {
  const { from, to } = replay.data;
  $('#tlRange').value = String(Math.round((replay.t - from) / (to - from) * 1000));
  const busy = sessions.filter(s => simulateAt(s, replay.t).status === 'busy').length;
  $('#tlTime').textContent = `${new Date(replay.t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · ${busy} working`;
  $('#tlPlay').textContent = replay.playing ? '⏸' : '▶';
}
function drawSparkline() {
  const c = $('#tlSpark'), { from, to } = replay.data;
  c.width = c.clientWidth * (window.devicePixelRatio || 1); c.height = 28 * (window.devicePixelRatio || 1);
  const g = c.getContext('2d'), n = 240, counts = new Array(n).fill(0);
  for (const s of replay.data.sessions) for (const [a, b] of s.turns) {
    for (let i = Math.max(0, Math.floor((a - from) / (to - from) * n)); i <= Math.min(n - 1, Math.floor((b - from) / (to - from) * n)); i++) counts[i]++;
  }
  const max = Math.max(1, ...counts), w = c.width / n;
  g.fillStyle = '#4cd96499';
  counts.forEach((v, i) => { const h = v / max * (c.height - 4); g.fillRect(i * w, c.height - h, Math.max(1, w - 0.5), h); });
}
async function startReplay() {
  try { replay.data = await (await fetch('/api/timeline?hours=24')).json(); } catch { replay.data = null; }
  if (!replay.data?.sessions) return toast('Could not load the timeline.');
  if (!replay.data.sessions.length) return toast('Nothing happened in the last 24 hours, so there is nothing to replay.');
  replay.byId = new Map(replay.data.sessions.map(s => [s.id, s]));
  const first = Math.min(...replay.data.sessions.flatMap(s => s.turns.map(t => t[0])), replay.data.to);
  replay.t = Math.max(replay.data.from, first - 10 * 60e3);
  replay.on = true; replay.playing = true; replay.applyT = 0;
  if (standup.on) endStandup();
  document.body.classList.add('replaying');
  $('#timeline').hidden = false;
  await refresh();
  drawSparkline();
  applyReplay();
  toast('⏪ Replaying the last 24 hours. Drag the timeline to jump around.');
}
function stopReplay() {
  replay.on = false; replay.playing = false;
  document.body.classList.remove('replaying');
  $('#timeline').hidden = true;
  refresh();
}
$('#replayBtn').onclick = () => (replay.on ? stopReplay() : startReplay());
$('#tlLive').onclick = stopReplay;
$('#tlPlay').onclick = () => { if (replay.t >= replay.data.to) replay.t = replay.data.from; replay.playing = !replay.playing; updateTimelineUI(); };
$('#tlSpeed').onchange = e => { replay.speed = Number(e.target.value); };
$('#tlRange').oninput = e => {
  const { from, to } = replay.data;
  replay.t = from + (to - from) * Number(e.target.value) / 1000;
  applyReplay();
};
window.addEventListener('resize', () => { if (replay.on) drawSparkline(); });

// ---------------- TODO board ----------------
let boardItems = [];
async function loadBoard() {
  try { boardItems = (await (await fetch('/api/board')).json()).items || []; } catch { return; }
  if (world?.kanban) world.kanban.counts = ['todo', 'doing', 'done'].map(st => boardItems.filter(i => i.status === st).length);
  if (!$('#todoModal').hidden) renderTodo();
}
const boardPost = body => post('/api/board', body).then(loadBoard).catch(e => toast(`Board: ${escapeHtml(e.message)}`));
function todoCard(it) {
  const s = it.sessionId && allSessions.find(x => x.id === it.sessionId), p = s && personaFor(s);
  const next = { todo: ['doing', '▶ Start'], doing: ['done', '✓ Done'], done: ['todo', '↺ Reopen'] }[it.status];
  const when = it.status === 'done' && it.doneAt ? `done ${ago(it.doneAt)}` : `added ${ago(it.createdAt)}`;
  return `<div class="todo ${it.status}" draggable="true" data-todo="${it.id}" style="border-left-color:${it.project ? projectColor(it.project) : 'var(--border)'}">
    <div class="t">${escapeHtml(it.title)}</div>
    ${it.notes ? `<div class="notes">${escapeHtml(it.notes)}</div>` : ''}
    <div class="meta">
      ${it.project ? `<span class="pill">${escapeHtml(it.project)}</span>` : ''}
      ${p ? `<span class="who" data-open="${s.id}" data-tip="Linked to ${escapeHtml(p.name)}. Click to open their panel."><canvas width="16" height="26" style="width:10px;height:16px" data-av="${s.id}"></canvas>${escapeHtml(p.name)}</span>` : ''}
      <span data-tip="Who added it">by ${escapeHtml(it.by || 'you')}</span><span>· ${when}</span>
    </div>
    <div class="acts">
      <button data-act="move" data-to="${next[0]}">${next[1]}</button>
      ${it.status !== 'done' ? `<button data-act="give" data-tip="Hand this to an existing agent (opens their terminal)">🤝 Give</button><button data-act="hire" data-tip="Hire a new agent for this (e.g. a Fixer on its own branch)">🏢 Hire</button>` : ''}
      <button data-act="edit" data-tip="Edit the title and notes">✎</button>
      <button data-act="delete" data-tip="Delete this card">🗑</button>
    </div>
  </div>`;
}
function renderTodo() {
  const cols = { todo: [], doing: [], done: [] };
  for (const it of boardItems) (cols[it.status] || cols.todo).push(it);
  cols.done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  for (const [k, list] of Object.entries(cols)) {
    const col = document.querySelector(`.col[data-col=${k}]`);
    col.querySelector('.count').textContent = list.length;
    col.querySelector('.cards').innerHTML = list.map(todoCard).join('') || '<p class="muted small">Nothing here.</p>';
  }
  const doneToday = cols.done.filter(i => i.doneAt && new Date(i.doneAt).toDateString() === new Date().toDateString()).length;
  $('#todoSummary').textContent = `${cols.todo.length} to do · ${cols.doing.length} in progress · ${doneToday} done today`;
  const box = $('#todoModal');
  paintAvatars(box);
  box.querySelectorAll('[data-open]').forEach(el => el.onclick = () => { box.hidden = true; if (agents.has(el.dataset.open)) select(el.dataset.open, false); });
  box.querySelectorAll('.todo').forEach(card => {
    const it = boardItems.find(i => i.id === card.dataset.todo);
    card.addEventListener('dragstart', e => { e.dataTransfer.setData('text/todo', it.id); card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'move') boardPost({ op: 'update', id: it.id, status: b.dataset.to });
      if (act === 'delete') boardPost({ op: 'delete', id: it.id });
      if (act === 'give') { box.hidden = true; openHandoff(null, null, `${it.title}${it.notes ? `\n\n${it.notes}` : ''}`, it); }
      if (act === 'hire') { box.hidden = true; openNewForTodo(it); }
      if (act === 'edit') {
        card.innerHTML = `<input value="${escapeHtml(it.title)}" maxlength="200"><textarea rows="3" placeholder="Notes">${escapeHtml(it.notes || '')}</textarea><div class="acts"><button class="primary" data-save>Save</button><button data-cancel>Cancel</button></div>`;
        card.draggable = false;
        card.querySelector('[data-save]').onclick = () => boardPost({ op: 'update', id: it.id, title: card.querySelector('input').value.trim() || it.title, notes: card.querySelector('textarea').value });
        card.querySelector('[data-cancel]').onclick = renderTodo;
        card.querySelector('input').focus();
      }
    });
  });
}
document.querySelectorAll('.col').forEach(col => {
  col.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('text/todo')) { e.preventDefault(); col.classList.add('drop'); } });
  col.addEventListener('dragleave', () => col.classList.remove('drop'));
  col.addEventListener('drop', e => {
    col.classList.remove('drop');
    const id = e.dataTransfer.getData('text/todo');
    if (id) { e.preventDefault(); boardPost({ op: 'update', id, status: col.dataset.col }); }
  });
});
async function openTodo() {
  const projects = [...new Set(allSessions.map(s => s.project))].sort();
  $('#todoProject').innerHTML = '<option value="">No project</option>' + projects.map(p => `<option>${escapeHtml(p)}</option>`).join('');
  const sel = agents.get(selectedId);
  if (sel) $('#todoProject').value = sel.session.project;
  $('#todoModal').hidden = false;
  await loadBoard(); renderTodo();
  $('#todoAdd').title.focus();
}
$('#todoBtn').onclick = openTodo;
$('#todoAdd').onsubmit = e => {
  e.preventDefault();
  const f = e.target;
  boardPost({ op: 'add', title: f.title.value.trim(), project: f.project.value });
  f.title.value = '';
};
$('#todoClear').onclick = () => {
  const old = boardItems.filter(i => i.status === 'done' && Date.now() - (i.doneAt || 0) > 86400e3);
  Promise.all(old.map(i => post('/api/board', { op: 'delete', id: i.id }))).then(loadBoard);
  toast(old.length ? `Cleared ${old.length} old done card${old.length > 1 ? 's' : ''}.` : 'Nothing older than a day to clear.');
};

// ---------------- handoffs ----------------
let dragHandoff = null;
document.addEventListener('dragend', () => { canvas.classList.remove('drop-target'); });
canvas.addEventListener('dragover', e => {
  if (!dragHandoff) return;
  e.preventDefault();
  const a = agentAt(e);
  hoverId = a && a.id !== dragHandoff.from ? a.id : null;
});
canvas.addEventListener('drop', e => {
  if (!dragHandoff) return;
  e.preventDefault();
  canvas.classList.remove('drop-target');
  const a = agentAt(e), h = dragHandoff;
  dragHandoff = null;
  if (a && a.id !== h.from) openHandoff(h.from, a.id, h.text);
  else toast('Drop it on another agent to hand it off.');
});

let handoffTodo = null; // board item being handed off, if any
function openHandoff(fromId, toId, text, todo = null) {
  handoffTodo = todo;
  const from = !fromId ? { persona: { name: 'the office board' }, session: { project: todo?.project || '' } }
    : agents.get(fromId) || { persona: personaFor(allSessions.find(s => s.id === fromId) || { id: fromId }), session: allSessions.find(s => s.id === fromId) || {} };
  const f = $('#handoffForm');
  const role = roleFor(from.persona.role);
  const targets = [...allSessions].filter(s => s.id !== fromId).map(s => ({ s, p: personaFor(s) }));
  $('#handoffTarget').innerHTML = targets.map(({ s, p }) => `<option value="${s.id}">${escapeHtml(p.name)} · ${escapeHtml(s.project)}${s.live ? ' (session open)' : ''}</option>`).join('');
  if (toId) f.target.value = toId;
  else if (todo?.project) { const same = targets.find(({ s }) => s.project === todo.project && !s.live) || targets.find(({ s }) => s.project === todo.project); if (same) f.target.value = same.s.id; }
  $('#handoffFrom').textContent = `From ${from.persona.name}${role ? `, ${role.label}` : ''} (${from.session.project || ''}).`;
  const fill = () => {
    const t = allSessions.find(s => s.id === f.target.value), tp = t && personaFor(t);
    if (!t) return;
    f.prompt.value = todo
      ? `From the office TODO board: ${text}\n\nPlease take care of this in ${t.project}, run the relevant tests, and tell me what you changed.`
      : `Handoff from ${from.persona.name}${role ? ` (${role.label})` : ''}:\n\n${text}\n\nPlease take it from here: fix what's described above in ${t.project}, run the relevant tests, and tell me what you changed.`;
    const canResume = !t.live;
    f.querySelector('input[value=resume]').disabled = !canResume;
    $('#handoffResumeLabel').textContent = canResume ? `Continue ${tp.name}'s session (they keep their memory)` : `Continue ${tp.name}'s session (not possible: their session is already open)`;
    $('#handoffNewLabel').textContent = `New session in ${t.project} as ${tp.name} II, with their personality`;
    f.mode.value = canResume ? 'resume' : 'new';
  };
  f.target.onchange = fill;
  fill();
  $('#handoffModal').hidden = false;
}
$('#handoffForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const t = allSessions.find(s => s.id === f.target.value);
  try {
    await post('/api/handoff', { targetId: f.target.value, prompt: f.prompt.value.trim(), mode: f.mode.value, todoId: handoffTodo?.id });
    handoffTodo = null; loadBoard();
    $('#handoffModal').hidden = true;
    const a = agents.get(f.target.value);
    if (a && !a.away) { a.quip = '🤝 On it!'; a.quipT = -4; a.celebrateT = 2; }
    toast(`🤝 Handed off to <b>${escapeHtml(personaFor(t).name)}</b>. Check ${escapeHtml(config.terminal)}.`);
    setTimeout(refresh, 1500);
  } catch (err) { toast(`Could not hand off: ${escapeHtml(err.message)}`); }
};

// ---------------- standup ----------------
function joinMeeting(a) {
  const seat = world.spots.find(sp => sp.meeting && !sp.takenBy) || null;
  if (seat && a.goTo(seat, seat, 'meeting')) return;
  a.task = 'meeting'; // no free seat: stand where you are and listen in
}
async function startStandup() {
  if (!world) return;
  standup.on = true;
  for (const a of agents.values()) if (!a.away && a.task !== 'meeting') joinMeeting(a);
  const m = world.meeting, s = scale();
  viewport.scrollTo({ top: (m.y0 - 4) * T * s, behavior: 'smooth' });
  $('#standupCard').hidden = false;
  runStandupSummary();
}
async function runStandupSummary() {
  if (standup.running) return;
  standup.running = true;
  const box = $('#standupText');
  box.classList.add('thinking');
  box.textContent = 'Everyone is heading to the meeting room… collecting yesterday, today and blockers.';
  $('#standupTime').textContent = `${new Date().toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · hosted by ${agents.get('pm')?.persona.name || 'the PM'}`;
  const started = Date.now();
  const tick = setInterval(() => { if (box.classList.contains('thinking')) box.textContent = `Collecting notes from everyone… ${Math.round((Date.now() - started) / 1000)}s`; }, 1000);
  try {
    const names = Object.fromEntries(allSessions.map(s => [s.id, personaFor(s).name]));
    const res = await fetch('/api/standup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names }) });
    const reader = res.body.getReader(), dec = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      box.classList.remove('thinking');
      box.innerHTML = md(text);
    }
    standup.text = text;
  } catch (e) { box.classList.remove('thinking'); box.textContent = `⚠️ ${e.message}`; }
  clearInterval(tick);
  standup.running = false;
}
function endStandup() {
  standup.on = false;
  $('#standupCard').hidden = true;
  for (const a of agents.values()) if (a.task === 'meeting') { a.release(); a.task = null; a.path = []; a.timer = rand(0, 2); }
}
$('#standupBtn').onclick = () => (standup.on ? endStandup() : startStandup());
$('#standupEnd').onclick = endStandup;
$('#standupClose').onclick = endStandup;
$('#standupAgain').onclick = runStandupSummary;
$('#standupCopy').onclick = () => standup.text && copy(standup.text);

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
  typed = (typed + e.key.toLowerCase()).slice(-20);
  if (/(matrix|redpill|neo)$/.test(typed)) { typed = ''; setMatrix(true); }
  else if (/bluepill$/.test(typed)) { typed = ''; setMatrix(false); }
  else if (/whiterabbit$/.test(typed)) { typed = ''; spawnCritter('rabbit'); }
  else if (/dejavu$/.test(typed)) { typed = ''; spawnCritter('cat'); }
  else if (/dundermifflin$/.test(typed)) { typed = ''; dunderMifflin(); }
});
// Dunder Mifflin, Scranton branch (for a minute)
function dunderMifflin() {
  const h1 = document.querySelector('h1'), was = h1.textContent;
  h1.textContent = 'Dunder Mifflin · Scranton';
  const lines = ["That's what she said!", 'Bears. Beets. Battlestar Galactica.', 'Is it pretzel day?', '👀', 'Nobody steals from Creed.', 'I declare bankruptcy!'];
  for (const a of agents.values()) if (!a.away) { a.quip = choice(lines); a.quipT = -4; a.celebrateT = 2; }
  toast('📎 <b>Dunder Mifflin</b>: limitless paper in a paperless world.');
  setTimeout(() => { h1.textContent = was; }, 60000);
}
console.log('%cWake up, Neo…', 'color:#00ff66;background:#000;font:16px monospace;padding:6px 10px');
console.log('%cThe Matrix has you. Follow the white rabbit. (try typing "matrix" on the office)', 'color:#00ff66;background:#000;font:12px monospace;padding:4px 10px');

// ---------------- day & night ----------------
// 0 = broad daylight, 1 = deep night. "auto" follows the real clock: dusk 17-20h, dawn 6-8h.
function darkness() {
  if (lightingMode === 'day') return 0;
  if (lightingMode === 'night') return 1;
  const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
  if (h >= 20 || h < 6) return 1;
  if (h >= 17) return (h - 17) / 3;
  if (h < 8) return 1 - (h - 6) / 2;
  return 0;
}
function drawLighting(s) {
  const dark = darkness();
  if (dark <= 0.02) return;
  const w = canvas.width, h = canvas.height;
  ctx.save();
  // tint the whole office towards a cool night blue
  const k = 1 - 0.62 * dark;
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = `rgb(${Math.round(255 * k * 0.8 + 40 * (1 - k))}, ${Math.round(255 * k * 0.85 + 50 * (1 - k))}, ${Math.round(255 * k + 110 * (1 - k))})`;
  ctx.fillRect(0, 0, w, h);
  // light pools: lamps (warm), busy monitors (cool), the elevator light
  ctx.globalCompositeOperation = 'lighter';
  const glow = (x, y, r, color, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color.replace('A', (a * dark).toFixed(3))); g.addColorStop(1, color.replace('A', '0'));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  };
  for (const o of world.objects) {
    if (o.type === 'lamp') glow((o.x + 0.5) * T * s, (o.y - 0.4) * T * s, 3.2 * T * s, 'rgba(255,200,110,A)', 0.35);
    if (o.type === 'desk' && !o.empty) {
      const owner = agents.get(world.rooms[o.room]?.session?.id);
      if (owner && !owner.away && owner.session.status === 'busy') glow((o.x + 0.5) * T * s, (o.y - 0.4) * T * s, 1.6 * T * s, 'rgba(110,190,255,A)', 0.38);
    }
    if (o.type === 'tv' || o.type === 'arcade') glow((o.x + o.w / 2) * T * s, o.y * T * s, 2 * T * s, 'rgba(180,120,255,A)', 0.22);
  }
  ctx.restore();
}

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

  const night = darkness() > 0.5;
  for (const o of world.objects) if (o.type === 'window') o.night = night;
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
  drawLighting(s);
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
    const h = fs * 3 + 16 * dpr;
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
    // status line: what they are doing right now
    ctx.font = `600 ${Math.round(fs * 0.88)}px Inter, sans-serif`;
    ctx.fillStyle = STATUS_COLOR[displayStatus(ss)] || '#ccc';
    ctx.fillText(fit(a ? a.statusText() : '', w - 14 * dpr), x + 8 * dpr, y + 8 * dpr + fs * 1.45);
    ctx.font = `${Math.round(fs * 0.85)}px Inter, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(fit(ss.title, w - 14 * dpr), x + 8 * dpr, y + h - 8 * dpr - fs * 0.42);
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
    if (darkness() > 0.5 && (a.session.badges || []).includes('nightowl') && a.id !== employeeOfMonth) {
      ctx.font = `${Math.round(fs * 1.05)}px sans-serif`; ctx.textAlign = 'center';
      ctx.fillText('🦉', cx, (a.y * T - 13) * s + (a.currentPose() === 'sit' || a.currentPose() === 'type' ? 3 * s : 0));
      ctx.textAlign = 'left';
    }
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
  if (selectedId && Math.floor(time * 2) !== Math.floor((time - dt) * 2)) { // refresh the panel's status line twice a second
    const a = agents.get(selectedId);
    if (a) $('#pDoing').textContent = a.statusText();
  }
  if (replay.on) tickReplay(dt);
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
  const room = world.rooms.find(r => wy >= r.plaque.y && wy <= r.plaque.y + 1.35 && wx >= r.plaque.x && wx <= r.plaque.x + r.plaque.w);
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
  const kb = world?.kanban;
  if (kb && wx >= kb.x && wx <= kb.x + kb.w && wy >= kb.y && wy <= kb.y + 1) return openTodo();
  const rabbit = critters.find(c => c.kind === 'rabbit' && Math.abs(c.x + 0.5 - wx) < 0.8 && Math.abs(c.y + 0.5 - wy) < 0.8);
  if (rabbit) { critters = critters.filter(c => c !== rabbit); setMatrix(true); return; }
  const a = world && agentAt(e);
  if (a) select(a.id, true); else closePanel();
});

function resumeCmd(s) {
  if (s.id === 'pm') return 'The PM lives in the office: use the Ask tab';
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

// Tiny, safe markdown for reports and replies: escape everything first, then add a few styles.
function md(text) {
  let h = escapeHtml(text);
  h = h.replace(/```[a-z]*\n?([\s\S]*?)```/g, (_, code) => `<pre>${code.replace(/\n$/, '')}</pre>`);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/^#{1,4} (.+)$/gm, '<b class="md-h">$1</b>');
  h = h.replace(/^\|?[-: |]+\|[-: |]*$/gm, '');                       // drop table separator rows
  return h;
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
  document.body.classList.toggle('pm-selected', id === 'pm');
  if (id === 'pm') { detail = null; renderPMWork(); return; }
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
function closePanel() { discardDraft(); document.body.classList.remove('pm-selected'); selectedId = null; $('#panel').hidden = true; resize(); }
$('#closePanel').onclick = closePanel;


function updatePanelHeader() {
  const a = agents.get(selectedId);
  if (!a) return closePanel();
  const s = a.session, p = a.persona;
  $('#pName').textContent = p.name;
  const ds = displayStatus(s);
  const role = roleFor(p.role);
  const preset = PRESETS.find(x => x.key === p.preset)?.label || '✏️ Custom';
  if (a.id === 'pm') {
    $('#pBadges').innerHTML = '<span class="pill lv">👔 Product Manager</span><span class="pill" data-tip="You are the boss. The PM keeps track of everyone and reports to you.">works for you</span>';
    $('#pTitle').textContent = 'Knows what every agent is doing. Ask away.';
    $('#pDoing').textContent = a.statusText();
    $('#pMeta').textContent = 'Desk in the meeting room · hosts the standup';
    const av = $('#avatar').getContext('2d');
    av.imageSmoothingEnabled = false; av.clearRect(0, 0, 64, 104);
    av.drawImage(characterFrame(p, 'down', 'stand', 0), 0, 0, 64, 104);
    return;
  }
  $('#pBadges').innerHTML = [
    `<span class="chip ${ds.replace(' ', '-')}">${ds === 'offline' ? 'out of office' : ds}</span>`,
    `<span class="pill lv">Lv ${s.level || 1} · ${escapeHtml(s.rank || 'Intern')}</span>`,
    `<span class="pill">${escapeHtml(preset)}</span>`,
    role ? `<span class="pill">${role.icon} ${escapeHtml(role.label)}</span>` : '',
    s.background ? '<span class="pill">🏢 in the office</span>' : '',
    s.hiredBy ? `<span class="pill" data-tip="Hired by another agent through the agent-office tools">👥 hired by ${escapeHtml(personaFor(allSessions.find(x => x.id === s.hiredBy) || { id: s.hiredBy, personality: { name: p.hiredByName } }).name)}</span>` : '',
    (() => { const n = allSessions.filter(x => x.hiredBy === s.id).length; return n ? `<span class="pill" data-tip="Coworkers this agent hired">👥 ${n} hire${n > 1 ? 's' : ''}</span>` : ''; })(),
  ].join('');
  $('#endBtn').hidden = !s.live;
  $('#hideBtn').hidden = s.live;
  $('#openBtn').hidden = s.live;
  $('#pTitle').textContent = s.title;
  $('#pDoing').textContent = a.statusText();
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

function renderPMWork() {
  const live = allSessions.filter(s => s.live), busy = allSessions.filter(s => s.status === 'busy');
  const needs = allSessions.filter(s => s.status === 'waiting' || isYourTurn(s));
  const cols = ['todo', 'doing', 'done'].map(st => boardItems.filter(i => i.status === st).length);
  $('#tab-work').innerHTML = `
    <div class="kv">
      <div data-tip="Sessions whose claude process is running"><b>${live.length}</b><span>in the office</span></div>
      <div data-tip="Writing a reply or running a tool right now"><b>${busy.length}</b><span>working</span></div>
      <div data-tip="Waiting for your permission or your reply"><b>${needs.length}</b><span>waiting on you</span></div>
    </div>
    <div class="kv">
      <div data-tip="Open cards on the office board"><b>${cols[0]}</b><span>to do</span></div>
      <div data-tip="Cards someone is working on"><b>${cols[1]}</b><span>in progress</span></div>
      <div data-tip="Finished cards"><b>${cols[2]}</b><span>done</span></div>
    </div>
    <h3>What I can do for you</h3>
    <div class="pm-actions">
      <button id="pmPlan" class="primary" data-tip="I look at the whole office and suggest today's priorities as board cards you can add with one click.">🗓️ Plan my day</button>
      <button id="pmAskStatus" data-tip="A quick status report on everyone.">📊 Status report</button>
      <button id="pmAskBlocked" data-tip="Who is stuck, and what would unblock them.">🧱 What's blocked?</button>
      <button id="pmBoard" data-tip="Open the office TODO board.">📋 Open the board</button>
      <button id="pmSession" data-tip="Opens a real Claude session as the PM in your terminal. With the agent-office tools connected, it can read the office, update the board and hire agents.">🖥️ Start a PM session</button>
    </div>
    <div id="pmPlanOut"></div>
    <p class="muted small">I don't write code myself. I read a fresh briefing of every agent (status, recent messages, reports) and the board each time you ask, so my answers are always current.</p>`;
  const askPM = q => { document.querySelector('.tabs [data-tab=ask]').click(); ask(q); };
  $('#pmAskStatus').onclick = () => askPM('Give me a quick status report on the whole office.');
  $('#pmAskBlocked').onclick = () => askPM("What's blocked right now, and what would unblock it?");
  $('#pmBoard').onclick = openTodo;
  $('#pmSession').onclick = async () => {
    try { await post('/api/pm/session', { persona: agents.get('pm')?.persona }); toast(`🖥️ Opening a PM session in ${escapeHtml(config.terminal)}.`); }
    catch (e) { toast(`Could not start the PM session: ${escapeHtml(e.message)}`); }
  };
  $('#pmPlan').onclick = async () => {
    const out = $('#pmPlanOut'), pm = agents.get('pm');
    out.innerHTML = '<p class="muted small">Looking at the whole office…</p>';
    if (pm) pm.thinking = true;
    try {
      const plan = await post('/api/pm/plan', { persona: pm?.persona });
      out.innerHTML = `<div class="plan"><p>${md(plan.summary || '')}</p>${(plan.items || []).map((it, i) => `
        <div class="plan-item"><div><b>${escapeHtml(it.title)}</b>${it.project ? ` <span class="pill">${escapeHtml(it.project)}</span>` : ''}<div class="muted small">${escapeHtml(it.why || '')}</div></div>
        <button class="small" data-add="${i}">➕ Add to board</button></div>`).join('')}
        ${(plan.items || []).length ? '<button class="primary small" id="planAll">Add all to the board</button>' : ''}</div>`;
      const add = it => post('/api/board', { op: 'add', title: it.title, project: it.project || '', notes: [it.notes, it.why && `Why: ${it.why}`].filter(Boolean).join('\n') });
      out.querySelectorAll('[data-add]').forEach(b => b.onclick = async () => { await add(plan.items[Number(b.dataset.add)]); b.disabled = true; b.textContent = '✓ Added'; loadBoard(); });
      const all = $('#planAll');
      if (all) all.onclick = async () => { for (const [i, it] of plan.items.entries()) { const b = out.querySelector(`[data-add="${i}"]`); if (!b.disabled) { await add(it); b.disabled = true; b.textContent = '✓ Added'; } } all.disabled = true; loadBoard(); toast('📋 Added to the board.'); };
    } catch (e) { out.innerHTML = `<p class="muted small">⚠️ ${escapeHtml(e.message)}</p>`; }
    if (pm) pm.thinking = false;
  };
}

function renderWork() {
  const d = detail;
  if (!d) return;
  $('#deepHint').textContent = d.context
    ? `re-reads all ${fmtTokens(d.context)} tokens of the conversation (${d.context > 150000 ? 'slow and pricey for this one' : 'a bit slower, costs more'})`
    : 're-reads the whole conversation (slower, costs more)';
  const prompts = [...d.prompts].reverse().slice(0, 6);
  const replies = [...d.replies].reverse().slice(0, 3);
  const pct = Math.min(1, (d.context || 0) / (d.contextWindow || 1));
  const into = d.xp - d.levelXp, need = d.nextXp - d.levelXp;
  const rep = d.report, role = roleFor(d.personality?.role);
  const reportHtml = d.runState === 'running'
    ? `<h3>📋 Report</h3><p class="muted small">${role ? role.icon : '🏢'} Working on it in the background… the report appears here when they're done.</p>`
    : rep ? `<div class="report-head"><h3>📋 Report${role ? ` · ${role.icon} ${escapeHtml(role.label)}` : ''}</h3><span><button class="handoff-btn" data-handoff="report" title="Give this report to another agent">🤝 Hand off</button> <button class="small" id="copyReport">Copy</button></span></div>
      <div class="report md ${rep.ok ? '' : 'failed'}" draggable="true" data-drag="report" title="Drag onto another agent to hand it off">${md(rep.result)}</div>
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
    ${replies.map((r, i) => `<div class="item md" draggable="true" data-drag="reply" data-i="${i}" title="Drag onto another agent to hand it off"><time>${ago(r.at)}${i === 0 ? ' · <button class="handoff-btn" data-handoff="reply" data-i="0">🤝 Hand off</button>' : ''}</time>${md(r.text)}</div>`).join('') || '<p class="muted">Nothing yet.</p>'}
    <h3>What you asked</h3>
    ${prompts.map(r => `<div class="item"><time>${ago(r.at)}</time>${escapeHtml(r.text)}</div>`).join('') || '<p class="muted">No prompts.</p>'}
    ${d.files.length ? `<h3>Files touched</h3><ul class="files">${d.files.map(f => `<li title="${escapeHtml(f.path)}">${escapeHtml(f.path.replace(d.cwd + '/', ''))} <span>×${f.edits}</span></li>`).join('')}</ul>` : ''}
    ${d.tools.length ? `<h3>Favourite tools</h3><div class="muted small">${d.tools.map(t => `${escapeHtml(t.name)} ×${t.n}`).join(' · ')}</div>` : ''}
    ${d.model ? `<h3>Brain</h3><div class="muted small">${escapeHtml(d.model)}</div>` : ''}`;
  const cr = $('#copyReport');
  if (cr) cr.onclick = () => copy(rep.result);
  // handoffs: button or drag onto an agent in the office
  const handoffText = el => (el.dataset.handoff === 'report' || el.dataset.drag === 'report' ? rep.result : replies[Number(el.dataset.i) || 0]?.text);
  document.querySelectorAll('#tab-work [data-handoff]').forEach(b => b.onclick = e => { e.stopPropagation(); openHandoff(d.id, null, handoffText(b)); });
  document.querySelectorAll('#tab-work [data-drag]').forEach(el => el.addEventListener('dragstart', e => {
    dragHandoff = { from: d.id, text: handoffText(el) };
    e.dataTransfer.setData('text/plain', dragHandoff.text);
    e.dataTransfer.effectAllowed = 'copy';
    canvas.classList.add('drop-target');
  }));
}

// tabs
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== `tab-${b.dataset.tab}`; });
});

// ask
function renderChat() {
  const log = chats.get(selectedId) || [];
  $('#chat').innerHTML = log.map(m => `<div class="msg md ${m.who}${m.thinking ? ' thinking' : ''}">${m.who === 'them' ? md(m.text) : escapeHtml(m.text)}</div>`).join('');
}

async function ask(question) {
  const id = selectedId, a = agents.get(id);
  if (!a || a.thinking) return;
  const log = chats.get(id) || [];
  chats.set(id, log);
  log.push({ who: 'me', text: question });
  const mode = document.querySelector('input[name=askMode]:checked')?.value || 'quick';
  const reply = { who: 'them', text: `${a.persona.name} is thinking…`, thinking: true };
  log.push(reply);
  renderChat();
  a.thinking = true;
  // show that something is happening, and how long it takes
  const started = Date.now();
  const tick = setInterval(() => {
    if (!reply.thinking) return clearInterval(tick);
    const secs = Math.round((Date.now() - started) / 1000);
    reply.text = `${a.persona.name} is thinking… ${secs}s${mode === 'deep' ? ' (deep memory: re-reading the whole conversation)' : ''}`;
    if (selectedId === id) renderChat();
  }, 1000);
  try {
    const { name, traits } = a.persona;
    const res = await fetch(id === 'pm' ? '/api/ask/pm' : `/api/ask/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, mode, persona: { name, traits } }) });
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
  clearInterval(tick);
  reply.thinking = false;
  a.thinking = false;
  if (selectedId === id) renderChat();
}
$('#askForm').onsubmit = e => { e.preventDefault(); const q = $('#askInput').value.trim(); if (q) { $('#askInput').value = ''; ask(q); } };
document.querySelectorAll('.quick button').forEach(b => b.onclick = () => ask(b.dataset.q));

// personality
$('#presetSelect').innerHTML = presetOptions('<option value="custom">✏️ Custom</option>');
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
  const body = { ...draft, auto: false, workStyle: draft.impact !== false ? workStyleFor(draft) : '' };
  const saved = await (await fetch(`/api/personality/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const s = sessions.find(x => x.id === id);
  const ag = agents.get(id);
  if (ag) ag.draftPersona = null;
  if (id === 'pm') { pmPersonality = saved; ag?.setSession(pmSession(), true); }
  if (s) { s.personality = saved; ag?.setSession(s, true); }
  toast(`Saved ${escapeHtml(saved.name)}'s personality`);
};

// ---------------- chrome ----------------
function renderStats() {
  const list = replay.on && replay.data ? sessions.map(s => simulateAt(s, replay.t)) : allSessions;
  const count = st => list.filter(s => displayStatus(s) === st).length;
  $('#stats').innerHTML = ['busy', 'waiting', 'your turn', 'idle', 'offline']
    .map(st => `<span><span class="dot" style="background:${STATUS_COLOR[st]}"></span>${count(st)} ${st}</span>`).join('');
  if (!$('#board').hidden && boardTab !== 'settings') renderBoard();
}

// show offline toggle
$('#showOffline').checked = showOffline;
function setShowOffline(v) { showOffline = v; $('#showOffline').checked = v; $('#setOffline').checked = v; store.set('showOffline', v); refresh(); }
$('#showOffline').onchange = e => setShowOffline(e.target.checked);

// ---------------- tooltips ----------------
// Anything with data-tip gets an instant hover bubble (faster and nicer than the native title).
const tip = document.createElement('div');
tip.id = 'tip'; tip.hidden = true; document.body.appendChild(tip);
let tipFor = null;
document.addEventListener('mouseover', e => {
  const el = e.target.closest?.('[data-tip]');
  if (el === tipFor) return;
  tipFor = el;
  if (!el || !el.dataset.tip) { tip.hidden = true; return; }
  tip.textContent = el.dataset.tip; tip.hidden = false;
});
document.addEventListener('mousemove', e => {
  if (tip.hidden) return;
  const pad = 14, r = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${Math.max(8, y)}px`;
});
document.addEventListener('mousedown', () => { tip.hidden = true; tipFor = null; });

// ---------------- office dashboard ----------------
// Motivation is a playful read of the agent's state: busy = in the zone, full context = burned out, etc.
const EAGER = new Set(['intern', 'coach', 'neo', 'michael', 'dwight']), GRUMPY = new Set(['senior', 'sarcastic', 'smith', 'stanley']);
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
  const plain = html => html.replace(/<[^>]+>/g, '');
  // the explanation lives in the hover tooltip, so the cards stay compact
  const card = (value, label, desc) => `<div class="stat-card" data-tip="${escapeHtml(plain(desc))}"><b>${value}</b><span>${label} <span class="info">ⓘ</span></span></div>`;
  const section = (title, desc) => `<h3>${title}</h3><p class="section-desc">${desc}</p>`;
  pane.innerHTML = `
    <div class="kv overview-cards">
      ${card(list.length, `employees (${live.length} in office)`, `Every Claude Code session from the last ${config.maxDays} days (up to ${config.maxRooms}), plus any that are running now. <i>In office</i> means its <code>claude</code> process is running.`)}
      ${card(busy.length, 'working right now', 'Sessions where Claude is writing a reply or running a tool at this moment.')}
      ${card(money(sum('cost')), 'total spend', 'What these sessions cost, as recorded by Claude Code (the same numbers <code>/cost</code> shows). Sessions with no recorded cost count as $0.')}
      ${card(money(workH ? sum('cost') / workH : 0), 'per hour of work', 'Total spend divided by hands-on work time: roughly what one hour of an agent actually working costs.')}
      ${card(fmtDuration(sum('workMs')), 'hands-on work', 'Time Claude spent on your prompts, from each prompt to its last message in that turn (at most 2h per turn). Idle time does not count.')}
      ${card(`+${sum('linesAdded').toLocaleString()} / −${sum('linesRemoved').toLocaleString()}`, 'lines changed', 'Lines added and removed by Claude\'s file edits, as recorded by Claude Code.')}
      ${card(sum('prs'), 'PRs opened', 'Pull / merge requests Claude Code linked to these sessions, for example when an agent created one. It counts links, not whether they are still open.')}
      ${card(`${avgMot}%`, 'office motivation', 'Average mood of the agents in the office, just for fun: working 🔥 scores high, waiting on you 🙋 or bored 😴 lower, a nearly full context 🥵 lowest. A low score usually means agents are waiting for you.')}
    </div>
    <div class="two">
      <div>
        ${section('Spend by project', 'Recorded cost per project folder, highest first.')}
        ${projects.map(p => `<div class="hbar" data-tip="${escapeHtml(p.project)}: ${money(p.cost)} recorded spend across ${p.agents} agent${p.agents > 1 ? 's' : ''} (${p.live} in the office now)"><span>${escapeHtml(p.project)}</span><div class="bar"><div style="width:${p.cost / maxCost * 100}%;background:${projectColor(p.project)}"></div></div><span>${money(p.cost)}</span></div>`).join('')}
        ${section('Work time by project', 'Hands-on work time per project folder.')}
        ${projects.map(p => `<div class="hbar" data-tip="${escapeHtml(p.project)}: ${fmtDuration(p.workMs)} of hands-on work by ${p.agents} agent${p.agents > 1 ? 's' : ''}"><span>${escapeHtml(p.project)}</span><div class="bar"><div style="width:${p.workMs / maxWork * 100}%;background:${projectColor(p.project)}"></div></div><span>${fmtDuration(p.workMs)}</span></div>`).join('')}
      </div>
      <div>
        ${section('Working right now', 'Agents that are busy at this moment and what they are doing. Click one to open their panel.')}
        <div class="feed">${busy.map(s => `<div data-id="${s.id}" data-tip="Click to open ${escapeHtml(personaFor(s).name)}'s panel (${escapeHtml(s.project)}: ${escapeHtml(s.title)})">${avatarCell(s)}<b>${escapeHtml(personaFor(s).name)}</b><span class="what">${escapeHtml(s.activity || s.title)}</span></div>`).join('') || '<p class="muted small">Nobody is working. Time to hand out tasks?</p>'}</div>
        ${section('Needs you', 'Agents blocked on a permission ❗ or waiting for your reply 💬. Click one to jump to them.')}
        <div class="feed">${needs.map(s => `<div data-id="${s.id}" data-tip="${s.status === 'waiting' ? 'Blocked until you approve or answer in their terminal' : 'Finished their turn and is waiting for your next message'}. Click to open their panel.">${avatarCell(s)}<b>${escapeHtml(personaFor(s).name)}</b><span class="what">${s.status === 'waiting' ? `❗ ${escapeHtml(s.waitingFor || 'waiting for input')}` : '💬 your turn'} · ${escapeHtml(s.title)}</span></div>`).join('') || '<p class="muted small">Nobody is waiting on you. 🎉</p>'}</div>
        ${section('Helpers on the floor', 'Subagents running for an agent right now, shown as 🤖 robots at their desk.')}
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
  const TIPS = {
    name: 'Agent name and personality preset. Click a row to open their panel.', project: 'The project folder the session runs in.',
    status: 'busy = working now, waiting = needs your permission, your turn = waiting for your reply, idle = on a break, out of office = not running.',
    motivation: 'A playful mood score: working is high, waiting on you or bored is lower, a nearly full context is lowest.',
    level: 'Level from XP: hands-on work time, tool calls, lines changed, prompts, helpers and PRs.', cost: 'Recorded cost of the session, as Claude Code reports it.',
    context: 'How full the context window is. Near 100% the session gets slow and forgetful; consider /compact.', active: 'When the session last wrote to its transcript.',
  };
  const th = (k, label) => `<th data-sort="${k}" data-tip="${escapeHtml(TIPS[k] || '')} Click to sort.">${label}${empSort.key === k ? (empSort.dir > 0 ? ' ▾' : ' ▴') : ''}</th>`;
  const pane = document.querySelector('[data-bpane=employees]');
  pane.innerHTML = `<table><thead><tr><th></th>${th('name', 'Employee')}${th('project', 'Project')}${th('status', 'Status')}<th data-tip="What they are doing right now (the current tool while busy, otherwise the session title).">Doing now</th>${th('motivation', 'Motivation')}${th('level', 'Level')}${th('cost', 'Cost')}${th('context', 'Context')}${th('active', 'Last active')}</tr></thead><tbody>
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
  pane.innerHTML = `<table><thead><tr><th data-tip="Rank by XP. 👑 is the top agent.">#</th><th></th><th data-tip="Agent name and project.">Agent</th><th data-tip="Level and rank, from Intern to Legend. Level 5 and up get a private office.">Level</th><th data-tip="10 per minute of hands-on work, 2 per tool call, ½ per line changed, 5 per prompt, 30 per helper, 250 per PR.">XP</th><th data-tip="Hands-on work time: from each prompt to Claude's last message in that turn.">Work</th><th data-tip="Achievements earned. Hover an icon for its name.">Badges</th></tr></thead><tbody>
    ${list.map((s, i) => `<tr data-id="${s.id}"><td>${i === 0 ? '👑' : i + 1}</td><td>${avatarCell(s)}</td>
      <td><b>${escapeHtml(personaFor(s).name)}</b> <span class="muted small">${escapeHtml(s.project)}</span></td>
      <td>Lv ${s.level || 1} <span class="muted small">${escapeHtml(s.rank || '')}</span></td>
      <td>${(s.xp || 0).toLocaleString()}</td><td>${fmtDuration(s.workMs)}</td>
      <td>${(s.badges || []).map(b => `<span title="${escapeHtml(BADGES[b]?.name || b)}">${BADGES[b]?.icon || ''}</span>`).join('')}</td></tr>`).join('')}
  </tbody></table>
  <p class="muted small">XP: 10 per minute of hands-on work, 2 per tool call, ½ per line changed, 5 per prompt, 30 per helper, 250 per PR. 👑 marks the top agent.</p>`;
}

async function renderHiring() {
  const [st, mcp] = await Promise.all([fetch('/api/settings').then(r => r.json()).catch(() => null), fetch('/api/mcp').then(r => r.json()).catch(() => null)]);
  if (st) { $('#hireOn').checked = st.hiring.enabled; $('#hireLevel').value = String(st.hiring.minLevel); $('#hireMax').value = String(st.hiring.maxActive); }
  if (mcp) {
    $('#mcpStatus').textContent = mcp.demo ? '(not available in demo mode)' : mcp.installed ? '✅ Connected. New sessions can hire.' : 'Not connected yet.';
    $('#mcpInstall').textContent = mcp.installed ? '🔌 Disconnect' : '🔌 Connect to Claude Code';
    $('#mcpInstall').dataset.installed = mcp.installed ? '1' : '';
    $('#mcpCmd').textContent = mcp.command;
  }
}
const saveHiring = () => post('/api/settings', { hiring: { enabled: $('#hireOn').checked, minLevel: Number($('#hireLevel').value), maxActive: Number($('#hireMax').value) } }).then(() => toast('Hiring settings saved.'));
$('#hireOn').onchange = saveHiring; $('#hireLevel').onchange = saveHiring; $('#hireMax').onchange = saveHiring;
$('#mcpInstall').onclick = async () => {
  const btn = $('#mcpInstall'), install = !btn.dataset.installed;
  btn.disabled = true; $('#mcpStatus').textContent = install ? 'Connecting…' : 'Disconnecting…';
  try { await post('/api/mcp', { install }); toast(install ? '🔌 Connected. Sessions you start from now on can hire coworkers.' : 'Disconnected.'); }
  catch (e) { toast(`Could not change the MCP setup: ${escapeHtml(e.message)}`); }
  btn.disabled = false; renderHiring();
};

function renderSettings() {
  renderHiring();
  $('#setOffline').checked = showOffline;
  $('#setMatrix').checked = matrix.on;
  $('#setCritters').checked = crittersOn;
  $('#setTheme').value = themeKey;
  $('#setLighting').value = lightingMode;
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
$('#setTheme').innerHTML = Object.entries(THEMES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('');
$('#setTheme').onchange = e => { themeKey = e.target.value; store.set('theme', themeKey); setTheme(themeKey); rebuild(); };
$('#setLighting').onchange = e => { lightingMode = e.target.value; store.set('lighting', lightingMode); };
$('#setCritters').onchange = e => { crittersOn = e.target.checked; store.set('critters', crittersOn); if (!crittersOn) critters = []; };
$('#setYourTurn').onchange = e => { YOUR_TURN_MS = Number(e.target.value) * 60000; store.set('yourTurnMinutes', Number(e.target.value)); refresh(); };
$('#setUnhide').onclick = async () => { await post('/api/hide/', { hide: false }); toast('All hidden cubicles are back.'); refresh(); };
$('#setFit').onclick = () => setZoom(0);
$('#setHelp').onclick = () => { $('#board').hidden = true; openHelp(); };

// personality packs: cast everyone at once, highest XP first; undo restores what was there before
async function applyPack(key) {
  const pack = PACKS[key], replaceCustom = $('#packReplace').checked;
  const list = [...allSessions].sort((a, b) => (b.xp || 0) - (a.xp || 0));
  let i = 0, cast = 0;
  const batch = {};
  for (const s of list) {
    const mine = s.personality && !s.personality.pack && !s.personality.auto;
    if (mine && !replaceCustom) continue;
    const c = pack.cast[i % pack.cast.length];
    const round = Math.floor(i / pack.cast.length);
    const preset = PRESETS.find(p => p.key === c.preset);
    const before = s.personality?.pack ? s.personality.before ?? null : s.personality || null;
    const p = { ...c, name: round ? `${c.name} ${['', 'II', 'III', 'IV'][round] || round + 1}` : c.name,
      traits: preset.traits, hangout: preset.hangout, impact: s.personality?.impact ?? true, role: s.personality?.role || null, pack: key, before };
    p.workStyle = p.impact !== false ? workStyleFor(p) : '';
    batch[s.id] = { replace: p };
    i++; cast++;
  }
  if (cast) await post('/api/personalities', batch);
  toast(cast ? `📎 ${cast} agents now work for <b>${pack.label}</b>. Welcome to Scranton.` : 'Everyone already has a personality you customised. Tick "Also replace…" to recast them.');
  for (const a of agents.values()) a.draftPersona = null;
  await refresh();
  if (selectedId) fillPersonaForm();
}
async function resetPack() {
  const packed = allSessions.filter(s => s.personality?.pack);
  if (packed.length) await post('/api/personalities', Object.fromEntries(packed.map(s => [s.id, s.personality.before ? { replace: s.personality.before } : { reset: true }])));
  toast(packed.length ? `↩️ ${packed.length} agents are back to their own personalities.` : 'No pack is active.');
  await refresh();
  if (selectedId) fillPersonaForm();
}
$('#packDunder').onclick = () => applyPack('dunder');
$('#packReset').onclick = resetPack;

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
$('#newPreset').innerHTML = presetOptions();
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
$('#newBtn').onclick = () => { newTodo = null; openNew(); };
let newTodo = null; // board item a new hire is for
async function openNewForTodo(item) {
  newTodo = item;
  await openNew();
  const f = $('#newForm');
  const projects = [...$('#projectList').options].map(o => o.value);
  const match = projects.find(p => p.split('/').pop() === item.project);
  if (match) f.cwd.value = match;
  f.role.value = 'fixer'; f.role.dispatchEvent(new Event('change'));
  f.prompt.value = `${item.title}${item.notes ? `\n\n${item.notes}` : ''}`;
  f.mode.value = 'background'; syncNewForm();
}
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
    await post('/api/new', { cwd: f.cwd.value.trim(), prompt: f.prompt.value.trim(), persona, role: role?.key || null, background, todoId: newTodo?.id });
    newTodo = null; loadBoard();
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
  if (e.key === 'Tab') { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); return; }
  if (e.key === ' ' && replay.on) { e.preventDefault(); $('#tlPlay').click(); return; }
  if (e.key === '+' || e.key === '=') return $('#zoomIn').click();
  if (e.key === '-') return $('#zoomOut').click();
  if (e.key === '0') return setZoom(0);
  const actions = {
    n: () => { newTodo = null; openNew(); }, d: () => openBoard(), b: () => openTodo(), s: () => setShowOffline(!showOffline),
    m: () => (standup.on ? endStandup() : startStandup()), t: () => (replay.on ? stopReplay() : startReplay()),
    o: () => selectedId && openInTerminal(), c: () => selectedId && $('#copyCmd').click(), h: () => selectedId && hideSelected(),
    a: () => { if (selectedId) { document.querySelector('.tabs [data-tab=ask]').click(); $('#askInput').focus(); } },
  };
  // Letter shortcuts wait a moment: if another letter follows quickly you're typing a word
  // (like a cheat code), so the shortcut is cancelled.
  if (/^[a-z]$/.test(k)) {
    const now = performance.now(), typing = now - lastLetterAt < 350;
    lastLetterAt = now;
    clearTimeout(pendingShortcut);
    if (typing || !actions[k]) return;
    pendingShortcut = setTimeout(actions[k], 350);
  }
});
let pendingShortcut = null, lastLetterAt = 0;
window.addEventListener('resize', resize);

// debug handle: office.step(30) fast-forwards the simulation 30 seconds
window.office = {
  agents: () => [...agents.values()],
  step(seconds) { for (let i = 0; i < seconds * 20; i++) { time += 0.05; if (replay.on) tickReplay(0.05); for (const a of agents.values()) a.update(0.05); for (const h of helpers.values()) h.update(0.05); updateEffects(0.05); updateMatrix(0.05); updateCritters(0.05); } render(); },
  matrix: on => setMatrix(on), critter: kind => spawnCritter(kind),
};

const config = await (await fetch('/api/config')).json().catch(() => ({ terminal: 'Terminal', achievements: [] }));
BADGES = Object.fromEntries(config.achievements.map(a => [a.id, a]));
$('#openBtn').textContent = `🖥️ Open in ${config.terminal}`;
await loadPM();
await refresh();
if (!store.get('seenHelp', false)) { store.set('seenHelp', true); openHelp(); }
setInterval(refresh, 3000);
requestAnimationFrame(loop);
