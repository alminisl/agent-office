// Agent Office — local server. Reads ~/.claude session data and serves the office UI.
// Zero dependencies: `node server.mjs` then open http://localhost:4747
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { demoSessions, demoDetail, demoSavePersonality, DEMO_REPLY, DEMO_QUIRKS } from './demo.mjs';

const PORT = Number(process.env.PORT || 4747);
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const LIVE_DIR = path.join(CLAUDE_DIR, 'sessions');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PERSONALITIES_FILE = path.join(ROOT, 'data', 'personalities.json');
const HIDDEN_FILE = path.join(ROOT, 'data', 'hidden.json');
const REPORTS_DIR = path.join(ROOT, 'data', 'reports');
const TERMINAL = process.env.OFFICE_TERMINAL || (process.env.TERM_PROGRAM === 'iTerm.app' ? 'iTerm' : 'Terminal');
const MAX_DAYS = Number(process.env.MAX_DAYS || 14);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 20);
const DEMO = process.env.DEMO === '1' || process.argv.includes('--demo');

// ---------- transcript parsing (cached by mtime) ----------
const cache = new Map(); // file -> { mtimeMs, summary }

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

function isRealPrompt(t) {
  if (!t) return false;
  const s = t.trim();
  return s && !s.startsWith('<') && !s.startsWith('Caveat:') && !s.startsWith('[Request interrupted');
}

function describeTool(name, input = {}) {
  const base = p => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return `Editing ${base(input.file_path || input.notebook_path)}`;
    case 'Read': return `Reading ${base(input.file_path)}`;
    case 'Bash': return input.description ? `$ ${input.description}` : 'Running a command';
    case 'Grep': case 'Glob': return `Searching ${input.pattern ? `"${String(input.pattern).slice(0, 24)}"` : ''}`;
    case 'WebFetch': case 'WebSearch': return 'Browsing the web';
    case 'Agent': case 'Task': return `Delegating: ${input.description || 'subtask'}`;
    case 'TodoWrite': return 'Updating the todo list';
    default: return name.startsWith('mcp__') ? `Using ${name.split('__')[1]}` : `Using ${name}`;
  }
}

