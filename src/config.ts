import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { AppConfig, FolderConfig } from './types';

const CONFIG_DIR = path.join(os.homedir(), '.terminalapp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function loadConfig(): AppConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.folders)) return parsed as AppConfig;
  } catch {
    // no config yet, or unreadable — start fresh
  }
  return { folders: [] };
}

export function saveConfig(config: AppConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

export function makeFolder(name: string, folderPath: string): FolderConfig {
  return { id: randomUUID(), name, path: folderPath };
}
