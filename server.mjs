// Agent Office — local server. Reads ~/.claude session data and serves the office UI.
// Zero dependencies: `node server.mjs` then open http://localhost:4747
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { demoSessions, demoDetail, demoSavePersonality, demoSavePersonalities, DEMO_REPLY, DEMO_QUIRKS, DEMO_STANDUP, demoTimeline, demoBoard, demoBoardOp, DEMO_PM, DEMO_PLAN, demoChat, demoChatOp, demoPRs, demoStartReviews, demoReviews, demoStartBrainstorm, demoBrainstorm, demoBrainstormList } from './demo.mjs';

const PORT = Number(process.env.PORT || 4747);
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const LIVE_DIR = path.join(CLAUDE_DIR, 'sessions');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PERSONALITIES_FILE = path.join(ROOT, 'data', 'personalities.json');
const HIDDEN_FILE = path.join(ROOT, 'data', 'hidden.json');
const REPORTS_DIR = path.join(ROOT, 'data', 'reports');
const SETTINGS_FILE = path.join(ROOT, 'data', 'settings.json');
const BOARD_FILE = path.join(ROOT, 'data', 'board.json');
const CHATS_FILE = path.join(ROOT, 'data', 'chats.json');
const WORKTREES_DIR = path.join(os.homedir(), '.agent-office', 'worktrees');
const DEFAULT_SETTINGS = { hiring: { enabled: true, minLevel: 5, maxActive: 3 } };
// Which terminal opens sessions. macOS: iTerm or Terminal. Linux: the first one found of
// gnome-terminal, kitty, konsole, alacritty, wezterm, xfce4-terminal, xterm. OFFICE_TERMINAL overrides.
const LINUX_TERMINALS = ['gnome-terminal', 'kitty', 'konsole', 'alacritty', 'wezterm', 'xfce4-terminal', 'xterm'];
const onPath = bin => (process.env.PATH || '').split(path.delimiter).some(d => d && fs.existsSync(path.join(d, bin)));
const TERMINAL = process.env.OFFICE_TERMINAL
  || (process.platform === 'darwin'
    ? (process.env.TERM_PROGRAM === 'iTerm.app' ? 'iTerm' : 'Terminal')
    : LINUX_TERMINALS.find(onPath) || 'xterm');
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
    turns: [], events: [], // for the timeline: [start, end] of each turn, and [time, label] of each action
  };
  // work time = for each turn, time from your prompt to Claude's last message in that turn
  let turnStart = null, turnEnd = null;
  const closeTurn = () => {
    if (turnStart && turnEnd > turnStart) { s.workMs += Math.min(turnEnd - turnStart, 2 * 3600e3); s.turns.push([turnStart, Math.min(turnEnd, turnStart + 2 * 3600e3)]); }
    turnStart = turnEnd = null;
  };
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
            if (d.timestamp) s.events.push([Date.parse(d.timestamp), 'Talking']);
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
            if (d.timestamp) s.events.push([Date.parse(d.timestamp), s.lastActivity.label]);
          }
        }
        s.messageCount++;
        break;
      }
    }
  }
  closeTurn();
  s.events = s.events.slice(-4000);
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
// Fixers work on their own branch in a separate git worktree: they may edit, test and commit there, never push.
const CHECK_TOOLS = ['Bash(node --check:*)', 'Bash(npm run lint:*)', 'Bash(npm run typecheck:*)', 'Bash(npx tsc --noEmit:*)', 'Bash(npx eslint:*)', 'Bash(ruff check:*)', 'Bash(python -m py_compile:*)', 'Bash(go vet:*)', 'Bash(cargo check:*)'];
const FIXER_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash(ls:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git add:*)', 'Bash(git commit:*)', ...TEST_TOOLS, ...CHECK_TOOLS];
const ROLE_TOOLS = {
  fixer: FIXER_TOOLS,
  reviewer: [...READ_ONLY, ...PR_TOOLS],
  qa: [...READ_ONLY, ...TEST_TOOLS],
  bughunter: [...READ_ONLY, ...TEST_TOOLS],
  security: [...READ_ONLY],
  docs: [...READ_ONLY],
  custom: [...READ_ONLY],
};
const BOARD_NOTE = 'The office has a shared TODO board. Check it with the todo_list tool; if you find follow-up work you will not do yourself, add it with todo_add (short title, details in notes, no duplicates). office_overview shows what the other agents are doing.';
const BACKGROUND_NOTE = `You are running unattended inside "Agent Office": nobody can answer questions or approve extra permissions, and you only have read-only tools (plus test runners for QA roles). Do not try to edit files. ${BOARD_NOTE} When you are done, reply with a concise markdown report: a one-line summary, then findings ranked by severity with file:line references, then recommended next steps.`;
// Background agents get the office MCP server with only the board and overview tools (no hiring).
const OFFICE_MCP_CONFIG = () => JSON.stringify({ mcpServers: { 'agent-office': { command: process.execPath, args: [path.join(ROOT, 'mcp.mjs')], env: { OFFICE_URL: `http://127.0.0.1:${PORT}` } } } });
const BOARD_TOOLS = ['mcp__agent-office__todo_list', 'mcp__agent-office__todo_add', 'mcp__agent-office__todo_update', 'mcp__agent-office__office_overview'];
const FIXER_NOTE = branch => `You are running unattended inside "Agent Office": nobody can answer questions or approve extra permissions. You work in a separate git worktree on branch "${branch}", so edit freely: nobody else's working copy is affected. Make the change, run the relevant tests, and commit your work on this branch with a clear message. Never push. ${BOARD_NOTE} When you are done, reply with a concise markdown report: what you changed (with file paths), test results, anything left to do, and the branch name.`;
const runs = new Map(); // session id -> { child, cwd, role, name, startedAt, endedAt, state, hiredBy, task, branch, worktree }

// A fresh worktree + branch for a fixer, so they never touch anyone's working copy.
function createWorktree(cwd, name, id) {
  let root;
  try { root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); }
  catch { throw new Error(`${cwd} is not a git repository, so a fixer can't get its own branch there. Use a read-only role, or ask the user.`); }
  const slug = String(name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  const branch = `office/${slug}-${id.slice(0, 6)}`;
  const worktree = path.join(WORKTREES_DIR, path.basename(root), `${slug}-${id.slice(0, 6)}`);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  execFileSync('git', ['-C', root, 'worktree', 'add', '-b', branch, worktree, 'HEAD'], { stdio: 'ignore' });
  // run in the same sub-folder the caller was in
  const rel = path.relative(root, cwd);
  return { branch, worktree, cwd: rel && !rel.startsWith('..') ? path.join(worktree, rel) : worktree };
}

async function loadReport(id) {
  try { return JSON.parse(await fsp.readFile(path.join(REPORTS_DIR, `${id}.json`), 'utf8')); } catch { return null; }
}

