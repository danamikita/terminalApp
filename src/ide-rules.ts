import * as fs from 'fs';
import * as path from 'path';
import { IdeRuleConfig } from './types';

function matchesPattern(name: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p || p === '*') return true;
  if (p.startsWith('*.')) return name.toLowerCase().endsWith(p.slice(1).toLowerCase());
  return name.toLowerCase() === p.toLowerCase();
}

export function matchesAny(name: string, patterns: string): boolean {
  return patterns.split(',').some((p) => matchesPattern(name, p));
}

export interface IdeMatch {
  ruleId: string;
  label: string;
  fileName: string | null;
}

// For a rule whose command uses {file} (e.g. opening a specific .sln), every
// matching file gets its own entry so a folder with two can offer a choice.
// For a rule that only uses {folder} (e.g. "code {folder}"), one match per
// rule is enough — multiple hits (build.gradle AND settings.gradle, say)
// shouldn't produce duplicate "Android Studio" entries.
export function findIdeMatches(dirPath: string, rules: IdeRuleConfig[]): IdeMatch[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const matches: IdeMatch[] = [];
  for (const rule of rules) {
    if (rule.matchKind === 'always') {
      matches.push({ ruleId: rule.id, label: rule.label, fileName: null });
      continue;
    }
    const hits = entries.filter((e) => matchesAny(e.name, rule.match));
    if (hits.length === 0) continue;
    if (rule.command.includes('{file}')) {
      for (const hit of hits) matches.push({ ruleId: rule.id, label: rule.label, fileName: hit.name });
    } else {
      matches.push({ ruleId: rule.id, label: rule.label, fileName: null });
    }
  }
  return matches;
}

export type IdeLaunchPlan = { mode: 'open'; target: string } | { mode: 'exec'; command: string; cwd: string };

export function buildLaunchPlan(dirPath: string, rule: IdeRuleConfig, fileName: string | null): IdeLaunchPlan {
  const filePath = fileName ? path.join(dirPath, fileName) : dirPath;
  const trimmed = rule.command.trim();
  if (trimmed === '{file}') return { mode: 'open', target: filePath };
  if (trimmed === '{folder}') return { mode: 'open', target: dirPath };
  const command = rule.command.replace(/\{file\}/g, `"${filePath}"`).replace(/\{folder\}/g, `"${dirPath}"`);
  return { mode: 'exec', command, cwd: dirPath };
}

function findExeInCommonDirs(relativePaths: string[]): string | null {
  const bases = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']].filter(
    (p): p is string => !!p
  );
  for (const base of bases) {
    for (const rel of relativePaths) {
      const candidate = path.join(base, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findRiderPath(): string {
  return findExeInCommonDirs(['JetBrains\\Rider\\bin\\rider64.exe', 'Programs\\Rider\\bin\\rider64.exe']) || 'rider64.exe';
}

function findAndroidStudioPath(): string {
  return (
    findExeInCommonDirs(['Android\\Android Studio\\bin\\studio64.exe', 'Programs\\Android Studio\\bin\\studio64.exe']) ||
    'studio64.exe'
  );
}

// Computed once (not shipped as a static constant) so a best-guess install
// path gets baked into the rule's command right away — what the user sees
// in Settings is the real, already-resolved command, just plain editable
// text from then on, rather than a magic token resolved again at launch time.
export function defaultIdeRules(): IdeRuleConfig[] {
  return [
    { id: 'visual-studio', label: 'Visual Studio', matchKind: 'glob', match: '*.sln', command: '{file}' },
    { id: 'vscode', label: 'VS Code', matchKind: 'always', match: '', command: 'code {folder}' },
    { id: 'rider', label: 'Rider', matchKind: 'glob', match: '.idea', command: `"${findRiderPath()}" {folder}` },
    {
      id: 'android-studio',
      label: 'Android Studio',
      matchKind: 'glob',
      match: 'build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts,local.properties',
      command: `"${findAndroidStudioPath()}" {folder}`,
    },
  ];
}
