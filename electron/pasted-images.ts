// Shared by the desktop renderer's clipboard:save-pasted-image IPC handler
// and the web driver's POST /session/:id/paste-image route — both turn a
// pasted image into a file the local `claude` process can read via an
// @"path" reference, typed into the session exactly like a hand-typed path.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function savePastedImage(data: Buffer, ext: string): string {
  const safeExt = /^[a-z0-9]+$/i.test(ext) ? ext : 'png';
  const dir = path.join(os.tmpdir(), 'terminalapp-pasted-images');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `clipboard-${Date.now()}.${safeExt}`);
  fs.writeFileSync(filePath, data);
  return filePath;
}