function startBackgroundRun({ id, cwd, prompt, persona, role, hiredBy = null, todoId = null }) {
  const tools = [...(ROLE_TOOLS[role] || ROLE_TOOLS.custom), ...BOARD_TOOLS];
  if (todoId) prompt += `\n\n(This task is card [${todoId}] on the office board. When you are done, mark it done with todo_update, adding a one-line note.)`;
  let wt = null;
  if (role === 'fixer') { wt = createWorktree(cwd, persona?.name, id); cwd = wt.cwd; }
  const system = [persona?.workStyle, wt ? FIXER_NOTE(wt.branch) : BACKGROUND_NOTE].filter(Boolean).join('\n\n');
  // only the office MCP server (not the user's others): faster start. Hiring tools aren't allowed, so hires can't hire.
  const args = ['-p', prompt, '--allowedTools', ...tools, '--output-format', 'json', '--strict-mcp-config', '--mcp-config', OFFICE_MCP_CONFIG(), '--session-id', id, '--append-system-prompt', system];
  if (persona?.name) args.push('-n', persona.name);
  const child = spawn(process.env.CLAUDE_BIN || 'claude', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { child, cwd, role, name: persona?.name, startedAt: Date.now(), state: 'running', hiredBy, task: prompt, branch: wt?.branch, worktree: wt?.worktree };
  runs.set(id, run);
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const finish = async (ok, result, cost) => {
    run.state = ok ? 'done' : 'failed'; run.endedAt = Date.now(); run.child = null;
    await fsp.mkdir(REPORTS_DIR, { recursive: true });
    const branchNote = wt ? `\n\n---\nBranch \`${wt.branch}\` in \`${wt.worktree}\`. Review with \`git diff HEAD...${wt.branch}\` in the original repo.` : '';
    syncBoardWithRun(id, ok ? 'done' : 'failed');
    await writeJson(path.join(REPORTS_DIR, `${id}.json`), { role, name: persona?.name, ok, result: result + branchNote, cost, startedAt: run.startedAt, endedAt: run.endedAt, hiredBy, task: prompt, branch: wt?.branch, worktree: wt?.worktree });
    try { run.onDone?.(); } catch {}
  };
  child.on('error', e => finish(false, `Could not start claude: ${e.message}`, 0));
  child.on('close', code => {
    if (run.state !== 'running') return;
    let data = null;
    try { data = JSON.parse(out); } catch {}
    if (data) finish(!data.is_error, data.result || '(no report)', data.total_cost_usd || 0);
    else finish(false, `claude exited with code ${code}. ${(err || out).slice(0, 1000)}`, 0);
  });
  return run;
}

// ---------- PRs & MRs: tracking and "all hands" reviews ----------
// Repos come from the folders your sessions run in. GitLab repos are read with `glab`, GitHub
// repos with `gh` (both run inside the repo, so they use its remote and your existing login).
const REVIEWS_FILE = path.join(ROOT, 'data', 'reviews.json');
const sh = (cmd, args, cwd) => new Promise(resolve => execFile(cmd, args, { cwd, timeout: 30e3, maxBuffer: 20 * 1024 * 1024 }, (err, out, errOut) => resolve({ ok: !err, out: String(out || ''), err: String(errOut || err?.message || '') })));
async function discoverRepos() {
  const roots = new Map();
  for (const s of await listSessions()) {
    if (!s.cwd || !fs.existsSync(s.cwd)) continue;
    const top = await sh('git', ['-C', s.cwd, 'rev-parse', '--show-toplevel']);
    if (!top.ok) continue;
    const root = top.out.trim();
    if (roots.has(root)) continue;
    const remote = (await sh('git', ['-C', root, 'remote', 'get-url', 'origin'])).out.trim();
    const m = remote.match(/^(?:https?:\/\/|ssh:\/\/)?(?:[^@]+@)?([^:/]+)[:/](.+?)(?:\.git)?$/);
    if (!m) continue;
    const provider = /github/i.test(m[1]) ? 'github' : /gitlab/i.test(m[1]) ? 'gitlab' : null;
    if (provider) roots.set(root, { root, host: m[1], path: m[2], provider, name: path.basename(root) });
  }
  return [...roots.values()];
}
function normalize(repo, kind, x) {
  if (repo.provider === 'gitlab') {
    return { key: `${repo.path}!${x.iid}`, ref: `!${x.iid}`, repo: repo.path, root: repo.root, provider: 'gitlab', kind, number: x.iid, title: x.title, url: x.web_url, author: x.author?.username, draft: !!x.draft,
      updatedAt: Date.parse(x.updated_at), createdAt: Date.parse(x.created_at), branch: x.source_branch, status: x.detailed_merge_status || '', conflicts: !!x.has_conflicts, comments: x.user_notes_count || 0, reviewers: (x.reviewers || []).map(r => r.username) };
  }
  return { key: `${repo.path}#${x.number}`, ref: `#${x.number}`, repo: repo.path, root: repo.root, provider: 'github', kind, number: x.number, title: x.title, url: x.url, author: x.author?.login, draft: !!x.isDraft,
    updatedAt: Date.parse(x.updatedAt), createdAt: Date.parse(x.createdAt), branch: x.headRefName, status: x.reviewDecision || '', conflicts: x.mergeable === 'CONFLICTING', comments: 0, reviewers: [] };
}
const GH_FIELDS = 'number,title,url,author,isDraft,updatedAt,createdAt,headRefName,reviewDecision,mergeable';
async function listRepoPRs(repo, teamLimit = 15) {
  const q = repo.provider === 'gitlab'
    ? { mine: ['mr', 'list', '--author=@me', '-F', 'json', '--per-page', '50'], review: ['mr', 'list', '--reviewer=@me', '-F', 'json', '--per-page', '50'], team: ['mr', 'list', '-F', 'json', '--per-page', String(teamLimit)] }
    : { mine: ['pr', 'list', '--author', '@me', '--json', GH_FIELDS, '--limit', '50'], review: ['pr', 'list', '--search', 'review-requested:@me', '--json', GH_FIELDS, '--limit', '50'], team: ['pr', 'list', '--json', GH_FIELDS, '--limit', String(teamLimit)] };
  const bin = repo.provider === 'gitlab' ? 'glab' : 'gh';
  const out = { items: [], error: null };
  for (const [kind, args] of Object.entries(q)) {
    const r = await sh(bin, args, repo.root);
    if (!r.ok) { out.error = `${bin} ${args.slice(0, 2).join(' ')}: ${r.err.split('\n')[0].slice(0, 160)}`; continue; }
    try { for (const x of JSON.parse(r.out || '[]')) out.items.push(normalize(repo, kind, x)); } catch { out.error = `could not read ${bin} output`; }
  }
  return out;
}
let prCache = { at: 0, data: null };
async function listPRs(force = false) {
  if (!force && prCache.data && Date.now() - prCache.at < 3 * 60e3) return prCache.data;
  const repos = await discoverRepos();
  const byKey = new Map(), errors = [];
  const results = await Promise.all(repos.map(repo => listRepoPRs(repo).then(r => ({ repo, ...r })))); // repos in parallel
  for (const { repo, items, error } of results) {
    if (error) errors.push({ repo: repo.path, error });
    // one entry per PR; "review" and "mine" win over "team"
    for (const it of items) { const prev = byKey.get(it.key); if (!prev || prev.kind === 'team') byKey.set(it.key, it); }
  }
  const sessions = await listSessions();
  const reviews = await readJson(REVIEWS_FILE, {}).catch(() => ({}));
  const items = [...byKey.values()].map(it => ({
    ...it,
    agentId: sessions.find(s => s.gitBranch && s.gitBranch === it.branch && s.cwd?.startsWith(it.root))?.id || null,
    review: reviews[it.key] || null,
  })).sort((a, b) => b.updatedAt - a.updatedAt);
  prCache = { at: Date.now(), data: { at: Date.now(), repos: repos.map(r => ({ path: r.path, provider: r.provider, name: r.name })), items, errors } };
  return prCache.data;
}

// Reviewers are read-only: they may use your review skill, read the MR/PR and the code, and run
// sub-agents, but they can't comment, approve, check out branches or push.
const REVIEW_SKILL_TOOLS = ['Skill', 'Agent', 'Task', 'Read', 'Grep', 'Glob', 'Bash(ls:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(git branch:*)', 'Bash(git fetch:*)', 'Bash(git blame:*)', 'Bash(git merge-base:*)',
  'Bash(glab mr view:*)', 'Bash(glab mr diff:*)', 'Bash(glab mr list:*)', 'Bash(gh pr view:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr list:*)'];
ROLE_TOOLS.prreview = REVIEW_SKILL_TOOLS;
const REVIEW_SKILLS = ['review-mr-light', 'review-mr'];
const MAX_PARALLEL_REVIEWS = 4;
const reviewQueue = [];
let reviewsRunning = 0;
function pumpReviews() {
  while (reviewsRunning < MAX_PARALLEL_REVIEWS && reviewQueue.length) {
    const job = reviewQueue.shift();
    reviewsRunning++;
    const r = startBackgroundRun(job);
    r.onDone = () => { reviewsRunning--; job.onDone?.(); pumpReviews(); };
  }
}
const updateReview = (key, change) => updateJson(REVIEWS_FILE, {}, all => { all[key] = change(all[key] || {}); return all[key]; });

// one-shot claude call that returns { text, cost } (JSON output gives us the cost)
function claudeOnce(args, cwd = os.tmpdir()) {
  return new Promise(resolve => {
    const child = spawn(process.env.CLAUDE_BIN || 'claude', [...args, '--output-format', 'json'], { cwd, env: FAST_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    child.stdout.on('data', d => { o += d; });
    child.on('error', () => resolve({ text: '', cost: 0 }));
    child.on('close', () => { try { const d = JSON.parse(o); resolve({ text: String(d.result || '').trim(), cost: d.total_cost_usd || 0 }); } catch { resolve({ text: o.trim(), cost: 0 }); } });
  });
}
const kindOf = pr => (pr.provider === 'gitlab' ? 'merge request' : 'pull request');

// The agent who wrote the change answers the reviewers, from a throwaway fork of its own session
// (full memory of the work, and its real conversation is never touched).
async function authorResponds(key, pr, authorId, reports) {
  await updateReview(key, v => ({ ...v, stage: 'author' }));
  const author = (await loadPersonalities())[authorId]?.name || 'the author';
  const prompt = `Reviewers just reviewed your work on ${kindOf(pr)} ${pr.repo}${pr.ref} "${pr.title}" (branch ${pr.branch}). Their reports:\n\n`
    + reports.map((r, i) => `--- Reviewer ${i + 1}: ${r.name} ---\n${r.text.slice(0, 10000)}`).join('\n\n')
    + '\n\nAs the author, respond to the findings in markdown. For each substantive finding say whether it is valid, what you would change, or why you disagree (with evidence from the work you did). End with "**I will fix:**" and "**I disagree with:**" lists. Be concise and honest; do not make changes now.';
  const r = await claudeOnce(['-p', prompt, '--resume', authorId, '--fork-session', '--no-session-persistence', '--tools', '', '--append-system-prompt', `You are ${author}, the engineer who wrote this change, answering a code review in the user's AI office.`]);
  return { name: author, text: r.text, cost: r.cost };
}

async function finishReview(key, pr, ids, authorId) {
  const reports = [];
  let cost = 0;
  for (const id of ids) { const r = await loadReport(id); cost += r?.cost || 0; if (r?.ok) reports.push({ id, name: r.name, text: r.result }); }
  if (!reports.length) return updateReview(key, v => ({ ...v, status: 'failed', stage: 'done', verdict: 'reviews failed', summary: 'None of the reviewers could finish. Open their panels for the errors.', cost, at: Date.now() }));
  let author = null;
  if (authorId) { author = await authorResponds(key, pr, authorId, reports).catch(() => null); cost += author?.cost || 0; }
  await updateReview(key, v => ({ ...v, stage: 'summary' }));
  const prompt = `${reports.length} reviewer${reports.length > 1 ? 's' : ''} independently reviewed ${kindOf(pr)} ${pr.repo}${pr.ref} "${pr.title}".\n\n`
    + reports.map((r, i) => `--- Review ${i + 1} (by ${r.name}) ---\n${r.text.slice(0, 12000)}`).join('\n\n')
    + (author?.text ? `\n\n--- The author (${author.name}) responded ---\n${author.text.slice(0, 8000)}` : '')
    + '\n\nWrite the final review summary in markdown. First line: "**Verdict:** approve / approve with nits / changes requested / needs discussion". Then "**Summary:**" (2-3 sentences on what happened in this review)'
    + (reports.length > 1 ? ', "**Everyone found:**", "**Only some found:**" (say who, and whether it holds up), "**Disagreements:**"' : ', "**Findings:**"')
    + (author?.text ? ', "**Author\'s take:**" (what the author accepts and pushes back on, and who is right)' : '')
    + ', and "**Next steps:**" as a short bullet list. Be concise and concrete, keep file:line references, and do not invent issues nobody raised.';
  const sum = await claudeOnce(['-p', prompt, '--model', process.env.PM_MODEL || 'sonnet', '--no-session-persistence', '--tools', '']);
  cost += sum.cost;
  const verdict = (sum.text.match(/\*\*Verdict:\*\*\s*([^\n]+)/i)?.[1] || 'see summary').trim();
  const review = await updateReview(key, v => ({ ...v, status: 'done', stage: 'done', verdict, summary: sum.text || '(no summary)', author: author ? { id: authorId, name: author.name, text: author.text } : null, reviewers: reports.map(r => ({ id: r.id, name: r.name })), cost, at: Date.now() }));
  if (review.cardId) await boardOp('update', { id: review.cardId, status: 'done', note: `Verdict: ${verdict}` }).catch(() => {});
  return review;
}

const REVIEWER_NAMES = ['Sherlock', 'Marple', 'Poirot', 'Columbo', 'Watson', 'Holmes', 'Lestrade', 'Morse', 'Vera', 'Luther', 'Monk', 'Magnum'];
const REVIEWER_PRESETS = ['detective', 'perfectionist', 'senior', 'oscar', 'angela'];
async function startReviews({ keys = [], skill = 'review-mr-light', reviewers = 2, includeAuthor = true }) {
  if (!REVIEW_SKILLS.includes(skill)) skill = 'review-mr-light';
  const per = Math.max(1, Math.min(5, Number(reviewers) || 2));
  const data = await listPRs();
  const prs = data.items.filter(p => keys.includes(p.key));
  if (!prs.length) throw Object.assign(new Error('No matching PRs/MRs.'), { status: 400 });
  if (prs.length * per > 20) throw Object.assign(new Error(`That is ${prs.length * per} reviews at once. Keep it to 20 or fewer.`), { status: 400 });
  const personalities = await loadPersonalities();
  const used = new Set(Object.values(personalities).map(p => p.name));
  const names = REVIEWER_NAMES.filter(n => !used.has(n));
  let n = 0;
  const started = [];
  for (const pr of prs) {
    const ids = [];
    const authorId = includeAuthor && pr.agentId ? pr.agentId : null;
    for (let k = 0; k < per; k++) {
      const id = randomUUID();
      const base = names.length ? names[n % names.length] : 'Reviewer';
      const name = names.length && n < names.length ? base : `${base} ${n + 1}`;
      n++;
      const persona = { name, preset: REVIEWER_PRESETS[k % REVIEWER_PRESETS.length], role: 'reviewer', hangout: 'lounge', impact: true, auto: false, allHands: true, reviewOf: pr.key };
      persona.workStyle = `You are "${name}", a reviewer in the user's AI office.`;
      await savePersonality(id, persona);
      ids.push(id);
      const prompt = `Use the ${skill} skill to review ${kindOf(pr)} ${pr.url} ("${pr.title}").\n\n`
        + `This is part of an automated "all hands" review in Agent Office${per > 1 ? `, and ${per - 1} other reviewer${per > 2 ? 's are' : ' is'} reviewing the same change independently` : ''}. `
        + 'Report only: never post comments, approve, merge, check out branches or change anything. Your final message is your review report.';
      reviewQueue.push({ id, cwd: pr.root, prompt, persona, role: 'prreview', onDone: () => {
        if (ids.length === per && ids.every(x => runs.get(x) && runs.get(x).state !== 'running')) finishReview(pr.key, pr, ids, authorId).catch(() => {});
      } });
    }
    const card = await boardOp('add', { title: `Review ${pr.repo.split('/').pop()}${pr.ref}: ${pr.title}`.slice(0, 200), project: path.basename(pr.root), status: 'doing', notes: `${pr.url}\nAll-hands review with ${skill} by ${per} reviewer${per > 1 ? 's' : ''}${authorId ? ', with the author responding' : ''}.` }, 'All hands').catch(() => null);
    await updateReview(pr.key, () => ({ status: 'running', stage: 'reviewing', skill, reviewersWanted: per, runs: ids, authorId, startedAt: Date.now(), title: pr.title, url: pr.url, ref: pr.ref, repo: pr.repo, cardId: card?.id || null }));
    started.push({ key: pr.key, runs: ids, authorId });
  }
  pumpReviews();
  prCache.at = 0;
  return { started, reviews: started.length * per };
}

// ---------- the Product Manager: knows what everyone in the office is doing ----------
async function officeBriefing() {
  const personalities = await loadPersonalities();
  const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n)}…` : t; };
  const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
  const lines = [];
  for (const s of await listSessions()) {
    const d = await sessionDetail(s.id);
    if (!d) continue;
    const name = personalities[s.id]?.name || s.id.slice(0, 8);
    const boss = s.hiredBy ? personalities[s.hiredBy]?.name : null;
    lines.push([
      `- ${name} (project ${s.project}, level ${s.level || 1}${boss ? `, hired by ${boss}` : ''}): "${s.title}". Status: ${s.status}${s.activity ? `, doing: ${s.activity}` : ''}${s.waitingFor ? `, waiting for: ${s.waitingFor}` : ''}. Last active ${ago(s.updatedAt)}. Spent $${(s.cost || 0).toFixed(2)}, context ${Math.round((s.context || 0) / (s.contextWindow || 1) * 100)}% full.`,
      d.prompts.length ? `  Last asked: ${clip(d.prompts[d.prompts.length - 1].text, 220)}` : '',
      d.replies.length ? `  Last said: ${clip(d.replies[d.replies.length - 1].text, 320)}` : '',
      d.report ? `  Report: ${clip(d.report.result, 320)}` : '',
    ].filter(Boolean).join('\n'));
  }
  const board = (await loadBoard()).items || [];
  const boardText = ['todo', 'doing', 'done'].map(st => {
    const items = board.filter(i => i.status === st && (st !== 'done' || Date.now() - (i.doneAt || 0) < 3 * 86400e3));
    return `${{ todo: 'To do', doing: 'In progress', done: 'Done (last 3 days)' }[st]}: ${items.length ? items.map(i => `[${i.id}] ${i.title}${i.project ? ` (${i.project})` : ''}`).join('; ') : 'nothing'}`;
  }).join('\n');
  return `Now: ${new Date().toLocaleString()}.\n\nAgents (most recent first):\n${lines.join('\n')}\n\nTODO board:\n${boardText}`;
}
const PM_SYSTEM = (name, traits) => `You are ${name || 'the Product Manager'}, the Product Manager of the user's "Agent Office", where every coworker is an AI coding session (Claude Code). The user is the boss; you work for them. `
  + 'You keep track of what every agent is doing, spot blockers, duplicated work and risks, and help the user decide what to do next. You are given a fresh briefing of the whole office. '
  + 'Be concise, concrete and organised: name agents and projects, lead with what matters, and suggest next steps. If something is not in the briefing, say you do not know rather than guessing.'
  + (traits ? ` Personality: ${traits}.` : '');
async function askPM(question, persona, res) {
  const prompt = `Office briefing:\n\n${await officeBriefing()}\n\nThe boss asks: ${question}`;
  streamClaude(['-p', prompt, '--model', process.env.PM_MODEL || 'sonnet', '--no-session-persistence', '--tools', '', '--append-system-prompt', PM_SYSTEM(persona?.name, persona?.traits), ...STREAM_ARGS], res, { cwd: os.tmpdir(), timeoutMs: 3 * 60e3, fast: true });
}
async function pmPlan(persona) {
  const prompt = `Office briefing:\n\n${await officeBriefing()}\n\nPlan the boss's day. Reply with ONLY a JSON object, no code fences: {"summary": "2-3 sentences on the state of the office and the focus for today", "items": [up to 6 of {"title": "short, actionable TODO", "project": "project folder name or empty", "notes": "one or two sentences of detail", "why": "why it matters now"}]}. Prefer unblocking agents, finishing work in progress and following up on reports over starting new things. Do not repeat items already on the board.`;
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN || 'claude', ['-p', prompt, '--model', process.env.PM_MODEL || 'sonnet', '--no-session-persistence', '--tools', '', '--append-system-prompt', PM_SYSTEM(persona?.name, persona?.traits), '--output-format', 'text'], { cwd: os.tmpdir(), env: FAST_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    child.stdout.on('data', d => { o += d; }); child.stderr.on('data', d => { e += d; });
    child.on('error', reject);
    child.on('close', () => (o.includes('{') ? resolve(o) : reject(new Error((e || o).slice(0, 300) || 'no answer'))));
  });
  return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
}

// ---------- Ask conversations (saved, archivable, deleted with the agent) ----------
// chats: { [agentId]: { current: [{ who, text, at }], archived: [{ at, messages }] } }
const emptyChat = () => ({ current: [], archived: [] });
async function loadChat(id) { const all = await readJson(CHATS_FILE, {}).catch(() => ({})); return all[id] || emptyChat(); }
function chatOp(id, body) {
  return updateJson(CHATS_FILE, {}, all => {
    const c = all[id] ||= emptyChat();
    if (body.op === 'append') c.current.push(...(body.messages || []).map(m => ({ who: m.who === 'me' ? 'me' : 'them', text: String(m.text || '').slice(0, 20000), at: m.at || Date.now() })));
    else if (body.op === 'clear') c.current = [];
    else if (body.op === 'archive') { if (c.current.length) c.archived.unshift({ at: Date.now(), messages: c.current }); c.current = []; }
    else if (body.op === 'deleteArchived') c.archived.splice(Number(body.index), 1);
    else if (body.op === 'deleteAll') { delete all[id]; return emptyChat(); }
    c.archived = c.archived.slice(0, 50);
    return c;
  });
}

// Delete an agent from the office: everything the office stored about them, and optionally their
// Claude Code transcript, which is moved to the Trash (recoverable) rather than deleted.
async function deleteAgent(id, { trashTranscript = false } = {}) {
  if ((await liveSessions()).has(id) || runs.get(id)?.state === 'running') throw Object.assign(new Error('That agent is still running. End the session first.'), { status: 409 });
  await chatOp(id, { op: 'deleteAll' });
  await savePersonality(id, { reset: true });
  await fsp.rm(path.join(REPORTS_DIR, `${id}.json`), { force: true });
  await updateJson(BOARD_FILE, { items: [] }, b => { for (const i of b.items || []) if (i.sessionId === id) i.sessionId = null; return b; });
  runs.delete(id);
  let trashed = null;
  if (trashTranscript) {
    const file = (await allTranscripts()).find(f => path.basename(f, '.jsonl') === id);
    if (file) {
      const trash = process.platform === 'darwin' ? path.join(os.homedir(), '.Trash') : path.join(os.homedir(), '.local', 'share', 'Trash', 'files');
      await fsp.mkdir(trash, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      trashed = [];
      for (const src of [file, file.replace(/\.jsonl$/, '')]) {
        if (!fs.existsSync(src)) continue;
        const dest = path.join(trash, `agent-office-${path.basename(src)}-${stamp}`);
        await fsp.rename(src, dest).catch(async () => { await fsp.cp(src, dest, { recursive: true }); await fsp.rm(src, { recursive: true, force: true }); });
        trashed.push(dest);
      }
      cache.delete(file);
    }
  }
  if (!trashed) await setHidden(id, true); // keep it out of the office even though the transcript stays
  return { ok: true, trashed };
}

// ---------- brainstorm: office agents think about one idea together ----------
// Round 1: every participant proposes ideas in their own voice (personality + what they work on).
// Round 2 (optional): everyone reacts to the others' ideas. Then the PM synthesizes.
// "deep" participants answer from a throwaway fork of their own session (full memory).
const BRAINSTORMS_FILE = path.join(ROOT, 'data', 'brainstorms.json');
const brainstorms = new Map(); // id -> live state (also saved to disk when finished)
const clipText = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
async function participantBrief(id) {
  const p = (await loadPersonalities())[id] || {};
  const d = await sessionDetail(id);
  return {
    id, name: p.name || id.slice(0, 8), traits: p.traits || '', cwd: d?.cwd, deepOk: !!d && !d.empty,
    context: d ? [`You work on the project "${path.basename(d.cwd || '')}". Your current task: "${d.title || 'unknown'}".`,
      d.prompts?.length ? `The user recently asked you: ${clipText(d.prompts[d.prompts.length - 1].text, 300)}` : '',
      d.replies?.length ? `You recently said: ${clipText(d.replies[d.replies.length - 1].text, 400)}` : ''].filter(Boolean).join(' ') : '',
  };
}
function askParticipant(part, prompt, deep) {
  const system = `You are ${part.name}, a coworker in the user's AI office, taking part in a brainstorm.${part.traits ? ` Your personality: ${part.traits}. Speak in character, but keep the ideas genuinely useful.` : ''} ${part.context}`;
  const args = deep && part.deepOk
    ? ['-p', prompt, '--resume', part.id, '--fork-session', '--no-session-persistence', '--tools', '', '--append-system-prompt', system]
    : ['-p', prompt, '--model', process.env.BRAINSTORM_MODEL || 'sonnet', '--no-session-persistence', '--tools', '', '--append-system-prompt', system];
  return claudeOnce(args, deep && part.deepOk ? part.cwd || os.tmpdir() : os.tmpdir());
}
async function saveBrainstorm(b) {
  await updateJson(BRAINSTORMS_FILE, {}, all => {
    all[b.id] = b;
    for (const k of Object.keys(all).sort((x, y) => all[y].startedAt - all[x].startedAt).slice(30)) delete all[k];
    return all;
  });
}
async function runBrainstorm(b, parts, { reactions, deep }) {
  const set = (patch) => Object.assign(b, patch);
  try {
    // round 1: ideas, all in parallel
    await Promise.all(parts.map(async part => {
      const r = await askParticipant(part, `Brainstorm topic from the boss: "${b.topic}"\n\nPropose 3 distinct ideas. For each: a bold short title on its own line (**Title**), then 1-2 sentences on what it is and why it helps. Draw on your own project and experience where relevant. No preamble.`, deep);
      b.ideas[part.id] = r.text || '(no ideas)'; b.cost += r.cost;
    }));
    if (reactions && parts.length > 1) {
      set({ stage: 'reactions' });
      const all = parts.map(p => `--- ${p.name} ---\n${clipText(b.ideas[p.id], 1500)}`).join('\n\n');
      await Promise.all(parts.map(async part => {
        const r = await askParticipant(part, `Brainstorm topic: "${b.topic}"\n\nHere are everyone's ideas:\n\n${all}\n\nReact briefly in your own voice: "**Building on:**" the one or two ideas from others you like most (say whose, and how you'd improve them), and "**Concern:**" one risk or weakness you see. Max 120 words.`, deep);
        b.reactions[part.id] = r.text || ''; b.cost += r.cost;
      }));
    }
    set({ stage: 'summary' });
    const pm = (await loadPersonalities()).pm || {};
    const transcript = parts.map(p => `### ${p.name}\nIdeas:\n${clipText(b.ideas[p.id], 2000)}${b.reactions[p.id] ? `\nReaction:\n${clipText(b.reactions[p.id], 800)}` : ''}`).join('\n\n');
    const r = await claudeOnce(['-p', `You facilitated a brainstorm in the office. Topic from the boss: "${b.topic}"\n\n${transcript}\n\n`
      + 'Write the outcome in markdown: "**In short:**" (2 sentences), "**Top ideas:**" (a numbered list of the 3-5 best ideas, each with its title, who suggested it, and why it stands out), "**Themes:**", "**Open questions:**", and "**Next steps:**" (a short bullet list of concrete actions). Credit people by name. Be concise.',
    '--model', process.env.PM_MODEL || 'sonnet', '--no-session-persistence', '--tools', '', '--append-system-prompt', PM_SYSTEM(pm.name || 'Morgan', pm.traits)]);
    b.cost += r.cost;
    set({ stage: 'done', status: 'done', summary: r.text || '(no summary)', at: Date.now(), facilitator: pm.name || 'Morgan' });
  } catch (e) {
    set({ stage: 'done', status: 'failed', summary: `The brainstorm failed: ${e.message}`, at: Date.now() });
  }
  await saveBrainstorm(b).catch(() => {});
}
async function startBrainstorm({ topic, participants = [], reactions = true, deep = false }) {
  topic = String(topic || '').trim().slice(0, 1000);
  if (!topic) throw Object.assign(new Error('What should everyone brainstorm about?'), { status: 400 });
  const ids = [...new Set(participants)].filter(id => id !== 'pm').slice(0, 8);
  if (!ids.length) throw Object.assign(new Error('Pick at least one participant.'), { status: 400 });
  const parts = await Promise.all(ids.map(participantBrief));
  const b = { id: randomUUID().slice(0, 8), topic, status: 'running', stage: 'ideas', startedAt: Date.now(), participants: parts.map(p => ({ id: p.id, name: p.name })), ideas: {}, reactions: {}, summary: '', cost: 0, reactionsRound: !!reactions, deep: !!deep };
  brainstorms.set(b.id, b);
  runBrainstorm(b, parts, { reactions, deep });
  return b;
}
async function getBrainstorm(id) { return brainstorms.get(id) || (await readJson(BRAINSTORMS_FILE, {}).catch(() => ({})))[id] || null; }
async function listBrainstorms() {
  const saved = await readJson(BRAINSTORMS_FILE, {}).catch(() => ({}));
  for (const b of brainstorms.values()) saved[b.id] = b;
  return Object.values(saved).sort((a, b) => b.startedAt - a.startedAt).slice(0, 20).map(({ id, topic, status, stage, startedAt, participants }) => ({ id, topic, status, stage, startedAt, participants }));
}

// ---------- TODO board ----------
// items: { id, title, notes, project, status: todo|doing|done, sessionId, by, createdAt, updatedAt, doneAt }
const BOARD_STATUSES = ['todo', 'doing', 'done'];
const loadBoard = () => readJson(BOARD_FILE, { items: [] }).catch(() => ({ items: [] }));
function boardOp(op, body, by = 'you') {
  return updateJson(BOARD_FILE, { items: [] }, board => {
    board.items ||= [];
    const now = Date.now();
    const find = id => board.items.find(i => i.id === id);
    const clean = v => String(v ?? '').slice(0, 4000);
    if (op === 'add') {
      const title = clean(body.title).trim().slice(0, 200);
      if (!title) throw Object.assign(new Error('A TODO needs a title.'), { status: 400 });
      const status = BOARD_STATUSES.includes(body.status) ? body.status : 'todo';
      const item = { id: randomUUID().slice(0, 8), title, notes: clean(body.notes), project: clean(body.project).slice(0, 80), status, sessionId: body.sessionId || null, by, createdAt: now, updatedAt: now, doneAt: status === 'done' ? now : null };
      board.items.push(item);
      return item;
    }
    const item = find(body.id);
    if (!item) throw Object.assign(new Error('No TODO with that id.'), { status: 404 });
    if (op === 'delete') { board.items = board.items.filter(i => i !== item); return { ok: true }; }
    // update / move
    for (const k of ['title', 'notes', 'project']) if (body[k] !== undefined) item[k] = clean(body[k]);
    if (body.sessionId !== undefined) item.sessionId = body.sessionId;
    if (body.status && BOARD_STATUSES.includes(body.status) && body.status !== item.status) {
      item.status = body.status;
      item.doneAt = body.status === 'done' ? now : null;
    }
    if (body.note) item.notes = `${item.notes ? `${item.notes}\n\n` : ''}${clean(body.note)}`;
    item.updatedAt = now;
    return item;
  });
}
// a background run linked to board items moves them along
function syncBoardWithRun(sessionId, state) {
  return updateJson(BOARD_FILE, { items: [] }, board => {
    for (const item of board.items || []) {
      if (item.sessionId !== sessionId) continue;
      if (state === 'running' && item.status === 'todo') { item.status = 'doing'; item.updatedAt = Date.now(); }
      if (state === 'done' && item.status !== 'done') { item.status = 'done'; item.doneAt = item.updatedAt = Date.now(); }
      if (state === 'failed') { item.status = 'todo'; item.updatedAt = Date.now(); item.notes = `${item.notes ? `${item.notes}\n\n` : ''}⚠️ The agent working on this failed; see their report.`; }
    }
    return board;
  }).catch(() => {});
}

// ---------- agents hiring agents (called by the agent-office MCP server, see mcp.mjs) ----------
const loadSettings = async () => {
  const s = await readJson(SETTINGS_FILE, {}).catch(() => ({}));
  return { ...DEFAULT_SETTINGS, ...s, hiring: { ...DEFAULT_SETTINGS.hiring, ...(s.hiring || {}) } };
};
// Which session is calling? The MCP server sends its ancestor pids; one of them is a claude process.
async function callerSession(pids = []) {
  const ids = new Set(pids.map(Number));
  for (const [id, l] of await liveSessions()) if (ids.has(l.pid)) return id;
  for (const [id, r] of runs) if (r.child && ids.has(r.child.pid)) return id;
  return null;
}
const HIRE_NAMES = ['Nova', 'Pixel', 'Byte', 'Echo', 'Juno', 'Orion', 'Kai', 'Zoe', 'Remy', 'Ivy', 'Milo', 'Luna', 'Otto', 'Sage', 'Theo', 'Wren'];
const ROLE_PRESET = { fixer: 'intern', reviewer: 'detective', qa: 'perfectionist', bughunter: 'detective', security: 'smith', docs: 'bard' };
async function agentApi(route, body) {
  const settings = await loadSettings();
  const caller = await callerSession(body.pids);
  if (!caller) throw Object.assign(new Error('Agent Office could not tell which session you are. Only sessions running on this machine can hire.'), { status: 403 });
  const me = (await listSessions()).find(s => s.id === caller);
  const liveMe = (await liveSessions()).get(caller);
  const myName = (await loadPersonalities())[caller]?.name || me?.title || liveMe?.name || (liveMe?.cwd && path.basename(liveMe.cwd)) || 'An agent';
  if (route === 'overview') return { text: await officeBriefing() };
  if (route === 'todo') {
    const { op = 'list' } = body;
    if (op === 'list') {
      const board = await loadBoard();
      const items = board.items.filter(i => body.status ? i.status === body.status : i.status !== 'done' || Date.now() - (i.doneAt || 0) < 7 * 86400e3);
      return { items: items.map(({ id, title, status, project, notes, by }) => ({ id, title, status, project, by, notes: notes.slice(0, 300) })) };
    }
    if (op === 'add') return { item: await boardOp('add', { ...body, project: body.project || me?.project, sessionId: body.assign_to_me ? caller : null }, myName) };
    if (op === 'update') return { item: await boardOp('update', { id: body.id, status: body.status, note: body.note ? `${myName}: ${body.note}` : undefined }, myName) };
    throw Object.assign(new Error(`Unknown todo operation ${op}`), { status: 400 });
  }
  if (route === 'hires' || route === 'report') {
    const mine = [];
    for (const [id, r] of runs) if (r.hiredBy === caller) mine.push({ id, name: r.name, role: r.role, state: r.state, branch: r.branch, task: r.task });
    if (route === 'hires') return { hires: mine };
    const hire = mine.find(h => h.id === body.id);
    if (!hire) throw Object.assign(new Error('No hire of yours with that id.'), { status: 404 });
    const rep = await loadReport(hire.id);
    return { ...hire, report: rep?.result || null };
  }
  // route === 'hire'
  if (!settings.hiring.enabled) throw Object.assign(new Error('Hiring is switched off in Agent Office (Dashboard → Settings).'), { status: 403 });
  const isPM = (await loadPersonalities())[caller]?.role === 'pm';
  if (!isPM && (!me || (me.level || 1) < settings.hiring.minLevel)) {
    throw Object.assign(new Error(`${myName} is level ${me?.level || 1}. Only agents at level ${settings.hiring.minLevel} or higher can hire coworkers. Keep working to level up!`), { status: 403 });
  }
  const active = [...runs.values()].filter(r => r.hiredBy === caller && r.state === 'running').length;
  if (active >= settings.hiring.maxActive) throw Object.assign(new Error(`You already have ${active} hires working (the limit is ${settings.hiring.maxActive}). Wait for one to finish.`), { status: 429 });
  const task = String(body.task || '').trim();
  if (!task) throw Object.assign(new Error('A hire needs a task.'), { status: 400 });
  const role = ROLE_TOOLS[body.role] ? body.role : 'fixer';
  const cwd = body.project_path || me.cwd;
  if (!cwd || !fs.existsSync(cwd)) throw Object.assign(new Error(`Project folder not found: ${cwd}`), { status: 400 });
  const personalities = await loadPersonalities();
  const used = new Set(Object.values(personalities).map(p => p.name));
  const name = String(body.name || '').trim().slice(0, 24) || HIRE_NAMES.find(n => !used.has(n)) || `Hire ${runs.size + 1}`;
  const id = randomUUID();
  const persona = { name, preset: ROLE_PRESET[role], role, hangout: 'kitchen', impact: true, hiredBy: caller, hiredByName: myName };
  persona.workStyle = `You are "${name}", hired by ${myName} in the user's AI office.`;
  await savePersonality(id, persona);
  const run = startBackgroundRun({ id, cwd, prompt: `Task from ${myName} (a senior coworker):\n\n${task}`, persona, role, hiredBy: caller });
  return { id, name, role, branch: run.branch, worktree: run.worktree };
}

// ---------- first-run setup check (for the onboarding checklist) ----------
async function setupStatus() {
  const [transcripts, live, cli, board] = await Promise.all([
    allTranscripts(), liveSessions(),
    claudeCli(['--version']).then(r => (r.ok ? r.out.trim().split('\n')[0] : null)),
    loadBoard(), mcpStatus(), // refreshes mcpConnected
  ]);
  const personalities = await loadPersonalities();
  return {
    claudeDir: CLAUDE_DIR, claudeDirFound: fs.existsSync(PROJECTS_DIR),
    transcripts: transcripts.length, live: live.size, claudeCli: cli,
    terminal: TERMINAL, platform: process.platform, mcpConnected,
    customPersonalities: Object.values(personalities).filter(p => !p.auto).length,
    boardCards: (board.items || []).length, maxDays: MAX_DAYS,
  };
}

// ---------- registering the MCP server with Claude Code ----------
function claudeCli(args) {
  return new Promise(resolve => execFile(process.env.CLAUDE_BIN || 'claude', args, { timeout: 30e3 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}` })));
}
const MCP_NAME = 'agent-office';
let mcpConnected = false; // cached; refreshed at startup and whenever the status is checked
// Extra system prompt for sessions started from the office: their work style, plus the board if the tools are connected.
const officePrompt = ws => { const t = [ws, mcpConnected ? BOARD_NOTE : ''].filter(Boolean).join(' '); return t ? ` --append-system-prompt ${shq(t)}` : ''; };
async function mcpStatus() {
  const r = await claudeCli(['mcp', 'get', MCP_NAME]);
  mcpConnected = r.ok;
  return { installed: r.ok, command: `claude mcp add --scope user ${MCP_NAME} -e OFFICE_URL=http://127.0.0.1:${PORT} -- ${process.execPath} ${path.join(ROOT, 'mcp.mjs')}` };
}
async function mcpInstall(install) {
  if (!install) return claudeCli(['mcp', 'remove', MCP_NAME, '--scope', 'user']);
  await claudeCli(['mcp', 'remove', MCP_NAME, '--scope', 'user']);
  return claudeCli(['mcp', 'add', '--scope', 'user', MCP_NAME, '-e', `OFFICE_URL=http://127.0.0.1:${PORT}`, '--', process.execPath, path.join(ROOT, 'mcp.mjs')]);
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
      hiredBy: runs.get(id)?.hiredBy || personalities[id]?.hiredBy || null,
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

// ---------- safe JSON storage ----------
// All writes to a file go through one queue (no interleaved read-modify-write), are atomic
// (temp file + rename), and keep a .bak of the last good version. An unreadable file is never
// treated as empty: we fall back to the backup, and refuse to write rather than lose data.
const queues = new Map();
function exclusive(file, fn) {
  const next = (queues.get(file) || Promise.resolve()).then(fn, fn);
  queues.set(file, next.catch(() => {}));
  return next;
}
async function readJson(file, fallback) {
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(await fsp.readFile(`${file}.bak`, 'utf8')); } catch {}
  throw new Error(`${path.basename(file)} is unreadable; not touching it (a copy is in ${path.basename(file)}.bak if one exists)`);
}
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try { JSON.parse(await fsp.readFile(file, 'utf8')); await fsp.copyFile(file, `${file}.bak`); } catch {}
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}
const updateJson = (file, fallback, change) => exclusive(file, async () => {
  const data = await readJson(file, fallback);
  const result = change(data);
  await writeJson(file, data);
  return result;
});

// ---------- session control ----------
async function loadHidden() {
  try { return await readJson(HIDDEN_FILE, []); } catch { return []; }
}
function setHidden(id, hide) {
  return updateJson(HIDDEN_FILE, [], h => {
    const next = hide ? [...new Set([...h, id])] : id ? h.filter(x => x !== id) : [];
    h.splice(0, h.length, ...next);
    return h;
  });
}

const shq = v => `'${String(v).replace(/'/g, `'\\''`)}'`;
const asq = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// Opens a new terminal window running `command`: iTerm or Terminal.app on macOS, a Linux terminal elsewhere.
function openTerminal(command) {
  if (process.platform !== 'darwin') {
    // keep the window open after claude exits, so you can read what happened
    const shell = ['bash', '-lc', `${command}; exec bash`];
    const argv = {
      'gnome-terminal': ['--', ...shell], kitty: shell, konsole: ['-e', ...shell], alacritty: ['-e', ...shell],
      wezterm: ['start', '--', ...shell], 'xfce4-terminal': ['-x', ...shell], xterm: ['-e', ...shell],
    }[TERMINAL] || ['-e', ...shell];
    return new Promise((resolve, reject) => {
      const child = spawn(TERMINAL, argv, { detached: true, stdio: 'ignore' });
      child.on('error', e => reject(new Error(`could not start ${TERMINAL}: ${e.message}. Set OFFICE_TERMINAL to your terminal.`)));
      child.on('spawn', () => { child.unref(); resolve(); });
    });
  }
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
  return readJson(PERSONALITIES_FILE, {});
}
// { reset: true } forgets the personality, { replace: {...} } overwrites it (used by packs / undo)
function applyPersonality(all, id, p) {
  if (p.reset) delete all[id];
  else if (p.replace) all[id] = p.replace;
  else all[id] = { ...all[id], ...p };
  return all[id] || {};
}
function savePersonality(id, p) {
  return updateJson(PERSONALITIES_FILE, {}, all => applyPersonality(all, id, p));
}
// many at once in a single write: { id: change, ... }
function savePersonalities(changes) {
  return updateJson(PERSONALITIES_FILE, {}, all => Object.fromEntries(Object.entries(changes).map(([id, p]) => [id, applyPersonality(all, id, p)])));
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
    : ['-p', prompt, '--model', process.env.ASK_MODEL || 'haiku', '--effort', 'low', ...ISOLATED_ARGS, '--append-system-prompt', system, ...stream];
  streamClaude(args, res, {
    cwd: deep ? detail.cwd || os.homedir() : os.tmpdir(),
    timeoutMs: (deep ? 5 : 2) * 60e3,
    timeoutNote: deep ? 'This session is large, so try Quick mode.' : '',
    fast: !deep,
  });
}

// Runs `claude -p ... --output-format stream-json --include-partial-messages` and streams the
// answer's text to an HTTP response as plain text. stdin must be closed or claude waits on it.
// Quick jobs (summaries, briefings) skip extended thinking: it only adds latency here
// (first words in ~1s instead of 20-45s).
const FAST_ENV = { ...process.env, MAX_THINKING_TOKENS: '0' };
// Helper calls need none of the user's MCP servers (claude.ai connectors, plugins) or hooks:
// skipping them saves startup work and keeps status hooks from firing for background jobs.
const ISOLATED_ARGS = ['--no-session-persistence', '--tools', '', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}'];

// One quick call, whole answer as text ('' if it fails or times out).
function claudeText(args, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.env.CLAUDE_BIN || 'claude', [...args, '--output-format', 'text'], { cwd: os.tmpdir(), env: FAST_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', code => { clearTimeout(timer); resolve(code ? '' : out.trim()); });
  });
}

// suffix: a promise of text written after the streamed answer, before the response ends
function streamClaude(args, res, { cwd, timeoutMs, timeoutNote = '', prefix = '', suffix = null, fast = false }) {
  const child = spawn(process.env.CLAUDE_BIN || 'claude', args, { cwd, env: fast ? FAST_ENV : process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  if (prefix) res.write(prefix);
  let wrote = false, buf = '', err = '';
  const timer = setTimeout(() => { child.kill(); res.end(`${wrote ? '\n\n' : ''}⏱️ No answer after ${Math.round(timeoutMs / 60e3)} minutes, so I gave up. ${timeoutNote}`); }, timeoutMs);
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
  child.on('close', async code => {
    clearTimeout(timer);
    if (res.writableEnded) return;
    if (code && !wrote) return res.end(`⚠️ claude exited with code ${code}. ${err.slice(0, 500)}`);
    const tail = suffix ? await suffix : '';
    if (!res.writableEnded) res.end(tail);
  });
  res.on('close', () => { clearTimeout(timer); if (child.exitCode === null) child.kill(); });
}

// ---------- standup: yesterday / today / blockers across recent sessions ----------
const STREAM_ARGS = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
async function standup(names, res) {
  // "That day" = since local midnight. If nobody has worked yet today (an early standup),
  // fall back to the last 24 hours.
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const workedSince = (d, from) => d.turns.reduce((ms, [a, b]) => (b > from ? ms + (b - Math.max(a, from)) : ms), 0);
  const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n)}…` : t; };
  const fmt = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };

  const all = [];
  for (const s of await listSessions()) {
    const d = await sessionDetail(s.id);
    if (d) all.push({ s, d });
  }
  let from = midnight.getTime(), window = 'today';
  let worked = all.filter(({ d }) => workedSince(d, from) > 0);
  if (!worked.length) { from = Date.now() - 24 * 3600e3; window = 'in the last 24 hours'; worked = all.filter(({ d }) => workedSince(d, from) > 0); }
  if (!worked.length) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Nobody worked today or in the last 24 hours, so there is nothing to report. ☕');
  }
  worked.sort((a, b) => workedSince(b.d, from) - workedSince(a.d, from));
  const totalMs = worked.reduce((t, { d }) => t + workedSince(d, from), 0);
  const projects = [...new Set(worked.map(({ s }) => s.project))];

  const briefs = worked.slice(0, 16).map(({ s, d }) => {
    const recentPrompts = d.prompts.filter(p => Date.parse(p.at) >= from - 12 * 3600e3).slice(-4);
    return [
      `### ${names?.[s.id] || s.id.slice(0, 8)} (project: ${s.project})`,
      `Session: ${s.title}. Worked ${fmt(workedSince(d, from))} ${window}. Status now: ${s.status}${s.activity ? ` (${s.activity})` : ''}${s.waitingFor ? `, waiting for: ${s.waitingFor}` : ''}.`,
      recentPrompts.length ? `Asked recently: ${recentPrompts.map(p => clip(p.text, 220)).join(' | ')}` : '',
      d.replies.length ? `Latest replies: ${d.replies.slice(-2).map(r => clip(r.text, 500)).join(' | ')}` : '',
      d.report ? `Report handed in: ${clip(d.report.result, 600)}` : '',
    ].filter(Boolean).join('\n');
  });
  // exact numbers come from us, not the model
  const board = (await loadBoard()).items || [];
  const doneToday = board.filter(i => i.status === 'done' && i.doneAt >= from).length;
  const boardLine = board.length ? `📋 Board: ${doneToday} done ${window}, ${board.filter(i => i.status === 'doing').length} in progress, ${board.filter(i => i.status === 'todo').length} to do.\n` : '';
  const header = `## 📅 ${window === 'today' ? `Today, ${new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}` : 'Last 24 hours'}\n` +
    `**${worked.length} agent${worked.length > 1 ? 's' : ''} worked ${fmt(totalMs)}** across ${projects.length} project${projects.length > 1 ? 's' : ''} (${projects.join(', ')}).\n${boardLine}\n`;
  // The time goes into output tokens (~75/s on Haiku), so one call writing every section takes
  // 10s+. Instead the summary streams while the per-agent blocks are written in parallel, 2 agents
  // per call, and appended when the summary is done: wall time is the slowest call, not the sum.
  const model = ['--model', process.env.STANDUP_MODEL || process.env.ASK_MODEL || 'haiku', '--effort', 'low', ...ISOLATED_ARGS];
  const intro = `You are running the daily standup of an office where every coworker is an AI coding session. These coworkers worked ${window}:\n\n`;
  const rules = 'Be concrete, one line each, no filler. Do not invent work that is not in the notes.';
  const chunks = [];
  for (let i = 0; i < briefs.length; i += 2) chunks.push(briefs.slice(i, i + 2));
  const whoDidWhat = Promise.all(chunks.map(c => claudeText(['-p', `${intro}${c.join('\n\n')}\n\n` +
    'For each coworker, in the order given, write one short markdown block: **Name** (project), then "Yesterday:", "Today:" and "Blockers:" lines ' +
    '(write "none" if there are none; things waiting for the user, failing tests or open questions count as blockers). Output only the blocks, no heading. ' + rules, ...model], 2 * 60e3)))
    .then(parts => `\n\n## Who did what\n\n${parts.map((p, i) => p || chunks[i].map(b => `${b.split('\n')[0].replace(/^### /, '**').replace(' (project:', '** (')}\nCould not get notes.`).join('\n\n')).join('\n\n')}`);
  const prompt = `${intro}${briefs.join('\n\n')}\n\n` +
    'Write the start of the standup in markdown, in exactly this order:\n' +
    '1. "## Summary of the day": 2 to 4 sentences on what happened overall: the main things that got done or moved forward, recurring themes across projects, and the overall state. No per-agent lists here.\n' +
    '2. "## Needs your attention": the most important blockers across the office (at most 5 bullets), or "Nothing, great work."\n' +
    `Stop after these two sections: the per-agent notes are written separately. Do not repeat the date or totals heading. ${rules}`;
  streamClaude(['-p', prompt, ...model, ...STREAM_ARGS], res, { cwd: os.tmpdir(), timeoutMs: 3 * 60e3, prefix: header, suffix: whoDidWhat, fast: true });
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
    const child = spawn(process.env.CLAUDE_BIN || 'claude', ['-p', prompt, '--model', 'haiku', ...ISOLATED_ARGS, '--output-format', 'text'], { cwd: os.tmpdir(), env: FAST_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (url.pathname === '/api/personalities') return json(res, 200, demoSavePersonalities(await readBody(req)));
  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/personality\/([\w-]+)$/))) return json(res, 200, null);
  if ((m = url.pathname.match(/^\/api\/personality\/([\w-]+)$/))) return json(res, 200, demoSavePersonality(m[1], await readBody(req)));
  if (url.pathname.startsWith('/api/ask/') && url.pathname !== '/api/ask/pm') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    for (const word of DEMO_REPLY.split(' ')) { res.write(`${word} `); await new Promise(r => setTimeout(r, 40)); }
    return res.end();
  }
  if (url.pathname === '/api/quirks') return json(res, 200, DEMO_QUIRKS);
  if (url.pathname === '/api/settings') return json(res, 200, DEFAULT_SETTINGS);
  if (url.pathname === '/api/ask/pm') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    for (const word of DEMO_PM.split(' ')) { res.write(`${word} `); await new Promise(r => setTimeout(r, 20)); }
    return res.end();
  }
  if (url.pathname === '/api/pm/plan') return json(res, 200, DEMO_PLAN);
  if (url.pathname === '/api/prs') return json(res, 200, demoPRs());
  if (url.pathname === '/api/allhands') return json(res, 200, demoStartReviews(await readBody(req)));
  if (url.pathname === '/api/reviews') return json(res, 200, demoReviews());
  if (url.pathname === '/api/brainstorm') return json(res, 200, demoStartBrainstorm(await readBody(req)));
  if (url.pathname === '/api/brainstorms') return json(res, 200, demoBrainstormList());
  if ((m = url.pathname.match(/^\/api\/brainstorm\/([\w-]+)$/))) return json(res, 200, demoBrainstorm(m[1]));
  if ((m = url.pathname.match(/^\/api\/chat\/([\w-]+)$/))) return json(res, 200, req.method === 'POST' ? demoChatOp(m[1], await readBody(req)) : demoChat(m[1]));
  if (url.pathname === '/api/board') return json(res, 200, req.method === 'POST' ? demoBoardOp(await readBody(req)) : { items: demoBoard() });
  if (url.pathname === '/api/mcp') return json(res, 200, { installed: false, demo: true, command: 'claude mcp add --scope user agent-office -- node /path/to/agent-office/mcp.mjs' });
  if (url.pathname === '/api/timeline') return json(res, 200, demoTimeline(Number(url.searchParams.get('hours')) || 24));
  if (url.pathname === '/api/standup') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    for (const word of DEMO_STANDUP.split(' ')) { res.write(`${word} `); await new Promise(r => setTimeout(r, 15)); }
    return res.end();
  }
  if (url.pathname === '/api/projects') return json(res, 200, ['/home/dev/code/pixel-shop', '/home/dev/code/api-gateway', '/home/dev/code/docs-site']);
  if (url.pathname === '/api/hidden') return json(res, 200, []);
  if (url.pathname === '/api/setup') return json(res, 200, { demo: true, claudeDirFound: true, transcripts: 14, live: 10, claudeCli: 'demo', terminal: 'iTerm', mcpConnected: false, customPersonalities: 0, boardCards: 7, maxDays: 14 });
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

