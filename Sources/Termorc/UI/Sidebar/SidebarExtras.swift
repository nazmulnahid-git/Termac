import AppKit
import TermorcCore

// Favorites: always-on sessions shared by every Space, as a grid of square tiles.
@MainActor
final class FavoritesStrip: NSView {
    static weak var current: FavoritesStrip?
    private let grid = NSView()
    private let dropZone = NSTextField(labelWithString: "Drop here to make it a Favorite")
    private var tiles: [String: FavoriteTile] = [:]
    private var height: NSLayoutConstraint!
    private var order: [String] = []

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        height = heightAnchor.constraint(equalToConstant: 0)
        height.isActive = true
        registerForDraggedTypes([.termorcTab])
        Self.current = self
        dropZone.alignment = .center
        dropZone.textColor = .secondaryLabelColor
        dropZone.wantsLayer = true
        dropZone.isHidden = true
        addSubview(dropZone)
    }

    required init?(coder: NSCoder) { fatalError() }

    func update() {
        let store = Store.shared
        let ids = store.model.favorites
        if ids != order {
            order = ids
            tiles.values.forEach { $0.removeFromSuperview() }
            tiles = [:]
            for tid in ids {
                let t = FavoriteTile(tid: tid)
                tiles[tid] = t
                addSubview(t)
            }
            needsLayout = true
        }
        for (tid, t) in tiles { t.update(TabView.make(tid), active: store.activeTabId == tid) }
        // While a session is dragged with no Favorites yet, offer a target to make the first;
        // over it (or the tiles) the strip lights up.
        let drag = SidebarDrag.current
        let dragging = SpaceList.dragTid != nil || drag?.nearFavorites == true
        var hot = false
        if case .list(let d, _)? = drag?.target, d.section == .fav { hot = true }
        isHidden = ids.isEmpty && !dragging
        dropZone.isHidden = !(ids.isEmpty && dragging)
        dropZone.font = UI.font(0.92)
        wantsLayer = true
        let accent = UI.accent()
        dropZone.layer?.cornerRadius = 8
        dropZone.layer?.borderWidth = 1
        dropZone.layer?.borderColor = (hot ? accent : NSColor.separatorColor).cgColor
        dropZone.layer?.backgroundColor = hot ? accent.withAlphaComponent(0.14).cgColor : nil
        layer?.cornerRadius = 10
        layer?.backgroundColor = hot && !ids.isEmpty ? accent.withAlphaComponent(0.10).cgColor : nil
        layoutTiles()
    }

    // Where a drop at `p` (window coordinates) lands among the tiles.
    func dropIndex(at p: NSPoint) -> Int {
        let loc = convert(p, from: nil)
        return order.filter { $0 != SidebarDrag.current?.tid }.firstIndex { (tiles[$0]?.frame.midX ?? 0) > loc.x && (tiles[$0]?.frame.minY ?? 0) <= loc.y } ?? order.count
    }

    override func layout() {
        super.layout()
        layoutTiles()
    }

    private func layoutTiles() {
        let pad: CGFloat = 10, gap: CGFloat = 6
        let width = bounds.width - pad * 2
        let cols = max(1, Int((width + gap) / (46 + gap)))
        let side = (width - CGFloat(cols - 1) * gap) / CGFloat(cols)
        for (i, tid) in order.enumerated() {
            let r = i / cols, c = i % cols
            tiles[tid]?.frame = NSRect(x: pad + CGFloat(c) * (side + gap), y: bounds.height - 10 - side - CGFloat(r) * (side + gap), width: side, height: side)
        }
        let rows = order.isEmpty ? 0 : (order.count + cols - 1) / cols
        var h = order.isEmpty ? 0 : 14 + CGFloat(rows) * side + CGFloat(rows - 1) * gap
        if !dropZone.isHidden {
            h = 56
            dropZone.frame = NSRect(x: pad, y: 8, width: width, height: 40)
        }
        if height.constant != h { height.constant = h }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { .move }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let tid = sender.draggingPasteboard.string(forType: .termorcTab) else { return false }
        let loc = convert(sender.draggingLocation, from: nil)
        let index = order.firstIndex { (tiles[$0]?.frame.midX ?? 0) > loc.x && (tiles[$0]?.frame.minY ?? 0) <= loc.y } ?? order.count
        Store.shared.moveTab(tid, to: Dest(section: .fav, index: index))
        return true
    }
}

