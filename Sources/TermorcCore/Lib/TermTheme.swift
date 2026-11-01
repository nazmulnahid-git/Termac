import Foundation

// Per-Space terminal look: background color (preset, custom or tinted with the Space color)
// or an image with dim/blur. Text colors follow the background's lightness.
public struct Palette: Equatable, Sendable {
    public var background: String
    public var foreground: String
    public var cursor: String
    public var selection: (hex: String, alpha: Double)
    public var ansi: [String] // 16 colors: black…white, then the bright ones

    public static func == (l: Palette, r: Palette) -> Bool {
        l.background == r.background && l.foreground == r.foreground && l.ansi == r.ansi
    }

    public var black: String { ansi[0] }
    public var red: String { ansi[1] }
    public var green: String { ansi[2] }
    public var yellow: String { ansi[3] }
    public var blue: String { ansi[4] }
    public var magenta: String { ansi[5] }
    public var cyan: String { ansi[6] }
    public var brightBlack: String { ansi[8] }
}

public enum TermTheme {
    public static let dark = Palette(
        background: "#1d1d1d", // the window's own dark background, so terminal and chrome read as one surface
        foreground: "#d8dae0",
        cursor: "#d8dae0",
        selection: ("#88adff", 0.28),
        ansi: ["#2a2c33", "#ff8080", "#80d49b", "#ecc576", "#88adff", "#c8a0f5", "#7dd3d3", "#d8dae0",
               "#7f8392", "#ff9e9e", "#9de3b3", "#f3d595", "#a6c2ff", "#d8bbf8", "#9ee2e2", "#ffffff"]
    )

    public static let light = Palette(
        background: "#fcfcfa",
        foreground: "#2b2d33",
        cursor: "#2b2d33",
        selection: ("#2b5bc7", 0.18),
        ansi: ["#2b2d33", "#c93535", "#1b8048", "#93650a", "#2b5bc7", "#7f42c4", "#10767f", "#c9cac4",
               "#80838c", "#de4a4a", "#239a58", "#b07c10", "#3d6fe0", "#9455d8", "#178c96", "#111216"]
    )

    public static func palette(_ name: String) -> Palette { name == "light" ? light : dark }

    public struct Preset: Sendable {
        public let id: String
        public let name: String
        public let bg: String? // nil = follow the app's terminal theme; "tint" = Space color
    }

    public static let presets: [Preset] = [
        .init(id: "default", name: "Default", bg: nil),
        .init(id: "tint", name: "Space tint", bg: "tint"),
        .init(id: "graphite", name: "Graphite", bg: "#17181d"),
        .init(id: "midnight", name: "Midnight", bg: "#0f1726"),
        .init(id: "deepsea", name: "Deep Sea", bg: "#0c1e24"),
        .init(id: "forest", name: "Forest", bg: "#111e17"),
        .init(id: "plum", name: "Plum", bg: "#1c1424"),
        .init(id: "espresso", name: "Espresso", bg: "#1f1915"),
        .init(id: "paper", name: "Paper", bg: "#fcfcfa"),
        .init(id: "sand", name: "Sand", bg: "#f5efe3"),
        .init(id: "mist", name: "Mist", bg: "#eef2f6"),
    ]

    public static func parseHex(_ hex: String) -> (Double, Double, Double) {
        var h = hex.replacingOccurrences(of: "#", with: "")
        if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
        h = String((h + "000000").prefix(6))
        guard let n = Int(h, radix: 16) else { return (0, 0, 0) }
        return (Double((n >> 16) & 255), Double((n >> 8) & 255), Double(n & 255))
    }

    public static func toHex(_ c: (Double, Double, Double)) -> String {
        func p(_ v: Double) -> String { String(format: "%02x", Int(min(255, max(0, v)).rounded())) }
        return "#" + p(c.0) + p(c.1) + p(c.2)
    }

    public static func mix(_ a: String, _ b: String, _ t: Double) -> String {
        let x = parseHex(a), y = parseHex(b)
        return toHex((x.0 + (y.0 - x.0) * t, x.1 + (y.1 - x.1) * t, x.2 + (y.2 - x.2) * t))
    }

    // WCAG relative luminance.
    public static func luminance(_ hex: String) -> Double {
        let (r, g, b) = parseHex(hex)
        func c(_ v: Double) -> Double {
            let x = v / 255
            return x <= 0.03928 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)
    }

    public static func isDark(_ hex: String) -> Bool { luminance(hex) < 0.22 }

    public static func resolveBg(_ look: Look, spaceColor: String, fallbackTheme: String) -> String {
        if look.bg == "tint" { return mix(spaceColor, "#121318", 0.84) }
        if let bg = look.bg, !bg.isEmpty { return bg }
        return palette(fallbackTheme).background
    }
}

// Everything a card needs to paint one Space's terminals.
public struct TerminalLook: Equatable, Sendable {
    public var bg: String
    public var dark: Bool
    public var palette: Palette
    public var image: String?
    public var dim: Double
    public var blur: Double
    public var accent: String // the brand mint (build/icon.svg) for highlights

    public init(space: Space?, fallbackTheme: String) {
        let look = space?.term ?? Look()
        bg = TermTheme.resolveBg(look, spaceColor: space?.color ?? "#3b82f6", fallbackTheme: fallbackTheme)
        dark = TermTheme.isDark(bg)
        var base = dark ? TermTheme.dark : TermTheme.light
        base.background = bg
        palette = base
        image = look.image
        dim = look.dim
        blur = look.blur
        accent = dark ? "#a2f1c8" : "#0e8a5c"
    }

    // A raised surface a step from the background (block bands, the input bar).
    public var raise: String { TermTheme.mix(bg, palette.foreground, dark ? 0.06 : 0.045) }
}
