// --- Full-text "Search" panel (per folder, like the Files/Git panels) ---

let searchPanelState = null; // { folderId, query, caseSensitive, results, loading, error }
let searchDebounceTimer = null;

function openSearchForFolder(folder) {
  filesPanelState = { folderId: folder.id, view: 'search' };
  searchPanelState = { folderId: folder.id, query: '', caseSensitive: false, results: null, loading: false, error: null };
  singleModeShowing = 'files';
  applyLayout();
  renderSidebar();
  renderSearchPanel(folder);
}

function renderSearchPanel(folder) {
  if (!searchPanelState || searchPanelState.folderId !== folder.id) return;
  searchPanelEl.innerHTML = '';

  const header = el('div', 'search-panel-header');

  const backBtn = el('button', 'md-back', '← Back to files');
  backBtn.addEventListener('click', () => showFilesListing(folder, folderBrowseDir.get(folder.id) || folder.path));
  header.appendChild(backBtn);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'search-panel-input';
  input.placeholder = 'Search in files...';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = searchPanelState.query;
  input.addEventListener('input', () => {
    searchPanelState.query = input.value;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => runFolderSearch(folder), 250);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') showFilesListing(folder, folderBrowseDir.get(folder.id) || folder.path);
  });
  header.appendChild(input);

  const caseBtn = el('button', 'search-case-btn' + (searchPanelState.caseSensitive ? ' active' : ''), 'Aa');
  caseBtn.title = 'Match case';
  caseBtn.addEventListener('click', () => {
    searchPanelState.caseSensitive = !searchPanelState.caseSensitive;
    renderSearchPanel(folder);
    if (searchPanelState.query) runFolderSearch(folder);
  });
  header.appendChild(caseBtn);

  searchPanelEl.appendChild(header);

  const body = el('div', 'search-panel-body');
  searchPanelEl.appendChild(body);

  if (searchPanelState.loading) {
    body.appendChild(el('div', 'empty-hint', 'Searching…'));
  } else if (searchPanelState.error) {
    body.appendChild(el('div', 'empty-hint', searchPanelState.error));
  } else if (!searchPanelState.query) {
    body.appendChild(el('div', 'empty-hint', 'Type to search file contents in this folder.'));
  } else if (searchPanelState.results && searchPanelState.results.length === 0) {
    body.appendChild(el('div', 'empty-hint', 'No matches.'));
  } else if (searchPanelState.results) {
    renderSearchResults(folder, body, searchPanelState.results);
  }

  const focusInput = searchPanelEl.querySelector('.search-panel-input');
  if (focusInput) {
    const pos = focusInput.value.length;
    focusInput.focus();
    focusInput.setSelectionRange(pos, pos);
  }
}

function renderSearchResults(folder, body, results) {
  const matchLen = searchPanelState.query.length;
  const byFile = new Map();
  for (const r of results) {
    if (!byFile.has(r.relPath)) byFile.set(r.relPath, []);
    byFile.get(r.relPath).push(r);
  }

  for (const [relPath, matches] of byFile) {
    const group = el('div', 'search-file-group');

    const groupHeader = el('div', 'search-file-header');
    groupHeader.appendChild(el('span', 'fb-icon', '📄'));
    groupHeader.appendChild(el('span', 'search-file-path', relPath));
    groupHeader.appendChild(el('span', 'search-file-count', String(matches.length)));
    group.appendChild(groupHeader);

    for (const m of matches) {
      const row = el('div', 'search-match-row');
      row.appendChild(el('span', 'search-match-line', String(m.line)));

      const snippet = el('span', 'search-match-text');
      snippet.appendChild(document.createTextNode(m.text.slice(0, m.col)));
      snippet.appendChild(el('mark', null, m.text.slice(m.col, m.col + matchLen)));
      snippet.appendChild(document.createTextNode(m.text.slice(m.col + matchLen)));
      row.appendChild(snippet);

      row.addEventListener('click', () => openSearchResult(folder, m));
      group.appendChild(row);
    }

    body.appendChild(group);
  }
}

async function runFolderSearch(folder) {
  if (!searchPanelState || searchPanelState.folderId !== folder.id) return;
  const query = searchPanelState.query;
  if (!query) {
    searchPanelState.results = null;
    renderSearchPanel(folder);
    return;
  }

  searchPanelState.loading = true;
  searchPanelState.error = null;
  renderSearchPanel(folder);

  const res = await ipcRenderer.invoke('fs:search-text', {
    dirPath: folder.path,
    query,
    caseSensitive: searchPanelState.caseSensitive,
  });

  if (!searchPanelState || searchPanelState.folderId !== folder.id || searchPanelState.query !== query) return;
  searchPanelState.loading = false;
  if (!res.ok) searchPanelState.error = res.error;
  else searchPanelState.results = res.results;
  renderSearchPanel(folder);
}

async function openSearchResult(folder, result) {
  const isMd = /\.(md|markdown)$/i.test(result.relPath);
  await openFileInEditor(folder, result.absPath, isMd);
  revealLineInEditor(folder, result.absPath, result.line, result.col);
}

