import AppKit
import TermorcCore

// One Space's sessions as a source list: its header, Pinned sessions (loose and in folders),
// Today, and "New Terminal". The sidebar shows the active Space's list, and while swiping
// between Spaces the neighbours' lists sit beside it on the same track.
@MainActor
final class SpaceList: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate, NSMenuDelegate {
    static var dragTid: String? // a session dragged from the compact rail (an AppKit drag)
    private static let registry = NSHashTable<SpaceList>.weakObjects()
    static var all: [SpaceList] { registry.allObjects }

    let spaceId: String
    let store = Store.shared
    let outline = SidebarOutlineView()
    let scroll = SidebarScrollView()
    private var items: [SidebarItem] = []
    private var folderRows: [String: [SidebarItem]] = [:]
    private var structureKey = ""
    private var renaming: String?
    private var boxes: [String: SidebarItemBox] = [:]

    // While a session or folder is dragged (see SidebarDrag): what's lifted out of the list,
    // where the gap is, and which row a drop would merge into or fill.
    private struct DragView: Equatable {
        var tab: String?
        var folder: String?
        var gap: Dest?
        var folderGap: Int?
        var height: CGFloat
        var merge: String?
        var ready = false
        var into: String?
    }
    private var dragView: DragView?

    init(spaceId: String) {
        self.spaceId = spaceId
        super.init()
        Self.registry.add(self)
        outline.list = self
        outline.headerView = nil
        outline.style = .sourceList
        // Picking a row focuses its terminal; the list itself never holds the keyboard.
        outline.refusesFirstResponder = true
        outline.rowSizeStyle = .custom
        outline.floatsGroupRows = false
        outline.indentationPerLevel = 14
        outline.autoresizesOutlineColumn = false
        outline.intercellSpacing = NSSize(width: 0, height: 2)
        let col = NSTableColumn(identifier: .init("main"))
        col.resizingMask = .autoresizingMask
        outline.addTableColumn(col)
        outline.outlineTableColumn = col
        outline.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        outline.dataSource = self
        outline.delegate = self
        outline.target = self
        outline.action = #selector(clicked)
        outline.doubleAction = #selector(doubleClicked)
        outline.registerForDraggedTypes([.termorcTab])
        outline.setDraggingSourceOperationMask(.move, forLocal: true)
        outline.draggingDestinationFeedbackStyle = .sourceList
        let menu = NSMenu()
        menu.delegate = self
        outline.menu = menu
        scroll.documentView = outline
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.horizontalScrollElasticity = .none
        refresh()
    }

    var space: Space { store.space(spaceId) ?? store.activeSpace }
    var isActive: Bool { spaceId == store.model.activeSpaceId }

    // ---- Data -----------------------------------------------------------------------------
    func refresh(animated: Bool = false) {
        let sp = space
        let dv = dragView
        // A list's rows, without the session being dragged and with the gap where it would land.
        func rows(_ ids: [String], _ list: Dest) -> [SidebarItem] {
            var out: [SidebarItem] = ids.filter { $0 != dv?.tab }.map { .tab($0) }
            if let g = dv?.gap, g.spaceId == sp.id, g.folderId == list.folderId, list.folderId != nil || g.section == list.section {
                out.insert(.placeholder, at: g.index < 0 ? out.count : min(g.index, out.count))
            }
            return out
        }
        var top: [SidebarItem] = []
        var kids: [String: [SidebarItem]] = [:]
        if store.ui.settingsOpen && isActive { top.append(.settings) }
        top.append(.spaceHeader(sp.id))
        let pinned = rows(sp.pinned, Dest(section: .pinned, spaceId: sp.id))
        top += pinned
        var folders: [SidebarItem] = []
        for f in sp.folders where f.id != dv?.folder {
            folders.append(.folder(sp.id, f.id))
            kids[f.id] = rows(f.tabs, Dest(section: .pinned, spaceId: sp.id, folderId: f.id))
        }
        if dv?.folder != nil, let i = dv?.folderGap { folders.insert(.placeholder, at: max(0, min(i, folders.count))) }
        top += folders
        if pinned.isEmpty && folders.isEmpty { top.append(.pinEmpty(sp.id)) }
        top.append(.todayHeader(sp.id))
        top += rows(sp.today, Dest(section: .today, spaceId: sp.id))
        top.append(.newTerminal)

        let key = top.map(\.key).joined(separator: "|") + "#" + kids.map { "\($0.key):\($0.value.map(\.key).joined(separator: ","))" }.sorted().joined(separator: ";") + "#" + sp.folders.map { "\($0.id)\($0.open)" }.joined() + "#\(UI.scale)\(store.model.settings.uiFontSize)"
        if key != structureKey {
            structureKey = key
            apply(top, kids, animated: animated)
        } else {
            // Same rows: update them in place, so hover and editing survive.
            for row in 0..<outline.numberOfRows {
                guard let item = outline.item(atRow: row) as? SidebarItemBox, let cell = outline.view(atColumn: 0, row: row, makeIfNecessary: false) else { continue }
                configure(cell, item.item)
            }
        }
        syncDropHighlights()
        syncSelection()
    }