@MainActor
final class FavoriteTile: NSView {
    let tid: String
    private let label = NSTextField(labelWithString: "")
    private let icon = NSImageView()
    private let dot = NSView()
    private let badge = NSTextField(labelWithString: "")
    private var active = false
    private var tint: NSColor?

    init(tid: String) {
        self.tid = tid
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 9
        label.font = .systemFont(ofSize: 12, weight: .semibold)
        label.alignment = .center
        label.lineBreakMode = .byClipping
        icon.symbolConfiguration = .init(pointSize: 17, weight: .regular)
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3
        badge.font = .systemFont(ofSize: 10, weight: .bold)
        badge.wantsLayer = true
        badge.layer?.backgroundColor = NSColor.systemOrange.cgColor
        badge.layer?.cornerRadius = 7
        badge.alignment = .center
        for v in [label, icon, dot, badge] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor), label.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 4),
            icon.centerXAnchor.constraint(equalTo: centerXAnchor), icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 6), dot.heightAnchor.constraint(equalToConstant: 6),
            dot.topAnchor.constraint(equalTo: topAnchor, constant: 7), dot.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -7),
            badge.topAnchor.constraint(equalTo: topAnchor, constant: -4), badge.trailingAnchor.constraint(equalTo: trailingAnchor, constant: 4),
            badge.widthAnchor.constraint(greaterThanOrEqualToConstant: 14), badge.heightAnchor.constraint(equalToConstant: 14),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func update(_ v: TabView?, active: Bool) {
        guard let v else { return }
        self.active = active
        tint = v.tab.color.map { NSColor(hex: $0) }
        toolTip = v.name
        if let iconId = v.tab.icon {
            let (img, text) = KindIcons.image(kind: ">_", icon: iconId)
            icon.image = img
            icon.isHidden = img == nil
            label.stringValue = text ?? ""
            label.isHidden = text == nil
        } else {
            icon.isHidden = true
            label.isHidden = false
            label.stringValue = Meta.shortName(v.tab.name ?? v.active?.name)
        }
        icon.contentTintColor = tint ?? (active ? .controlAccentColor : .secondaryLabelColor)
        let color: NSColor = [.run: .controlAccentColor, .ok: .systemGreen, .fail: .systemRed, .bell: .systemOrange][v.status] ?? .tertiaryLabelColor
        dot.layer?.backgroundColor = color.cgColor
        badge.isHidden = v.bell == 0
        badge.stringValue = "\(v.bell)"
        needsDisplay = true
        updateLayer()
    }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        let base = tint ?? NSColor.labelColor
        layer?.backgroundColor = base.withAlphaComponent(tint != nil ? (active ? 0.30 : 0.18) : (active ? 0.10 : 0.05)).cgColor
        layer?.borderWidth = active ? 1.5 : 0.5
        layer?.borderColor = (active ? (tint ?? .controlAccentColor) : NSColor.separatorColor).cgColor
    }

    // A press drags the tile (SidebarDrag); one that comes up in place activates it.
    override func mouseDown(with event: NSEvent) {
        guard event.clickCount == 1, !event.modifierFlags.contains(.shift) else { return }
        if SidebarDrag.track(.tab(tid), source: self, event: event) { return }
        Store.shared.activateTab(tid)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let m = NSMenu()
        SidebarMenus.row(m, tid: tid, rename: nil, newFolder: nil)
        return m
    }
}


// Cards at the foot of the sidebar: a long job that finished elsewhere, and toasts.
@MainActor
final class SidebarCards: NSStackView {
    init() {
        super.init(frame: .zero)
        orientation = .vertical
        spacing = 8
        edgeInsets = NSEdgeInsets(top: 0, left: 8, bottom: 8, right: 8)
        translatesAutoresizingMaskIntoConstraints = false
    }

    required init?(coder: NSCoder) { fatalError() }

    private var key = ""

    func update() {
        let store = Store.shared
        let k = "\(store.ui.notify?.id ?? "")|\(store.ui.toast?.id ?? "")"
        guard k != key else { return }
        key = k
        arrangedSubviews.forEach { $0.removeFromSuperview() }
        if let n = store.ui.notify {
            let where_ = store.space(n.spaceId)?.name ?? ""
            addArrangedSubview(Card(icon: n.exit != 0 ? "exclamationmark.circle.fill" : "checkmark.circle.fill", iconColor: n.exit != 0 ? .systemRed : .systemGreen,
                                    title: n.command, mono: true,
                                    detail: "\(n.exit != 0 ? "Failed (exit \(n.exit))" : "Finished") in \(where_) · \(Meta.formatDuration(n.dur))",
                                    action: ("Jump", { store.jumpTo(n.sid); store.ui.notify = nil })))
        }
        if let t = store.ui.toast {
            addArrangedSubview(Card(icon: nil, iconColor: nil, title: t.title, mono: false, detail: t.detail, action: t.action))
        }
        for v in arrangedSubviews { v.widthAnchor.constraint(equalTo: widthAnchor, constant: -16).isActive = true }
    }

