# Termorc

A macOS terminal where every session lives in a vertical sidebar, grouped into colored **Spaces**.

## What it does

- **Spaces.** Each Space has its own color, pinned sessions, folders, start directory and shell profile. Switch with ⌃1–9, ⌃←/→, a two-finger swipe on the sidebar, or the All Spaces overview (⌃↑ or pinch).
- **Sidebar.** It has four parts:
  - Favorites: always-on sessions shared by every Space.
  - Pinned: named sessions in collapsible folders.
  - Today: temporary sessions.
  - Icon & Color… (right-click a row) gives a session its own icon and a tinted row.
  - Live status on every row: running, idle, ✓ done, ✗ failed (hover for the exit code, click to jump to the error), and a bell badge.
- **Status line.** A tmux-style bar along the bottom lists Spaces as `1:work*` (`*` current, `#` unseen finished jobs; drop a session on one to move it there), plus finished jobs, the Library, the focused session's process and size, and a clock. The title bar shows the focused session's directory and process; click it for the command bar.
- **Command bar (⌘T).** One fuzzy search over open sessions, recent directories, SSH hosts (`~/.ssh/config`), snippets and actions. Prefixes: `>` runs a command, `@` searches hosts, `/` searches snippets. ⇥ cycles filters.
- **Splits.** ⌘D / ⇧⌘D, up to four panes per card. You can also drag a sidebar row onto a card edge. Dividers snap to ⅓, ½ and ⅔. Drag a pane header back to the sidebar to unsplit it.
- **Peek.** Hover a row for 400 ms to see its last lines streaming live. ⇧-click keeps the peek open.
- **Auto-archive and Library (⌘Y).** Idle Today sessions move to the Library after 12 h (configurable, with Undo). Library search covers names, commands, output and paths. Restore brings back the scrollback.
- **Routing rules.** Rules decide where new sessions land, by directory glob, SSH host or command prefix. They can also add effects: a red danger frame, confirmation for multi-line pastes, or no auto-archive. On danger sessions, `sudo`, restarts and `rm -rf` ask before running.
- **Notes (⇧⌘N).** One Markdown doc per Space. It supports checklists and pasted output that remembers which session it came from. Code blocks can run in the current session or be saved as `/snippets`.
- **Input bar and blocks.** Type commands in Termorc's own input bar: syntax colors, a suggestion from history (→ accepts), ↑/↓ recall, ⌃R search, ⇥ completion for commands, paths and git branches. Each command's output is a block with its time, duration and exit status. Settings → Terminal → Prompt → Shell brings back your shell's own prompt.
- **Code review (⇧⌘G).** Changes, Commits and Pull request tabs. Diffs with word-level highlights; stage, unstage or discard whole files or single hunks; comment on lines and send the comments to the terminal (for a coding agent) or post them on the PR. Commit (amend, commit & push), switch branches, fetch/pull/push, and open or merge pull requests with the GitHub CLI. Maximize to cover the terminal area.
- **Editor.** Files open in a code editor (CodeMirror): syntax colors, search and replace, multiple cursors; ⌘S saves.
- **Finder.** Right-click a folder › Services › **New Termorc Tab Here**, or drop a folder on the Dock icon.
- **Quick Terminal (⌥Space).** A global drop-down panel. It opens in the frontmost Finder folder. "Move to Space" promotes it to a sidebar row with its scrollback intact.
- **Extras:**
  - ⇧⌘C copies only the last command's output.
  - A "Jump to bottom" pill appears when you scroll up.
  - Dropped SSH connections show a reconnect sheet.
  - Long jobs in other Spaces notify you.
  - Focus mode: ⌘S hides the sidebar, and hovering the left edge reveals it.

## How it works

Termorc is a [Tauri](https://tauri.app) app: a Rust core drives the native side, and the UI runs in the system WebKit view. That makes for a ~8 MB app.

| Layer | Notes |
| --- | --- |
| `src-tauri/src/pty.rs` | Owns every PTY (`portable-pty`). Output is coalesced into one channel message per window every ~4 ms. Ack-based flow control parks the reader so runaway processes block. The foreground process is polled every 1.5 s. |
| `src-tauri/shell-integration/` | Hooks for zsh, bash and fish. They emit OSC 633 marks (prompt, command, exit code, cwd) and still load your own dotfiles. These marks drive the status marks, names, notifications, ⇧⌘C and the Library. |
| `src-tauri/src/library.rs` | Archived sessions: a JSON index plus one ANSI scrollback file each. Search reads files lazily with a bounded cache. |
| `src-tauri/src/lib.rs` | Windows, menus, Quick Terminal, global hotkey, dialogs, notifications and the quit flow, exposed as Tauri commands. |
| `src/bridge.js` | The renderer's only door to the native side: the `window.termac` API, backed by Tauri commands, events and a PTY channel. |
| `src/term/registry.js` | One xterm.js instance per session. Off-screen terminals are parked, so xterm pauses their rendering. Only visible panes hold a WebGL context. Restored sessions get a shell only when first shown. |
| `src/state/` | Three small stores (persisted app model, runtime status, UI) with selector subscriptions. All mutations live in `actions.js`. |

State lives in `~/Library/Application Support/Termorc/`:
- `state.json`
- `scrollback/` for live sessions across restarts
- `library/` for archived sessions

## Develop

Needs Node and Rust (`curl https://sh.rustup.rs -sSf | sh`).

```bash
npm install
npm run dev     # Vite + Tauri with hot reload
npm test        # unit tests for routing, layout, fuzzy, keys, markdown
cargo test --manifest-path src-tauri/Cargo.toml --lib   # PTY, git and Library tests
npm run dist    # release build: Termorc.app and a styled .dmg in src-tauri/target.noindex/release/bundle
                # (the .dmg step needs dmgbuild: pip3 install dmgbuild)
```

Set `TERMORC_DATA_DIR=/some/folder` to run a build with its own state and settings, apart from your everyday sessions.

The installer window's background is `build/dmg/background.svg`, rendered to `background.tiff` (1× and 2×); the layout lives in `scripts/dmg-settings.py`.

The icon's source is `build/icon.svg`. After editing it, regenerate the app icons with `npx tauri icon build/icon.svg -o src-tauri/icons`, then delete the non-macOS sizes.
