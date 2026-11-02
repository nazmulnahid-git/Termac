import AppKit
import TermorcCore

// The content column: the active session's card (or the Library / Settings page) over the
// Spaces bar.
@MainActor
final class ContentViewController: NSViewController {
    let store = Store.shared
    let card = CardView()
    let statusBar = StatusBarView()
    private var token: ObserverToken?
    private lazy var statusBarHeight = statusBar.heightAnchor.constraint(equalToConstant: UI.px(30))

    override func loadView() {
        let root = NSView()
        for v in [card, statusBar] {
            v.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(v)
        }
        NSLayoutConstraint.activate([
            card.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor),
            card.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            card.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            card.bottomAnchor.constraint(equalTo: statusBar.topAnchor),
            statusBar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            statusBar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            statusBar.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            statusBarHeight,
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        token = store.observe { [weak self] in self?.refresh() }
        refresh()
    }

    private var library: NSView?
    private var settings: NSView?

    private func refresh() {
        statusBarHeight.constant = UI.px(30)
        card.update()
        statusBar.update()
        // The Library takes the card's place while it's open, fresh each time.
        if store.ui.view == .library, library == nil {
            let host = LibraryView.host { [weak self] in
                self?.store.ui.view = .terminal
                self?.store.syncFocus()
            }
            host.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(host)
            NSLayoutConstraint.activate([host.topAnchor.constraint(equalTo: card.topAnchor), host.bottomAnchor.constraint(equalTo: card.bottomAnchor), host.leadingAnchor.constraint(equalTo: card.leadingAnchor), host.trailingAnchor.constraint(equalTo: card.trailingAnchor)])
            library = host
        } else if store.ui.view != .library, let l = library {
            l.removeFromSuperview()
            library = nil
        }
        // Settings likewise.
        if store.ui.view == .settings, settings == nil {
            let host = SettingsPage.host()
            host.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(host)
            NSLayoutConstraint.activate([host.topAnchor.constraint(equalTo: card.topAnchor), host.bottomAnchor.constraint(equalTo: card.bottomAnchor), host.leadingAnchor.constraint(equalTo: card.leadingAnchor), host.trailingAnchor.constraint(equalTo: card.trailingAnchor)])
            settings = host
            // Keys stop going to the terminal behind it.
            if view.window?.firstResponder is TermView { view.window?.makeFirstResponder(nil) }
        } else if store.ui.view != .settings, let st = settings {
            st.removeFromSuperview()
            settings = nil
        }
        Overlays.shared.update(in: view.window)
    }
}

// The terminal card: one session's panes laid out by its split tree, painted with the
// Space's terminal look, and a red frame on danger sessions.
@MainActor
final class CardView: NSView {
    let store = Store.shared
    // Recently shown tabs keep their pane trees in the card, hidden while another tab shows,
    // so switching tabs or Spaces only flips visibility instead of rebuilding views.
    private struct Tree {
        let root: NSView
        var layout: Layout
        var panes: [String: PaneView]
        var look: TerminalLook
        var used: Int
    }
    private var trees: [String: Tree] = [:]
    private var tick = 0
    private var shownTid: String?
    private var panes: [String: PaneView] { shownTid.flatMap { trees[$0]?.panes } ?? [:] }
    static let keepTrees = 8
    private var shownLook: TerminalLook?
    private let frameLayer = CALayer()
    // A plain layer, not an NSImageView: an image view asks for its image's size, and Auto
    // Layout grew the window to fit a large background. Fills like the Space editor's preview.
    private let bgImage = NSView()
    private let bgDim = NSView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        bgImage.wantsLayer = true
        bgImage.layer?.contentsGravity = .resizeAspectFill
        bgImage.layer?.masksToBounds = true
        bgImage.translatesAutoresizingMaskIntoConstraints = false
        bgDim.wantsLayer = true
        bgDim.translatesAutoresizingMaskIntoConstraints = false
        addSubview(bgImage)
        addSubview(bgDim)
        for v in [bgImage, bgDim] {
            NSLayoutConstraint.activate([v.topAnchor.constraint(equalTo: topAnchor), v.bottomAnchor.constraint(equalTo: bottomAnchor), v.leadingAnchor.constraint(equalTo: leadingAnchor), v.trailingAnchor.constraint(equalTo: trailingAnchor)])
        }
        frameLayer.borderColor = NSColor.systemRed.cgColor
        frameLayer.borderWidth = 2
        frameLayer.zPosition = 100
        layer?.addSublayer(frameLayer)
        registerForDraggedTypes([.termorcTab])
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        frameLayer.frame = bounds
    }

