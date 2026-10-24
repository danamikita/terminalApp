import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BranchInfo, GitChange, GitFileStatusCode, GitInfo, GitOpResult, GitStatusResult } from './types';

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 3000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// Like `run`, but preserves leading/trailing whitespace. `git status
// --porcelain -z` entries are column-aligned ("XY path") and X can
// legitimately be a space (unstaged-only change) — trimming the raw stdout
// would eat that leading space off the first record and shift every field
// in it by one character.
function runRaw(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 3000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}

function runAllowFail(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
    });
  });
}

function runWithStdin(args: string[], cwd: string, input: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => (stdout += d.toString()));
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => resolve({ stdout, stderr: err.message, code: 1 }));
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.stdin?.write(input);
    proc.stdin?.end();
  });
}

async function getCurrentBranch(dirPath: string): Promise<string> {
  try {
    return await run(['symbolic-ref', '--short', '-q', 'HEAD'], dirPath);
  } catch {
    try {
      return `detached@${await run(['rev-parse', '--short', 'HEAD'], dirPath)}`;
    } catch {
      return 'unknown';
    }
  }
}

async function getAheadBehind(dirPath: string): Promise<{ ahead: number; behind: number }> {
  try {
    const counts = await run(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], dirPath);
    const [a, b] = counts.split(/\s+/).map((n) => parseInt(n, 10));
    return { ahead: a || 0, behind: b || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

export async function getGitInfo(dirPath: string): Promise<GitInfo> {
  try {
    await run(['rev-parse', '--is-inside-work-tree'], dirPath);
  } catch {
    return { isRepo: false };
  }

  const branch = await getCurrentBranch(dirPath);

  let dirty = 0;
  try {
    const status = await run(['status', '--porcelain'], dirPath);
    dirty = status ? status.split('\n').filter(Boolean).length : 0;
  } catch {
    // leave at 0
  }

  const { ahead, behind } = await getAheadBehind(dirPath);

  return { isRepo: true, branch, dirty, ahead, behind };
}

export async function listBranches(dirPath: string): Promise<BranchInfo> {
  const current = await getCurrentBranch(dirPath);

  let locals: string[] = [];
  try {
    const out = await run(['branch', '--format=%(refname:short)'], dirPath);
    locals = out ? out.split('\n').filter(Boolean) : [];
  } catch {
    locals = [];
  }

  let remotes: string[] = [];
  try {
    const out = await run(['branch', '-r', '--format=%(refname:short)'], dirPath);
    remotes = out ? out.split('\n').filter(Boolean).filter((r) => !r.includes('->')) : [];
  } catch {
    remotes = [];
  }

  return { current, locals, remotes };
}

export async function checkoutBranch(dirPath: string, branch: string): Promise<GitOpResult> {
  const res = await runAllowFail(['checkout', branch], dirPath);
  if (res.code === 0) return { ok: true };
  return { ok: false, error: (res.stderr || res.stdout || 'Checkout failed.').trim() };
}

export async function createBranch(dirPath: string, name: string): Promise<GitOpResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'Branch name is required.' };
  const res = await runAllowFail(['checkout', '-b', trimmed], dirPath);
  if (res.code === 0) return { ok: true };
  return { ok: false, error: (res.stderr || res.stdout || 'Branch creation failed.').trim() };
}

export async function gitPull(dirPath: string): Promise<GitOpResult> {
  const res = await runAllowFail(['pull'], dirPath);
  const combined = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
  if (res.code === 0) return { ok: true, message: combined || undefined };
  return { ok: false, error: combined || 'Pull failed.' };
}

export async function gitPush(dirPath: string): Promise<GitOpResult> {
  const res = await runAllowFail(['push'], dirPath);
  const combined = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
  if (res.code === 0) return { ok: true, message: combined || undefined };
  return { ok: false, error: combined || 'Push failed.' };
}

export async function stageFile(dirPath: string, relPath: string): Promise<GitOpResult> {
  const res = await runAllowFail(['add', '--', relPath], dirPath);
  if (res.code === 0) return { ok: true };
  return { ok: false, error: (res.stderr || res.stdout || 'Staging failed.').trim() };
}

export async function unstageFile(dirPath: string, relPath: string): Promise<GitOpResult> {
  const res = await runAllowFail(['reset', '--', relPath], dirPath);
  if (res.code === 0) return { ok: true };
  return { ok: false, error: (res.stderr || res.stdout || 'Unstaging failed.').trim() };
}

