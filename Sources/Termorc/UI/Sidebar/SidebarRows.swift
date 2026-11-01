import AppKit
import TermorcCore

// Aggregated view of a sidebar row: names, chips and the most urgent status of its panes.
@MainActor
struct TabView {
    enum Status { case idle, run, ok, fail, bell }

    struct Pane {
        let sid: String
        let rt: SessionRuntime
        let kind: String
        let name: String
    }

    let tab: Tab
    let panes: [Pane]
    let active: Pane?
    let name: String
    let status: Status
    let bell: Int
    let fail: String? // sid of the failed pane
    let danger: Bool
    let dead: Bool

    static func make(_ tid: String) -> TabView? {
        let store = Store.shared
        guard let tab = store.model.tabs[tid] else { return nil }
        let panes = tab.layout.leaves.map { sid -> Pane in
            let r = store.rt[sid] ?? SessionRuntime()
            let meta = store.model.sessions[sid]
            return Pane(sid: sid, rt: r, kind: Meta.kindOf(r.command.isEmpty ? meta?.command : r.command),
                        name: Meta.sessionName(tabName: nil, rt: r, cwd: meta?.cwd, home: store.home))
        }
        let bell = panes.reduce(0) { $0 + $1.rt.bell }
        let fail = panes.first { $0.rt.status == .fail }
        let status: Status = bell > 0 ? .bell : fail != nil ? .fail : panes.contains { $0.rt.status == .run } ? .run : panes.contains { $0.rt.status == .ok } ? .ok : .idle
        let active = panes.first { $0.sid == tab.activeSid } ?? panes.first
        let name = tab.name ?? (panes.count > 1 ? panes.map(\.name).joined(separator: " · ") : active?.name ?? "~")
        let dead = panes.count == 1 && active?.rt.alive == false && store.sessions[active!.sid]?.started == true
        return TabView(tab: tab, panes: panes, active: active, name: name, status: status, bell: bell, fail: fail?.sid, danger: tab.has("danger"), dead: dead)
    }
}

// What a session runs, as an SF Symbol in the row's gutter.
enum KindIcons {
    static let symbols: [String: (String, String)] = [
        ">_": ("terminal", "Shell"), "js": ("hexagon", "JavaScript"), "py": ("testtube.2", "Python"),
        "db": ("cylinder.split.1x2", "Database"), "git": ("arrow.triangle.branch", "Git"), "ssh": ("server.rack", "SSH"),
        "tf": ("square.3.stack.3d", "Terraform"), "k8": ("circle.hexagongrid", "Kubernetes"), "rs": ("gearshape.2", "Rust"),
        "go": ("hare", "Go"), "dk": ("shippingbox", "Docker"), "ed": ("square.and.pencil", "Editor"), "top": ("waveform.path.ecg", "Monitor"),
    ]

    // Icons a session can wear (Icon & Color…), stored on the tab by id.
    static let tabIcons: [(String, String)] = [
        ("terminal", "terminal"), ("code", "chevron.left.forwardslash.chevron.right"), ("server", "server.rack"), ("database", "cylinder.split.1x2"),
        ("globe", "globe"), ("cloud", "cloud"), ("network", "network"), ("webhook", "link"), ("container", "shippingbox"), ("package", "cube.box"),
        ("layers", "square.3.stack.3d"), ("git-branch", "arrow.triangle.branch"), ("rocket", "paperplane"), ("zap", "bolt"), ("flame", "flame"),
        ("activity", "waveform.path.ecg"), ("chart", "chart.line.uptrend.xyaxis"), ("cpu", "cpu"), ("hard-drive", "internaldrive"), ("monitor", "display"),
        ("smartphone", "iphone"), ("bug", "ladybug"), ("flask", "flask|testtube.2"), ("wrench", "wrench.and.screwdriver"), ("settings", "gearshape"),
        ("workflow", "flowchart|square.stack.3d.down.right"), ("shield", "checkmark.shield"), ("lock", "lock"), ("key", "key"), ("bot", "brain|cpu"),
        ("sparkles", "sparkles"), ("atom", "atom"), ("puzzle", "puzzlepiece"), ("book", "book"), ("notebook", "note.text"), ("calendar", "calendar"),
        ("mail", "envelope"), ("palette", "paintpalette"), ("music", "music.note"), ("coffee", "cup.and.saucer"), ("house", "house"),
        ("briefcase", "briefcase"), ("target", "target"), ("trophy", "trophy|rosette"), ("star", "star"), ("heart", "heart"), ("leaf", "leaf"), ("anchor", "sailboat"),
    ]

