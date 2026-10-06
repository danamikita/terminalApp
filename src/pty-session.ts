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
  readonly name: string;
  readonly command: string;
  readonly cwd: string;

  status: SessionStatus = 'running';
  exitCode: number | undefined;

  private proc: pty.IPty;
  private cols: number;
  private rows: number;

  onData?: (data: string) => void;
  onExit?: () => void;

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

  write(data: string): void {
    if (data && this.status === 'running') this.proc.write(data);
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
