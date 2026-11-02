import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRepo, clearRepoCache, configureRepoCache, projectFor, titleFor } from '../session-meta.mjs';
import { workspace, mkdir, repo, worktree, git, canonical, assertProject, isolatedEnv } from './helpers/fixtures.mjs';

const gitEnv = isolatedEnv();
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
for (const key of Object.keys(gitEnv)) if (key.startsWith('GIT_')) process.env[key] = gitEnv[key];

async function resolved(dir, root) {
  const actual = await resolveRepo(dir);
  assert.ok(actual);
  assert.equal(canonical(actual.root), canonical(root));
  assert.equal(actual.name, path.basename(root));
}

test('Resolve a checkout from its root and nested directories', async t => {
  const root = repo(workspace(t), 'main');
  await resolved(root, root);
  await resolved(mkdir(root, 'deep', 'nested'), root);
});
test('Linked worktrees resolve to the main checkout', async t => {
  const base = workspace(t), main = repo(base, 'main'), linked = worktree(base, main);
  await resolved(linked, main);
  await resolved(mkdir(linked, 'deep'), main);
});
test('Missing directories resolve through their nearest existing ancestor', async t => {
  const base = workspace(t), main = repo(base, 'main');
  await resolved(path.join(main, 'missing', 'deeper'), main);
  assert.equal(await resolveRepo(path.join(base, 'absent', 'deeper')), null);
});
test('Repository identity comes from Git', async t => {
  const base = workspace(t), main = repo(base, 'main $(false); & checkout');
  const nested = repo(main, 'independent nested');
  await resolved(mkdir(nested, 'sub dir'), nested);
  await resolved(main, main);
  assert.equal(await resolveRepo(mkdir(base, 'pretend.git', '.claude', 'worktrees', 'branch')), null);
});
test('Unavailable Git produces a repository miss', async t => {
  const base = workspace(t), main = repo(base, 'main');
  const original = process.env.PATH;
  process.env.PATH = mkdir(base, 'empty-bin');
  try {
    assert.equal(await resolveRepo(main), null);
    assertProject(assert, await projectFor({ cwd: main }), null, [], 'folder', 'main');
  } finally { process.env.PATH = original; }
});

for (const positive of [true, false]) test(`${positive ? 'Positive' : 'Negative'} cache entries expire`, async t => {
  const base = workspace(t), dir = positive ? repo(base, 'cached') : mkdir(base, 'cached');
  let now = 1000;
  configureRepoCache({ ttlMs: 100, now: () => now });
  try {
    clearRepoCache();
    if (positive) await resolved(dir, dir); else assert.equal(await resolveRepo(dir), null);
    if (positive) fs.rmSync(path.join(dir, '.git'), { recursive: true }); else { git(dir, 'init'); }
    now = 1099;
    if (positive) await resolved(dir, dir); else assert.equal(await resolveRepo(dir), null);
    now = 1100;
    if (positive) assert.equal(await resolveRepo(dir), null); else await resolved(dir, dir);
  } finally { configureRepoCache({ ttlMs: 600000, now: Date.now }); clearRepoCache(); }
});
test('Explicit cache clearing invalidates hits and misses', async t => {
  const base = workspace(t), hit = repo(base, 'hit'), miss = mkdir(base, 'miss');
  await resolved(hit, hit);
  assert.equal(await resolveRepo(miss), null);
  fs.rmSync(path.join(hit, '.git'), { recursive: true });
  git(miss, 'init');
  clearRepoCache();
  assert.equal(await resolveRepo(hit), null);
  await resolved(miss, miss);
});
test('The cwd repository wins while all repositories remain listed', async t => {
  const base = workspace(t), a = repo(base, 'a'), b = repo(base, 'b'), c = repo(base, 'c');
  assertProject(assert, await projectFor({ cwd: mkdir(a, 'nested'), editDirs: [{ dir: b, at: 10 }, { dir: c, at: 20 }] }), a, [a, c, b], 'cwd');
});
test('The most recently edited repository wins without a cwd repository', async t => {
  const base = workspace(t), a = repo(base, 'a'), b = repo(base, 'b');
  assertProject(assert, await projectFor({ cwd: base, editDirs: [{ dir: a, at: 1 }, { dir: b, at: 9 }, { dir: base, at: 20 }, { dir: a, at: 2 }] }), b, [b, a], 'edits');
});
test('Repository roots are deduplicated', async t => {
  const base = workspace(t), a = repo(base, 'a'), b = repo(base, 'b'), linked = worktree(base, a);
  assertProject(assert, await projectFor({ cwd: a, editDirs: [{ dir: b, at: 5 }, { dir: linked, at: 20 }, { dir: mkdir(b, 'nested'), at: 9 }, { dir: b, at: 3 }, { dir: mkdir(a, 'nested'), at: 7 }] }), a, [a, b], 'cwd');
});
test('Folder and unknown fallbacks', async t => {
  const base = workspace(t), folder = mkdir(base, 'plain'), a = repo(base, 'a');
  assertProject(assert, await projectFor({ cwd: folder, editDirs: [{ dir: base, at: 1 }] }), null, [], 'folder', 'plain');
  for (const cwd of [undefined, null, '']) {
    assertProject(assert, await projectFor({ cwd }), null, [], 'folder', 'unknown');
    assertProject(assert, await projectFor({ cwd, editDirs: [{ dir: a, at: 1 }] }), a, [a], 'edits');
  }
});
test('Every title precedence transition', () => {
  const transcript = { customTitle: 'Custom', title: 'AI', lastPrompt: 'Prompt' };
  assert.equal(titleFor(transcript, { name: 'Live' }), 'Live');
  assert.equal(titleFor(transcript, null), 'Custom');
  assert.equal(titleFor({ title: 'AI', lastPrompt: 'Prompt' }, null), 'AI');
  assert.equal(titleFor({ lastPrompt: 'Prompt' }, null), 'Prompt');
  assert.equal(titleFor({}, null), 'New session');
});
test('Blank titles and prompt length boundaries', () => {
  for (const blank of ['', ' \t\n ']) {
    assert.equal(titleFor({ customTitle: 'Custom' }, { name: blank }), 'Custom');
    assert.equal(titleFor({ customTitle: blank, title: 'AI' }, null), 'AI');
    assert.equal(titleFor({ title: blank, lastPrompt: 'Prompt' }, null), 'Prompt');
    assert.equal(titleFor({ customTitle: blank, title: blank, lastPrompt: blank }, { name: blank }), 'New session');
  }
  for (const length of [59, 60, 61]) assert.equal(titleFor({ lastPrompt: 'p'.repeat(length) }, null), 'p'.repeat(Math.min(length, 60)));
  const long = 'L'.repeat(90);
  assert.equal(titleFor({}, { name: long }), long);
  assert.equal(titleFor({ customTitle: long }, null), long);
  assert.equal(titleFor({ title: long }, null), long);
});