async function parseTranscript(file) {
  const stat = await fsp.stat(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.summary;

  const raw = await fsp.readFile(file, 'utf8');
  const s = {
    id: path.basename(file, '.jsonl'), file, cwd: null, gitBranch: null, title: null,
    lastPrompt: null, prompts: [], replies: [], files: {}, tools: {}, prs: [],
    cost: 0, linesAdded: 0, linesRemoved: 0, firstAt: null, lastAt: null,
    lastActivity: null, messageCount: 0, model: null,
    // gamification counters
    promptCount: 0, toolCount: 0, testRuns: 0, reads: 0, webCalls: 0, subagentsSpawned: 0,
    nightOwl: false, workMs: 0, context: 0, peakContext: 0,
  };
  // work time = for each turn, time from your prompt to Claude's last message in that turn
  let turnStart = null, turnEnd = null;
  const closeTurn = () => { if (turnStart && turnEnd > turnStart) s.workMs += Math.min(turnEnd - turnStart, 2 * 3600e3); turnStart = turnEnd = null; };
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.timestamp) { s.firstAt ??= d.timestamp; s.lastAt = d.timestamp; }
    if (d.cwd) s.cwd = d.cwd;
    if (d.gitBranch) s.gitBranch = d.gitBranch;
    switch (d.type) {
      case 'ai-title': s.title = d.aiTitle; break;
      case 'custom-title': s.customTitle = d.customTitle; break;
      case 'last-prompt': if (d.lastPrompt) s.lastPrompt = d.lastPrompt; break;
      case 'pr-link': if (!s.prs.some(p => p.url === d.prUrl)) s.prs.push({ number: d.prNumber, url: d.prUrl, repo: d.prRepository }); break;
      case 'cost-state':
        s.cost = d.totalCostUSD || s.cost; s.linesAdded = d.totalLinesAdded || s.linesAdded; s.linesRemoved = d.totalLinesRemoved || s.linesRemoved; break;
      case 'user': {
        if (d.isSidechain || d.isMeta) break;
        const t = textOf(d.message?.content);
        if (isRealPrompt(t)) {
          s.prompts.push({ at: d.timestamp, text: t.slice(0, 1200) }); s.messageCount++; s.promptCount++;
          closeTurn(); turnStart = Date.parse(d.timestamp);
        }
        break;
      }
      case 'assistant': {
        if (d.isSidechain) break;
        const m = d.message || {};
        if (m.model && !m.model.startsWith('<')) s.model = m.model;
        const u = m.usage;
        if (u) {
          s.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          s.peakContext = Math.max(s.peakContext, s.context);
        }
        if (d.timestamp) {
          turnEnd = Date.parse(d.timestamp);
          const hr = new Date(turnEnd).getHours();
          if (hr >= 0 && hr < 5) s.nightOwl = true;
        }
        for (const c of m.content || []) {
          if (c.type === 'text' && c.text?.trim()) {
            s.replies.push({ at: d.timestamp, text: c.text.slice(0, 2000) });
            s.lastActivity = { at: d.timestamp, label: 'Talking' };
          } else if (c.type === 'tool_use') {
            s.tools[c.name] = (s.tools[c.name] || 0) + 1;
            s.toolCount++;
            if (c.name === 'Bash' && /\b(test|pytest|jest|vitest|mocha|rspec|go test|cargo test)\b/.test(c.input?.command || '')) s.testRuns++;
            if (['Read', 'Grep', 'Glob'].includes(c.name)) s.reads++;
            if (['WebFetch', 'WebSearch'].includes(c.name) || c.name.startsWith('mcp__claude-in-chrome')) s.webCalls++;
            if (['Agent', 'Task'].includes(c.name)) s.subagentsSpawned++;
            const fp = c.input?.file_path;
            if (fp && ['Edit', 'Write', 'MultiEdit'].includes(c.name)) s.files[fp] = (s.files[fp] || 0) + 1;
            s.lastActivity = { at: d.timestamp, label: describeTool(c.name, c.input) };
          }
        }
        s.messageCount++;
        break;
      }
    }
  }
  closeTurn();
  s.prompts = s.prompts.slice(-15);
  s.replies = s.replies.slice(-8);
  s.files = Object.entries(s.files).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, n]) => ({ path: f, edits: n }));
  s.tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n }));
  s.updatedAt = stat.mtimeMs;
  cache.set(file, { mtimeMs: stat.mtimeMs, summary: s });
  return s;
}

// ---------- gamification ----------
const RANKS = [[1, 'Intern'], [3, 'Junior Dev'], [6, 'Engineer'], [10, 'Senior Engineer'], [15, 'Staff Engineer'], [21, 'Principal'], [28, 'Distinguished'], [36, 'Legend']];
const xpForLevel = L => 50 * L * (L - 1); // cumulative XP needed to reach level L

const ACHIEVEMENTS = [
  { id: 'shipper', icon: '🚀', name: 'Shipper', hint: 'Open a pull request', test: s => s.prs.length > 0 },
  { id: 'marathon', icon: '🏃', name: 'Marathon', hint: '2h of hands-on work', test: s => s.workMs >= 2 * 3600e3 },
  { id: 'nightowl', icon: '🦉', name: 'Night Owl', hint: 'Work between midnight and 5am', test: s => s.nightOwl },
  { id: 'testpilot', icon: '🧪', name: 'Test Pilot', hint: 'Run the tests 5 times', test: s => s.testRuns >= 5 },
  { id: 'janitor', icon: '🧹', name: 'Janitor', hint: 'Delete more than you add (50+ lines)', test: s => s.linesRemoved >= 50 && s.linesRemoved > s.linesAdded },
  { id: 'wordsmith', icon: '✍️', name: 'Wordsmith', hint: 'Add 500 lines', test: s => s.linesAdded >= 500 },
  { id: 'detective', icon: '🔍', name: 'Detective', hint: 'Read or search 100 times', test: s => s.reads >= 100 },
  { id: 'teamplayer', icon: '🤝', name: 'Team Player', hint: 'Delegate to 3 helpers', test: s => s.subagentsSpawned >= 3 },
  { id: 'surfer', icon: '🌐', name: 'Surfer', hint: 'Browse the web 5 times', test: s => s.webCalls >= 5 },
  { id: 'highroller', icon: '💸', name: 'High Roller', hint: 'Spend $20', test: s => s.cost >= 20 },
  { id: 'bigbrain', icon: '🧠', name: 'Big Brain', hint: 'Fill 75% of the context window', test: (s, win) => s.peakContext >= win * 0.75 },
  { id: 'chatterbox', icon: '💬', name: 'Chatterbox', hint: '50 prompts in one session', test: s => s.promptCount >= 50 },
];

