import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

export function isolatedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.DEMO;
  delete env.NODE_OPTIONS;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}
export function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-meta-tests-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
export function mkdir(...parts) {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.name=Session Test', '-c', 'user.email=session@example.invalid', '-C', dir, ...args], { env: isolatedEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function repo(base, name) {
  const dir = mkdir(base, name);
  git(dir, 'init');
  git(dir, 'commit', '--allow-empty', '-m', 'fixture');
  return fs.realpathSync(dir);
}
export function worktree(base, main, name = 'linked checkout') {
  const dir = path.join(base, name);
  git(main, 'worktree', 'add', '-b', name.replaceAll(/[^a-zA-Z0-9]/g, '-'), dir);
  return fs.realpathSync(dir);
}
export const canonical = value => value === null ? null : fs.realpathSync(value);
export function assertProject(assert, actual, root, roots, source, fallback) {
  assert.equal(actual.project, root ? path.basename(root) : fallback);
  assert.equal(canonical(actual.repoRoot), canonical(root));
  assert.ok(Array.isArray(actual.repos));
  assert.deepEqual(actual.repos.map(canonical), roots.map(canonical));
  assert.equal(actual.projectSource ?? actual.source, source);
}
export function transcript(cwd, edits = [], extra = []) {
  return [
    { type: 'user', cwd, timestamp: '2026-11-01T10:00:00.000Z', message: { content: 'Please implement the requested change' } },
    ...edits.map(({ cwd: eventCwd = cwd, file, tool = 'Edit', at = 1, ...rest }) => ({
      type: 'assistant', cwd: eventCwd, timestamp: new Date(Date.UTC(2026, 10, 1, 10, 0, at)).toISOString(),
      message: { content: [{ type: 'tool_use', name: tool, input: file === undefined ? {} : { file_path: file } }] }, ...rest,
    })),
    { type: 'assistant', cwd, timestamp: '2026-11-01T11:00:00.000Z', message: { content: [{ type: 'text', text: 'Completed' }] } },
    ...extra,
  ];
}
export async function ownedProcess(t, exited = false) {
  const child = spawn(process.execPath, ['-e', exited ? '' : 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  if (exited) await once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit');
      child.kill('SIGKILL');
      await done;
    }
  });
  return child.pid;
}
export async function api(t, base) {
  const claude = mkdir(base, 'claude');
  const data = mkdir(base, 'office-data');
  mkdir(claude, 'sessions');
  mkdir(claude, 'projects', 'fixture-folder');
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let logs = '';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../../', import.meta.url),
    env: { ...isolatedEnv(), CLAUDE_DIR: claude, OFFICE_DATA_DIR: data, PORT: String(port), CLAUDE_BIN: '/usr/bin/false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', b => { logs += b; });
  child.stderr.on('data', b => { logs += b; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit');
      child.kill('SIGKILL');
      await done;
    }
  });
  const sessions = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const result = await response.json();
    if (!Array.isArray(result)) throw new Error('Expected sessions array');
    return result;
  };
  const deadline = Date.now() + 10000;
  while (true) {
    try { await sessions(); break; } catch (error) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Server did not become ready: ${error.message}\n${logs}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  let revision = 0;
  return {
    sessions,
    write(id, records) {
      const file = path.join(claude, 'projects', 'fixture-folder', `${id}.jsonl`);
      fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
      const mtime = new Date(Date.now() + ++revision * 1000);
      fs.utimesSync(file, mtime, mtime);
    },
    live(pid, id, cwd, fields = {}) {
      fs.writeFileSync(path.join(claude, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd, name: 'Live agent', status: 'idle', startedAt: Date.now(), updatedAt: Date.now(), statusUpdatedAt: Date.now(), ...fields }));
    },
    removeLive(pid) { fs.rmSync(path.join(claude, 'sessions', `${pid}.json`)); },
    malformed() { fs.writeFileSync(path.join(claude, 'sessions', 'malformed.json'), '{invalid'); },
  };
}