    func update() {
        guard store.ui.view == .terminal, let tab = store.activeTab else {
            if let t = shownTid { trees[t]?.root.isHidden = true }
            return
        }
        let look = store.look(for: store.activeSpace)
        if look != shownLook {
            shownLook = look
            layer?.backgroundColor = NSColor(hex: look.bg).cgColor
            bgImage.layer?.contents = look.image.flatMap { NSImage(contentsOfFile: $0) }
            bgImage.isHidden = look.image == nil
            bgDim.isHidden = look.image == nil
            bgDim.layer?.backgroundColor = NSColor(hex: look.bg, alpha: look.dim).cgColor
        }
        frameLayer.isHidden = !tab.has("danger")
        show(tab, look: look)
        let multi = tab.layout.leaves.count > 1
        for (sid, p) in panes { p.update(focused: sid == tab.activeSid, multi: multi, danger: tab.has("danger")) }
    }

    private func show(_ tab: Tab, look: TerminalLook) {
        tick += 1
        let switched = tab.id != shownTid
        if switched, let old = shownTid, let t = trees[old] {
            t.root.isHidden = true
            t.panes.values.forEach { $0.park() }
        }
        // A kept tree is reused when its split shape still matches and no pane has moved to
        // another tab's tree since.
        if var t = trees[tab.id], sameShape(tab.layout, t.layout), t.panes.values.allSatisfy({ $0.isDescendant(of: t.root) }) {
            if tab.layout != t.layout { (t.root as? SplitContainer)?.updateRatios(tab.layout) }
            t.layout = tab.layout
            t.used = tick
            if t.look != look {
                t.look = look
                t.panes.values.forEach { $0.apply(look) }
            }
            trees[tab.id] = t
            shownTid = tab.id
            t.root.isHidden = false // also after the Library hid it
            guard switched else { return }
            t.panes.values.forEach { $0.attach() }
        } else {
            build(tab, look: look)
        }
        for sid in tab.layout.leaves { store.ensureStarted(sid) }
        store.syncFocus()
        prune()
    }

    // Lays the split tree out as nested split containers. Panes are reused by session id,
    // from whichever kept tree holds them.
    private func build(_ tab: Tab, look: TerminalLook) {
        var made: [String: PaneView] = [:]
        let view = node(tab.layout, tid: tab.id, path: [], look: look, made: &made)
        if let old = trees.removeValue(forKey: tab.id) {
            for (sid, p) in old.panes where made[sid] == nil { p.park(); p.removeFromSuperview() }
            old.root.removeFromSuperview()
        }
        view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(view, positioned: .above, relativeTo: bgDim)
        NSLayoutConstraint.activate([view.topAnchor.constraint(equalTo: topAnchor), view.bottomAnchor.constraint(equalTo: bottomAnchor), view.leadingAnchor.constraint(equalTo: leadingAnchor), view.trailingAnchor.constraint(equalTo: trailingAnchor)])
        trees[tab.id] = Tree(root: view, layout: tab.layout, panes: made, look: look, used: tick)
        shownTid = tab.id
    }

    // Drops trees of closed tabs, and the least recently shown beyond `keepTrees`.
    private func prune() {
        var gone = trees.keys.filter { store.model.tabs[$0] == nil && $0 != shownTid }
        let live = trees.filter { !gone.contains($0.key) && $0.key != shownTid }.sorted { $0.value.used > $1.value.used }
        gone += live.dropFirst(Self.keepTrees - 1).map(\.key)
        for tid in gone {
            guard let t = trees.removeValue(forKey: tid) else { continue }
            for p in t.panes.values where p.isDescendant(of: t.root) { p.park() }
            t.root.removeFromSuperview()
        }
    }

    private func sameShape(_ a: Layout?, _ b: Layout?) -> Bool {
        switch (a, b) {
        case let (.leaf(x)?, .leaf(y)?): return x == y
        case let (.split(d1, _, a1, b1)?, .split(d2, _, a2, b2)?): return d1 == d2 && sameShape(a1, a2) && sameShape(b1, b2)
        default: return false
        }
    }

    private func node(_ n: Layout, tid: String, path: [Layout.Step], look: TerminalLook, made: inout [String: PaneView]) -> NSView {
        switch n {
        case .leaf(let sid):
            let p = trees.values.lazy.compactMap { $0.panes[sid] }.first ?? PaneView(sid: sid)
            made[sid] = p
            p.removeFromSuperview()
            p.isHidden = false // a one-pane tab's pane is its tree's root, hidden with it
            p.apply(look)
            p.attach()
            return p
        case let .split(dir, ratio, a, b):
            return SplitContainer(dir: dir, ratio: ratio, tid: tid, path: path,
                                  a: node(a, tid: tid, path: path + [.a], look: look, made: &made),
                                  b: node(b, tid: tid, path: path + [.b], look: look, made: &made))
        }
    }

