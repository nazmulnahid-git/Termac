import AppKit
import TermorcCore

// The command bar (⌘T): one fuzzy search over open sessions, recent directories, SSH hosts,
// snippets and actions. `>` runs a command, `@` searches hosts, `/` snippets; ⇥ cycles the
// filter. ↵ opens, ⌘↵ opens a new terminal there, ⌥↵ opens it in a split.
@MainActor
final class CommandBar: NSObject, NSTextFieldDelegate, NSTableViewDataSource, NSTableViewDelegate {
    enum Mode { case open, new, split }

    struct Item {
        var key: String
        var group: String
        var label: String
        var sub: String = ""
        var extra: String = ""
        var symbol: String? = nil
        var glyph: (String, NSColor)? = nil
        var image: NSImage? = nil
        var mono = false
        var subMono = false
        var hint = ""
        var selHint = ""
        var bonus = 0.0
        var recency: Millis = 0
        var spaceId: String? = nil
        var active = false
        var tid: String? = nil
        var actionId: String? = nil
        var hl: [Int] = []
        var subHl: [Int] = []
        var score = 0.0
        var run: (Mode) -> Void
    }

    enum Row {
        case header(String)
        case item(Item)
    }

    static let groups: [(String, String)] = [("path", "Directory"), ("run", "Run"), ("session", "Open sessions"), ("dir", "Recent directories"), ("host", "SSH hosts"), ("snippet", "Snippets"), ("action", "Actions")]
    static let filters: [(String, String)] = [("all", "All"), ("session", "Sessions"), ("dir", "Directories"), ("host", "Hosts"), ("snippet", "Snippets"), ("action", "Actions")]
    static let emptyActions = ["newTerminal", "openDir", "splitRight", "library", "settings"]

    let store = Store.shared
    let panel: OverlayPanel
    private let field = NSTextField()
    private let filterButton = NSButton()
    private let table = NSTableView()
    private let none = NSTextField(labelWithString: "")
    private var rows: [Row] = []
    private var sel = 0
    private var filter = "all"
    private var cands: (sessions: [Item], dirs: [Item], hosts: [Item], snippets: [Item], actions: [Item]) = ([], [], [], [], [])
    var onClose: (() -> Void)?

    init(initial: String) {
        panel = OverlayPanel(size: NSSize(width: 680, height: UI.px(400)))
        super.init()
        build()
        cands = buildCandidates()
        field.stringValue = initial
        refresh()
    }

    private func build() {
        let root = panel.content
        let icon = NSImageView(image: NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: nil)!)
        icon.symbolConfiguration = .init(pointSize: 18, weight: .regular)
        icon.contentTintColor = .secondaryLabelColor
        field.placeholderString = "Search sessions, directories, hosts, snippets, actions…"
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = UI.font(1.22)
        field.delegate = self
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        filterButton.bezelStyle = .inline
        filterButton.controlSize = .regular
        filterButton.font = UI.font(0.86)
        filterButton.target = self
        filterButton.action = #selector(cycleFilter)
        let top = NSStackView(views: [icon, field, filterButton])
        top.spacing = 10
        top.edgeInsets = NSEdgeInsets(top: UI.px(12), left: 16, bottom: UI.px(12), right: 14)
        top.loosen()

        let col = NSTableColumn(identifier: .init("c"))
        table.addTableColumn(col)
        table.headerView = nil
        table.style = .plain
        table.backgroundColor = .clear
        table.intercellSpacing = NSSize(width: 0, height: 0)
        table.selectionHighlightStyle = .regular
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(clicked)
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        none.textColor = .secondaryLabelColor
        none.alignment = .center

