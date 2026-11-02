import test from 'node:test';
import assert from 'node:assert/strict';
import { api, workspace, mkdir, transcript, ownedProcess, fakeClaude, poll } from './helpers/fixtures.mjs';

const sessionId = '00000000-0000-4000-8000-000000000001';

test('State-only listed job has an offline detail endpoint', async t => {
  const base = workspace(t), server = await api(t, base);
  server.job('state-only', { sessionId, name: 'State name', cwd: base });

  assert.deepEqual((await server.sessions()).map(row => row.id), [sessionId]);
  // request() rejects non-2xx responses, including the former 404.
  const detail = await server.request(`/api/session/${sessionId}`);
  assert.equal(detail.id, sessionId);
  assert.equal(detail.status, 'offline');
});

test('Unlisted live PM hires using its live cwd when project_path is omitted', async t => {
  const base = workspace(t), cwd = mkdir(base, 'caller-work');
  const fake = fakeClaude(t, base), server = await api(t, base, fake.env);
  const pid = await ownedProcess(t);
  server.live(pid, sessionId, cwd, { kind: 'interactive', name: 'Interactive PM' });
  await server.request('/api/personalities', { [sessionId]: { name: 'Interactive PM', role: 'pm' } });
  assert.deepEqual(await server.sessions(), [], 'The caller has no job or office run');

  const hire = await server.request('/api/agent/hire', {
    pids: [pid], role: 'docs', task: 'Document the fixture project',
  });
  assert.equal(typeof hire.id, 'string');
  assert.ok(hire.id.length > 0);
  assert.notEqual(hire.id, sessionId);
  await poll(() => fake.started(hire.id), Boolean, 'hired Claude startup');
  const detail = await server.request(`/api/session/${hire.id}`);
  assert.equal(detail.cwd, cwd);
});

test('Whitespace live name falls back to job state name before transcript title', async t => {
  const base = workspace(t), server = await api(t, base);
  server.job('blank-live-name', { sessionId, name: 'State name', cwd: base });
  server.write(sessionId, transcript(base, [], [{ type: 'custom-title', customTitle: 'Transcript title' }]));
  server.live(await ownedProcess(t), sessionId, base, { name: '   ', kind: 'bg', jobId: 'blank-live-name' });

  const rows = await server.sessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, sessionId);
  assert.equal(rows[0].live, true);
  assert.equal(rows[0].title, 'State name');
});
