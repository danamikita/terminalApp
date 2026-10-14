const { EditorView, basicSetup } = require('codemirror');
const { EditorState } = require('@codemirror/state');
const { keymap } = require('@codemirror/view');
const { javascript } = require('@codemirror/lang-javascript');
const { json } = require('@codemirror/lang-json');
const { css } = require('@codemirror/lang-css');
const { html } = require('@codemirror/lang-html');
const { python } = require('@codemirror/lang-python');
const { markdown } = require('@codemirror/lang-markdown');
const { xml } = require('@codemirror/lang-xml');
const { yaml } = require('@codemirror/lang-yaml');
const { sql } = require('@codemirror/lang-sql');
const { rust } = require('@codemirror/lang-rust');
const { go } = require('@codemirror/lang-go');
const { cpp } = require('@codemirror/lang-cpp');
const { java } = require('@codemirror/lang-java');
const { php } = require('@codemirror/lang-php');

// folderId -> Map(filePath -> { cmView, container, dirty, isMarkdown })
const editorTabs = new Map();
// folderId -> filePath of the active tab
const activeEditorTab = new Map();

let editorToolbarEl = null;
let editorHostsEl = null;

function languageExtensionFor(filePath, isMarkdown) {
  if (isMarkdown) return [markdown()];
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'ts':
      return [javascript({ typescript: true })];
    case 'tsx':
      return [javascript({ typescript: true, jsx: true })];
    case 'js':
    case 'mjs':
    case 'cjs':
      return [javascript()];
    case 'jsx':
      return [javascript({ jsx: true })];
    case 'json':
      return [json()];
    case 'css':
      return [css()];
    case 'html':
    case 'htm':
      return [html()];
    case 'py':
      return [python()];
    case 'md':
    case 'markdown':
      return [markdown()];
    case 'xml':
      return [xml()];
    case 'yml':
    case 'yaml':
      return [yaml()];
    case 'sql':
      return [sql()];
    case 'rs':
      return [rust()];
    case 'go':
      return [go()];
    case 'c':
    case 'h':
    case 'cpp':
    case 'cc':
    case 'hpp':
      return [cpp()];
    case 'java':
      return [java()];
    case 'php':
      return [php()];
    default:
      return [];
  }
}

function buildEditorTheme() {
  return EditorView.theme(
    {
      '&': { backgroundColor: '#1e1e1e', color: '#d4d4d4', height: '100%', fontSize: '13px' },
      '.cm-content': { caretColor: '#fff', fontFamily: 'Consolas, "Courier New", monospace' },
      '.cm-cursor': { borderLeftColor: '#fff' },
      '.cm-gutters': { backgroundColor: '#1e1e1e', color: '#6e7681', border: 'none' },
      '.cm-activeLine': { backgroundColor: '#2a2d2e' },
      '.cm-activeLineGutter': { backgroundColor: '#2a2d2e' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#264f78 !important' },
      '&.cm-focused': { outline: 'none' },
    },
    { dark: true }
  );
}

function ensureEditorScaffold() {
  if (editorToolbarEl) return;
  editorToolbarEl = el('div', 'editor-toolbar');
  editorHostsEl = el('div', 'editor-hosts');
  editorPaneEl.appendChild(editorToolbarEl);
  editorPaneEl.appendChild(editorHostsEl);
}

async function openFileInEditor(folder, filePath, isMarkdown) {
  if (!editorTabs.has(folder.id)) editorTabs.set(folder.id, new Map());
  const tabs = editorTabs.get(folder.id);

  filesPanelState = { folderId: folder.id, view: 'editor' };
  singleModeShowing = 'files';

  if (tabs.has(filePath)) {
    activeEditorTab.set(folder.id, filePath);
    applyLayout();
    renderSidebar();
    renderEditorPane(folder);
    const tab = tabs.get(filePath);
    if (tab.cmView) tab.cmView.focus();
    return;
  }

  ensureEditorScaffold();
  const container = el('div', 'editor-tab-host');
  editorHostsEl.appendChild(container);
  tabs.set(filePath, { cmView: null, container, dirty: false, isMarkdown });
  activeEditorTab.set(folder.id, filePath);
  applyLayout();
  renderSidebar();
  renderEditorPane(folder);

  const res = await ipcRenderer.invoke('fs:read-file', { filePath });
  if (!tabs.get(filePath)) return; // tab was closed while loading

  if (!res.ok) {
    container.textContent = `Error: ${res.error}`;
    return;
  }

  const extensions = [
    basicSetup,
    ...languageExtensionFor(filePath, isMarkdown),
    buildEditorTheme(),
    keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          saveActiveTab(folder);
          return true;
        },
      },
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const tab = tabs.get(filePath);
        if (tab && !tab.dirty) {
          tab.dirty = true;
          if (filesPanelState && filesPanelState.view === 'editor' && filesPanelState.folderId === folder.id) {
            renderEditorPane(folder);
          }
        }
      }
    }),
  ];

  const editorState = EditorState.create({ doc: res.content, extensions });
  const cmView = new EditorView({ state: editorState, parent: container });
  tabs.get(filePath).cmView = cmView;
  if (filesPanelState && filesPanelState.view === 'editor' && filesPanelState.folderId === folder.id) {
    cmView.focus();
  }
}

