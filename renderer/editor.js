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

let cmView = null;
let editorDirty = false;
let editorFilePath = null;
let editorFolder = null;
let editorReturnDir = null;

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

function confirmDiscardEditorIfDirty() {
  if (filesPanelState && filesPanelState.view === 'editor' && editorDirty) {
    const ok = confirm(`Discard unsaved changes to ${basename(editorFilePath)}?`);
    if (!ok) return false;
  }
  teardownEditor();
  return true;
}

function teardownEditor() {
  if (cmView) {
    cmView.destroy();
    cmView = null;
  }
  editorDirty = false;
  editorFilePath = null;
  editorFolder = null;
  editorReturnDir = null;
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

async function openFileInEditor(folder, filePath, returnDir, isMarkdown) {
  if (!confirmDiscardEditorIfDirty()) return;
  filesPanelState = { folderId: folder.id, view: 'editor', editorPath: filePath, editorReturnDir: returnDir, editorIsMarkdown: isMarkdown };
  singleModeShowing = 'files';
  applyLayout();
  renderSidebar();
  await renderEditorPane(folder, filePath, returnDir, isMarkdown);
}

async function renderEditorPane(folder, filePath, returnDir, isMarkdown) {
  editorFolder = folder;
  editorFilePath = filePath;
  editorReturnDir = returnDir;
  editorDirty = false;

  editorPaneEl.innerHTML = '';
  const header = el('div', 'editor-header');

  const backBtn = el('button', 'md-back', '← Back to files');
  backBtn.addEventListener('click', () => {
    if (confirmDiscardEditorIfDirty()) showFilesListing(folder, returnDir);
  });
  header.appendChild(backBtn);

  header.appendChild(el('span', 'editor-filename', basename(filePath)));

  const dirtyDot = el('span', 'editor-dirty-dot', '●');
  dirtyDot.style.visibility = 'hidden';
  header.appendChild(dirtyDot);

  const statusEl = el('span', 'editor-status', '');
  header.appendChild(statusEl);

  const saveBtn = el('button', 'md-edit', '💾 Save');
  saveBtn.addEventListener('click', () => saveCurrentFile(dirtyDot, statusEl));
  header.appendChild(saveBtn);

  editorPaneEl.appendChild(header);

  const host = el('div');
  host.id = 'editor-cm-host';
  editorPaneEl.appendChild(host);

  const res = await ipcRenderer.invoke('fs:read-file', { filePath });
  if (!res.ok) {
    host.textContent = `Error: ${res.error}`;
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
          saveCurrentFile(dirtyDot, statusEl);
          return true;
        },
      },
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        editorDirty = true;
        dirtyDot.style.visibility = 'visible';
        statusEl.textContent = '';
      }
    }),
  ];

  const editorState = EditorState.create({ doc: res.content, extensions });
  cmView = new EditorView({ state: editorState, parent: host });
}

async function saveCurrentFile(dirtyDot, statusEl) {
  if (!cmView || !editorFilePath) return;
  const content = cmView.state.doc.toString();
  const res = await ipcRenderer.invoke('fs:write-file', { filePath: editorFilePath, content });
  if (!res.ok) {
    alert(res.error);
    return;
  }
  editorDirty = false;
  if (dirtyDot) dirtyDot.style.visibility = 'hidden';

  const folder = editorFolder;
  const filePath = editorFilePath;
  const returnDir = editorReturnDir;
  const wasMarkdown = filesPanelState && filesPanelState.editorIsMarkdown;

  if (wasMarkdown) {
    teardownEditor();
    showMarkdownPreview(folder, filePath, returnDir);
    return;
  }

  if (statusEl) {
    statusEl.textContent = 'Saved';
    setTimeout(() => {
      if (statusEl.textContent === 'Saved') statusEl.textContent = '';
    }, 1500);
  }
}
