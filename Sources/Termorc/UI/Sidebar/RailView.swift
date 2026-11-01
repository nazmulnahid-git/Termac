import AppKit
import TermorcCore

// Compact sidebar: one icon tile per session; folders expand in place.
@MainActor
final class RailView: NSView {
    let store = Store.shared
    private let stack = NSStackView()
    private let scroll = NSScrollView()
    private var key = ""

    override init(frame: NSRect) {
        super.init(frame: frame)
        stack.orientation = .vertical
        stack.spacing = 6
        stack.alignment = .centerX
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 0, bottom: 12, right: 0)
        let doc = FlippedView()
        doc.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(stack)
        scroll.documentView = doc
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor), scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor), scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            doc.widthAnchor.constraint(equalTo: scroll.widthAnchor),
            stack.topAnchor.constraint(equalTo: doc.topAnchor), stack.leadingAnchor.constraint(equalTo: doc.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: doc.trailingAnchor), stack.bottomAnchor.constraint(equalTo: doc.bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func update() {
        let sp = store.activeSpace
        let k = [store.model.favorites.joined(), sp.id, sp.allTabs.joined(), sp.folders.map { "\($0.id)\($0.open)" }.joined()].joined(separator: "|")
        if k != key {
            key = k
            rebuild(sp)
        }
        for case let t as RailTile in stack.arrangedSubviews { t.refresh() }
    }

    private func rebuild(_ sp: Space) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if !store.model.favorites.isEmpty {
            store.model.favorites.forEach { stack.addArrangedSubview(RailTile(tid: $0)) }
            stack.addArrangedSubview(separator())
        }
        let g = SpaceIcon.view(sp, size: 15)
        g.toolTip = sp.name
        stack.addArrangedSubview(g)
        sp.pinned.forEach { stack.addArrangedSubview(RailTile(tid: $0)) }
        for f in sp.folders {
            let b = RailButton(symbol: f.open ? "folder" : "folder.fill", tip: "\(f.name) · \(f.tabs.length)") { [store] in store.updateFolder(sp.id, f.id) { $0.open.toggle() } }
            stack.addArrangedSubview(b)
            if f.open { f.tabs.forEach { stack.addArrangedSubview(RailTile(tid: $0)) } }
        }
        if !sp.today.isEmpty { stack.addArrangedSubview(separator()) }
        sp.today.forEach { stack.addArrangedSubview(RailTile(tid: $0)) }
        stack.addArrangedSubview(RailButton(symbol: "plus", tip: "New terminal  \(Keys.format(store.model.settings.keybindings["newTerminal"]))") { [store] in store.openTerminal() })
    }

    private func separator() -> NSView {
        let v = NSBox()
        v.boxType = .separator
        v.widthAnchor.constraint(equalToConstant: 28).isActive = true
        return v
    }
}

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

private extension Array {
    var length: Int { count }
}

final class RailButton: NSButton {
    private let fn: () -> Void

    init(symbol: String, tip: String, _ fn: @escaping () -> Void) {
        self.fn = fn
        super.init(frame: .zero)
        image = NSImage(systemSymbolName: symbol, accessibilityDescription: tip)
        symbolConfiguration = .init(pointSize: 14, weight: .regular)
        isBordered = false
        contentTintColor = .secondaryLabelColor
        toolTip = tip
        target = self
        action = #selector(tap)
        widthAnchor.constraint(equalToConstant: 40).isActive = true
        heightAnchor.constraint(equalToConstant: 32).isActive = true
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc private func tap() { fn() }
}

// A session as a square tile: what it runs (or its chosen icon), a status dot, a bell badge.
@MainActor
final class RailTile: NSView {
    let tid: String
    private let icon = NSImageView()
    private let glyph = NSTextField(labelWithString: "")
    private let dot = NSView()
    private var active = false
    private var tint: NSColor?

    init(tid: String) {
        self.tid = tid
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 9
        icon.symbolConfiguration = .init(pointSize: 15, weight: .regular)
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3
        for v in [icon, glyph, dot] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 40), heightAnchor.constraint(equalToConstant: 40),
            icon.centerXAnchor.constraint(equalTo: centerXAnchor), icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            glyph.centerXAnchor.constraint(equalTo: centerXAnchor), glyph.centerYAnchor.constraint(equalTo: centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 6), dot.heightAnchor.constraint(equalToConstant: 6),
            dot.topAnchor.constraint(equalTo: topAnchor, constant: 5), dot.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -5),
        ])
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
        refresh()
    }

    required init?(coder: NSCoder) { fatalError() }

    func refresh() {
        guard let v = TabView.make(tid) else { return }
        let store = Store.shared
        active = store.activeTabId == tid
        tint = v.tab.color.map { NSColor(hex: $0) }
        toolTip = v.name
        let (img, text) = KindIcons.image(kind: v.active?.kind ?? ">_", icon: v.tab.icon)
        icon.image = img
        icon.isHidden = img == nil
        glyph.stringValue = text ?? ""
        glyph.isHidden = text == nil
        icon.contentTintColor = tint ?? (active ? NSColor(hex: store.activeSpace.color) : .secondaryLabelColor)
        let c: NSColor? = [.run: .controlAccentColor, .ok: .systemGreen, .fail: .systemRed, .bell: .systemOrange][v.status]
        dot.isHidden = c == nil
        dot.layer?.backgroundColor = c?.cgColor
        layer?.backgroundColor = (tint ?? .labelColor).withAlphaComponent(active ? 0.14 : (tint != nil ? 0.12 : 0)).cgColor
        alphaValue = v.dead ? 0.5 : 1
    }

    override func mouseEntered(with event: NSEvent) { Peek.shared.hover(tid, from: self) }
    override func mouseExited(with event: NSEvent) { Peek.shared.leave() }

    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.shift) { Peek.shared.togglePin(tid, from: self); return }
        Peek.shared.leftSidebar()
        let store = Store.shared
        if let v = TabView.make(tid), v.status == .fail, !active, let f = v.fail { store.jumpToFailure(f) } else { store.activateTab(tid) }
    }

    override func mouseDragged(with event: NSEvent) {
        let item = NSPasteboardItem()
        item.setString(tid, forType: .termorcTab)
        let d = NSDraggingItem(pasteboardWriter: item)
        d.setDraggingFrame(bounds, contents: NSImage(systemSymbolName: "terminal", accessibilityDescription: nil))
        beginDraggingSession(with: [d], event: event, source: self)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let m = NSMenu()
        SidebarMenus.row(m, tid: tid, rename: nil, newFolder: nil)
        return m
    }
}

extension RailTile: NSDraggingSource {
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .move }
}