function switchToTab(folder, filePath) {
  activeEditorTab.set(folder.id, filePath);
  renderEditorPane(folder);
  const tab = editorTabs.get(folder.id)?.get(filePath);
  if (tab && tab.cmView) tab.cmView.focus();
}

function closeTab(folder, filePath) {
  const tabs = editorTabs.get(folder.id);
  if (!tabs) return;
  const tab = tabs.get(filePath);
  if (!tab) return;

  if (tab.dirty) {
    const ok = confirm(`Discard unsaved changes to ${basename(filePath)}?`);
    if (!ok) return;
  }

  if (tab.cmView) tab.cmView.destroy();
  tab.container.remove();
  tabs.delete(filePath);

  if (activeEditorTab.get(folder.id) === filePath) {
    const remaining = Array.from(tabs.keys());
    if (remaining.length > 0) {
      activeEditorTab.set(folder.id, remaining[remaining.length - 1]);
      renderEditorPane(folder);
    } else {
      activeEditorTab.delete(folder.id);
      showFilesListing(folder, folderBrowseDir.get(folder.id) || folder.path);
    }
  } else if (filesPanelState && filesPanelState.view === 'editor' && filesPanelState.folderId === folder.id) {
    renderEditorPane(folder);
  }
}

function closeAllTabsForFolder(folder) {
  const tabs = editorTabs.get(folder.id);
  if (!tabs || tabs.size === 0) return true;

  const dirtyCount = Array.from(tabs.values()).filter((t) => t.dirty).length;
  if (dirtyCount > 0) {
    const ok = confirm(`Discard unsaved changes in ${dirtyCount} file(s)?`);
    if (!ok) return false;
  }

  for (const tab of tabs.values()) {
    if (tab.cmView) tab.cmView.destroy();
    tab.container.remove();
  }
  editorTabs.delete(folder.id);
  activeEditorTab.delete(folder.id);
  return true;
}

function renderTabBar(folder) {
  const bar = el('div', 'editor-tabbar');
  const tabs = editorTabs.get(folder.id);
  const activePath = activeEditorTab.get(folder.id);
  if (tabs) {
    for (const [filePath, tab] of tabs) {
      const tabEl = el('div', 'editor-tab' + (filePath === activePath ? ' active' : ''));
      tabEl.title = filePath;
      tabEl.appendChild(el('span', 'editor-tab-name', basename(filePath)));
      if (tab.dirty) tabEl.appendChild(el('span', 'editor-tab-dirty', '●'));
      const closeBtn = el('button', 'editor-tab-close', '×');
      closeBtn.title = 'Close';
      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeTab(folder, filePath);
      });
      tabEl.appendChild(closeBtn);
      tabEl.addEventListener('click', () => switchToTab(folder, filePath));
      bar.appendChild(tabEl);
    }
  }
  return bar;
}

function renderEditorPane(folder, justSaved) {
  ensureEditorScaffold();
  editorToolbarEl.innerHTML = '';

  const backBtn = el('button', 'md-back', '← Back to files');
  backBtn.addEventListener('click', () => showFilesListing(folder, folderBrowseDir.get(folder.id) || folder.path));
  editorToolbarEl.appendChild(backBtn);

  editorToolbarEl.appendChild(renderTabBar(folder));

  if (justSaved) {
    editorToolbarEl.appendChild(el('span', 'editor-status', 'Saved'));
    setTimeout(() => {
      if (filesPanelState && filesPanelState.view === 'editor' && filesPanelState.folderId === folder.id) {
        renderEditorPane(folder, false);
      }
    }, 1200);
  }

  const saveBtn = el('button', 'md-edit', '💾 Save');
  saveBtn.addEventListener('click', () => saveActiveTab(folder));
  editorToolbarEl.appendChild(saveBtn);

  for (const [fId, tabs] of editorTabs) {
    const activePath = activeEditorTab.get(fId);
    for (const [filePath, tab] of tabs) {
      const shouldShow =
        fId === folder.id &&
        filePath === activePath &&
        filesPanelState &&
        filesPanelState.view === 'editor' &&
        filesPanelState.folderId === folder.id;
      tab.container.classList.toggle('visible', shouldShow);
    }
  }
}

async function saveActiveTab(folder) {
  const filePath = activeEditorTab.get(folder.id);
  if (!filePath) return;
  const tabs = editorTabs.get(folder.id);
  const tab = tabs && tabs.get(filePath);
  if (!tab || !tab.cmView) return;

  const content = tab.cmView.state.doc.toString();
  const res = await ipcRenderer.invoke('fs:write-file', { filePath, content });
  if (!res.ok) {
    alert(res.error);
    return;
  }
  tab.dirty = false;
  renderEditorPane(folder, true);
}
