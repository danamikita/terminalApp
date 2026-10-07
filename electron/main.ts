import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { loadConfig, saveConfig, makeFolder } from '../src/config';
import { AppState, FolderConfig, FolderSnapshot } from '../src/types';
import { PtySession } from '../src/pty-session';
import { getGitInfo } from '../src/git';

interface FolderState extends FolderConfig {
  sessions: PtySession[];
  expanded: boolean;
}

const config = loadConfig();
const folders: FolderState[] = config.folders.map((f) => ({ ...f, sessions: [], expanded: true }));

let win: BrowserWindow | null = null;

function persist(): void {
  saveConfig({ folders: folders.map(({ sessions, expanded, ...f }) => f) });
}

function findFolder(folderId: string): FolderState | undefined {
  return folders.find((f) => f.id === folderId);
}

function findSession(sessionId: string): PtySession | undefined {
  for (const folder of folders) {
    const session = folder.sessions.find((s) => s.id === sessionId);
    if (session) return session;
  }
  return undefined;
}

function pathIsValidDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findSlnFiles(dirPath: string): { name: string; path: string }[] {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.sln'))
      .map((d) => ({ name: d.name, path: path.join(dirPath, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function getState(): AppState {
  return {
    folders: folders.map<FolderSnapshot>((f) => ({
      id: f.id,
      name: f.name,
      path: f.path,
      lastCommand: f.lastCommand,
      sessions: f.sessions.map((s) => ({
        id: s.id,
        folderId: s.folderId,
        name: s.name,
        command: s.command,
        lastCommand: s.lastCommand,
        status: s.status,
        exitCode: s.exitCode,
      })),
    })),
  };
}

function pushState(): void {
  win?.webContents.send('app:state', getState());
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Folders',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));

  win.webContents.on('console-message', (event) => {
    console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log(`[renderer] failed to load: ${code} ${desc}`);
  });

  win.on('close', (event) => {
    const runningCount = folders.reduce((n, f) => n + f.sessions.filter((s) => s.status === 'running').length, 0);
    if (runningCount > 0) {
      const choice = dialog.showMessageBoxSync(win!, {
        type: 'question',
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `${runningCount} session(s) still running. Quit and end them?`,
      });
      if (choice !== 0) {
        event.preventDefault();
        return;
      }
    }
    for (const folder of folders) {
      for (const session of folder.sessions) session.kill();
    }
  });
}

function setupAutoUpdate(): void {
  if (!app.isPackaged) return;

  autoUpdater.on('update-downloaded', (info) => {
    dialog
      .showMessageBox(win!, {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        message: `Version ${info.version} has been downloaded.`,
        detail: 'Restart to install the update.',
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.on('error', (err) => {
    console.log(`[updater] ${err.message}`);
  });

  autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 4 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdate();
});

app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.handle('app:get-state', () => getState());

ipcMain.handle('app:pick-directory', async (_e, args?: { title?: string }) => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: args?.title,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

function registerFolder(name: string, resolved: string): void {
  const folder: FolderState = { ...makeFolder(name, resolved), sessions: [], expanded: true };
  folders.push(folder);
  persist();
}

ipcMain.handle('app:add-folder', (_e, args: { folderPath: string; name: string }) => {
  const resolved = path.resolve(args.folderPath);
  if (!pathIsValidDir(resolved)) {
    return { ok: false, error: `Not a directory: ${resolved}`, state: getState() };
  }
  registerFolder(args.name.trim() || path.basename(resolved), resolved);
  return { ok: true, state: getState() };
});

ipcMain.handle('app:create-folder', (_e, args: { parentPath: string; name: string }) => {
  const name = args.name.trim();
  if (!name) return { ok: false, error: 'Name is required', state: getState() };
  const resolved = path.resolve(args.parentPath, name);
  if (fs.existsSync(resolved)) {
    return { ok: false, error: `Already exists: ${resolved}`, state: getState() };
  }
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (e) {
    return { ok: false, error: `Could not create folder: ${(e as Error).message}`, state: getState() };
  }
  registerFolder(name, resolved);
  return { ok: true, state: getState() };
});

ipcMain.handle('app:remove-folder', (_e, args: { folderId: string }) => {
  const folder = findFolder(args.folderId);
  if (!folder) return { ok: false, error: 'Folder not found', state: getState() };
  for (const session of folder.sessions) session.kill();
  const idx = folders.indexOf(folder);
  if (idx >= 0) folders.splice(idx, 1);
  persist();
  return { ok: true, state: getState() };
});

ipcMain.handle('app:create-session', (_e, args: { folderId: string; command: string }) => {
  const folder = findFolder(args.folderId);
  if (!folder) return { ok: false, error: 'Folder not found', state: getState() };
  if (!pathIsValidDir(folder.path)) {
    return { ok: false, error: `Folder path does not exist: ${folder.path}`, state: getState() };
  }
  const command = args.command.trim() || 'claude';
  folder.lastCommand = command;
  persist();

  let session: PtySession;
  try {
    session = new PtySession({
      folderId: folder.id,
      name: `${command.split(' ')[0]} #${folder.sessions.length + 1}`,
      command,
      cwd: folder.path,
      cols: 80,
      rows: 24,
    });
  } catch (e) {
    return { ok: false, error: `Could not start session: ${(e as Error).message}`, state: getState() };
  }

  session.onData = (data) => {
    win?.webContents.send('session:data', { sessionId: session.id, data });
  };
  session.onExit = () => {
    pushState();
  };
  session.onLastCommandChange = () => {
    pushState();
  };
  folder.sessions.push(session);

  return { ok: true, state: getState(), sessionId: session.id };
});

ipcMain.handle('app:kill-session', (_e, args: { sessionId: string }) => {
  const session = findSession(args.sessionId);
  session?.kill();
  return { ok: true, state: getState() };
});

ipcMain.handle('app:rename-session', (_e, args: { sessionId: string; name: string }) => {
  const session = findSession(args.sessionId);
  if (!session) return { ok: false, error: 'Session not found', state: getState() };
  session.rename(args.name);
  return { ok: true, state: getState() };
});

ipcMain.on('session:write', (_e, args: { sessionId: string; data: string }) => {
  findSession(args.sessionId)?.write(args.data);
});

ipcMain.on('session:resize', (_e, args: { sessionId: string; cols: number; rows: number }) => {
  findSession(args.sessionId)?.resize(args.cols, args.rows);
});

ipcMain.handle('fs:list-dir', (_e, args: { dirPath: string }) => {
  try {
    const entries = fs
      .readdirSync(args.dirPath, { withFileTypes: true })
      .map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { ok: true, entries };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

ipcMain.handle('fs:read-file', (_e, args: { filePath: string }) => {
  try {
    const stat = fs.statSync(args.filePath);
    if (stat.size > 5 * 1024 * 1024) {
      return { ok: false, error: 'File too large to preview (over 5MB).' };
    }
    const content = fs.readFileSync(args.filePath, 'utf8');
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

ipcMain.handle('fs:open-external', (_e, args: { filePath: string }) => {
  shell.openPath(args.filePath);
  return { ok: true };
});

ipcMain.handle('git:info', (_e, args: { dirPath: string }) => getGitInfo(args.dirPath));

ipcMain.handle('app:list-sln', (_e, args: { dirPath: string }) => ({ files: findSlnFiles(args.dirPath) }));

ipcMain.handle('app:get-info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  osRelease: os.release(),
}));

ipcMain.handle('app:open-external-url', (_e, args: { url: string }) => {
  shell.openExternal(args.url);
  return { ok: true };
});
