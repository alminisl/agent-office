#!/usr/bin/env node
// Agent Office MCP server: gives Claude Code sessions tools to hire coworkers in the office.
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
  const res = await fetch(`${OFFICE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, pids: ancestors() }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Agent Office answered ${res.status}`);
  return data;
}

async function callTool(name, args = {}) {
  if (name === 'hire_agent') {
    const r = await office('/api/agent/hire', args);
    return `Hired ${r.name} (${r.role}) as ${r.id}.${r.branch ? ` They work on branch ${r.branch} in ${r.worktree}.` : ''} They are walking to their desk in Agent Office now. Check on them with get_report("${r.id}").`;
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
