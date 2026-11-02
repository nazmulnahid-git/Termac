import AppKit
import TermorcCore

// The main window: a full-height sidebar (Spaces and sessions) beside the content column
// (the terminal card over the Spaces bar), under a unified toolbar. The sidebar toggle sits in
// the sidebar's own titlebar while it's open, and beside the window controls once it's hidden.
// The toolbar leads with the Space (its icon, name and sessions) or the open page; the field
// after it stretches to the buttons, reads like a terminal's title (where you are, what's
// running) and opens the command bar.
@MainActor
final class MainWindowController: NSWindowController, NSWindowDelegate, NSToolbarDelegate {
    let store = Store.shared
    let split = MainSplitViewController()
    private var token: ObserverToken?
    private let locationButton = LocationButton()
    private let titleView = ToolbarTitleView()

    static let location = NSToolbarItem.Identifier("location")
    static let title = NSToolbarItem.Identifier("title")
    static let overview = NSToolbarItem.Identifier("overview")
    static let settings = NSToolbarItem.Identifier("settings")
    static let sidebar = NSToolbarItem.Identifier("sidebarToggle")

    init() {
        let w = MainWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        // Wide enough that the open sidebar, the title, the search field and the buttons all fit
        // in the toolbar; 4:3 at its smallest.
        w.minSize = NSSize(width: 800, height: 600)
        w.title = "Termorc"
        w.titleVisibility = .hidden // ToolbarTitleView draws it, with the Space's icon
        w.toolbarStyle = .unified
        w.titlebarSeparatorStyle = .automatic
        w.isReleasedWhenClosed = false
        w.tabbingMode = .disallowed
        w.acceptsMouseMovedEvents = true
        w.contentViewController = split
        super.init(window: w)
        w.delegate = self
        let toolbar = NSToolbar(identifier: "main")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        w.toolbar = toolbar
        // Assigning the content view controller sizes the window to its view; start from the
        // default size, then the saved frame if it's a sane one.
        w.setContentSize(NSSize(width: 1280, height: 800))
        w.center()
        let size = w.frame.size
        if w.setFrameUsingName("TermorcMain"), w.frame.width < w.minSize.width || w.frame.height < w.minSize.height {
            w.setContentSize(size)
            w.center()
        }
        w.setFrameAutosaveName("TermorcMain")
        locationButton.target = self
        locationButton.action = #selector(openCommandBar)
        token = store.observe { [weak self] in self?.refresh() }
        refresh()
    }

    required init?(coder: NSCoder) { fatalError() }

