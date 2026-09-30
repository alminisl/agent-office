#!/usr/bin/env node
// Agent Office MCP server: gives Claude Code sessions tools to hire coworkers and use the office TODO board.
// Registered with:  claude mcp add --scope user agent-office -- node /path/to/mcp.mjs
// (Dashboard → Settings has a one-click button for this.)
//
// It speaks MCP over stdio (newline-delimited JSON-RPC) and forwards tool calls to the local
// Agent Office server. The office decides who may hire: it identifies the calling session from
// our parent process, and only agents at the required level (5 by default) are allowed.
import { execFileSync } from 'node:child_process';

const OFFICE = process.env.OFFICE_URL || 'http://127.0.0.1:4747';
const VERSION = '1.0.0';

// Our ancestors' pids, so the office can match the claude process that started us.
function ancestors() {
  const pids = [];
  let pid = process.ppid;
  for (let i = 0; i < 5 && pid > 1; i++) {
    pids.push(pid);
    try { pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { break; }
  }
  return pids;
}

const ROLES = ['fixer', 'reviewer', 'qa', 'bughunter', 'security', 'docs'];
const TOOLS = [
  {
    name: 'hire_agent',
    description: 'Hire a new coworker in Agent Office to work on a task in parallel, then keep working yourself. Only senior agents (level 5+ in the office) may hire. '
      + 'Roles: "fixer" makes the change on its own git branch in a separate worktree (it may edit files, run tests and commit, but never push), so your working copy is untouched. '
      + '"reviewer", "qa", "bughunter", "security" and "docs" are read-only (QA roles may run tests) and hand in a report. '
      + 'Give a complete, self-contained task: the hire does not see your conversation. Returns the hire id; check on it with list_my_hires or get_report.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the new agent should do. Include the relevant files, the problem, and what "done" looks like.' },
        role: { type: 'string', enum: ROLES, description: 'fixer to change code on a separate branch; the others are read-only and report back. Default: fixer.' },
        name: { type: 'string', description: 'Optional name for the new coworker.' },
        project_path: { type: 'string', description: 'Absolute path of the project to work in. Defaults to your own project.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'office_overview',
    description: 'Get a live briefing of the whole Agent Office: every agent (Claude Code session) with their project, status, what they are doing, last messages and reports, plus the shared TODO board. Use it to coordinate, avoid duplicate work, or answer "what is everyone doing?".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'todo_list',
    description: 'List the items on the Agent Office TODO board that the user and other agents share (to do, in progress, and recently done).',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['todo', 'doing', 'done'], description: 'Only this column.' } } },
  },
  {
    name: 'todo_add',
    description: 'Add an item to the shared Agent Office TODO board, e.g. a follow-up you noticed but will not do now. Keep the title short; put details in notes.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, like "Add tests for the retry logic".' },
        notes: { type: 'string', description: 'Details: files, context, what done looks like.' },
        status: { type: 'string', enum: ['todo', 'doing', 'done'], description: 'Default: todo.' },
        assign_to_me: { type: 'boolean', description: 'Link the item to your session (for things you will do yourself).' },
      },
      required: ['title'],
    },
  },
  {
    name: 'todo_update',
    description: 'Move an Agent Office TODO item to another column (todo, doing, done) and/or add a note to it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done'] }, note: { type: 'string', description: 'A short progress note.' } },
      required: ['id'],
    },
  },
  {
    name: 'list_my_hires',
    description: 'List the coworkers you hired in Agent Office, with their status (running, done, failed), role and branch.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_report',
    description: 'Get the report a coworker you hired handed in (or their current status if they are still working).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The hire id from hire_agent or list_my_hires.' } }, required: ['id'] },
  },
];

async function office(path, body) {
  const res = await fetch(`${OFFICE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Office': '1' }, body: JSON.stringify({ ...body, pids: ancestors() }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Agent Office answered ${res.status}`);
  return data;
}

async function callTool(name, args = {}) {
  if (name === 'hire_agent') {
    const r = await office('/api/agent/hire', args);
    return `Hired ${r.name} (${r.role}) as ${r.id}.${r.branch ? ` They work on branch ${r.branch} in ${r.worktree}.` : ''} They are walking to their desk in Agent Office now. Check on them with get_report("${r.id}").`;
  }
  if (name === 'office_overview') return (await office('/api/agent/overview', {})).text;
  if (name === 'todo_list') {
    const r = await office('/api/agent/todo', { op: 'list', status: args.status });
    if (!r.items.length) return 'The board is empty.';
    const label = { todo: 'To do', doing: 'In progress', done: 'Done' };
    return ['todo', 'doing', 'done'].map(st => {
      const items = r.items.filter(i => i.status === st);
      return items.length ? `${label[st]}:\n${items.map(i => `- [${i.id}] ${i.title}${i.project ? ` (${i.project})` : ''}${i.by ? `, added by ${i.by}` : ''}`).join('\n')}` : '';
    }).filter(Boolean).join('\n\n');
  }
  if (name === 'todo_add') {
    const r = await office('/api/agent/todo', { op: 'add', ...args });
    return `Added "${r.item.title}" to the board as ${r.item.id} (${r.item.status}).`;
  }
  if (name === 'todo_update') {
    const r = await office('/api/agent/todo', { op: 'update', ...args });
    return `Updated "${r.item.title}": now ${r.item.status}.`;
  }
  if (name === 'list_my_hires') {
    const r = await office('/api/agent/hires', {});
    if (!r.hires.length) return 'You have not hired anyone yet.';
    return r.hires.map(h => `- ${h.name} (${h.role}) ${h.id}: ${h.state}${h.branch ? `, branch ${h.branch}` : ''}. Task: ${h.task.slice(0, 120)}`).join('\n');
  }
  if (name === 'get_report') {
    const r = await office('/api/agent/report', { id: args.id });
    return r.report ? `${r.name} (${r.role}) ${r.state}:\n\n${r.report}` : `${r.name} is still ${r.state}.`;
  }
  throw new Error(`Unknown tool ${name}`);
}

// ---- JSON-RPC over stdio ----
const send = msg => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled, ...)
  try {
    if (method === 'initialize') {
      return send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-office', version: VERSION } } });
    }
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const text = await callTool(params?.name, params?.arguments);
        return send({ id, result: { content: [{ type: 'text', text }] } });
      } catch (e) {
        return send({ id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
      }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ id, error: { code: -32603, message: e.message } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
