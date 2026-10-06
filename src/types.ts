export interface FolderConfig {
  id: string;
  name: string;
  path: string;
  lastCommand?: string;
}

export interface AppConfig {
  folders: FolderConfig[];
}

export interface SessionSnapshot {
  id: string;
  folderId: string;
  name: string;
  command: string;
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
}

export type GitInfo =
  | { isRepo: false }
  | { isRepo: true; branch: string; dirty: number; ahead: number; behind: number };
