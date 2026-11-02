// Which repository a session works in, and what to call it. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

let ttlMs = 10 * 60e3;
let now = Date.now;
const cache = new Map(); // dir -> { at, value: Promise<{ root, name } | null> }

/** Set the cache lifetime and the clock. Omitted options keep their current value. */
export function configureRepoCache(options = {}) {
  if (options.ttlMs !== undefined) ttlMs = options.ttlMs;
  if (options.now !== undefined) now = options.now;
}

/** Forget every cached lookup. */
export function clearRepoCache() { cache.clear(); }

// The nearest directory that exists: a deleted worktree or a file path still points at its repo.
function existingDir(dir) {
  let d = path.resolve(dir);
  for (;;) {
    try { if (fs.statSync(d).isDirectory()) return d; } catch {}
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// At most MAX_GIT lookups run at once: the first poll can ask about hundreds of folders.
const MAX_GIT = 6;
let running = 0;
const waiting = [];
async function limited(fn) {
  if (running >= MAX_GIT) await new Promise(go => waiting.push(go));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

function gitLookup(dir) {
  return limited(() => new Promise(resolve => {
    execFile('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      { timeout: 5000, env: process.env }, (err, out) => {
        if (err) return resolve(null);
        const [top, common] = String(out).trim().split('\n');
        if (!top || !common) return resolve(null);
        // A linked worktree shares the main checkout's .git folder. A submodule's common dir
        // is inside the parent's .git/modules, so it keeps its own top level.
        const root = path.basename(common) === '.git' ? path.dirname(common) : top;
        resolve({ root, name: path.basename(root) });
      });
  }));
}

/**
 * Resolve the main checkout of the git repository that contains `dir`: a linked worktree
 * resolves to its main repository, a missing path through its nearest existing ancestor.
 * Hits and misses are cached; a missing or failing git gives null.
 * @returns {Promise<{ root: string, name: string } | null>}
 */
export function resolveRepo(dir) {
  if (!dir) return Promise.resolve(null);
  const start = existingDir(dir);
  if (!start) return Promise.resolve(null);
  const hit = cache.get(start);
  if (hit && now() - hit.at < ttlMs) return hit.value;
  const value = gitLookup(start); // concurrent lookups of one dir share this promise
  cache.set(start, { at: now(), value });
  return value;
}

/**
 * Decide the project of a session: the repository of `cwd`, else the repository of the most
 * recently edited directory, else basename(cwd) ('unknown' without one).
 * `repos` lists every repository found: cwd first, then edits by recency, without duplicates.
 * @param {{ cwd?: string|null, editDirs?: Array<{ dir: string, at: number }> }} input
 */
export async function projectFor({ cwd, editDirs } = {}) {
  const byRecency = [...(editDirs || [])].sort((a, b) => b.at - a.at);
  const [own, ...edited] = await Promise.all([resolveRepo(cwd), ...byRecency.map(e => resolveRepo(e.dir))]);
  const repos = [];
  for (const r of [own, ...edited]) if (r && !repos.includes(r.root)) repos.push(r.root);
  const main = own || edited.find(Boolean);
  if (main) return { project: main.name, repoRoot: main.root, repos, source: own ? 'cwd' : 'edits' };
  return { project: cwd ? path.basename(cwd) : 'unknown', repoRoot: null, repos, source: 'folder' };
}

const filled = v => (typeof v === 'string' && v.trim() ? v : null);

/** Title: agents-view name → custom title → AI title → last prompt (60 chars) → 'New session'. */
export function titleFor(transcript = {}, live = null) {
  return filled(live?.name) || filled(transcript.customTitle) || filled(transcript.title)
    || filled(transcript.lastPrompt)?.slice(0, 60) || 'New session';
}