    // Closing the window hides it; sessions keep running and the Dock icon brings it back.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    private func refresh() {
        guard let w = window else { return }
        let sp = store.activeSpace
        switch store.ui.view {
        case .settings:
            w.title = "Settings"
            titleView.set(icon: .symbol("gearshape"), title: "Settings", subtitle: "")
        case .library:
            w.title = "Library"
            titleView.set(icon: .symbol("books.vertical"), title: "Library", subtitle: "")
        case .terminal:
            let tids = sp.allTabs
            let running = tids.filter { tid in store.model.tabs[tid]?.layout.leaves.contains { store.rt[$0]?.status == .run } ?? false }.count
            w.title = sp.name
            titleView.set(icon: .space(sp), title: sp.name, subtitle: (tids.count == 1 ? "1 session" : "\(tids.count) sessions") + (running > 0 ? " · \(running) running" : ""))
        }
        let sid = store.ui.focusedSid
        let r = sid.flatMap { store.rt[$0] }
        let cwd = r?.cwd ?? sid.flatMap { store.model.sessions[$0]?.cwd }
        locationButton.set(path: cwd.map { Routing.tildify($0, home: store.home) } ?? sp.name.lowercased(), proc: cwd == nil ? nil : Meta.procLabel(r), shortcut: Keys.format(store.model.settings.keybindings["commandBar"]))
        split.applySidebarMode(store.model.settings.sidebarMode)
    }

    @objc func openCommandBar() { store.ui.overlay = .commandBar("") }
    @objc func toggleOverview() { store.ui.overlay = store.ui.overlay == .overview ? nil : .overview }
    @objc func openSettings() { store.toggleSettings() }
    @objc func toggleSidebar() { store.toggleSidebar() }

    // ---- Toolbar ----------------------------------------------------------------------
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, Self.sidebar, .sidebarTrackingSeparator, Self.title, .space, Self.location, .space, Self.overview, Self.settings]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let item = NSToolbarItem(itemIdentifier: id)
        func button(_ symbol: String, _ label: String, _ action: Selector) {
            item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
            item.label = label
            item.toolTip = label
            item.target = self
            item.action = action
            item.isBordered = true
        }
        switch id {
        case .sidebarTrackingSeparator:
            // Keeps the toggle over the sidebar while it's open; collapsed, it moves beside the
            // window controls. The toolbar only tracks the divider when handed the split view.
            return NSTrackingSeparatorToolbarItem(identifier: id, splitView: split.splitView, dividerIndex: 0)
        case Self.sidebar:
            // Not navigational: macOS would pin it to the content column's leading edge.
            button("sidebar.left", "Sidebar", #selector(toggleSidebar))
        case Self.title:
            item.view = titleView
            item.label = "Space"
            item.isBordered = false
        case Self.location:
            item.view = locationButton
            item.label = "Command Bar"
            item.visibilityPriority = .high
        case Self.overview:
            button("square.grid.2x2", "All Spaces", #selector(toggleOverview))
        case Self.settings:
            button("gearshape", "Settings", #selector(openSettings))
        default:
            return nil
        }
        return item
    }
}

// Tells the store when a terminal takes focus (SwiftTerm's view can't be subclassed for it).
final class MainWindow: NSWindow {
    // Three-finger tap (Look Up) over a terminal copies its last command's output.
    override func quickLook(with event: NSEvent) {
        MainActor.assumeIsolated {
            let hit = contentView?.hitTest(contentView!.convert(event.locationInWindow, from: nil))
            var v = hit
            while let cur = v, !(cur is PaneView) { v = cur.superview }
            if let pane = v as? PaneView { Store.shared.copyLastOutput(pane.sid) } else { super.quickLook(with: event) }
        }
    }

    override func makeFirstResponder(_ responder: NSResponder?) -> Bool {
        let ok = super.makeFirstResponder(responder)
        if ok, let v = responder as? TermView, let s = v.session {
            MainActor.assumeIsolated { s.hooks?.termFocus(s) }
        }
        return ok
    }
}

// The toolbar's field: "⌕ ~/work/api · npm run dev   ⌘T", styled like a search field. It
// fills the toolbar between the title and the buttons; a path too long for it scrolls inside
// (shown from its end, so the folder and process stay in view).
final class LocationButton: NSButton {
    private let icon = NSImageView()
    private let scroll = NSScrollView()
    private let label = NSTextField(labelWithString: "")
    private let key = NSTextField(labelWithString: "")

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 420, height: 28))
        title = ""
        bezelStyle = .texturedRounded
        isBordered = true
        setButtonType(.momentaryPushIn)
        translatesAutoresizingMaskIntoConstraints = false
        // At least 220pt; otherwise as wide as the toolbar allows.
        widthAnchor.constraint(greaterThanOrEqualToConstant: 220).isActive = true
        let fill = widthAnchor.constraint(equalToConstant: 4000)
        fill.priority = .defaultLow
        fill.isActive = true
        icon.image = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: nil)
        icon.contentTintColor = .secondaryLabelColor
        icon.setContentHuggingPriority(.required, for: .horizontal)
        label.font = .systemFont(ofSize: 12.5)
        label.lineBreakMode = .byClipping
        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = false
        scroll.hasVerticalScroller = false
        scroll.horizontalScrollElasticity = .none
        scroll.verticalScrollElasticity = .none
        scroll.documentView = label
        key.font = .systemFont(ofSize: 11, weight: .medium)
        key.textColor = .secondaryLabelColor
        key.setContentHuggingPriority(.required, for: .horizontal)
        key.setContentCompressionResistancePriority(.required, for: .horizontal)
        // The shortcut in a small capsule at the field's end.
        key.wantsLayer = true
        key.drawsBackground = true
        key.backgroundColor = NSColor.labelColor.withAlphaComponent(0.08)
        key.layer?.cornerRadius = 8
        key.alignment = .center
        for v in [icon, scroll, key] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 9),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            scroll.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 6),
            scroll.trailingAnchor.constraint(equalTo: key.leadingAnchor, constant: -8),
            scroll.centerYAnchor.constraint(equalTo: centerYAnchor),
            scroll.heightAnchor.constraint(equalToConstant: 18),
            key.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            key.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func set(path: String, proc: String?, shortcut: String) {
        let s = NSMutableAttributedString(string: path, attributes: [.foregroundColor: NSColor.labelColor, .font: NSFont.systemFont(ofSize: 12.5, weight: .medium)])
        if let proc {
            s.append(NSAttributedString(string: "  ·  " + proc, attributes: [.foregroundColor: NSColor.secondaryLabelColor, .font: NSFont.systemFont(ofSize: 12.5)]))
        }
        key.stringValue = "  \(shortcut)  "
        toolTip = "Command bar  \(shortcut)\n\(s.string)"
        guard label.attributedStringValue != s else { return }
        label.attributedStringValue = s
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let h = scroll.contentSize.height
        label.frame = NSRect(x: 0, y: 0, width: ceil(label.attributedStringValue.size().width) + 4, height: h)
        scroll.contentView.scroll(to: NSPoint(x: max(0, label.frame.width - scroll.contentSize.width), y: 0))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    // Clicks anywhere open the command bar; a horizontal swipe scrolls the path.
    override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }
    override func scrollWheel(with event: NSEvent) { scroll.scrollWheel(with: event) }
}

