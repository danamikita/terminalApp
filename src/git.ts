import { execFile } from 'child_process';
import { BranchInfo, GitChange, GitFileStatusCode, GitInfo, GitOpResult, GitStatusResult } from './types';

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 3000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
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
    raw = await run(['status', '--porcelain=v1', '-z'], dirPath);
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
