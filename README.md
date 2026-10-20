# Termac 🚀
### Arc Browser-Inspired macOS Terminal Wrapper

**Termac** is a modern macOS terminal wrapper inspired by the visual design and workflow of the **Arc Browser**. It is built on top of your default macOS shell (`zsh` by default) with an emphasis on effortless tab management, pinned directory bookmarks, and fluid keyboard navigation.

---

## ✨ Features

- **Arc-Style Vertical Sidebar**:
  - Pinned directory bookmarks with one-click launch, drag-and-drop reordering, and Finder integration.
  - Open tabs list with active highlight, close buttons, and process/directory titles.
  - Native macOS traffic light controls with proper inset and window dragging.
  - Collapsible sidebar (`⌘S`) into a minimalist dot/icon bar.
- **Persistent Directory Bookmarks**:
  - Pin frequently visited folders (Home, Desktop, Downloads, project repos).
  - Add bookmarks directly from Finder using the `+` directory picker.
  - Bookmark the active tab's current directory instantly with `⌘B` or the star button.
  - Right-click pinned folders to reveal them directly in Finder or copy paths.
- **Arc Command Palette (`⌘T` / `⌘K`)**:
  - Spotlight-style search modal with fuzzy search.
  - Switch between open tabs, jump to pinned bookmarks, or type a custom directory path.
  - Full keyboard navigation (Up/Down arrow, Enter, Escape).
- **Default Mac Terminal Engine**:
  - Powered by `node-pty` and `@xterm/xterm` running your default `/bin/zsh` shell.
  - Full 256-color and truecolor support, cursor blinking, link clicking, and responsive resizing.
  - Automatic directory tracking via process inspection (`lsof`).
  - Right-click context menus for tab duplication, closing other tabs, and copying paths.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `⌘ + T` / `⌘ + K` | Open Arc Command Palette / New tab switcher |
| `⌘ + W` | Close active terminal tab |
| `⌘ + S` | Toggle sidebar (collapse / expand) |
| `⌘ + 1` to `⌘ + 9` | Switch directly to tab 1 through 9 |
| `⌘ + [` / `⌘ + ]` | Navigate to previous / next tab |
| `⌘ + B` | Bookmark active tab's working directory |
| `Esc` | Close Command Palette or context menus |

---

## 🛠️ Tech Stack

- **Runtime**: Electron 33 (Native macOS vibrancy, frameless window with `hiddenInset` traffic lights)
- **Frontend**: React 18 + Vite 6
- **Terminal Emulator**: xterm.js 5 + FitAddon + WebLinksAddon
- **PTY Manager**: node-pty (macOS zsh process spawning and IO)
- **Persistence**: electron-store (stores pinned bookmarks and sidebar preferences)

---

## 🚀 Getting Started

### Development Mode
```bash
npm run dev
```

### Production Build & Preview
```bash
# Build Vite frontend and launch Electron
npm run preview

# Package as a standalone macOS DMG application
npm run build
```

