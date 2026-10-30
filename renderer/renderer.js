const { ipcRenderer } = require('electron');
const path = require('path');
const os = require('os');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { parse: parseMarkdown } = require('marked');
const DOMPurify = require('dompurify');

let state = { folders: [] };
const collapsed = new Set();
let archivedExpanded = false;
const sessionTerms = new Map(); // sessionId -> { term, fitAddon, container }

const folderBrowseDir = new Map(); // folderId -> last-browsed directory (sticky)
const gitInfo = new Map(); // folderId -> GitInfo
const ideMatches = new Map(); // folderId -> [{ ruleId, label, fileName }]
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
const searchPanelEl = document.getElementById('search-panel');
const splitToggleBtn = document.getElementById('split-toggle');
const autoResumeToggleBtn = document.getElementById('auto-resume-toggle');
const checkUpdateBtn = document.getElementById('check-update-btn');
const webDriverToggleBtn = document.getElementById('web-driver-toggle');
const webDriverOverlay = document.getElementById('web-driver-overlay');
const webDriverUrlInput = document.getElementById('web-driver-url');
const webDriverCopyBtn = document.getElementById('web-driver-copy');
const webDriverCloseBtn = document.getElementById('web-driver-close');
const webDriverBanner = document.getElementById('web-driver-banner');
const webDriverBannerOffBtn = document.getElementById('web-driver-banner-off');
const webDriverLocalHint = document.getElementById('web-driver-local-hint');
const webDriverTailscaleHint = document.getElementById('web-driver-tailscale-hint');
const webDriverFixFirewallBtn = document.getElementById('web-driver-fix-firewall');

const settingsBtn = document.getElementById('settings-btn');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsRulesEl = document.getElementById('settings-rules');
const settingsAddRuleBtn = document.getElementById('settings-add-rule');
const settingsCancelBtn = document.getElementById('settings-cancel');
const settingsSaveBtn = document.getElementById('settings-save');
const settingsDefaultShellSelect = document.getElementById('settings-default-shell');
const settingsDevicesEl = document.getElementById('settings-devices');

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

// Each folder's git status costs up to 4 sequential `git` subprocess spawns
// in the main process. Doing all folders one at a time scales linearly with
// folder count, and since this runs on a setInterval that doesn't wait for
// the previous sweep, a slow sweep (lots of folders, a big repo, a network
// drive) can cause the next one to start before it finishes — compounding
// subprocess load and starving everything else sharing the machine's CPU,
// including terminal rendering. Cap concurrency and skip starting a new
// sweep while one's still running.
let gitRefreshInFlight = false;
const GIT_REFRESH_CONCURRENCY = 4;
async function refreshGitInfo() {
  if (gitRefreshInFlight) return;
  gitRefreshInFlight = true;
  try {
    const folders = state.folders.filter((f) => !f.archived);
    let next = 0;
    async function worker() {
      while (next < folders.length) {
        const folder = folders[next++];
        try {
          gitInfo.set(folder.id, await ipcRenderer.invoke('git:info', { dirPath: folder.path }));
        } catch {
          gitInfo.set(folder.id, { isRepo: false });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(GIT_REFRESH_CONCURRENCY, folders.length) }, worker));
    renderSidebar();
  } finally {
    gitRefreshInFlight = false;
  }
}