    final class Card: NSVisualEffectView {
        private var run: (() -> Void)?

        init(icon: String?, iconColor: NSColor?, title: String, mono: Bool, detail: String?, action: (label: String, run: () -> Void)?) {
            super.init(frame: .zero)
            material = .popover
            blendingMode = .withinWindow
            state = .active
            wantsLayer = true
            layer?.cornerRadius = 10
            layer?.borderWidth = 0.5
            layer?.borderColor = NSColor.separatorColor.cgColor
            run = action?.run
            let t = NSTextField(labelWithString: title)
            t.font = mono ? .monospacedSystemFont(ofSize: 11.5, weight: .medium) : .systemFont(ofSize: 12.5, weight: .semibold)
            t.lineBreakMode = .byTruncatingTail
            let d = NSTextField(wrappingLabelWithString: detail ?? "")
            d.font = .systemFont(ofSize: 11.5)
            d.textColor = .secondaryLabelColor
            d.isHidden = detail == nil
            let texts = NSStackView(views: [t, d])
            texts.orientation = .vertical
            texts.alignment = .leading
            texts.spacing = 2
            texts.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            var views: [NSView] = []
            if let icon {
                let iv = NSImageView(image: NSImage(systemSymbolName: icon, accessibilityDescription: nil)!)
                iv.contentTintColor = iconColor
                iv.symbolConfiguration = .init(pointSize: 15, weight: .regular)
                views.append(iv)
            }
            views.append(texts)
            if let action {
                let b = NSButton(title: action.label, target: self, action: #selector(tap))
                b.bezelStyle = .inline
                b.controlSize = .small
                views.append(b)
            }
            let row = NSStackView(views: views)
            row.loosen()
            row.spacing = 10
            row.alignment = .centerY
            row.translatesAutoresizingMaskIntoConstraints = false
            addSubview(row)
            NSLayoutConstraint.activate([
                row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12), row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
                row.topAnchor.constraint(equalTo: topAnchor, constant: 10), row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            ])
        }

        required init?(coder: NSCoder) { fatalError() }

        @objc private func tap() { run?() }
    }
}

// Context menus for rows, folders and Spaces (sidebar-shared.js).
@MainActor
enum SidebarMenus {
    final class Handler: NSObject {
        let fn: () -> Void
        init(_ fn: @escaping () -> Void) { self.fn = fn }
        @objc func run() { fn() }
    }

    private static var handlers: [Handler] = []