let defaultWindow = 200_000;
try {
  const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
  if (/\[1m\]/i.test(settings.model || '')) defaultWindow = 1_000_000;
} catch {}
if (process.env.CONTEXT_WINDOW) defaultWindow = Number(process.env.CONTEXT_WINDOW);
const contextWindow = s => (s.peakContext > 200_000 ? 1_000_000 : defaultWindow);

function gamify(s) {
  const minutes = s.workMs / 60000;
  const xp = Math.round(minutes * 10 + s.toolCount * 2 + (s.linesAdded + s.linesRemoved) * 0.5 + s.prs.length * 250 + s.promptCount * 5 + s.subagentsSpawned * 30);
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  const rank = RANKS.filter(([l]) => level >= l).pop()[1];
  const win = contextWindow(s);
  return {
    xp, level, rank, levelXp: xpForLevel(level), nextXp: xpForLevel(level + 1),
    workMs: s.workMs, context: s.context, contextWindow: win,
    badges: ACHIEVEMENTS.filter(a => a.test(s, win)).map(a => a.id),
  };
}

// Subagents a live session is running right now (their transcript was touched in the last 45s)
async function activeHelpers(s) {
  const dir = path.join(path.dirname(s.file), s.id, 'subagents');
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names.filter(n => n.endsWith('.jsonl'))) {
    const f = path.join(dir, n);
    const st = await fsp.stat(f).catch(() => null);
    if (!st || Date.now() - st.mtimeMs > 45e3) continue;
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {}
    // last tool call from the tail of the file
    let activity = null;
    try {
      const fh = await fsp.open(f, 'r');
      const len = Math.min(st.size, 65536);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.size - len);
      await fh.close();
      for (const line of buf.toString('utf8').split('\n').reverse()) {
        try {
          const d = JSON.parse(line);
          const tu = d.message?.content?.findLast?.(c => c.type === 'tool_use');
          if (tu) { activity = describeTool(tu.name, tu.input); break; }
        } catch {}
      }
    } catch {}
    out.push({ id: n.replace(/\.jsonl$/, ''), description: meta.description || 'Helping out', type: meta.agentType || 'helper', activity });
  }
  return out;
}

// ---------- background agents (roles that run inside the office and report back) ----------
// Tools are decided here per role, never taken from the browser. Anything not listed is denied
// automatically in print mode, so reviewers can read and inspect but not push, merge or edit.
const READ_ONLY = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(git branch:*)', 'Bash(git fetch:*)', 'Bash(git blame:*)', 'Bash(ls:*)'];
const PR_TOOLS = ['Bash(gh pr list:*)', 'Bash(gh pr view:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr checks:*)', 'Bash(glab mr list:*)', 'Bash(glab mr view:*)', 'Bash(glab mr diff:*)'];
const TEST_TOOLS = ['Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npx vitest:*)', 'Bash(npx jest:*)', 'Bash(yarn test:*)', 'Bash(pnpm test:*)', 'Bash(pytest:*)', 'Bash(python -m pytest:*)', 'Bash(go test:*)', 'Bash(cargo test:*)', 'Bash(make test:*)', 'Bash(bundle exec rspec:*)', 'Bash(./manage.py test:*)', 'Bash(python manage.py test:*)'];
const ROLE_TOOLS = {
  reviewer: [...READ_ONLY, ...PR_TOOLS],
  qa: [...READ_ONLY, ...TEST_TOOLS],
  bughunter: [...READ_ONLY, ...TEST_TOOLS],
  security: [...READ_ONLY],
  docs: [...READ_ONLY],
  custom: [...READ_ONLY],
};
const BACKGROUND_NOTE = 'You are running unattended inside "Agent Office": nobody can answer questions or approve extra permissions, and you only have read-only tools (plus test runners for QA roles). Do not try to edit files. When you are done, reply with a concise markdown report: a one-line summary, then findings ranked by severity with file:line references, then recommended next steps.';
const runs = new Map(); // session id -> { child, cwd, role, name, startedAt, endedAt, state }