async function refreshIdeMatches() {
  for (const folder of state.folders) {
    if (folder.archived) continue;
    try {
      const res = await ipcRenderer.invoke('app:list-ide-matches', { dirPath: folder.path });
      ideMatches.set(folder.id, res.matches || []);
    } catch {
      ideMatches.set(folder.id, []);
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

function launchIdeMatch(folder, match) {
  ipcRenderer.invoke('app:launch-ide', { dirPath: folder.path, ruleId: match.ruleId, fileName: match.fileName });
}

function ideMatchLabel(match) {
  return match.fileName ? `${match.label} — ${match.fileName}` : match.label;
}

function handleIdeClick(folder, anchorEl) {
  const matches = ideMatches.get(folder.id) || [];
  if (matches.length === 0) return;
  if (matches.length === 1) {
    launchIdeMatch(folder, matches[0]);
    return;
  }
  openMenu(
    anchorEl,
    matches.map((m) => ({ label: ideMatchLabel(m), match: m })),
    (item) => launchIdeMatch(folder, item.match)
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

  const activeFolders = state.folders.filter((f) => !f.archived);
  const archivedFolders = state.folders.filter((f) => f.archived);

  if (activeFolders.length === 0) {
    folderListEl.appendChild(el('div', 'empty-hint', 'All folders are archived.'));
  }

  for (const folder of activeFolders) {
    const isCollapsed = collapsed.has(folder.id);
    const row = el('div', 'folder-row');
    row.dataset.testid = 'folder-row';
    row.dataset.folderId = folder.id;
    row.draggable = true;
    const main = el('div', 'folder-main');
    main.appendChild(el('span', 'folder-arrow', isCollapsed ? '▸' : '▾'));
    main.appendChild(el('span', 'folder-icon', '📦'));
    main.appendChild(el('span', 'folder-name', folder.name));

    const matches = ideMatches.get(folder.id) || [];
    if (matches.length > 0) {
      const ideBtn = el('button', 'row-btn ide-btn', '🧰');
      ideBtn.title = matches.length === 1 ? `Open in ${ideMatchLabel(matches[0])}` : `Open in IDE (${matches.length} options)`;
      ideBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        handleIdeClick(folder, ideBtn);
      });
      main.appendChild(ideBtn);
    }

    const newBtn = el('button', 'row-btn', '+');
    newBtn.title = 'New session';
    newBtn.dataset.testid = 'new-session-btn';
    newBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      promptNewSession(folder);
    });
    main.appendChild(newBtn);

    const archiveBtn = el('button', 'row-btn', '🗄');
    archiveBtn.dataset.testid = 'archive-folder-btn';
    archiveBtn.title = 'Archive folder';
    archiveBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      archiveFolder(folder);
    });
    main.appendChild(archiveBtn);

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

      const searchRow = el('div', 'session-row');
      searchRow.dataset.testid = 'search-row';
      searchRow.dataset.folderId = folder.id;
      if (filesPanelState && filesPanelState.folderId === folder.id && filesPanelState.view === 'search' && (splitMode || singleModeShowing === 'files')) {
        searchRow.classList.add('selected');
      }
      searchRow.appendChild(el('span', 'status-dot', '🔎'));
      searchRow.appendChild(el('span', 'session-name', 'Search'));
      searchRow.addEventListener('click', () => openSearchForFolder(folder));
      folderListEl.appendChild(searchRow);

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
        killBtn.title = 'Close session';
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

  if (archivedFolders.length > 0) {
    const header = el('div', 'archived-header');
    header.dataset.testid = 'archived-header';
    header.appendChild(el('span', 'folder-arrow', archivedExpanded ? '▾' : '▸'));
    header.appendChild(el('span', 'archived-label', `Archived (${archivedFolders.length})`));
    header.addEventListener('click', () => {
      archivedExpanded = !archivedExpanded;
      renderSidebar();
    });
    folderListEl.appendChild(header);

    if (archivedExpanded) {
      for (const folder of archivedFolders) {
        const row = el('div', 'folder-row archived');
        row.dataset.testid = 'archived-folder-row';
        row.dataset.folderId = folder.id;
        const main = el('div', 'folder-main');
        main.appendChild(el('span', 'folder-icon', '📦'));
        main.appendChild(el('span', 'folder-name', folder.name));

        const unarchiveBtn = el('button', 'row-btn', '📤');
        unarchiveBtn.dataset.testid = 'unarchive-folder-btn';
        unarchiveBtn.title = 'Unarchive folder';
        unarchiveBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          unarchiveFolder(folder);
        });
        main.appendChild(unarchiveBtn);

        const trashBtn = el('button', 'row-btn', '✕');
        trashBtn.dataset.testid = 'remove-folder-btn';
        trashBtn.title = 'Remove folder';
        trashBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          removeFolder(folder);
        });
        main.appendChild(trashBtn);

        row.appendChild(main);
        folderListEl.appendChild(row);
      }
    }
  }
}

