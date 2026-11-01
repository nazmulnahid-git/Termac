import AppKit
import TermorcCore

// The main window: a full-height sidebar (Spaces and sessions) beside the content column
// (the terminal card over the Spaces bar), under a unified toolbar. Like a native toolbar it
// leads with a title (the Space, or the open page) and a quiet subtitle; the centre field
// reads like a terminal's title (where you are, what's running) and opens the command bar.
@MainActor
final class MainWindowController: NSWindowController, NSWindowDelegate, NSToolbarDelegate {
    let store = Store.shared
    let split = MainSplitViewController()
    private var token: ObserverToken?
    private let locationButton = LocationButton()

    static let location = NSToolbarItem.Identifier("location")
    static let overview = NSToolbarItem.Identifier("overview")
    static let settings = NSToolbarItem.Identifier("settings")
    static let sidebar = NSToolbarItem.Identifier("sidebarToggle")

    init() {
        let w = MainWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        w.minSize = NSSize(width: 720, height: 420)
        w.title = "Termorc"
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
            w.subtitle = ""
        case .library:
            w.title = "Library"
            w.subtitle = ""
        case .terminal:
            let tids = sp.allTabs
            let running = tids.filter { tid in store.model.tabs[tid]?.layout.leaves.contains { store.rt[$0]?.status == .run } ?? false }.count
            w.title = sp.name
            w.subtitle = (tids.count == 1 ? "1 session" : "\(tids.count) sessions") + (running > 0 ? " · \(running) running" : "")
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
        [Self.sidebar, .sidebarTrackingSeparator, .flexibleSpace, Self.location, .flexibleSpace, Self.overview, Self.settings]
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
        case Self.sidebar:
            button("sidebar.left", "Sidebar", #selector(toggleSidebar))
            item.isNavigational = true
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

// The centre of the toolbar: "⌕ ~/work/api · npm run dev   ⌘T", styled like a search field.
final class LocationButton: NSButton {
    private let icon = NSImageView()
    private let label = NSTextField(labelWithString: "")
    private let key = NSTextField(labelWithString: "")

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 380, height: 28))
        title = ""
        bezelStyle = .texturedRounded
        isBordered = true
        setButtonType(.momentaryPushIn)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(greaterThanOrEqualToConstant: 240).isActive = true
        widthAnchor.constraint(lessThanOrEqualToConstant: 520).isActive = true
        let w = widthAnchor.constraint(equalToConstant: 420)
        w.priority = .defaultLow
        w.isActive = true
        icon.image = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: nil)
        icon.contentTintColor = .secondaryLabelColor
        label.lineBreakMode = .byTruncatingMiddle
        label.font = .systemFont(ofSize: 12.5)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        key.font = .systemFont(ofSize: 11, weight: .medium)
        key.textColor = .secondaryLabelColor
        // The shortcut in a small capsule at the field's end.
        key.wantsLayer = true
        key.drawsBackground = true
        key.backgroundColor = NSColor.labelColor.withAlphaComponent(0.08)
        key.layer?.cornerRadius = 8
        key.alignment = .center
        for v in [icon, label, key] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 9),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 6),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            key.leadingAnchor.constraint(greaterThanOrEqualTo: label.trailingAnchor, constant: 8),
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
        if label.attributedStringValue != s { label.attributedStringValue = s }
        key.stringValue = "  \(shortcut)  "
        toolTip = "Command bar  \(shortcut)"
    }
}

// Sidebar beside the content column, as in Finder or Mail.
@MainActor
final class MainSplitViewController: NSSplitViewController {
    let sidebar = SidebarViewController()
    let content = ContentViewController()
    private lazy var sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebar)
    private var lastMode: String?

    override func viewDidLoad() {
        super.viewDidLoad()
        sidebarItem.minimumThickness = 220
        sidebarItem.maximumThickness = 360
        sidebarItem.canCollapse = true
        sidebarItem.allowsFullHeightLayout = true
        sidebarItem.titlebarSeparatorStyle = .none
        let contentItem = NSSplitViewItem(viewController: content)
        contentItem.titlebarSeparatorStyle = .line
        addSplitViewItem(sidebarItem)
        addSplitViewItem(contentItem)
        splitView.autosaveName = "TermorcSidebar"
    }

    func applySidebarMode(_ mode: String) {
        guard mode != lastMode else { return }
        let first = lastMode == nil
        lastMode = mode
        revealed = false
        let compact = mode == "compact"
        sidebar.compact = compact
        sidebarItem.minimumThickness = compact ? 64 : 220
        sidebarItem.maximumThickness = compact ? 64 : 360
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