        func footLabel(_ s: String) -> NSTextField {
            let l = NSTextField(labelWithString: s)
            l.font = UI.font(0.9)
            l.textColor = .secondaryLabelColor
            return l
        }
        let footSpacer = NSView()
        footSpacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let footRow = NSStackView(views: ["↑↓ navigate", "↵ open", "⌘↵ new terminal", "⌥↵ open in split"].map(footLabel) + [footSpacer, footLabel("> run · @ host · / snippet")])
        footRow.spacing = 16
        footRow.loosen()
        footRow.edgeInsets = NSEdgeInsets(top: 8, left: 18, bottom: 9, right: 18)

        let views: [NSView] = [top, NSBox.separator(), scroll, NSBox.separator(), footRow]
        for v in views {
            v.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(v)
        }
        NSLayoutConstraint.activate([
            views[0].topAnchor.constraint(equalTo: root.topAnchor),
            views[1].topAnchor.constraint(equalTo: views[0].bottomAnchor),
            views[2].topAnchor.constraint(equalTo: views[1].bottomAnchor),
            views[3].topAnchor.constraint(equalTo: views[2].bottomAnchor),
            views[4].topAnchor.constraint(equalTo: views[3].bottomAnchor),
            views[4].bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ] + views.flatMap { [$0.leadingAnchor.constraint(equalTo: root.leadingAnchor), $0.trailingAnchor.constraint(equalTo: root.trailingAnchor)] })
        none.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(none)
        NSLayoutConstraint.activate([none.centerXAnchor.constraint(equalTo: scroll.centerXAnchor), none.topAnchor.constraint(equalTo: scroll.topAnchor, constant: 24)])
        panel.initialFirstResponder = field
    }

    func show(over window: NSWindow) {
        panel.present(over: window, topFraction: 0.18)
        panel.makeFirstResponder(field)
        field.currentEditor()?.moveToEndOfDocument(nil)
        panel.onResign = { [weak self] in self?.close() }
    }

    func close() {
        panel.onResign = nil
        panel.dismiss()
        onClose?()
    }

    // ---- Query ----------------------------------------------------------------------------
    private var parsed: (prefix: String, term: String) {
        let q = field.stringValue
        if let c = q.first, ">@/".contains(c) { return (String(c), String(q.dropFirst()).trimmingCharacters(in: .whitespaces)) }
        return ("", q.trimmingCharacters(in: .whitespaces))
    }

    private func looksLikePath(_ q: String) -> Bool {
        let t = q.trimmingCharacters(in: .whitespaces)
        return t.range(of: #"^~(/|$)"#, options: .regularExpression) != nil || t.range(of: #"^/\S*$"#, options: .regularExpression) != nil
    }

    func controlTextDidChange(_ obj: Notification) {
        sel = 0
        refresh()
    }

    private func refresh() {
        let (prefix, term) = parsed
        let scope = prefix == ">" ? "run" : prefix == "@" ? "host" : prefix == "/" ? "snippet" : filter
        let q = field.stringValue.trimmingCharacters(in: .whitespaces)
        let path = looksLikePath(q) && System.isDir(Routing.expandHome(q, home: store.home)) ? q : nil
        let items = rank(prefix: prefix, term: term, scope: scope, path: path)
        var out: [Row] = []
        var last: String?
        for it in items {
            if it.group != last { out.append(.header(Self.groups.first { $0.0 == it.group }?.1 ?? "")) }
            last = it.group
            out.append(.item(it))
        }
        rows = out
        filterButton.title = !prefix.isEmpty ? "\(["\u{3e}": "Run", "@": "Hosts", "/": "Snippets"][prefix] ?? "") only" : filter == "all" ? "All · ⇥ to filter" : "\(Self.filters.first { $0.0 == filter }!.1) · ⇥"
        none.isHidden = !items.isEmpty
        none.stringValue = prefix == ">" ? "Type a command to run it in a new terminal" : prefix == "@" ? (term.isEmpty ? "No SSH hosts found in ~/.ssh/config" : "No matching SSH hosts") : prefix == "/" ? (term.isEmpty ? "No snippets yet" : "No matching snippets") : "No matches"
        table.reloadData()
        select(itemIndex: sel)
        fitHeight()
    }

    // Grows with the results up to a cap, keeping its top edge where it is.
    private func fitHeight() {
        let rowsH = rows.reduce(CGFloat(0)) { h, r in
            if case .header = r { return h + UI.px(28) }
            return h + UI.px(30)
        }
        let chrome = UI.px(46) + UI.px(34) + 14
        let h = min(UI.px(460), max(UI.px(150), chrome + (rows.isEmpty ? UI.px(60) : rowsH)))
        var f = panel.frame
        guard abs(f.height - h) > 0.5 else { return }
        f.origin.y += f.height - h
        f.size.height = h
        panel.setFrame(f, display: true)
    }

    private var itemRows: [Int] { rows.indices.filter { if case .item = rows[$0] { return true }; return false } }

    private func select(itemIndex i: Int) {
        let ir = itemRows
        guard !ir.isEmpty else { return }
        sel = (i % ir.count + ir.count) % ir.count
        table.selectRowIndexes([ir[sel]], byExtendingSelection: false)
        table.scrollRowToVisible(ir[sel])
        for r in 0..<rows.count { (table.view(atColumn: 0, row: r, makeIfNecessary: false) as? CommandRow)?.selected = r == ir[sel] }
    }

    @objc private func cycleFilter() { cycle(1) }

    private func cycle(_ d: Int) {
        guard parsed.prefix.isEmpty else { return }
        let i = Self.filters.firstIndex { $0.0 == filter } ?? 0
        filter = Self.filters[(i + d + Self.filters.count) % Self.filters.count].0
        sel = 0
        refresh()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        let flags = NSApp.currentEvent?.modifierFlags ?? []
        switch sel {
        case #selector(NSResponder.moveDown(_:)): select(itemIndex: self.sel + 1)
        case #selector(NSResponder.moveUp(_:)): select(itemIndex: self.sel - 1)
        case #selector(NSResponder.insertTab(_:)): cycle(1)
        case #selector(NSResponder.insertBacktab(_:)): cycle(-1)
        case #selector(NSResponder.insertNewline(_:)), #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
            run(mode: flags.contains(.command) ? .new : flags.contains(.option) ? .split : .open)
        case #selector(NSResponder.cancelOperation(_:)): close(); store.syncFocus()
        default:
            // ⌃N / ⌃P move too, as in the web build.
            if flags.contains(.control), let c = NSApp.currentEvent?.charactersIgnoringModifiers {
                if c == "n" { select(itemIndex: self.sel + 1); return true }
                if c == "p" { select(itemIndex: self.sel - 1); return true }
            }
            return false
        }
        return true
    }

    private func run(mode: Mode) {
        let ir = itemRows
        guard sel < ir.count, case .item(let it) = rows[ir[sel]] else { return }
        close()
        it.run(mode)
    }

    @objc private func clicked() {
        let r = table.clickedRow
        guard r >= 0, case .item = rows[r], let i = itemRows.firstIndex(of: r) else { return }
        sel = i
        let f = NSApp.currentEvent?.modifierFlags ?? []
        run(mode: f.contains(.command) ? .new : f.contains(.option) ? .split : .open)
    }

    // ---- Table ----------------------------------------------------------------------------
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        if case .header = rows[row] { return UI.px(28) }
        return UI.px(30)
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        if case .item = rows[row] { return true }
        return false
    }

    func tableView(_ tableView: NSTableView, isGroupRow row: Int) -> Bool {
        if case .header = rows[row] { return true }
        return false
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        switch rows[row] {
        case .header(let t):
            let l = NSTextField(labelWithString: t)
            l.font = UI.font(0.88, .semibold)
            l.textColor = .secondaryLabelColor
            let v = NSView()
            l.translatesAutoresizingMaskIntoConstraints = false
            v.addSubview(l)
            NSLayoutConstraint.activate([l.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 18), l.bottomAnchor.constraint(equalTo: v.bottomAnchor, constant: -3)])
            return v
        case .item(let it):
            let v = CommandRow()
            v.configure(it)
            let ir = itemRows
            v.selected = sel < ir.count && ir[sel] == row
            v.onHover = { [weak self] in
                guard let self, let i = self.itemRows.firstIndex(of: row), i != self.sel else { return }
                self.select(itemIndex: i)
            }
            return v
        }
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? { ClearRowView() }

    // ---- Candidates -----------------------------------------------------------------------
    private func buildCandidates() -> (sessions: [Item], dirs: [Item], hosts: [Item], snippets: [Item], actions: [Item]) {
        let s = store.model
        let home = store.home
        let now = nowMillis()
        let activeTid = store.activeTabId
        let kb = s.settings.keybindings
        func k(_ id: String) -> String { Keys.format(kb[id]) }

        var placed: [(String, String, String?)] = s.favorites.map { ($0, "Favorites", nil) }
        for sp in s.spaces {
            placed += sp.pinned.map { ($0, "\(sp.name) · Pinned", sp.id) }
            for f in sp.folders { placed += f.tabs.map { ($0, "\(sp.name) › \(f.name)", sp.id) } }
            placed += sp.today.map { ($0, "\(sp.name) · Today", sp.id) }
        }
        let sessions: [Item] = placed.compactMap { tid, where_, spaceId in
            guard let tab = s.tabs[tid] else { return nil }
            let sids = tab.layout.leaves
            let names = sids.map { Meta.sessionName(tabName: nil, rt: store.rt[$0], cwd: s.sessions[$0]?.cwd, home: home) }
            let cur = store.rt[tab.activeSid]
            let meta = s.sessions[tab.activeSid]
            let running = sids.compactMap { store.rt[$0] }.first { $0.status == .run }
            let failed = sids.compactMap { store.rt[$0] }.first { $0.status == .fail }
            let status = running.map { r in r.cmdStart.map { " · running \(Meta.formatDuration(now - $0))" } ?? " · running" } ?? failed.map { " · exit \($0.exitCode ?? 1)" } ?? ""
            let recency = ([tab.createdAt] + sids.map { sid in
                max(store.sessions[sid].map { Millis($0.lastActivity.timeIntervalSince1970 * 1000) } ?? 0, store.rt[sid]?.endedAt ?? 0, store.rt[sid]?.cmdStart ?? 0)
            }).max() ?? 0
            let cwd = cur?.cwd ?? meta?.cwd
            let active = tid == activeTid
            let kind = Meta.kindOf((cur?.command.isEmpty == false ? cur?.command : nil) ?? meta?.command)
            let (img, _) = KindIcons.image(kind: kind, icon: tab.icon)
            return Item(key: "s:\(tid)", group: "session", label: tab.name ?? (names.isEmpty ? "~" : names.joined(separator: " · ")), sub: where_ + status,
                        extra: ([cwd.map { Routing.tildify($0, home: home) }].compactMap { $0 } + names).joined(separator: " "),
                        image: img, selHint: "Switch to session ↵", recency: recency, spaceId: spaceId, active: active, tid: tid) { [store] mode in
                if mode == .new { store.openTerminal(.init(cwd: cwd)); return }
                if mode == .split, !active, store.activeTab != nil { store.mergeIntoActive(tid, edge: .right); return }
                store.activateTab(tid)
            }
        }

        let dirs: [Item] = s.recentDirs.enumerated().map { i, d in
            let when = Self.dayLabel(d.last, now: now)
            return Item(key: "d:\(d.path)", group: "dir", label: Routing.tildify(d.path, home: home), sub: d.visits >= 3 ? "\(d.visits) visits" : when == "Today" ? Meta.timeAgo(d.last, now: now) : when.lowercased(),
                        symbol: "folder", mono: true, selHint: "New terminal ⌘↵", bonus: log2(1 + Double(max(1, d.visits))) * 2 - Double(i) * 0.02) { [weak self] mode in self?.openDir(d.path, mode) }
        }

        let hosts: [Item] = store.ui.sshHosts.map { h in
            let target = h.hostName ?? h.alias
            return Item(key: "h:\(h.alias)", group: "host", label: h.user.map { "\($0)@\(target)" } ?? target, sub: h.alias != target ? h.alias : "",
                        symbol: "server.rack", mono: true, subMono: true, selHint: "Connect ↵") { [store] mode in
                store.openTerminal(.init(command: "ssh \(h.alias)", splitOf: mode == .split ? store.activeTabId : nil))
            }
        }

        let snippets: [Item] = s.snippets.map { sn in
            let other = sn.spaceId != nil && sn.spaceId != s.activeSpaceId ? store.space(sn.spaceId) : nil
            return Item(key: "n:\(sn.id)", group: "snippet", label: "/\(sn.name)", sub: (sn.command.components(separatedBy: "\n").first ?? "") + (other.map { "  · \($0.name)" } ?? ""),
                        symbol: "curlybraces", subMono: true, selHint: "Run ↵", bonus: other == nil ? 3 : 0) { [store] mode in
                switch mode {
                case .new: store.openTerminal(.init(command: sn.command))
                case .split: store.openTerminal(.init(command: sn.command, splitOf: store.activeTabId))
                case .open: store.runInSession(sn.command)
                }
            }
        }

        let d = NSApp.delegate as? AppDelegate
        func act(_ id: String, _ label: String, symbol: String = "command", hint: String? = nil, words: String = "", _ run: @escaping () -> Void) -> Item {
            Item(key: "a:\(id)", group: "action", label: label, extra: words, symbol: symbol, hint: hint ?? k(id), actionId: id) { _ in run() }
        }
        var actions: [Item] = [
            act("newTerminal", "New terminal", symbol: "plus") { d?.run("newTerminal") },
            act("splitRight", "Split right", symbol: "rectangle.split.2x1") { d?.run("splitRight") },
            act("splitDown", "Split down", symbol: "rectangle.split.1x2") { d?.run("splitDown") },
            act("openDir", "Open directory…", hint: "", words: "folder choose") { [store] in
                let panel = NSOpenPanel()
                panel.canChooseDirectories = true
                panel.canChooseFiles = false
                panel.directoryURL = URL(fileURLWithPath: home)
                if panel.runModal() == .OK, let url = panel.url { store.openTerminal(.init(cwd: url.path)) }
            },
        ]
        for (i, sp) in s.spaces.enumerated() where sp.id != s.activeSpaceId {
            var it = act("space:\(sp.id)", "Switch to Space · \(sp.name)", hint: i < 9 ? "⌃\(i + 1)" : "") { [store] in store.switchSpace(sp.id) }
            if let img = SpaceIcon.menuImage(sp) { it.image = img } else { it.glyph = (sp.glyph, NSColor(hex: sp.color)) }
            actions.append(it)
        }
        actions += [
            act("newSpace", "New Space") { d?.run("newSpace") },
            act("overview", "All Spaces", words: "overview") { d?.run("overview") },
            act("prevSpace", "Previous Space") { d?.run("prevSpace") },
            act("nextSpace", "Next Space") { d?.run("nextSpace") },
            act("library", "Library", words: "archive history") { d?.run("library") },
            act("settings", "Settings", words: "preferences") { [store] in store.openSettings() },
            act("settingsFile", "Edit settings.json", hint: "", words: "preferences config json customize") { [store] in store.openSettings("file") },
            act("toggleSidebar", "Show / hide sidebar") { d?.run("toggleSidebar") },
            act("focusMode", "Focus mode (hide sidebar)") { d?.run("focusMode") },
            act("copyLastOutput", "Copy last output") { d?.run("copyLastOutput") },
            act("find", "Find in terminal", words: "search") { d?.run("find") },
            act("clear", "Clear scrollback") { d?.run("clear") },
            act("rename", "Rename session…", hint: "") { [store] in
                guard let tid = store.activeTabId, let tab = store.model.tabs[tid] else { return }
                if let name = Prompt.text("Rename session", value: tab.name ?? "") { store.renameTab(tid, name) }
            },
            act("tidy", "Tidy idle sessions", hint: "", words: "archive clean") { [store] in store.tidy() },
            act("closePane", "Close pane") { d?.run("closePane") },
            act("nextTab", "Next session") { d?.run("nextTab") },
            act("prevTab", "Previous session") { d?.run("prevTab") },
            act("zoomIn", "Bigger text", words: "zoom font") { d?.run("zoomIn") },
            act("zoomOut", "Smaller text", words: "zoom font") { d?.run("zoomOut") },
            act("zoomReset", "Actual size", words: "zoom font reset") { d?.run("zoomReset") },
        ]
        return (sessions, dirs, hosts, snippets, actions)
    }

    private func openDir(_ path: String, _ mode: Mode) {
        store.openTerminal(.init(cwd: path, splitOf: mode == .split ? store.activeTabId : nil))
    }

    static func dayLabel(_ ts: Millis, now: Millis) -> String {
        let cal = Calendar.current
        let d = Date(timeIntervalSince1970: Double(ts) / 1000)
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: d), to: cal.startOfDay(for: Date(timeIntervalSince1970: Double(now) / 1000))).day ?? 0
        if days <= 0 { return "Today" }
        if days == 1 { return "Yesterday" }
        if days < 7 { return "This week" }
        if days < 14 { return "Last week" }
        let f = DateFormatter()
        f.dateFormat = "LLLL yyyy"
        return f.string(from: d)
    }

    // ---- Ranking --------------------------------------------------------------------------
    private func match(_ it: Item, _ term: String) -> Item? {
        var r = it
        if let m = Fuzzy.match(term, it.label) { r.hl = m.indices; r.score = m.score + it.bonus; return r }
        if !it.sub.isEmpty, let m = Fuzzy.match(term, it.sub) { r.subHl = m.indices; r.score = m.score * 0.6 + it.bonus; return r }
        if !it.extra.isEmpty, let m = Fuzzy.match(term, it.extra) { r.score = m.score * 0.5 + it.bonus; return r }
        return nil
    }

    private func top(_ list: [Item], _ term: String, _ cap: Int) -> [Item] {
        Array(list.compactMap { match($0, term) }.sorted { $0.score > $1.score }.prefix(cap))
    }

    private func rank(prefix: String, term: String, scope: String, path: String?) -> [Item] {
        var out: [Item] = []
        if let path {
            out.append(Item(key: "p:\(path)", group: "path", label: "Open terminal in \(path)", symbol: "folder", selHint: "↵") { [weak self] mode in self?.openDir(Routing.expandHome(path, home: Store.shared.home), mode) })
        }
        if prefix == ">" {
            guard !term.isEmpty else { return out }
            out.append(Item(key: "run", group: "run", label: term, sub: "Run in a new terminal", symbol: "terminal", mono: true, hint: "↵") { [store] mode in
                store.openTerminal(.init(command: term, splitOf: mode == .split ? store.activeTabId : nil))
            })
            return out
        }
        let solo = scope != "all"
        func want(_ g: String) -> Bool { scope == "all" || scope == g }
        let c = cands
        if term.isEmpty {
            if want("session") {
                let list = c.sessions.filter { solo || !$0.active }.sorted {
                    let a = $0.spaceId == store.model.activeSpaceId, b = $1.spaceId == store.model.activeSpaceId
                    return a != b ? a : $0.recency > $1.recency
                }
                out += list.prefix(solo ? 60 : 6)
            }
            if want("dir") { out += c.dirs.prefix(solo ? 60 : 4) }
            if want("host") && solo { out += c.hosts.prefix(60) }
            if want("snippet") && solo { out += c.snippets.sorted { $0.bonus > $1.bonus }.prefix(60) }
            if want("action") { out += solo ? Array(c.actions.prefix(60)) : Self.emptyActions.compactMap { id in c.actions.first { $0.actionId == id } } }
            return out
        }
        let cap = solo ? 60 : 6
        let sessions = want("session") ? top(c.sessions, term, cap) : []
        out += sessions
        if want("dir") { out += top(c.dirs, term, cap) }
        if want("host") { out += top(c.hosts, term, cap) }
        if want("snippet") {
            let sn = top(c.snippets, term, cap)
            // A typed path wins over snippets unless one actually matches it.
            if path != nil, prefix == "/", !sn.isEmpty, !(path!.dropFirst().contains("/")) { out.removeFirst() }
            out += sn
        }
        if want("action") {
            var acts = top(c.actions, term, cap)
            if let best = sessions.first(where: { !$0.active }), store.activeTabId != nil, scope == "all", let tid = best.tid {
                let prefixText = "Split right with "
                var merge = Item(key: "a:merge:\(tid)", group: "action", label: prefixText + best.label, symbol: "rectangle.split.2x1", hint: "⌥↵") { [store] _ in store.mergeIntoActive(tid, edge: .right) }
                merge.hl = best.hl.map { $0 + prefixText.count }
                acts.insert(merge, at: 0)
            }
            out += acts.prefix(cap)
        }
        return Array(out.prefix(solo ? 60 : 40))
    }
}

