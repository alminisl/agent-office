// Live demo for GitHub Pages: there is no Node server there, so this answers the app's /api/*
// requests in the browser with the same made-up office that `npm run demo` serves.
// Loaded before app.js by the Pages build (.github/workflows/pages.yml).
import {
  demoSessions, demoDetail, demoSavePersonality, demoSavePersonalities, demoTimeline, demoBoard, demoBoardOp,
  demoChat, demoChatOp, DEMO_REPLY, DEMO_QUIRKS, DEMO_STANDUP, DEMO_PM, DEMO_PLAN,
} from './demo.mjs';

const ACHIEVEMENTS = [
  ['shipper', '🚀', 'Shipper', 'Open a pull request'], ['marathon', '🏃', 'Marathon', '2h of hands-on work'],
  ['nightowl', '🦉', 'Night Owl', 'Work between midnight and 5am'], ['testpilot', '🧪', 'Test Pilot', 'Run the tests 5 times'],
  ['janitor', '🧹', 'Janitor', 'Delete more than you add (50+ lines)'], ['wordsmith', '✍️', 'Wordsmith', 'Add 500 lines'],
  ['detective', '🔍', 'Detective', 'Read or search 100 times'], ['teamplayer', '🤝', 'Team Player', 'Delegate to 3 helpers'],
  ['surfer', '🌐', 'Surfer', 'Browse the web 5 times'], ['highroller', '💸', 'High Roller', 'Spend $20'],
  ['bigbrain', '🧠', 'Big Brain', 'Fill 75% of the context window'], ['chatterbox', '💬', 'Chatterbox', '50 prompts in one session'],
].map(([id, icon, name, hint]) => ({ id, icon, name, hint }));
const RANKS = [[1, 'Intern'], [3, 'Junior Dev'], [6, 'Engineer'], [10, 'Senior Engineer'], [15, 'Staff Engineer'], [21, 'Principal'], [28, 'Distinguished'], [36, 'Legend']];
const personalities = {};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stream = (text, ms) => new Response(new ReadableStream({
  async start(c) {
    const enc = new TextEncoder();
    for (const word of text.split(' ')) { c.enqueue(enc.encode(`${word} `)); await new Promise(r => setTimeout(r, ms)); }
    c.close();
  },
}), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
const NOT_HERE = { error: 'This is the live demo on GitHub Pages. Install Agent Office locally to open terminals and run real agents.' };

async function route(url, init = {}) {
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : {};
  const p = url.pathname.replace(/^.*\/api\//, '/api/');
  let m;
  if (p === '/api/config') return json({ terminal: 'your terminal', maxDays: 14, maxRooms: 20, achievements: ACHIEVEMENTS, ranks: RANKS, demo: true });
  if (p === '/api/sessions') return json(demoSessions().map(s => ({ ...s, personality: personalities[s.id] || s.personality })));
  if ((m = p.match(/^\/api\/session\/([\w-]+)$/))) { const d = demoDetail(m[1], ACHIEVEMENTS); return d ? json({ ...d, personality: personalities[d.id] || d.personality }) : json({ error: 'not found' }, 404); }
  if (p === '/api/personalities') { const r = demoSavePersonalities(body); Object.assign(personalities, r); return json(r); }
  if ((m = p.match(/^\/api\/personality\/([\w-]+)$/))) {
    if (method === 'GET') return json(personalities[m[1]] || null);
    const r = demoSavePersonality(m[1], body); personalities[m[1]] = r; return json(r);
  }
  if (p === '/api/ask/pm') return stream(DEMO_PM, 20);
  if (p.startsWith('/api/ask/')) return stream(DEMO_REPLY, 35);
  if (p === '/api/pm/plan') { await new Promise(r => setTimeout(r, 900)); return json(DEMO_PLAN); }
  if (p === '/api/standup') return stream(DEMO_STANDUP, 15);
  if (p === '/api/quirks') { await new Promise(r => setTimeout(r, 900)); return json(DEMO_QUIRKS); }
  if (p === '/api/timeline') return json(demoTimeline(Number(url.searchParams.get('hours')) || 24));
  if (p === '/api/board') return json(method === 'POST' ? demoBoardOp(body) : { items: demoBoard() });
  if ((m = p.match(/^\/api\/chat\/([\w-]+)$/))) return json(method === 'POST' ? demoChatOp(m[1], body) : demoChat(m[1]));
  if (p === '/api/settings') return json({ hiring: { enabled: true, minLevel: 5, maxActive: 3 } });
  if (p === '/api/mcp') return json({ installed: false, demo: true, command: 'claude mcp add --scope user agent-office -- node /path/to/agent-office/mcp.mjs' });
  if (p === '/api/projects') return json(['/home/dev/code/pixel-shop', '/home/dev/code/api-gateway', '/home/dev/code/docs-site']);
  if (p === '/api/hidden') return json([]);
  if (p === '/api/setup') return json({ demo: true, claudeDirFound: true, transcripts: 14, live: 10, claudeCli: 'demo', terminal: 'your terminal', mcpConnected: false, customPersonalities: 0, boardCards: demoBoard().length, maxDays: 14 });
  if (/^\/api\/(new|open|end|handoff|send|pm\/session)/.test(p)) return json(NOT_HERE, 501);
  return json({ ok: true, demo: true });
}

const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  return url.pathname.includes('/api/') ? route(url, init) : realFetch(input, init);
};

// a small banner so visitors know what they are looking at
addEventListener('DOMContentLoaded', () => {
  const bar = document.createElement('div');
  bar.className = 'demo-banner';
  bar.innerHTML = '🎮 <b>Live demo</b>: a made-up office running in your browser. <a href="https://github.com/alminisl/agent-office#quick-start" target="_blank" rel="noopener">Install it</a> to see your own Claude Code sessions. <a href="../">← Back</a>';
  document.body.prepend(bar);
  const style = document.createElement('style');
  style.textContent = '.demo-banner{background:#d97757;color:#1d1b26;font:13px Inter,system-ui,sans-serif;padding:6px 16px;text-align:center}.demo-banner a{color:#1d1b26;font-weight:600;margin-left:6px}main{height:calc(100% - 53px - 31px)!important}';
  document.head.appendChild(style);
});