    private func apply(_ top: [SidebarItem], _ kids: [String: [SidebarItem]], animated: Bool) {
        if animated, let (from, to) = gapMove(top, kids) {
            items = top
            folderRows = kids
            let parent = { (f: String?) in f.map { self.box(.folder(self.spaceId, $0)) } }
            outline.moveItem(at: from.1, inParent: parent(from.0), to: to.1, inParent: parent(to.0))
            return
        }
        items = top
        folderRows = kids
        outline.reloadData()
        for f in space.folders where f.open { outline.expandItem(outline.item(atRow: rowOf(.folder(spaceId, f.id)) ?? -1)) }
    }

    // When the only change is the gap moving, its old and new places as (folder or nil for the
    // top level, index), so the rows between can slide instead of the list reloading.
    private func gapMove(_ top: [SidebarItem], _ kids: [String: [SidebarItem]]) -> ((String?, Int), (String?, Int))? {
        func find(_ t: [SidebarItem], _ k: [String: [SidebarItem]]) -> (String?, Int)? {
            if let i = t.firstIndex(of: .placeholder) { return (nil, i) }
            for (f, list) in k { if let i = list.firstIndex(of: .placeholder) { return (f, i) } }
            return nil
        }
        func strip(_ t: [SidebarItem]) -> [SidebarItem] { t.filter { $0 != .placeholder } }
        guard let a = find(items, folderRows), let b = find(top, kids), a != b,
              strip(items) == strip(top), Set(folderRows.keys) == Set(kids.keys),
              folderRows.allSatisfy({ strip($0.value) == strip(kids[$0.key] ?? []) }) else { return nil }
        // A folder with no rows shows "Drop sessions here" instead; filling or emptying one
        // isn't a plain move.
        if let f = a.0, folderRows[f]?.count == 1 { return nil }
        if let f = b.0, kids[f]?.count == 1 { return nil }
        return (a, b)
    }

    // ---- Dragging (SidebarDrag) ---------------------------------------------------------------
    func showDrag(_ d: SidebarDrag?) {
        var v: DragView?
        if let d {
            var dv = DragView(height: UI.px(28))
            dv.tab = d.tid
            if case .folder(let s, let f) = d.item, s == spaceId {
                dv.folder = f
                dv.folderGap = d.folderGap
                dv.height = UI.px(30)
            }
            if let g = d.gap, g.section != .fav, g.spaceId == spaceId { dv.gap = g }
            switch d.target {
            case .arming(let t, _): dv.merge = t
            case .merge(let t, _): dv.merge = t; dv.ready = true
            case .list(let g, let f?) where g.spaceId == spaceId: dv.into = f
            default: break
            }
            v = dv
        }
        guard v != dragView else { return }
        dragView = v
        refresh(animated: v != nil)
    }

    // Rows a drop would merge into or fill light up.
    private func syncDropHighlights() {
        for row in 0..<outline.numberOfRows {
            guard let rv = outline.rowView(atRow: row, makeIfNecessary: false) as? SidebarRowBackground else { continue }
            let item = (outline.item(atRow: row) as? SidebarItemBox)?.item
            rv.drop = dropStyle(item)
            rv.split = isSplit(item)
        }
    }

    // Split rows show the focused pane's segment filled instead of the whole row selected.
    private func isSplit(_ i: SidebarItem?) -> Bool {
        guard case .tab(let t) = i else { return false }
        return (store.model.tabs[t]?.layout.leaves.count ?? 0) > 1 || dragView?.merge == t
    }

