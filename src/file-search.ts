import * as fs from 'fs';
import * as path from 'path';

const IGNORE_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'release',
  'out',
  '.next',
  '.cache',
  '.gradle',
  '.idea',
  '.vscode',
  'coverage',
  'target',
  'bin',
  'obj',
  '__pycache__',
  '.venv',
  'venv',
  '.turbo',
  '.parcel-cache',
]);

const BINARY_EXT =
  /\.(png|jpe?g|gif|bmp|ico|webp|pdf|zip|7z|rar|exe|dll|so|dylib|mp3|mp4|mov|wav|ttf|woff2?|bin|class|jar|pyc|lock)$/i;

const MAX_FILES_WALKED = 50000;
const MAX_NAME_MATCHES = 2000;
const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 500;
const MAX_RESULTS_PER_FILE = 50;

export interface FileNameMatch {
  absPath: string;
  relPath: string;
}

export interface TextSearchMatch {
  absPath: string;
  relPath: string;
  line: number;
  col: number;
  text: string;
}

// Visits every non-ignored file under rootDir. `onFile` returning `false`
// stops the walk early (used to cap result counts on huge trees).
function walkFiles(rootDir: string, onFile: (absPath: string, relPath: string) => boolean | void): void {
  let visited = 0;
  let stopped = false;

  function recurse(dir: string) {
    if (stopped) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stopped) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIR_NAMES.has(entry.name)) continue;
        recurse(full);
      } else if (entry.isFile()) {
        visited += 1;
        if (visited > MAX_FILES_WALKED) {
          stopped = true;
          return;
        }
        const rel = path.relative(rootDir, full);
        if (onFile(full, rel) === false) {
          stopped = true;
          return;
        }
      }
    }
  }

  recurse(rootDir);
}

export function searchFileNames(rootDir: string, query: string, limit = 200): FileNameMatch[] {
  const q = query.trim().toLowerCase();
  const scored: { absPath: string; relPath: string; score: number }[] = [];

  walkFiles(rootDir, (absPath, relPath) => {
    const relLower = relPath.toLowerCase();
    let score = 0;
    if (q) {
      const idx = relLower.indexOf(q);
      if (idx === -1) return;
      const baseLower = path.basename(relLower);
      const baseIdx = baseLower.indexOf(q);
      score = (baseIdx === -1 ? 1000 : baseIdx) + idx + relPath.length * 0.01;
    } else {
      score = relPath.length;
    }
    scored.push({ absPath, relPath, score });
    if (scored.length > MAX_NAME_MATCHES) return false;
  });

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((r) => ({ absPath: r.absPath, relPath: r.relPath }));
}

export function searchFileContents(
  rootDir: string,
  query: string,
  opts: { caseSensitive?: boolean } = {}
): TextSearchMatch[] {
  if (!query) return [];
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  const results: TextSearchMatch[] = [];
  let total = 0;

  walkFiles(rootDir, (absPath, relPath) => {
    if (BINARY_EXT.test(absPath)) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      return;
    }
    if (stat.size > MAX_TEXT_FILE_SIZE) return;

    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      return;
    }
    if (content.includes(String.fromCharCode(0))) return;

    const lines = content.split('\n');
    let foundInFile = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hay = opts.caseSensitive ? line : line.toLowerCase();
      const col = hay.indexOf(needle);
      if (col === -1) continue;
      results.push({
        absPath,
        relPath,
        line: i + 1,
        col,
        text: line.length > 300 ? line.slice(0, 300) : line,
      });
      foundInFile += 1;
      total += 1;
      if (foundInFile >= MAX_RESULTS_PER_FILE || total >= MAX_SEARCH_RESULTS) break;
    }
    if (total >= MAX_SEARCH_RESULTS) return false;
  });

  return results;
}
