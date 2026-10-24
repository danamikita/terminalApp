export type ShellType = 'cmd' | 'powershell' | 'bash';

export interface ResumableSession {
  name: string;
  command: string;
  shell?: ShellType;
}

export interface FolderConfig {
  id: string;
  name: string;
  path: string;
  lastCommand?: string;
  lastShell?: ShellType;
  resumeSessions?: ResumableSession[];
}

export interface IdeRuleConfig {
  id: string;
  label: string;
  // 'glob': matched against filenames in the folder (see `match`, comma-separated
  // patterns, each a literal name or "*.ext"). 'always': offered for every folder,
  // no file needed (e.g. a generic "open in VS Code").
  matchKind: 'glob' | 'always';
  match: string;
  // Command line template: {file} is the matched file's full path (only valid
  // when matchKind is 'glob'), {folder} is the project folder's path. A command
  // that's *just* "{file}" or "{folder}" opens that path with its registered app
  // instead of running a command line.
  command: string;
}

export interface AppConfig {
  folders: FolderConfig[];
  autoResume?: boolean;
  ideRules?: IdeRuleConfig[];
  defaultShell?: ShellType;
}

export interface SessionSnapshot {
  id: string;
  folderId: string;
  name: string;
  command: string;
  lastCommand?: string;
  status: 'running' | 'exited';
  exitCode?: number;
  activity: 'idle' | 'busy';
  attention: boolean;
}

export interface FolderSnapshot {
  id: string;
  name: string;
  path: string;
  lastCommand?: string;
  lastShell?: ShellType;
  sessions: SessionSnapshot[];
}

export interface AppState {
  folders: FolderSnapshot[];
  autoResume: boolean;
  defaultShell: ShellType;
}

export type GitInfo =
  | { isRepo: false }
  | { isRepo: true; branch: string; dirty: number; ahead: number; behind: number };

export interface BranchInfo {
  current: string;
  locals: string[];
  remotes: string[];
}

export type GitFileStatusCode = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitChange {
  path: string;
  staged: boolean;
  worktreeStatus: GitFileStatusCode | null;
  indexStatus: GitFileStatusCode | null;
  origPath?: string;
}

export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

export type GitOpResult = { ok: true; message?: string } | { ok: false; error: string };