// Drag-and-drop folder reordering. Listeners live on the (stable) list
// container rather than per-row, since renderSidebar() rebuilds every row
// on each render.
let draggedFolderId = null;

folderListEl.addEventListener('dragstart', (ev) => {
  const row = ev.target.closest('[data-testid="folder-row"]');
  if (!row) {
    ev.preventDefault();
    return;
  }
  draggedFolderId = row.dataset.folderId;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', draggedFolderId);
  requestAnimationFrame(() => row.classList.add('dragging'));
});

folderListEl.addEventListener('dragend', () => {
  draggedFolderId = null;
  for (const row of folderListEl.querySelectorAll('.folder-row')) {
    row.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
  }
});

folderListEl.addEventListener('dragover', (ev) => {
  if (!draggedFolderId) return;
  const row = ev.target.closest('[data-testid="folder-row"]');
  if (!row || row.dataset.folderId === draggedFolderId) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const rect = row.getBoundingClientRect();
  const before = ev.clientY < rect.top + rect.height / 2;
  row.classList.toggle('drag-over-top', before);
  row.classList.toggle('drag-over-bottom', !before);
});

folderListEl.addEventListener('dragleave', (ev) => {
  const row = ev.target.closest('[data-testid="folder-row"]');
  if (row) row.classList.remove('drag-over-top', 'drag-over-bottom');
});

folderListEl.addEventListener('drop', async (ev) => {
  const row = ev.target.closest('[data-testid="folder-row"]');
  if (!draggedFolderId || !row || row.dataset.folderId === draggedFolderId) return;
  ev.preventDefault();
  const before = row.classList.contains('drag-over-top');
  row.classList.remove('drag-over-top', 'drag-over-bottom');

  const ids = state.folders.map((f) => f.id);
  const fromIdx = ids.indexOf(draggedFolderId);
  if (fromIdx === -1) return;
  ids.splice(fromIdx, 1);
  let toIdx = ids.indexOf(row.dataset.folderId);
  if (!before) toIdx += 1;
  ids.splice(toIdx, 0, draggedFolderId);

  const res = await ipcRenderer.invoke('app:reorder-folders', { orderedIds: ids });
  state = res.state;
  renderSidebar();
});

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
  searchPanelEl.classList.toggle('visible', hasFiles && filesPanelState.view === 'search');

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

// Sessions run over ConPTY (node-pty's default on Windows). Without telling
// xterm.js that, it falls back to a heuristic for line-wrap detection ("a
// line is wrapped if it doesn't end in whitespace") that misfires on most
// real output, corrupting multi-line copy/selection — lines that aren't
// actually wrapped get joined without a newline. Build number comes from
// `os.release()` (e.g. "10.0.26200" -> 26200); xterm only trusts ConPTY's
// own wrap tracking from build 21376 onward.
function windowsPtyOptions() {
  const buildNumber = Number(os.release().split('.')[2]);
  return { backend: 'conpty', buildNumber: Number.isFinite(buildNumber) ? buildNumber : 0 };
}

