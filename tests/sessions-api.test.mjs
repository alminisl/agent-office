import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { workspace, mkdir, repo, worktree, api, transcript, ownedProcess, assertProject } from './helpers/fixtures.mjs';

function session(rows, id) {
  const matches = rows.filter(row => row.id === id);
  assert.equal(matches.length, 1, `Expected exactly one session ${id}`);
  return matches[0];
}
function project(row, root, roots, source, fallback) {
  assert.equal(row.projectSource, source);
  assertProject(assert, row, root, roots, source, fallback);
}

test('Transcript edits use each line\'s cwd', async t => {
  const base = workspace(t), a = repo(base, 'a'), b = repo(base, 'b'), c = repo(base, 'c');
  const server = await api(t, base);
  server.job('job-line-cwd', { sessionId: 'line-cwd' });
  server.write('line-cwd', transcript(base, [
    { cwd: a, file: 'src/a.js', tool: 'Edit', at: 1 },
    { cwd: b, file: 'lib/b.js', tool: 'Write', at: 3 },
    { cwd: a, file: path.join(c, 'pkg/c.js'), tool: 'MultiEdit', at: 2 },
  ]));
  project(session(await server.sessions(), 'line-cwd'), b, [b, c, a], 'edits');
});
test('Distinct edit directories retain their latest edit time', async t => {
  const base = workspace(t), a = repo(base, 'a'), b = repo(base, 'b');
  const server = await api(t, base);
  server.job('job-latest-time', { sessionId: 'latest-time' });
  server.write('latest-time', transcript(base, [
    { file: path.join(a, 'src/first.js'), at: 50 },
    { file: path.join(b, 'src/b.js'), at: 30 },
    { file: `${a}/src/../src/second.js`, at: 10 },
    { file: path.join(a, 'src/third.js'), at: 5 },
  ]));
  project(session(await server.sessions(), 'latest-time'), a, [a, b], 'edits');
});
test('Only qualifying edit tools contribute directories', async t => {
  const base = workspace(t), a = repo(base, 'qualifying'), b = repo(base, 'read-only');
  const server = await api(t, base);
  server.job('job-qualifying-tools', { sessionId: 'qualifying-tools' });
  server.write('qualifying-tools', transcript(base, [
    { file: path.join(a, 'edit.js'), tool: 'Edit', at: 1 },
    { file: path.join(a, 'write.js'), tool: 'Write', at: 2 },
    { file: path.join(a, 'multi.js'), tool: 'MultiEdit', at: 3 },
    { file: path.join(b, 'read.js'), tool: 'Read', at: 30 },
    { file: path.join(b, 'notebook.ipynb'), tool: 'NotebookEdit', at: 31 },
    { file: path.join(b, 'side.js'), isSidechain: true, at: 32 },
    { cwd: b, tool: 'Edit', at: 33 },
  ], [{ type: 'user', cwd: base, timestamp: '2026-11-01T12:00:00Z', message: { content: [{ type: 'tool_result', content: path.join(b, 'result.js') }] } }]));
  project(session(await server.sessions(), 'qualifying-tools'), a, [a], 'edits');
});
test('Repository attribution survives top-15 file truncation', async t => {
  const base = workspace(t), old = repo(base, 'older'), latest = repo(base, 'latest');
  const server = await api(t, base);
  const edits = [];
  for (let i = 0; i < 15; i++) for (let j = 0; j < 3; j++) edits.push({ file: path.join(old, `file-${i}.js`), at: j + 1 });
  edits.push({ file: path.join(latest, 'only-once.js'), at: 50 });
  server.job('job-top-files', { sessionId: 'top-files' });
  server.write('top-files', transcript(base, edits));
  project(session(await server.sessions(), 'top-files'), latest, [latest, old], 'edits');
});
test('HTTP metadata works for every session source', async t => {
  const base = workspace(t), a = repo(base, 'a'), b = repo(base, 'b'), linked = worktree(base, a);
  const server = await api(t, base);
  const livePid = await ownedProcess(t), bothPid = await ownedProcess(t);
  server.live(livePid, 'live-only', linked, { name: 'Live worktree', kind: 'bg', jobId: 'job-live' });
  server.job('job-offline', { sessionId: 'offline' });
  server.write('offline', transcript(mkdir(b, 'src'), [], [{ type: 'ai-title', aiTitle: 'Offline AI' }]));
  server.job('job-both', { sessionId: 'both' });
  server.write('both', transcript(a, [], [{ type: 'custom-title', customTitle: 'Transcript custom' }, { type: 'ai-title', aiTitle: 'Transcript AI' }]));
  server.live(bothPid, 'both', a, { name: 'Agents view name', kind: 'interactive', jobId: 'job-both' });
  server.job('job-live', { sessionId: 'live-only' });
  const rows = await server.sessions();
  const live = session(rows, 'live-only'), offline = session(rows, 'offline'), both = session(rows, 'both');
  project(live, a, [a], 'cwd');
  assert.equal(live.cwd, linked);
  assert.equal(live.title, 'Live worktree');
  assert.equal(live.kind, 'bg');
  assert.equal(live.jobId, 'job-live');
  project(offline, b, [b], 'cwd');
  assert.equal(offline.title, 'Offline AI');
  assert.equal(offline.kind, 'bg');
  assert.equal(offline.jobId, 'job-offline');
  project(both, a, [a], 'cwd');
  assert.equal(both.title, 'Agents view name');
  assert.equal(both.kind, 'bg');
  assert.equal(both.jobId, 'job-both');
  for (const row of [live, offline, both]) assert.equal(row.background, false);
  server.job('job-folder', { sessionId: 'folder' });
  server.write('folder', transcript(base));
  project(session(await server.sessions(), 'folder'), null, [], 'folder', path.basename(base));
});
test('Live metadata requires a live PID', async t => {
  const base = workspace(t), a = repo(base, 'a');
  const server = await api(t, base);
  const livePid = await ownedProcess(t), deadPid = await ownedProcess(t, true);
  server.live(livePid, 'valid-live', a, { name: 'Valid', kind: 'bg', jobId: 'valid-job' });
  server.live(deadPid, 'stale', a, { name: 'Stale live name', kind: 'bg', jobId: 'stale-job' });
  server.write('stale', transcript(a, [], [{ type: 'custom-title', customTitle: 'Offline custom' }]));
  server.job('valid-job', { sessionId: 'valid-live' });
  server.job('stale-job', { sessionId: 'stale', name: 'Job name' });
  server.malformed();
  const rows = await server.sessions(), valid = session(rows, 'valid-live'), stale = session(rows, 'stale');
  assert.equal(valid.title, 'Valid');
  assert.equal(valid.kind, 'bg');
  assert.equal(valid.jobId, 'valid-job');
  assert.equal(stale.live, false);
  assert.equal(stale.status, 'offline');
  assert.equal(stale.title, 'Job name');
  assert.equal(stale.kind, 'bg');
  assert.equal(stale.jobId, 'stale-job');
});
test('Interactive and non-job live sessions are excluded', async t => {
  const base = workspace(t), a = repo(base, 'a');
  const server = await api(t, base);
  for (const [id, fields] of [['external-bg', { kind: 'bg', jobId: 'external-job' }], ['external-other', { kind: 'review' }], ['ordinary', {}]]) {
    server.live(await ownedProcess(t), id, a, fields);
    server.write(id, transcript(a));
  }
  assert.deepEqual(await server.sessions(), []);
});
test('Metadata refreshes on subsequent requests', async t => {
  const base = workspace(t), a = repo(base, 'a'), b = repo(base, 'b');
  const server = await api(t, base), pid = await ownedProcess(t);
  server.write('refresh', transcript(base, [{ file: path.join(a, 'first.js'), at: 1 }], [{ type: 'custom-title', customTitle: 'First custom' }]));
  server.live(pid, 'refresh', base, { name: 'First live', kind: 'bg', jobId: 'first-job' });
  server.job('first-job', { sessionId: 'refresh', name: 'Job name' });
  let row = session(await server.sessions(), 'refresh');
  project(row, a, [a], 'edits');
  assert.equal(row.title, 'First live');
  assert.equal(row.kind, 'bg');
  assert.equal(row.jobId, 'first-job');
  server.write('refresh', transcript(base, [{ file: path.join(b, 'second.js'), at: 2 }], [{ type: 'custom-title', customTitle: 'Updated custom' }]));
  server.live(pid, 'refresh', base, { name: 'Updated live', kind: 'review', jobId: 'updated-job' });
  server.removeJob('first-job');
  server.job('updated-job', { sessionId: 'refresh', name: 'Updated job' });
  row = session(await server.sessions(), 'refresh');
  project(row, b, [b], 'edits');
  assert.equal(row.title, 'Updated live');
  assert.equal(row.kind, 'bg');
  assert.equal(row.jobId, 'updated-job');
  server.removeLive(pid);
  row = session(await server.sessions(), 'refresh');
  project(row, b, [b], 'edits');
  assert.equal(row.title, 'Updated job');
  assert.equal(row.kind, 'bg');
  assert.equal(row.jobId, 'updated-job');
  assert.equal(row.live, false);
  assert.equal(row.background, false);
});

