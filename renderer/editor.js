// --- Monaco bootstrap (no bundler: AMD min/vs build) ---
//
// This app has no webpack/vite step (plain classic <script> tags, nodeIntegration
// on — see README.md). Monaco's ESM build turned out not to be loadable via plain
// dynamic import() here: its esm/ source tree has bundler-only `import './foo.css'`
// statements that native ESM can't resolve (Chromium reports "MIME type text/css,
// expected a JavaScript module"). The `min/vs` AMD bundle has no such imports (CSS
// is injected at runtime via the DOM instead), which is Monaco's own documented
// no-bundler path — but its loader.js auto-detects a CommonJS environment (the
// `require`/`module`/`exports` globals nodeIntegration injects) and wrongly exports
// itself as a CommonJS module instead of defining global AMD require/define. The
// fix is the standard one for Electron+nodeIntegration+Monaco: hide those globals
// while loader.js runs, then restore them — nothing else in this app's renderer
// scripts calls require() after this point (editor.js is the only one that ever
// did, and only for the CodeMirror imports Monaco replaces).
let monacoReadyPromise = null;
let monaco = null;

function monacoVsUrl(relPath) {
  return new URL(`../node_modules/monaco-editor/min/vs/${relPath}`, document.baseURI).href;
}

function loadClassicScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function ensureMonacoLoaded() {
  if (!monacoReadyPromise) {
    monacoReadyPromise = (async () => {
      const savedRequire = window.require;
      const savedModule = window.module;
      const savedExports = window.exports;
      const savedProcess = window.process;
      window.require = undefined;
      window.module = undefined;
      window.exports = undefined;
      // Also hide `process` — loader.js treats `process.type === 'renderer'`
      // (true under nodeIntegration) as "running under Electron with Node
      // integration" and routes module loading through its Node-style
      // fs/vm-based loader instead of the plain browser <script>-tag one,
      // which fails here since these are file:// paths, not real Node module
      // ids. Hiding `module`/`exports` alone isn't enough to avoid that path.
      window.process = undefined;
      try {
        await loadClassicScript(monacoVsUrl('loader.js'));
        const amdRequire = window.require;
        amdRequire.config({ paths: { vs: monacoVsUrl('') } });
        self.MonacoEnvironment = {
          getWorkerUrl() {
            const base = monacoVsUrl('');
            return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
              self.MonacoEnvironment = { baseUrl: '${base}' };
              importScripts('${base}base/worker/workerMain.js');
            `)}`;
          },
        };
        await new Promise((resolve, reject) => {
          amdRequire(['vs/editor/editor.main'], resolve, reject);
        });
        monaco = window.monaco;
        registerCsharpProviders();
        defineCustomEditorThemes();
      } finally {
        window.require = savedRequire;
        window.module = savedModule;
        window.exports = savedExports;
        window.process = savedProcess;
      }
      return monaco;
    })();
  }
  return monacoReadyPromise;
}

// Themes offered in Settings. 'vs-dark'/'vs'/'hc-black'/'hc-light' are Monaco's
// own built-ins; the rest are defined below in defineCustomEditorThemes() from
// each palette's published color spec (Dracula, Monokai, Nord, Solarized).
const EDITOR_THEMES = [
  { id: 'vs-dark', label: 'Dark (default)' },
  { id: 'vs', label: 'Light' },
  { id: 'hc-black', label: 'High Contrast Dark' },
  { id: 'hc-light', label: 'High Contrast Light' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'monokai', label: 'Monokai' },
  { id: 'nord', label: 'Nord' },
  { id: 'solarized-dark', label: 'Solarized Dark' },
  { id: 'solarized-light', label: 'Solarized Light' },
];

