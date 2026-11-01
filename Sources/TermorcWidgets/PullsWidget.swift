import AppKit
import SwiftUI
import TermorcCore
import WidgetKit

// Open pull requests waiting on your review, and your own, with CI and review status. Termorc
// fetches them with `gh` every minute and notifies you of new review requests; the organization
// comes from settings.json › widgets.github_org.
struct PullsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetStore.pullsKind, provider: Provider()) { entry in
            Card { PullsView(entry: entry) }
        }
        .configurationDisplayName("Pull Requests")
        .description("Reviews waiting on you, and your own open pull requests.")
        .supportedFamilies([.systemLarge])
        .contentMarginsDisabled()
    }

    struct Entry: TimelineEntry {
        let date: Date
        let snapshot: PullsSnapshot?
        let live: Bool
        let tab: String
        var syncing = false
    }

    struct Provider: TimelineProvider {
        func placeholder(in context: Context) -> Entry {
            Entry(date: Date(), snapshot: Samples.pulls, live: true, tab: "review")
        }

        func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
            completion(context.isPreview ? placeholder(in: context) : entries().first!)
        }

        func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
            completion(Timeline(entries: entries(), policy: .atEnd))
        }

        private func entries() -> [Entry] {
            let snap = WidgetStore.read(PullsSnapshot.self, kind: WidgetStore.pullsKind)
            let live = Feed.live(snap?.at, within: 300)
            if !live { Feed.hello(WidgetStore.pullsKind) }
            let tab = WidgetState.pullsTab
            return Feed.dates(until: [WidgetState.expiry(WidgetState.syncing)]).map { date in
                // Syncing until a fetch newer than the tap lands, or the wait runs out.
                let tapped = WidgetState.value(WidgetState.syncing, at: date).flatMap(Double.init).map(Date.init(timeIntervalSince1970:))
                return Entry(date: date, snapshot: snap, live: live, tab: tab, syncing: tapped.map { (snap?.at ?? .distantPast) < $0 } ?? false)
            }
        }
    }
}

private struct PullsView: View {
    @Environment(\.colorScheme) private var scheme
    let entry: PullsWidget.Entry

    private var current: PullList? { entry.tab == "mine" ? entry.snapshot?.mine : entry.snapshot?.review }

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Link(destination: URL(string: "https://github.com/pulls/review-requested")!) {
                    HStack(spacing: 7) {
                        HeadIcon(image: Assets.github)
                        HeadTitle(text: "Pull Requests")
                    }
                }
                Spacer()
                HStack(spacing: 8) {
                    Text(status).font(.system(size: 11)).foregroundStyle(p.fg2).lineLimit(1)
                    Button(intent: SyncPullsIntent()) {
                        Image(systemName: entry.syncing ? "ellipsis" : "arrow.clockwise")
                            .font(.system(size: 11, weight: .bold))
                            .frame(width: 26, height: 26)
                            .background(p.fill, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .help("Sync now")
                }
            }

            HStack(spacing: 0) {
                Segment(tab: "review", label: "Review", count: entry.snapshot?.review?.total, color: Palette.orange, active: entry.tab != "mine")
                Segment(tab: "mine", label: "Mine", count: entry.snapshot?.mine?.total, color: Palette.blue, active: entry.tab == "mine")
            }
            .padding(2)
            .background(p.fill, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .padding(.top, 12)
            .padding(.bottom, 6)

            if let current, !current.items.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(current.items.prefix(10).enumerated()), id: \.element.url) { i, pr in
                        PullRow(pr: pr, now: entry.date, showAuthor: entry.tab != "mine")
                            .overlay(alignment: .top) { if i > 0 { RowSeparator(inset: 48) } }
                    }
                }
                .frame(maxHeight: .infinity, alignment: .top)
                .padding(.horizontal, -8)
                .clipped()
                .fadeOut(at: 0.82)
            } else if current != nil {
                EmptyState(symbol: AnyView(Image(systemName: "checkmark.circle.fill").font(.system(size: 38)).foregroundStyle(.white, Palette.green)),
                           title: "All caught up",
                           detail: entry.tab == "mine" ? "You have no open pull requests" : "No reviews waiting on you")
            } else if !entry.live {
                EmptyState(title: "Termorc isn't running", detail: "Open it to see your pull requests")
            } else {
                EmptyState(title: entry.snapshot?.problem ?? "Loading pull requests…", detail: "")
            }
        }
        .padding(EdgeInsets(top: 16, leading: 16, bottom: 10, trailing: 16))
    }

    private var status: String {
        if entry.syncing { return "Syncing…" }
        if !entry.live { return entry.snapshot?.fetchedAt.map { "Termorc closed · \(Format.clock($0))" } ?? "" }
        if entry.snapshot?.problem != nil, current != nil { return "Offline" }
        return entry.snapshot?.fetchedAt.map { "Updated \(Format.clock($0))" } ?? ""
    }
}