// One result: icon, label (matched letters bold), quiet subtitle, hint on the right.
final class CommandRow: NSView {
    private let icon = NSImageView()
    private let glyph = NSTextField(labelWithString: "")
    private let label = NSTextField(labelWithString: "")
    private let sub = NSTextField(labelWithString: "")
    private let hint = NSTextField(labelWithString: "")
    private var item: CommandBar.Item?
    var onHover: (() -> Void)?
    var selected = false { didSet { if oldValue != selected, let item { configure(item) }; needsDisplay = true } }

    init() {
        super.init(frame: .zero)
        icon.symbolConfiguration = .init(pointSize: UI.font(1.1).pointSize, weight: .regular)
        icon.contentTintColor = .secondaryLabelColor
        glyph.font = .systemFont(ofSize: 14)
        label.lineBreakMode = .byTruncatingTail
        sub.lineBreakMode = .byTruncatingTail
        sub.textColor = .secondaryLabelColor
        hint.textColor = .tertiaryLabelColor
        hint.font = UI.font(0.95)
        label.setContentCompressionResistancePriority(.init(740), for: .horizontal)
        sub.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let stack = NSStackView(views: [icon, glyph, label, sub, spacer, hint])
        stack.spacing = 10
        stack.loosen()
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18), stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor), icon.widthAnchor.constraint(equalToConstant: 20),
        ])
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeAlways, .inVisibleRect], owner: self))
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ it: CommandBar.Item) {
        item = it
        icon.image = it.image ?? it.symbol.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil) }
        icon.isHidden = it.glyph != nil
        glyph.isHidden = it.glyph == nil
        if let (g, c) = it.glyph { glyph.stringValue = g; glyph.textColor = selected ? .white : c; glyph.font = UI.font(1.1) }
        let ink: NSColor = selected ? .white : .labelColor
        let dim: NSColor = selected ? NSColor.white.withAlphaComponent(0.8) : .secondaryLabelColor
        let hit: NSColor = selected ? .white : UI.accent()
        label.attributedStringValue = Self.highlighted(it.label, it.hl, mono: it.mono, size: UI.font().pointSize, color: ink, hit: hit)
        sub.attributedStringValue = Self.highlighted(it.sub, it.subHl, mono: it.subMono, size: UI.font().pointSize, color: dim, hit: hit)
        icon.contentTintColor = selected ? .white : .secondaryLabelColor
        hint.textColor = selected ? NSColor.white.withAlphaComponent(0.8) : .tertiaryLabelColor
        sub.isHidden = it.sub.isEmpty
        updateHint()
    }

    private func updateHint() {
        guard let it = item else { return }
        let h = it.hint.isEmpty ? (selected ? it.selHint : "") : it.hint
        hint.stringValue = h
        hint.isHidden = h.isEmpty
    }

    static func highlighted(_ text: String, _ idx: [Int], mono: Bool, size: CGFloat, color: NSColor, hit: NSColor? = nil) -> NSAttributedString {
        let base: NSFont = mono ? .monospacedSystemFont(ofSize: size - 0.5, weight: .regular) : .systemFont(ofSize: size)
        let bold: NSFont = mono ? .monospacedSystemFont(ofSize: size - 0.5, weight: .bold) : .systemFont(ofSize: size, weight: .bold)
        let s = NSMutableAttributedString()
        let hits = Set(idx)
        for (i, ch) in text.enumerated() {
            s.append(NSAttributedString(string: String(ch), attributes: [.font: hits.contains(i) ? bold : base, .foregroundColor: hits.contains(i) ? (hit ?? color) : color]))
        }
        return s
    }

    override func draw(_ dirtyRect: NSRect) {
        guard selected else { return }
        MainActor.assumeIsolated { UI.accent() }.setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 8, dy: 1), xRadius: 9, yRadius: 9).fill()
    }

    override func mouseMoved(with event: NSEvent) { onHover?() }
}