// Monaco's theme is a single global (monaco.editor.setTheme swaps it for every
// editor instance at once), so these just need defining once up front — picking
// one in Settings, including live preview, is a plain setTheme() call from then on.
function defineCustomEditorThemes() {
  const palette = (base, bg, fg, lineHighlight, selection, cursor, lineNumber, tokenColors) => ({
    base,
    inherit: true,
    rules: [
      { token: 'comment', foreground: tokenColors.comment, fontStyle: 'italic' },
      { token: 'string', foreground: tokenColors.string },
      { token: 'number', foreground: tokenColors.number },
      { token: 'keyword', foreground: tokenColors.keyword, fontStyle: 'bold' },
      { token: 'type', foreground: tokenColors.type, fontStyle: 'italic' },
      { token: 'delimiter', foreground: tokenColors.delimiter },
      { token: 'operator', foreground: tokenColors.operator },
      { token: 'tag', foreground: tokenColors.tag },
      { token: 'attribute.name', foreground: tokenColors.attributeName },
      { token: 'annotation', foreground: tokenColors.annotation },
      { token: 'regexp', foreground: tokenColors.regexp },
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editor.lineHighlightBackground': lineHighlight,
      'editor.selectionBackground': selection,
      'editorCursor.foreground': cursor,
      'editorLineNumber.foreground': lineNumber,
    },
  });

  monaco.editor.defineTheme('dracula', palette('vs-dark', '#282a36', '#f8f8f2', '#33344a', '#44475a', '#f8f8f0', '#6272a4', {
    comment: '6272a4', string: 'f1fa8c', number: 'bd93f9', keyword: 'ff79c6', type: '8be9fd',
    delimiter: 'f8f8f2', operator: 'ff79c6', tag: 'ff79c6', attributeName: '50fa7b', annotation: 'ffb86c', regexp: 'ff5555',
  }));
  monaco.editor.defineTheme('monokai', palette('vs-dark', '#272822', '#f8f8f2', '#3e3d32', '#49483e', '#f8f8f0', '#90908a', {
    comment: '75715e', string: 'e6db74', number: 'ae81ff', keyword: 'f92672', type: '66d9ef',
    delimiter: 'f8f8f2', operator: 'f92672', tag: 'f92672', attributeName: 'a6e22e', annotation: 'fd971f', regexp: 'fd971f',
  }));
  monaco.editor.defineTheme('nord', palette('vs-dark', '#2e3440', '#d8dee9', '#3b4252', '#434c5e', '#d8dee9', '#4c566a', {
    comment: '616e88', string: 'a3be8c', number: 'b48ead', keyword: '81a1c1', type: '8fbcbb',
    delimiter: 'eceff4', operator: '81a1c1', tag: '81a1c1', attributeName: '8fbcbb', annotation: 'd08770', regexp: 'ebcb8b',
  }));
  monaco.editor.defineTheme('solarized-dark', palette('vs-dark', '#002b36', '#839496', '#073642', '#073642', '#839496', '#586e75', {
    comment: '586e75', string: '2aa198', number: 'd33682', keyword: '859900', type: 'b58900',
    delimiter: '839496', operator: '859900', tag: '268bd2', attributeName: '93a1a1', annotation: 'cb4b16', regexp: 'dc322f',
  }));
  monaco.editor.defineTheme('solarized-light', palette('vs', '#fdf6e3', '#657b83', '#eee8d5', '#eee8d5', '#657b83', '#93a1a1', {
    comment: '93a1a1', string: '2aa198', number: 'd33682', keyword: '859900', type: 'b58900',
    delimiter: '657b83', operator: '859900', tag: '268bd2', attributeName: '586e75', annotation: 'cb4b16', regexp: 'dc322f',
  }));
}

// Sample snippet shown in the Settings theme preview — picked to light up most
// of the token rules above (comment, string, number, keyword, type, tag).
const EDITOR_THEME_PREVIEW_SNIPPET = `// Pick a theme to preview it here
import { useState } from "react";

/** Returns true for primes > 1. */
function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false;
  }
  return true;
}

const tag = <div className="demo">{isPrime(17)}</div>;
`;

let themePreviewEditor = null;
const themePreviewHostEl = document.getElementById('settings-theme-preview');

