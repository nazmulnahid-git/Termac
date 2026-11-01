import AppKit
import SwiftTerm
import TermorcCore

// Peek: hover a sidebar row for 400 ms to see its last lines streaming live. ⇧-click keeps
// the peek open; it closes when the pointer leaves the sidebar unless pinned.
@MainActor
final class Peek: NSObject, NSPopoverDelegate {
    static let shared = Peek()
    private var timer: Timer?
    private var refresh: Timer?
    private var popover: NSPopover?
    private(set) var tid: String?
    private(set) var pinned = false
    private let text = NSTextField(labelWithString: "")
    private let title = NSTextField(labelWithString: "")

    func hover(_ tid: String, from view: NSView) {
        let store = Store.shared
        timer?.invalidate()
        guard store.model.settings.gestures.peek, store.ui.overlay == nil, store.activeTabId != tid else { return }
        if popover?.isShown == true {
            show(tid, from: view, pinned: pinned)
            return
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self, weak view] _ in
            MainActor.assumeIsolated {
                guard let self, let view, view.window != nil, Store.shared.activeTabId != tid else { return }
                self.show(tid, from: view, pinned: false)
            }
        }
    }

    func leave() {
        timer?.invalidate()
    }

    func leftSidebar() {
        timer?.invalidate()
        if !pinned { close() }
    }

    func togglePin(_ tid: String, from view: NSView) {
        if pinned, self.tid == tid { close() } else { show(tid, from: view, pinned: true) }
    }

    private func show(_ tid: String, from view: NSView, pinned: Bool) {
        self.tid = tid
        self.pinned = pinned
        let p = popover ?? makePopover()
        popover = p
        update()
        if p.isShown { p.positioningRect = view.bounds; p.contentViewController?.view.needsLayout = true }
        p.show(relativeTo: view.bounds, of: view, preferredEdge: .maxX)
        refresh?.invalidate()
        refresh = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.update() } }
    }

    func close() {
        refresh?.invalidate()
        refresh = nil
        popover?.close()
        tid = nil
        pinned = false
    }

    func popoverDidClose(_ notification: Notification) {
        refresh?.invalidate()
        tid = nil
        pinned = false
    }

    private func makePopover() -> NSPopover {
        let p = NSPopover()
        p.behavior = .semitransient
        p.animates = true
        p.delegate = self
        let vc = NSViewController()
        let root = NSView()
        title.font = .systemFont(ofSize: 12, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        text.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        text.maximumNumberOfLines = 0
        text.lineBreakMode = .byClipping
        text.wantsLayer = true
        text.layer?.cornerRadius = 6
        for v in [title, text] {
            v.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(v)
        }
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: root.topAnchor, constant: 10), title.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            title.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            text.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8), text.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            text.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12), text.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),
            root.widthAnchor.constraint(equalToConstant: 460),
        ])
        vc.view = root
        p.contentViewController = vc
        return p
    }

    // The session's last 12 non-empty lines, colored like the terminal.
    private func update() {
        let store = Store.shared
        guard let tid, let tab = store.model.tabs[tid], let v = TabView.make(tid) else { close(); return }
        title.stringValue = v.name + (v.status == .run ? "  ·  running" : "")
        let sid = tab.activeSid
        let session = store.termSession(sid)
        let look = store.look(for: store.space(store.spaceForTab(tid)))
        let rows = session.tail(12)
        let out = NSMutableAttributedString()
        let base = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        let bold = NSFont.monospacedSystemFont(ofSize: 11, weight: .bold)
        for (i, row) in rows.enumerated() {
            for cell in row.cells where cell.width > 0 {
                let a = cell.attribute
                var fg = NSColor(hex: look.palette.foreground)
                switch a.fg {
                case .ansi256(let c): fg = Self.color(Int(c), look.palette)
                case let .trueColor(r, g, b): fg = NSColor(srgbRed: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
                default: break
                }
                if a.style.contains(.dim) { fg = fg.withAlphaComponent(0.6) }
                out.append(NSAttributedString(string: cell.text.isEmpty ? " " : cell.text, attributes: [.foregroundColor: fg, .font: a.style.contains(.bold) ? bold : base]))
            }
            if i < rows.count - 1 { out.append(NSAttributedString(string: "\n")) }
        }
        if rows.isEmpty { out.append(NSAttributedString(string: session.started ? "No output yet" : "Not started yet — click to open", attributes: [.foregroundColor: NSColor.secondaryLabelColor, .font: base])) }
        text.attributedStringValue = out
        text.backgroundColor = NSColor(hex: look.bg)
        text.drawsBackground = true
    }

    static func color(_ v: Int, _ p: Palette) -> NSColor {
        if v < 16 { return NSColor(hex: p.ansi[v]) }
        if v >= 232 {
            let g = CGFloat(8 + (v - 232) * 10) / 255
            return NSColor(srgbRed: g, green: g, blue: g, alpha: 1)
        }
        let i = v - 16
        func c(_ x: Int) -> CGFloat { x == 0 ? 0 : CGFloat(55 + x * 40) / 255 }
        return NSColor(srgbRed: c(i / 36), green: c((i / 6) % 6), blue: c(i % 6), alpha: 1)
    }
}
