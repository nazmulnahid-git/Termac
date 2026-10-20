# Termac

A macOS terminal where every session lives in a vertical sidebar, grouped into colored **Spaces**.

## What it does

- **Spaces.** Each Space has its own color, pinned sessions, folders, start directory and shell profile. Switch with ⌃1–9, ⌃←/→, a two-finger swipe on the sidebar, or the All Spaces overview (⌃↑ or pinch).
- **Sidebar.** It has four parts:
  - Favorites: always-on sessions shared by every Space.
  - Pinned: named sessions in collapsible folders.
  - Today: temporary sessions.
  - Live status on every row: running, idle, ✓ done, ! failed (hover for the exit code, click to jump to the error), and a bell badge.
- **Command bar (⌘T).** One fuzzy search over open sessions, recent directories, SSH hosts (`~/.ssh/config`), snippets and actions. Prefixes: `>` runs a command, `@` searches hosts, `/` searches snippets. ⇥ cycles filters.
- **Splits.** ⌘D / ⇧⌘D, up to four panes per card. You can also drag a sidebar row onto a card edge. Dividers snap to ⅓, ½ and ⅔. Drag a pane header back to the sidebar to unsplit it.
- **Peek.** Hover a row for 400 ms to see its last lines streaming live. ⇧-click keeps the peek open.
- **Auto-archive and Library (⌘Y).** Idle Today sessions move to the Library after 12 h (configurable, with Undo). Library search covers names, commands, output and paths. Restore brings back the scrollback.
- **Routing rules.** Rules decide where new sessions land, by directory glob, SSH host or command prefix. They can also add effects: a red danger frame, confirmation for multi-line pastes, or no auto-archive. On danger sessions, `sudo`, restarts and `rm -rf` ask before running.
- **Notes (⇧⌘N).** One Markdown doc per Space. It supports checklists and pasted output that remembers which session it came from. Code blocks can run in the current session or be saved as `/snippets`.
- **Quick Terminal (⌥Space).** A global drop-down panel. It opens in the frontmost Finder folder. "Move to Space" promotes it to a sidebar row with its scrollback intact.
- **Extras:**
  - ⇧⌘C copies only the last command's output.
  - A "Jump to bottom" pill appears when you scroll up.
  - Dropped SSH connections show a reconnect sheet.
  - Long jobs in other Spaces notify you.
  - Focus mode: ⌘S hides the sidebar, and hovering the left edge reveals it.

## How it works

| Layer | Notes |
| --- | --- |
| `electron/pty-host.js` | Owns every PTY (`node-pty`). Output is coalesced into one IPC message per window per ~4 ms. Ack-based flow control pauses runaway processes. The foreground process is polled every 1.5 s. |
| `electron/shell-integration/` | Hooks for zsh, bash and fish. They emit OSC 633 marks (prompt, command, exit code, cwd) and still load your own dotfiles. These marks drive the status dots, names, notifications, ⇧⌘C and the Library. |
| `electron/library.js` | Archived sessions: a JSON index plus one ANSI scrollback file each. Search reads files lazily with a bounded cache. |
| `src/term/registry.js` | One xterm.js instance per session. Off-screen terminals are parked, so xterm pauses their rendering. Only visible panes hold a WebGL context. Restored sessions get a shell only when first shown. |
| `src/state/` | Three small stores (persisted app model, runtime status, UI) with selector subscriptions. All mutations live in `actions.js`. |

State lives in `~/Library/Application Support/Termac/`:
- `state.json`
- `scrollback/` for live sessions across restarts
- `library/` for archived sessions

## Develop

```bash
npm install
npm run dev     # Vite + Electron with hot reload
npm test        # unit tests for routing, layout, fuzzy, keys, markdown
npm run start   # production build, then launch
npm run dist    # package a .dmg
```
