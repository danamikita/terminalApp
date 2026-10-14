let gitPanelState = null; // { folderId, branches, status, selectedFile, selectedStaged, selectedUntracked, selectedDiffText, busy, errorText }

const commitOverlay = document.getElementById('commit-overlay');
const commitStagedCountEl = document.getElementById('commit-staged-count');
const commitMessageInput = document.getElementById('commit-message');
const commitCancelBtn = document.getElementById('commit-cancel');
const commitSubmitBtn = document.getElementById('commit-submit');
let commitModalFolder = null;

async function openGitForFolder(folder) {
  filesPanelState = { folderId: folder.id, view: 'git' };
  gitPanelState = {
    folderId: folder.id,
    branches: null,
    status: null,
    selectedFile: null,
    selectedStaged: false,
    selectedUntracked: false,
    selectedDiffText: null,
    busy: null,
    errorText: null,
  };
  singleModeShowing = 'files';
  applyLayout();
  renderSidebar();
  await refreshGitPanel(folder);
}

async function refreshGitPanel(folder) {
  if (!gitPanelState || gitPanelState.folderId !== folder.id) return;
  const [branches, status] = await Promise.all([
    ipcRenderer.invoke('git:list-branches', { dirPath: folder.path }),
    ipcRenderer.invoke('git:status', { dirPath: folder.path }),
  ]);
  if (!gitPanelState || gitPanelState.folderId !== folder.id) return;
  gitPanelState.branches = branches;
  gitPanelState.status = status;
  if (gitPanelState.selectedFile) {
    const stillExists = status.changes.some(
      (c) => c.path === gitPanelState.selectedFile && c.staged === gitPanelState.selectedStaged
    );
    if (!stillExists) {
      gitPanelState.selectedFile = null;
      gitPanelState.selectedDiffText = null;
    }
  }
  renderGitPanel(folder);
}

function renderGitPanel(folder) {
  if (!gitPanelState) return;
  gitPanelEl.innerHTML = '';

  const header = el('div', 'git-panel-header');

  const select = document.createElement('select');
  const branches = gitPanelState.branches;
  if (branches) {
    const names = branches.locals.includes(branches.current) ? branches.locals : [branches.current, ...branches.locals];
    for (const b of names) {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      if (b === branches.current) opt.selected = true;
      select.appendChild(opt);
    }
  }
  select.disabled = !!gitPanelState.busy;
  select.addEventListener('change', () => doCheckout(folder, select.value));
  header.appendChild(select);

  const pullBtn = el('button', 'git-panel-btn', gitPanelState.busy === 'pull' ? 'Pulling…' : '⬇ Pull');
  pullBtn.disabled = !!gitPanelState.busy;
  pullBtn.addEventListener('click', () => doPull(folder));
  header.appendChild(pullBtn);

  const pushBtn = el('button', 'git-panel-btn', gitPanelState.busy === 'push' ? 'Pushing…' : '⬆ Push');
  pushBtn.disabled = !!gitPanelState.busy;
  pushBtn.addEventListener('click', () => doPush(folder));
  header.appendChild(pushBtn);

  const stagedCount = gitPanelState.status ? gitPanelState.status.changes.filter((c) => c.staged).length : 0;
  const commitBtn = el('button', 'git-panel-btn primary', '✓ Commit');
  commitBtn.disabled = !!gitPanelState.busy || stagedCount === 0;
  commitBtn.addEventListener('click', () => openCommitModal(folder));
  header.appendChild(commitBtn);

  gitPanelEl.appendChild(header);

  if (gitPanelState.errorText) {
    const errBox = el('div', 'git-panel-error');
    errBox.appendChild(el('span', '', gitPanelState.errorText));
    const dismiss = el('button', 'git-panel-error-dismiss', '×');
    dismiss.addEventListener('click', () => {
      gitPanelState.errorText = null;
      renderGitPanel(folder);
    });
    errBox.appendChild(dismiss);
    gitPanelEl.appendChild(errBox);
  }

  const body = el('div', 'git-panel-body');
  body.appendChild(renderChangeList(folder));
  body.appendChild(renderDiffView());
  gitPanelEl.appendChild(body);
}

function statusLabel(code) {
  switch (code) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'untracked':
      return 'U';
    case 'conflicted':
      return '!';
    default:
      return '';
  }
}

function renderChangeList(folder) {
  const container = el('div', 'git-change-list');
  const changes = (gitPanelState.status && gitPanelState.status.changes) || [];
  if (changes.length === 0) {
    container.appendChild(el('div', 'git-change-empty', 'No changes.'));
    return container;
  }

  const staged = changes.filter((c) => c.staged);
  const unstaged = changes.filter((c) => !c.staged);

  if (staged.length > 0) {
    container.appendChild(el('div', 'git-change-group-label', `Staged (${staged.length})`));
    for (const c of staged) container.appendChild(renderChangeRow(folder, c));
  }
  if (unstaged.length > 0) {
    container.appendChild(el('div', 'git-change-group-label', `Changes (${unstaged.length})`));
    for (const c of unstaged) container.appendChild(renderChangeRow(folder, c));
  }
  return container;
}

