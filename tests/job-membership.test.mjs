import test from 'node:test';
import assert from 'node:assert/strict';
import { api, workspace, repo, transcript, ownedProcess, assertProject, fakeClaude, poll } from './helpers/fixtures.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function exact(rows, ids) {
  assert.equal(rows.length, ids.length, 'Each expected session appears exactly once');
  assert.deepEqual(rows.map(row => row.id).sort(), [...ids].sort());
}
function one(rows, sessionId) {
  const matches = rows.filter(row => row.id === sessionId);
  assert.equal(matches.length, 1, `Expected one row for ${sessionId}`);
  return matches[0];
}
function offlineJob(row, jobId, title) {
  assert.equal(row.jobId, jobId);
  assert.equal(row.kind, 'bg');
  assert.equal(row.background, false);
  assert.equal(row.live, false);
  assert.equal(row.status, 'offline');
  assert.equal(row.title, title);
}

test('Exact membership is jobs plus office runs, each once', async t => {
  const base = workspace(t), fake = fakeClaude(t, base), server = await api(t, base, fake.env);
  const office = await server.request('/api/new', { cwd: base, prompt: 'Fixture task', background: true });
  await poll(() => fake.started(office.id), Boolean, 'office process startup');
  server.job('aa123456', { sessionId: id(1), name: 'State only', status: 'working' });
  server.job('bb123456', { sessionId: id(2), name: 'Joined job' });
  server.write(id(2), transcript(base));
  server.live(await ownedProcess(t), id(2), base, { kind: 'bg', jobId: 'bb123456' });
  server.live(await ownedProcess(t), id(3), base, { kind: 'interactive' });
  server.live(await ownedProcess(t), id(4), base, { kind: 'bg', jobId: 'spare' });
  server.write(id(5), transcript(base));
  server.emptyJob('empty');
  server.rawJob('broken', '{bad');
  exact(await server.sessions(), [id(1), id(2), office.id]);
});

test('Alive bg-spare without a state is excluded even with a matching transcript', async t => {
  const base = workspace(t), server = await api(t, base), pid = await ownedProcess(t);
  server.live(pid, id(1), base, { kind: 'bg', jobId: 'ce834b91' });
  exact(await server.sessions(), []);
  server.write(id(1), transcript(base));
  exact(await server.sessions(), []);
});

for (const status of ['working', 'blocked']) {
  test(`Job state alone establishes membership for ${status}, including with dead live metadata`, async t => {
    const base = workspace(t), server = await api(t, base);
    server.job('ce834b91', { sessionId: id(1), name: 'State name', status });
    offlineJob(one(await server.sessions(), id(1)), 'ce834b91', 'State name');
    server.live(await ownedProcess(t, true), id(1), base, { kind: 'interactive', jobId: 'wrong', name: 'Dead name' });
    offlineJob(one(await server.sessions(), id(1)), 'ce834b91', 'State name');
  });
}

test('Jobs join transcripts and live metadata by full session UUID, never short job ID', async t => {
  const base = workspace(t), right = repo(base, 'right'), wrong = repo(base, 'wrong'), server = await api(t, base);
  server.job('ce834b91', { sessionId: id(1) });
  server.write(id(1), transcript(right, [], [{ type: 'custom-title', customTitle: 'Correct transcript' }]));
  server.write('ce834b91', transcript(wrong, [], [{ type: 'custom-title', customTitle: 'Wrong transcript' }]));
  server.live(await ownedProcess(t), 'ce834b91', wrong, { name: 'Wrong live', kind: 'bg' });
  exact(await server.sessions(), [id(1)]);
  const row = one(await server.sessions(), id(1));
  offlineJob(row, 'ce834b91', 'Correct transcript');
  assertProject(assert, row, right, [right], 'cwd');
  server.live(await ownedProcess(t), id(1), right, { name: 'Correct live', jobId: 'wrong-live-job' });
  const live = one(await server.sessions(), id(1));
  assert.equal(live.title, 'Correct live');
  assert.equal(live.jobId, 'ce834b91');
  assert.equal(live.kind, 'bg');
  assert.equal(live.live, true);
});

test('Membership and state title refresh after state creation, update and removal', async t => {
  const base = workspace(t), server = await api(t, base);
  server.live(await ownedProcess(t), id(1), base, { name: '', kind: 'bg', jobId: 'ce834b91' });
  server.write(id(1), transcript(base, [], [{ type: 'custom-title', customTitle: 'Transcript title' }]));
  exact(await server.sessions(), []);
  server.job('ce834b91', { sessionId: id(1), name: 'First name' });
  assert.equal(one(await server.sessions(), id(1)).title, 'First name');
  server.job('ce834b91', { sessionId: id(1), name: 'Updated name' });
  assert.equal(one(await server.sessions(), id(1)).title, 'Updated name');
  server.removeJob('ce834b91');
  exact(await server.sessions(), []);
});

for (const env of [{}, { MAX_DAYS: '1' }]) {
  test(`Old transcripts retain job membership and attribution with env ${JSON.stringify(env)}`, async t => {
    const base = workspace(t), root = repo(base, 'old-repository'), server = await api(t, base, env);
    server.job('old-job', { sessionId: id(1) });
    server.write(id(1), transcript(root, [], [{ type: 'custom-title', customTitle: 'Old transcript' }]));
    server.mtime(id(1), new Date('2001-01-01T00:00:00Z'));
    const row = one(await server.sessions(), id(1));
    offlineJob(row, 'old-job', 'Old transcript');
    assertProject(assert, row, root, [root], 'cwd');
  });
}