    // ---- Drop a sidebar session on a card edge to split ------------------------------------
    private var dropEdge: Layout.Edge?
    private let dropHighlight = NSView()

    func edge(for p: NSPoint) -> Layout.Edge {
        let x = p.x / max(1, bounds.width), y = 1 - p.y / max(1, bounds.height)
        let d = [(Layout.Edge.left, x), (.right, 1 - x), (.top, y), (.bottom, 1 - y)]
        return d.min { $0.1 < $1.1 }!.0
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { draggingUpdated(sender) }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard let tid = sender.draggingPasteboard.string(forType: .termorcTab), let tab = store.activeTab, tid != tab.id,
              let src = store.model.tabs[tid], tab.layout.leaves.count + src.layout.leaves.count <= Layout.maxPanes else { return [] }
        let e = edge(for: convert(sender.draggingLocation, from: nil))
        if e != dropEdge {
            dropEdge = e
            showDropHighlight(e)
        }
        return .move
    }

    override func draggingExited(_ sender: NSDraggingInfo?) { hideDropHighlight() }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        defer { hideDropHighlight() }
        guard let tid = sender.draggingPasteboard.string(forType: .termorcTab), let e = dropEdge else { return false }
        store.mergeIntoActive(tid, edge: e)
        return true
    }

    // A sidebar drag (SidebarDrag) over the card: the half it would take, and what it does.
    private let dropLabel = NSTextField(labelWithString: "")
    private let dropPill = NSView()

    func showDrop(_ e: Layout.Edge, tid: String) {
        let name = TabView.make(tid)?.name ?? "session"
        let verb = [Layout.Edge.left: "Split left", .right: "Split right", .top: "Split up", .bottom: "Split down"][e] ?? ""
        showDropHighlight(e)
        if dropPill.superview == nil {
            dropPill.wantsLayer = true
            dropPill.shadow = { let s = NSShadow(); s.shadowBlurRadius = 14; s.shadowOffset = NSSize(width: 0, height: -4); s.shadowColor = NSColor.black.withAlphaComponent(0.35); return s }()
            dropLabel.translatesAutoresizingMaskIntoConstraints = false
            dropPill.translatesAutoresizingMaskIntoConstraints = false
            dropPill.addSubview(dropLabel)
            addSubview(dropPill)
            NSLayoutConstraint.activate([
                dropLabel.leadingAnchor.constraint(equalTo: dropPill.leadingAnchor, constant: 14), dropLabel.trailingAnchor.constraint(equalTo: dropPill.trailingAnchor, constant: -14),
                dropLabel.topAnchor.constraint(equalTo: dropPill.topAnchor, constant: 6), dropLabel.bottomAnchor.constraint(equalTo: dropPill.bottomAnchor, constant: -6),
                dropPill.centerXAnchor.constraint(equalTo: centerXAnchor), dropPill.centerYAnchor.constraint(equalTo: centerYAnchor),
            ])
        }
        let accent = UI.accent()
        dropPill.layer?.backgroundColor = accent.cgColor
        dropPill.layer?.cornerRadius = 15
        dropLabel.font = UI.font(1, .medium)
        dropLabel.textColor = accent.brightnessComponentSafe > 0.75 ? .black : .white
        dropLabel.stringValue = "\(verb) · \(name)"
    }

    func hideDrop() {
        hideDropHighlight()
        dropPill.removeFromSuperview()
    }

    private func showDropHighlight(_ e: Layout.Edge) {
        let accent = UI.accent()
        dropHighlight.wantsLayer = true
        dropHighlight.layer?.backgroundColor = accent.withAlphaComponent(0.22).cgColor
        dropHighlight.layer?.borderColor = accent.cgColor
        dropHighlight.layer?.borderWidth = 1
        dropHighlight.layer?.cornerRadius = 6
        if dropHighlight.superview == nil {
            addSubview(dropHighlight, positioned: .below, relativeTo: dropPill.superview == nil ? nil : dropPill)
        }
        let b = bounds.insetBy(dx: 6, dy: 6)
        let f: NSRect
        switch e {
        case .left: f = NSRect(x: b.minX, y: b.minY, width: b.width / 2, height: b.height)
        case .right: f = NSRect(x: b.midX, y: b.minY, width: b.width / 2, height: b.height)
        case .top: f = NSRect(x: b.minX, y: b.midY, width: b.width, height: b.height / 2)
        case .bottom: f = NSRect(x: b.minX, y: b.minY, width: b.width, height: b.height / 2)
        }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            dropHighlight.animator().frame = f
        }
    }

    private func hideDropHighlight() {
        dropEdge = nil
        dropHighlight.removeFromSuperview()
    }
}