function renderChangeRow(folder, change) {
  const row = el('div', 'git-change-row');
  const isSelected = gitPanelState.selectedFile === change.path && gitPanelState.selectedStaged === change.staged;
  if (isSelected) row.classList.add('selected');

  const code = change.staged ? change.indexStatus : change.worktreeStatus;
  row.appendChild(el('span', `git-status-badge git-status-${code}`, statusLabel(code)));

  if (code !== 'conflicted') {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = change.staged;
    checkbox.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleStage(folder, change);
    });
    row.appendChild(checkbox);
  }

  row.appendChild(el('span', 'git-change-path', change.path));
  row.addEventListener('click', () => selectChangeForDiff(folder, change));
  return row;
}

async function toggleStage(folder, change) {
  const channel = change.staged ? 'git:unstage' : 'git:stage';
  const res = await ipcRenderer.invoke(channel, { dirPath: folder.path, relPath: change.path });
  if (!res.ok) gitPanelState.errorText = res.error;
  await refreshGitPanel(folder);
  refreshGitInfo();
}

async function selectChangeForDiff(folder, change) {
  gitPanelState.selectedFile = change.path;
  gitPanelState.selectedStaged = change.staged;
  gitPanelState.selectedUntracked = change.worktreeStatus === 'untracked';
  gitPanelState.selectedDiffText = null;
  renderGitPanel(folder);

  const res = await ipcRenderer.invoke('git:diff', {
    dirPath: folder.path,
    relPath: change.path,
    staged: change.staged,
    untracked: gitPanelState.selectedUntracked,
  });
  if (!gitPanelState || gitPanelState.selectedFile !== change.path || gitPanelState.selectedStaged !== change.staged) return;
  gitPanelState.selectedDiffText = res.diff || '';
  renderGitPanel(folder);
}

function renderDiffView() {
  const pre = document.createElement('pre');
  pre.className = 'git-diff-view';
  if (!gitPanelState.selectedFile) {
    pre.textContent = 'Select a file to view its diff.';
  } else if (gitPanelState.selectedDiffText === null) {
    pre.textContent = 'Loading diff…';
  } else if (gitPanelState.selectedDiffText === '') {
    pre.textContent = '(no textual diff)';
  } else {
    for (const line of gitPanelState.selectedDiffText.split('\n')) {
      const lineEl = document.createElement('span');
      if (line.startsWith('+') && !line.startsWith('+++')) lineEl.className = 'git-diff-add';
      else if (line.startsWith('-') && !line.startsWith('---')) lineEl.className = 'git-diff-del';
      else if (line.startsWith('@@')) lineEl.className = 'git-diff-hunk';
      lineEl.textContent = `${line}\n`;
      pre.appendChild(lineEl);
    }
  }
  return pre;
}

async function doCheckout(folder, branch) {
  gitPanelState.busy = 'checkout';
  gitPanelState.errorText = null;
  renderGitPanel(folder);
  const res = await ipcRenderer.invoke('git:checkout-branch', { dirPath: folder.path, branch });
  gitPanelState.busy = null;
  if (!res.ok) {
    gitPanelState.errorText = res.error;
    renderGitPanel(folder);
    return;
  }
  gitPanelState.selectedFile = null;
  gitPanelState.selectedDiffText = null;
  await refreshGitPanel(folder);
  refreshGitInfo();
}

async function doPull(folder) {
  gitPanelState.busy = 'pull';
  gitPanelState.errorText = null;
  renderGitPanel(folder);
  const res = await ipcRenderer.invoke('git:pull', { dirPath: folder.path });
  gitPanelState.busy = null;
  if (!res.ok) gitPanelState.errorText = res.error;
  await refreshGitPanel(folder);
  refreshGitInfo();
}

async function doPush(folder) {
  gitPanelState.busy = 'push';
  gitPanelState.errorText = null;
  renderGitPanel(folder);
  const res = await ipcRenderer.invoke('git:push', { dirPath: folder.path });
  gitPanelState.busy = null;
  if (!res.ok) gitPanelState.errorText = res.error;
  await refreshGitPanel(folder);
  refreshGitInfo();
}

function openCommitModal(folder) {
  commitModalFolder = folder;
  const stagedCount = gitPanelState.status ? gitPanelState.status.changes.filter((c) => c.staged).length : 0;
  commitStagedCountEl.textContent = `${stagedCount} file${stagedCount === 1 ? '' : 's'} staged`;
  commitMessageInput.value = '';
  commitSubmitBtn.disabled = true;
  commitOverlay.classList.remove('hidden');
  commitMessageInput.focus();
}

function closeCommitModal() {
  commitOverlay.classList.add('hidden');
  commitModalFolder = null;
}

commitMessageInput.addEventListener('input', () => {
  commitSubmitBtn.disabled = !commitMessageInput.value.trim();
});

commitCancelBtn.addEventListener('click', () => closeCommitModal());

commitOverlay.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeCommitModal();
});

commitSubmitBtn.addEventListener('click', async () => {
  const folder = commitModalFolder;
  if (!folder) return;
  const message = commitMessageInput.value.trim();
  if (!message) return;
  commitSubmitBtn.disabled = true;
  const res = await ipcRenderer.invoke('git:commit', { dirPath: folder.path, message });
  commitSubmitBtn.disabled = false;
  if (!res.ok) {
    closeCommitModal();
    gitPanelState.errorText = res.error;
    renderGitPanel(folder);
    return;
  }
  closeCommitModal();
  await refreshGitPanel(folder);
  refreshGitInfo();
});
