import AppKit
import TermorcCore
import UserNotifications

// Everything that changes sessions, tabs and Spaces goes through here (actions.js).

struct Dest: Equatable {
    enum Section: String { case fav, pinned, today }
    var section: Section
    var spaceId: String?
    var folderId: String?
    var index: Int = -1
}

@MainActor
extension Store {
    // ---- Lookups ------------------------------------------------------------------------
    var activeSpace: Space { model.spaces.first { $0.id == model.activeSpaceId } ?? model.spaces[0] }
    var activeTabId: String? { activeSpace.activeTabId }
    var activeTab: Tab? { activeTabId.flatMap { model.tabs[$0] } }
    var focusedSid: String? { activeTab?.activeSid }

    func space(_ id: String?) -> Space? { model.spaces.first { $0.id == id } }

    func locate(_ tid: String, in s: AppModel? = nil) -> Dest? {
        let s = s ?? model
        if s.favorites.contains(tid) { return Dest(section: .fav) }
        for sp in s.spaces {
            if sp.pinned.contains(tid) { return Dest(section: .pinned, spaceId: sp.id) }
            if sp.today.contains(tid) { return Dest(section: .today, spaceId: sp.id) }
            for f in sp.folders where f.tabs.contains(tid) { return Dest(section: .pinned, spaceId: sp.id, folderId: f.id) }
        }
        return nil
    }

    func tabOfSession(_ sid: String, in s: AppModel? = nil) -> Tab? {
        (s ?? model).tabs.values.first { $0.layout.leaves.contains(sid) }
    }

    func spaceForTab(_ tid: String, in s: AppModel? = nil) -> String {
        let s = s ?? model
        return locate(tid, in: s)?.spaceId ?? s.activeSpaceId
    }

    func profileFor(_ id: String?) -> Profile {
        model.profiles.first { $0.id == id } ?? model.profiles.first { $0.id == model.defaultProfileId } ?? model.profiles.first ?? .default
    }

    func spaceStartDir(_ sp: Space?) -> String {
        let p = profileFor(sp?.profileId)
        if p.cwdMode == "home" { return home }
        if p.cwdMode == "custom", !p.cwd.isEmpty { return Routing.expandHome(p.cwd, home: home) }
        return Routing.expandHome(sp?.startDir ?? "~", home: home)
    }

    func defaultCwd(_ sp: Space) -> String {
        switch model.settings.newTerminalDir {
        case "home": return home
        case "current":
            if let sid = focusedSid, sp.id == model.activeSpaceId, let cwd = rt[sid]?.cwd ?? model.sessions[sid]?.cwd { return cwd }
        default: break
        }
        return spaceStartDir(sp)
    }

    // ---- List surgery -----------------------------------------------------------------
    static func detach(_ s: AppModel, _ tid: String) -> AppModel {
        var s = s
        s.favorites.removeAll { $0 == tid }
        for i in s.spaces.indices {
            s.spaces[i].pinned.removeAll { $0 == tid }
            s.spaces[i].today.removeAll { $0 == tid }
            for j in s.spaces[i].folders.indices { s.spaces[i].folders[j].tabs.removeAll { $0 == tid } }
            if s.spaces[i].activeTabId == tid { s.spaces[i].activeTabId = nil }
        }
        return s
    }

    static func attach(_ s: AppModel, _ tid: String, _ d: Dest) -> AppModel {
        var s = s
        func put(_ list: inout [String]) {
            list.removeAll { $0 == tid }
            if d.index < 0 || d.index > list.count { list.append(tid) } else { list.insert(tid, at: d.index) }
        }
        if d.section == .fav {
            put(&s.favorites)
            return s
        }
        guard let i = s.spaces.firstIndex(where: { $0.id == d.spaceId }) else { return s }
        if let fid = d.folderId, let j = s.spaces[i].folders.firstIndex(where: { $0.id == fid }) {
            s.spaces[i].folders[j].open = true
            put(&s.spaces[i].folders[j].tabs)
        } else if d.section == .pinned {
            put(&s.spaces[i].pinned)
        } else {
            put(&s.spaces[i].today)
        }
        return s
    }

    static func setActiveTab(_ s: AppModel, _ spaceId: String, _ tid: String?) -> AppModel {
        var s = s
        s.activeSpaceId = spaceId
        if let i = s.spaces.firstIndex(where: { $0.id == spaceId }) { s.spaces[i].activeTabId = tid }
        return s
    }

    // ---- Sessions ---------------------------------------------------------------------
    var integrationDir: String {
        if let res = Bundle.main.resourceURL?.appendingPathComponent("shell-integration"), FileManager.default.fileExists(atPath: res.path) {
            return res.path
        }
        // Running from `swift run`: the repo's copy.
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return repo.appendingPathComponent("Resources/shell-integration").path
    }