    // "flask|testtube.2": the first symbol this macOS has.
    static func symbol(_ spec: String) -> NSImage? {
        for name in spec.split(separator: "|") {
            if let img = NSImage(systemSymbolName: String(name), accessibilityDescription: nil) { return img }
        }
        return nil
    }

    static func image(kind: String, icon: String?) -> (NSImage?, String?) {
        if let icon {
            if let spec = tabIcons.first(where: { $0.0 == icon })?.1 { return (symbol(spec), nil) }
            return (nil, icon) // an emoji or typed character from older builds
        }
        let (sym, label) = symbols[kind] ?? symbols[">_"]!
        return (NSImage(systemSymbolName: sym, accessibilityDescription: label), nil)
    }
}

// Status at the end of a row: a spinner while running, ✓ done, ✗ failed, a bell count.
final class StatusMarkView: NSView {
    private let label = NSTextField(labelWithString: "")
    private let spinner = NSProgressIndicator()
    private let dot = NSView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        spinner.style = .spinning
        spinner.controlSize = .mini
        spinner.isIndeterminate = true
        label.font = .systemFont(ofSize: 11, weight: .bold)
        label.alignment = .center
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3
        for v in [label, spinner, dot] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
            v.centerXAnchor.constraint(equalTo: centerXAnchor).isActive = true
            v.centerYAnchor.constraint(equalTo: centerYAnchor).isActive = true
        }
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 22), heightAnchor.constraint(equalToConstant: 18),
            dot.widthAnchor.constraint(equalToConstant: 6), dot.heightAnchor.constraint(equalToConstant: 6),
            spinner.widthAnchor.constraint(equalToConstant: 12), spinner.heightAnchor.constraint(equalToConstant: 12),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func set(_ status: TabView.Status, bell: Int, accent: NSColor) {
        label.isHidden = true
        dot.isHidden = true
        spinner.isHidden = true
        spinner.stopAnimation(nil)
        label.wantsLayer = true
        label.layer?.backgroundColor = nil
        switch status {
        case .run:
            spinner.isHidden = false
            spinner.startAnimation(nil)
        case .ok:
            label.isHidden = false
            label.stringValue = "✓"
            label.textColor = .systemGreen
        case .fail:
            label.isHidden = false
            label.stringValue = "✗"
            label.textColor = .systemRed
        case .bell:
            label.isHidden = false
            label.stringValue = "\(bell)"
            label.textColor = .black
            label.layer?.backgroundColor = NSColor.systemOrange.cgColor
            label.layer?.cornerRadius = 4
        case .idle:
            dot.isHidden = false
            dot.layer?.backgroundColor = NSColor.tertiaryLabelColor.withAlphaComponent(0.4).cgColor
        }
    }
}

// One session row, or for a split session an Arc-style row with a segment per pane. Under
// the pointer it shows ✕ to close it, or − on a pinned row: that stops its shells but keeps
// the row, dimmed, to start again with a click.
final class SessionRowView: NSTableCellView, NSTextFieldDelegate {
    static let id = NSUserInterfaceItemIdentifier("session")
    private let icon = NSImageView()
    private let glyph = NSTextField(labelWithString: "")
    private let name = NSTextField(labelWithString: "")
    private let segs = NSStackView()
    private let prod = NSTextField(labelWithString: "PROD")
    private let status = StatusMarkView()
    private let close = RowButton(symbol: "xmark", tip: "Close")
    private var tracking: NSTrackingArea?
    private var hover = false { didSet { updateHover() } }
    private var onRename: ((String?) -> Void)?
    private var current: TabView.Status = .idle
    private var split = false
    private var closable = true
    var onClose: (() -> Void)?

