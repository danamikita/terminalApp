import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { app } from 'electron';
import extractZip from 'extract-zip';

// Pinned to a well-trodden framework-dependent (net6.0) release — the same
// kind of build VS Code's C# extension has shipped for years. Newer releases
// (e.g. v2.0.0+) renamed/collapsed the per-platform assets and haven't been
// checked against this app's "assume the .NET SDK is already installed"
// assumption, so don't bump this without re-verifying asset names below.
const OMNISHARP_VERSION = '1.39.12';

export interface OmniSharpInstall {
  dllPath: string;
  installDir: string;
}

function assetNameFor(platform: NodeJS.Platform, arch: string): string {
  const platKey = platform === 'win32' ? 'win' : platform === 'darwin' ? 'osx' : 'linux';
  const archKey = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'x86' : null;
  if (!archKey) throw new Error(`Unsupported architecture for OmniSharp: ${platform}/${arch}`);
  return `omnisharp-${platKey}-${archKey}-net6.0.zip`;
}

function installDirFor(): string {
  return path.join(app.getPath('userData'), 'omnisharp', OMNISHARP_VERSION);
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`OmniSharp download failed: HTTP ${res.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(destPath));
}

let ensurePromise: Promise<OmniSharpInstall> | null = null;

// Idempotent: the first caller triggers the download+extract (if needed),
// every other concurrent/later caller awaits the same promise rather than
// racing a second download.
export function ensureOmniSharpInstalled(): Promise<OmniSharpInstall> {
  if (!ensurePromise) {
    ensurePromise = doEnsure().catch((err) => {
      // Let a failed attempt be retried on the next call instead of
      // permanently caching the rejection.
      ensurePromise = null;
      throw err;
    });
  }
  return ensurePromise;
}

async function doEnsure(): Promise<OmniSharpInstall> {
  const installDir = installDirFor();
  const dllPath = path.join(installDir, 'OmniSharp.dll');
  const sentinelPath = path.join(installDir, '.ok');

  if (fs.existsSync(sentinelPath) && fs.existsSync(dllPath)) {
    return { dllPath, installDir };
  }

  const asset = assetNameFor(process.platform, process.arch);
  const url = `https://github.com/OmniSharp/omnisharp-roslyn/releases/download/v${OMNISHARP_VERSION}/${asset}`;

  const tmpRoot = path.join(app.getPath('userData'), 'omnisharp', 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmpZipPath = path.join(tmpRoot, `${asset}-${Date.now()}.zip`);

  try {
    await downloadToFile(url, tmpZipPath);
    fs.mkdirSync(installDir, { recursive: true });
    await extractZip(tmpZipPath, { dir: installDir });
    if (!fs.existsSync(dllPath)) {
      throw new Error(`OmniSharp.dll not found after extracting ${asset} — unexpected archive layout`);
    }
    fs.writeFileSync(sentinelPath, '');
  } finally {
    try {
      fs.unlinkSync(tmpZipPath);
    } catch {
      // best-effort cleanup
    }
  }

  return { dllPath, installDir };
}