// Only our own page (and the local MCP server) may use the API. Browsers attach an Origin to
// cross-site requests, and a custom header can't be sent cross-site without a CORS preflight
// (which we never allow), so other websites can't drive the office. The Host check stops
// DNS-rebinding tricks.
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
function allowed(req, url) {
  if (!url.pathname.startsWith('/api/')) return true;
  if (!LOCAL_HOSTS.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && !LOCAL_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-agent-office'] !== '1') return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let m;
  if (!allowed(req, url)) return json(res, 403, { error: 'Requests to Agent Office must come from its own page.' });
  try {
    if (DEMO && url.pathname.startsWith('/api/') && url.pathname !== '/api/config') return demoRoute(url, req, res);
    if (url.pathname === '/api/sessions') return json(res, 200, await listSessions());
    if ((m = url.pathname.match(/^\/api\/session\/([\w-]+)$/))) {
      const d = await sessionDetail(m[1]);
      return d ? json(res, 200, d) : json(res, 404, { error: 'not found' });
    }
    if (url.pathname === '/api/personalities' && req.method === 'POST') return json(res, 200, await savePersonalities(await readBody(req)));
    if ((m = url.pathname.match(/^\/api\/personality\/([\w-]+)$/)) && req.method === 'GET') return json(res, 200, (await loadPersonalities())[m[1]] || null);
    if ((m = url.pathname.match(/^\/api\/personality\/([\w-]+)$/)) && req.method === 'POST') {
      return json(res, 200, await savePersonality(m[1], await readBody(req)));
    }
    if (url.pathname === '/api/ask/pm' && req.method === 'POST') {
      const { question, persona } = await readBody(req);
      return askPM(String(question || 'Give me a quick status of the office.'), persona, res);
    }
    if (url.pathname === '/api/pm/plan' && req.method === 'POST') {
      try { return json(res, 200, await pmPlan((await readBody(req)).persona)); } catch (e) { return json(res, 500, { error: `The PM could not make a plan: ${e.message}` }); }
    }
    if (url.pathname === '/api/pm/session' && req.method === 'POST') {
      // a real Claude session as the PM, which can use the agent-office tools to manage the office
      const { persona } = await readBody(req);
      const system = `${PM_SYSTEM(persona?.name, persona?.traits)} In this session you can manage the office with the agent-office tools (office_overview, todo_list, todo_add, todo_update, hire_agent, get_report) if they are connected. Start by calling office_overview.`;
      const sid = randomUUID(), name = `${persona?.name || 'PM'} (session)`;
      await savePersonality(sid, { ...(persona || {}), name, role: 'pm', preset: 'pm', auto: false });
      await openTerminal(`cd ${shq(os.homedir())} && claude --session-id ${sid} -n ${shq(name)} --append-system-prompt ${shq(system)} ${shq('Give me a quick status of the office, then ask what I want to focus on.')}`);
      return json(res, 200, { ok: true });
    }
    if ((m = url.pathname.match(/^\/api\/ask\/([\w-]+)$/)) && req.method === 'POST') {
      const d = await sessionDetail(m[1]);
      if (!d) return json(res, 404, { error: 'This session no longer exists.' });
      if (d.empty) return json(res, 409, { error: "They haven't started talking yet. Ask again after their first reply." });
      const { question, mode, persona } = await readBody(req);
      return askAgent(d, String(question || 'What are you working on and what do you think of it?'), mode, persona, res);
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/agent\/(hire|hires|report|todo|overview)$/))) {
      try { return json(res, 200, await agentApi(m[1], await readBody(req))); }
      catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if ((m = url.pathname.match(/^\/api\/chat\/([\w-]+)$/))) {
      if (req.method !== 'POST') return json(res, 200, await loadChat(m[1]));
      return json(res, 200, await chatOp(m[1], await readBody(req)));
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/delete\/([\w-]+)$/))) {
      try { return json(res, 200, await deleteAgent(m[1], await readBody(req))); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (url.pathname === '/api/brainstorm' && req.method === 'POST') {
      try { return json(res, 200, await startBrainstorm(await readBody(req))); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (url.pathname === '/api/brainstorms') return json(res, 200, await listBrainstorms());
    if ((m = url.pathname.match(/^\/api\/brainstorm\/([\w-]+)$/))) { const b = await getBrainstorm(m[1]); return b ? json(res, 200, b) : json(res, 404, { error: 'not found' }); }
    if (url.pathname === '/api/prs') return json(res, 200, await listPRs(url.searchParams.has('refresh')));
    if (url.pathname === '/api/reviews') return json(res, 200, await readJson(REVIEWS_FILE, {}).catch(() => ({})));
    if (req.method === 'POST' && url.pathname === '/api/allhands') {
      try { return json(res, 200, await startReviews(await readBody(req))); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (url.pathname === '/api/board') {
      if (req.method !== 'POST') return json(res, 200, await loadBoard());
      const b = await readBody(req);
      try { return json(res, 200, await boardOp(b.op, b)); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (url.pathname === '/api/settings') {
      if (req.method === 'POST') { const b = await readBody(req); return json(res, 200, await updateJson(SETTINGS_FILE, {}, s => { if (b.hiring) s.hiring = { ...(s.hiring || {}), ...b.hiring }; return s; }).then(loadSettings)); }
      return json(res, 200, await loadSettings());
    }
    if (url.pathname === '/api/mcp') {
      if (req.method === 'POST') { const r = await mcpInstall((await readBody(req)).install !== false); return json(res, r.ok ? 200 : 500, { ...(await mcpStatus()), output: r.out.slice(0, 500) }); }
      return json(res, 200, await mcpStatus());
    }
    if (req.method === 'POST' && url.pathname === '/api/handoff') {
      // hand a report or reply to another agent: continue their session, or start a new one in their project
      const { targetId, prompt, mode, todoId } = await readBody(req);
      const linkTodo = sid => (todoId ? boardOp('update', { id: todoId, sessionId: sid, status: 'doing' }).catch(() => {}) : null);
      const d = await sessionDetail(targetId);
      if (!d) return json(res, 404, { error: 'That agent no longer exists.' });
      if (!prompt) return json(res, 400, { error: 'The handoff needs a task.' });
      const p = d.personality || {};
      const ws = officePrompt(p.impact !== false ? p.workStyle : '');
      if (mode === 'resume') {
        if (d.status !== 'offline') return json(res, 409, { error: `${p.name || 'They'} already have a session open. Choose "new session", or paste the task into their terminal.` });
        await openTerminal(`cd ${shq(d.cwd || os.homedir())} && claude --resume ${d.id}${ws} ${shq(prompt)}`);
        await linkTodo(d.id);
        return json(res, 200, { id: d.id });
      }
      const id = randomUUID();
      const persona = { ...p, name: p.name ? `${p.name} II` : undefined, auto: false, pack: undefined, before: undefined };
      await savePersonality(id, persona);
      await openTerminal(`cd ${shq(d.cwd || os.homedir())} && claude --session-id ${id}${persona.name ? ` -n ${shq(persona.name)}` : ''}${ws} ${shq(prompt)}`);
      await linkTodo(id);
      return json(res, 200, { id });
    }
    if (req.method === 'POST' && url.pathname === '/api/standup') return standup((await readBody(req)).names, res);
    if (req.method === 'POST' && url.pathname === '/api/quirks') {
      const { name, traits } = await readBody(req);
      return json(res, 200, await generateQuirks(name, traits));
    }
    if (url.pathname === '/api/timeline') {
      // turns and actions of every listed session inside the window (default: last 24h)
      const hours = Math.min(168, Number(url.searchParams.get('hours')) || 24);
      const from = Date.now() - hours * 3600e3;
      const out = [];
      for (const ls of await listSessions()) {
        const f = (await allTranscripts()).find(x => path.basename(x, '.jsonl') === ls.id);
        if (!f) continue;
        const t = await parseTranscript(f);
        const turns = t.turns.filter(([a, b]) => b >= from);
        if (!turns.length) continue;
        out.push({ id: ls.id, turns, events: t.events.filter(([at]) => at >= from) });
      }
      return json(res, 200, { from, to: Date.now(), sessions: out });
    }
    if (url.pathname === '/api/hidden') return json(res, 200, await loadHidden());
    if (url.pathname === '/api/setup') return json(res, 200, await setupStatus());
    if (url.pathname === '/api/projects') return json(res, 200, await knownProjects());
    if (url.pathname === '/api/config') return json(res, 200, { terminal: TERMINAL, maxDays: MAX_DAYS, maxRooms: MAX_ROOMS, achievements: ACHIEVEMENTS.map(({ test, ...a }) => a), ranks: RANKS });
    if (req.method === 'POST' && url.pathname === '/api/new') {
      const { cwd, prompt, persona, role, background, todoId } = await readBody(req);
      if (!cwd || !fs.existsSync(cwd)) return json(res, 400, { error: 'project folder not found' });
      const id = randomUUID();
      if (persona) await savePersonality(id, { ...persona, role: role || null });
      if (background) {
        if (!prompt) return json(res, 400, { error: 'a background agent needs a task' });
        startBackgroundRun({ id, cwd, prompt, persona, role, todoId });
        if (todoId) await boardOp('update', { id: todoId, sessionId: id, status: 'doing' }).catch(() => {});
        return json(res, 200, { id, background: true });
      }
      const name = persona?.name ? ` -n ${shq(persona.name)}` : '';
      const style = officePrompt(persona?.workStyle);
      await openTerminal(`cd ${shq(cwd)} && claude --session-id ${id}${name}${style}${prompt ? ` ${shq(prompt)}` : ''}`);
      if (todoId) await boardOp('update', { id: todoId, sessionId: id, status: 'doing' }).catch(() => {});
      return json(res, 200, { id });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/open\/([\w-]+)$/))) {
      const d = await sessionDetail(m[1]);
      if (!d) return json(res, 404, { error: 'not found' });
      const ws = d.personality?.impact !== false ? d.personality?.workStyle : '';
      await openTerminal(`cd ${shq(d.cwd || os.homedir())} && claude --resume ${d.id}${officePrompt(ws)}`);
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

mcpStatus().catch(() => {});
server.listen(PORT, '127.0.0.1', () => console.log(`Agent Office${DEMO ? ' (demo mode)' : ''} open at http://localhost:${PORT}`));