    init() {
        super.init(frame: .zero)
        identifier = Self.id
        icon.symbolConfiguration = .init(pointSize: 13, weight: .regular)
        icon.contentTintColor = .secondaryLabelColor
        glyph.font = .systemFont(ofSize: 13)
        name.lineBreakMode = .byTruncatingTail
        name.font = .systemFont(ofSize: 13)
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        name.delegate = self
        prod.font = .systemFont(ofSize: 9.5, weight: .bold)
        prod.textColor = .systemRed
        prod.wantsLayer = true
        prod.layer?.borderColor = NSColor.systemRed.withAlphaComponent(0.7).cgColor
        prod.layer?.borderWidth = 1
        prod.layer?.cornerRadius = 3
        close.action = { [weak self] in self?.onClose?() }
        close.isHidden = true
        segs.distribution = .fillEqually
        segs.spacing = 4
        segs.isHidden = true
        segs.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        segs.setContentHuggingPriority(.init(1), for: .horizontal) // the segments share the row's width
        // Not the cell's textField / imageView: AppKit would recolor them on selection.
        let stack = NSStackView(views: [icon, glyph, name, segs, prod, close, status])
        stack.loosen()
        stack.spacing = 7
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.setHuggingPriority(.defaultLow, for: .horizontal)
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 18),
            segs.heightAnchor.constraint(equalTo: heightAnchor, constant: -4),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    private var tid: String?

    // `pinned` rows unload instead of closing; `incoming` is a session hovering this row to
    // merge, previewed as the segments it would add (`ready` once a drop would merge).
    func configure(tid: String, view v: TabView?, active: Bool, renaming: Bool, pinned: Bool = false, incoming: TabView? = nil, ready: Bool = false, onRename: @escaping (String?) -> Void) {
        self.tid = tid
        guard let v else { return }
        self.onRename = onRename
        let store = Store.shared
        let tint = v.tab.color.map { NSColor(hex: $0) }
        let accent = UI.accent()
        split = v.panes.count + (incoming?.panes.count ?? 0) > 1 && !renaming
        // A split row shows the session's own icon only if it was given one.
        let (img, text) = split ? (v.tab.icon.flatMap { KindIcons.image(kind: ">_", icon: $0).0 }, nil) : KindIcons.image(kind: v.active?.kind ?? ">_", icon: v.tab.icon)
        icon.image = img
        icon.isHidden = img == nil
        glyph.stringValue = text ?? ""
        glyph.isHidden = text == nil
        icon.contentTintColor = tint ?? (active ? accent : nil) ?? .secondaryLabelColor
        name.isHidden = split
        segs.isHidden = !split
        if split {
            let panes = v.panes.map { ($0, false) } + (incoming?.panes.map { ($0, true) } ?? [])
            while segs.arrangedSubviews.count < panes.count { segs.addArrangedSubview(SegmentView()) }
            while segs.arrangedSubviews.count > panes.count { segs.arrangedSubviews.last?.removeFromSuperview() }
            for (seg, (p, isNew)) in zip(segs.arrangedSubviews.compactMap { $0 as? SegmentView }, panes) {
                let dead = !p.rt.alive && store.sessions[p.sid]?.started == true
                seg.configure(p, tid: tid, current: active && p.sid == v.tab.activeSid, incoming: isNew, ready: ready, closable: !isNew && v.panes.count > 1, dead: dead, accent: accent)
            }
        } else if renaming {
            if !name.isEditable {
                name.isEditable = true
                name.isBordered = true
                name.drawsBackground = true
                name.stringValue = v.tab.name ?? v.name
                window?.makeFirstResponder(name)
                name.currentEditor()?.selectAll(nil)
            }
        } else if !name.isEditable {
            name.stringValue = v.name
        }
        name.alphaValue = v.dead ? 0.5 : 1
        icon.alphaValue = v.dead ? 0.5 : 1
        if !name.isEditable { name.font = UI.font(1, active ? .medium : .regular) }
        icon.symbolConfiguration = .init(pointSize: UI.font(1.05).pointSize, weight: .regular)
        glyph.font = UI.font()
        prod.font = UI.font(0.72, .bold)
        toolTip = split ? (v.tab.name ?? v.panes.map(\.name).joined(separator: "  ·  ")) : nil
        name.toolTip = v.name
        prod.isHidden = !v.danger
        // Pinned: − unloads (nothing to unload once it's asleep). Elsewhere ✕ closes.
        close.symbol = pinned ? "minus" : "xmark"
        close.toolTip = pinned ? "Close (stays pinned)" : "Close"
        // A split row has no ✕ of its own: each segment closes its own pane.
        closable = !split && !(pinned && v.panes.allSatisfy { !$0.rt.alive })
        current = v.status
        status.set(v.status, bell: v.bell, accent: .controlAccentColor)
        if v.status == .fail, let f = v.fail, let r = store.rt[f] {
            status.toolTip = "exit \(r.exitCode ?? 1) · failed \(r.endedAt.map { Meta.timeAgo($0) } ?? "") · \(Meta.formatDuration(r.duration))"
        } else {
            status.toolTip = nil
        }
        updateHover()
    }