// The toolbar's title: the Space's icon beside its name and session count, or the open page.
final class ToolbarTitleView: NSView {
    enum Icon {
        case space(Space)
        case symbol(String)
    }

    private let iconBox = NSView()
    private let title = NSTextField(labelWithString: "")
    private let subtitle = NSTextField(labelWithString: "")
    private var iconKey = ""

    init() {
        super.init(frame: .zero)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        subtitle.font = .systemFont(ofSize: 11)
        subtitle.textColor = .secondaryLabelColor
        subtitle.lineBreakMode = .byTruncatingTail
        let text = NSStackView(views: [title, subtitle])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 0
        let row = NSStackView(views: [iconBox, text])
        row.spacing = 8
        row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            iconBox.widthAnchor.constraint(equalToConstant: 20),
            iconBox.heightAnchor.constraint(equalToConstant: 20),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
            widthAnchor.constraint(lessThanOrEqualToConstant: 200),
            heightAnchor.constraint(equalToConstant: 32),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func set(icon: Icon, title t: String, subtitle sub: String) {
        if title.stringValue != t { title.stringValue = t }
        if subtitle.stringValue != sub { subtitle.stringValue = sub }
        subtitle.isHidden = sub.isEmpty
        let key: String
        switch icon {
        case .space(let sp): key = "space|\(sp.glyph)|\(sp.color)|\(sp.iconImage?.hashValue ?? 0)"
        case .symbol(let name): key = "symbol|\(name)"
        }
        guard key != iconKey else { return }
        iconKey = key
        iconBox.subviews.forEach { $0.removeFromSuperview() }
        let v: NSView
        switch icon {
        case .space(let sp):
            v = SpaceIcon.view(sp, size: 16)
        case .symbol(let name):
            let img = NSImageView(image: NSImage(systemSymbolName: name, accessibilityDescription: nil) ?? NSImage())
            img.symbolConfiguration = .init(pointSize: 14, weight: .medium)
            img.contentTintColor = .secondaryLabelColor
            v = img
        }
        v.translatesAutoresizingMaskIntoConstraints = false
        iconBox.addSubview(v)
        NSLayoutConstraint.activate([v.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor), v.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor)])
    }

    // Purely a label: the toolbar under it still drags the window.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// Sidebar beside the content column, as in Finder or Mail.
