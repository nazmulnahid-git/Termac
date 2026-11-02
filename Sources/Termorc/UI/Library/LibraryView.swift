import AppKit
import SwiftTerm
import SwiftUI
import TermorcCore

// The Library (⌘Y): archived sessions with their scrollback, commands and directory.
// Search covers names, commands, paths and output; Restore brings a session back with its
// scrollback.
@MainActor
final class LibraryModel: ObservableObject {
    @Published var q = ""
    @Published var spaceId: String?
    @Published var cwd: String?
    @Published var host: String?
    @Published var status: String?
    @Published var sinceDays: Double = 30
    @Published var results: [LibraryEntry] = []
    @Published var total = 0
    @Published var selId: String?
    @Published var busy = false
    private var work: DispatchWorkItem?

    func search(debounce: Bool = true) {
        work?.cancel()
        let query = LibraryQuery(q: q, spaceId: spaceId, cwd: cwd, host: host, status: status, sinceDays: sinceDays)
        let lib = Store.shared.library
        busy = true
        let w = DispatchWorkItem { [weak self] in
            DispatchQueue.global(qos: .userInitiated).async {
                let r = lib.search(query)
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.results = r.results
                    self.total = r.total
                    self.busy = false
                    if self.selId == nil || !r.results.contains(where: { $0.id == self.selId }) { self.selId = r.results.first?.id }
                }
            }
        }
        work = w
        DispatchQueue.main.asyncAfter(deadline: .now() + (debounce ? 0.15 : 0), execute: w)
    }
}

struct LibraryView: View {
    static func host(onExit: @escaping () -> Void) -> NSView {
        NSHostingView(rootView: LibraryView().environmentObject(Store.shared).onExitCommand(perform: onExit))
    }

    @EnvironmentObject var store: Store
    @StateObject private var m = LibraryModel()
    @FocusState private var searchFocused: Bool

