// Demo mode: a made-up office so the app can be shown (screenshots, GIFs, talks)
// without exposing any real session data. Start with `npm run demo`.
const PROJECTS = ['pixel-shop', 'api-gateway', 'docs-site', 'ml-pipeline', 'mobile-app'];

const AGENTS = [
  { project: 'pixel-shop', title: 'Checkout flow redesign', status: 'busy', files: ['src/checkout/Cart.tsx', 'src/checkout/Payment.tsx'], helpers: 2 },
  { project: 'pixel-shop', title: 'Fix flaky cart tests', status: 'waiting', waitingFor: 'approve npm test' },
  { project: 'pixel-shop', title: 'Dark mode for storefront', status: 'offline' },
  { project: 'api-gateway', title: 'Rate limiting middleware', status: 'busy', files: ['middleware/rate_limit.go', 'middleware/rate_limit_test.go'] },
  { project: 'api-gateway', title: 'Run the full test suite', status: 'your turn', role: 'qa', preset: 'perfectionist', run: 'done',
    report: '**3 of 412 tests fail**, all in the rate limiter.\n\n1. 🔴 `middleware/rate_limit.go:88`: the token bucket refills with wall-clock time, so `TestBurst` fails when the CI box is slow. Inject a clock.\n2. 🟠 `middleware/rate_limit_test.go:41`: shared global limiter between tests; runs are order-dependent.\n3. 🟡 `handlers/health.go`: no tests at all, and it is the load balancer\'s liveness probe.\n\n**Next steps:** fix (1) and (2) first (about 20 lines), then add a health check test.' },
  { project: 'api-gateway', title: 'Upgrade to Go 1.24', status: 'idle' },
  { project: 'api-gateway', title: 'Investigate p99 latency', status: 'offline' },
  { project: 'docs-site', title: 'Write getting-started guide', status: 'busy', files: ['docs/getting-started.md', 'docs/install.md'] },
  { project: 'docs-site', title: 'Review open PRs', status: 'busy', role: 'reviewer', preset: 'detective', run: 'running', files: ['docs/api/auth.md', 'docs/sidebar.js'] },
  { project: 'ml-pipeline', title: 'Feature store backfill', status: 'busy', files: ['pipeline/backfill.py', 'pipeline/schema.py'], helpers: 1 },
  { project: 'ml-pipeline', title: 'Notebook to package refactor', status: 'offline' },
  { project: 'ml-pipeline', title: 'Model eval dashboard', status: 'idle' },
  { project: 'mobile-app', title: 'Push notification opt-in', status: 'offline' },
  { project: 'mobile-app', title: 'Offline sync bug', status: 'idle' },
];

const TOOLS = f => [`Editing ${f[0]}`, `Reading ${f[1]}`, '$ Run the test suite', `Searching "TODO"`, `Editing ${f[1]}`, 'Talking', '$ Lint changed files'];
const HELPER_JOBS = ['Review payment edge cases', 'Audit accessibility', 'Profile slow queries'];

