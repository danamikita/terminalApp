const { ipcRenderer, clipboard } = require('electron');
const path = require('path');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { parse: parseMarkdown } = require('marked');
const DOMPurify = require('dompurify');

let state = { folders: [] };
const collapsed = new Set();
const sessionTerms = new Map(); // sessionId -> { term, fitAddon, container }

const folderBrowseDir = new Map(); // folderId -> last-browsed directory (sticky)
const gitInfo = new Map(); // folderId -> GitInfo
const slnFiles = new Map(); // folderId -> [{ name, path }]
let filesPanelState = null; // null | { folderId, view: 'listing'|'markdown', markdownPath?, markdownReturnDir? }
let activeSessionId = null;
let singleModeShowing = 'placeholder'; // 'placeholder' | 'files' | 'session' -- which slot wins when not split
let splitMode = false;

const folderListEl = document.getElementById('folder-list');
const terminalsEl = document.getElementById('terminals');
const addFolderBtn = document.getElementById('add-folder-btn');
const newFolderBtn = document.getElementById('new-folder-btn');
const cloneRepoBtn = document.getElementById('clone-repo-btn');
const sidebarEl = document.getElementById('sidebar');
const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');

const mainBodyEl = document.getElementById('main-body');
const slotFilesEl = document.getElementById('slot-files');
const slotTerminalEl = document.getElementById('slot-terminal');
const filesEmptyEl = document.getElementById('files-empty');
const terminalEmptyEl = document.getElementById('terminal-empty');
const fileBrowserEl = document.getElementById('file-browser');
const markdownPreviewEl = document.getElementById('markdown-preview');
const editorPaneEl = document.getElementById('editor-pane');
const gitPanelEl = document.getElementById('git-panel');
const splitToggleBtn = document.getElementById('split-toggle');
const autoResumeToggleBtn = document.getElementById('auto-resume-toggle');
const checkUpdateBtn = document.getElementById('check-update-btn');

const overlay = document.getElementById('modal-overlay');
const modalLabel = document.getElementById('modal-label');
const modalInput = document.getElementById('modal-input');
const modalOk = document.getElementById('modal-ok');
const modalCancel = document.getElementById('modal-cancel');

const feedbackBtn = document.getElementById('feedback-btn');
const feedbackOverlay = document.getElementById('feedback-overlay');
const feedbackModal = document.getElementById('feedback-modal');
const feedbackType = document.getElementById('feedback-type');
const feedbackTitleInput = document.getElementById('feedback-title');
const feedbackBodyInput = document.getElementById('feedback-body');
const feedbackCancelBtn = document.getElementById('feedback-cancel');
const feedbackSubmitBtn = document.getElementById('feedback-submit');

const REPO_URL = 'https://github.com/danamikita/terminalApp';

function openModal(label, defaultValue, callback) {
  modalLabel.textContent = label;
  modalInput.value = defaultValue || '';
  overlay.classList.remove('hidden');
  modalInput.focus();
  modalInput.select();

  function cleanup() {
    overlay.classList.add('hidden');
    modalOk.removeEventListener('click', onOk);
    modalCancel.removeEventListener('click', onCancel);
    modalInput.removeEventListener('keydown', onKey);
  }
  function onOk() {
    cleanup();
    callback(modalInput.value);
  }
  function onCancel() {
    cleanup();
    callback(null);
  }
  function onKey(ev) {
    if (ev.key === 'Enter') onOk();
    else if (ev.key === 'Escape') onCancel();
  }
  modalOk.addEventListener('click', onOk);
  modalCancel.addEventListener('click', onCancel);
  modalInput.addEventListener('keydown', onKey);
}