    private func updateHover() {
        let dragging = SidebarDrag.active
        close.isHidden = !hover || name.isEditable || !closable || dragging
        status.isHidden = !close.isHidden && current != .bell && current != .run
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        tracking = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(tracking!)
    }

    override func mouseEntered(with event: NSEvent) {
        hover = true
        if let tid { Peek.shared.hover(tid, from: self) }
    }

    override func mouseExited(with event: NSEvent) {
        hover = false
        Peek.shared.leave()
    }

    // ⇧-click keeps a peek open.
    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.shift), let tid, Store.shared.activeTabId != tid {
            Peek.shared.togglePin(tid, from: self)
            return
        }
        Peek.shared.leave()
        super.mouseDown(with: event)
    }

    // Rename: Enter saves, Esc cancels, leaving the field saves.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(cancelOperation(_:)) { finish(nil); return true }
        if sel == #selector(insertNewline(_:)) { finish(name.stringValue); return true }
        return false
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        if name.isEditable { finish(name.stringValue) }
    }

    private func finish(_ value: String?) {
        guard name.isEditable else { return }
        name.isEditable = false
        name.isBordered = false
        name.drawsBackground = false
        let cb = onRename
        onRename = nil
        cb?(value)
        updateHover()
    }
}

// One pane of a split row: its kind icon and name in an outlined capsule, filled for the
// pane that has focus. Click focuses that pane, its ✕ closes just that pane, and dragging it
// drags the whole row. A session hovering to merge shows as an extra, tinted segment.
final class SegmentView: NSView {
    private let icon = NSImageView()
    private let glyph = NSTextField(labelWithString: "")
    private let name = NSTextField(labelWithString: "")
    private let close = RowButton(symbol: "xmark", tip: "Close this pane", size: 16)
    private var sid = ""
    private var tid = ""
    private var current = false
    private var incoming = false
    private var ready = false
    private var closable = false
    private var accent = NSColor.controlAccentColor
    private var hover = false { didSet { syncClose() } }
    private var hasIcon = false
    private var hasGlyph = false

    // The ✕ shows under the pointer; the kind icon steps aside for it so the name keeps its room.
    private func syncClose() {
        let show = hover && closable && !SidebarDrag.active
        close.isHidden = !show
        icon.isHidden = !hasIcon || show
        glyph.isHidden = !hasGlyph || show
        needsDisplay = true
    }