function hash(str) { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
const id = i => `demo-${String(i).padStart(4, '0')}-${(hash(`agent${i}`) % 0xffff).toString(16).padStart(4, '0')}-0000-000000000000`;

const xpForLevel = L => 50 * L * (L - 1);
const RANKS = [[1, 'Intern'], [3, 'Junior Dev'], [6, 'Engineer'], [10, 'Senior Engineer'], [15, 'Staff Engineer'], [21, 'Principal'], [28, 'Distinguished'], [36, 'Legend']];
const BADGE_POOL = ['shipper', 'marathon', 'testpilot', 'detective', 'teamplayer', 'wordsmith', 'nightowl', 'surfer', 'janitor'];
const started = Date.now();
const personalities = {}; // demo personalities live in memory only

function base(a, i) {
  const h = hash(a.title);
  const xp = i % 4 === 0 ? 1200 + (h % 3000) : 60 + (h % 900); // a few seniors with private offices
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  const window = 1_000_000;
  const context = a.status === 'busy' && i === 3 ? 870_000 : 40_000 + (h % 520_000);
  return {
    id: id(i), cwd: `/home/dev/code/${a.project}`, project: a.project, title: a.title,
    gitBranch: `feat/${a.title.toLowerCase().replace(/[^a-z]+/g, '-').slice(0, 24)}`,
    xp, level, rank: RANKS.filter(([l]) => level >= l).pop()[1], levelXp: xpForLevel(level), nextXp: xpForLevel(level + 1),
    workMs: (20 + (h % 400)) * 60000, context, contextWindow: window,
    badges: BADGE_POOL.filter((_, k) => (h >> k) % 3 === 0).slice(0, 1 + (h % 4)),
    cost: ((h % 3000) / 100), prs: h % 3, linesAdded: h % 900, linesRemoved: h % 300, toolCount: 60 + (h % 400),
  };
}

export function demoSessions() {
  const tick = Math.floor((Date.now() - started) / 4000);
  return AGENTS.map((a, i) => {
    const b = base(a, i);
    const live = a.status !== 'offline';
    const status = a.status === 'your turn' ? 'idle' : a.status;
    const helpers = live && a.helpers
      ? Array.from({ length: a.helpers }, (_, k) => ({ id: `${b.id}-h${k}`, description: HELPER_JOBS[(i + k) % HELPER_JOBS.length], type: 'general-purpose', activity: k ? '$ Run the test suite' : `Reading ${a.files?.[k] || 'README.md'}` }))
      : [];
    return {
      ...b, helpers, lastPrompt: a.title, updatedAt: Date.now() - i * 3600e3,
      status, live, waitingFor: a.waitingFor,
      statusSince: a.status === 'your turn' ? Date.now() - 20e3 : Date.now() - 3600e3,
      activity: status === 'busy' ? TOOLS(a.files)[(tick + i) % 7] : null,
      personality: personalities[b.id] || (a.role ? { role: a.role, preset: a.preset } : null),
      background: !!a.run, runState: a.run || null, hasReport: !!a.report,
    };
  });
}

export function demoDetail(sid, achievements) {
  const i = AGENTS.findIndex((_, k) => id(k) === sid);
  if (i < 0) return null;
  const a = AGENTS[i], b = base(a, i), s = demoSessions()[i];
  const t = mins => new Date(Date.now() - mins * 60000).toISOString();
  return {
    ...b, ...s, achievements, messageCount: 40 + (hash(a.title) % 200), promptCount: 8 + (hash(a.title) % 30), toolCount: 60 + (hash(a.title) % 400),
    linesAdded: hash(a.title) % 900, linesRemoved: hash(a.title) % 300, model: 'claude-opus-5-5',
    prs: [], files: (a.files || ['README.md']).map((f, k) => ({ path: `${b.cwd}/${f}`, edits: 7 - k * 3 })),
    tools: [{ name: 'Edit', n: 42 }, { name: 'Read', n: 38 }, { name: 'Bash', n: 21 }, { name: 'Grep', n: 12 }],
    replies: [
      { at: t(2), text: `Progress on "${a.title}": the main change is in, and I'm running the tests now. Two edge cases left to handle.` },
      { at: t(9), text: 'Found the root cause. It was an off-by-one in the pagination helper. Writing a regression test first.' },
    ],
    report: a.report ? { role: a.role, ok: true, result: a.report, cost: 0.84, startedAt: Date.now() - 9 * 60000, endedAt: Date.now() - 2 * 60000 } : null,
    prompts: [
      { at: t(12), text: `Let's work on: ${a.title.toLowerCase()}. Keep the diff small and add tests.` },
      { at: t(30), text: 'Can you look at how this is done elsewhere in the repo first?' },
    ],
  };
}

export function demoSavePersonality(sid, p) {
  if (p.reset) delete personalities[sid];
  else if (p.replace) personalities[sid] = p.replace;
  else personalities[sid] = { ...personalities[sid], ...p };
  return personalities[sid] || {};
}

export const DEMO_REPLY = "Honestly? It's going well. The tricky part was the edge cases around empty carts, and those are covered by tests now. I'd like one more pass on error messages before we ship. Want me to open the PR after that?";
export const DEMO_QUIRKS = { emoji: '🎸', work: ['Rock on!', 'Shredding this bug', 'Encore!', 'Turn it up'], idle: ['Air guitar break', 'Soundcheck', 'Tour snacks'], verbs: { Editing: 'Riffing on', Reading: 'Tuning', Searching: 'Jamming for', Running: 'Playing' } };

export function demoSavePersonalities(changes) {
  return Object.fromEntries(Object.entries(changes).map(([id, p]) => [id, demoSavePersonality(id, p)]));
}

export const DEMO_STANDUP = `## 📅 Today
**4 agents worked 6h 40m** across 4 projects (api-gateway, docs-site, pixel-shop, ml-pipeline).

## Summary of the day
Testing was the theme: the QA run in api-gateway surfaced three rate-limiter failures, and the flaky cart tests in pixel-shop were traced to a shared fixture. The docs review is nearly done, and the ml-pipeline backfill got its first two weeks of data in. Two things are waiting on you before the day can wrap up.

## Needs your attention
- Approve Ada's npm test run (pixel-shop).
- Reply to Frances' QA report (api-gateway).

## Who did what
**Frances** (api-gateway)
Yesterday: ran the full test suite and wrote up 3 failures in the rate limiter.
Today: waiting for a go-ahead to fix the clock injection.
Blockers: needs your reply on the report.

**Radia** (docs-site)
Yesterday: started reviewing the two open docs PRs.
Today: finishing the review of the auth guide.
Blockers: none.

**Ada** (pixel-shop)
Yesterday: tracked down the flaky cart tests.
Today: re-running the suite with the fix.
Blockers: waiting for permission to run npm test.

**Dennis** (ml-pipeline)
Yesterday: designed the feature store backfill.
Today: backfilling the first two weeks of data.
Blockers: none.`;

// A made-up day of work for the timeline replay: a few work sessions per agent over the last 12h.
export function demoTimeline(hours = 24) {
  const now = Date.now(), from = now - hours * 3600e3;
  const sessions = demoSessions().map((s, i) => {
    const h = hash(s.title);
    const turns = [], events = [];
    let t = now - (10 + (h % 3)) * 3600e3;
    for (let k = 0; k < 4 + (h % 4); k++) {
      const start = t + ((h >> k) % 60) * 60e3, len = (8 + ((h >> (k + 2)) % 40)) * 60e3;
      if (start > now) break;
      const end = Math.min(now, start + len);
      turns.push([start, end]);
      const labels = s.activity ? [s.activity, 'Talking', 'Reading README.md', '$ Run the test suite'] : ['Reading README.md', 'Talking', 'Editing src/index.ts'];
      for (let e = start; e < end; e += 3 * 60e3) events.push([e, labels[(e / 60e3 + i) % labels.length | 0]]);
      t = end + (20 + ((h >> (k + 4)) % 70)) * 60e3;
    }
    if (s.status === 'busy') turns.push([now - 15 * 60e3, now]);
    return { id: s.id, turns, events };
  }).filter(s => s.turns.length);
  return { from, to: now, sessions };
}

// A sample TODO board for demo mode (kept in memory)
let board = null;
export function demoBoard() {
  if (board) return board;
  const ids = demoSessions().map(s => s.id), t = m => Date.now() - m * 60000;
  board = [
    { id: 'd1', title: 'Fix the rate limiter clock injection', notes: 'From the QA report: TestBurst fails on slow CI.', project: 'api-gateway', status: 'todo', sessionId: null, by: 'Frances', createdAt: t(40), updatedAt: t(40), doneAt: null },
    { id: 'd2', title: 'Add a health check test', notes: '', project: 'api-gateway', status: 'todo', sessionId: null, by: 'you', createdAt: t(35), updatedAt: t(35), doneAt: null },
    { id: 'd3', title: 'Dark mode for the storefront', notes: 'Waiting on design tokens.', project: 'pixel-shop', status: 'todo', sessionId: null, by: 'you', createdAt: t(300), updatedAt: t(300), doneAt: null },
    { id: 'd4', title: 'Review the open docs PRs', notes: '', project: 'docs-site', status: 'doing', sessionId: ids[7], by: 'you', createdAt: t(90), updatedAt: t(20), doneAt: null },
    { id: 'd5', title: 'Backfill the feature store', notes: '', project: 'ml-pipeline', status: 'doing', sessionId: ids[9], by: 'you', createdAt: t(200), updatedAt: t(60), doneAt: null },
    { id: 'd6', title: 'Run the full test suite', notes: '3 failures, see the report.', project: 'api-gateway', status: 'done', sessionId: ids[4], by: 'you', createdAt: t(180), updatedAt: t(30), doneAt: t(30) },
    { id: 'd7', title: 'Track down the flaky cart tests', notes: '', project: 'pixel-shop', status: 'done', sessionId: ids[1], by: 'you', createdAt: t(400), updatedAt: t(120), doneAt: t(120) },
  ];
  return board;
}
export function demoBoardOp(b) {
  const items = demoBoard(), now = Date.now();
  if (b.op === 'add') { const it = { id: `d${now}`, title: String(b.title || 'Untitled'), notes: b.notes || '', project: b.project || '', status: b.status || 'todo', sessionId: b.sessionId || null, by: 'you', createdAt: now, updatedAt: now, doneAt: b.status === 'done' ? now : null }; items.push(it); return it; }
  const it = items.find(i => i.id === b.id);
  if (!it) return { error: 'not found' };
  if (b.op === 'delete') { board = items.filter(i => i !== it); return { ok: true }; }
  for (const k of ['title', 'notes', 'project', 'sessionId']) if (b[k] !== undefined) it[k] = b[k];
  if (b.status && b.status !== it.status) { it.status = b.status; it.doneAt = b.status === 'done' ? now : null; }
  it.updatedAt = now;
  return it;
}

export const DEMO_PM = `**Quick status:** 5 agents are working, and 2 are waiting on you.

- **Blocked:** Ada (pixel-shop) needs permission to run \`npm test\`, and Frances (api-gateway) finished the QA run and is waiting for your go-ahead on the fixes.
- **Moving well:** Dennis is backfilling the feature store, and Linus is updating the getting-started guide.
- **Risk:** the rate limiter bug from Frances' report will keep CI flaky until it's fixed.

**Suggested next step:** approve Ada's test run, then hand Frances' report to a Fixer.`;
export const DEMO_PLAN = {
  summary: 'The office is busy but two agents are blocked on you. Unblock them first, then turn the QA findings into fixes so CI stops flaking.',
  items: [
    { title: "Approve Ada's npm test run", project: 'pixel-shop', notes: 'She is waiting on a permission prompt.', why: 'It unblocks the flaky cart test fix.' },
    { title: 'Hand the rate limiter findings to a Fixer', project: 'api-gateway', notes: 'Use the QA report from Frances as the task.', why: 'The failing tests make CI unreliable for everyone.' },
    { title: 'Review the docs PRs once Radia is done', project: 'docs-site', notes: '', why: 'They have been open for two days.' },
  ],
};

// Ask conversations in demo mode (kept in memory)
const chats = {};
export const demoChat = id => chats[id] || { current: [], archived: [] };
export function demoChatOp(id, b) {
  const c = chats[id] ||= { current: [], archived: [] };
  if (b.op === 'append') c.current.push(...(b.messages || []));
  if (b.op === 'clear') c.current = [];
  if (b.op === 'archive' && c.current.length) { c.archived.unshift({ at: Date.now(), messages: c.current }); c.current = []; }
  if (b.op === 'deleteArchived') c.archived.splice(Number(b.index), 1);
  if (b.op === 'deleteAll') delete chats[id];
  return chats[id] || { current: [], archived: [] };
}

// PRs & MRs in demo mode
export function demoPRs() {
  const ids = demoSessions().map(s => s.id), now = Date.now(), h = n => now - n * 3600e3;
  const mk = (repo, provider, n, title, kind, extra = {}) => ({ key: `${repo}${provider === 'gitlab' ? '!' : '#'}${n}`, ref: `${provider === 'gitlab' ? '!' : '#'}${n}`, repo, root: `/home/dev/code/${repo.split('/').pop()}`, provider, kind, number: n, title,
    url: `https://${provider}.com/${repo}/-/merge_requests/${n}`, author: kind === 'mine' ? 'you' : 'teammate', draft: false, updatedAt: h(n % 30), createdAt: h(n % 30 + 20), branch: `feat/${n}`, status: 'mergeable', conflicts: false, comments: n % 7, reviewers: [], agentId: null, review: null, ...extra });
  const withReviews = data => { data.items.forEach(i => { if (demoReviewState[i.key]) i.review = demoReviewState[i.key]; }); return data; };
  return withReviews({
    at: now, errors: [],
    repos: [{ path: 'acme/api-gateway', provider: 'gitlab', name: 'api-gateway' }, { path: 'acme/pixel-shop', provider: 'github', name: 'pixel-shop' }],
    items: [
      mk('acme/api-gateway', 'gitlab', 412, 'Rate limiting middleware', 'mine', { agentId: ids[3], status: 'ci_must_pass' }),
      mk('acme/pixel-shop', 'github', 88, 'Checkout flow redesign', 'mine', { agentId: ids[0], review: { status: 'done', verdict: 'approve with nits', crossCheck: true, summary: '**Verdict:** approve with nits\n\n**Both found:** the discount is applied twice when a coupon and a gift card are combined (`Cart.tsx:141`).\n\n**Only one found:** Sherlock flagged a missing loading state on the pay button; it holds up.\n\n**Next steps:** fix the double discount, add a test for coupon + gift card.' } }),
      mk('acme/api-gateway', 'gitlab', 405, 'OpenAPI spec cleanup', 'review', { author: 'teammate' }),
      mk('acme/pixel-shop', 'github', 91, 'Dark mode tokens', 'team', { draft: true }),
      mk('acme/api-gateway', 'gitlab', 399, 'Upgrade to Go 1.24', 'team', { conflicts: true, status: 'conflict' }),
      mk('acme/pixel-shop', 'github', 90, 'Fix flaky cart tests', 'team'),
    ],
  });
}

// All-hands reviews in demo mode: they "finish" a few seconds after starting
const demoReviewState = {};
export function demoStartReviews({ keys = [], reviewers = 2 }) {
  const per = Math.max(1, Math.min(5, Number(reviewers) || 2));
  for (const key of keys) demoReviewState[key] = { status: 'running', stage: 'reviewing', reviewersWanted: per, startedAt: Date.now(), doneAt: Date.now() + 9000, key };
  return { started: keys.map(key => ({ key, runs: [] })), reviews: keys.length * per, demo: true };
}
export function demoReviews() {
  const names = ['Sherlock', 'Marple', 'Poirot', 'Columbo', 'Watson'];
  for (const [key, r] of Object.entries(demoReviewState)) {
    if (r.status !== 'running') continue;
    if (Date.now() > r.doneAt - 4000) r.stage = 'author';
    if (Date.now() > r.doneAt) Object.assign(r, {
      status: 'done', stage: 'done', verdict: 'changes requested', cost: 1.12 * r.reviewersWanted, at: Date.now(),
      reviewers: names.slice(0, r.reviewersWanted).map(name => ({ id: null, name })),
      author: { id: null, name: 'Margaret', text: '**Valid:** the token bucket does refill with wall-clock time; I will inject a clock.\n\n**I disagree with:** moving the limiter into Redis now. It is out of scope for this MR.\n\n**I will fix:** clock injection, and the shared limiter between tests.' },
      summary: '**Verdict:** changes requested\n\n**Summary:** All reviewers found the same flaky-time bug, and the author agrees to fix it. One reviewer wants Redis-backed limits, which the author pushes back on as out of scope.\n\n**Everyone found:** `middleware/rate_limit.go:88` refills with wall-clock time, so tests fail on slow CI.\n\n**Only some found:** Marple noticed the limiter is shared between tests; it holds up.\n\n**Disagreements:** Redis now or later. The author is right that it belongs in a follow-up.\n\n**Author\'s take:** accepts the clock and test-isolation fixes; defers Redis.\n\n**Next steps:**\n- Inject a clock into the token bucket\n- Give each test its own limiter\n- Open a follow-up for Redis-backed limits',
      title: 'Rate limiting middleware', url: 'https://gitlab.com/acme/api-gateway/-/merge_requests/412', ref: '!412', repo: 'acme/api-gateway',
    });
  }
  return demoReviewState;
}

// Brainstorms in demo mode: ideas arrive one by one, then a summary
const demoStorms = {};
const DEMO_IDEAS = [
  '**Cache dependencies between CI runs**\nMost of our 11-minute pipeline is npm install. A shared cache would cut it roughly in half.\n\n**Run only affected tests**\nUse the dependency graph to skip test suites that a change cannot touch.\n\n**Split the e2e suite**\nShard it across 4 runners.',
  '**Kill the flaky tests first**\nEvery flaky retry costs minutes. Quarantine the top 5 offenders.\n\n**Nightly full run**\nKeep PR runs lean and run everything once a night.\n\n**Faster Docker base image**\nWe rebuild the same layers on every run.',
  '**Measure before we optimise**\nAdd timing per step so we know where the minutes go.\n\n**Parallel lint and typecheck**\nThey run one after the other today for no reason.\n\n**Smaller PRs**\nBig PRs trigger the whole matrix.',
];
export function demoStartBrainstorm({ topic, participants = [], reactions = true, names = {} }) {
  const ids = participants.filter(x => x !== 'pm').slice(0, 8);
  const all = demoSessions();
  const b = { id: `demo${Date.now()}`, topic: topic || 'How can we make CI faster?', status: 'running', stage: 'ideas', startedAt: Date.now(), participants: ids.map(id => ({ id, name: names[id] || all.find(s => s.id === id)?.personality?.name || 'Agent' })), ideas: {}, reactions: {}, summary: '', cost: 0, reactionsRound: reactions };
  demoStorms[b.id] = b;
  return b;
}
export function demoBrainstorm(id) {
  const b = demoStorms[id];
  if (!b || b.status !== 'running') return b || null;
  const t = (Date.now() - b.startedAt) / 1000;
  b.participants.forEach((p, i) => { if (t > 1.5 + i * 1.2) b.ideas[p.id] = DEMO_IDEAS[i % DEMO_IDEAS.length]; });
  if (t > 1.5 + b.participants.length * 1.2) { b.stage = b.reactionsRound ? 'reactions' : 'summary'; }
  if (b.reactionsRound && t > 3 + b.participants.length * 1.2) b.participants.forEach(p => { b.reactions[p.id] = '**Building on:** the caching idea. Pair it with timing per step so we can prove the win.\n**Concern:** skipping tests could hide real regressions.'; });
  if (t > 5 + b.participants.length * 1.5) Object.assign(b, { stage: 'done', status: 'done', facilitator: 'Morgan', cost: 0.18 * b.participants.length, at: Date.now(),
    summary: '**In short:** everyone agrees that dependency installs and flaky retries eat most of the pipeline. Measure first, then cache and shard.\n\n**Top ideas:**\n1. **Cache dependencies between runs**: the biggest, cheapest win.\n2. **Quarantine flaky tests**: every retry costs minutes and trust.\n3. **Measure each step**: so we optimise the right thing.\n4. **Shard the e2e suite** across 4 runners.\n\n**Themes:** measure first, remove waste, then parallelise.\n\n**Open questions:** how much can we skip safely with affected-tests-only?\n\n**Next steps:**\n- Add per-step timing to CI\n- Enable the dependency cache\n- Quarantine the top 5 flaky tests' });
  return b;
}
export const demoBrainstormList = () => Object.values(demoStorms).map(({ id, topic, status, stage, startedAt, participants }) => ({ id, topic, status, stage, startedAt, participants }));