test('Repository attribution retains edits beyond the 50 most recent directories', async t => {
  const base = workspace(t), older = repo(base, 'older'), latest = repo(base, 'latest');
  const server = await api(t, base);
  const nonRepositoryEdits = Array.from({ length: 51 }, (_, i) => ({
    file: path.join(mkdir(base, `non-repository-${i}`), 'file.js'), at: i + 2,
  }));
  const olderEdit = { file: path.join(older, 'file.js'), at: 1 };
  server.job('job-older-repository-only', { sessionId: 'older-repository-only' });
  server.write('older-repository-only', transcript(base, [olderEdit, ...nonRepositoryEdits]));
  server.job('job-older-and-latest-repositories', { sessionId: 'older-and-latest-repositories' });
  server.write('older-and-latest-repositories', transcript(base, [
    olderEdit, ...nonRepositoryEdits, { file: path.join(latest, 'file.js'), at: 54 },
  ]));
  const rows = await server.sessions();
  await t.test('finds the only repository behind 51 newer non-repository directories', () => {
    project(session(rows, 'older-repository-only'), older, [older], 'edits');
  });
  await t.test('lists both repositories with the most recently edited repository first', () => {
    project(session(rows, 'older-and-latest-repositories'), latest, [latest, older], 'edits');
  });
});
