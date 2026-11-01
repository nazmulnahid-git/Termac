import AppKit
import SwiftUI
import TermorcCore
import WidgetKit

// Termorc's desktop widgets: Localhost, System and Pull Requests, the native versions of the
// Übersicht widgets. WidgetKit runs this extension sandboxed, so Termorc collects the data
// (Sources/Termorc/Widgets/WidgetFeed.swift) and this side reads it back and draws it.
// `scripts/build-app.sh` wraps it in Termorc.app/Contents/PlugIns/TermorcWidgets.appex.
@main
struct TermorcWidgets: WidgetBundle {
    var body: some Widget {
        SystemWidget()
        LocalhostWidget()
        PullsWidget()
    }
}

// ---- Look -----------------------------------------------------------------------------------

// Apple's widget palette, light and dark.
struct Palette {
    let bg, fg, fg2, fg3, sep, fill, tile, seg: Color

    init(_ scheme: ColorScheme) {
        if scheme == .dark {
            bg = Color(hex: 0x101010)
            fg = .white
            fg2 = Color(hex: 0xEBEBF5, opacity: 0.6)
            fg3 = Color(hex: 0xEBEBF5, opacity: 0.3)
            sep = Color(hex: 0x545458, opacity: 0.6)
            fill = Color(hex: 0x767680, opacity: 0.24)
            tile = Color(hex: 0x2C2C2E)
            seg = Color(hex: 0x636366)
        } else {
            bg = .white
            fg = .black
            fg2 = Color(hex: 0x3C3C43, opacity: 0.6)
            fg3 = Color(hex: 0x3C3C43, opacity: 0.3)
            sep = Color(hex: 0x3C3C43, opacity: 0.29)
            fill = Color(hex: 0x767680, opacity: 0.12)
            tile = Color(hex: 0xE5E5EA)
            seg = .white
        }
    }

    static let blue = Color(hex: 0x0A84FF)
    static let green = Color(hex: 0x30D158)
    static let orange = Color(hex: 0xFF9F0A)
    static let purple = Color(hex: 0xBF5AF2)
    static let red = Color(hex: 0xFF453A)
    static let yellow = Color(hex: 0xFFD60A)
    static let gray = Color(hex: 0x8E8E93)
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }
}

extension Font {
    static func rounded(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font { .system(size: size, weight: weight, design: .rounded) }
}

// The widget's own background, edge to edge; each widget pads its content itself.
struct Card<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    @ViewBuilder let content: Content

    var body: some View {
        let p = Palette(scheme)
        content
            .foregroundStyle(p.fg)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .containerBackground(for: .widget) { p.bg }
    }
}

// Every title glyph sits in the same 22pt square.
struct HeadIcon: View {
    let image: Image

    var body: some View {
        image.resizable().aspectRatio(contentMode: .fit).frame(maxWidth: 22, maxHeight: 19).frame(width: 22, height: 22)
    }
}

struct HeadTitle: View {
    let text: String

    var body: some View {
        Text(text).font(.system(size: 15, weight: .semibold)).tracking(-0.2).lineLimit(1)
    }
}

