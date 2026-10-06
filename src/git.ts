import { execFile } from 'child_process';
import { GitInfo } from './types';

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 3000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

export async function getGitInfo(dirPath: string): Promise<GitInfo> {
  try {
    await run(['rev-parse', '--is-inside-work-tree'], dirPath);
  } catch {
    return { isRepo: false };
  }

  let branch: string;
  try {
    branch = await run(['symbolic-ref', '--short', '-q', 'HEAD'], dirPath);
  } catch {
    try {
      branch = `detached@${await run(['rev-parse', '--short', 'HEAD'], dirPath)}`;
    } catch {
      branch = 'unknown';
    }
  }

  let dirty = 0;
  try {
    const status = await run(['status', '--porcelain'], dirPath);
    dirty = status ? status.split('\n').filter(Boolean).length : 0;
  } catch {
    // leave at 0
  }

  let ahead = 0;
  let behind = 0;
  try {
    const counts = await run(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], dirPath);
    const [a, b] = counts.split(/\s+/).map((n) => parseInt(n, 10));
    ahead = a || 0;
    behind = b || 0;
  } catch {
    // no upstream configured; leave at 0
  }

  return { isRepo: true, branch, dirty, ahead, behind };
}