// Clipboard text wins when present (unchanged paste behavior). When the
// clipboard holds an image instead (e.g. a screenshot) with no text
// representation, save it to a temp PNG and paste its path as an @-reference
// so Claude Code (or any CLI reading its own prompt) can pick it up — same
// as typing a path by hand, just without the manual save-to-file step.
async function pasteIntoSession(sessionId) {
  const text = await navigator.clipboard.readText();
  if (text) {
    ipcRenderer.send('session:write', { sessionId, data: text });
    return;
  }
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const imageType = item.types.find((t) => t.startsWith('image/'));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    const data = new Uint8Array(await blob.arrayBuffer());
    const res = await ipcRenderer.invoke('clipboard:save-pasted-image', { data, ext: imageType.split('/')[1] });
    if (res.ok) ipcRenderer.send('session:write', { sessionId, data: `@"${res.filePath}" ` });
    return;
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
    windowsPty: windowsPtyOptions(),
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
      navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    if (key === 'v') {
      pasteIntoSession(sessionId);
      return false;
    }
    return true;
  });

  // Right-click copy/paste — the convention most Windows terminals (conhost,
  // Windows Terminal, PuTTY, ConEmu) use: with a selection, right-click
  // copies it and clears the selection; with no selection, it pastes. There
  // was no context-menu handling here at all before, so right-click did
  // nothing, which is easy to mistake for "copy is broken" if that's your
  // muscle memory instead of Ctrl+C.
  container.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
    } else {
      pasteIntoSession(sessionId);
    }
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

// ext -> how to run it: build(path) produces the command line to type into
// the session; shell pins the shell type it needs (omitted = folder's usual shell).
const SCRIPT_RUNNERS = {
  '.ps1': { shell: 'powershell', build: (p) => `& "${p}"` },
  '.bat': { shell: 'cmd', build: (p) => `"${p}"` },
  '.cmd': { shell: 'cmd', build: (p) => `"${p}"` },
  '.sh': { shell: 'bash', build: (p) => `"${p}"` },
  '.py': { build: (p) => `python "${p}"` },
  '.js': { build: (p) => `node "${p}"` },
  '.mjs': { build: (p) => `node "${p}"` },
  '.cjs': { build: (p) => `node "${p}"` },
  '.rb': { build: (p) => `ruby "${p}"` },
  '.pl': { build: (p) => `perl "${p}"` },
};

async function runScriptInNewSession(folder, filePath, runner) {
  const choice = await ipcRenderer.invoke('app:popup-menu', {
    items: [{ id: 'run', label: 'Run in New Session' }],
  });
  if (choice !== 'run') return;

  const command = runner.build(filePath);
  const shell = runner.shell || folder.lastShell;
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
      const runner = SCRIPT_RUNNERS[path.extname(entry.name).toLowerCase()];
      row.appendChild(el('span', 'fb-icon', isMd ? '📝' : '📄'));
      row.appendChild(el('span', 'fb-name', entry.name));
      row.addEventListener('click', () => {
        if (isMd) showMarkdownPreview(folder, full, dirPath);
        else if (isBinary) ipcRenderer.invoke('fs:open-external', { filePath: full });
        else openFileInEditor(folder, full, false);
      });
      if (runner) {
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          runScriptInNewSession(folder, full, runner);
        });
      }
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
    addCodeBlockCopyButtons(body);
  });
}

function addCodeBlockCopyButtons(body) {
  for (const pre of body.querySelectorAll('pre')) {
    const code = pre.querySelector('code') || pre;
    const btn = el('button', 'md-copy', 'Copy');
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(code.textContent);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    });
    pre.appendChild(btn);
  }
}

const sessionOverlay = document.getElementById('session-overlay');
const sessionShellSelect = document.getElementById('session-shell');
const sessionCommandInput = document.getElementById('session-command');
const sessionCancelBtn = document.getElementById('session-cancel');
const sessionStartBtn = document.getElementById('session-start');

