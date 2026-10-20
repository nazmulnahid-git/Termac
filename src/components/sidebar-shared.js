// Behaviour shared by the expanded sidebar and the compact rail: peek, menus. Dragging lives in sidebar-drag.js.
import { app, ui } from '../state/model.js';
import * as A from '../state/actions.js';

const api = window.termac;
export const PANE_MIME = 'application/x-termac-pane';

// Folder that should start in rename mode (set right after creating it).
export const renameFolder = { id: null };

// ---- Peek ----------------------------------------------------------------------------
let peekTimer = null;
export function usePeek(tid, sid, isActive) {
  const enabled = app.use((s) => s.settings.gestures.peek);
  const show = (el, pinned = false) => {
    const r = el.getBoundingClientRect();
    ui.set((u) => ({ ...u, peek: { tid, sid, top: r.top, left: r.right + 14, pinned } }));
  };
  return {
    onMouseEnter(e) {
      if (!enabled || isActive || ui.get().dragging) return;
      clearTimeout(peekTimer);
      const el = e.currentTarget;
      if (ui.get().peek) show(el, ui.get().peek.pinned);
      else peekTimer = setTimeout(() => show(el), 400);
    },
    onMouseLeave() {
      clearTimeout(peekTimer);
    },
    onMouseDown(e) {
      if (!e.shiftKey || isActive) return;
      e.preventDefault();
      const p = ui.get().peek;
      if (p?.pinned && p.tid === tid) ui.set((u) => ({ ...u, peek: null }));
      else show(e.currentTarget, true);
    },
  };
}

export function closePeek() {
  clearTimeout(peekTimer);
  if (!ui.get().peek?.pinned) ui.set((u) => (u.peek ? { ...u, peek: null } : u));
}

// Tiny inline prompt rendered by App (window.prompt is unavailable in Electron).
export function promptText(title, value = '') {
  return new Promise((resolve) => ui.set((u) => ({ ...u, prompt: { title, value, resolve } })));
}

export function newFolder(spaceId, tid = null) {
  const fid = A.createFolder(spaceId);
  if (tid) A.moveTab(tid, { section: 'pinned', spaceId, folderId: fid });
  renameFolder.id = fid;
  return fid;
}

// ---- Menus ---------------------------------------------------------------------------
export async function rowMenu(e, tid, v, startRename) {
  e.preventDefault();
  const s = app.get();
  const loc = A.locate(tid, s);
  const sp = A.activeSpace(s);
  const eff = v.tab.effects || {};
  const cwd = v.active?.rt.cwd;
  const items = [
    startRename && { id: 'rename', label: 'Rename…' },
    { type: 'separator' },
    loc?.section === 'today' ? { id: 'pin', label: 'Pin to Space' } : { id: 'unpin', label: 'Move to Today' },
    loc?.section === 'fav' ? { id: 'unfav', label: 'Remove from Favorites' } : { id: 'fav', label: 'Add to Favorites' },
    {
      label: 'Move to Folder',
      submenu: [...sp.folders.map((f) => ({ id: `folder:${f.id}`, label: f.name, enabled: f.id !== loc?.folderId })), sp.folders.length && { type: 'separator' }, { id: 'newfolder', label: 'New Folder' }].filter(Boolean),
    },
    { label: 'Move to Space', submenu: s.spaces.map((x) => ({ id: `space:${x.id}`, label: `${x.glyph}  ${x.name}`, enabled: x.id !== loc?.spaceId })) },
    { type: 'separator' },
    A.activeTabId(s) !== tid && { id: 'split', label: 'Open in Split Right' },
    { id: 'dup', label: 'New Terminal Here' },
    cwd && { id: 'copypath', label: 'Copy Path' },
    cwd && { id: 'finder', label: 'Open in Finder' },
    { type: 'separator' },
    {
      label: 'Protection',
      submenu: [
        { id: 'fx:danger', label: 'Red danger frame', checked: !!eff.danger },
        { id: 'fx:confirmPaste', label: 'Confirm multi-line paste', checked: !!eff.confirmPaste },
        { id: 'fx:noArchive', label: 'Never auto-archive', checked: !!eff.noArchive },
      ],
    },
    { type: 'separator' },
    { id: 'archive', label: 'Move to Library' },
    { id: 'close', label: 'Close' },
  ].filter(Boolean);
  const id = await api.app.popupMenu(items);
  if (!id) return;
  if (id === 'rename') startRename();
  else if (id === 'pin') A.moveTab(tid, { section: 'pinned', spaceId: loc.spaceId });
  else if (id === 'unpin' || id === 'unfav') A.moveTab(tid, { section: 'today', spaceId: loc?.spaceId || sp.id });
  else if (id === 'fav') A.moveTab(tid, { section: 'fav', spaceId: null });
  else if (id === 'newfolder') newFolder(sp.id, tid);
  else if (id.startsWith('folder:')) A.moveTab(tid, { section: 'pinned', spaceId: sp.id, folderId: id.slice(7) });
  else if (id.startsWith('space:')) A.moveTab(tid, { section: loc?.section === 'pinned' ? 'pinned' : 'today', spaceId: id.slice(6) });
  else if (id === 'split') A.mergeIntoActive(tid, 'right');
  else if (id === 'dup') A.openTerminal({ cwd, viaRules: false });
  else if (id === 'copypath') navigator.clipboard.writeText(cwd);
  else if (id === 'finder') api.sys.reveal(cwd);
  else if (id.startsWith('fx:')) A.setTabEffects(tid, { [id.slice(3)]: !eff[id.slice(3)] });
  else if (id === 'archive') A.archiveTab(tid);
  else if (id === 'close') A.closeTab(tid);
}

export async function folderMenu(e, spaceId, folder, startRename) {
  e.preventDefault();
  e.stopPropagation();
  const id = await api.app.popupMenu([
    { id: 'new', label: 'New Terminal in Folder' },
    { id: 'rename', label: 'Rename…' },
    { type: 'separator' },
    { id: 'archive', label: 'Move Sessions to Library', enabled: folder.tabs.length > 0 },
    { id: 'delete', label: 'Remove Folder (keep sessions)' },
  ]);
  if (id === 'new') A.openTerminal({ section: 'pinned', spaceId, folderId: folder.id, viaRules: false });
  else if (id === 'rename') startRename();
  else if (id === 'archive') A.tidy(folder.tabs, { reason: 'closed' });
  else if (id === 'delete') A.deleteFolder(spaceId, folder.id);
}

export async function spaceMenu(space) {
  const s = app.get();
  const id = await api.app.popupMenu([
    { id: 'edit', label: 'Edit Space…' },
    { id: 'look', label: 'Terminal Background…' },
    { id: 'folder', label: 'New Folder' },
    { id: 'notes', label: 'Notes' },
    { type: 'separator' },
    { id: 'new', label: 'New Space…' },
    { id: 'overview', label: 'All Spaces' },
    { type: 'separator' },
    { id: 'delete', label: 'Delete Space…', enabled: s.spaces.length > 1 },
  ]);
  if (id === 'edit' || id === 'look') ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: space.id }));
  else if (id === 'folder') newFolder(space.id);
  else if (id === 'notes') ui.set((u) => ({ ...u, notesOpen: true }));
  else if (id === 'new') ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: null }));
  else if (id === 'overview') ui.set((u) => ({ ...u, overlay: 'overview' }));
  else if (id === 'delete') A.deleteSpace(space.id);
}
