export interface ResumableSession {
  name: string;
  command: string;
}

export interface FolderConfig {
  id: string;
  name: string;
  path: string;
  lastCommand?: string;
  resumeSessions?: ResumableSession[];
}

export interface AppConfig {
  folders: FolderConfig[];
  autoResume?: boolean;
}

export interface SessionSnapshot {
  id: string;
  folderId: string;
  name: string;
  command: string;
  lastCommand?: string;
  status: 'running' | 'exited';
  exitCode?: number;
}

export interface FolderSnapshot {
  id: string;
  name: string;
  path: string;
  lastCommand?: string;
  sessions: SessionSnapshot[];
}

export interface AppState {
  folders: FolderSnapshot[];
  autoResume: boolean;
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