    private func dropStyle(_ i: SidebarItem?) -> SidebarRowBackground.Drop {
        guard let dv = dragView else { return .none }
        switch i {
        case .tab(let t) where t == dv.merge: return .soft // the incoming segment shows the rest
        case .folder(_, let f) where f == dv.into: return .ready
        default: return .none
        }
    }

    // What a drop at `p` (window coordinates) over this list would do.
    func dropTarget(at p: NSPoint, for d: SidebarDrag) -> SidebarDrag.Target? {
        let current = d.target
        let lp = outline.convert(p, from: nil)
        let row = outline.row(at: lp)
        guard row >= 0, let it = (outline.item(atRow: row) as? SidebarItemBox)?.item else { return current }
        let sp = space
        if case .folder(let fs, let dragged) = d.item {
            guard fs == spaceId else { return current }
            // Folders reorder among themselves: count the other folders' headers above the pointer.
            let above = (0..<outline.numberOfRows).filter { r in
                guard case .folder(_, let f) = (outline.item(atRow: r) as? SidebarItemBox)?.item, f != dragged else { return false }
                return outline.rect(ofRow: r).midY < lp.y
            }
            return .folders(above.count)
        }
        guard let tid = d.tid else { return current }
        let r = outline.rect(ofRow: row)
        let rel = (lp.y - r.minY) / max(1, r.height) // the outline is flipped: 0 at the row's top
        switch it {
        case .tab(let t):
            guard t != tid, var dest = store.locate(t), dest.section != .fav else { return current }
            // The middle of another session merges the two into one split.
            if rel > 0.28, rel < 0.72, SidebarDrag.canMerge(tid, into: t) {
                switch current {
                case .arming(let x, _) where x == t, .merge(let x, _) where x == t: return current
                default: return .arming(t, hold: current?.hold)
                }
            }
            let ids = SidebarDrag.list(dest, store.model).filter { $0 != tid }
            dest.index = (ids.firstIndex(of: t) ?? ids.count) + (rel > 0.5 ? 1 : 0)
            return .list(dest, spring: nil)
        case .placeholder:
            return current
        case .folder(let s, let f):
            let n = (sp.folders.first { $0.id == f }?.tabs ?? []).filter { $0 != tid }.count
            return .list(Dest(section: .pinned, spaceId: s, folderId: f, index: n), spring: f)
        case .folderEmpty(let s, let f):
            return .list(Dest(section: .pinned, spaceId: s, folderId: f, index: 0), spring: nil)
        case .spaceHeader, .pinEmpty:
            return .list(Dest(section: .pinned, spaceId: sp.id, index: 0), spring: nil)
        case .todayHeader:
            return .list(Dest(section: .today, spaceId: sp.id, index: 0), spring: nil)
        case .newTerminal:
            return .list(Dest(section: .today, spaceId: sp.id, index: sp.today.filter { $0 != tid }.count), spring: nil)
        default:
            return current
        }
    }

    // What a row press would drag, if anything.
    func dragItem(atRow row: Int) -> SidebarDrag.Item? {
        guard renaming == nil, row >= 0 else { return nil }
        switch (outline.item(atRow: row) as? SidebarItemBox)?.item {
        case .tab(let t): return .tab(t)
        case .folder(let s, let f): return .folder(spaceId: s, folderId: f)
        default: return nil
        }
    }

    func windowRect(ofTab tid: String) -> NSRect? {
        visibleRect(rowOf(.tab(tid)))
    }

    // The gap, or the closed folder it's hidden in.
    func windowRectOfGap() -> NSRect? {
        if let r = rowOf(.placeholder) { return visibleRect(r) }
        guard let g = dragView?.gap, let f = g.folderId else { return nil }
        return visibleRect(rowOf(.folder(spaceId, f)))
    }

    private func visibleRect(_ row: Int?) -> NSRect? {
        guard let row, row >= 0, outline.window != nil, scroll.superview != nil else { return nil }
        let r = outline.convert(outline.rect(ofRow: row), to: nil)
        // Only the list in the sidebar's viewport, not a neighbour waiting off to the side.
        let shown = scroll.convert(scroll.bounds, to: nil)
        return shown.intersects(r) ? r : nil
    }

