let gitPanelState = null; // { folderId, branches, status, selectedFile, selectedStaged, selectedUntracked, selectedConflicted, selectedChange, selectedDiffText, busy, errorText }

const commitOverlay = document.getElementById('commit-overlay');
const commitStagedCountEl = document.getElementById('commit-staged-count');
const commitMessageInput = document.getElementById('commit-message');
const commitCancelBtn = document.getElementById('commit-cancel');
const commitSubmitBtn = document.getElementById('commit-submit');
let commitModalFolder = null;

const branchOverlay = document.getElementById('branch-overlay');
const branchNameInput = document.getElementById('branch-name');
const branchCancelBtn = document.getElementById('branch-cancel');
const branchSubmitBtn = document.getElementById('branch-submit');
let branchModalFolder = null;

async function openGitForFolder(folder) {
  filesPanelState = { folderId: folder.id, view: 'git' };
  gitPanelState = {
    folderId: folder.id,
    branches: null,
    status: null,
    selectedFile: null,
    selectedStaged: false,
    selectedUntracked: false,
    selectedConflicted: false,
    selectedChange: null,
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
      gitPanelState.selectedChange = null;
      gitPanelState.selectedConflicted = false;
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

  const branchBtn = el('button', 'git-panel-btn', '+ Branch');
  branchBtn.disabled = !!gitPanelState.busy;
  branchBtn.addEventListener('click', () => openBranchModal(folder));
  header.appendChild(branchBtn);

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
  body.appendChild(renderDiffView(folder));
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

  if (code !== 'conflicted') {
    const revertBtn = el('button', 'git-revert-file-btn', '↺');
    revertBtn.title = 'Discard changes to this file';
    revertBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      revertChange(folder, change);
    });
    row.appendChild(revertBtn);
  }

  row.addEventListener('click', () => selectChangeForDiff(folder, change));
  return row;
}