function promptNewSession(folder) {
  sessionShellSelect.value = folder.lastShell || state.defaultShell || 'cmd';
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

  const entry = sessionTerms.get(sessionId);
  if (entry) {
    entry.term.dispose();
    entry.container.remove();
    sessionTerms.delete(sessionId);
  }
  if (activeSessionId === sessionId) {
    activeSessionId = null;
    if (singleModeShowing === 'session') singleModeShowing = 'placeholder';
  }

  applyLayout();
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
  ideMatches.delete(folder.id);
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

async function archiveFolder(folder) {
  if (!closeAllTabsForFolder(folder)) return;
  const res = await ipcRenderer.invoke('app:set-folder-archived', { folderId: folder.id, archived: true });
  state = res.state;

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

  applyLayout();
  renderSidebar();
}

async function unarchiveFolder(folder) {
  const res = await ipcRenderer.invoke('app:set-folder-archived', { folderId: folder.id, archived: false });
  state = res.state;
  renderSidebar();
  refreshGitInfo();
  refreshIdeMatches();
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
    refreshIdeMatches();
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
    refreshIdeMatches();
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
    refreshIdeMatches();
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

let webDriverEnabled = false;

async function setWebDriverEnabled(enabled) {
  const res = await ipcRenderer.invoke('app:toggle-web-driver', { enabled });
  if (!res.ok) {
    alert(`Could not start web driver: ${res.error}`);
    return;
  }
  webDriverEnabled = res.enabled;
  webDriverToggleBtn.classList.toggle('active', webDriverEnabled);
  webDriverBanner.classList.toggle('hidden', !webDriverEnabled);
  if (webDriverEnabled) {
    const host = res.lanAddress || '127.0.0.1';
    webDriverUrlInput.value = `http://${host}:${res.port}/?token=${res.token}`;
    webDriverCopyBtn.textContent = '📋 Copy to clipboard';
    if (res.hostname) {
      webDriverLocalHint.textContent =
        `Or, if your phone resolves mDNS names: http://${res.hostname}.local:${res.port}/?token=${res.token} ` +
        `(best effort — not guaranteed on every network/device).`;
      webDriverLocalHint.classList.remove('hidden');
    } else {
      webDriverLocalHint.classList.add('hidden');
    }
    const tailscaleHost = res.tailscaleDnsName || res.tailscaleAddress;
    if (tailscaleHost) {
      webDriverTailscaleHint.textContent =
        `Or, from outside this network via Tailscale: http://${tailscaleHost}:${res.port}/?token=${res.token} ` +
        `— worth saving once in the Android app's "Paired" list so you never need to re-copy it.`;
      webDriverTailscaleHint.classList.remove('hidden');
    } else {
      webDriverTailscaleHint.classList.add('hidden');
    }
    webDriverOverlay.classList.remove('hidden');
  }
}

webDriverToggleBtn.addEventListener('click', () => setWebDriverEnabled(!webDriverEnabled));
webDriverBannerOffBtn.addEventListener('click', () => setWebDriverEnabled(false));

webDriverCopyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(webDriverUrlInput.value);
  webDriverCopyBtn.textContent = '✓ Copied';
  setTimeout(() => {
    webDriverCopyBtn.textContent = '📋 Copy to clipboard';
  }, 1500);
});

webDriverCloseBtn.addEventListener('click', () => {
  webDriverOverlay.classList.add('hidden');
});

webDriverFixFirewallBtn.addEventListener('click', async () => {
  webDriverFixFirewallBtn.disabled = true;
  webDriverFixFirewallBtn.textContent = '🛡️ Waiting for admin approval…';
  const res = await ipcRenderer.invoke('app:add-firewall-rule');
  if (res.ok) {
    webDriverFixFirewallBtn.textContent = '✓ Allowed';
  } else {
    webDriverFixFirewallBtn.disabled = false;
    webDriverFixFirewallBtn.textContent = '🛡️ Allow network discovery';
    alert(`Could not update the firewall: ${res.error}`);
  }
});

let editingIdeRules = [];

