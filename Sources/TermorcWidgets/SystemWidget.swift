import SwiftUI
import TermorcCore
import WidgetKit

// CPU, memory, disk and battery rings; the network with its ping, speeds and a ten-minute
// chart; and the local and public IPs (click to copy).
struct SystemWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetStore.systemKind, provider: Provider()) { entry in
            Card { SystemView(entry: entry) }
        }
        .configurationDisplayName("System")
        .description("CPU, memory, disk, battery and network.")
        .supportedFamilies([.systemLarge])
        .contentMarginsDisabled()
    }

    struct Entry: TimelineEntry {
        let date: Date
        let snapshot: SystemSnapshot?
        let live: Bool
    }

    struct Provider: TimelineProvider {
        func placeholder(in context: Context) -> Entry {
            Entry(date: Date(), snapshot: Samples.system, live: true)
        }

        func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
            completion(context.isPreview ? placeholder(in: context) : entries().first!)
        }

        func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
            completion(Timeline(entries: entries(), policy: .atEnd))
        }

        private func entries() -> [Entry] {
            let snap = WidgetStore.read(SystemSnapshot.self, kind: WidgetStore.systemKind)
            let live = Feed.live(snap?.at, within: 120)
            if !live { Feed.hello(WidgetStore.systemKind) }
            return Feed.dates().map { Entry(date: $0, snapshot: snap, live: live) }
        }
    }
}

private struct SystemView: View {
    @Environment(\.colorScheme) private var scheme
    let entry: SystemWidget.Entry

    var body: some View {
        let p = Palette(scheme)
        if let s = entry.snapshot, entry.live {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        HeadIcon(image: Image(systemName: s.battery == nil ? "desktopcomputer" : "laptopcomputer"))
                        HeadTitle(text: s.model)
                    }
                    Text("\(s.chip) · Up \(Format.duration(entry.date.timeIntervalSince(s.bootedAt)))")
                        .font(.system(size: 12)).foregroundStyle(p.fg2).lineLimit(1)
                }

                HStack(spacing: 0) {
                    Ring(pct: s.cpu, color: s.cpu >= 85 ? Palette.red : Palette.blue, symbol: "cpu", value: "\(s.cpu)", unit: "%", label: "CPU")
                    Spacer(minLength: 0)
                    Ring(pct: s.memory, color: s.memory >= 85 ? Palette.red : Palette.purple, symbol: "memorychip", value: "\(s.memory)", unit: "%", label: "Memory")
                    Spacer(minLength: 0)
                    let free = Format.storage(s.diskFree)
                    Ring(pct: s.diskUsed, color: s.diskUsed >= 90 ? Palette.red : Palette.orange, symbol: "internaldrive", value: free.0, unit: free.1, label: "Free")
                    if let b = s.battery {
                        Spacer(minLength: 0)
                        Ring(pct: b, color: !s.charging && b <= 20 ? Palette.red : Palette.green, symbol: batterySymbol(b, s.charging),
                             value: "\(b)", unit: "%", label: s.charging ? "Charging" : s.remaining.map { "\($0 / 60):\(String(format: "%02d", $0 % 60)) left" } ?? "Battery")
                    }
                }
                .padding(.top, 12)

                Rectangle().fill(p.sep).frame(height: 0.5).padding(.top, 10).padding(.bottom, 8)

                HStack {
                    HStack(spacing: 8) {
                        Image(systemName: s.network == nil ? "wifi.slash" : s.network == "Wi-Fi" ? "wifi" : "network")
                            .font(.system(size: 15, weight: .semibold)).frame(width: 22, height: 22)
                            .foregroundStyle(s.network == nil ? Palette.gray : p.fg)
                        Text(s.network ?? "Offline").font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    }
                    Spacer()
                    HStack(spacing: 5) {
                        Circle().fill(pingColor(s.ping)).frame(width: 7, height: 7)
                        Text(s.ping.map { "\($0) ms" } ?? "Offline").font(.rounded(13, .medium)).monospacedDigit().foregroundStyle(p.fg2)
                    }
                }

                HStack(spacing: 18) {
                    Speed(arrow: "arrow.down", color: Palette.blue, label: "Download", bytes: s.down.last ?? 0)
                    Speed(arrow: "arrow.up", color: Palette.green, label: "Upload", bytes: s.up.last ?? 0)
                }
                .padding(.top, 10)

                SpeedChart(down: s.down, up: s.up).frame(height: 30).padding(.top, 4)

                Spacer(minLength: 6)

