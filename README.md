# Folders

A desktop app for organizing terminal sessions (like Claude Code sessions, or any
shell command) by project folder, instead of hunting through scattered terminal
windows. Built with Electron, [node-pty](https://github.com/microsoft/node-pty),
and [xterm.js](https://xtermjs.org/).

Each folder you add can hold multiple live sessions. Sessions keep running in the
background while you switch between them. Each folder also has a built-in file
browser, code editor, and a full git panel.

## Features

### Sessions

- **Folder-organized sessions** — group terminal sessions by project directory,
  with multiple concurrent sessions per folder
- **Sessions persist while the app runs** — switch away and back without losing output
- **Shell picker** — choose Command Prompt, PowerShell, or Git Bash per session
- **Auto-resume on launch** — sessions still running when you last closed the app
  are relaunched automatically (Claude sessions resume with `--continue`); toggle
  this off from the toolbar if you'd rather start clean
- **Activity indicators** — a status dot shows idle / running / waiting-for-input /
  exited at a glance; rename sessions and see the last command each one ran

### Files & editing

- **File browser per folder** — sticky navigation, remembers where you left off
- **In-app code editor** — CodeMirror-based, with syntax highlighting for
  JS/TS/JSX/TSX, Python, Rust, Go, C/C++, Java, PHP, JSON, CSS, HTML, Markdown,
  XML, YAML, and SQL; multiple tabs with unsaved-change indicators
- **Markdown preview** — click a `.md` file to render it inline (sanitized with
  DOMPurify), with a one-click switch to editing
- **Run scripts in a new session** — right-click a `.ps1`/`.bat`/`.cmd`/`.sh`/
  `.py`/`.js`/`.mjs`/`.cjs`/`.rb`/`.pl` file to run it in a fresh session with
  the right shell or interpreter already chosen for you
- **.sln detection** — folders containing a Visual Studio solution get a button
  to launch it directly
- **Split view** — see the file browser and a terminal side by side
- **Collapsible sidebar**

### Git

- **Live git status per folder** — current branch, uncommitted change count,
  and ahead/behind upstream, shown as a badge in the sidebar, refreshed automatically
- **Full git panel** — switch/checkout branches, pull/push, stage or unstage
  individual files, view diffs, and commit staged changes, without leaving the app
- **Clone a repository** — pick a destination and paste a URL; clone progress
  streams live into the app

### Folders

- **Native folder picker**, or **create a brand-new folder** on disk from inside the app
- **Windows Explorer integration** — right-click any folder (or its empty space)
  to "Add to Folders" directly, no need to open the app first (packaged builds only)

### Automation & feedback

- **Opt-in web driver** — a toggleable HTTP driver for automating the app
  (click/type/press/eval/screenshot and more) over your local network, gated by
  a random per-session token and off by default; a persistent banner reminds you
  while it's on. Handy for scripting the app, or for assistants like Claude to
  drive it directly — see [the source](electron/web-driver.ts) for the command set.
- **In-app feedback** — opens a pre-filled GitHub issue (bug or idea) with your
  app version and OS attached; nothing is sent until you submit it yourself
- **Update checks** — automatic on launch and periodically while running, plus
  a manual "Check for Updates" button; prompts to restart once a new version
  has downloaded

## Download

Grab the latest Windows installer from the
[Releases page](https://github.com/danamikita/terminalApp/releases/latest).
The app checks for updates on launch (and every few hours while running) and
will prompt to restart when a new version has downloaded — no need to
reinstall manually after the first time.

> **Note:** installers aren't code-signed yet, so Windows SmartScreen will
> warn that it's from an unknown publisher on first install. Click
> "More info" → "Run anyway" to proceed. This doesn't affect auto-updates
> once installed.

## Getting started (from source)

### Prerequisites

- [Node.js](https://nodejs.org/) 22 or newer
- Windows (see [Platform notes](#platform-notes))

### Install

```bash
git clone https://github.com/danamikita/terminalApp.git
cd terminalApp
npm install
```

### Run

```bash
npm run build
npm start
```

Or in one step during development:

```bash
npm run dev
```

## Using the app

- **＋ (sidebar header)** — add a folder (opens a native directory picker, then
  asks for a display name)
- **🆕 (sidebar header)** — create a brand-new folder on disk and add it
- **⬇ (sidebar header)** — clone a git repository into a new folder
- **📂 Files** — browse that folder's files; click a subdirectory to go in, `..`
  to go up, a `.md` file to preview it, a code file to open it in the editor, or
  any other file to open it in its default system app. Right-click a recognized
  script to run it in a new session.
- **🌿 Git** — a full git panel for that folder: switch branches, pull/push,
  stage/unstage files, view diffs, and commit
- **🧩 (folder row)** — appears when the folder has a `.sln` file; click to launch it
- **＋ (folder row)** — start a new session in that folder (pick a shell, enter
  a command, defaults to `claude`)
- **✕ (folder row)** — remove a folder (kills any running sessions in it)
- **✎ / ✕ (session row)** — rename or kill that session
- **⬓ Split view** — show the file browser and the active terminal side by side
- **🔁 Auto-resume** — toggle whether sessions running at last close relaunch on startup
- **🔄 Check for Updates** — check right now instead of waiting for the periodic check
- **🧪 Web Driver** — toggle the opt-in HTTP automation driver (see
  [Features](#features) above); shows the link to copy and a warning banner
  while it's on
- **🐛 Feedback** — opens a pre-filled "New Issue" page on GitHub in your
  browser (with your app version and OS included) so bugs and ideas land
  straight in the repo's issue tracker; nothing is sent until you submit it
  there yourself

Sessions and the file browser both live in the main pane; clicking between rows
in the sidebar switches what's shown there. Sessions keep running until you kill
them or quit the app — closing the window ends any sessions still running.

Added folders, the last command/shell used per folder, and (if Auto-resume is
on) the sessions that were still running are remembered across restarts, in
`~/.terminalapp/config.json`.

## Project structure

```
electron/      Electron main process — owns PTY sessions, folder/session
                state, config persistence, all IPC handlers, and the
                opt-in web-driver HTTP server (web-driver.ts)
renderer/      The UI (plain HTML/CSS/JS) — sidebar, xterm.js terminals,
                file browser, markdown preview (renderer.js), the
                CodeMirror editor (editor.js), and the git panel (git-panel.js)
src/           Code shared by the main process: config load/save, git
                plumbing, the node-pty wrapper, and shared types
scripts/       electron-drive.mjs — a Playwright-based CLI driver used to
                test the app end-to-end (separate from the in-app web driver)
```

## Platform notes

Windows-only for now — sessions are spawned via `cmd.exe`, PowerShell, or Git
Bash (`src/pty-session.ts`), chosen per-session from the shell picker, and the
Explorer "Add to Folders" context menu entry is Windows-specific. The rest of
the stack (Electron/node-pty/xterm.js) is cross-platform, so porting is mostly
about the shell resolution and the Explorer integration.

## Security note

The renderer runs with `nodeIntegration` enabled and no context isolation —
this is a trusted local tool, not something that loads remote or untrusted web
content. Markdown file contents are rendered as HTML, so they're parsed with
`marked` and sanitized with `DOMPurify` before being inserted into the page.

The optional web driver (off by default) listens on your local network and
runs arbitrary JS in the renderer — with nodeIntegration on, that's full Node
access. It's gated by a random per-session token, and the UI shows a
persistent warning banner the whole time it's enabled, but treat that token
like a credential for as long as it's on. See the comment at the top of
[`electron/web-driver.ts`](electron/web-driver.ts) for the full threat model.

## Releasing a new version

Builds and publishes happen automatically on GitHub Actions when a `v*` tag
is pushed — [`.github/workflows/release.yml`](.github/workflows/release.yml)
builds the Windows installer with `electron-builder` and publishes it as a
GitHub Release, which is also the update feed the app checks.

```bash
npm version patch -m "v%s"   # or minor / major — bumps package.json, commits "vX.Y.Z", tags it
git push
git push --tags
```

`npm version` creates a lightweight tag, and `git push --follow-tags` only
pushes *annotated* tags — it won't actually push the version tag, so push
`--tags` explicitly (or just the one tag: `git push origin vX.Y.Z`).

That's it — the workflow builds, signs nothing (see the note above), and
uploads the installer plus the metadata (`latest.yml`) `electron-updater`
needs to detect and download the new version.

To build an installer locally without publishing:

```bash
npm run dist
```

Output goes to `release/` (gitignored).