function basename(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildGitBadge(folder) {
  const info = gitInfo.get(folder.id);
  if (!info || !info.isRepo) return null;

  const badge = el('span', 'git-badge');
  badge.appendChild(el('span', 'git-branch', `⎇ ${info.branch}`));
  if (info.dirty > 0) {
    const dirty = el('span', 'git-dirty', `●${info.dirty}`);
    dirty.title = `${info.dirty} uncommitted change${info.dirty === 1 ? '' : 's'}`;
    badge.appendChild(dirty);
  }
  if (info.ahead > 0) {
    const ahead = el('span', 'git-ahead', `↑${info.ahead}`);
    ahead.title = `${info.ahead} commit${info.ahead === 1 ? '' : 's'} ahead of upstream`;
    badge.appendChild(ahead);
  }
  if (info.behind > 0) {
    const behind = el('span', 'git-behind', `↓${info.behind}`);
    behind.title = `${info.behind} commit${info.behind === 1 ? '' : 's'} behind upstream`;
    badge.appendChild(behind);
  }
  return badge;
}

async function refreshGitInfo() {
  for (const folder of state.folders) {
    try {
      gitInfo.set(folder.id, await ipcRenderer.invoke('git:info', { dirPath: folder.path }));
    } catch {
      gitInfo.set(folder.id, { isRepo: false });
    }
  }
  renderSidebar();
}

async function refreshSlnFiles() {
  for (const folder of state.folders) {
    try {
      const res = await ipcRenderer.invoke('app:list-sln', { dirPath: folder.path });
      slnFiles.set(folder.id, res.files || []);
    } catch {
      slnFiles.set(folder.id, []);
    }
  }
  renderSidebar();
}

function closeMenu() {
  const existing = document.getElementById('popup-menu');
  if (existing) existing.remove();
}

function openMenu(anchorEl, items, onSelect) {
  closeMenu();
  const rect = anchorEl.getBoundingClientRect();
  const menu = el('div', 'popup-menu');
  menu.id = 'popup-menu';
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 2}px`;
  for (const item of items) {
    const row = el('div', 'popup-menu-item', item.label);
    row.title = item.label;
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      onSelect(item);
    });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);

  setTimeout(() => {
    document.addEventListener('click', closeMenu, { once: true });
  }, 0);
}

function launchSlnFile(file) {
  ipcRenderer.invoke('fs:open-external', { filePath: file.path });
}

function handleSlnClick(folder, anchorEl) {
  const files = slnFiles.get(folder.id) || [];
  if (files.length === 0) return;
  if (files.length === 1) {
    launchSlnFile(files[0]);
    return;
  }
  openMenu(
    anchorEl,
    files.map((f) => ({ label: f.name, file: f })),
    (item) => launchSlnFile(item.file)
  );
}

function sessionDotClass(session) {
  if (session.status === 'exited') return 'exited';
  if (session.attention) return 'running attention';
  return session.activity === 'busy' ? 'running busy' : 'running idle';
}

function sessionDotTitle(session) {
  if (session.status === 'exited') return 'Exited';
  if (session.attention) return 'Waiting for you — ready for input';
  return session.activity === 'busy' ? 'Running' : 'Idle';
}

function renderSidebar() {
  folderListEl.innerHTML = '';

  if (state.folders.length === 0) {
    folderListEl.appendChild(el('div', 'empty-hint', 'No folders yet. Click + to add one.'));
    return;
  }

  for (const folder of state.folders) {
    const isCollapsed = collapsed.has(folder.id);
    const row = el('div', 'folder-row');
    row.dataset.testid = 'folder-row';
    row.dataset.folderId = folder.id;
    const main = el('div', 'folder-main');
    main.appendChild(el('span', 'folder-arrow', isCollapsed ? '▸' : '▾'));
    main.appendChild(el('span', 'folder-icon', '📦'));
    main.appendChild(el('span', 'folder-name', folder.name));

    const slns = slnFiles.get(folder.id) || [];
    if (slns.length > 0) {
      const slnBtn = el('button', 'row-btn sln-btn', '🧩');
      slnBtn.title =
        slns.length === 1 ? `Open ${slns[0].name} in Visual Studio` : `Open solution (${slns.length} found)`;
      slnBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        handleSlnClick(folder, slnBtn);
      });
      main.appendChild(slnBtn);
    }

    const newBtn = el('button', 'row-btn', '+');
    newBtn.title = 'New session';
    newBtn.dataset.testid = 'new-session-btn';
    newBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      promptNewSession(folder);
    });
    main.appendChild(newBtn);

    const trashBtn = el('button', 'row-btn', '✕');
    trashBtn.dataset.testid = 'remove-folder-btn';
    trashBtn.title = 'Remove folder';
    trashBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeFolder(folder);
    });
    main.appendChild(trashBtn);
    row.appendChild(main);

    const gitBadge = buildGitBadge(folder);
    const runningCount = folder.sessions.filter((s) => s.status === 'running').length;
    const attentionCount = folder.sessions.filter((s) => s.attention).length;
    if (gitBadge || runningCount > 0) {
      const meta = el('div', 'folder-meta');
      if (gitBadge) meta.appendChild(gitBadge);
      if (attentionCount > 0) {
        const attn = el('span', 'folder-attention', '●');
        attn.title = `${attentionCount} session${attentionCount === 1 ? '' : 's'} waiting for you`;
        meta.appendChild(attn);
      }
      if (runningCount > 0) meta.appendChild(el('span', 'folder-count', `(${runningCount})`));
      row.appendChild(meta);
    }

    row.addEventListener('click', () => {
      if (isCollapsed) collapsed.delete(folder.id);
      else collapsed.add(folder.id);
      renderSidebar();
    });
    folderListEl.appendChild(row);

    if (!isCollapsed) {
      const filesRow = el('div', 'session-row');
      filesRow.dataset.testid = 'files-row';
      filesRow.dataset.folderId = folder.id;
      if (filesPanelState && filesPanelState.folderId === folder.id && (splitMode || singleModeShowing === 'files')) {
        filesRow.classList.add('selected');
      }
      filesRow.appendChild(el('span', 'status-dot', '📂'));
      filesRow.appendChild(el('span', 'session-name', 'Files'));
      filesRow.addEventListener('click', () => openFilesForFolder(folder));
      folderListEl.appendChild(filesRow);

      const info = gitInfo.get(folder.id);
      if (info && info.isRepo) {
        const gitRow = el('div', 'session-row');
        gitRow.dataset.testid = 'git-row';
        gitRow.dataset.folderId = folder.id;
        if (filesPanelState && filesPanelState.folderId === folder.id && filesPanelState.view === 'git' && (splitMode || singleModeShowing === 'files')) {
          gitRow.classList.add('selected');
        }
        gitRow.appendChild(el('span', 'status-dot', '🌿'));
        gitRow.appendChild(el('span', 'session-name', 'Git'));
        gitRow.addEventListener('click', () => openGitForFolder(folder));
        folderListEl.appendChild(gitRow);
      }

      for (const session of folder.sessions) {
        const sRow = el('div', 'session-row');
        sRow.dataset.testid = 'session-row';
        sRow.dataset.sessionId = session.id;
        sRow.dataset.status = session.status;
        sRow.dataset.activity = session.activity;
        sRow.dataset.attention = String(!!session.attention);
        if (session.id === activeSessionId && (splitMode || singleModeShowing === 'session')) {
          sRow.classList.add('selected');
        }

        const dot = el('span', `status-dot ${sessionDotClass(session)}`, '●');
        dot.dataset.testid = 'status-dot';
        dot.title = sessionDotTitle(session);
        sRow.appendChild(dot);

        const info = el('div', 'session-info');
        info.appendChild(el('span', 'session-name', session.name));
        const lastCmd = session.lastCommand || session.command;
        if (lastCmd) {
          const sub = el('span', 'session-sub', lastCmd);
          sub.title = lastCmd;
          info.appendChild(sub);
        }
        sRow.appendChild(info);

        const renameBtn = el('button', 'row-btn', '✎');
        renameBtn.dataset.testid = 'rename-session-btn';
        renameBtn.title = 'Rename session';
        renameBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          renameSession(session);
        });
        sRow.appendChild(renameBtn);

        const killBtn = el('button', 'row-btn', '✕');
        killBtn.dataset.testid = 'kill-session-btn';
        killBtn.title = 'Kill session';
        killBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          killSession(session.id);
        });
        sRow.appendChild(killBtn);

        sRow.addEventListener('click', () => selectSession(session.id));
        folderListEl.appendChild(sRow);
      }
    }
  }
}

function applyLayout() {
  mainBodyEl.classList.toggle('split', splitMode);

  const filesSlotVisible = splitMode || singleModeShowing === 'files';
  const terminalSlotVisible = splitMode || singleModeShowing === 'session' || singleModeShowing === 'placeholder';

  slotFilesEl.classList.toggle('visible', filesSlotVisible);
  slotTerminalEl.classList.toggle('visible', terminalSlotVisible);

  const hasFiles = filesPanelState !== null;
  filesEmptyEl.classList.toggle('visible', !hasFiles);
  fileBrowserEl.classList.toggle('visible', hasFiles && filesPanelState.view === 'listing');
  markdownPreviewEl.classList.toggle('visible', hasFiles && filesPanelState.view === 'markdown');
  editorPaneEl.classList.toggle('visible', hasFiles && filesPanelState.view === 'editor');
  gitPanelEl.classList.toggle('visible', hasFiles && filesPanelState.view === 'git');

  const hasSession = activeSessionId !== null;
  terminalEmptyEl.classList.toggle('visible', !hasSession);
  for (const [id, entry] of sessionTerms) {
    entry.container.classList.toggle('visible', hasSession && id === activeSessionId);
  }

  if (hasSession && terminalSlotVisible) {
    const entry = sessionTerms.get(activeSessionId);
    requestAnimationFrame(() => {
      entry.fitAddon.fit();
      entry.term.focus();
      ipcRenderer.send('session:resize', { sessionId: activeSessionId, cols: entry.term.cols, rows: entry.term.rows });
    });
  }
}

function ensureTerminalForSession(sessionId) {
  if (sessionTerms.has(sessionId)) return sessionTerms.get(sessionId);

  const container = el('div', 'term-container');
  terminalsEl.appendChild(container);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    theme: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
    },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.ctrlKey || ev.altKey || ev.metaKey) return true;
    const key = ev.key.toLowerCase();
    if (key === 'c' && term.hasSelection()) {
      clipboard.writeText(term.getSelection());
      return false;
    }
    if (key === 'v') {
      const text = clipboard.readText();
      if (text) ipcRenderer.send('session:write', { sessionId, data: text });
      return false;
    }
    return true;
  });

  term.onData((data) => {
    ipcRenderer.send('session:write', { sessionId, data });
  });
  term.onBinary((data) => {
    ipcRenderer.send('session:write', { sessionId, data });
  });

  const entry = { term, fitAddon, container, ready: false, pending: [] };
  sessionTerms.set(sessionId, entry);

  ipcRenderer.invoke('app:get-session-buffer', { sessionId }).then((res) => {
    if (res && res.buffer) term.write(res.buffer);
    for (const chunk of entry.pending) term.write(chunk);
    entry.pending = [];
    entry.ready = true;
  });

  return entry;
}

function selectSession(sessionId) {
  activeSessionId = sessionId;
  singleModeShowing = 'session';
  ensureTerminalForSession(sessionId);
  applyLayout();
  renderSidebar();
  ipcRenderer.invoke('app:focus-session', { sessionId }).then((res) => {
    state = res.state;
    renderSidebar();
  });
}

function openFilesForFolder(folder) {
  const dir = folderBrowseDir.get(folder.id) || folder.path;
  showFilesListing(folder, dir);
}

function showFilesListing(folder, dirPath) {
  filesPanelState = { folderId: folder.id, view: 'listing' };
  folderBrowseDir.set(folder.id, dirPath);
  singleModeShowing = 'files';
  applyLayout();
  renderSidebar();
  renderFileBrowserContents(folder, dirPath);
}

const BINARY_EXT = /\.(png|jpe?g|gif|bmp|ico|webp|pdf|zip|7z|rar|exe|dll|so|dylib|mp3|mp4|mov|wav|ttf|woff2?|bin)$/i;

async function renderFileBrowserContents(folder, dirPath) {
  fileBrowserEl.innerHTML = '';
  fileBrowserEl.appendChild(el('div', 'fb-breadcrumb', dirPath));

  const normalizedCurrent = path.resolve(dirPath);
  const normalizedRoot = path.resolve(folder.path);
  if (normalizedCurrent !== normalizedRoot) {
    const up = el('div', 'fb-row');
    up.appendChild(el('span', 'fb-icon', '⬆'));
    up.appendChild(el('span', 'fb-name', '..'));
    up.addEventListener('click', () => showFilesListing(folder, path.dirname(dirPath)));
    fileBrowserEl.appendChild(up);
  }

  const res = await ipcRenderer.invoke('fs:list-dir', { dirPath });
  if (!res.ok) {
    fileBrowserEl.appendChild(el('div', 'empty-hint', res.error));
    return;
  }

  for (const entry of res.entries) {
    const full = path.join(dirPath, entry.name);
    const row = el('div', 'fb-row');

    if (entry.isDirectory) {
      row.appendChild(el('span', 'fb-icon', '📁'));
      row.appendChild(el('span', 'fb-name', entry.name));
      row.addEventListener('click', () => showFilesListing(folder, full));
    } else {
      const isMd = /\.(md|markdown)$/i.test(entry.name);
      const isBinary = BINARY_EXT.test(entry.name);
      row.appendChild(el('span', 'fb-icon', isMd ? '📝' : '📄'));
      row.appendChild(el('span', 'fb-name', entry.name));
      row.addEventListener('click', () => {
        if (isMd) showMarkdownPreview(folder, full, dirPath);
        else if (isBinary) ipcRenderer.invoke('fs:open-external', { filePath: full });
        else openFileInEditor(folder, full, false);
      });
    }
    fileBrowserEl.appendChild(row);
  }
}

function showMarkdownPreview(folder, filePath, returnDir) {
  filesPanelState = { folderId: folder.id, view: 'markdown', markdownPath: filePath, markdownReturnDir: returnDir };
  singleModeShowing = 'files';
  applyLayout();
  renderSidebar();

  markdownPreviewEl.innerHTML = '';
  const backBtn = el('button', 'md-back', '← Back to files');
  backBtn.addEventListener('click', () => showFilesListing(folder, returnDir));
  markdownPreviewEl.appendChild(backBtn);

  const editBtn = el('button', 'md-edit', '✎ Edit');
  editBtn.addEventListener('click', () => openFileInEditor(folder, filePath, true));
  markdownPreviewEl.appendChild(editBtn);

  const body = el('div');
  body.id = 'markdown-body';
  markdownPreviewEl.appendChild(body);

  ipcRenderer.invoke('fs:read-file', { filePath }).then((res) => {
    if (!res.ok) {
      body.textContent = `Error: ${res.error}`;
      return;
    }
    body.innerHTML = DOMPurify.sanitize(parseMarkdown(res.content));
  });
}

const sessionOverlay = document.getElementById('session-overlay');
const sessionShellSelect = document.getElementById('session-shell');
const sessionCommandInput = document.getElementById('session-command');
const sessionCancelBtn = document.getElementById('session-cancel');
const sessionStartBtn = document.getElementById('session-start');

function promptNewSession(folder) {
  sessionShellSelect.value = folder.lastShell || 'cmd';
  sessionCommandInput.value = folder.lastCommand || 'claude';
  sessionOverlay.classList.remove('hidden');
  sessionCommandInput.focus();
  sessionCommandInput.select();

  function cleanup() {
    sessionOverlay.classList.add('hidden');
    sessionStartBtn.removeEventListener('click', onStart);
    sessionCancelBtn.removeEventListener('click', onCancel);
    sessionCommandInput.removeEventListener('keydown', onKey);
  }
  async function onStart() {
    const shell = sessionShellSelect.value;
    const command = sessionCommandInput.value.trim() || 'claude';
    cleanup();
    const res = await ipcRenderer.invoke('app:create-session', { folderId: folder.id, command, shell });
    state = res.state;
    if (!res.ok) {
      alert(res.error);
      renderSidebar();
      return;
    }
    collapsed.delete(folder.id);
    selectSession(res.sessionId);
  }
  function onCancel() {
    cleanup();
  }
  function onKey(ev) {
    if (ev.key === 'Enter') onStart();
    else if (ev.key === 'Escape') onCancel();
  }
  sessionStartBtn.addEventListener('click', onStart);
  sessionCancelBtn.addEventListener('click', onCancel);
  sessionCommandInput.addEventListener('keydown', onKey);
}

async function killSession(sessionId) {
  const res = await ipcRenderer.invoke('app:kill-session', { sessionId });
  state = res.state;
  renderSidebar();
}

function renameSession(session) {
  openModal('Rename session:', session.name, async (value) => {
    if (value === null) return;
    const res = await ipcRenderer.invoke('app:rename-session', { sessionId: session.id, name: value });
    state = res.state;
    renderSidebar();
  });
}

async function removeFolder(folder) {
  const running = folder.sessions.filter((s) => s.status === 'running').length;
  if (running > 0) {
    const confirmed = confirm(`Folder "${folder.name}" has ${running} running session(s). Kill and remove?`);
    if (!confirmed) return;
  }
  if (!closeAllTabsForFolder(folder)) return;
  const res = await ipcRenderer.invoke('app:remove-folder', { folderId: folder.id });
  state = res.state;
  gitInfo.delete(folder.id);
  slnFiles.delete(folder.id);
  folderBrowseDir.delete(folder.id);

  if (filesPanelState && filesPanelState.folderId === folder.id) {
    filesPanelState = null;
    if (singleModeShowing === 'files') singleModeShowing = 'placeholder';
  }
  if (gitPanelState && gitPanelState.folderId === folder.id) {
    gitPanelState = null;
  }
  if (activeSessionId && folder.sessions.some((s) => s.id === activeSessionId)) {
    activeSessionId = null;
    if (singleModeShowing === 'session') singleModeShowing = 'placeholder';
  }

  for (const session of folder.sessions) {
    const entry = sessionTerms.get(session.id);
    if (entry) {
      entry.term.dispose();
      entry.container.remove();
      sessionTerms.delete(session.id);
    }
  }

  applyLayout();
  renderSidebar();
}

addFolderBtn.addEventListener('click', async () => {
  const dir = await ipcRenderer.invoke('app:pick-directory');
  if (!dir) return;
  openModal('Display name:', basename(dir), async (name) => {
    if (name === null) return;
    const res = await ipcRenderer.invoke('app:add-folder', { folderPath: dir, name: name.trim() || basename(dir) });
    state = res.state;
    if (!res.ok) {
      alert(res.error);
    }
    renderSidebar();
    refreshGitInfo();
    refreshSlnFiles();
  });
});

const cloneOverlay = document.getElementById('clone-overlay');
const cloneUrlInput = document.getElementById('clone-url');
const cloneDestInput = document.getElementById('clone-dest');
const cloneBrowseBtn = document.getElementById('clone-browse-btn');
const cloneNameInput = document.getElementById('clone-name');
const cloneLogEl = document.getElementById('clone-log');
const cloneCancelBtn = document.getElementById('clone-cancel');
const cloneSubmitBtn = document.getElementById('clone-submit');

let cloneDestDir = null;
let cloning = false;

function deriveRepoName(url) {
  const trimmed = url.trim().replace(/\/+$/, '');
  const last = trimmed.split(/[\\/]/).pop() || '';
  return last.replace(/\.git$/i, '');
}

function resetCloneModal() {
  cloneUrlInput.value = '';
  cloneDestInput.value = '';
  cloneDestDir = null;
  cloneNameInput.value = '';
  delete cloneNameInput.dataset.touched;
  cloneLogEl.textContent = '';
  cloneLogEl.classList.add('hidden');
  cloning = false;
  cloneSubmitBtn.disabled = false;
  cloneSubmitBtn.textContent = 'Clone';
  cloneCancelBtn.textContent = 'Cancel';
}

cloneRepoBtn.addEventListener('click', () => {
  resetCloneModal();
  cloneOverlay.classList.remove('hidden');
  cloneUrlInput.focus();
});

cloneUrlInput.addEventListener('input', () => {
  if (!cloneNameInput.dataset.touched) {
    cloneNameInput.value = deriveRepoName(cloneUrlInput.value);
  }
});

cloneNameInput.addEventListener('input', () => {
  cloneNameInput.dataset.touched = '1';
});

cloneBrowseBtn.addEventListener('click', async () => {
  const dir = await ipcRenderer.invoke('app:pick-directory', { title: 'Choose where to clone into' });
  if (!dir) return;
  cloneDestDir = dir;
  cloneDestInput.value = dir;
});

cloneCancelBtn.addEventListener('click', () => {
  if (cloning) {
    ipcRenderer.send('app:clone-repo-cancel');
    return;
  }
  cloneOverlay.classList.add('hidden');
});

cloneSubmitBtn.addEventListener('click', async () => {
  if (cloning) return;
  const url = cloneUrlInput.value.trim();
  const name = cloneNameInput.value.trim();
  if (!url) {
    alert('Repository URL is required.');
    return;
  }
  if (!cloneDestDir) {
    alert('Choose a destination folder.');
    return;
  }
  if (!name) {
    alert('Folder name is required.');
    return;
  }

  cloning = true;
  cloneSubmitBtn.disabled = true;
  cloneSubmitBtn.textContent = 'Cloning…';
  cloneCancelBtn.textContent = 'Stop';
  cloneLogEl.textContent = '';
  cloneLogEl.classList.remove('hidden');

  const res = await ipcRenderer.invoke('app:clone-repo', { parentPath: cloneDestDir, name, url });
  cloning = false;
  cloneSubmitBtn.disabled = false;
  cloneSubmitBtn.textContent = 'Clone';
  cloneCancelBtn.textContent = 'Close';

  if (res.ok) {
    state = res.state;
    renderSidebar();
    refreshGitInfo();
    refreshSlnFiles();
    cloneOverlay.classList.add('hidden');
  } else {
    cloneLogEl.textContent += `\nError: ${res.error}\n`;
    cloneLogEl.scrollTop = cloneLogEl.scrollHeight;
  }
});

ipcRenderer.on('git:clone-progress', (_e, { chunk }) => {
  cloneLogEl.textContent += chunk.replace(/\r/g, '\n');
  cloneLogEl.scrollTop = cloneLogEl.scrollHeight;
});

newFolderBtn.addEventListener('click', async () => {
  const parentDir = await ipcRenderer.invoke('app:pick-directory', { title: 'Choose where to create the new folder' });
  if (!parentDir) return;
  openModal('New folder name:', '', async (name) => {
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await ipcRenderer.invoke('app:create-folder', { parentPath: parentDir, name: trimmed });
    state = res.state;
    if (!res.ok) {
      alert(res.error);
    }
    renderSidebar();
    refreshGitInfo();
    refreshSlnFiles();
  });
});

splitToggleBtn.addEventListener('click', () => {
  splitMode = !splitMode;
  splitToggleBtn.classList.toggle('active', splitMode);
  applyLayout();
});

function setSidebarCollapsed(collapsed) {
  sidebarEl.classList.toggle('collapsed', collapsed);
  sidebarExpandBtn.classList.toggle('visible', collapsed);
  requestAnimationFrame(() => {
    if (activeSessionId) {
      const entry = sessionTerms.get(activeSessionId);
      if (entry) {
        entry.fitAddon.fit();
        ipcRenderer.send('session:resize', { sessionId: activeSessionId, cols: entry.term.cols, rows: entry.term.rows });
      }
    }
  });
}

sidebarCollapseBtn.addEventListener('click', () => setSidebarCollapsed(true));
sidebarExpandBtn.addEventListener('click', () => setSidebarCollapsed(false));

function applyAutoResumeButton() {
  autoResumeToggleBtn.classList.toggle('active', !!state.autoResume);
}

autoResumeToggleBtn.addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('app:set-auto-resume', { enabled: !state.autoResume });
  state = res.state;
  applyAutoResumeButton();
  renderSidebar();
});

checkUpdateBtn.addEventListener('click', async () => {
  checkUpdateBtn.disabled = true;
  checkUpdateBtn.textContent = '🔄 Checking…';
  try {
    const res = await ipcRenderer.invoke('app:check-for-updates');
    if (res.status === 'dev') {
      alert('Update checks only work in the installed app, not in a dev build.');
    } else if (res.status === 'available') {
      alert(`Update found: v${res.version}. Downloading now — you'll be prompted to restart once it's ready.`);
    } else if (res.status === 'not-available') {
      alert(`You're up to date (v${res.currentVersion}).`);
    } else {
      alert(`Update check failed: ${res.message}`);
    }
  } finally {
    checkUpdateBtn.disabled = false;
    checkUpdateBtn.textContent = '🔄 Check for Updates';
  }
});