// Two children side by side (row) or stacked (col) with a draggable divider that snaps to
// ⅓, ½ and ⅔ and shows the ratio while dragging. Double-click resets to ½.
@MainActor
final class SplitContainer: NSView {
    let dir: Layout.Dir
    private(set) var ratio: Double
    let tid: String
    let path: [Layout.Step]
    let a: NSView
    let b: NSView
    private let divider = DividerView()
    static let thickness: CGFloat = 1

    init(dir: Layout.Dir, ratio: Double, tid: String, path: [Layout.Step], a: NSView, b: NSView) {
        self.dir = dir
        self.ratio = ratio
        self.tid = tid
        self.path = path
        self.a = a
        self.b = b
        super.init(frame: .zero)
        for v in [a, b, divider] {
            v.translatesAutoresizingMaskIntoConstraints = true
            addSubview(v)
        }
        divider.vertical = dir == .row
        divider.onDrag = { [weak self] p in self?.drag(to: p) }
        divider.onReset = { [weak self] in
            guard let self else { return }
            Store.shared.setRatio(tid, path: path, ratio: 0.5)
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    func updateRatios(_ node: Layout) {
        guard case let .split(_, r, na, nb) = node else { return }
        if r != ratio {
            ratio = r
            needsLayout = true
        }
        (a as? SplitContainer)?.updateRatios(na)
        (b as? SplitContainer)?.updateRatios(nb)
    }

    override func layout() {
        super.layout()
        let t = Self.thickness
        if dir == .row {
            let w = (bounds.width - t) * ratio
            a.frame = NSRect(x: 0, y: 0, width: w.rounded(), height: bounds.height)
            divider.frame = NSRect(x: a.frame.maxX - 3, y: 0, width: t + 6, height: bounds.height)
            b.frame = NSRect(x: a.frame.maxX + t, y: 0, width: bounds.width - a.frame.maxX - t, height: bounds.height)
        } else {
            // Flipped coordinates: `a` is on top.
            let h = (bounds.height - t) * ratio
            a.frame = NSRect(x: 0, y: bounds.height - h.rounded(), width: bounds.width, height: h.rounded())
            divider.frame = NSRect(x: 0, y: a.frame.minY - t - 3, width: bounds.width, height: t + 6)
            b.frame = NSRect(x: 0, y: 0, width: bounds.width, height: a.frame.minY - t)
        }
    }

    private func drag(to p: NSPoint) {
        let local = convert(p, from: nil)
        let r = dir == .row ? local.x / max(1, bounds.width) : 1 - local.y / max(1, bounds.height)
        let snapped = Layout.snapRatio(r)
        divider.ratioLabel = "\(Int((snapped * 100).rounded())) : \(100 - Int((snapped * 100).rounded()))"
        Store.shared.setRatio(tid, path: path, ratio: snapped)
    }
}

final class DividerView: NSView {
    var vertical = true
    var onDrag: ((NSPoint) -> Void)?
    var onReset: (() -> Void)?
    var ratioLabel: String? { didSet { label.stringValue = ratioLabel ?? ""; label.isHidden = ratioLabel == nil } }
    private let label = NSTextField(labelWithString: "")

    override init(frame: NSRect) {
        super.init(frame: frame)
        label.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        label.isHidden = true
        label.wantsLayer = true
        label.drawsBackground = true
        label.backgroundColor = .windowBackgroundColor
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.separatorColor.setFill()
        if vertical { NSRect(x: bounds.midX - 0.5, y: 0, width: 1, height: bounds.height).fill() }
        else { NSRect(x: 0, y: bounds.midY - 0.5, width: bounds.width, height: 1).fill() }
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: vertical ? .resizeLeftRight : .resizeUpDown)
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { onReset?(); return }
    }

    override func mouseDragged(with event: NSEvent) {
        onDrag?(event.locationInWindow)
        label.sizeToFit()
        label.setFrameOrigin(NSPoint(x: bounds.midX - label.frame.width / 2, y: bounds.midY - label.frame.height / 2))
    }

    override func mouseUp(with event: NSEvent) { ratioLabel = nil }
}
