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