    static let archiveOpts: [(Double, String)] = [(1, "1 hour idle"), (4, "4 hours idle"), (12, "12 hours idle"), (24, "24 hours idle"), (72, "3 days idle"), (0, "Never")]
    static let daysOpts: [(Double, String)] = [(1, "Last 24 hours"), (7, "Last 7 days"), (30, "Last 30 days"), (90, "Last 90 days"), (0, "All time")]
    static let hitLabel = ["command": "in commands", "path": "in path", "output": "in output"]

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if m.total == 0 && !m.busy {
                empty
            } else {
                HSplitView {
                    list.frame(minWidth: 300, idealWidth: 360)
                    if let e = m.results.first(where: { $0.id == m.selId }) { LibraryDetail(entry: e, model: m).frame(minWidth: 380) }
                    else { Text("No matches").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity) }
                }
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { m.search(debounce: false); searchFocused = true }
        .onChange(of: m.q) { _, _ in m.search() }
    }

    var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(m.total.formatted()) archived session\(m.total == 1 ? "" : "s")").foregroundStyle(.secondary)
                Spacer()
                Text("Archive after").foregroundStyle(.secondary)
                Picker("", selection: setting(\.archiveAfterH)) {
                    ForEach(Self.archiveOpts, id: \.0) { Text($0.1).tag($0.0) }
                }.fixedSize()
            }
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search sessions", text: $m.q).textFieldStyle(.plain).font(.title3).focused($searchFocused)
                    .onSubmit { if let e = m.results.first(where: { $0.id == m.selId }) { store.restoreFromLibrary(e); store.ui.view = .terminal } }
                Text(m.busy && !m.q.isEmpty ? "searching…" : "searching commands, output & paths").font(.caption).foregroundStyle(.tertiary)
            }
            .padding(8)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
            HStack(spacing: 6) {
                chipMenu(m.spaceId.flatMap { id in store.space(id).map { "\($0.glyph) \($0.name)" } } ?? "Space", on: m.spaceId != nil) {
                    Button("Any Space") { m.spaceId = nil; m.search() }
                    ForEach(store.model.spaces) { sp in Button("\(sp.glyph)  \(sp.name)") { m.spaceId = sp.id; m.search() } }
                }
                chipMenu(m.cwd.map { Routing.tildify($0, home: store.home) } ?? "Directory", on: m.cwd != nil) {
                    Button("Any directory") { m.cwd = nil; m.search() }
                    ForEach(distinct(m.results.map(\.cwd)).prefix(20), id: \.self) { d in Button(Routing.tildify(d, home: store.home)) { m.cwd = d; m.search() } }
                }
                chipMenu("Host: \(m.host ?? "any")", on: m.host != nil) {
                    Button("any") { m.host = nil; m.search() }
                    ForEach(distinct(m.results.map { $0.host.isEmpty ? "local" : $0.host }), id: \.self) { h in Button(h) { m.host = h; m.search() } }
                }
                chipMenu("Status: \(["ok": "ok", "fail": "failed", "idle": "idle"][m.status ?? ""] ?? "any")", on: m.status != nil) {
                    Button("any") { m.status = nil; m.search() }
                    Button("ok") { m.status = "ok"; m.search() }
                    Button("failed") { m.status = "fail"; m.search() }
                    Button("idle") { m.status = "idle"; m.search() }
                }
                chipMenu(Self.daysOpts.first { $0.0 == m.sinceDays }?.1 ?? "", on: m.sinceDays != 30) {
                    ForEach(Self.daysOpts, id: \.0) { o in Button(o.1) { m.sinceDays = o.0; m.search() } }
                }
            }
        }
        .padding(16)
    }

    func chipMenu<C: View>(_ title: String, on: Bool, @ViewBuilder _ content: () -> C) -> some View {
        Menu { content() } label: { Text(title).lineLimit(1) }
            .menuStyle(.button).buttonStyle(.bordered).controlSize(.small).tint(on ? .accentColor : nil).fixedSize()
    }

    func distinct(_ list: [String]) -> [String] {
        var counts: [String: Int] = [:]
        for v in list where !v.isEmpty { counts[v, default: 0] += 1 }
        return counts.sorted { $0.value > $1.value }.map(\.key)
    }

    var list: some View {
        let groups = Dictionary(grouping: m.results) { CommandBar.dayLabel($0.endedAt, now: nowMillis()) }
        let order = m.results.map { CommandBar.dayLabel($0.endedAt, now: nowMillis()) }.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        return List(selection: $m.selId) {
            ForEach(order, id: \.self) { label in
                Section(label) {
                    ForEach(groups[label] ?? []) { e in row(e, label: label).tag(e.id) }
                }
            }
            if m.results.count >= 500 { Text("Showing the first 500 — refine the search to see more.").font(.caption).foregroundStyle(.secondary) }
        }
        .listStyle(.inset)
        .contextMenu(forSelectionType: String.self) { ids in
            if let id = ids.first, let e = m.results.first(where: { $0.id == id }) {
                Button("Restore") { store.restoreFromLibrary(e); store.ui.view = .terminal }
                Button("Delete…", role: .destructive) { delete(e) }
            }
        } primaryAction: { ids in
            if let id = ids.first, let e = m.results.first(where: { $0.id == id }) { store.restoreFromLibrary(e); store.ui.view = .terminal }
        }
    }

    func delete(_ e: LibraryEntry) {
        Task {
            guard await store.confirm("Delete “\(e.name)” from the Library?", detail: "Its scrollback and command history are removed. This can't be undone.", ok: "Delete") else { return }
            store.library.remove(e.id)
            if m.selId == e.id { m.selId = nil }
            m.search(debounce: false)
        }
    }

    func row(_ e: LibraryEntry, label: String) -> some View {
        let remote = !e.host.isEmpty && e.host != "local"
        let last = e.commands.last?.cmd
        return VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(e.name).fontWeight(.medium).lineLimit(1)
                if remote, let last, last != e.name { Text("→ \(last)").foregroundStyle(.secondary).lineLimit(1) }
                Spacer()
                if let hit = e.hit.flatMap({ Self.hitLabel[$0] }) { Text(hit).font(.caption2).padding(.horizontal, 5).background(.quaternary, in: Capsule()) }
                statusEnd(e)
            }
            HStack(spacing: 5) {
                Text(remote ? e.host : Routing.tildify(e.cwd, home: store.home)).font(.caption.monospaced()).lineLimit(1)
                Text("·")
                Text(Self.whenLabel(e, label))
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
    }

    @ViewBuilder func statusEnd(_ e: LibraryEntry) -> some View {
        if e.status == "ok" { Text("✓").foregroundStyle(.green).bold() }
        else if e.status == "fail" { Text("exit \(e.exitCode ?? 1)").font(.caption).foregroundStyle(.red) }
        else { Circle().fill(.tertiary).frame(width: 6, height: 6).help("No finished commands") }
    }

    // "16:02 – 16:40" for recent entries, "Thu 11:20" within the week, "19 Oct 11:20" beyond.
    static func whenLabel(_ e: LibraryEntry, _ label: String) -> String {
        let clock = Meta.clockTime
        let cal = Calendar.current
        let start = Date(timeIntervalSince1970: Double(e.startedAt) / 1000), end = Date(timeIntervalSince1970: Double(e.endedAt) / 1000)
        let wd = DateFormatter()
        wd.dateFormat = "EEE"
        if label == "Today" || label == "Yesterday" {
            return cal.isDate(start, inSameDayAs: end) ? "\(clock(e.startedAt)) – \(clock(e.endedAt))" : "\(wd.string(from: start)) \(clock(e.startedAt)) – \(clock(e.endedAt))"
        }
        if Date().timeIntervalSince(end) < 7 * 86400 { return "\(wd.string(from: end)) \(clock(e.endedAt))" }
        let dm = DateFormatter()
        dm.dateFormat = "d MMM"
        return "\(dm.string(from: end)) \(clock(e.endedAt))"
    }

    var empty: some View {
        let h = store.model.settings.archiveAfterH
        return VStack(spacing: 12) {
            Image(systemName: "archivebox").font(.system(size: 40)).foregroundStyle(.secondary)
            Text("No archived sessions yet").font(.title3.weight(.semibold))
            Text(h > 0
                 ? "Idle sessions from Today are tidied here automatically after \(Self.archiveOpts.first { $0.0 == h }?.1.replacingOccurrences(of: " idle", with: "") ?? "\(Int(h)) hours") of inactivity — with their scrollback, commands and directory — so you can search and restore them any time."
                 : "Idle sessions from Today are tidied here automatically once auto-archive is on. Sessions you move to the Library keep their scrollback, commands and directory, so you can search and restore them any time.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary).frame(maxWidth: 440)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct LibraryDetail: View {
    @EnvironmentObject var store: Store
    let entry: LibraryEntry
    @ObservedObject var model: LibraryModel

    var body: some View {
        let e = entry
        let sp = store.space(e.spaceId)
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(e.name).font(.title3.weight(.semibold)).lineLimit(1)
                Text(e.exitCode == nil ? "idle" : "exit \(e.exitCode!)")
                    .font(.caption.weight(.semibold)).padding(.horizontal, 7).padding(.vertical, 2)
                    .background((e.exitCode == nil ? Color.secondary : e.exitCode == 0 ? .green : .red).opacity(0.2), in: Capsule())
                Spacer()
                Button("Delete", role: .destructive) { delete() }.buttonStyle(.borderless)
                Menu("Restore to…") {
                    ForEach(store.model.spaces) { s in Button("\(s.glyph)  \(s.name)") { restore(to: s.id) } }
                }.fixedSize()
                Button("Restore") { restore(to: nil) }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
            }
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 6) {
                GridRow {
                    meta("Space", (sp.map { "\($0.glyph) \($0.name)" } ?? (e.spaceName.isEmpty ? "—" : e.spaceName)))
                    meta("Directory", Routing.tildify(e.cwd, home: store.home), mono: true)
                    meta("Host", e.host.isEmpty ? "local" : e.host)
                }
                GridRow {
                    meta("Started", Self.longDate(e.startedAt) + ", " + Meta.clockTime(e.startedAt))
                    meta("Ended", ended(e))
                    meta("Commands", "\(e.commands.count) run · \(Self.shortLines(e.lines)) lines")
                }
            }
            if !e.commands.isEmpty {
                Text("Commands run").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ScrollView {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(e.commands.enumerated()), id: \.offset) { _, c in
                            HStack {
                                Text(c.exit == 0 ? "✓" : c.exit == nil ? "•" : "✗").foregroundStyle(c.exit == 0 ? .green : c.exit == nil ? .secondary : .red)
                                Text(c.cmd).font(.callout.monospaced()).lineLimit(1)
                                Spacer()
                                Text(c.at.map { Meta.clockTime($0) } ?? "").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .frame(maxHeight: 120)
            }
            ScrollbackPreview(id: e.id, look: store.look(for: store.space(e.spaceId)))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .padding(16)
    }

    func meta(_ k: String, _ v: String, mono: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(k).font(.caption).foregroundStyle(.secondary)
            Text(v).font(mono ? .callout.monospaced() : .callout).lineLimit(1)
        }
    }

    func ended(_ e: LibraryEntry) -> String {
        let cal = Calendar.current
        let same = cal.isDate(Date(timeIntervalSince1970: Double(e.startedAt) / 1000), inSameDayAs: Date(timeIntervalSince1970: Double(e.endedAt) / 1000))
        let why = e.reason == "idle" ? " · idle \(Self.idleFor(e))" : e.reason == "quick" ? " · Quick Terminal" : " · closed"
        return (same ? "" : Self.longDate(e.endedAt) + ", ") + Meta.clockTime(e.endedAt) + why
    }

    static func longDate(_ ts: Millis) -> String {
        let f = DateFormatter()
        f.dateFormat = "EEE d MMM"
        return f.string(from: Date(timeIntervalSince1970: Double(ts) / 1000))
    }

    static func shortLines(_ n: Int) -> String {
        if n < 1000 { return "\(n)" }
        let k = Double(n) / 1000
        return (n < 10000 ? String(format: "%.1f", k).replacingOccurrences(of: ".0", with: "") : "\(Int(k.rounded()))") + "k"
    }

    static func idleFor(_ e: LibraryEntry) -> String {
        let ms = max(0, e.endedAt - (e.idleSince > 0 ? e.idleSince : e.endedAt))
        if ms < 3_600_000 { return "\(max(1, Int((Double(ms) / 60000).rounded())))m" }
        if ms < 72 * 3_600_000 { return "\(Int((Double(ms) / 3_600_000).rounded()))h" }
        return "\(Int((Double(ms) / 86_400_000).rounded()))d"
    }

    func restore(to spaceId: String?) {
        store.restoreFromLibrary(entry, spaceId: spaceId)
        store.ui.view = .terminal
    }

    func delete() {
        Task {
            guard await store.confirm("Delete “\(entry.name)” from the Library?", detail: "Its scrollback and command history are removed. This can't be undone.", ok: "Delete") else { return }
            store.library.remove(entry.id)
            model.selId = nil
            model.search(debounce: false)
        }
    }
}

// A read-only terminal showing an archived session's scrollback in its Space's colors. Keyed by
// the entry: its file (up to several MB) is read when the selection changes, not on every
// redraw of the Library.
struct ScrollbackPreview: NSViewRepresentable {
    let id: String
    let look: TerminalLook

    func makeNSView(context: Context) -> TerminalView {
        let v = TerminalView(frame: NSRect(x: 0, y: 0, width: 600, height: 300))
        v.font = Fonts.mono(Store.shared.model.settings.fontFamily, size: Store.shared.model.settings.fontSize, weight: Store.shared.model.settings.fontWeight)
        return v
    }

    func updateNSView(_ v: TerminalView, context: Context) {
        guard context.coordinator.shown != id else { return }
        context.coordinator.shown = id
        let content = Store.shared.library.content(id)
        v.installColors(look.palette.ansi.map { SwiftTerm.Color(hex: $0) })
        v.nativeBackgroundColor = NSColor(hex: look.bg)
        v.nativeForegroundColor = NSColor(hex: look.palette.foreground)
        v.feed(text: "\u{1b}c")
        var text = content
        // Skip the private block header saved scrollback starts with.
        if text.hasPrefix("\u{1b}]7701;"), let bel = text.firstIndex(of: "\u{07}") { text = String(text[text.index(after: bel)...]) }
        v.feed(text: text)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator { var shown: String? }
}