test('Absent, empty and one-message job transcripts are all listed', async t => {
  const base = workspace(t), server = await api(t, base);
  for (let n = 1; n <= 3; n++) server.job(`job-${n}`, { sessionId: id(n), name: `Job ${n}` });
  server.write(id(2), []);
  server.write(id(3), transcript(base).slice(0, 1));
  const rows = await server.sessions();
  exact(rows, [id(1), id(2), id(3)]);
  for (let n = 1; n <= 3; n++) offlineJob(one(rows, id(n)), `job-${n}`, `Job ${n}`);
});

test('MAX_ROOMS never caps jobs', async t => {
  const base = workspace(t), server = await api(t, base, { MAX_ROOMS: '2' });
  const ids = Array.from({ length: 6 }, (_, n) => id(n + 1));
  for (const [n, sessionId] of ids.entries()) {
    server.job(`job-${n}`, { sessionId });
    server.write(sessionId, transcript(base));
  }
  exact(await server.sessions(), ids);
});

test('Office run is visible while running, merges with matching job, and lingers after completion', async t => {
  const base = workspace(t), fake = fakeClaude(t, base), server = await api(t, base, fake.env);
  const run = await server.request('/api/new', { cwd: base, prompt: 'Fixture task', background: true, persona: { name: 'Office worker' } });
  await poll(() => fake.started(run.id), Boolean, 'fake Claude startup');
  let rows = await server.sessions();
  exact(rows, [run.id]);
  assert.equal(rows[0].background, true);
  assert.equal(rows[0].runState, 'running');
  assert.equal(rows[0].live, true);
  server.job('office-job', { sessionId: run.id, name: 'Job name' });
  rows = await server.sessions();
  exact(rows, [run.id]);
  assert.equal(rows[0].background, true);
  assert.equal(rows[0].jobId, 'office-job');
  assert.equal(rows[0].kind, 'bg');
  fake.complete(run.id);
  rows = await poll(() => server.sessions(), rows => rows.some(row => row.id === run.id && row.runState === 'done' && row.hasReport), 'completed office report');
  exact(rows, [run.id]);
  assert.equal(rows[0].background, true);
  server.removeJob('office-job');
  rows = await server.sessions();
  exact(rows, [run.id]);
  assert.equal(rows[0].background, true);
  assert.equal(rows[0].runState, 'done');
});

test('Missing jobs directory and invalid job entries produce no phantom sessions', async t => {
  const base = workspace(t), server = await api(t, base);
  exact(await server.sessions(), []);
  server.emptyJob('empty');
  server.rawJob('broken', '{invalid');
  server.job('valid', { sessionId: id(1), name: 'Valid' });
  const rows = await server.sessions();
  exact(rows, [id(1)]);
  offlineJob(rows[0], 'valid', 'Valid');
});

test('Job identity survives removal of live file and dead PID metadata', async t => {
  const base = workspace(t), server = await api(t, base), pid = await ownedProcess(t);
  server.job('ce834b91', { sessionId: id(1), name: 'Job name' });
  server.write(id(1), transcript(base, [], [{ type: 'custom-title', customTitle: 'Transcript title' }]));
  server.live(pid, id(1), base, { name: 'Live name', kind: 'bg', jobId: 'ce834b91' });
  assert.equal(one(await server.sessions(), id(1)).title, 'Live name');
  server.removeLive(pid);
  offlineJob(one(await server.sessions(), id(1)), 'ce834b91', 'Job name');
  server.live(await ownedProcess(t, true), id(1), base, { name: 'Dead name', kind: 'bg', jobId: 'ce834b91' });
  offlineJob(one(await server.sessions(), id(1)), 'ce834b91', 'Job name');
});

test('Hidden jobs are excluded even with an alive PID and can be unhidden', async t => {
  const base = workspace(t), server = await api(t, base);
  server.job('job-one', { sessionId: id(1) });
  server.job('job-two', { sessionId: id(2) });
  server.write(id(1), transcript(base));
  server.live(await ownedProcess(t), id(1), base, { kind: 'bg' });
  exact(await server.sessions(), [id(1), id(2)]);
  await server.request(`/api/hide/${id(1)}`, { hide: true });
  exact(await server.sessions(), [id(2)]);
  await server.request(`/api/hide/${id(1)}`, { hide: false });
  exact(await server.sessions(), [id(1), id(2)]);
});

test('Config no longer exposes maxDays even when MAX_DAYS is configured', async t => {
  const server = await api(t, workspace(t), { MAX_DAYS: '1' });
  assert.equal(Object.hasOwn(await server.request('/api/config'), 'maxDays'), false);
});

test('Timeline includes only listed jobs despite equivalent recent excluded turns', async t => {
  const base = workspace(t), server = await api(t, base);
  const now = Date.now();
  const records = transcript(base).map((record, n) => ({ ...record, timestamp: new Date(now - 60000 + n * 10000).toISOString() }));
  for (let n = 1; n <= 4; n++) server.write(id(n), records);
  server.job('included', { sessionId: id(1) });
  server.live(await ownedProcess(t), id(2), base, { kind: 'interactive' });
  server.live(await ownedProcess(t), id(3), base, { kind: 'bg', jobId: 'ce834b91' });
  const timeline = await server.request('/api/timeline?hours=1');
  exact(timeline.sessions, [id(1)]);
  assert.ok(timeline.sessions[0].turns.length > 0);
  assert.deepEqual(timeline.sessions[0].turns, [[now - 60000, now - 50000]]);
});