async function loadReport(id) {
  try { return JSON.parse(await fsp.readFile(path.join(REPORTS_DIR, `${id}.json`), 'utf8')); } catch { return null; }
}

function startBackgroundRun({ id, cwd, prompt, persona, role }) {
  const tools = ROLE_TOOLS[role] || ROLE_TOOLS.custom;
  const system = [persona?.workStyle, BACKGROUND_NOTE].filter(Boolean).join('\n\n');
  const args = ['-p', prompt, '--allowedTools', ...tools, '--output-format', 'json', '--session-id', id, '--append-system-prompt', system];
  if (persona?.name) args.push('-n', persona.name);
  const child = spawn(process.env.CLAUDE_BIN || 'claude', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { child, cwd, role, name: persona?.name, startedAt: Date.now(), state: 'running' };
  runs.set(id, run);
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const finish = async (ok, result, cost) => {
    run.state = ok ? 'done' : 'failed'; run.endedAt = Date.now(); run.child = null;
    await fsp.mkdir(REPORTS_DIR, { recursive: true });
    await fsp.writeFile(path.join(REPORTS_DIR, `${id}.json`), JSON.stringify({ role, name: persona?.name, ok, result, cost, startedAt: run.startedAt, endedAt: run.endedAt }, null, 2));
  };
  child.on('error', e => finish(false, `Could not start claude: ${e.message}`, 0));
  child.on('close', code => {
    let data = null;
    try { data = JSON.parse(out); } catch {}
    if (data) finish(!data.is_error, data.result || '(no report)', data.total_cost_usd || 0);
    else finish(false, `claude exited with code ${code}. ${(err || out).slice(0, 1000)}`, 0);
  });
}

// background runs look like live sessions: busy while running, then "your turn" for a while with a report
const RUN_LINGER_MS = 15 * 60 * 1000;
function runAsLive(id, run) {
  if (run.state === 'running') return { status: 'busy', since: run.startedAt, cwd: run.cwd, name: run.name, startedAt: run.startedAt, background: true };
  if (Date.now() - run.endedAt < RUN_LINGER_MS) return { status: 'idle', since: run.endedAt, cwd: run.cwd, name: run.name, startedAt: run.startedAt, background: true };
  return null;
}

// ---------- live session status ----------
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function liveSessions() {
  const out = new Map();
  let names = [];
  try { names = await fsp.readdir(LIVE_DIR); } catch { return out; }
  for (const n of names.filter(n => n.endsWith('.json'))) {
    try {
      const d = JSON.parse(await fsp.readFile(path.join(LIVE_DIR, n), 'utf8'));
      if (!d.sessionId || !pidAlive(d.pid)) continue;
      out.set(d.sessionId, { status: d.status || 'idle', waitingFor: d.waitingFor, name: d.name, pid: d.pid, cwd: d.cwd, since: d.statusUpdatedAt || d.updatedAt, startedAt: d.startedAt });
    } catch {}
  }
  return out;
}

async function allTranscripts() {
  const files = [];
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_DIR); } catch { return files; }
  for (const dir of dirs) {
    let entries = [];
    try { entries = await fsp.readdir(path.join(PROJECTS_DIR, dir)); } catch { continue; }
    for (const e of entries) if (e.endsWith('.jsonl')) files.push(path.join(PROJECTS_DIR, dir, e));
  }
  return files;
}