final class ClearRowView: NSTableRowView {
    override func drawSelection(in dirtyRect: NSRect) {}
    override func drawBackground(in dirtyRect: NSRect) {}
}

extension NSBox {
    static func separator() -> NSBox {
        let b = NSBox()
        b.boxType = .separator
        return b
    }
}

// A one-line text prompt (rename and the like), as a small modal alert.
@MainActor
enum Prompt {
    static func text(_ title: String, value: String) -> String? {
        let alert = NSAlert()
        alert.messageText = title
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = value
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        return alert.runModal() == .alertFirstButtonReturn ? field.stringValue.trimmingCharacters(in: .whitespaces) : nil
    }
}

// A floating, rounded glass panel over the main window for the command bar and friends.
// It takes keys while it's up and goes away when it loses them.
final class OverlayPanel: NSPanel {
    let content: NSView
    var onResign: (() -> Void)?

    init(size: NSSize) {
        let fx = NSVisualEffectView()
        // Glass like the web build's palette: a blur, tinted with the window background so it
        // reads dark in Dark Mode and light in Light Mode.
        fx.material = .underWindowBackground
        fx.blendingMode = .behindWindow
        fx.state = .active
        fx.wantsLayer = true
        fx.layer?.cornerRadius = 14
        fx.layer?.masksToBounds = true
        fx.layer?.borderWidth = 0.5
        fx.layer?.borderColor = NSColor.separatorColor.cgColor
        let tint = TintView()
        tint.autoresizingMask = [.width, .height]
        fx.addSubview(tint)
        content = fx
        super.init(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .fullSizeContentView], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isReleasedWhenClosed = false
        contentView = fx
        tint.frame = fx.bounds
    }

    override var canBecomeKey: Bool { true }

    func present(over window: NSWindow, topFraction: CGFloat) {
        let f = window.frame
        let size = frame.size
        setFrameOrigin(NSPoint(x: f.midX - size.width / 2, y: f.maxY - f.height * topFraction - size.height))
        window.addChildWindow(self, ordered: .above)
        alphaValue = 0
        makeKeyAndOrderFront(nil)
        NSAnimationContext.runAnimationGroup { $0.duration = 0.12; animator().alphaValue = 1 }
    }

    func dismiss() {
        parent?.removeChildWindow(self)
        orderOut(nil)
    }

    override func resignKey() {
        super.resignKey()
        onResign?()
    }

    override func cancelOperation(_ sender: Any?) {
        onResign?()
    }
}

// The glass panel's tint; follows the appearance.
final class TintView: NSView {
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() { layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.78).cgColor }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