struct EmptyState: View {
    @Environment(\.colorScheme) private var scheme
    var symbol: AnyView?
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 4) {
            if let symbol { symbol.padding(.bottom, 2) }
            Text(title).font(.system(size: 13, weight: .semibold))
            Text(detail).font(.system(size: 11)).foregroundStyle(Palette(scheme).fg2).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// A hairline above every row but the first, starting at the row's text.
struct RowSeparator: View {
    @Environment(\.colorScheme) private var scheme
    let inset: CGFloat

    var body: some View {
        Rectangle().fill(Palette(scheme).sep).frame(height: 0.5).padding(.leading, inset).padding(.trailing, 8)
    }
}

// Lists end in a fade, like a scroll view cut off at the widget's edge.
extension View {
    func fadeOut(at stop: CGFloat) -> some View {
        mask(LinearGradient(stops: [.init(color: .black, location: stop), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
    }
}

enum Assets {
    static func image(_ name: String, _ ext: String, template: Bool) -> Image {
        guard let url = Bundle.main.url(forResource: name, withExtension: ext), let img = NSImage(contentsOf: url) else { return Image(systemName: "questionmark") }
        img.isTemplate = template
        return Image(nsImage: img)
    }

    static let localhost = image("localhost", "png", template: true)
    static let github = image("github", "svg", template: true)
    static let vscode = image("vscode", "png", template: false)
}

// ---- Data -----------------------------------------------------------------------------------

enum Feed {
    // Termorc is feeding the widgets, and this snapshot is recent enough to show as live.
    static func live(_ at: Date?, within seconds: TimeInterval) -> Bool {
        guard let at, WidgetStore.read(FeedStatus.self, kind: FeedStatus.kind)?.running == true else { return false }
        return Date().timeIntervalSince(at) < seconds
    }

    // Ask Termorc to start feeding `kind` (a widget was just added, or its data is stale).
    static func hello(_ kind: String) { post("hello:\(kind)") }

    static func post(_ action: String) {
        DistributedNotificationCenter.default().postNotificationName(.init(WidgetStore.actionNotification), object: action, userInfo: nil, deliverImmediately: true)
    }

    // One entry a minute for an hour, so uptimes and "3m ago" stay current without Termorc
    // asking for redraws, plus one at each moment a button's state runs out.
    static func dates(_ now: Date = Date(), until extra: [Date?] = []) -> [Date] {
        let marks = (0...60).map { now.addingTimeInterval(Double($0) * 60) } + extra.compactMap { $0 }.filter { $0 > now }
        return Set(marks).sorted()
    }
}

// Button state that outlives a single render (a pending "Stop?", the selected tab). The
// buttons' App Intents run in this extension too, so its own defaults are shared ground.
enum WidgetState {
    static let confirmStop = "localhost.confirm"
    static let stopping = "localhost.busy"
    static let syncing = "pulls.sync"

    private static let defaults = UserDefaults.standard

    static func set(_ key: String, _ value: String, for seconds: TimeInterval) {
        defaults.set(["value": value, "until": Date().addingTimeInterval(seconds).timeIntervalSince1970], forKey: key)
    }

    static func clear(_ key: String) { defaults.removeObject(forKey: key) }

    static func value(_ key: String, at date: Date) -> String? {
        guard let d = defaults.dictionary(forKey: key), let until = d["until"] as? Double, date.timeIntervalSince1970 < until else { return nil }
        return d["value"] as? String
    }

    static func expiry(_ key: String) -> Date? {
        (defaults.dictionary(forKey: key)?["until"] as? Double).map(Date.init(timeIntervalSince1970:))
    }

    static var pullsTab: String {
        get { defaults.string(forKey: "pulls.tab") ?? "review" }
        set { defaults.set(newValue, forKey: "pulls.tab") }
    }
}

// ---- Formatting -----------------------------------------------------------------------------

enum Format {
    static func duration(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        let d = s / 86400, h = s % 86400 / 3600, m = s % 3600 / 60
        return d > 0 ? "\(d)d \(h)h" : h > 0 ? "\(h)h \(m)m" : "\(m)m"
    }

    static func ago(_ date: Date, now: Date) -> String {
        let s = now.timeIntervalSince(date)
        return s < 3600 ? "\(max(1, Int((s / 60).rounded())))m" : s < 86400 ? "\(Int((s / 3600).rounded()))h" : "\(Int((s / 86400).rounded()))d"
    }

    static func memory(_ kb: Int) -> String {
        kb >= 1024 * 1024 ? String(format: "%.1f GB", Double(kb) / 1024 / 1024) : "\(kb / 1024) MB"
    }

    static func speed(_ bytes: Double) -> (String, String) {
        bytes >= 1e6 ? (String(format: "%.1f", bytes / 1e6), "MB/s") : bytes >= 1e3 ? ("\(Int((bytes / 1e3).rounded()))", "KB/s") : ("\(Int(bytes))", "B/s")
    }

    static func storage(_ bytes: Int64) -> (String, String) {
        let gb = Double(bytes) / 1e9
        return gb >= 1000 ? (String(format: "%.1f", gb / 1000), "TB") : gb >= 10 ? ("\(Int(gb))", "GB") : (String(format: "%.1f", gb), "GB")
    }

    static func short(_ n: Int) -> String {
        n >= 10000 ? "\(n / 1000)k" : n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)"
    }

    static func clock(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }
}