async function listSessions() {
  const [files, live, personalities, hidden] = await Promise.all([allTranscripts(), liveSessions(), loadPersonalities(), loadHidden()]);
  for (const [id, run] of runs) { const l = runAsLive(id, run); if (l && !live.has(id)) live.set(id, l); }
  const cutoff = Date.now() - MAX_DAYS * 86400e3;
  const stats = await Promise.all(files.map(async f => ({ f, st: await fsp.stat(f).catch(() => null) })));
  const candidates = stats
    .filter(x => x.st && (x.st.mtimeMs >= cutoff || live.has(path.basename(x.f, '.jsonl'))))
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

  const sessions = [];
  const seen = new Set();
  const reports = new Map();
  try { for (const f of await fsp.readdir(REPORTS_DIR)) if (f.endsWith('.json')) reports.set(f.slice(0, -5), await loadReport(f.slice(0, -5))); } catch {}
  const push = async (id, s, l) => {
    seen.add(id);
    const g = s.file ? gamify(s) : null;
    const helpers = l && s.file ? await activeHelpers(s) : [];
    sessions.push({
      ...g, helpers,
      id, cwd: s.cwd || l?.cwd, project: path.basename(s.cwd || l?.cwd || 'unknown'),
      title: s.customTitle || s.title || s.lastPrompt?.slice(0, 60) || l?.name || 'New session',
      lastPrompt: s.lastPrompt, gitBranch: s.gitBranch, updatedAt: s.updatedAt || l?.startedAt,
      status: l ? l.status : 'offline', statusSince: l?.since, waitingFor: l?.waitingFor, live: !!l,
      activity: l?.status === 'busy' ? s.lastActivity?.label : null,
      cost: s.cost || (runs.get(id)?.state !== 'running' && reports.get(id)?.cost) || 0, prs: s.prs?.length || 0, personality: personalities[id] || null,
      background: runs.has(id), runState: runs.get(id)?.state || null, hasReport: reports.has(id),
      linesAdded: s.linesAdded || 0, linesRemoved: s.linesRemoved || 0, toolCount: s.toolCount || 0, gitBranch: s.gitBranch,
    });
  };
  // live sessions first (always shown, even before they write a transcript)
  for (const [id, l] of live) {
    const f = candidates.find(x => path.basename(x.f, '.jsonl') === id);
    await push(id, f ? await parseTranscript(f.f) : {}, l);
  }
  for (const { f } of candidates) {
    if (sessions.length >= MAX_ROOMS) break;
    const id = path.basename(f, '.jsonl');
    if (seen.has(id) || hidden.includes(id)) continue;
    const s = await parseTranscript(f);
    if (s.messageCount < 2) continue; // skip empty/one-shot noise
    await push(id, s, null);
  }
  return sessions;
}