function buildIssueUrl(type, title, body, info) {
  const label = type === 'enhancement' ? 'enhancement' : 'bug';
  const fullBody = `${body}\n\n---\nApp version: ${info.version}\nPlatform: ${info.platform} (${info.osRelease})`;
  const params = new URLSearchParams({ title, body: fullBody, labels: label });
  return `${REPO_URL}/issues/new?${params.toString()}`;
}

feedbackBtn.addEventListener('click', () => {
  feedbackType.value = 'bug';
  feedbackTitleInput.value = '';
  feedbackBodyInput.value = '';
  feedbackOverlay.classList.remove('hidden');
  feedbackTitleInput.focus();
});

feedbackCancelBtn.addEventListener('click', () => {
  feedbackOverlay.classList.add('hidden');
});

feedbackModal.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') feedbackCancelBtn.click();
});

feedbackSubmitBtn.addEventListener('click', async () => {
  const title = feedbackTitleInput.value.trim();
  if (!title) {
    feedbackTitleInput.focus();
    return;
  }
  const body = feedbackBodyInput.value.trim();
  const info = await ipcRenderer.invoke('app:get-info');
  const url = buildIssueUrl(feedbackType.value, title, body, info);
  await ipcRenderer.invoke('app:open-external-url', { url });
  feedbackOverlay.classList.add('hidden');
});

ipcRenderer.on('session:data', (_e, { sessionId, data }) => {
  const entry = sessionTerms.get(sessionId);
  if (!entry) return;
  if (entry.ready) entry.term.write(data);
  else entry.pending.push(data);
});

ipcRenderer.on('app:state', (_e, newState) => {
  state = newState;
  applyAutoResumeButton();
  renderSidebar();
});

window.addEventListener('resize', () => {
  if (!activeSessionId || !slotTerminalEl.classList.contains('visible')) return;
  const entry = sessionTerms.get(activeSessionId);
  if (!entry) return;
  entry.fitAddon.fit();
  ipcRenderer.send('session:resize', { sessionId: activeSessionId, cols: entry.term.cols, rows: entry.term.rows });
});

(async function init() {
  state = await ipcRenderer.invoke('app:get-state');
  renderSidebar();
  applyAutoResumeButton();
  applyLayout();
  refreshGitInfo();
  refreshSlnFiles();
  setInterval(refreshGitInfo, 10000);
})();
