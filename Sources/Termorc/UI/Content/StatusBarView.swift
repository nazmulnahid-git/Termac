import AppKit
import TermorcCore

// The window's bottom bar, as in Finder or Xcode: the Spaces as tabs (a dot marks one with
// unseen finished jobs) and a button for a new one. Dropping a session on a Space moves it there.
@MainActor
final class StatusBarView: NSView {
    let store = Store.shared
    private let stack = NSStackView()
    private var key = ""

    override init(frame: NSRect) {
        super.init(frame: frame)
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8), stack.centerYAnchor.constraint(equalTo: centerYAnchor), stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8)])
    }

    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.separatorColor.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
    }

    func update() {
        let unseen = Set(store.model.activity.filter { !$0.seen }.map(\.spaceId))
        let k = "\(UI.scale)" + store.model.spaces.map { "\($0.id)\($0.name)\($0.glyph)\($0.iconImage?.count ?? 0)\($0.color)\(unseen.contains($0.id))" }.joined() + store.model.activeSpaceId
        guard k != key else { return }
        key = k
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (i, sp) in store.model.spaces.enumerated() {
            let b = SpaceTab(space: sp, active: sp.id == store.model.activeSpaceId, flag: sp.id != store.model.activeSpaceId && unseen.contains(sp.id))
            b.toolTip = "\(sp.name)  ⌃\(i + 1)"
            stack.addArrangedSubview(b)
        }
        let add = NSButton(image: NSImage(systemSymbolName: "plus", accessibilityDescription: "New Space")!, target: self, action: #selector(newSpace))
        add.isBordered = false
        add.symbolConfiguration = .init(pointSize: 11, weight: .medium)
        add.contentTintColor = .secondaryLabelColor
        add.toolTip = "New Space"
        stack.addArrangedSubview(add)
    }

    @objc private func newSpace() { store.ui.overlay = .spaceEditor(nil) }
}

@MainActor
final class SpaceTab: NSView {
    let spaceId: String
    private let active: Bool
    private var hot = false { didSet { needsDisplay = true } }
    private var hover = false { didSet { needsDisplay = true } }
    private let color: NSColor

    init(space: Space, active: Bool, flag: Bool) {
        spaceId = space.id
        self.active = active
        color = NSColor(hex: space.color)
        super.init(frame: .zero)
        let g = SpaceIcon.view(space, size: UI.font(1).pointSize, color: color)
        let t = NSTextField(labelWithString: space.name)
        t.font = UI.font(0.95, active ? .medium : .regular)
        t.textColor = active ? .labelColor : .secondaryLabelColor
        var views: [NSView] = [g, t]
        if flag {
            let dot = NSView()
            dot.wantsLayer = true
            dot.layer?.backgroundColor = NSColor.systemOrange.cgColor
            dot.layer?.cornerRadius = 3
            dot.widthAnchor.constraint(equalToConstant: 6).isActive = true
            dot.heightAnchor.constraint(equalToConstant: 6).isActive = true
            views.append(dot)
        }
        let stack = NSStackView(views: views)
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 9), stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -9), stack.centerYAnchor.constraint(equalTo: centerYAnchor), heightAnchor.constraint(equalToConstant: UI.px(24))])
        registerForDraggedTypes([.termorcTab])
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }

    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2)
        if hot {
            color.withAlphaComponent(0.24).setFill()
            path.fill()
            color.setStroke()
            path.stroke()
        } else if active {
            NSColor.labelColor.withAlphaComponent(0.09).setFill()
            path.fill()
        } else if hover {
            NSColor.labelColor.withAlphaComponent(0.05).setFill()
            path.fill()
        }
    }

    override func mouseEntered(with event: NSEvent) { hover = true }
    override func mouseExited(with event: NSEvent) { hover = false }

    override func mouseUp(with event: NSEvent) {
        if event.clickCount == 2 { Store.shared.ui.overlay = .spaceEditor(spaceId) }
        else { Store.shared.switchSpace(spaceId) }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        hot = true
        return .move
    }

    override func draggingExited(_ sender: NSDraggingInfo?) { hot = false }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        hot = false
        guard let tid = sender.draggingPasteboard.string(forType: .termorcTab) else { return false }
        let store = Store.shared
        store.moveTab(tid, to: Dest(section: store.locate(tid)?.section == .pinned ? .pinned : .today, spaceId: spaceId))
        return true
    }
}