// Settings modal calls this once, when it opens, to create (or just re-show)
// the preview instance — kept separate from sharedMonacoEditor since it needs
// its own read-only model and lives inside the settings overlay, not the Files tab.
async function ensureThemePreviewEditor() {
  await ensureMonacoLoaded();
  if (themePreviewEditor) return themePreviewEditor;
  themePreviewEditor = monaco.editor.create(themePreviewHostEl, {
    value: EDITOR_THEME_PREVIEW_SNIPPET,
    language: 'typescript',
    readOnly: true,
    automaticLayout: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    lineNumbers: 'off',
  });
  return themePreviewEditor;
}

// Applies immediately and globally (see note on EDITOR_THEMES above) — used both
// for live preview as the Settings dropdown changes and to commit the choice on Save.
function previewEditorTheme(themeId) {
  if (!monaco) return;
  monaco.editor.setTheme(themeId);
}

// Kick off loading immediately so it's warm by the time a file is clicked.
ensureMonacoLoaded();

let sharedMonacoEditor = null;
const monacoHostEl = document.getElementById('files-monaco-host');

async function ensureSharedEditor() {
  await ensureMonacoLoaded();
  if (sharedMonacoEditor) return sharedMonacoEditor;
  sharedMonacoEditor = monaco.editor.create(monacoHostEl, {
    automaticLayout: true,
    theme: (state && state.editorTheme) || 'vs-dark',
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    minimap: { enabled: false },
  });
  sharedMonacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    if (activeFilesFolder) saveActiveTab(activeFilesFolder);
  });
  sharedMonacoEditor.onDidChangeModelContent(() => {
    const model = sharedMonacoEditor.getModel();
    if (!model || !activeFilesFolder) return;
    const tabs = editorTabs.get(activeFilesFolder.id);
    const filePath = activeEditorTab.get(activeFilesFolder.id);
    const tab = tabs && filePath && tabs.get(filePath);
    if (tab && tab.model === model && !tab.dirty) {
      tab.dirty = true;
      renderFilesTabs(activeFilesFolder);
    }
    if (tab && tab.model === model && isCsharpFile(filePath)) {
      debouncedCsharpDidChange(activeFilesFolder, filePath, model);
    }
  });
  return sharedMonacoEditor;
}

// ext -> Monaco built-in language id. Keeps the same extension set as before
// (including the .config/.csproj/etc. XML group), just mapped to Monaco ids
// instead of CodeMirror language-extension arrays.
function monacoLanguageFor(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'html':
    case 'htm':
      return 'html';
    case 'py':
      return 'python';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'xml':
    case 'config':
    case 'csproj':
    case 'vbproj':
    case 'props':
    case 'targets':
    case 'resx':
    case 'nuspec':
    case 'xsd':
    case 'xsl':
    case 'xslt':
      return 'xml';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'sql':
      return 'sql';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'c':
    case 'h':
    case 'cpp':
    case 'cc':
    case 'hpp':
      return 'cpp';
    case 'java':
      return 'java';
    case 'cs':
    case 'csx':
      return 'csharp';
    case 'php':
      return 'php';
    default:
      return 'plaintext';
  }
}

function isMarkdownFile(filePath) {
  return /\.(md|markdown)$/i.test(filePath);
}

// folderId -> Map(filePath -> { kind: 'edit'|'preview', model, viewState, dirty, rawContent })
const editorTabs = new Map();
// folderId -> filePath of the active tab
const activeEditorTab = new Map();
// Folder whose Files screen is currently showing — the shared editor/save
// command and dirty-tracking listener need to resolve this dynamically since
// there's one editor instance reused across folders.
let activeFilesFolder = null;

const filesTabbarEl = document.getElementById('files-tabbar');
const filesTabsEmptyEl = document.getElementById('files-tabs-empty');
const filesPreviewHostEl = document.getElementById('files-preview-host');

// Every path that brings a folder's Files screen to the front — clicking the
// tree directly, quick-open, search results, or just the sidebar "Files" row
// for a different folder — funnels through here so the outgoing folder's
// cursor/scroll state is saved before the shared editor gets repointed, and
// the tab strip always reflects whichever folder is now active.
function setActiveFilesFolder(folder) {
  if (activeFilesFolder && activeFilesFolder.id !== folder.id) {
    saveCurrentViewState(activeFilesFolder);
  }
  activeFilesFolder = folder;
}

