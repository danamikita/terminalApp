import * as pty from 'node-pty';
import { randomUUID } from 'crypto';
import * as os from 'os';

export type SessionStatus = 'running' | 'exited';

export interface SessionOptions {
  folderId: string;
  name: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
}

const SHELL = os.platform() === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/bash');

export class PtySession {
  readonly id = randomUUID();
  readonly folderId: string;
  name: string;
  readonly command: string;
  readonly cwd: string;

  status: SessionStatus = 'running';
  exitCode: number | undefined;
  lastCommand: string | undefined;

  private proc: pty.IPty;
  private cols: number;
  private rows: number;
  private inputLine = '';

  onData?: (data: string) => void;
  onExit?: () => void;
  onLastCommandChange?: () => void;

  constructor(opts: SessionOptions) {
    this.folderId = opts.folderId;
    this.name = opts.name;
    this.command = opts.command;
    this.cwd = opts.cwd;
    this.cols = opts.cols;
    this.rows = opts.rows;

    this.proc = pty.spawn(SHELL, [], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: process.env as { [key: string]: string },
    });

    const cmd = opts.command.trim();
    if (cmd.length > 0) {
      setTimeout(() => this.proc.write(cmd + '\r'), 150);
    }

    this.proc.onData((data) => {
      this.onData?.(data);
    });

    this.proc.onExit(({ exitCode }) => {
      this.status = 'exited';
      this.exitCode = exitCode;
      this.onExit?.();
    });
  }

  rename(newName: string): void {
    const trimmed = newName.trim();
    if (trimmed) this.name = trimmed;
  }

  write(data: string): void {
    if (data && this.status === 'running') this.proc.write(data);
    this.trackInputLine(data);
  }

  private trackInputLine(data: string): void {
    if (!data || data.startsWith('\x1b')) return; // arrow keys / escape sequences
    if (data === '\r' || data === '\n') {
      const cmd = this.inputLine.trim();
      this.inputLine = '';
      if (cmd) {
        this.lastCommand = cmd;
        this.onLastCommandChange?.();
      }
      return;
    }
    if (data === '\x7f' || data === '\b') {
      this.inputLine = this.inputLine.slice(0, -1);
      return;
    }
    if (data === '\x03') {
      this.inputLine = ''; // Ctrl+C cancels the in-progress line
      return;
    }
    this.inputLine += data;
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    if (this.status === 'running') {
      try {
        this.proc.resize(cols, rows);
      } catch {
        // pty may have just exited; ignore
      }
    }
  }

  kill(): void {
    if (this.status === 'running') {
      try {
        this.proc.kill();
      } catch {
        // already gone
      }
    }
  }
}