    override var wantsUpdateLayer: Bool { true }

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.cornerCurve = .continuous
        icon.imageScaling = .scaleProportionallyDown
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        close.isHidden = true
        let stack = NSStackView(views: [icon, glyph, name, close])
        stack.spacing = 5
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 7),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -3),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 15),
        ])
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ p: TabView.Pane, tid: String, current: Bool, incoming: Bool, ready: Bool, closable: Bool, dead: Bool, accent: NSColor) {
        sid = p.sid
        self.tid = tid
        self.current = current
        self.incoming = incoming
        self.ready = ready
        self.closable = closable
        self.accent = accent
        let (img, text) = KindIcons.image(kind: p.kind, icon: nil)
        icon.image = img
        hasIcon = img != nil
        icon.symbolConfiguration = .init(pointSize: UI.font(0.95).pointSize, weight: .regular)
        icon.contentTintColor = current ? accent : .secondaryLabelColor
        glyph.stringValue = text ?? ""
        hasGlyph = text != nil
        glyph.font = UI.font(0.95)
        name.stringValue = p.name
        name.font = UI.font(0.95, current ? .medium : .regular)
        name.textColor = .labelColor
        alphaValue = dead ? 0.5 : 1
        toolTip = p.name
        close.action = { [sid = p.sid] in Store.shared.closePane(sid) }
        syncClose()
    }

    override func updateLayer() {
        let line = NSColor.labelColor.withAlphaComponent(0.12)
        if incoming {
            layer?.backgroundColor = accent.withAlphaComponent(ready ? 0.20 : 0.13).cgColor
            layer?.borderColor = (ready ? accent : accent.withAlphaComponent(0.38)).cgColor
            layer?.borderWidth = 1
        } else if current {
            layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.11).cgColor
            layer?.borderWidth = 0
        } else {
            layer?.backgroundColor = hover ? NSColor.labelColor.withAlphaComponent(0.06).cgColor : nil
            layer?.borderColor = line.cgColor
            layer?.borderWidth = 1
        }
    }

    override func mouseEntered(with event: NSEvent) { hover = true }
    override func mouseExited(with event: NSEvent) { hover = false }

    // A press may drag the whole row; one that comes up in place focuses this pane.
    override func mouseDown(with event: NSEvent) {
        guard !incoming, event.clickCount == 1, event.modifierFlags.intersection([.shift, .command, .control, .option]).isEmpty else {
            return super.mouseDown(with: event)
        }
        Peek.shared.leave()
        var row: NSView? = superview
        while let r = row, !(r is NSTableRowView) { row = r.superview }
        if SidebarDrag.track(.tab(tid), source: row ?? self, event: event) { return }
        Store.shared.focusSession(sid)
    }
}

// The small square buttons at a row's end (✕ close, − unload): a fixed size so rows never
// shift, with a rounded highlight under the pointer.
final class RowButton: NSView {
    var action: (() -> Void)?
    var symbol: String { didSet { if symbol != oldValue { image.image = NSImage(systemSymbolName: symbol, accessibilityDescription: toolTip) } } }
    private let image = NSImageView()
    private var hover = false { didSet { needsDisplay = true } }
    private var pressed = false { didSet { needsDisplay = true } }

    override var wantsUpdateLayer: Bool { true }

    init(symbol: String, tip: String, size: CGFloat = 20) {
        self.symbol = symbol
        super.init(frame: .zero)
        toolTip = tip
        wantsLayer = true
        layer?.cornerRadius = 5
        image.image = NSImage(systemSymbolName: symbol, accessibilityDescription: tip)
        image.symbolConfiguration = .init(pointSize: size * 0.5, weight: .semibold)
        image.translatesAutoresizingMaskIntoConstraints = false
        addSubview(image)
        translatesAutoresizingMaskIntoConstraints = false
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: size), heightAnchor.constraint(equalToConstant: size),
            image.centerXAnchor.constraint(equalTo: centerXAnchor), image.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }

    required init?(coder: NSCoder) { fatalError() }

    override func updateLayer() {
        layer?.backgroundColor = hover ? NSColor.labelColor.withAlphaComponent(pressed ? 0.18 : 0.1).cgColor : nil
        image.contentTintColor = hover ? .labelColor : .secondaryLabelColor
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseEntered(with event: NSEvent) { hover = true }
    override func mouseExited(with event: NSEvent) { hover = false }
    override func mouseDown(with event: NSEvent) { pressed = true }

    override func mouseUp(with event: NSEvent) {
        pressed = false
        if bounds.contains(convert(event.locationInWindow, from: nil)) { action?() }
    }
}

