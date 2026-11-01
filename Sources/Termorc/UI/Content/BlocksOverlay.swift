import AppKit
import TermorcCore

// Command blocks over a terminal (sessions with Termorc's own prompt): the line each
// command was typed on gets a hairline above it and a faint band, and once it finishes its
// duration and status in a small tab hanging from that hairline on the right. A failed
// block gets a red edge and a red wash fading out across its output. Restored history ends
// in a "Restored · time" divider. The overlay reaches `inset` points left of the text, so
// bands start in the pane's margin.
final class BlocksOverlay: NSView {
    weak var session: TermSession?
    var look: TerminalLook? { didSet { needsDisplay = true } }
    var inset: CGFloat = 12

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        MainActor.assumeIsolated { drawBlocks() }
    }

    @MainActor
    private func drawBlocks() {
        guard let s = session, let look, !s.altScreen, let dims = s.view.terminalInputStateSnapshot()?.dimensions, dims.rows > 0, let top = s.viewportTop()?.row else { return }
        let cellH = bounds.height / CGFloat(dims.rows)
        let p = look.palette
        let fg = NSColor(hex: p.foreground)
        let line = fg.withAlphaComponent(0.08)
        let rows = top..<(top + dims.rows)
        func y(_ row: Int) -> CGFloat { CGFloat(row - top) * cellH }
        let metaFont = NSFont.monospacedDigitSystemFont(ofSize: UI.px(11), weight: .regular)

        for e in s.cmds where e.decorated || e.restored {
            guard let head = e.head else { continue }
            if let end = e.end, (e.exit ?? 0) != 0, e.exit != 130 {
                let from = max(head, top), to = min(max(end, head + 1), rows.upperBound)
                if from < to {
                    let r = NSRect(x: 0, y: y(from), width: bounds.width, height: CGFloat(to - from) * cellH)
                    let red = NSColor(hex: p.red)
                    NSGradient(colors: [red.withAlphaComponent(0.10), red.withAlphaComponent(0)], atLocations: [0, 0.4], colorSpace: .sRGB)?.draw(in: r, angle: 0)
                    red.setFill()
                    NSRect(x: 0, y: r.minY, width: 2, height: r.height).fill()
                }
            }
            guard rows.contains(head) else { continue }
            let band = NSRect(x: 0, y: y(head), width: bounds.width, height: cellH)
            NSColor(hex: TermTheme.mix(look.bg, p.foreground, 0.055)).setFill()
            band.fill(using: .sourceOver)
            line.setFill()
            NSRect(x: 0, y: band.minY, width: bounds.width, height: 1).fill()

            let (text, color) = Self.meta(e, look)
            let attrs: [NSAttributedString.Key: Any] = [.font: metaFont, .foregroundColor: color]
            let size = (text as NSString).size(withAttributes: attrs)
            let tab = NSRect(x: bounds.width - size.width - UI.px(16) - 8, y: band.minY + 1, width: size.width + UI.px(16), height: min(cellH - 1, size.height + 4))
            let path = NSBezierPath()
            let r: CGFloat = 6
            path.move(to: NSPoint(x: tab.minX, y: tab.minY))
            path.line(to: NSPoint(x: tab.maxX, y: tab.minY))
            path.line(to: NSPoint(x: tab.maxX, y: tab.maxY - r))
            path.appendArc(withCenter: NSPoint(x: tab.maxX - r, y: tab.maxY - r), radius: r, startAngle: 0, endAngle: 90)
            path.line(to: NSPoint(x: tab.minX + r, y: tab.maxY))
            path.appendArc(withCenter: NSPoint(x: tab.minX + r, y: tab.maxY - r), radius: r, startAngle: 90, endAngle: 180)
            path.close()
            NSColor(hex: look.raise).setFill()
            path.fill()
            (text as NSString).draw(at: NSPoint(x: tab.minX + UI.px(8), y: tab.midY - size.height / 2), withAttributes: attrs)
        }

        for d in s.dividers where rows.contains(d.row) {
            let label = "Restored · \(Self.stamp(d.at))"
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: UI.px(11)), .foregroundColor: NSColor(hex: p.brightBlack)]
            let size = (label as NSString).size(withAttributes: attrs)
            let mid = y(d.row) + cellH / 2
            line.setFill()
            NSRect(x: 12, y: mid, width: max(0, bounds.midX - size.width / 2 - 22), height: 1).fill()
            NSRect(x: bounds.midX + size.width / 2 + 10, y: mid, width: max(0, bounds.width - bounds.midX - size.width / 2 - 22), height: 1).fill()
            (label as NSString).draw(at: NSPoint(x: bounds.midX - size.width / 2, y: mid - size.height / 2), withAttributes: attrs)
        }
    }

    // Running blocks show when they started; finished ones how long they took and how it went.
    static func meta(_ e: TermSession.Command, _ look: TerminalLook) -> (String, NSColor) {
        let p = look.palette
        let dim = NSColor(hex: p.brightBlack)
        guard let exit = e.exit else { return ("started \(Meta.clockTime(e.at))", dim) }
        let dur: String = {
            guard let d = e.dur else { return "" }
            if d < 1000 { return "\(d)ms" }
            if d < 60000 { return String(format: "%.1fs", Double(d) / 1000) }
            return "\(d / 60000)m \(Int((Double(d % 60000) / 1000).rounded()))s"
        }()
        let status = exit == 0 ? "✓" : exit == 130 ? "⌃C" : "✗ \(exit)"
        let color = exit == 0 ? NSColor(hex: TermTheme.mix(p.green, p.brightBlack, 0.2)) : exit == 130 ? dim : NSColor(hex: p.red)
        return ([dur, status].filter { !$0.isEmpty }.joined(separator: "  "), color)
    }

    static func stamp(_ ts: Millis) -> String {
        let d = Date(timeIntervalSince1970: Double(ts) / 1000)
        if Calendar.current.isDateInToday(d) { return Meta.clockTime(ts) }
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return "\(f.string(from: d)), \(Meta.clockTime(ts))"
    }
}