async function revertChange(folder, change) {
  const ok = confirm(`Discard changes to "${change.path}"?\n\nThis cannot be undone.`);
  if (!ok) return;
  const res = await ipcRenderer.invoke('git:discard-file', {
    dirPath: folder.path,
    relPath: change.path,
    worktreeStatus: change.worktreeStatus,
    indexStatus: change.indexStatus,
    origPath: change.origPath,
  });
  if (!res.ok) {
    gitPanelState.errorText = res.error;
  } else if (gitPanelState.selectedFile === change.path) {
    gitPanelState.selectedFile = null;
    gitPanelState.selectedChange = null;
    gitPanelState.selectedDiffText = null;
  }
  await refreshGitPanel(folder);
  refreshGitInfo();
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
  gitPanelState.selectedConflicted = change.worktreeStatus === 'conflicted' || change.indexStatus === 'conflicted';
  gitPanelState.selectedChange = change;
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

// Splits a single-file diff into its header lines (everything before the
// first "@@" hunk marker) and a list of hunks, each carrying its own "@@"
// line plus the +/- /context lines that follow it. Needed so a hunk can be
// re-assembled with the header into a standalone patch for `git apply`.
function parseDiffHunks(diffText) {
  const lines = diffText.split('\n');
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  if (firstHunk === -1) return { header: lines, hunks: [] };
  const header = lines.slice(0, firstHunk);
  const hunks = [];
  let current = null;
  for (let i = firstHunk; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      if (current) hunks.push(current);
      current = { headerLine: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  return { header, hunks };
}

function buildHunkPatch(header, hunk) {
  const lines = [...header, hunk.headerLine, ...hunk.lines];
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

function renderDiffView(folder) {
  const wrap = el('div', 'git-diff-wrap');

  if (gitPanelState.selectedFile) {
    const toolbar = el('div', 'git-diff-toolbar');
    toolbar.appendChild(el('span', 'git-diff-toolbar-path', gitPanelState.selectedFile));
    if (!gitPanelState.selectedConflicted) {
      const revertFileBtn = el('button', 'git-diff-revert-btn', '↺ Revert File');
      revertFileBtn.addEventListener('click', () => revertChange(folder, gitPanelState.selectedChange));
      toolbar.appendChild(revertFileBtn);
    }
    wrap.appendChild(toolbar);
  }

  const body = el('div', 'git-diff-view');

  if (!gitPanelState.selectedFile) {
    body.textContent = 'Select a file to view its diff.';
  } else if (gitPanelState.selectedDiffText === null) {
    body.textContent = 'Loading diff…';
  } else if (gitPanelState.selectedDiffText === '') {
    body.textContent = '(no textual diff)';
  } else {
    const { header, hunks } = parseDiffHunks(gitPanelState.selectedDiffText);
    const canRevertHunks = !gitPanelState.selectedUntracked && !gitPanelState.selectedConflicted;
    for (const hunk of hunks) {
      const hunkBlock = el('div', 'git-diff-hunk-block');

      const hunkHeaderRow = el('div', 'git-diff-hunk-header-row');
      hunkHeaderRow.appendChild(el('span', 'git-diff-hunk', hunk.headerLine));
      if (canRevertHunks) {
        const revertHunkBtn = el('button', 'git-diff-revert-hunk-btn', '↺ Revert Hunk');
        revertHunkBtn.addEventListener('click', () => doRevertHunk(folder, header, hunk));
        hunkHeaderRow.appendChild(revertHunkBtn);
      }
      hunkBlock.appendChild(hunkHeaderRow);

      for (const line of hunk.lines) {
        const lineEl = document.createElement('span');
        if (line.startsWith('+') && !line.startsWith('+++')) lineEl.className = 'git-diff-add';
        else if (line.startsWith('-') && !line.startsWith('---')) lineEl.className = 'git-diff-del';
        lineEl.textContent = `${line}\n`;
        hunkBlock.appendChild(lineEl);
      }
      body.appendChild(hunkBlock);
    }
  }
  wrap.appendChild(body);
  return wrap;
}

async function doRevertHunk(folder, header, hunk) {
  const patch = buildHunkPatch(header, hunk);
  const relPath = gitPanelState.selectedFile;
  const staged = gitPanelState.selectedStaged;
  const res = await ipcRenderer.invoke('git:revert-hunk', { dirPath: folder.path, relPath, patch, staged });
  if (!res.ok) {
    gitPanelState.errorText = res.error;
    renderGitPanel(folder);
    return;
  }
  await refreshGitPanel(folder);
  const stillThere = gitPanelState.status.changes.find((c) => c.path === relPath && c.staged === staged);
  if (stillThere) await selectChangeForDiff(folder, stillThere);
  refreshGitInfo();
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

function openBranchModal(folder) {
  branchModalFolder = folder;
  branchNameInput.value = '';
  branchSubmitBtn.disabled = true;
  branchOverlay.classList.remove('hidden');
  branchNameInput.focus();
}

function closeBranchModal() {
  branchOverlay.classList.add('hidden');
  branchModalFolder = null;
}

branchNameInput.addEventListener('input', () => {
  branchSubmitBtn.disabled = !branchNameInput.value.trim();
});

branchCancelBtn.addEventListener('click', () => closeBranchModal());

branchOverlay.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeBranchModal();
  if (ev.key === 'Enter' && !branchSubmitBtn.disabled) branchSubmitBtn.click();
});

branchSubmitBtn.addEventListener('click', async () => {
  const folder = branchModalFolder;
  if (!folder) return;
  const name = branchNameInput.value.trim();
  if (!name) return;
  branchSubmitBtn.disabled = true;
  const res = await ipcRenderer.invoke('git:create-branch', { dirPath: folder.path, name });
  branchSubmitBtn.disabled = false;
  if (!res.ok) {
    closeBranchModal();
    gitPanelState.errorText = res.error;
    renderGitPanel(folder);
    return;
  }
  closeBranchModal();
  gitPanelState.selectedFile = null;
  gitPanelState.selectedChange = null;
  gitPanelState.selectedDiffText = null;
  await refreshGitPanel(folder);
  refreshGitInfo();
});