async function knownProjects() {
  const counts = new Map();
  for (const f of await allTranscripts()) {
    const s = await parseTranscript(f).catch(() => null);
    if (s?.cwd) counts.set(s.cwd, Math.max(counts.get(s.cwd) || 0, s.updatedAt));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
}

// ---------- session control ----------
async function loadHidden() {
  try { return JSON.parse(await fsp.readFile(HIDDEN_FILE, 'utf8')); } catch { return []; }
}
async function setHidden(id, hide) {
  let h = await loadHidden();
  h = hide ? [...new Set([...h, id])] : id ? h.filter(x => x !== id) : [];
  await fsp.mkdir(path.dirname(HIDDEN_FILE), { recursive: true });
  await fsp.writeFile(HIDDEN_FILE, JSON.stringify(h, null, 2));
  return h;
}

const shq = v => `'${String(v).replace(/'/g, `'\\''`)}'`;
const asq = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// Opens a new terminal window running `command` (iTerm or Terminal.app).
function openTerminal(command) {
  const script = TERMINAL === 'iTerm'
    ? `tell application "iTerm"
         activate
         set w to (create window with default profile)
         tell current session of w to write text "${asq(command)}"
       end tell`
    : `tell application "Terminal"
         activate
         do script "${asq(command)}"
       end tell`;
  return new Promise((resolve, reject) => execFile('osascript', ['-e', script], err => (err ? reject(err) : resolve())));
}

async function endSession(id) {
  const run = runs.get(id);
  if (run?.state === 'running') { run.child?.kill('SIGTERM'); return; }
  const l = (await liveSessions()).get(id);
  if (!l) throw new Error('session is not running');
  // make sure the pid still belongs to a claude process before signalling it
  const comm = await new Promise(r => execFile('ps', ['-p', String(l.pid), '-o', 'command='], (e, out) => r(String(out || ''))));
  if (!/claude/i.test(comm)) throw new Error('pid does not look like a claude process');
  process.kill(l.pid, 'SIGTERM');
}

async function sessionDetail(id) {
  const files = await allTranscripts();
  const f = files.find(x => path.basename(x, '.jsonl') === id);
  const run = runs.get(id);
  const live = (await liveSessions()).get(id) || (run && runAsLive(id, run));
  if (!f && !live) return null;
  // a session that just started may not have written its transcript yet
  const s = f ? await parseTranscript(f) : {
    id, cwd: live.cwd, prompts: [], replies: [], files: [], tools: [], prs: [], cost: 0, linesAdded: 0, linesRemoved: 0,
    messageCount: 0, promptCount: 0, toolCount: 0, testRuns: 0, reads: 0, webCalls: 0, subagentsSpawned: 0,
    nightOwl: false, workMs: 0, context: 0, peakContext: 0, empty: true,
  };
  const personalities = await loadPersonalities();
  return { ...s, ...gamify(s), report: await loadReport(id), runState: run?.state || null, achievements: ACHIEVEMENTS.map(({ test, ...a }) => a), status: live ? live.status : 'offline', waitingFor: live?.waitingFor, personality: personalities[id] || null };
}

// ---------- personalities ----------
async function loadPersonalities() {
  try { return JSON.parse(await fsp.readFile(PERSONALITIES_FILE, 'utf8')); } catch { return {}; }
}
async function savePersonality(id, p) {
  const all = await loadPersonalities();
  // { reset: true } forgets the personality, { replace: {...} } overwrites it (used by packs / undo)
  if (p.reset) delete all[id];
  else if (p.replace) all[id] = p.replace;
  else all[id] = { ...all[id], ...p };
  await fsp.mkdir(path.dirname(PERSONALITIES_FILE), { recursive: true });
  await fsp.writeFile(PERSONALITIES_FILE, JSON.stringify(all, null, 2));
  return all[id] || {};
}

// ---------- ask an agent (forks the session so the original is untouched) ----------
// Quick mode (default): a fast model answers from a short briefing built from the transcript.
// Deep mode: resumes a fork of the full session. Complete memory, but it re-reads the whole
// context, so it is slow and costly on big sessions.
function briefing(d) {
  const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);
  return [
    `Session title: ${d.title || 'untitled'}`,
    `Project: ${d.cwd || 'unknown'}${d.gitBranch ? ` (branch ${d.gitBranch})` : ''}`,
    `Status right now: ${d.status}${d.lastActivity ? `; last action: ${d.lastActivity.label}` : ''}`,
    `Totals: ${Math.round((d.workMs || 0) / 60000)} min of work, ${d.toolCount} tool calls, +${d.linesAdded}/-${d.linesRemoved} lines, $${(d.cost || 0).toFixed(2)}`,
    d.files?.length ? `Files edited: ${d.files.map(f => f.path.replace(`${d.cwd}/`, '')).join(', ')}` : '',
    d.prs?.length ? `PRs: ${d.prs.map(p => p.url).join(', ')}` : '',
    d.report ? `Report you handed in:\n${clip(d.report.result, 1500)}` : '',
    'What the user asked you (oldest first):',
    ...d.prompts.slice(-8).map(p => `- ${clip(p.text.replace(/\s+/g, ' '), 400)}`),
    'Your most recent replies (oldest first):',
    ...d.replies.slice(-5).map(r => `- ${clip(r.text.replace(/\s+/g, ' '), 900)}`),
  ].filter(Boolean).join('\n');
}

function askAgent(detail, question, mode, persona, res) {
  const p = { ...(detail.personality || {}), ...(persona || {}) };
  const system = [
    'You are being interviewed inside "Agent Office", a playful visualization where each Claude Code session is an office worker.',
    `Your name is ${p.name || 'an unnamed agent'}.`,
    p.traits ? `Your personality: ${p.traits}. Stay fully in character (tone, quirks, catchphrases) while being accurate about the work.` : '',
    'Answer only from what you know about this session. Do not run tools or change anything. If you do not know, say so. Keep it conversational and under ~150 words unless asked for more.',
  ].filter(Boolean).join(' ');

  const deep = mode === 'deep';
  const prompt = deep
    ? (p.traits ? `[Office interview: answer in character as ${p.name || 'yourself'}, ${p.traits}]\n\n${question}` : question)
    : `Here is a briefing of the Claude Code session you are (it is your own work):\n\n${briefing(detail)}\n\nThe user asks: ${question}`;
  const stream = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  const args = deep
    ? ['-p', prompt, '--resume', detail.id, '--fork-session', '--no-session-persistence', '--tools', '', '--append-system-prompt', system, ...stream]
    : ['-p', prompt, '--model', process.env.ASK_MODEL || 'haiku', '--no-session-persistence', '--tools', '', '--append-system-prompt', system, ...stream];
  const child = spawn(process.env.CLAUDE_BIN || 'claude', args, { cwd: deep ? detail.cwd || os.homedir() : os.tmpdir(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });

  let wrote = false, buf = '', err = '';
  const timer = setTimeout(() => { child.kill(); res.end(`${wrote ? '\n\n' : ''}⏱️ No answer after ${deep ? 5 : 2} minutes, so I gave up. ${deep ? 'This session is large, so try Quick mode.' : ''}`); }, (deep ? 5 : 2) * 60e3);
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (d.type === 'stream_event' && d.event?.delta?.type === 'text_delta') { res.write(d.event.delta.text); wrote = true; }
      else if (d.type === 'result') {
        if (!wrote && d.result) { res.write(d.result); wrote = true; }
        if (d.is_error && !wrote) res.write(`⚠️ ${d.result || 'Claude returned an error'}`);
      }
    }
  });
  child.stderr.on('data', d => { err += d; });
  child.on('error', e => { clearTimeout(timer); res.end(`⚠️ Could not start claude: ${e.message}`); });
  child.on('close', code => { clearTimeout(timer); if (!res.writableEnded) res.end(code && !wrote ? `⚠️ claude exited with code ${code}. ${err.slice(0, 500)}` : ''); });
  res.on('close', () => { clearTimeout(timer); if (child.exitCode === null) child.kill(); });
}

// ---------- personality quirks (generated by Claude from the traits) ----------
function generateQuirks(name, traits) {
  const prompt = `Invent office-worker quirks for a character in a pixel-art office game where AI coding agents are coworkers.
Character: ${name || 'an agent'}, ${traits}.
Reply with ONLY a JSON object, no prose, no code fences:
{"work": [8 short in-character lines (max 6 words) they mutter while coding],
 "idle": [8 short in-character lines (max 6 words) for coffee breaks and the gym],
 "verbs": {"Editing": "...", "Reading": "...", "Searching": "...", "Running": "..."} (in-character replacements for these activity verbs, one or two words each),
 "emoji": "one emoji that represents them"}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN || 'claude', ['-p', prompt, '--model', 'haiku', '--no-session-persistence', '--tools', '', '--output-format', 'text'], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', () => {
      try { resolve(JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))); }
      catch { reject(new Error(`could not parse quirks: ${(err || out).slice(0, 200)}`)); }
    });
  });
}