    private func rowOf(_ item: SidebarItem) -> Int? {
        (0..<outline.numberOfRows).first { (outline.item(atRow: $0) as? SidebarItemBox)?.item == item }
    }

    private func syncSelection() {
        var want: Int?
        if isActive {
            if store.ui.view == .settings { want = rowOf(.settings) }
            else if let t = store.activeTabId, store.locate(t)?.section != .fav { want = rowOf(.tab(t)) }
        } else if let t = space.activeTabId {
            want = rowOf(.tab(t))
        }
        if let want {
            if outline.selectedRow != want { outline.selectRowIndexes([want], byExtendingSelection: false) }
        } else if outline.selectedRow != -1 {
            outline.deselectAll(nil)
        }
    }

    // NSOutlineView needs stable object identity for items.
    private func box(_ i: SidebarItem) -> SidebarItemBox {
        if let b = boxes[i.key], b.item == i { return b }
        let b = SidebarItemBox(i)
        boxes[i.key] = b
        return b
    }

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        guard let b = item as? SidebarItemBox else { return items.count }
        if case .folder(_, let fid) = b.item { return max(1, folderRows[fid]?.count ?? 0) }
        return 0
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        guard let b = item as? SidebarItemBox else { return box(items[index]) }
        if case .folder(let sp, let fid) = b.item {
            let kids = folderRows[fid] ?? []
            return box(kids.isEmpty ? .folderEmpty(sp, fid) : kids[index])
        }
        return box(.newTerminal)
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        if case .folder = (item as? SidebarItemBox)?.item { return true }
        return false
    }

    func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat {
        switch (item as? SidebarItemBox)?.item {
        case .spaceHeader, .todayHeader: return UI.px(34)
        case .pinEmpty: return UI.px(64)
        case .folderEmpty, .folder: return UI.px(30)
        case .placeholder: return dragView?.height ?? UI.px(28)
        default: return UI.px(28)
        }
    }

    func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool {
        switch (item as? SidebarItemBox)?.item {
        case .tab, .settings: return true
        default: return false
        }
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let i = (item as? SidebarItemBox)?.item else { return nil }
        let cell: NSView
        switch i {
        case .tab: cell = outlineView.makeView(withIdentifier: SessionRowView.id, owner: self) ?? SessionRowView()
        case .spaceHeader, .todayHeader: cell = outlineView.makeView(withIdentifier: SectionHeaderView.id, owner: self) ?? SectionHeaderView()
        case .folder: cell = outlineView.makeView(withIdentifier: FolderRowView.id, owner: self) ?? FolderRowView()
        case .placeholder: return NSTableCellView() // the gap
        default: cell = outlineView.makeView(withIdentifier: PlainRowView.id, owner: self) ?? PlainRowView()
        }
        configure(cell, i)
        return cell
    }

    func outlineView(_ outlineView: NSOutlineView, rowViewForItem item: Any) -> NSTableRowView? {
        let rv = SidebarRowBackground()
        if case .tab(let tid) = (item as? SidebarItemBox)?.item { rv.tint = store.model.tabs[tid]?.color.map { NSColor(hex: $0) } }
        rv.drop = dropStyle((item as? SidebarItemBox)?.item)
        rv.split = isSplit((item as? SidebarItemBox)?.item)
        return rv
    }

    private func configure(_ cell: NSView, _ i: SidebarItem) {
        switch (i, cell) {
        case (.tab(let tid), let c as SessionRowView):
            let pinned = store.locate(tid)?.section == .pinned
            let merging = dragView?.merge == tid ? dragView?.tab.flatMap(TabView.make) : nil
            c.configure(tid: tid, view: TabView.make(tid), active: store.activeTabId == tid, renaming: renaming == tid, pinned: pinned, incoming: merging, ready: dragView?.ready ?? false) { [weak self] name in
                self?.renaming = nil
                if let name { self?.store.renameTab(tid, name) }
            }
            // Pinned rows unload (Arc's −); the rest close.
            c.onClose = { [weak self] in pinned ? self?.store.unloadTab(tid) : self?.store.closeTab(tid) }
        case (.spaceHeader(let sid), let c as SectionHeaderView):
            guard let sp = store.space(sid) else { return }
            c.configure(title: sp.name, glyph: sp.glyph, icon: SpaceIcon.image(sp), color: NSColor(hex: sp.color), actions: [
                ("folder.badge.plus", "New folder", { [weak self] in self?.newFolder() }),
                ("ellipsis.circle", "Space options", { [weak self, weak c] in if let c { self?.spaceMenu(from: c) } }),
            ])
        case (.todayHeader(let sid), let c as SectionHeaderView):
            let n = store.space(sid)?.today.count ?? 0
            c.configure(title: "Today", glyph: nil, color: nil, actions: n > 0 ? [("archivebox", "Move idle sessions to the Library", { [weak self] in self?.tidyNow() })] : [])
        case (.folder(let sid, let fid), let c as FolderRowView):
            guard let f = store.space(sid)?.folders.first(where: { $0.id == fid }) else { return }
            let running = f.tabs.contains { store.model.tabs[$0]?.layout.leaves.contains { store.rt[$0]?.status == .run } ?? false }
            c.configure(name: f.name, open: f.open, count: f.tabs.count, running: running, renaming: renaming == fid) { [weak self] name in
                self?.renaming = nil
                if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { self?.store.updateFolder(sid, fid) { $0.name = name.trimmingCharacters(in: .whitespaces) } }
            }
            c.onAdd = { [weak self] in self?.store.openTerminal(.init(spaceId: sid, section: .pinned, folderId: fid)) }
        case (.newTerminal, let c as PlainRowView):
            c.configure(symbol: "plus", text: "New Terminal", detail: Keys.format(store.model.settings.keybindings["newTerminal"]), dim: false)
        case (.settings, let c as PlainRowView):
            c.configure(symbol: "gearshape", text: "Settings", detail: nil, dim: false)
        case (.pinEmpty(let sid), let c as PlainRowView):
            c.configure(symbol: nil, text: "Drag a session here to keep it in \(store.space(sid)?.name ?? "this Space")", detail: nil, dim: true, dashed: true)
        case (.folderEmpty, let c as PlainRowView):
            c.configure(symbol: nil, text: "Drop sessions here", detail: nil, dim: true)
        default:
            break
        }
    }

    // ---- Clicks -----------------------------------------------------------------------------
    @objc private func clicked() {
        if !NSEvent.modifierFlags.contains(.shift) { Peek.shared.leftSidebar() }
        let row = outline.clickedRow
        guard row >= 0, let i = (outline.item(atRow: row) as? SidebarItemBox)?.item else { return }
        switch i {
        case .tab(let tid):
            if NSEvent.modifierFlags.contains(.shift) { return }
            let v = TabView.make(tid)
            if v?.status == .fail, store.activeTabId != tid, let f = v?.fail { store.jumpToFailure(f) } else { store.activateTab(tid) }
        case .newTerminal: store.openTerminal(.init(spaceId: spaceId))
        case .settings: store.openSettings()
        case .folder(let sid, let fid):
            let item = outline.item(atRow: row)
            store.updateFolder(sid, fid) { $0.open.toggle() }
            if outline.isItemExpanded(item) { outline.animator().collapseItem(item) } else { outline.animator().expandItem(item) }
        default: break
        }
    }

    @objc private func doubleClicked() {
        let row = outline.clickedRow
        guard row >= 0, let i = (outline.item(atRow: row) as? SidebarItemBox)?.item else { return }
        switch i {
        case .tab(let tid): startRename(tid)
        case .spaceHeader(let sid): store.ui.overlay = .spaceEditor(sid)
        case .folder(_, let fid): renameFolder(fid)
        default: break
        }
    }

    func startRename(_ tid: String) {
        renaming = tid
        if let row = rowOf(.tab(tid)), let cell = outline.view(atColumn: 0, row: row, makeIfNecessary: false) { configure(cell, .tab(tid)) }
    }

    private func renameFolder(_ fid: String) {
        renaming = fid
        structureKey = ""
        refresh()
    }

    func outlineViewItemDidExpand(_ notification: Notification) { syncFolderOpen(notification, open: true) }
    func outlineViewItemDidCollapse(_ notification: Notification) { syncFolderOpen(notification, open: false) }

    private func syncFolderOpen(_ n: Notification, open: Bool) {
        guard case .folder(let sid, let fid) = (n.userInfo?["NSObject"] as? SidebarItemBox)?.item else { return }
        if store.space(sid)?.folders.first(where: { $0.id == fid })?.open != open { store.updateFolder(sid, fid) { $0.open = open } }
    }

    private func newFolder(tid: String? = nil) {
        let fid = store.createFolder(spaceId)
        if let tid { store.moveTab(tid, to: Dest(section: .pinned, spaceId: spaceId, folderId: fid)) }
        renaming = fid
    }

    private func tidyNow() {
        let sp = space
        let tids = sp.today.filter { tid in
            guard tid != sp.activeTabId, let tab = store.model.tabs[tid], !tab.has("noArchive") else { return false }
            return tab.layout.leaves.allSatisfy { store.rt[$0]?.status != .run }
        }
        if tids.isEmpty { store.toast("Nothing to tidy", detail: "Running sessions and the open one stay put.") } else { store.tidy(tids) }
    }

    // ---- Menus ------------------------------------------------------------------------------
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = outline.clickedRow
        guard row >= 0, let i = (outline.item(atRow: row) as? SidebarItemBox)?.item else { return }
        switch i {
        case .tab(let tid): SidebarMenus.row(menu, tid: tid, rename: { [weak self] in self?.startRename(tid) }, newFolder: { [weak self] in self?.newFolder(tid: tid) })
        case .folder(let sid, let fid): SidebarMenus.folder(menu, spaceId: sid, folderId: fid, rename: { [weak self] in self?.renameFolder(fid) })
        case .spaceHeader(let sid): SidebarMenus.space(menu, spaceId: sid, newFolder: { [weak self] in self?.newFolder() })
        default: break
        }
    }

    private func spaceMenu(from view: NSView) {
        let menu = NSMenu()
        SidebarMenus.space(menu, spaceId: spaceId, newFolder: { [weak self] in self?.newFolder() })
        menu.popUp(positioning: nil, at: NSPoint(x: view.bounds.maxX - 30, y: view.bounds.minY), in: view)
    }

    // ---- Drag and drop ----------------------------------------------------------------------
    // Rows are dragged by SidebarDrag; AppKit drags from the compact rail land here.
    // Where a drop lands: between rows of Pinned / a folder / Today, into a folder, or onto
    // another session (they merge into one split, Arc-style).
    func outlineView(_ outlineView: NSOutlineView, validateDrop info: NSDraggingInfo, proposedItem item: Any?, proposedChildIndex index: Int) -> NSDragOperation {
        resolveDrop(item: item, index: index) == nil ? [] : .move
    }

    func outlineView(_ outlineView: NSOutlineView, acceptDrop info: NSDraggingInfo, item: Any?, childIndex index: Int) -> Bool {
        guard let tid = info.draggingPasteboard.string(forType: .termorcTab), let drop = resolveDrop(item: item, index: index) else { return false }
        switch drop {
        case .merge(let target): return store.mergeTabs(tid, into: target)
        case .move(let dest): store.moveTab(tid, to: dest)
        }
        return true
    }

    private enum Drop { case move(Dest), merge(String) }

    private func resolveDrop(item: Any?, index: Int) -> Drop? {
        let sp = space
        if let target = (item as? SidebarItemBox)?.item {
            switch target {
            case .tab(let t) where index == NSOutlineViewDropOnItemIndex:
                return t == Self.dragTid ? nil : .merge(t)
            case .folder(let s, let fid):
                let list = sp.folders.first { $0.id == fid }?.tabs ?? []
                return .move(Dest(section: .pinned, spaceId: s, folderId: fid, index: index < 0 ? list.count : adjusted(index, list)))
            default:
                return nil
            }
        }
        // Top level: between rows. Find the section the gap belongs to.
        guard index >= 0 else { return nil }
        let todayAt = items.firstIndex { if case .todayHeader = $0 { return true }; return false } ?? items.count
        if index <= todayAt {
            let pinnedStart = (items.firstIndex { if case .spaceHeader = $0 { return true }; return false } ?? 0) + 1
            let pos = max(0, min(index - pinnedStart, sp.pinned.count))
            return .move(Dest(section: .pinned, spaceId: sp.id, index: adjusted(pos, sp.pinned)))
        }
        let pos = max(0, min(index - todayAt - 1, sp.today.count))
        return .move(Dest(section: .today, spaceId: sp.id, index: adjusted(pos, sp.today)))
    }

    // Indexes count the dragged row itself; once it's removed from the list they shift by one.
    private func adjusted(_ index: Int, _ list: [String]) -> Int {
        guard let tid = Self.dragTid, let from = list.firstIndex(of: tid), from < index else { return index }
        return index - 1
    }
}