    func startSession(_ sid: String, initialCommand: String = "", ownPrompt: Bool? = nil) {
        guard let meta = model.sessions[sid] else { return }
        let tab = tabOfSession(sid)
        let sp = space(tab.map { spaceForTab($0.id) } ?? model.activeSpaceId)
        let p = profileFor(meta.profileId)
        // Termorc draws its own prompt only once the input bar exists; until then the shell keeps its own.
        let own = ownPrompt ?? (InputBar.available && model.settings.promptStyle != "shell")
        let launch = ShellLaunch.make(.init(command: p.command, profileEnv: p.envPairs, startup: p.startup, spaceName: sp?.name ?? "", cwd: meta.cwd.isEmpty ? home : meta.cwd, ownPrompt: own, integrationDir: integrationDir))
        let s = termSession(sid)
        let error = s.start(launch, ownPrompt: own, initialCommand: initialCommand)
        patchRt(sid) {
            $0.cwd = meta.cwd
            $0.startedAt = nowMillis()
            $0.shell = launch.shell
            $0.proc = launch.shell
            $0.alive = error == nil
            $0.integrated = launch.integrated
            $0.ownPrompt = s.ownPrompt
            if error != nil { $0.status = .fail } else if $0.status != .fail { $0.status = .idle }
        }
        if !meta.cwd.isEmpty { refreshGit(sid, meta.cwd) }
    }

    // Showing a pane calls this; restored sessions only get a shell when first shown.
    func ensureStarted(_ sid: String) {
        let s = termSession(sid)
        guard !s.alive else { return }
        let meta = model.sessions[sid]
        // A restored ssh session reconnects on first show.
        let rerun = !s.started && Routing.sshTarget(meta?.command) != nil ? (meta?.command ?? "") : ""
        startSession(sid, initialCommand: rerun)
    }

    struct OpenOptions {
        var cwd: String?
        var command = ""
        var spaceId: String?
        var section: Dest.Section = .today
        var folderId: String?
        var splitOf: String?
        var edge: Layout.Edge = .right
        var name: String?
        var profileId: String?
        var activate = true
        var content = ""
    }

    @discardableResult
    func openTerminal(_ o: OpenOptions = OpenOptions()) -> (sid: String, tid: String) {
        let target = space(o.spaceId) ?? activeSpace
        let dir = o.cwd.map { Routing.expandHome($0, home: home) } ?? defaultCwd(target)
        let profile = o.profileId ?? target.profileId ?? model.defaultProfileId
        let sid = uid("s")
        let now = nowMillis()
        var tid = ""
        var next = model
        next.sessions[sid] = SessionMeta(id: sid, cwd: dir, profileId: profile, command: o.command, createdAt: now)
        if let host = o.splitOf.flatMap({ next.tabs[$0] }), host.layout.leaves.count < Layout.maxPanes {
            tid = host.id
            next.tabs[tid]?.layout = host.layout.inserting(sid, nextTo: host.activeSid, edge: o.edge)
            next.tabs[tid]?.activeSid = sid
        } else {
            tid = uid("t")
            next.tabs[tid] = Tab(id: tid, name: o.name, layout: .leaf(sid), activeSid: sid, createdAt: now)
            next = Store.attach(next, tid, Dest(section: o.section, spaceId: target.id, folderId: o.folderId))
        }
        if o.activate { next = Store.setActiveTab(next, o.section == .fav ? next.activeSpaceId : spaceForTab(tid, in: next), tid) }
        model = next

        let s = termSession(sid)
        if !o.content.isEmpty { s.restore(o.content) }
        startSession(sid, initialCommand: o.command)
        if o.activate {
            ui.view = .terminal
            ui.focusedSid = sid
            focusTerminal(sid)
        }
        return (sid, tid)
    }

    private func removeSessionFromTab(_ sid: String) {
        let tab = tabOfSession(sid)
        var next = model
        next.sessions[sid] = nil
        if let tab {
            if let layout = tab.layout.removing(sid) {
                let leaves = layout.leaves
                next.tabs[tab.id]?.layout = layout
                next.tabs[tab.id]?.activeSid = leaves.contains(tab.activeSid) ? tab.activeSid : leaves[leaves.count - 1]
            } else {
                let loc = locate(tab.id, in: next)
                let sp = next.spaces.first { $0.id == (loc?.spaceId ?? next.activeSpaceId) }
                let order = sp?.allTabs ?? []
                let idx = order.firstIndex(of: tab.id) ?? 0
                next.tabs[tab.id] = nil
                next = Store.detach(next, tab.id)
                if let sp, sp.activeTabId == tab.id, let i = next.spaces.firstIndex(where: { $0.id == sp.id }) {
                    let rest = order.filter { $0 != tab.id }
                    next.spaces[i].activeTabId = rest.isEmpty ? nil : rest[min(idx, rest.count - 1)]
                }
            }
        }
        model = next
        disposeSession(sid)
        Persistence.removeScrollback(sid, paths)
        syncFocus()
    }

    func isBusy(_ sid: String) -> Bool { rt[sid]?.busy ?? false }