private struct Segment: View {
    @Environment(\.colorScheme) private var scheme
    let tab: String
    let label: String
    let count: Int?
    let color: Color
    let active: Bool

    var body: some View {
        let p = Palette(scheme)
        Button(intent: ShowPullsIntent(tab)) {
            HStack(spacing: 6) {
                Text(label).font(.system(size: 12, weight: active ? .semibold : .medium)).foregroundStyle(active ? p.fg : p.fg2)
                if let count {
                    Text("\(count)").font(.rounded(11)).foregroundStyle(.white)
                        .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 16)
                        .background(color, in: Capsule())
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 24)
            .background {
                if active {
                    RoundedRectangle(cornerRadius: 7, style: .continuous).fill(p.seg).shadow(color: .black.opacity(0.18), radius: 1.5, y: 1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct PullRow: View {
    @Environment(\.colorScheme) private var scheme
    let pr: PullRequest
    let now: Date
    let showAuthor: Bool

    var body: some View {
        let p = Palette(scheme)
        Link(destination: URL(string: pr.url) ?? URL(string: "https://github.com")!) {
            HStack(spacing: 10) {
                avatar(p)
                    .frame(width: 30, height: 30)
                    .overlay(alignment: .bottomTrailing) { checks(p).offset(x: 5, y: 5) }
                VStack(alignment: .leading, spacing: 1) {
                    Text(pr.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text(meta).font(.system(size: 11)).foregroundStyle(p.fg2).lineLimit(1)
                }
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 3) {
                    review
                    HStack(spacing: 4) {
                        Text("+\(Format.short(pr.additions))").foregroundStyle(Palette.green)
                        Text("−\(Format.short(pr.deletions))").foregroundStyle(Palette.red)
                    }
                    .font(.rounded(10.5)).monospacedDigit()
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
        }
    }

    private var meta: String {
        var parts = ["\(pr.repo) #\(pr.number)"]
        if showAuthor { parts.append(pr.author) }
        parts.append(Format.ago(pr.updatedAt, now: now))
        if pr.comments > 0 { parts.append("💬 \(pr.comments)") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private func avatar(_ p: Palette) -> some View {
        if let img = NSImage(contentsOf: pr.avatarFile) {
            Image(nsImage: img).resizable().clipShape(Circle())
        } else {
            Circle().fill(p.fill).overlay { Text(pr.author.prefix(1).uppercased()).font(.rounded(13)).foregroundStyle(p.fg2) }
        }
    }

    @ViewBuilder private func checks(_ p: Palette) -> some View {
        let badge = { (color: Color, symbol: String, size: CGFloat) in
            Image(systemName: symbol).font(.system(size: size, weight: .black)).foregroundStyle(.white)
                .frame(width: 14, height: 14).background(color, in: Circle())
                .padding(2).background(p.bg, in: Circle())
        }
        switch pr.checks {
        case "SUCCESS": badge(Palette.green, "checkmark", 7)
        case "FAILURE", "ERROR": badge(Palette.red, "xmark", 6)
        case "PENDING", "EXPECTED": badge(Palette.yellow, "circle.fill", 5)
        default: EmptyView()
        }
    }

    @ViewBuilder private var review: some View {
        let tag = { (label: String, color: Color) in
            Text(label).font(.system(size: 10, weight: .semibold)).foregroundStyle(color)
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        if pr.isDraft {
            tag("Draft", Palette.gray)
        } else if pr.review == "APPROVED" {
            tag("Approved", Palette.green)
        } else if pr.review == "CHANGES_REQUESTED" {
            tag("Changes", Palette.red)
        }
    }
}