                VStack(spacing: 0) {
                    IPRow(label: "Local IP", value: s.lan)
                    Rectangle().fill(p.sep).frame(height: 0.5)
                    IPRow(label: "Public IP", value: s.wan)
                }
            }
            .padding(16)
        } else {
            EmptyState(symbol: AnyView(Image(systemName: "laptopcomputer").font(.system(size: 28)).foregroundStyle(p.fg2)),
                       title: "Termorc isn't running", detail: "Open it to see live stats")
                .padding(16)
        }
    }

    private func batterySymbol(_ pct: Int, _ charging: Bool) -> String {
        if charging { return "battery.100percent.bolt" }
        return "battery.\([0, 25, 50, 75, 100].min { abs($0 - pct) < abs($1 - pct) } ?? 100)percent"
    }

    private func pingColor(_ ms: Int?) -> Color {
        guard let ms else { return Palette.gray }
        return ms < 40 ? Palette.green : ms < 100 ? Palette.yellow : Palette.red
    }
}

private struct Ring: View {
    @Environment(\.colorScheme) private var scheme
    let pct: Int
    let color: Color
    let symbol: String
    let value: String
    let unit: String
    let label: String

    var body: some View {
        let p = Palette(scheme)
        VStack(spacing: 0) {
            ZStack {
                Circle().stroke(color.opacity(0.22), lineWidth: 6)
                Circle().trim(from: 0, to: CGFloat(min(100, max(0, pct))) / 100)
                    .stroke(color, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Image(systemName: symbol).font(.system(size: 17)).foregroundStyle(p.fg)
            }
            .frame(width: 48, height: 48)
            .frame(width: 58, height: 58)
            HStack(alignment: .firstTextBaseline, spacing: 1) {
                Text(value).font(.rounded(16)).monospacedDigit()
                Text(unit).font(.system(size: 11)).foregroundStyle(p.fg2)
            }
            .padding(.top, 6)
            Text(label).font(.system(size: 11)).foregroundStyle(p.fg2).lineLimit(1).fixedSize()
        }
        .frame(width: 66)
    }
}

private struct Speed: View {
    @Environment(\.colorScheme) private var scheme
    let arrow: String
    let color: Color
    let label: String
    let bytes: Double

    var body: some View {
        let p = Palette(scheme)
        let (value, unit) = Format.speed(bytes)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Image(systemName: arrow).font(.system(size: 8, weight: .heavy)).foregroundStyle(color)
                Text(label)
            }
            .font(.system(size: 11)).foregroundStyle(p.fg2)
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text(value).font(.rounded(17)).monospacedDigit()
                Text(unit).font(.system(size: 11, weight: .medium)).foregroundStyle(p.fg2)
            }
        }
    }
}

// Download filled in blue, upload as a green line, on a shared scale (at least 50 KB/s).
private struct SpeedChart: View {
    let down: [Double]
    let up: [Double]

    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height
            let n = max(down.count, 2)
            let top = max(50e3, down.max() ?? 0, up.max() ?? 0)
            let points = { (a: [Double]) in a.enumerated().map { CGPoint(x: Double($0.offset) / Double(n - 1) * w, y: h - 1.5 - $0.element / top * (h - 4)) } }
            let d = points(down), u = points(up)
            ZStack {
                if d.count > 1 {
                    Path { path in
                        path.addLines(d)
                        path.addLine(to: CGPoint(x: d.last!.x, y: h))
                        path.addLine(to: CGPoint(x: 0, y: h))
                        path.closeSubpath()
                    }
                    .fill(LinearGradient(colors: [Palette.blue.opacity(0.35), Palette.blue.opacity(0)], startPoint: .top, endPoint: .bottom))
                    Path { $0.addLines(d) }.stroke(Palette.blue, style: StrokeStyle(lineWidth: 1.8, lineJoin: .round))
                }
                if u.count > 1 {
                    Path { $0.addLines(u) }.stroke(Palette.green, style: StrokeStyle(lineWidth: 1.4, lineJoin: .round))
                }
            }
        }
    }
}

private struct IPRow: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: String?

    var body: some View {
        let row = HStack {
            Text(label).foregroundStyle(Palette(scheme).fg2)
            Spacer()
            Text(value ?? "–").font(.rounded(12, .medium)).monospacedDigit()
        }
        .font(.system(size: 12))
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        if let value {
            Button(intent: CopyTextIntent(value)) { row }.buttonStyle(.plain).help("Click to copy")
        } else {
            row
        }
    }
}