    // An idle Today session just closes. A pinned or Favorite one, or one with something
    // running, asks first. `sids` alone means panes leaving a split that stays open.
    func okToClose(tids: [String] = [], sids explicit: [String]? = nil, archive: Bool = false) async -> Bool {
        let sids = explicit ?? tids.flatMap { model.tabs[$0]?.layout.leaves ?? [] }
        let busy = sids.filter(isBusy)
        let kept = tids.filter { [.pinned, .fav].contains(locate($0)?.section) }
        if busy.isEmpty && kept.isEmpty { return true }
        let first = busy.first ?? sids.first ?? ""
        let what = tids.count > 1 ? "\(tids.count) sessions" : "“\(model.tabs[tids.first ?? ""]?.name ?? Meta.sessionName(tabName: nil, rt: rt[first], cwd: nil, home: home))”"
        var detail: [String] = []
        if busy.count == 1 {
            let r = rt[busy[0]]
            detail.append("\(r?.command.isEmpty == false ? r!.command : (r?.proc.isEmpty == false ? r!.proc : "A process")) is still running and will be stopped.")
        } else if !busy.isEmpty {
            detail.append("\(busy.count) running processes will be stopped.")
        }
        if archive { detail.append("Scrollback and history are kept in the Library.") }
        else if kept.count > 1 { detail.append("\(kept.count) of them are pinned.") }
        else if let k = kept.first { detail.append(locate(k)?.section == .fav ? "It's a Favorite, shared by every Space." : "It's pinned to this Space.") }
        return await confirm(archive ? "Move \(what) to the Library?" : "Close \(what)?", detail: detail.joined(separator: " "), ok: archive ? "Move to Library" : "Close")
    }