// Called by renderer.js's showFilesListing whenever the sidebar's "Files"
// row brings a folder's screen to the front, so the tab strip/editor catch
// up to whichever folder that is (the tree side is handled by renderFilesTree).
function showFilesTabsFor(folder) {
  setActiveFilesFolder(folder);
  renderFilesTabs(folder);
}

async function openFileInEditor(folder, filePath, preferPreview) {
  setActiveFilesFolder(folder);
  if (!editorTabs.has(folder.id)) editorTabs.set(folder.id, new Map());
  const tabs = editorTabs.get(folder.id);

  // Called from entry points other than clicking the tree itself (quick-open,
  // search results) where the Files screen for this folder may not already
  // be showing — bring the tree column in sync too, not just the tab strip.
  const treeAlreadyShowing = filesPanelState && filesPanelState.folderId === folder.id && filesPanelState.view === 'files';
  filesPanelState = { folderId: folder.id, view: 'files' };
  singleModeShowing = 'files';
  if (!treeAlreadyShowing) renderFilesTree(folder);

  if (tabs.has(filePath)) {
    switchToTab(folder, filePath);
    return;
  }

  saveCurrentViewState(folder); // save whatever tab in this folder was active before this new one

  const kind = preferPreview && isMarkdownFile(filePath) ? 'preview' : 'edit';
  // Placeholder so the tab shows up in the strip immediately, and so a
  // closeTab() that lands while fs:read-file is still in flight can cancel
  // this open by deleting it out from under the awaited call below.
  tabs.set(filePath, { kind, model: null, viewState: null, dirty: false, rawContent: '' });
  activeEditorTab.set(folder.id, filePath);
  applyLayout();
  renderSidebar();
  renderFilesTabs(folder);

  const res = await ipcRenderer.invoke('fs:read-file', { filePath });
  if (!tabs.has(filePath)) return; // tab was closed while loading

  const tab = tabs.get(filePath);
  tab.rawContent = res.ok ? res.content : `Error: ${res.error}`;

  if (kind === 'edit' && res.ok) {
    await ensureSharedEditor();
    if (!tabs.has(filePath)) return; // closed while the editor was loading
    tab.model = monaco.editor.getModel(monaco.Uri.file(filePath)) || monaco.editor.createModel(tab.rawContent, monacoLanguageFor(filePath), monaco.Uri.file(filePath));
    if (isCsharpFile(filePath)) {
      ipcRenderer.invoke('csharp:did-open', { folderId: folder.id, filePath, text: tab.rawContent });
    }
  }

  if (activeEditorTab.get(folder.id) === filePath && filesPanelState && filesPanelState.folderId === folder.id) {
    renderFilesTabs(folder);
  }
}

function switchToTab(folder, filePath) {
  setActiveFilesFolder(folder);
  saveCurrentViewState(folder); // save the outgoing tab within this same folder
  activeEditorTab.set(folder.id, filePath);
  filesPanelState = { folderId: folder.id, view: 'files' };
  singleModeShowing = 'files';
  applyLayout();
  renderSidebar();
  renderFilesTabs(folder);
}