extension NSPasteboard.PasteboardType {
    static let termorcTab = NSPasteboard.PasteboardType("com.termorc.tab")
}

// What a sidebar row shows.
enum SidebarItem: Equatable {
    case settings
    case placeholder // the gap a dragged row would land in
    case spaceHeader(String)
    case tab(String)
    case folder(String, String)
    case folderEmpty(String, String)
    case pinEmpty(String)
    case todayHeader(String)
    case newTerminal

    var key: String {
        switch self {
        case .settings: return "settings"
        case .placeholder: return "ph"
        case .spaceHeader(let s): return "sh:\(s)"
        case .tab(let t): return "t:\(t)"
        case .folder(_, let f): return "f:\(f)"
        case .folderEmpty(_, let f): return "fe:\(f)"
        case .pinEmpty(let s): return "pe:\(s)"
        case .todayHeader(let s): return "th:\(s)"
        case .newTerminal: return "new"
        }
    }
}

final class SidebarItemBox: NSObject {
    let item: SidebarItem
    init(_ item: SidebarItem) { self.item = item }
}

// Overriding scrollWheel opts the list out of responsive scrolling, which would otherwise take
// a whole trackpad gesture off the main event path after its first event, hiding the rest of
// a horizontal swipe from the sidebar's Space switching.
final class SidebarScrollView: NSScrollView {
    override func scrollWheel(with event: NSEvent) { super.scrollWheel(with: event) }
}