// ---------- demo mode: fake data only, nothing is read from ~/.claude ----------
async function demoRoute(url, req, res) {
  const publicAchievements = ACHIEVEMENTS.map(({ test, ...a }) => a);
  let m;
  if (url.pathname === '/api/sessions') return json(res, 200, demoSessions());
  if ((m = url.pathname.match(/^\/api\/session\/([\w-]+)$/))) {
    const d = demoDetail(m[1], publicAchievements);
    return d ? json(res, 200, d) : json(res, 404, { error: 'not found' });
  }
  if ((m = url.pathname.match(/^\/api\/personality\/([\w-]+)$/))) return json(res, 200, demoSavePersonality(m[1], await readBody(req)));
  if (url.pathname.startsWith('/api/ask/')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    for (const word of DEMO_REPLY.split(' ')) { res.write(`${word} `); await new Promise(r => setTimeout(r, 40)); }
    return res.end();
  }
  if (url.pathname === '/api/quirks') return json(res, 200, DEMO_QUIRKS);
  if (url.pathname === '/api/projects') return json(res, 200, ['/home/dev/code/pixel-shop', '/home/dev/code/api-gateway', '/home/dev/code/docs-site']);
  if (url.pathname === '/api/hidden') return json(res, 200, []);
  return json(res, 200, { ok: true, demo: true }); // new/open/end/hide are no-ops in the demo
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let b = '';
  for await (const c of req) b += c;
  return b ? JSON.parse(b) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let m;
  try {
    if (DEMO && url.pathname.startsWith('/api/') && url.pathname !== '/api/config') return demoRoute(url, req, res);
    if (url.pathname === '/api/sessions') return json(res, 200, await listSessions());
    if ((m = url.pathname.match(/^\/api\/session\/([\w-]+)$/))) {
      const d = await sessionDetail(m[1]);
      return d ? json(res, 200, d) : json(res, 404, { error: 'not found' });
    }
    if ((m = url.pathname.match(/^\/api\/personality\/([\w-]+)$/)) && req.method === 'POST') {
      return json(res, 200, await savePersonality(m[1], await readBody(req)));
    }
    if ((m = url.pathname.match(/^\/api\/ask\/([\w-]+)$/)) && req.method === 'POST') {
      const d = await sessionDetail(m[1]);
      if (!d) return json(res, 404, { error: 'This session no longer exists.' });
      if (d.empty) return json(res, 409, { error: "They haven't started talking yet. Ask again after their first reply." });
      const { question, mode, persona } = await readBody(req);
      return askAgent(d, String(question || 'What are you working on and what do you think of it?'), mode, persona, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/quirks') {
      const { name, traits } = await readBody(req);
      return json(res, 200, await generateQuirks(name, traits));
    }
    if (url.pathname === '/api/hidden') return json(res, 200, await loadHidden());
    if (url.pathname === '/api/projects') return json(res, 200, await knownProjects());
    if (url.pathname === '/api/config') return json(res, 200, { terminal: TERMINAL, maxDays: MAX_DAYS, maxRooms: MAX_ROOMS, achievements: ACHIEVEMENTS.map(({ test, ...a }) => a), ranks: RANKS });
    if (req.method === 'POST' && url.pathname === '/api/new') {
      const { cwd, prompt, persona, role, background } = await readBody(req);
      if (!cwd || !fs.existsSync(cwd)) return json(res, 400, { error: 'project folder not found' });
      const id = randomUUID();
      if (persona) await savePersonality(id, { ...persona, role: role || null });
      if (background) {
        if (!prompt) return json(res, 400, { error: 'a background agent needs a task' });
        startBackgroundRun({ id, cwd, prompt, persona, role });
        return json(res, 200, { id, background: true });
      }
      const name = persona?.name ? ` -n ${shq(persona.name)}` : '';
      const style = persona?.workStyle ? ` --append-system-prompt ${shq(persona.workStyle)}` : '';
      await openTerminal(`cd ${shq(cwd)} && claude --session-id ${id}${name}${style}${prompt ? ` ${shq(prompt)}` : ''}`);
      return json(res, 200, { id });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/open\/([\w-]+)$/))) {
      const d = await sessionDetail(m[1]);
      if (!d) return json(res, 404, { error: 'not found' });
      const ws = d.personality?.impact !== false && d.personality?.workStyle;
      await openTerminal(`cd ${shq(d.cwd || os.homedir())} && claude --resume ${d.id}${ws ? ` --append-system-prompt ${shq(ws)}` : ''}`);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/end\/([\w-]+)$/))) {
      await endSession(m[1]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/hide\/([\w-]*)$/))) {
      const { hide } = await readBody(req);
      return json(res, 200, await setHidden(m[1], !!hide));
    }
    // static
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Agent Office${DEMO ? ' (demo mode)' : ''} open at http://localhost:${PORT}`));