    func confirm(_ message: String, detail: String, ok: String) async -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        alert.alertStyle = .warning
        alert.addButton(withTitle: ok)
        alert.addButton(withTitle: "Cancel")
        // Always on the main window, brought forward first. With the window closed (hidden) or
        // Termorc in the background, the alert ended up shrunk in a corner of the screen, and
        // a quit waiting on it looked like Termorc wouldn't quit.
        NSApp.activate(ignoringOtherApps: true)
        if let window {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
            if window.attachedSheet == nil {
                return await alert.beginSheetModal(for: window) == .alertFirstButtonReturn
            }
        }
        return alert.runModal() == .alertFirstButtonReturn
    }

    func closePane(_ sid: String? = nil, force: Bool = false) {
        guard let sid = sid ?? focusedSid, let tab = tabOfSession(sid) else { return }
        let whole = tab.layout.leaves.count == 1
        Task {
            if !force {
                let ok = whole ? await okToClose(tids: [tab.id]) : await okToClose(sids: [sid])
                guard ok else { return }
            }
            removeSessionFromTab(sid)
            ensureSession(closed: true)
        }
    }

    func closeTab(_ tid: String) {
        guard let tab = model.tabs[tid] else { return }
        Task {
            guard await okToClose(tids: [tid]) else { return }
            for sid in tab.layout.leaves { removeSessionFromTab(sid) }
            ensureSession(closed: true)
        }
    }

    // ---- Always a session -------------------------------------------------------------
    // The active Space always shows a session: another of its own, or a fresh terminal.
    // Closing the last one in a Space moves to the nearest Space that has sessions, and
    // closing the very last session quits.
    func ensureSession(closed: Bool = false) {
        guard loaded, !quitting, !quitRequested else { return }
        let sp = activeSpace
        if let t = sp.activeTabId, model.tabs[t] != nil { return }
        if let fallback = (sp.allTabs + model.favorites).first(where: { model.tabs[$0] != nil }) {
            model = Store.setActiveTab(model, sp.id, fallback)
            syncFocus()
            return
        }
        if closed {
            let at = model.spaces.firstIndex { $0.id == sp.id } ?? 0
            let near = model.spaces.enumerated()
                .filter { $0.element.id != sp.id && $0.element.allTabs.contains { model.tabs[$0] != nil } }
                .min { abs($0.offset - at) < abs($1.offset - at) }
            if let near { return switchSpace(near.element.id) }
            quitRequested = true
            NSApp.terminate(nil)
            return
        }
        openTerminal(OpenOptions(spaceId: sp.id))
    }

    // Catches every other way a Space ends up empty: switching to it, creating it,
    // archiving or moving its sessions away. Deferred so a close can decide first.
    func afterChange() {
        guard loaded, !ensureQueued else { return }
        if let t = activeSpace.activeTabId, model.tabs[t] != nil { return }
        ensureQueued = true
        DispatchQueue.main.async { [weak self] in
            self?.ensureQueued = false
            self?.ensureSession()
        }
    }

    func onExit(_ sid: String, _ code: Int32?) {
        // Shells die because we're quitting: keep their tabs for the next launch.
        guard !quitting else { return }
        let tab = tabOfSession(sid)
        let loc = tab.flatMap { locate($0.id) }
        let keep = (loc?.section == .pinned || loc?.section == .fav) && tab?.layout.leaves.count == 1
        if keep {
            let suffix = (code ?? 0) != 0 ? " with code \(code!)" : ""
            sessions[sid]?.view.feed(text: "\r\n\u{1b}[2m[process exited\(suffix) — click to restart]\u{1b}[0m\r\n")
            patchRt(sid) { $0.alive = false; $0.status = .idle }
        } else {
            removeSessionFromTab(sid)
            ensureSession(closed: true)
        }
    }

    // ---- Settings -----------------------------------------------------------------------
    // Settings is a page in place of the terminal; its sidebar row stays while it's open.
    func openSettings(_ tab: String? = nil) {
        if let tab { ui.settingsTab = tab }
        ui.settingsOpen = true
        ui.overlay = nil
        ui.view = .settings
    }

    func closeSettings() {
        let shown = ui.view == .settings
        ui.settingsOpen = false
        if shown {
            ui.view = .terminal
            syncFocus()
        }
    }

    func toggleSettings() { ui.view == .settings ? closeSettings() : openSettings() }

    // ---- Activation ---------------------------------------------------------------------
    func activateTab(_ tid: String, focus: Bool = true) {
        guard let tab = model.tabs[tid] else { return }
        let spaceId = locate(tid)?.spaceId ?? model.activeSpaceId
        model = Store.setActiveTab(model, spaceId, tid)
        ui.view = .terminal
        for sid in tab.layout.leaves {
            if (rt[sid]?.bell ?? 0) > 0 { patchRt(sid) { $0.bell = 0 } }
            if let s = sessions[sid], !s.alive, s.started { startSession(sid) }
        }
        markSpaceSeen(spaceId)
        syncFocus(focus)
    }

    func focusSession(_ sid: String) {
        guard let tab = tabOfSession(sid) else { return }
        if tab.activeSid != sid { model.tabs[tab.id]?.activeSid = sid }
        if activeTabId != tab.id { activateTab(tab.id) } else { syncFocus() }
    }

    func syncFocus(_ doFocus: Bool = true) {
        let sid = focusedSid
        if ui.focusedSid != sid { ui.focusedSid = sid }
        if let sid, doFocus { focusTerminal(sid) }
    }

    // Makes the session's terminal first responder once the card has laid it out.
    func focusTerminal(_ sid: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let s = sessions[sid], let w = s.view.window, ui.view == .terminal, ui.overlay == nil else { return }
            let target: NSView = s.composerActive ? s.composer!.editor : s.view
            if w.firstResponder !== target { w.makeFirstResponder(target) }
        }
    }

    func jumpTo(_ sid: String, row: Int? = nil) {
        focusSession(sid)
        if let row { DispatchQueue.main.async { self.sessions[sid]?.scroll(toRow: max(0, row - 1)) } }
    }

    var sidebarOrder: [String] { model.favorites + activeSpace.allTabs }

    func cycleTab(_ delta: Int) {
        let order = sidebarOrder
        guard !order.isEmpty else { return }
        let i = order.firstIndex(of: activeTabId ?? "") ?? 0
        activateTab(order[((i + delta) % order.count + order.count) % order.count])
    }

    func activateIndex(_ n: Int) {
        let order = sidebarOrder
        if n < order.count { activateTab(order[n]) }
    }

    // ---- Spaces -------------------------------------------------------------------------
    func switchSpace(_ id: String) {
        guard model.spaces.contains(where: { $0.id == id }) else { return }
        model.activeSpaceId = id
        markSpaceSeen(id)
        syncFocus()
    }

    func switchSpace(by delta: Int) {
        let i = model.spaces.firstIndex { $0.id == model.activeSpaceId } ?? 0
        let n = model.spaces.count
        switchSpace(model.spaces[((i + delta) % n + n) % n].id)
    }

    func createSpace(_ space: Space) {
        model.spaces.append(space)
        model.activeSpaceId = space.id
        syncFocus()
    }

    // A fresh, empty Space with the next unused color and glyph (swiping past the last Space).
    @discardableResult
    func createBlankSpace() -> String {
        let used = Set(model.spaces.map { $0.color.lowercased() })
        let n = model.spaces.count
        let color = Meta.spaceColors.first { !used.contains($0) } ?? Meta.spaceColors[n % Meta.spaceColors.count]
        let space = Space(name: "Space \(n + 1)", glyph: Meta.spaceGlyphs[n % Meta.spaceGlyphs.count], color: color)
        createSpace(space)
        toast("\(space.name) created", detail: "Swipe back to return.", action: ("Rename", { [weak self] in
            self?.ui.overlay = .spaceEditor(space.id)
            self?.ui.toast = nil
        }))
        return space.id
    }

    func updateSpace(_ id: String, _ fn: (inout Space) -> Void) {
        guard let i = model.spaces.firstIndex(where: { $0.id == id }) else { return }
        fn(&model.spaces[i])
    }

    func deleteSpace(_ id: String) {
        guard model.spaces.count > 1, let sp = space(id) else { return }
        let n = sp.allTabs.count
        Task {
            let detail = n > 0 ? "Its \(n) session\(n > 1 ? "s" : "") will be moved to the Library." : "This can't be undone."
            guard await confirm("Delete “\(sp.name)”?", detail: detail, ok: "Delete Space") else { return }
            if n > 0 { commitArchive(sp.allTabs, reason: "closed") }
            var next = model
            next.spaces.removeAll { $0.id == id }
            if next.activeSpaceId == id { next.activeSpaceId = next.spaces[0].id }
            model = next
            syncFocus()
        }
    }

    func reorderSpaces(from: Int, to: Int) {
        guard from != to, model.spaces.indices.contains(from) else { return }
        let m = model.spaces.remove(at: from)
        model.spaces.insert(m, at: min(max(0, to), model.spaces.count))
    }

    func markSpaceSeen(_ spaceId: String) {
        guard model.activity.contains(where: { $0.spaceId == spaceId && !$0.seen }) else { return }
        for i in model.activity.indices where model.activity[i].spaceId == spaceId { model.activity[i].seen = true }
    }

    // ---- Moving tabs ----------------------------------------------------------------------
    func moveTab(_ tid: String, to dest: Dest) {
        let wasActive = activeSpace.activeTabId == tid
        var next = Store.attach(Store.detach(model, tid), tid, dest)
        if dest.section != .fav, dest.spaceId == model.activeSpaceId, wasActive { next = Store.setActiveTab(next, dest.spaceId!, tid) }
        model = next
    }

    func renameTab(_ tid: String, _ name: String) {
        let n = name.trimmingCharacters(in: .whitespaces)
        model.tabs[tid]?.name = n.isEmpty ? nil : n
    }

    // Per-tab look: an icon in the sidebar gutter and a color that tints the row.
    func setTabStyle(_ tid: String, icon: String?? = .none, color: String?? = .none) {
        guard model.tabs[tid] != nil else { return }
        if case .some(let i) = icon { model.tabs[tid]?.icon = i }
        if case .some(let c) = color { model.tabs[tid]?.color = c }
    }

    func toggleTabEffect(_ tid: String, _ effect: String) {
        guard let tab = model.tabs[tid] else { return }
        model.tabs[tid]?.effects[effect] = !tab.has(effect)
    }

    @discardableResult
    func createFolder(_ spaceId: String, name: String = "New Folder") -> String {
        let id = uid("f")
        updateSpace(spaceId) { $0.folders.append(Folder(id: id, name: name)) }
        return id
    }

    func updateFolder(_ spaceId: String, _ folderId: String, _ fn: (inout Folder) -> Void) {
        updateSpace(spaceId) { sp in
            if let j = sp.folders.firstIndex(where: { $0.id == folderId }) { fn(&sp.folders[j]) }
        }
    }

    func deleteFolder(_ spaceId: String, _ folderId: String) {
        updateSpace(spaceId) { sp in
            let f = sp.folders.first { $0.id == folderId }
            sp.pinned += f?.tabs ?? []
            sp.folders.removeAll { $0.id == folderId }
        }
    }

    func moveFolder(_ spaceId: String, _ folderId: String, to index: Int) {
        updateSpace(spaceId) { sp in
            guard let f = sp.folders.first(where: { $0.id == folderId }) else { return }
            sp.folders.removeAll { $0.id == folderId }
            sp.folders.insert(f, at: max(0, min(index, sp.folders.count)))
        }
    }

    // ---- Splits ---------------------------------------------------------------------------
    func splitActive(_ edge: Layout.Edge = .right) {
        guard let tab = activeTab else { openTerminal(); return }
        guard tab.layout.leaves.count < Layout.maxPanes else { return }
        let cwd = rt[tab.activeSid]?.cwd ?? model.sessions[tab.activeSid]?.cwd
        openTerminal(OpenOptions(cwd: cwd, splitOf: tab.id, edge: edge))
    }

    // Drop a sidebar tab onto an edge of the active card.
    func mergeIntoActive(_ tid: String, edge: Layout.Edge) {
        guard let target = activeTab, let src = model.tabs[tid], target.id != tid,
              target.layout.leaves.count + src.layout.leaves.count <= Layout.maxPanes else { return }
        var next = model
        next.tabs[target.id]?.layout = target.layout.insertingRoot(src.layout, edge: edge)
        next.tabs[target.id]?.activeSid = src.activeSid
        next.tabs[tid] = nil
        model = Store.detach(next, tid)
        syncFocus()
    }

    // Drop one sidebar session onto another (Arc-style): they become one split session.
    @discardableResult
    func mergeTabs(_ srcTid: String, into targetTid: String, edge: Layout.Edge = .right) -> Bool {
        guard let src = model.tabs[srcTid], let target = model.tabs[targetTid], srcTid != targetTid else { return false }
        guard target.layout.leaves.count + src.layout.leaves.count <= Layout.maxPanes else {
            toast("That split is full", detail: "A session holds up to \(Layout.maxPanes) panes.")
            return false
        }
        var next = model
        next.tabs[targetTid]?.layout = target.layout.insertingRoot(src.layout, edge: edge)
        next.tabs[targetTid]?.activeSid = src.activeSid
        next.tabs[srcTid] = nil
        model = Store.detach(next, srcTid)
        activateTab(targetTid)
        return true
    }

    // Pull one pane out of a split into its own row: Today by default, or `dest`.
    @discardableResult
    func unsplit(_ sid: String, to dest: Dest? = nil) -> String? {
        guard let tab = tabOfSession(sid), tab.layout.leaves.count > 1, let layout = tab.layout.removing(sid) else { return nil }
        let tid = uid("t")
        let spaceId = spaceForTab(tab.id)
        var next = model
        let leaves = layout.leaves
        next.tabs[tab.id]?.layout = layout
        next.tabs[tab.id]?.activeSid = leaves.contains(tab.activeSid) ? tab.activeSid : leaves[0]
        next.tabs[tid] = Tab(id: tid, layout: .leaf(sid), activeSid: sid, effects: tab.effects)
        model = Store.attach(next, tid, dest ?? Dest(section: .today, spaceId: spaceId))
        return tid
    }

    func setRatio(_ tid: String, path: [Layout.Step], ratio: Double) {
        guard let t = model.tabs[tid] else { return }
        model.tabs[tid]?.layout = t.layout.settingRatio(ratio, at: path)
    }

    func focusDirection(_ dir: Layout.Direction) {
        guard let tab = activeTab, let n = tab.layout.neighbor(of: tab.activeSid, dir) else { return }
        focusSession(n)
    }

    // ---- Guard rails ------------------------------------------------------------------------
    func effects(_ sid: String) -> [String: Bool] { tabOfSession(sid)?.effects ?? [:] }
    func isDanger(_ sid: String) -> Bool { effects(sid)["danger"] == true }

    func confirmThen(_ sid: String, title: String, detail: String, label: String, danger: Bool = false, run: @escaping () -> Void) {
        ui.confirm = UIState.Confirm(sid: sid, title: title, detail: detail, label: label, danger: danger, run: run)
    }

    func resolveConfirm(_ run: Bool) {
        guard let c = ui.confirm else { return }
        ui.confirm = nil
        if run { c.run() }
        focusTerminal(c.sid)
    }

    // Enter on a danger session: risky command lines ask first. Returns false to swallow the key.
    func allowEnter(_ sid: String) -> Bool {
        guard isDanger(sid), let s = sessions[sid] else { return true }
        let line = s.cursorLine()
        guard Routing.isRiskyCommand(line) else { return true }
        confirmThen(sid, title: "Run this on production?", detail: "You're about to run a privileged command on production.", label: "Run", danger: true) { [weak s] in s?.write("\r") }
        return false
    }

    // ---- Copy output, reconnect -------------------------------------------------------------
    func copyLastOutput(_ sid: String? = nil) {
        guard let sid = sid ?? focusedSid, let s = sessions[sid], let entry = s.lastFinished, let text = s.output(of: entry) else {
            toast("Nothing to copy yet", detail: "Run a command first — output is tracked per command.")
            return
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        ui.copied = sid
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
            if self?.ui.copied == sid { self?.ui.copied = nil }
        }
    }

    func jumpToFailure(_ sid: String) {
        let entry = sessions[sid]?.cmds.last { ($0.exit ?? 0) != 0 && $0.exit != 130 }
        focusSession(sid)
        if let row = entry?.start { DispatchQueue.main.async { self.sessions[sid]?.scroll(toRow: max(0, row - 1)) } }
    }

    func reconnect(_ sid: String? = nil) {
        guard let sid = sid ?? focusedSid, let d = rt[sid]?.dropped else { return }
        patchRt(sid) { $0.dropped = nil }
        sessions[sid]?.write(d.cmd + "\r")
        focusTerminal(sid)
    }

    // Branch and changed-file count for a session's directory; results for a cwd the session
    // has since left are dropped.
    func refreshGit(_ sid: String, _ cwd: String) {
        Task.detached(priority: .utility) {
            let branch = System.gitBranch(cwd)
            let changes = branch == nil ? nil : System.gitChanges(cwd)
            await MainActor.run {
                guard let self = Optional(Store.shared), (self.rt[sid]?.cwd ?? self.model.sessions[sid]?.cwd) == cwd else { return }
                self.patchRt(sid) {
                    $0.branch = branch
                    $0.changes = changes
                }
            }
        }
    }

    static func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    // Type a command at the prompt the way a person would, replacing anything half-typed.
    // Refuses while something is running so keystrokes never go to another program.
    @discardableResult
    func typeCommand(_ sid: String?, _ command: String) -> Bool {
        guard let sid else { return false }
        if rt[sid]?.status == .run {
            toast("Finish the running command first", detail: "Switching runs a command in this shell.")
            return false
        }
        if let s = sessions[sid], !s.alive { startSession(sid) }
        sessions[sid]?.write("\u{05}\u{15}" + command + "\r")
        focusSession(sid)
        return true
    }

    // Runs a command typed in the input bar, with the same production guard as typing it in
    // the terminal. Multi-line input goes as one bracketed paste so the shell runs it whole.
    @discardableResult
    func submitCommand(_ sid: String, _ command: String) -> Bool {
        if let s = sessions[sid], !s.alive { startSession(sid) }
        let data = command.contains("\n") ? "\u{1b}[200~\(command)\u{1b}[201~\r" : command + "\r"
        if isDanger(sid), Routing.isRiskyCommand(command) {
            confirmThen(sid, title: "Run this on production?", detail: "You're about to run a privileged command on production.", label: "Run", danger: true) { [weak self] in self?.sessions[sid]?.write(data) }
            return false
        }
        sessions[sid]?.write(data)
        return true
    }

    func runInSession(_ command: String, _ sid: String? = nil) {
        guard let sid = sid ?? focusedSid else { openTerminal(OpenOptions(command: command)); return }
        if let s = sessions[sid], !s.alive { startSession(sid) }
        sessions[sid]?.write(command + "\r")
        focusSession(sid)
    }

    func insertText(_ sid: String?, _ text: String) {
        guard let sid else { return }
        if let s = sessions[sid], !s.alive { startSession(sid) }
        if let s = sessions[sid], s.composerActive { s.composer?.receive(Array(text.utf8)) } else { sessions[sid]?.write(text) }
        focusSession(sid)
    }

    // ---- Toasts -----------------------------------------------------------------------------
    @discardableResult
    func toast(_ title: String, detail: String? = nil, action: (label: String, run: () -> Void)? = nil, seconds: Double = 4) -> String {
        let t = UIState.Toast(title: title, detail: detail, action: action)
        ui.toast = t
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            if self?.ui.toast?.id == t.id { self?.ui.toast = nil }
        }
        return t.id
    }

    // ---- Auto-archive & Library -------------------------------------------------------------
    func archiveCandidates() -> [String] {
        let now = Date()
        var out: [String] = []
        for sp in model.spaces {
            let hours = sp.archiveAfterH ?? model.settings.archiveAfterH
            guard hours > 0 else { continue }
            for tid in sp.today {
                if sp.id == model.activeSpaceId && sp.activeTabId == tid { continue }
                guard let tab = model.tabs[tid], !tab.has("noArchive") else { continue }
                let idle = tab.layout.leaves.allSatisfy { sid in
                    guard let s = sessions[sid] else { return true }
                    if isBusy(sid) { return false }
                    return now.timeIntervalSince(s.lastActivity) > hours * 3600
                }
                if idle { out.append(tid) }
            }
        }
        return out
    }

    func tidy(_ tids: [String]? = nil, reason: String = "idle", quiet: Bool = false) {
        let tids = tids ?? archiveCandidates()
        guard !tids.isEmpty else { return }
        let refs = tids.compactMap { tid in locate(tid).map { (tid, $0) } }
        var next = model
        for (tid, _) in refs { next = Store.detach(next, tid) }
        model = next
        syncFocus(false)
        var undone = false
        let locs = Dictionary(uniqueKeysWithValues: refs.map { ($0.0, $0.1) })
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            if !undone { self?.commitArchive(refs.map(\.0), reason: reason, locs: locs) }
        }
        guard !quiet else { return }
        let hours = activeSpace.archiveAfterH ?? model.settings.archiveAfterH
        let n = refs.count
        let title = reason == "idle" ? "Tidied \(n) idle session\(n > 1 ? "s" : "")" : "Moved \(n) session\(n > 1 ? "s" : "") to the Library"
        let detail = reason == "idle" ? "Idle for \(Int(hours))h · moved to Library" : "Scrollback and history are kept"
        toast(title, detail: detail, action: ("Undo", { [weak self] in
            guard let self else { return }
            undone = true
            var m = model
            for (tid, loc) in refs { m = Store.attach(m, tid, loc) }
            model = m
            ui.toast = nil
        }), seconds: 8)
    }

    func commitArchive(_ tids: [String], reason: String, locs: [String: Dest] = [:]) {
        let s = model
        for tid in tids {
            guard let tab = s.tabs[tid] else { continue }
            let spaceId = locs[tid]?.spaceId ?? locate(tid, in: s)?.spaceId ?? s.activeSpaceId
            let sp = s.spaces.first { $0.id == spaceId }
            for sid in tab.layout.leaves {
                let session = sessions[sid]
                let r = rt[sid] ?? SessionRuntime()
                let meta = s.sessions[sid]
                let cmds = (session?.cmds ?? []).filter { !$0.cmd.isEmpty }.map { LibraryEntry.Cmd(cmd: $0.cmd, exit: $0.exit, at: $0.at) }
                let ssh = cmds.reversed().lazy.compactMap { Routing.sshTarget($0.cmd) }.first
                let lastExit = cmds.reversed().first { $0.exit != nil }?.exit
                let name = tab.name ?? (r.command.isEmpty ? nil : r.command) ?? cmds.last?.cmd ?? Meta.leafOf(r.cwd ?? meta?.cwd, home: home)
                let entry = LibraryEntry(
                    id: sid, name: name, spaceId: spaceId, spaceName: sp?.name ?? "", cwd: r.cwd ?? meta?.cwd ?? home,
                    host: ssh?.host ?? "local", status: lastExit == nil ? "idle" : lastExit == 0 ? "ok" : "fail", exitCode: lastExit,
                    startedAt: meta?.createdAt ?? nowMillis(), endedAt: nowMillis(),
                    idleSince: session.map { Millis($0.lastActivity.timeIntervalSince1970 * 1000) } ?? nowMillis(),
                    reason: reason, commands: Array(cmds.suffix(100)), lines: 0)
                if let session { library.add(entry, ansi: session.saveHistory(scrollback: 5000)) }
                disposeSession(sid)
                Persistence.removeScrollback(sid, paths)
            }
        }
        var next = model
        for tid in tids {
            for sid in next.tabs[tid]?.layout.leaves ?? s.tabs[tid]?.layout.leaves ?? [] { next.sessions[sid] = nil }
            next.tabs[tid] = nil
            next = Store.detach(next, tid)
        }
        model = next
    }

    func archiveTabs(_ tids: [String]) {
        guard !tids.isEmpty else { return }
        Task {
            guard await okToClose(tids: tids, archive: true) else { return }
            tidy(tids, reason: "closed")
        }
    }

    func restoreFromLibrary(_ entry: LibraryEntry, spaceId: String? = nil) {
        let content = library.content(entry.id)
        let target = space(spaceId ?? entry.spaceId)?.id ?? model.activeSpaceId
        openTerminal(OpenOptions(cwd: entry.cwd, spaceId: target, content: content))
        library.remove(entry.id)
    }

    // ---- Snippets, profiles, settings -------------------------------------------------------
    func addSnippet(name: String, command: String, spaceId: String? = nil) {
        let clean = name.replacingOccurrences(of: "^/+", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"\s+"#, with: "-", options: .regularExpression)
        let n = clean.isEmpty ? "snippet" : clean
        let sp = spaceId ?? model.activeSpaceId
        model.snippets.removeAll { $0.name == n && $0.spaceId == sp }
        model.snippets.append(Snippet(id: uid("sn"), name: n, command: command, spaceId: sp, createdAt: nowMillis()))
        toast("Saved /\(n)", detail: "It now shows up in the command bar.")
    }

    func setSettings(_ fn: (inout Settings) -> Void) {
        fn(&model.settings)
        applySettings()
    }

    func applySettings() {
        let st = model.settings
        let appearance: NSAppearance? = st.termTheme == "light" ? NSAppearance(named: .aqua) : st.termTheme == "dark" ? NSAppearance(named: .darkAqua) : nil
        if ProcessInfo.processInfo.environment["TERMORC_APPEARANCE"] == nil, NSApp.appearance != appearance { NSApp.appearance = appearance }
        let dark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let theme = st.termTheme == "system" ? (dark ? "dark" : "light") : st.termTheme
        if ui.dark != dark { ui.dark = dark }
        if ui.termTheme != theme { ui.termTheme = theme }
        for s in sessions.values { configure(s) }
        MainMenu.rebuild()
    }

    func zoom(_ delta: Double) {
        setSettings { s in s.fontSize = delta == 0 ? Settings().fontSize : min(28, max(9, s.fontSize + delta)) }
    }

    // ⌘S: hide completely, like a native sidebar, then bring back whichever mode was showing.
    func toggleSidebar() {
        let cur = model.settings.sidebarMode
        if cur != "hidden" { UserDefaults.standard.set(cur, forKey: "lastSidebarMode") }
        let last = UserDefaults.standard.string(forKey: "lastSidebarMode") ?? "expanded"
        setSettings { $0.sidebarMode = cur == "hidden" ? last : "hidden" }
    }

    // ---- Notifications ----------------------------------------------------------------------
    func notifyFinished(_ sid: String, _ entry: TermSession.Command) {
        guard let tab = tabOfSession(sid) else { return }
        let spaceId = spaceForTab(tab.id)
        let sp = space(spaceId)
        let item = Activity(id: uid("a"), sid: sid, spaceId: spaceId, command: entry.cmd, exit: entry.exit ?? 0, dur: entry.dur ?? 0, at: nowMillis(), seen: spaceId == model.activeSpaceId && NSApp.isActive)
        model.activity = Array(([item] + model.activity).prefix(50))
        ui.notify = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
            if self?.ui.notify?.id == item.id { self?.ui.notify = nil }
        }
        let os = model.settings.osNotify
        guard os == "always" || (os == "background" && !NSApp.isActive), Bundle.main.bundleURL.pathExtension == "app" else { return }
        let content = UNMutableNotificationContent()
        content.title = "\(entry.cmd) \((entry.exit ?? 0) != 0 ? "failed (exit \(entry.exit!))" : "finished")"
        content.body = "\(sp?.name ?? "") · \(Meta.formatDuration(entry.dur))"
        content.sound = .default
        content.userInfo = ["sid": sid]
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { ok, _ in
            guard ok else { return }
            center.add(UNNotificationRequest(identifier: item.id, content: content, trigger: nil))
        }
    }
}