    static func add(_ menu: NSMenu, _ title: String, enabled: Bool = true, checked: Bool? = nil, _ fn: @escaping () -> Void) {
        let h = Handler(fn)
        handlers.append(h)
        if handlers.count > 200 { handlers.removeFirst(100) }
        let item = NSMenuItem(title: title, action: enabled ? #selector(Handler.run) : nil, keyEquivalent: "")
        item.target = h
        item.isEnabled = enabled
        if let checked { item.state = checked ? .on : .off }
        menu.addItem(item)
    }

    static func sub(_ menu: NSMenu, _ title: String, _ build: (NSMenu) -> Void) {
        let m = NSMenu(title: title)
        build(m)
        let host = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        host.submenu = m
        menu.addItem(host)
    }

    static func row(_ menu: NSMenu, tid: String, rename: (() -> Void)?, newFolder: (() -> Void)?) {
        let store = Store.shared
        guard let v = TabView.make(tid) else { return }
        let loc = store.locate(tid)
        let sp = store.activeSpace
        let cwd = v.active?.rt.cwd
        if let rename { add(menu, "Rename…", rename) }
        add(menu, "Icon & Color…") { store.ui.overlay = .tabStyle(tid) }
        menu.addItem(.separator())
        if loc?.section == .today {
            add(menu, "Pin to Space") { store.moveTab(tid, to: Dest(section: .pinned, spaceId: loc?.spaceId)) }
        } else {
            add(menu, "Move to Today") { store.moveTab(tid, to: Dest(section: .today, spaceId: loc?.spaceId ?? sp.id)) }
        }
        if loc?.section == .fav {
            add(menu, "Remove from Favorites") { store.moveTab(tid, to: Dest(section: .today, spaceId: sp.id)) }
        } else {
            add(menu, "Add to Favorites") { store.moveTab(tid, to: Dest(section: .fav)) }
        }
        sub(menu, "Move to Folder") { m in
            for f in sp.folders { add(m, f.name, enabled: f.id != loc?.folderId) { store.moveTab(tid, to: Dest(section: .pinned, spaceId: sp.id, folderId: f.id)) } }
            if !sp.folders.isEmpty { m.addItem(.separator()) }
            add(m, "New Folder", enabled: newFolder != nil) { newFolder?() }
        }
        sub(menu, "Move to Space") { m in
            for x in store.model.spaces {
                add(m, "\(x.glyph)  \(x.name)", enabled: x.id != loc?.spaceId) { store.moveTab(tid, to: Dest(section: loc?.section == .pinned ? .pinned : .today, spaceId: x.id)) }
            }
        }
        menu.addItem(.separator())
        if store.activeTabId != tid { add(menu, "Open in Split Right") { store.mergeIntoActive(tid, edge: .right) } }
        if v.panes.count > 1 {
            add(menu, "Separate Panes") {
                let at = listIndex(loc, tid)
                for (i, p) in v.panes.dropFirst().enumerated() {
                    var d = loc
                    d?.index = at + 1 + i
                    store.unsplit(p.sid, to: loc?.section == .fav ? nil : d)
                }
            }
        }
        add(menu, "New Terminal Here") { store.openTerminal(.init(cwd: cwd)) }
        if let cwd {
            add(menu, "Copy Path") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(cwd, forType: .string)
            }
            add(menu, "Open in Finder") { NSWorkspace.shared.open(URL(fileURLWithPath: cwd)) }
        }
        menu.addItem(.separator())
        sub(menu, "Protection") { m in
            add(m, "Red danger frame", checked: v.tab.has("danger")) { store.toggleTabEffect(tid, "danger") }
            add(m, "Confirm multi-line paste", checked: v.tab.has("confirmPaste")) { store.toggleTabEffect(tid, "confirmPaste") }
            add(m, "Never auto-archive", checked: v.tab.has("noArchive")) { store.toggleTabEffect(tid, "noArchive") }
        }
        menu.addItem(.separator())
        add(menu, "Move to Library") { store.archiveTabs([tid]) }
        add(menu, "Close") { store.closeTab(tid) }
    }

    private static func listIndex(_ loc: Dest?, _ tid: String) -> Int {
        let store = Store.shared
        guard let loc else { return -1 }
        let sp = store.space(loc.spaceId)
        let list: [String]?
        if loc.section == .fav { list = store.model.favorites }
        else if let fid = loc.folderId { list = sp?.folders.first { $0.id == fid }?.tabs }
        else { list = loc.section == .pinned ? sp?.pinned : sp?.today }
        return list?.firstIndex(of: tid) ?? -1
    }

    static func folder(_ menu: NSMenu, spaceId: String, folderId: String, rename: @escaping () -> Void) {
        let store = Store.shared
        let f = store.space(spaceId)?.folders.first { $0.id == folderId }
        add(menu, "New Terminal in Folder") { store.openTerminal(.init(spaceId: spaceId, section: .pinned, folderId: folderId)) }
        add(menu, "Rename…", rename)
        menu.addItem(.separator())
        add(menu, "Move Sessions to Library", enabled: !(f?.tabs.isEmpty ?? true)) { store.archiveTabs(f?.tabs ?? []) }
        add(menu, "Remove Folder (keep sessions)") { store.deleteFolder(spaceId, folderId) }
    }

    static func space(_ menu: NSMenu, spaceId: String, newFolder: @escaping () -> Void) {
        let store = Store.shared
        add(menu, "Edit Space…") { store.ui.overlay = .spaceEditor(spaceId) }
        add(menu, "Terminal Background…") { store.ui.overlay = .spaceEditor(spaceId) }
        add(menu, "New Folder", newFolder)
        menu.addItem(.separator())
        add(menu, "New Space…") { store.ui.overlay = .spaceEditor(nil) }
        add(menu, "All Spaces") { store.ui.overlay = .overview }
        menu.addItem(.separator())
        add(menu, "Delete Space…", enabled: store.model.spaces.count > 1) { store.deleteSpace(spaceId) }
    }
}
