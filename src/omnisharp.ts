import { ChildProcess, spawn } from 'child_process';
import { ensureOmniSharpInstalled } from './omnisharp-download';

export type OmniSharpStatus = 'starting' | 'running' | 'exited' | 'error';

export interface LspPosition {
  line: number; // 0-based
  character: number; // 0-based
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms));
}

// Normalizes the LSP spec's allowed `Location | Location[] | LocationLink[] |
// null` response shape for textDocument/definition into a plain array. Our
// `initialize` capabilities don't advertise `linkSupport`, so a LocationLink
// response isn't expected in practice, but it's cheap to handle anyway.
function normalizeLocations(result: unknown): LspLocation[] {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  return arr.map((item) => {
    const it = item as Record<string, unknown>;
    if (it.targetUri) {
      return { uri: it.targetUri as string, range: it.targetRange as LspRange };
    }
    return { uri: it.uri as string, range: it.range as LspRange };
  });
}

export interface OmniSharpServerOptions {
  folderId: string;
  cwd: string;
}

export class OmniSharpServer {
  readonly folderId: string;
  readonly cwd: string;

  status: OmniSharpStatus = 'starting';
  lastError: string | undefined;

  onStatusChange?: (status: OmniSharpStatus) => void;

  private proc: ChildProcess | undefined;
  private stdoutBuffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private openDocs = new Set<string>();
  private startPromise: Promise<void> | undefined;

  constructor(opts: OmniSharpServerOptions) {
    this.folderId = opts.folderId;
    this.cwd = opts.cwd;
  }

  private setStatus(status: OmniSharpStatus, error?: string): void {
    this.status = status;
    this.lastError = error;
    this.onStatusChange?.(status);
  }

  async ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.start().catch((err) => {
        this.setStatus('error', err instanceof Error ? err.message : String(err));
        this.startPromise = undefined; // allow a later call to retry
        throw err;
      });
    }
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const install = await ensureOmniSharpInstalled();

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('dotnet', [install.dllPath, '--languageserver', '--hostPID', String(process.pid)], {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;

      let settled = false;
      proc.once('error', (err) => {
        if (settled) return;
        settled = true;
        reject(new Error(`Could not start OmniSharp — is the .NET SDK installed and 'dotnet' on PATH? (${err.message})`));
      });
      proc.once('spawn', () => {
        if (settled) return;
        settled = true;
        resolve();
      });

      proc.stdout!.on('data', (chunk: Buffer) => this.handleStdoutChunk(chunk));
      proc.stderr!.on('data', (chunk: Buffer) => {
        console.log(`[omnisharp:${this.folderId}] ${chunk.toString('utf8').trim()}`);
      });
      proc.on('exit', (code) => {
        this.status = 'exited';
        this.lastError = code != null ? `OmniSharp exited with code ${code}` : undefined;
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error('OmniSharp process exited'));
        }
        this.pending.clear();
      });
    });

    await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileUri(this.cwd),
      rootPath: this.cwd,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
        },
      },
      initializationOptions: {},
    });
    this.send('initialized', {});
    this.setStatus('running');
  }

  private handleStdoutChunk(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const headerEnd = this.stdoutBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.stdoutBuffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) {
        // Malformed frame — drop what we have and wait for a fresh one.
        this.stdoutBuffer = Buffer.alloc(0);
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.stdoutBuffer.length < bodyStart + length) return; // wait for more data
      const body = this.stdoutBuffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.stdoutBuffer = this.stdoutBuffer.subarray(bodyStart + length);
      try {
        this.dispatch(JSON.parse(body));
      } catch (err) {
        console.log(`[omnisharp:${this.folderId}] failed to parse message: ${(err as Error).message}`);
      }
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.id !== 'number') return; // server-initiated request/notification — nothing we handle for MVP
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error((msg.error as { message?: string }).message || 'OmniSharp request failed'));
    } else {
      pending.resolve(msg.result);
    }
  }

  private writeMessage(obj: unknown): void {
    const json = JSON.stringify(obj);
    const header = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`;
    this.proc?.stdin?.write(header + json);
  }

  private send(method: string, params: unknown): void {
    this.writeMessage({ jsonrpc: '2.0', method, params });
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.writeMessage({ jsonrpc: '2.0', id, method, params });
    });
  }

  async didOpen(uri: string, languageId: string, text: string): Promise<void> {
    await this.ensureStarted();
    this.openDocs.add(uri);
    this.send('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
  }

  async didChange(uri: string, text: string): Promise<void> {
    if (!this.openDocs.has(uri)) return;
    this.send('textDocument/didChange', { textDocument: { uri }, contentChanges: [{ text }] });
  }

  async didClose(uri: string): Promise<void> {
    this.openDocs.delete(uri);
    this.send('textDocument/didClose', { textDocument: { uri } });
  }

  async definition(uri: string, position: LspPosition): Promise<LspLocation[]> {
    await this.ensureStarted();
    const result = await this.request<unknown>('textDocument/definition', { textDocument: { uri }, position });
    return normalizeLocations(result);
  }

  async references(uri: string, position: LspPosition): Promise<LspLocation[]> {
    await this.ensureStarted();
    const result = await this.request<unknown>('textDocument/references', {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });
    return normalizeLocations(result);
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    if (this.status === 'running') {
      try {
        await Promise.race([this.request('shutdown', null), timeout(1000)]);
        this.send('exit', null);
      } catch {
        // best-effort — proceed to kill regardless
      }
    }
    try {
      proc.kill();
    } catch {
      // already gone
    }
    this.status = 'exited';
  }
}

export function pathToFileUri(absPath: string): string {
  let p = absPath.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = `/${p}`; // Windows drive letters (C:/...) need a leading slash
  return `file://${encodeURI(p)}`;
}

export function fileUriToPath(uri: string): string {
  const decoded = decodeURI(uri.replace(/^file:\/\//, ''));
  // Strip the leading slash in front of a Windows drive letter (/C:/foo -> C:/foo).
  return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
}