function renderSettingsRules() {
  settingsRulesEl.innerHTML = '';
  for (const rule of editingIdeRules) {
    const row = el('div', 'settings-rule-row');

    const labelInput = document.createElement('input');
    labelInput.value = rule.label;
    labelInput.placeholder = 'Label';
    labelInput.addEventListener('input', () => {
      rule.label = labelInput.value;
    });
    row.appendChild(labelInput);

    const kindSelect = document.createElement('select');
    for (const [value, text] of [
      ['glob', 'Match files'],
      ['always', 'Always offered'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      if (rule.matchKind === value) opt.selected = true;
      kindSelect.appendChild(opt);
    }
    row.appendChild(kindSelect);

    const matchInput = document.createElement('input');
    matchInput.value = rule.match;
    matchInput.placeholder = 'e.g. *.sln or .idea';
    matchInput.disabled = rule.matchKind === 'always';
    matchInput.addEventListener('input', () => {
      rule.match = matchInput.value;
    });
    row.appendChild(matchInput);

    kindSelect.addEventListener('change', () => {
      rule.matchKind = kindSelect.value;
      matchInput.disabled = rule.matchKind === 'always';
    });

    const commandInput = document.createElement('input');
    commandInput.value = rule.command;
    commandInput.placeholder = 'e.g. code {folder}';
    commandInput.addEventListener('input', () => {
      rule.command = commandInput.value;
    });
    row.appendChild(commandInput);

    const removeBtn = el('button', 'settings-rule-remove', '✕');
    removeBtn.title = 'Remove rule';
    removeBtn.addEventListener('click', () => {
      editingIdeRules = editingIdeRules.filter((r) => r !== rule);
      renderSettingsRules();
    });
    row.appendChild(removeBtn);

    settingsRulesEl.appendChild(row);
  }
}

let trustedDevicesList = [];

function formatTimestamp(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function renderSettingsDevices() {
  settingsDevicesEl.innerHTML = '';
  if (trustedDevicesList.length === 0) {
    settingsDevicesEl.appendChild(el('div', 'settings-devices-empty', 'No paired devices yet.'));
    return;
  }
  for (const device of trustedDevicesList) {
    const row = el('div', 'settings-device-row');
    row.appendChild(el('span', '', device.name));
    row.appendChild(el('span', '', formatTimestamp(device.pairedAt)));
    row.appendChild(el('span', '', formatTimestamp(device.lastSeenAt)));

    const revokeBtn = el('button', 'settings-device-revoke', '✕');
    revokeBtn.title = 'Revoke';
    revokeBtn.addEventListener('click', async () => {
      const res = await ipcRenderer.invoke('app:revoke-trusted-device', { id: device.id });
      trustedDevicesList = res.devices || [];
      renderSettingsDevices();
    });
    row.appendChild(revokeBtn);

    settingsDevicesEl.appendChild(row);
  }
}

settingsBtn.addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('app:get-ide-rules');
  editingIdeRules = (res.rules || []).map((r) => ({ ...r }));
  renderSettingsRules();
  settingsDefaultShellSelect.value = res.defaultShell || 'cmd';
  const devicesRes = await ipcRenderer.invoke('app:get-trusted-devices');
  trustedDevicesList = devicesRes.devices || [];
  renderSettingsDevices();
  settingsOverlay.classList.remove('hidden');
});

settingsAddRuleBtn.addEventListener('click', () => {
  editingIdeRules.push({ id: crypto.randomUUID(), label: '', matchKind: 'glob', match: '', command: '' });
  renderSettingsRules();
});

settingsCancelBtn.addEventListener('click', () => {
  settingsOverlay.classList.add('hidden');
});

settingsSaveBtn.addEventListener('click', async () => {
  const cleaned = editingIdeRules
    .map((r) => ({ ...r, label: r.label.trim(), match: r.match.trim(), command: r.command.trim() }))
    .filter((r) => r.label && r.command && (r.matchKind === 'always' || r.match));
  const res = await ipcRenderer.invoke('app:save-ide-rules', {
    rules: cleaned,
    defaultShell: settingsDefaultShellSelect.value,
  });
  if (state) state.defaultShell = res.defaultShell;
  settingsOverlay.classList.add('hidden');
  refreshIdeMatches();
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
  refreshIdeMatches();
  setInterval(refreshGitInfo, 10000);
})();
