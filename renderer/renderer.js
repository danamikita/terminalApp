const { ipcRenderer } = require('electron');
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
let filesPanelState = null; // null | { folderId, view: 'listing'|'markdown', markdownPath?, markdownReturnDir? }
let activeSessionId = null;
let singleModeShowing = 'placeholder'; // 'placeholder' | 'files' | 'session' -- which slot wins when not split
let splitMode = false;

const folderListEl = document.getElementById('folder-list');
const terminalsEl = document.getElementById('terminals');
const addFolderBtn = document.getElementById('add-folder-btn');

const mainBodyEl = document.getElementById('main-body');
const slotFilesEl = document.getElementById('slot-files');
const slotTerminalEl = document.getElementById('slot-terminal');
const filesEmptyEl = document.getElementById('files-empty');
const terminalEmptyEl = document.getElementById('terminal-empty');
const fileBrowserEl = document.getElementById('file-browser');
const markdownPreviewEl = document.getElementById('markdown-preview');
const splitToggleBtn = document.getElementById('split-toggle');

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

function renderSidebar() {
  folderListEl.innerHTML = '';

  if (state.folders.length === 0) {
    folderListEl.appendChild(el('div', 'empty-hint', 'No folders yet. Click + to add one.'));
    return;
  }

  for (const folder of state.folders) {
    const isCollapsed = collapsed.has(folder.id);
    const row = el('div', 'folder-row');
    row.appendChild(el('span', 'folder-arrow', isCollapsed ? '▸' : '▾'));
    row.appendChild(el('span', 'folder-name', folder.name));

    const gitBadge = buildGitBadge(folder);
    if (gitBadge) row.appendChild(gitBadge);

    const runningCount = folder.sessions.filter((s) => s.status === 'running').length;
    if (runningCount > 0) row.appendChild(el('span', 'folder-count', `(${runningCount})`));

    const newBtn = el('button', 'row-btn', '+');
    newBtn.title = 'New session';
    newBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      promptNewSession(folder);
    });
    row.appendChild(newBtn);

    const trashBtn = el('button', 'row-btn', '✕');
    trashBtn.title = 'Remove folder';
    trashBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeFolder(folder);
    });
    row.appendChild(trashBtn);

    row.addEventListener('click', () => {
      if (isCollapsed) collapsed.delete(folder.id);
      else collapsed.add(folder.id);
      renderSidebar();
    });
    folderListEl.appendChild(row);

    if (!isCollapsed) {
      const filesRow = el('div', 'session-row');
      if (filesPanelState && filesPanelState.folderId === folder.id && (splitMode || singleModeShowing === 'files')) {
        filesRow.classList.add('selected');
      }
      filesRow.appendChild(el('span', 'status-dot', '📂'));
      filesRow.appendChild(el('span', 'session-name', 'Files'));
      filesRow.addEventListener('click', () => openFilesForFolder(folder));
      folderListEl.appendChild(filesRow);

      for (const session of folder.sessions) {
        const sRow = el('div', 'session-row');
        if (session.id === activeSessionId && (splitMode || singleModeShowing === 'session')) {
          sRow.classList.add('selected');
        }

        const dot = el('span', `status-dot ${session.status}`, '●');
        sRow.appendChild(dot);
        sRow.appendChild(el('span', 'session-name', session.name));

        const killBtn = el('button', 'row-btn', '✕');
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

  term.onData((data) => {
    ipcRenderer.send('session:write', { sessionId, data });
  });

  const entry = { term, fitAddon, container };
  sessionTerms.set(sessionId, entry);
  return entry;
}

function selectSession(sessionId) {
  activeSessionId = sessionId;
  singleModeShowing = 'session';
  ensureTerminalForSession(sessionId);
  applyLayout();
  renderSidebar();
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
      row.appendChild(el('span', 'fb-icon', isMd ? '📝' : '📄'));
      row.appendChild(el('span', 'fb-name', entry.name));
      row.addEventListener('click', () => {
        if (isMd) showMarkdownPreview(folder, full, dirPath);
        else ipcRenderer.invoke('fs:open-external', { filePath: full });
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

async function promptNewSession(folder) {
  openModal('Command to run (e.g. claude):', folder.lastCommand || 'claude', async (value) => {
    if (value === null) return;
    const command = value.trim() || 'claude';
    const res = await ipcRenderer.invoke('app:create-session', { folderId: folder.id, command });
    state = res.state;
    if (!res.ok) {
      alert(res.error);
      renderSidebar();
      return;
    }
    collapsed.delete(folder.id);
    selectSession(res.sessionId);
  });
}

async function killSession(sessionId) {
  const res = await ipcRenderer.invoke('app:kill-session', { sessionId });
  state = res.state;
  renderSidebar();
}

async function removeFolder(folder) {
  const running = folder.sessions.filter((s) => s.status === 'running').length;
  if (running > 0) {
    const confirmed = confirm(`Folder "${folder.name}" has ${running} running session(s). Kill and remove?`);
    if (!confirmed) return;
  }
  const res = await ipcRenderer.invoke('app:remove-folder', { folderId: folder.id });
  state = res.state;
  gitInfo.delete(folder.id);
  folderBrowseDir.delete(folder.id);

  if (filesPanelState && filesPanelState.folderId === folder.id) {
    filesPanelState = null;
    if (singleModeShowing === 'files') singleModeShowing = 'placeholder';
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
  });
});

splitToggleBtn.addEventListener('click', () => {
  splitMode = !splitMode;
  splitToggleBtn.classList.toggle('active', splitMode);
  applyLayout();
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
  if (entry) entry.term.write(data);
});

ipcRenderer.on('app:state', (_e, newState) => {
  state = newState;
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
  applyLayout();
  refreshGitInfo();
  setInterval(refreshGitInfo, 10000);
})();
