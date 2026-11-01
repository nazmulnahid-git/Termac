import AppKit
import TermorcCore

// Sizes and colors shared by Termorc's own views (sidebar rows, panes, the input bar, the
// command bar). Like the web build, the Zoom setting scales the interface text and the
// terminals together; native chrome (toolbar, menus, sheets) keeps the system's sizes.
@MainActor
enum UI {
    static var settings: Settings { Store.shared.model.settings }
    static var scale: CGFloat { CGFloat(settings.zoomLevel) / 100 }

    // `em` is relative to the interface font size (12.5 by default).
    static func font(_ em: CGFloat = 1, _ weight: NSFont.Weight = .regular) -> NSFont {
        .systemFont(ofSize: (CGFloat(settings.uiFontSize) * em * scale).rounded(.toNearestOrEven), weight: weight)
    }

    static func px(_ v: CGFloat) -> CGFloat { (v * scale).rounded() }

    static var termFontSize: Double { settings.fontSize * Double(scale) }

    static func mono(_ size: Double? = nil) -> NSFont {
        Fonts.mono(settings.fontFamily, size: size ?? termFontSize, weight: settings.fontWeight)
    }

    // The Space color as an accent, lifted toward white on dark and toward black on light.
    static func accent(dark: Bool = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua) -> NSColor {
        let c = Store.shared.activeSpace.color
        return NSColor(hex: dark ? TermTheme.mix(c, "#ffffff", 0.12) : TermTheme.mix(c, "#000000", 0.08))
    }
}

// A key cap: "⌘T", "⇥", "⏎" in a small rounded box.
final class KeyCap: NSView {
    private let label = NSTextField(labelWithString: "")

    init(_ text: String, font: NSFont, fg: NSColor, fill: NSColor, stroke: NSColor) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 4
        layer?.backgroundColor = fill.cgColor
        layer?.borderColor = stroke.cgColor
        layer?.borderWidth = 1
        label.stringValue = text
        label.font = font
        label.textColor = fg
        label.alignment = .center
        label.setContentCompressionResistancePriority(.required, for: .horizontal) // a key cap never squeezes
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor), label.centerYAnchor.constraint(equalTo: centerYAnchor),
            widthAnchor.constraint(greaterThanOrEqualTo: label.widthAnchor, constant: 8),
            widthAnchor.constraint(greaterThanOrEqualTo: heightAnchor),
            {
                // As narrow as the text allows; stack views must not stretch a key cap.
                let c = widthAnchor.constraint(equalTo: label.widthAnchor, constant: 8)
                c.priority = .init(749)
                return c
            }(),
            heightAnchor.constraint(equalToConstant: (font.pointSize * 1.45).rounded()),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }
}

// "⏎ run   ⇧⏎ new line …": key caps followed by quiet labels.
@MainActor
func keyHints(_ items: [(String, String)], font: NSFont, fg: NSColor, dim: NSColor, fill: NSColor, stroke: NSColor) -> [NSView] {
    items.map { key, text in
        let l = NSTextField(labelWithString: text)
        l.font = font
        l.textColor = dim
        // Whole or not at all: a stack that runs short drops hints rather than squeezing them.
        l.setContentCompressionResistancePriority(.required, for: .horizontal)
        let s = NSStackView(views: [KeyCap(key, font: font, fg: fg, fill: fill, stroke: stroke), l])
        s.spacing = 5
        s.setContentCompressionResistancePriority(.required, for: .horizontal)
        return s
    }
}

// A Space's icon: its glyph in its color, or the image it was given (stored as a PNG data URL,
// like the web build).
@MainActor
enum SpaceIcon {
    private static var cache: [String: NSImage] = [:]

    static func image(_ space: Space) -> NSImage? {
        guard let s = space.iconImage else { return nil }
        if let i = cache[s] { return i }
        guard let comma = s.firstIndex(of: ","), let data = Data(base64Encoded: String(s[s.index(after: comma)...])), let img = NSImage(data: data) else { return nil }
        cache[s] = img
        return img
    }

    // The glyph as a label, or the image in a rounded square `size` points wide.
    static func view(_ space: Space, size: CGFloat, color: NSColor? = nil) -> NSView {
        guard let img = image(space) else {
            let g = NSTextField(labelWithString: space.glyph)
            g.textColor = color ?? NSColor(hex: space.color)
            g.font = .systemFont(ofSize: size)
            return g
        }
        let v = NSImageView(image: img)
        v.imageScaling = .scaleProportionallyUpOrDown
        v.wantsLayer = true
        v.layer?.cornerRadius = (size * 0.24).rounded()
        v.layer?.masksToBounds = true
        v.translatesAutoresizingMaskIntoConstraints = false
        v.setContentHuggingPriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([v.widthAnchor.constraint(equalToConstant: size + 2), v.heightAnchor.constraint(equalToConstant: size + 2)])
        return v
    }

    // For menu items: the image at menu size, or nil (the title then carries the glyph).
    static func menuImage(_ space: Space) -> NSImage? {
        guard let img = image(space) else { return nil }
        let side: CGFloat = 16
        return NSImage(size: NSSize(width: side, height: side), flipped: false) { r in
            NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4).addClip()
            img.draw(in: r)
            return true
        }
    }

    static func menuTitle(_ space: Space) -> String { image(space) == nil ? "\(space.glyph)  \(space.name)" : space.name }
}
