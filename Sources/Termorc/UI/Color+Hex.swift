import AppKit
import SwiftTerm
import TermorcCore

extension NSColor {
    convenience init(hex: String, alpha: CGFloat = 1) {
        let (r, g, b) = TermTheme.parseHex(hex)
        self.init(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: alpha)
    }
}

extension SwiftTerm.Color {
    convenience init(hex: String) {
        let (r, g, b) = TermTheme.parseHex(hex)
        self.init(red: UInt16(r) * 257, green: UInt16(g) * 257, blue: UInt16(b) * 257)
    }
}

extension NSStackView {
    // Stack views hug at 750 by default, above the window's "stay put" priority (500); one
    // pinned edge to edge would shrink the window to its fitting size.
    func loosen() {
        setHuggingPriority(.defaultLow, for: .horizontal)
        setHuggingPriority(.defaultLow, for: .vertical)
    }
}
