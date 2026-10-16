import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { loadConfig, saveConfig, makeFolder, setConfigDirName } from '../src/config';
import { AppState, FolderConfig, FolderSnapshot, ShellType } from '../src/types';
import { PtySession } from '../src/pty-session';
import {
  getGitInfo,
  listBranches,
  checkoutBranch,
  gitPull,
  gitPush,
  getStatus,
  stageFile,
  unstageFile,
  getDiff,
  commitStaged,
  cloneRepo,
} from '../src/git';

interface FolderState extends FolderConfig {
  sessions: PtySession[];
  expanded: boolean;
}

const isTestMode = process.env.TERMINALAPP_TEST === '1';
if (!app.isPackaged) {
  // Keep a dev run's userData (incl. the single-instance lock) and saved
  // config separate from the installed app so both can run at once.
  // Automated-driver runs (TERMINALAPP_TEST=1) get their own config dir too,
  // so they never collide with a manually-run dev instance.
  app.setName(isTestMode ? 'terminalapp-test' : 'terminalapp-dev');
  setConfigDirName(isTestMode ? '.terminalapp-test' : '.terminalapp-dev');
}
const config = loadConfig();
const folders: FolderState[] = config.folders.map((f) => ({ ...f, sessions: [], expanded: true }));
// Test-mode never auto-resumes real sessions, even if a prior test run saved some.
let autoResumeEnabled = isTestMode ? false : config.autoResume !== false;

let win: BrowserWindow | null = null;
let activeClone: { cancel: () => void } | null = null;

