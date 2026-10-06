# Folders

A desktop app for organizing terminal sessions (like Claude Code sessions, or any
shell command) by project folder, instead of hunting through scattered terminal
windows. Built with Electron, [node-pty](https://github.com/microsoft/node-pty),
and [xterm.js](https://xtermjs.org/).

Each folder you add can hold multiple live sessions. Sessions keep running in the
background while you switch between them. Each folder also has a built-in file
browser with native Markdown preview.

## Features

- **Folder-organized sessions** — group terminal sessions by project directory
- **Sessions persist while the app runs** — switch away and back without losing output
- **File browser per folder** — sticky navigation, remembers where you left off
- **Markdown preview** — click a `.md` file to render it inline (sanitized with DOMPurify)
- **Split view** — see the file browser and a terminal side by side
- **Native folder picker** — no typing paths by hand

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 22 or newer
- Windows (the app currently targets `cmd.exe` as the shell; see [Platform notes](#platform-notes))

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
- **📂 Files** — browse that folder's files; click a subdirectory to go in, `..`
  to go up, a `.md` file to preview it, or any other file to open it in its
  default system app
- **＋ (folder row)** — start a new session in that folder (prompts for a
  command, defaults to `claude`)
- **✕ (folder row)** — remove a folder (kills any running sessions in it)
- **✕ (session row)** — kill that session
- **⬓ Split view** — show the file browser and the active terminal side by side

Sessions and the file browser both live in the main pane; clicking between rows
in the sidebar switches what's shown there. Sessions keep running until you kill
them or quit the app — closing the window ends any sessions still running.

Added folders and the last command used per folder are remembered across
restarts, in `~/.terminalapp/config.json`. Running sessions are not restored
when you reopen the app.

## Project structure

```
electron/      Electron main process — owns PTY sessions, folder/session
                state, config persistence, and all IPC handlers
renderer/      The UI (plain HTML/CSS/JS) — sidebar, xterm.js terminals,
                file browser, markdown preview
src/           Code shared by the main process: config load/save, the
                node-pty wrapper, and shared types
```

## Platform notes

Sessions are spawned via `cmd.exe` on Windows. To use a different shell (e.g.
PowerShell), change the `SHELL` constant in `src/pty-session.ts`.

## Security note

The renderer runs with `nodeIntegration` enabled and no context isolation —
this is a trusted local tool, not something that loads remote or untrusted web
content. Markdown file contents are rendered as HTML, so they're parsed with
`marked` and sanitized with `DOMPurify` before being inserted into the page.