final class SidebarOutlineView: NSOutlineView {
    weak var list: SpaceList?

    // Folder rows draw their own chevron.
    override func frameOfOutlineCell(atRow row: Int) -> NSRect { .zero }

    // Pressing a session or folder may start a drag; if the button comes up first it's a click.
    override func mouseDown(with event: NSEvent) {
        let row = self.row(at: convert(event.locationInWindow, from: nil))
        if event.clickCount == 1, event.modifierFlags.intersection([.shift, .command, .control, .option]).isEmpty,
           let item = list?.dragItem(atRow: row),
           SidebarDrag.track(item, source: rowView(atRow: row, makeIfNecessary: false) ?? self, event: event) {
            return
        }
        super.mouseDown(with: event)
    }
}

// Tinted rows (Icon & Color…) get a wash of their color under the content.
final class SidebarRowBackground: NSTableRowView {
    var tint: NSColor?
    // During a drag: the session a drop would merge with (soft while arming, ringed once
    // ready), or the folder it would go into.
    enum Drop { case none, soft, ready }
    var drop = Drop.none { didSet { if drop != oldValue { needsDisplay = true } } }
    var split = false { didSet { if split != oldValue { needsDisplay = true } } }
    var hovered = false { didSet { if hovered != oldValue { needsDisplay = true } } } // set by its SessionRowView

    override func drawSelection(in dirtyRect: NSRect) {
        if !split { super.drawSelection(in: dirtyRect) }
    }

    override func drawBackground(in dirtyRect: NSRect) {
        super.drawBackground(in: dirtyRect)
        if drop != .none {
            let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 10, dy: 1), xRadius: 7, yRadius: 7)
            let accent = MainActor.assumeIsolated { UI.accent() }
            (drop == .ready ? accent.withAlphaComponent(0.16) : NSColor.labelColor.withAlphaComponent(0.07)).setFill()
            path.fill()
            if drop == .ready {
                accent.setStroke()
                path.lineWidth = 1
                path.stroke()
            }
            return
        }
        guard !isSelected else { return }
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 10, dy: 1), xRadius: 6, yRadius: 6)
        if let tint {
            tint.withAlphaComponent(0.16).setFill()
            path.fill()
        }
        // Under the pointer, like Arc: a softer version of the selected row's fill.
        if hovered {
            NSColor.labelColor.withAlphaComponent(0.06).setFill()
            path.fill()
        }
    }
}