// --- Quick-open file palette (Ctrl+P), scoped to the folder currently in view ---

const quickOpenOverlay = document.getElementById('quickopen-overlay');
const quickOpenInput = document.getElementById('quickopen-input');
const quickOpenResultsEl = document.getElementById('quickopen-results');

let quickOpenFolder = null;
let quickOpenItems = [];
let quickOpenSelected = 0;
let quickOpenDebounceTimer = null;

function currentFolderForSearch() {
  if (filesPanelState) {
    const f = state.folders.find((x) => x.id === filesPanelState.folderId);
    if (f) return f;
  }
  if (activeSessionId) {
    const f = state.folders.find((x) => x.sessions.some((s) => s.id === activeSessionId));
    if (f) return f;
  }
  return state.folders.find((f) => !f.archived) || null;
}

function openQuickOpen(folder) {
  quickOpenFolder = folder;
  quickOpenItems = [];
  quickOpenSelected = 0;
  quickOpenInput.value = '';
  quickOpenResultsEl.innerHTML = '';
  quickOpenOverlay.classList.remove('hidden');
  quickOpenInput.focus();
  runQuickOpenQuery('');
}

function closeQuickOpen() {
  quickOpenOverlay.classList.add('hidden');
  quickOpenFolder = null;
}

async function runQuickOpenQuery(query) {
  const folder = quickOpenFolder;
  if (!folder) return;
  const res = await ipcRenderer.invoke('fs:search-files', { dirPath: folder.path, query });
  if (quickOpenFolder !== folder) return;

  if (!res.ok) {
    quickOpenItems = [];
    quickOpenResultsEl.innerHTML = '';
    quickOpenResultsEl.appendChild(el('div', 'qo-empty', res.error));
    return;
  }

  quickOpenItems = res.results;
  quickOpenSelected = 0;
  renderQuickOpenResults();
}

function renderQuickOpenResults() {
  quickOpenResultsEl.innerHTML = '';
  if (quickOpenItems.length === 0) {
    quickOpenResultsEl.appendChild(el('div', 'qo-empty', 'No matching files'));
    return;
  }

  quickOpenItems.forEach((item, i) => {
    const dir = path.dirname(item.relPath);
    const row = el('div', 'qo-row' + (i === quickOpenSelected ? ' selected' : ''));
    row.appendChild(el('span', 'qo-name', basename(item.relPath)));
    row.appendChild(el('span', 'qo-path', dir === '.' ? '' : dir));
    row.addEventListener('mouseenter', () => {
      quickOpenSelected = i;
      renderQuickOpenResults();
    });
    row.addEventListener('click', () => chooseQuickOpenItem(i));
    quickOpenResultsEl.appendChild(row);
  });

  const sel = quickOpenResultsEl.children[quickOpenSelected];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function chooseQuickOpenItem(i) {
  const item = quickOpenItems[i];
  const folder = quickOpenFolder;
  if (!item || !folder) return;
  closeQuickOpen();
  const isMd = /\.(md|markdown)$/i.test(item.relPath);
  if (isMd) showMarkdownPreview(folder, item.absPath, path.dirname(item.absPath));
  else openFileInEditor(folder, item.absPath, false);
}

quickOpenInput.addEventListener('input', () => {
  clearTimeout(quickOpenDebounceTimer);
  const query = quickOpenInput.value;
  quickOpenDebounceTimer = setTimeout(() => runQuickOpenQuery(query), 120);
});

quickOpenInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    closeQuickOpen();
  } else if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    if (quickOpenItems.length) {
      quickOpenSelected = Math.min(quickOpenSelected + 1, quickOpenItems.length - 1);
      renderQuickOpenResults();
    }
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (quickOpenItems.length) {
      quickOpenSelected = Math.max(quickOpenSelected - 1, 0);
      renderQuickOpenResults();
    }
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    chooseQuickOpenItem(quickOpenSelected);
  }
});

quickOpenOverlay.addEventListener('click', (ev) => {
  if (ev.target === quickOpenOverlay) closeQuickOpen();
});

// Global shortcuts: Ctrl/Cmd+P (quick open), Ctrl/Cmd+Shift+F (search in files).
// Ignored while a terminal has focus so shell history shortcuts (e.g. bash/PSReadLine's
// own Ctrl+P) keep working as expected.
document.addEventListener('keydown', (ev) => {
  const mod = ev.ctrlKey || ev.metaKey;
  if (!mod) return;
  if (ev.target && ev.target.closest && ev.target.closest('#slot-terminal')) return;

  const key = ev.key.toLowerCase();
  if (key === 'p' && !ev.shiftKey) {
    const folder = currentFolderForSearch();
    if (!folder) return;
    ev.preventDefault();
    openQuickOpen(folder);
  } else if (key === 'f' && ev.shiftKey) {
    const folder = currentFolderForSearch();
    if (!folder) return;
    ev.preventDefault();
    openSearchForFolder(folder);
  }
});
