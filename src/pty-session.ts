import * as pty from 'node-pty';
import { randomUUID } from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { ShellType } from './types';

export type SessionStatus = 'running' | 'exited';
export type SessionActivity = 'idle' | 'busy';

const IDLE_AFTER_MS = 800;
const BEL = '\x07';
// OSC (Operating System Command) sequences are sometimes terminated with BEL
// instead of the proper ST (ESC \) — shells commonly use this to set the
// window/tab title (e.g. cmd.exe does it on every prompt). That's not a real
// bell, so strip such sequences before looking for a standalone BEL.
const OSC_BEL_TERMINATED = /\x1b\][^\x07\x1b]*\x07/g;

export interface SessionOptions {
  folderId: string;
  name: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: ShellType;
}

function findBashPath(): string {
  const programFilesDirs = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(
    (p): p is string => !!p
  );
  for (const dir of programFilesDirs) {
    const candidate = path.join(dir, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'bash.exe'; // fall back to PATH resolution (e.g. WSL's bash.exe)
}

function resolveShell(shell: ShellType | undefined): string {
  if (os.platform() !== 'win32') return process.env.SHELL || '/bin/bash';
  switch (shell) {
    case 'powershell':
      return 'powershell.exe';
    case 'bash':
      return findBashPath();
    case 'cmd':
    default:
      return 'cmd.exe';
  }
}

export class PtySession {
  readonly id = randomUUID();
  readonly folderId: string;
  name: string;
  readonly command: string;
  readonly cwd: string;
  readonly shell: ShellType | undefined;

  status: SessionStatus = 'running';
  exitCode: number | undefined;
  lastCommand: string | undefined;
  activity: SessionActivity = 'idle';
  attention = false;

  private proc: pty.IPty;
  private cols: number;
  private rows: number;
  private inputLine = '';
  private buffer: string[] = [];
  private bufferBytes = 0;
  private readonly maxBufferBytes = 200_000;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  onData?: (data: string) => void;
  onExit?: () => void;
  onLastCommandChange?: () => void;
  onActivityChange?: () => void;

  constructor(opts: SessionOptions) {
    this.folderId = opts.folderId;
    this.name = opts.name;
    this.command = opts.command;
    this.cwd = opts.cwd;
    this.shell = opts.shell;
    this.cols = opts.cols;
    this.rows = opts.rows;

    this.proc = pty.spawn(resolveShell(opts.shell), [], {
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
      this.pushBuffer(data);
      this.markBusy();
      if (!this.attention && data.replace(OSC_BEL_TERMINATED, '').includes(BEL)) {
        this.attention = true;
        this.onActivityChange?.();
      }
      this.onData?.(data);
    });

    this.proc.onExit(({ exitCode }) => {
      this.status = 'exited';
      this.exitCode = exitCode;
      clearTimeout(this.idleTimer);
      this.onExit?.();
    });
  }

  private markBusy(): void {
    clearTimeout(this.idleTimer);
    const wasIdle = this.activity === 'idle';
    this.activity = 'busy';
    if (wasIdle) this.onActivityChange?.();
    this.idleTimer = setTimeout(() => {
      this.activity = 'idle';
      this.onActivityChange?.();
    }, IDLE_AFTER_MS);
  }

  focus(): void {
    if (!this.attention) return;
    this.attention = false;
    this.onActivityChange?.();
  }

  getBuffer(): string {
    return this.buffer.join('');
  }

  private pushBuffer(data: string): void {
    this.buffer.push(data);
    this.bufferBytes += data.length;
    while (this.bufferBytes > this.maxBufferBytes && this.buffer.length > 1) {
      this.bufferBytes -= this.buffer.shift()!.length;
    }
  }

  rename(newName: string): void {
    const trimmed = newName.trim();
    if (trimmed) this.name = trimmed;
  }

  write(data: string): void {
    if (data && this.status === 'running') this.proc.write(data);
    this.trackInputLine(data);
    this.focus();
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
    clearTimeout(this.idleTimer);
    if (this.status === 'running') {
      try {
        this.proc.kill();
      } catch {
        // already gone
      }
    }
  }
}