function sendToWindow(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function persist(): void {
  saveConfig({
    folders: folders.map(({ sessions, expanded, ...f }) => f),
    autoResume: autoResumeEnabled,
  });
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

function buildResumeCommand(command: string): string {
  const trimmed = command.trim();
  const firstToken = trimmed.split(/\s+/)[0];
  const hasResumeFlag = /(^|\s)--(continue|resume)\b/.test(trimmed);
  if (firstToken === 'claude' && !hasResumeFlag) {
    return `${trimmed} --continue`;
  }
  return trimmed;
}

function createSessionForFolder(folder: FolderState, command: string, shell?: ShellType): PtySession | { error: string } {
  if (!pathIsValidDir(folder.path)) {
    return { error: `Folder path does not exist: ${folder.path}` };
  }
  let session: PtySession;
  try {
    session = new PtySession({
      folderId: folder.id,
      name: `${command.split(' ')[0]} #${folder.sessions.length + 1}`,
      command,
      cwd: folder.path,
      cols: 80,
      rows: 24,
      shell,
    });
  } catch (e) {
    return { error: `Could not start session: ${(e as Error).message}` };
  }

  session.onData = (data) => {
    sendToWindow('session:data', { sessionId: session.id, data });
  };
  session.onExit = () => pushState();
  session.onLastCommandChange = () => pushState();
  session.onActivityChange = () => pushState();
  folder.sessions.push(session);
  return session;
}

function resumeSessionsOnStartup(): void {
  if (!autoResumeEnabled) return;
  for (const folder of folders) {
    for (const entry of folder.resumeSessions || []) {
      const result = createSessionForFolder(folder, buildResumeCommand(entry.command), entry.shell);
      if (!('error' in result)) result.rename(entry.name);
    }
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
    autoResume: autoResumeEnabled,
    folders: folders.map<FolderSnapshot>((f) => ({
      id: f.id,
      name: f.name,
      path: f.path,
      lastCommand: f.lastCommand,
      lastShell: f.lastShell,
      sessions: f.sessions.map((s) => ({
        id: s.id,
        folderId: s.folderId,
        name: s.name,
        command: s.command,
        lastCommand: s.lastCommand,
        status: s.status,
        exitCode: s.exitCode,
        activity: s.activity,
        attention: s.attention,
      })),
    })),
  };
}

function pushState(): void {
  sendToWindow('app:state', getState());
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

  const isExternalHttpUrl = (url: string): boolean => {
    try {
      const protocol = new URL(url).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank') return { action: 'allow' };
    if (isExternalHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (childWindow) => {
    childWindow.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (isExternalHttpUrl(url)) shell.openExternal(url);
      childWindow.close();
    });
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win!.webContents.getURL()) return;
    event.preventDefault();
    if (isExternalHttpUrl(url)) shell.openExternal(url);
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
      folder.resumeSessions = folder.sessions
        .filter((s) => s.status === 'running')
        .map((s) => ({ name: s.name, command: s.command, shell: s.shell }));
    }
    persist();
    for (const folder of folders) {
      for (const session of folder.sessions) session.kill();
    }
  });

  win.on('closed', () => {
    win = null;
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

const CONTEXT_MENU_KEY = 'AddToFoldersApp';

function registerWindowsContextMenu(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const exePath = process.execPath;
  const run = (args: string[]) => execFileSync('reg', args, { stdio: 'ignore' });
  try {
    run(['add', `HKCU\\Software\\Classes\\Directory\\shell\\${CONTEXT_MENU_KEY}`, '/ve', '/d', 'Add to Folders', '/f']);
    run(['add', `HKCU\\Software\\Classes\\Directory\\shell\\${CONTEXT_MENU_KEY}`, '/v', 'Icon', '/d', `"${exePath}",0`, '/f']);
    run(['add', `HKCU\\Software\\Classes\\Directory\\shell\\${CONTEXT_MENU_KEY}\\command`, '/ve', '/d', `"${exePath}" "--add-folder" "%1"`, '/f']);

    run(['add', `HKCU\\Software\\Classes\\Directory\\Background\\shell\\${CONTEXT_MENU_KEY}`, '/ve', '/d', 'Add this folder to Folders', '/f']);
    run(['add', `HKCU\\Software\\Classes\\Directory\\Background\\shell\\${CONTEXT_MENU_KEY}`, '/v', 'Icon', '/d', `"${exePath}",0`, '/f']);
    run(['add', `HKCU\\Software\\Classes\\Directory\\Background\\shell\\${CONTEXT_MENU_KEY}\\command`, '/ve', '/d', `"${exePath}" "--add-folder" "%V"`, '/f']);
  } catch (e) {
    console.log(`[context-menu] registration failed: ${(e as Error).message}`);
  }
}

function handleAddFolderArg(argv: string[]): void {
  const idx = argv.indexOf('--add-folder');
  if (idx === -1 || idx + 1 >= argv.length) return;
  const resolved = path.resolve(argv[idx + 1]);
  if (!pathIsValidDir(resolved)) return;
  if (!folders.some((f) => path.resolve(f.path) === resolved)) {
    registerFolder(path.basename(resolved), resolved);
    pushState();
  }
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    handleAddFolderArg(argv);
  });

  app.whenReady().then(() => {
    createWindow();
    resumeSessionsOnStartup();
    registerWindowsContextMenu();
    handleAddFolderArg(process.argv);
    setupAutoUpdate();
  });
}

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

ipcMain.handle('app:clone-repo', async (_e, args: { parentPath: string; name: string; url: string }) => {
  const name = args.name.trim();
  const url = args.url.trim();
  if (!url) return { ok: false, error: 'Repository URL is required.' };
  if (!name) return { ok: false, error: 'Folder name is required.' };
  const resolved = path.resolve(args.parentPath, name);
  if (fs.existsSync(resolved)) {
    return { ok: false, error: `Already exists: ${resolved}` };
  }

  const { promise, cancel } = cloneRepo(args.parentPath, url, name, (chunk) => {
    sendToWindow('git:clone-progress', { chunk });
  });
  activeClone = { cancel };
  const result = await promise;
  activeClone = null;
  if (!result.ok) return { ok: false, error: result.error };

  registerFolder(name, resolved);
  return { ok: true, state: getState() };
});

ipcMain.on('app:clone-repo-cancel', () => {
  activeClone?.cancel();
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

ipcMain.handle('app:create-session', (_e, args: { folderId: string; command: string; shell?: ShellType }) => {
  const folder = findFolder(args.folderId);
  if (!folder) return { ok: false, error: 'Folder not found', state: getState() };
  const command = args.command.trim() || 'claude';
  folder.lastCommand = command;
  folder.lastShell = args.shell;
  persist();

  const result = createSessionForFolder(folder, command, args.shell);
  if ('error' in result) return { ok: false, error: result.error, state: getState() };

  return { ok: true, state: getState(), sessionId: result.id };
});

ipcMain.handle('app:popup-menu', (_e, args: { items: { id: string; label: string }[] }) => {
  return new Promise<string | null>((resolve) => {
    let resolved = false;
    const template = args.items.map((item) => ({
      label: item.label,
      click: () => {
        resolved = true;
        resolve(item.id);
      },
    }));
    const menu = Menu.buildFromTemplate(template);
    menu.popup({
      window: win ?? undefined,
      callback: () => {
        if (!resolved) resolve(null);
      },
    });
  });
});

ipcMain.handle('app:get-session-buffer', (_e, args: { sessionId: string }) => ({
  buffer: findSession(args.sessionId)?.getBuffer() || '',
}));

ipcMain.handle('app:set-auto-resume', (_e, args: { enabled: boolean }) => {
  autoResumeEnabled = args.enabled;
  persist();
  return { ok: true, state: getState() };
});

ipcMain.handle('app:focus-session', (_e, args: { sessionId: string }) => {
  findSession(args.sessionId)?.focus();
  return { ok: true, state: getState() };
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

ipcMain.handle('fs:write-file', (_e, args: { filePath: string; content: string }) => {
  try {
    fs.writeFileSync(args.filePath, args.content, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

ipcMain.handle('git:info', (_e, args: { dirPath: string }) => getGitInfo(args.dirPath));

ipcMain.handle('git:list-branches', (_e, args: { dirPath: string }) => listBranches(args.dirPath));

ipcMain.handle('git:checkout-branch', (_e, args: { dirPath: string; branch: string }) =>
  checkoutBranch(args.dirPath, args.branch)
);

ipcMain.handle('git:pull', (_e, args: { dirPath: string }) => gitPull(args.dirPath));

ipcMain.handle('git:push', (_e, args: { dirPath: string }) => gitPush(args.dirPath));

ipcMain.handle('git:status', (_e, args: { dirPath: string }) => getStatus(args.dirPath));

ipcMain.handle('git:stage', (_e, args: { dirPath: string; relPath: string }) => stageFile(args.dirPath, args.relPath));

ipcMain.handle('git:unstage', (_e, args: { dirPath: string; relPath: string }) =>
  unstageFile(args.dirPath, args.relPath)
);

ipcMain.handle('git:diff', async (_e, args: { dirPath: string; relPath: string; staged: boolean; untracked?: boolean }) => {
  const diff = await getDiff(args.dirPath, args.relPath, args.staged, args.untracked);
  return { ok: true, diff };
});

ipcMain.handle('git:commit', (_e, args: { dirPath: string; message: string }) => commitStaged(args.dirPath, args.message));

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

ipcMain.handle('app:check-for-updates', async () => {
  if (!app.isPackaged) {
    return { status: 'dev' as const };
  }
  return new Promise<{ status: string; version?: string; message?: string; currentVersion?: string }>((resolve) => {
    const cleanup = () => {
      autoUpdater.removeListener('update-available', onAvailable);
      autoUpdater.removeListener('update-not-available', onNotAvailable);
      autoUpdater.removeListener('error', onError);
    };
    const onAvailable = (info: { version: string }) => {
      cleanup();
      resolve({ status: 'available', version: info.version });
    };
    const onNotAvailable = () => {
      cleanup();
      resolve({ status: 'not-available', currentVersion: app.getVersion() });
    };
    const onError = (err: Error) => {
      cleanup();
      resolve({ status: 'error', message: err.message });
    };
    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('update-not-available', onNotAvailable);
    autoUpdater.once('error', onError);
    autoUpdater.checkForUpdates().catch((err: Error) => {
      cleanup();
      resolve({ status: 'error', message: err.message });
    });
  });
});