export async function discardFile(
  dirPath: string,
  relPath: string,
  worktreeStatus: GitFileStatusCode | null,
  indexStatus: GitFileStatusCode | null,
  origPath?: string
): Promise<GitOpResult> {
  // Drop the file from the index first (no-op if it isn't staged) so a staged
  // add/rename doesn't linger after the worktree side is restored or removed.
  await runAllowFail(['reset', '--', relPath], dirPath);
  if (origPath) await runAllowFail(['reset', '--', origPath], dirPath);

  const isNew = worktreeStatus === 'untracked' || indexStatus === 'added';
  if (isNew) {
    try {
      fs.unlinkSync(path.join(dirPath, relPath));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: (e as Error).message };
    }
    return { ok: true };
  }

  const restorePath = origPath || relPath;
  const res = await runAllowFail(['checkout', 'HEAD', '--', restorePath], dirPath);
  if (origPath && origPath !== relPath) {
    try {
      fs.unlinkSync(path.join(dirPath, relPath));
    } catch {
      // already gone
    }
  }
  if (res.code === 0) return { ok: true };
  return { ok: false, error: (res.stderr || res.stdout || 'Revert failed.').trim() };
}

export async function revertHunk(dirPath: string, relPath: string, patch: string, staged: boolean): Promise<GitOpResult> {
  const args = ['apply', '--reverse', '--whitespace=nowarn'];
  if (staged) args.push('--cached');
  const res = await runWithStdin(args, dirPath, patch);
  if (res.code !== 0) return { ok: false, error: (res.stderr || res.stdout || 'Revert failed.').trim() };

  if (!staged) {
    // `git apply` writes the working-tree file straight through the
    // autocrlf smudge filter. On Windows repos with core.autocrlf=true,
    // that can leave `git status` reporting the file as modified even
    // though `git diff` agrees it's clean again — restaging and
    // unstaging forces git to recompute and cache the correct stat/hash.
    await runAllowFail(['add', '--', relPath], dirPath);
    await runAllowFail(['reset', '--', relPath], dirPath);
  }

  return { ok: true };
}

export async function getDiff(dirPath: string, relPath: string, staged: boolean, untracked?: boolean): Promise<string> {
  if (untracked) {
    const res = await runAllowFail(['diff', '--no-index', '--', '/dev/null', relPath], dirPath);
    return res.stdout;
  }
  const args = staged ? ['diff', '--cached', '--', relPath] : ['diff', '--', relPath];
  const res = await runAllowFail(args, dirPath);
  return res.stdout;
}

export async function commitStaged(dirPath: string, message: string): Promise<GitOpResult> {
  const trimmedMsg = message.trim();
  if (!trimmedMsg) return { ok: false, error: 'Commit message is required.' };

  let staged = '';
  try {
    staged = await run(['diff', '--cached', '--name-only'], dirPath);
  } catch {
    staged = '';
  }
  if (!staged.trim()) return { ok: false, error: 'Nothing staged to commit.' };

  const res = await runAllowFail(['commit', '-m', trimmedMsg], dirPath);
  if (res.code === 0) return { ok: true, message: res.stdout.trim() || undefined };
  return { ok: false, error: (res.stderr || res.stdout || 'Commit failed.').trim() };
}

export interface CloneHandle {
  promise: Promise<GitOpResult>;
  cancel: () => void;
}

export function cloneRepo(parentDir: string, url: string, name: string, onProgress: (chunk: string) => void): CloneHandle {
  let cancelled = false;
  const proc = spawn('git', ['clone', '--progress', '--', url, name], { cwd: parentDir });

  const promise = new Promise<GitOpResult>((resolve) => {
    let stderr = '';
    proc.stdout?.on('data', (d) => onProgress(d.toString()));
    proc.stderr?.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      onProgress(s);
    });
    proc.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
    proc.on('close', (code) => {
      if (cancelled) {
        resolve({ ok: false, error: 'Clone cancelled.' });
      } else if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: stderr.trim() || `git clone exited with code ${code}` });
      }
    });
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      proc.kill();
    },
  };
}

function mapStatusChar(c: string): GitFileStatusCode | null {
  switch (c) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return null;
  }
}

export async function getStatus(dirPath: string): Promise<GitStatusResult> {
  const branch = await getCurrentBranch(dirPath);
  const { ahead, behind } = await getAheadBehind(dirPath);

  let raw = '';
  try {
    raw = await runRaw(['status', '--porcelain=v1', '-z'], dirPath);
  } catch {
    raw = '';
  }

  const changes: GitChange[] = [];
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const rec = tokens[i];
    i++;
    const x = rec[0];
    const y = rec[1];
    const path = rec.slice(3);
    let origPath: string | undefined;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      origPath = tokens[i];
      i++;
    }

    if (x === '!' && y === '!') continue; // ignored

    if (x === '?' && y === '?') {
      changes.push({ path, staged: false, worktreeStatus: 'untracked', indexStatus: null });
      continue;
    }

    const conflicted = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    if (conflicted) {
      changes.push({ path, staged: false, worktreeStatus: 'conflicted', indexStatus: 'conflicted', origPath });
      continue;
    }

    const indexCode = mapStatusChar(x);
    const worktreeCode = mapStatusChar(y);
    if (indexCode) changes.push({ path, staged: true, indexStatus: indexCode, worktreeStatus: null, origPath });
    if (worktreeCode) changes.push({ path, staged: false, worktreeStatus: worktreeCode, indexStatus: null, origPath });
  }

  return { branch, ahead, behind, changes };
}