// "◆ Work            [+folder] [⋯]" and "Today ———— Tidy".
final class SectionHeaderView: NSTableCellView {
    static let id = NSUserInterfaceItemIdentifier("section")
    private let glyph = NSTextField(labelWithString: "")
    private let image = NSImageView() // a Space's own icon, in place of the glyph
    private var imageSize: NSLayoutConstraint!
    private let title = NSTextField(labelWithString: "")
    private let buttons = NSStackView()

    init() {
        super.init(frame: .zero)
        identifier = Self.id
        glyph.font = .systemFont(ofSize: 12)
        title.font = .systemFont(ofSize: 11.5, weight: .semibold)
        title.textColor = .secondaryLabelColor
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        buttons.spacing = 2
        buttons.alphaValue = 0
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        image.imageScaling = .scaleProportionallyUpOrDown
        image.wantsLayer = true
        image.layer?.masksToBounds = true
        image.isHidden = true
        imageSize = image.widthAnchor.constraint(equalToConstant: 16)
        NSLayoutConstraint.activate([imageSize, image.heightAnchor.constraint(equalTo: image.widthAnchor)])
        let stack = NSStackView(views: [glyph, image, title, spacer, buttons])
        stack.loosen()
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    // The header's buttons show on hover, as in the web build.
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { buttons.animator().alphaValue = 1 }
    override func mouseExited(with event: NSEvent) { buttons.animator().alphaValue = 0 }

    private var actions: [() -> Void] = []

    func configure(title t: String, glyph g: String?, icon: NSImage? = nil, color: NSColor?, actions acts: [(String, String, () -> Void)]) {
        title.stringValue = t
        title.font = UI.font(0.92, .semibold)
        glyph.font = UI.font(1.05)
        glyph.stringValue = g ?? ""
        glyph.isHidden = g == nil || icon != nil
        glyph.textColor = color
        image.image = icon
        image.isHidden = icon == nil
        imageSize.constant = (UI.font(1.05).pointSize * 1.3).rounded()
        image.layer?.cornerRadius = (imageSize.constant * 0.24).rounded()
        buttons.arrangedSubviews.forEach { $0.removeFromSuperview() }
        actions = acts.map(\.2)
        for (i, a) in acts.enumerated() {
            let b = NSButton(image: NSImage(systemSymbolName: a.0, accessibilityDescription: a.1)!, target: self, action: #selector(tap(_:)))
            b.isBordered = false
            b.symbolConfiguration = .init(pointSize: UI.font(0.95).pointSize, weight: .regular)
            b.contentTintColor = .secondaryLabelColor
            b.toolTip = a.1
            b.tag = i
            buttons.addArrangedSubview(b)
        }
    }

    @objc private func tap(_ b: NSButton) { actions[b.tag]() }
}

final class FolderRowView: NSTableCellView, NSTextFieldDelegate {
    static let id = NSUserInterfaceItemIdentifier("folder")
    private let chevron = NSImageView()
    private let icon = NSImageView()
    private let name = NSTextField(labelWithString: "")
    private let count = NSTextField(labelWithString: "")
    private let run = NSProgressIndicator()
    private let add = NSButton()
    private var onRename: ((String?) -> Void)?
    var onAdd: (() -> Void)?

    init() {
        super.init(frame: .zero)
        identifier = Self.id
        chevron.symbolConfiguration = .init(pointSize: 9, weight: .semibold)
        chevron.contentTintColor = .tertiaryLabelColor
        icon.symbolConfiguration = .init(pointSize: 13, weight: .regular)
        icon.contentTintColor = .secondaryLabelColor
        name.font = .systemFont(ofSize: 13)
        name.lineBreakMode = .byTruncatingTail
        name.delegate = self
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        count.font = .systemFont(ofSize: 11)
        count.textColor = .tertiaryLabelColor
        run.style = .spinning
        run.controlSize = .mini
        add.image = NSImage(systemSymbolName: "plus", accessibilityDescription: "New terminal in folder")
        add.isBordered = false
        add.symbolConfiguration = .init(pointSize: 10, weight: .semibold)
        add.contentTintColor = .secondaryLabelColor
        add.toolTip = "New terminal in folder"
        add.target = self
        add.action = #selector(addClicked)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let stack = NSStackView(views: [chevron, icon, name, spacer, run, count, add])
        stack.loosen()
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        textField = name
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            chevron.widthAnchor.constraint(equalToConstant: 10),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(name n: String, open: Bool, count c: Int, running: Bool, renaming: Bool, onRename: @escaping (String?) -> Void) {
        self.onRename = onRename
        name.font = UI.font()
        count.font = UI.font(0.85)
        icon.symbolConfiguration = .init(pointSize: UI.font(1.05).pointSize, weight: .regular)
        chevron.image = NSImage(systemSymbolName: open ? "chevron.down" : "chevron.right", accessibilityDescription: nil)
        icon.image = NSImage(systemSymbolName: open ? "folder" : "folder.fill", accessibilityDescription: nil)
        count.stringValue = open ? "" : "\(c)"
        run.isHidden = open || !running
        if running && !open { run.startAnimation(nil) } else { run.stopAnimation(nil) }
        if renaming, !name.isEditable {
            name.isEditable = true
            name.isBordered = true
            name.drawsBackground = true
            name.stringValue = n
            DispatchQueue.main.async { [self] in
                window?.makeFirstResponder(name)
                name.currentEditor()?.selectAll(nil)
            }
        } else if !name.isEditable {
            name.stringValue = n
        }
    }

    @objc private func addClicked() { onAdd?() }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(cancelOperation(_:)) { finish(nil); return true }
        if sel == #selector(insertNewline(_:)) { finish(name.stringValue); return true }
        return false
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        if name.isEditable { finish(name.stringValue) }
    }

    private func finish(_ v: String?) {
        guard name.isEditable else { return }
        name.isEditable = false
        name.isBordered = false
        name.drawsBackground = false
        let cb = onRename
        onRename = nil
        cb?(v)
    }
}

// "+ New Terminal ⌘N", the Settings row and the empty-state hints.
final class PlainRowView: NSTableCellView {
    static let id = NSUserInterfaceItemIdentifier("plain")
    private let icon = NSImageView()
    private let text = NSTextField(labelWithString: "")
    private let detail = NSTextField(labelWithString: "")

    init() {
        super.init(frame: .zero)
        identifier = Self.id
        icon.symbolConfiguration = .init(pointSize: 12, weight: .regular)
        icon.contentTintColor = .secondaryLabelColor
        text.font = .systemFont(ofSize: 13)
        text.lineBreakMode = .byTruncatingTail
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detail.font = .systemFont(ofSize: 11)
        detail.textColor = .tertiaryLabelColor
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let stack = NSStackView(views: [icon, text, spacer, detail])
        stack.loosen()
        stack.spacing = 7
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 18),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    private let dashBox = CAShapeLayer()

    func configure(symbol: String?, text t: String, detail d: String?, dim: Bool, dashed: Bool = false) {
        icon.image = symbol.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil) }
        icon.isHidden = symbol == nil
        icon.symbolConfiguration = .init(pointSize: UI.font(0.95).pointSize, weight: .regular)
        text.stringValue = t
        text.textColor = dim ? .secondaryLabelColor : .secondaryLabelColor
        text.font = dim ? UI.font(0.92) : UI.font()
        text.alignment = dashed ? .center : .natural
        text.maximumNumberOfLines = dashed ? 2 : 1
        text.lineBreakMode = dashed ? .byWordWrapping : .byTruncatingTail
        detail.font = UI.font(0.88)
        detail.stringValue = d ?? ""
        detail.isHidden = d == nil
        // The empty Pinned section: a dashed drop target.
        wantsLayer = true
        if dashed {
            dashBox.strokeColor = NSColor.separatorColor.cgColor
            dashBox.fillColor = nil
            dashBox.lineDashPattern = [4, 3]
            dashBox.lineWidth = 1
            if dashBox.superlayer == nil { layer?.addSublayer(dashBox) }
        } else {
            dashBox.removeFromSuperlayer()
        }
        needsLayout = true
    }

    override func layout() {
        super.layout()
        dashBox.frame = bounds
        dashBox.path = CGPath(roundedRect: bounds.insetBy(dx: 4, dy: 3), cornerWidth: 9, cornerHeight: 9, transform: nil)
    }
}