function saveCurrentViewState(folder) {
  if (!sharedMonacoEditor) return;
  const prevPath = activeEditorTab.get(folder.id);
  const tabs = editorTabs.get(folder.id);
  const prevTab = prevPath && tabs && tabs.get(prevPath);
  if (prevTab && prevTab.kind === 'edit' && prevTab.model === sharedMonacoEditor.getModel()) {
    prevTab.viewState = sharedMonacoEditor.saveViewState();
  }
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

  if (tab.model) tab.model.dispose();
  tabs.delete(filePath);
  if (isCsharpFile(filePath)) {
    ipcRenderer.invoke('csharp:did-close', { folderId: folder.id, filePath });
  }

  if (activeEditorTab.get(folder.id) === filePath) {
    const remaining = Array.from(tabs.keys());
    if (remaining.length > 0) {
      activeEditorTab.set(folder.id, remaining[remaining.length - 1]);
    } else {
      activeEditorTab.delete(folder.id);
    }
    if (filesPanelState && filesPanelState.view === 'files' && filesPanelState.folderId === folder.id) {
      renderFilesTabs(folder);
    }
  } else if (filesPanelState && filesPanelState.view === 'files' && filesPanelState.folderId === folder.id) {
    renderFilesTabs(folder);
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

  for (const [filePath, tab] of tabs) {
    if (tab.model) tab.model.dispose();
    if (isCsharpFile(filePath)) {
      ipcRenderer.invoke('csharp:did-close', { folderId: folder.id, filePath });
    }
  }
  editorTabs.delete(folder.id);
  activeEditorTab.delete(folder.id);
  if (activeFilesFolder && activeFilesFolder.id === folder.id) {
    if (sharedMonacoEditor) sharedMonacoEditor.setModel(null);
    activeFilesFolder = null;
  }
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

function renderMarkdownPreview(filePath, tab) {
  filesPreviewHostEl.innerHTML = '';

  const editBtn = el('button', 'md-edit', '✎ Edit');
  editBtn.addEventListener('click', async () => {
    await ensureSharedEditor();
    if (!tab.model) tab.model = monaco.editor.getModel(monaco.Uri.file(filePath)) || monaco.editor.createModel(tab.rawContent, monacoLanguageFor(filePath), monaco.Uri.file(filePath));
    tab.kind = 'edit';
    renderFilesTabs(activeFilesFolder);
  });
  filesPreviewHostEl.appendChild(editBtn);

  const body = el('div');
  body.id = 'markdown-body';
  filesPreviewHostEl.appendChild(body);

  const content = tab.model ? tab.model.getValue() : tab.rawContent;
  body.innerHTML = DOMPurify.sanitize(parseMarkdown(content));
  addCodeBlockCopyButtons(body);
}

function renderFilesTabs(folder, justSaved) {
  filesTabbarEl.innerHTML = '';
  filesTabbarEl.appendChild(renderTabBar(folder));

  const activePath = activeEditorTab.get(folder.id);
  const tabs = editorTabs.get(folder.id);
  const activeTab = activePath && tabs && tabs.get(activePath);

  const actions = el('div', 'files-tabbar-actions');
  if (activeTab) {
    if (activeTab.kind === 'edit' && isMarkdownFile(activePath)) {
      const previewBtn = el('button', 'md-edit', '👁 Preview');
      previewBtn.addEventListener('click', () => {
        activeTab.kind = 'preview';
        renderFilesTabs(folder);
      });
      actions.appendChild(previewBtn);
    }
    if (justSaved) {
      actions.appendChild(el('span', 'editor-status', 'Saved'));
      setTimeout(() => {
        if (filesPanelState && filesPanelState.view === 'files' && filesPanelState.folderId === folder.id) {
          renderFilesTabs(folder, false);
        }
      }, 1200);
    }
    if (activeTab.kind === 'edit') {
      const saveBtn = el('button', 'md-edit', '💾 Save');
      saveBtn.addEventListener('click', () => saveActiveTab(folder));
      actions.appendChild(saveBtn);
    }
  }
  filesTabbarEl.appendChild(actions);

  filesTabsEmptyEl.classList.toggle('visible', !activeTab);
  monacoHostEl.classList.toggle('visible', !!activeTab && activeTab.kind === 'edit');
  filesPreviewHostEl.classList.toggle('visible', !!activeTab && activeTab.kind === 'preview');

  if (!activeTab) return;

  if (activeTab.kind === 'edit') {
    ensureSharedEditor().then((editor) => {
      if (!activeEditorTab.get(folder.id) || activeEditorTab.get(folder.id) !== activePath) return;
      if (!editorTabs.get(folder.id) || editorTabs.get(folder.id).get(activePath) !== activeTab) return;
      // Guard against clobbering a cursor/selection another caller (e.g.
      // revealLineInEditor) already set synchronously before this resolved.
      if (editor.getModel() !== activeTab.model) {
        editor.setModel(activeTab.model);
        if (activeTab.viewState) editor.restoreViewState(activeTab.viewState);
      }
      editor.focus();
    });
  } else {
    renderMarkdownPreview(activePath, activeTab);
  }
}

// Called after openFileInEditor() resolves for filePath, so the tab exists;
// forces edit mode (even for markdown) so the match line is visible.
async function revealLineInEditor(folder, filePath, lineNumber, col) {
  const tabs = editorTabs.get(folder.id);
  const tab = tabs && tabs.get(filePath);
  if (!tab) return;

  const editor = await ensureSharedEditor();
  if (!tab.model) tab.model = monaco.editor.getModel(monaco.Uri.file(filePath)) || monaco.editor.createModel(tab.rawContent, monacoLanguageFor(filePath), monaco.Uri.file(filePath));
  tab.kind = 'edit';
  activeEditorTab.set(folder.id, filePath);
  renderFilesTabs(folder);

  editor.setModel(tab.model);
  const lineCount = tab.model.getLineCount();
  const line = Math.max(1, Math.min(lineNumber, lineCount));
  const column = Math.max(1, (col || 0) + 1);
  editor.revealLineInCenter(line);
  editor.setSelection({ startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: tab.model.getLineMaxColumn(line) });
  editor.focus();
}

async function saveActiveTab(folder) {
  const filePath = activeEditorTab.get(folder.id);
  if (!filePath) return;
  const tabs = editorTabs.get(folder.id);
  const tab = tabs && tabs.get(filePath);
  if (!tab || !tab.model) return;

  const content = tab.model.getValue();
  const res = await ipcRenderer.invoke('fs:write-file', { filePath, content });
  if (!res.ok) {
    alert(res.error);
    return;
  }
  tab.dirty = false;
  renderFilesTabs(folder, true);
}

// --- C# Go to Definition / Find All References (OmniSharp over IPC) ---
//
// Monaco's built-in goToDefinition/peek-reference contribution turns out not
// to be reachable from this app's AMD min/vs build (monaco-editor's newer
// Vite-chunked output splits that contribution into a separate hashed chunk
// — e.g. editor-BdtEMBbM.js — that this build's bundled loader.js silently
// fails to pull in via editor.main.js's own relative '../editor-BdtEMBbM'
// dependency, even when requested explicitly alongside 'vs/editor/editor.main'
// in ensureMonacoLoaded; monaco.languages.registerDefinitionProvider/
// registerReferenceProvider end up with no Monaco UI wired to them at all).
// So instead of relying on that, these are plain editor.addAction entries —
// same right-click commands, implemented directly against the csharp:*
// IPC handlers in main.ts (which own the actual OmniSharp language-server
// process, see src/omnisharp.ts), with navigation via the existing
// openFileInEditor/revealLineInEditor pair and a native popup menu
// (app:popup-menu, the same one used for the "run script" right-click) when
// a reference search returns more than one hit.

function isCsharpFile(filePath) {
  return monacoLanguageFor(filePath) === 'csharp';
}

// LSP uses file:// URIs (percent-encoded); this is the renderer-side mirror
// of src/omnisharp.ts's fileUriToPath. OmniSharp always lowercases the drive
// letter in returned URIs (file:///c:/...) regardless of how the path was
// sent to it, while every other path string in this app (folder.path, open
// tab keys) keeps the OS's original uppercase casing — uppercase it back
// here so paths derived from LSP responses compare equal to those, instead
// of silently failing folderForPath lookups and editorTabs key matches.
function lspUriToPath(uri) {
  let decoded = decodeURI(uri.replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
  return decoded.replace(/^[a-z]:/, (m) => m.toUpperCase());
}

// Monaco model object -> the folder whose open tabs contain it. Models have
// no built-in back-reference to a folder, so this scans editorTabs (fine at
// "tabs a human has open" scale, same spirit as main.ts's linear-scan
// findFolder/findSession helpers).
function folderForModel(model) {
  for (const [folderId, tabs] of editorTabs) {
    for (const tab of tabs.values()) {
      if (tab.model === model) return state.folders.find((f) => f.id === folderId) || null;
    }
  }
  return null;
}

function filePathForModel(folder, model) {
  const tabs = editorTabs.get(folder.id);
  if (!tabs) return null;
  for (const [filePath, tab] of tabs) {
    if (tab.model === model) return filePath;
  }
  return null;
}

// Which open folder (sidebar root) a given absolute path lives under, if
// any — used when a definition/reference jump lands in a file that has no
// open tab yet, so there's no editorTabs entry to resolve it from.
//
// Windows path comparisons here need to be case-insensitive on the drive
// letter at least: OmniSharp's LSP URIs always come back with a lowercased
// drive letter (file:///c:/...) regardless of how the path was sent to it,
// while folder.path keeps whatever case the OS/user originally gave it
// (typically uppercase, e.g. "C:\\Users\\...") — a strict comparison would
// silently fail to match every single cross-file jump on Windows.
function folderForPath(filePath) {
  const resolved = path.resolve(filePath);
  const normalize = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const target = normalize(resolved);
  return (
    state.folders.find((f) => {
      const root = normalize(path.resolve(f.path));
      return target === root || target.startsWith(root + path.sep);
    }) || null
  );
}

// Opens (or activates) the tab for an LSP location and moves the cursor
// there — the same two-step open+reveal primitive search-result clicks use.
async function jumpToLspLocation(loc) {
  const filePath = lspUriToPath(loc.uri);
  const folder = folderForPath(filePath);
  if (!folder) return;
  await openFileInEditor(folder, filePath, false);
  revealLineInEditor(folder, filePath, loc.range.start.line + 1, loc.range.start.character);
}

// Find All References can come back with several hits — ask via the same
// native popup menu the file browser's "run script" right-click uses
// (app:popup-menu) rather than inventing another list UI.
async function pickAndJumpToLocation(locations) {
  if (!locations || locations.length === 0) return;
  if (locations.length === 1) {
    await jumpToLspLocation(locations[0]);
    return;
  }
  const items = locations.map((loc, i) => ({
    id: String(i),
    label: `${basename(lspUriToPath(loc.uri))} — line ${loc.range.start.line + 1}`,
  }));
  const choice = await ipcRenderer.invoke('app:popup-menu', { items });
  if (choice == null) return;
  await jumpToLspLocation(locations[Number(choice)]);
}

async function requestCsharpLocations(channel, editorInstance) {
  const model = editorInstance.getModel();
  const position = editorInstance.getPosition();
  if (!model || !position) return null;
  const folder = folderForModel(model);
  if (!folder) return null;
  const filePath = filePathForModel(folder, model);
  if (!filePath) return null;
  const res = await ipcRenderer.invoke(channel, {
    folderId: folder.id,
    filePath,
    line: position.lineNumber - 1,
    character: position.column - 1,
  });
  return res.ok ? res.locations : null;
}

const csharpDidChangeTimers = new Map(); // filePath -> timeout id
function debouncedCsharpDidChange(folder, filePath, model) {
  clearTimeout(csharpDidChangeTimers.get(filePath));
  csharpDidChangeTimers.set(
    filePath,
    setTimeout(() => {
      csharpDidChangeTimers.delete(filePath);
      ipcRenderer.invoke('csharp:did-change', { folderId: folder.id, filePath, text: model.getValue() });
    }, 300)
  );
}

let csharpProvidersRegistered = false;
function registerCsharpProviders() {
  if (csharpProvidersRegistered) return;
  csharpProvidersRegistered = true;

  ensureSharedEditor().then((ed) => {
    ed.addAction({
      id: 'csharp.goToDefinition',
      label: 'Go to Definition',
      precondition: "editorLangId == 'csharp'",
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.1,
      keybindings: [monaco.KeyCode.F12],
      run: async (editorInstance) => {
        const locations = await requestCsharpLocations('csharp:definition', editorInstance);
        await pickAndJumpToLocation(locations);
      },
    });

    ed.addAction({
      id: 'csharp.findReferences',
      label: 'Find All References',
      precondition: "editorLangId == 'csharp'",
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.2,
      keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
      run: async (editorInstance) => {
        const locations = await requestCsharpLocations('csharp:references', editorInstance);
        await pickAndJumpToLocation(locations);
      },
    });
  });
}
