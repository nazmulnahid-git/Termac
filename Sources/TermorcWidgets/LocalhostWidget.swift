import SwiftUI
import TermorcCore
import WidgetKit

// Running dev servers: framework, project, uptime and memory. The port opens the server; the
// buttons copy its URL, open the project in VS Code, and stop it (tap twice to confirm).
struct LocalhostWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetStore.localhostKind, provider: Provider()) { entry in
            Card { LocalhostView(entry: entry) }
        }
        .configurationDisplayName("Localhost")
        .description("Dev servers running on this Mac.")
        .supportedFamilies([.systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }

    struct Entry: TimelineEntry {
        let date: Date
        let servers: [LocalServer]
        let live: Bool
        var confirm: Int32?
        var busy: Int32?
    }

    struct Provider: TimelineProvider {
        func placeholder(in context: Context) -> Entry {
            Entry(date: Date(), servers: Samples.servers, live: true)
        }

        func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
            completion(context.isPreview ? placeholder(in: context) : entries().first!)
        }

        func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
            completion(Timeline(entries: entries(), policy: .atEnd))
        }

        private func entries() -> [Entry] {
            let snap = WidgetStore.read(LocalhostSnapshot.self, kind: WidgetStore.localhostKind)
            let live = Feed.live(snap?.at, within: 120)
            if !live { Feed.hello(WidgetStore.localhostKind) }
            return Feed.dates(until: [WidgetState.expiry(WidgetState.confirmStop), WidgetState.expiry(WidgetState.stopping)]).map { date in
                Entry(date: date, servers: snap?.servers ?? [], live: live,
                      confirm: WidgetState.value(WidgetState.confirmStop, at: date).flatMap { Int32($0) },
                      busy: WidgetState.value(WidgetState.stopping, at: date).flatMap { Int32($0) })
            }
        }
    }
}

private struct LocalhostView: View {
    @Environment(\.colorScheme) private var scheme
    let entry: LocalhostWidget.Entry

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                HStack(spacing: 7) {
                    HeadIcon(image: Assets.localhost)
                    HeadTitle(text: "Localhost")
                }
                Spacer()
                if entry.live, !entry.servers.isEmpty {
                    HStack(spacing: 5) {
                        Circle().fill(Palette.green).frame(width: 6, height: 6).shadow(color: Palette.green, radius: 3)
                        Text("\(entry.servers.count) running").font(.system(size: 11)).foregroundStyle(p.fg2)
                    }
                }
            }
            if !entry.live {
                EmptyState(title: "Termorc isn't running", detail: "Open it to see your dev servers")
            } else if entry.servers.isEmpty {
                EmptyState(title: "No dev servers running", detail: "Start one and it shows up here")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(entry.servers.prefix(12).enumerated()), id: \.element.port) { i, s in
                        ServerRow(server: s, now: entry.date, confirm: entry.confirm == s.pid, busy: entry.busy == s.pid)
                            .overlay(alignment: .top) { if i > 0 { RowSeparator(inset: 46) } }
                    }
                }
                .frame(maxHeight: .infinity, alignment: .top)
                .padding(.horizontal, -8)
                .clipped()
                .fadeOut(at: 0.86)
            }
        }
        .padding(EdgeInsets(top: 14, leading: 16, bottom: 6, trailing: 16))
    }
}

private struct ServerRow: View {
    @Environment(\.colorScheme) private var scheme
    let server: LocalServer
    let now: Date
    let confirm: Bool
    let busy: Bool

    var body: some View {
        let p = Palette(scheme)
        let fw = server.framework
        HStack(spacing: 10) {
            Text(fw.glyph)
                .font(.rounded(12, .heavy)).tracking(-0.3)
                .frame(width: 28, height: 28)
                .background(p.tile, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .help(fw.label)
            VStack(alignment: .leading, spacing: 0) {
                Text(server.project).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text("\(fw.label) · \(Format.duration(now.timeIntervalSince(server.started))) · \(Format.memory(server.rssKB))")
                    .font(.system(size: 11)).monospacedDigit().foregroundStyle(p.fg2).lineLimit(1)
            }
            Spacer(minLength: 0)
            HStack(spacing: 2) {
                if busy {
                    IconButton { Image(systemName: "hourglass").font(.system(size: 11, weight: .semibold)).foregroundStyle(p.fg2) }
                } else if confirm {
                    Button(intent: StopServerIntent(server.pid)) {
                        Text("Stop?").font(.system(size: 11, weight: .semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 9).padding(.vertical, 3)
                            .background(Palette.red, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    }
                    .buttonStyle(.plain)
                } else {
                    Button(intent: CopyTextIntent(server.url)) {
                        IconButton { Image(systemName: "doc.on.doc").font(.system(size: 11, weight: .semibold)).foregroundStyle(p.fg2) }
                    }
                    .buttonStyle(.plain)
                    .help("Copy URL")
                    if server.hasProject, let url = vscodeURL {
                        Link(destination: url) {
                            IconButton { Assets.vscode.resizable().frame(width: 15, height: 15) }
                        }
                        .help("Open project in VS Code")
                    }
                    Button(intent: AskStopServerIntent(server.pid)) {
                        IconButton { Image(systemName: "stop.fill").font(.system(size: 10)).foregroundStyle(Palette.red) }
                    }
                    .buttonStyle(.plain)
                    .help("Stop server")
                }
                if let url = URL(string: server.url) {
                    Link(destination: url) {
                        Text(":\(String(server.port))").font(.rounded(12)).foregroundStyle(Palette.blue)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Palette.blue.opacity(0.13), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    }
                    .padding(.leading, 4)
                    .help("Open \(server.url)")
                }
            }
            .fixedSize() // the project name truncates first, never the port
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
    }

    private var vscodeURL: URL? {
        var c = URLComponents()
        c.scheme = "vscode"
        c.host = "file"
        c.path = server.cwd
        return c.url
    }
}

private struct IconButton<Label: View>: View {
    @ViewBuilder let label: Label

    var body: some View {
        label.frame(width: 22, height: 24).contentShape(Rectangle())
    }
}