@MainActor
final class MainSplitViewController: NSSplitViewController {
    let sidebar = SidebarViewController()
    let content = ContentViewController()
    private lazy var sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebar)
    private var lastMode: String?

    // The sidebar is a fixed width, like Mail's; compact mode is the icon rail. The window's
    // traffic lights sit over the sidebar and reach about 80pt in, so the rail is wider than
    // its tiles need: at 64 the zoom button hung over the edge of macOS 26's floating sidebar.
    static let sidebarWidth: CGFloat = 220
    static let railWidth: CGFloat = 84

    override func viewDidLoad() {
        super.viewDidLoad()
        sidebarItem.minimumThickness = Self.sidebarWidth
        sidebarItem.maximumThickness = Self.sidebarWidth
        sidebarItem.canCollapse = true
        sidebarItem.allowsFullHeightLayout = true
        sidebarItem.titlebarSeparatorStyle = .none
        let contentItem = NSSplitViewItem(viewController: content)
        contentItem.titlebarSeparatorStyle = .line
        addSplitViewItem(sidebarItem)
        addSplitViewItem(contentItem)
    }

    // No resize cursor or drag on the divider: the sidebar doesn't resize.
    override func splitView(_ splitView: NSSplitView, effectiveRect proposedEffectiveRect: NSRect, forDrawnRect drawnRect: NSRect, ofDividerAt dividerIndex: Int) -> NSRect {
        .zero
    }

    func applySidebarMode(_ mode: String) {
        guard mode != lastMode else { return }
        let first = lastMode == nil
        lastMode = mode
        revealed = false
        let compact = mode == "compact"
        sidebar.compact = compact
        let width = compact ? Self.railWidth : Self.sidebarWidth
        sidebarItem.minimumThickness = width
        sidebarItem.maximumThickness = width
        let collapse = mode == "hidden"
        if sidebarItem.isCollapsed != collapse {
            if first { sidebarItem.isCollapsed = collapse } else { sidebarItem.animator().isCollapsed = collapse }
        }
        edge.isHidden = !collapse
    }

    // ---- Edge reveal ------------------------------------------------------------------
    // With the sidebar hidden, hovering the window's left edge slides it back in until the
    // pointer moves well off to the right.
    private let edge = EdgeStrip()
    private var revealed = false
    private var revealMonitor: Any?

    override func viewDidAppear() {
        super.viewDidAppear()
        guard edge.superview == nil else { return }
        edge.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(edge, positioned: .above, relativeTo: nil)
        NSLayoutConstraint.activate([edge.leadingAnchor.constraint(equalTo: view.leadingAnchor), edge.topAnchor.constraint(equalTo: view.topAnchor), edge.bottomAnchor.constraint(equalTo: view.bottomAnchor), edge.widthAnchor.constraint(equalToConstant: 5)])
        edge.isHidden = !sidebarItem.isCollapsed
        edge.onEnter = { [weak self] in self?.reveal() }
        // Collapsing before the window is on screen doesn't stick; start hidden from here.
        if lastMode == "hidden", !sidebarItem.isCollapsed {
            sidebarItem.isCollapsed = true
            edge.isHidden = false
        }
    }


    private func reveal() {
        guard Store.shared.model.settings.gestures.edgeReveal, sidebarItem.isCollapsed, !revealed else { return }
        revealed = true
        sidebarItem.animator().isCollapsed = false
        var timer: Timer?
        revealMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] e in
            MainActor.assumeIsolated {
                guard let self, self.revealed else { return }
                let x = self.view.convert(e.locationInWindow, from: nil).x
                let out = x > self.sidebar.view.frame.maxX + 8
                if out, timer == nil {
                    timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: false) { _ in MainActor.assumeIsolated { self.hideRevealed() } }
                } else if !out {
                    timer?.invalidate()
                    timer = nil
                }
            }
            return e
        }
    }

    private func hideRevealed() {
        guard revealed else { return }
        revealed = false
        if let m = revealMonitor { NSEvent.removeMonitor(m) }
        revealMonitor = nil
        if Store.shared.model.settings.sidebarMode == "hidden" { sidebarItem.animator().isCollapsed = true }
    }

    // The toolbar's native toggle and ⌃⌘S both go through the setting.
    override func toggleSidebar(_ sender: Any?) {
        Store.shared.toggleSidebar()
    }
}

final class EdgeStrip: NSView {
    var onEnter: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    required init?(coder: NSCoder) { fatalError() }

    override func mouseEntered(with event: NSEvent) { onEnter?() }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
