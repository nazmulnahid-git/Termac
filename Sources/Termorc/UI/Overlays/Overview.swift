import AppKit
import SwiftUI
import TermorcCore

// "All Spaces" (⌃⌥↑ or pinch): one card per Space over a dark backdrop. Click a card to
// switch, a row to open that session; drag rows between cards to move them.
@MainActor
final class OverviewPanel {
    let panel: OverlayPanel
    var onClose: (() -> Void)?
    private var monitor: Any?
    private let model = OverviewModel()

    init() {
        panel = OverlayPanel(size: .zero)
        panel.content.layer?.cornerRadius = 0
        (panel.content as? NSVisualEffectView)?.material = .fullScreenUI
        (panel.content as? NSVisualEffectView)?.appearance = NSAppearance(named: .darkAqua)
        let host = NSHostingView(rootView: OverviewView(model: model, close: { [weak self] in self?.close() }).environmentObject(Store.shared))
        host.translatesAutoresizingMaskIntoConstraints = false
        panel.content.addSubview(host)
        NSLayoutConstraint.activate([host.topAnchor.constraint(equalTo: panel.content.topAnchor), host.bottomAnchor.constraint(equalTo: panel.content.bottomAnchor), host.leadingAnchor.constraint(equalTo: panel.content.leadingAnchor), host.trailingAnchor.constraint(equalTo: panel.content.trailingAnchor)])
    }

    func show(over window: NSWindow) {
        let store = Store.shared
        model.hl = max(0, store.model.spaces.firstIndex { $0.id == store.model.activeSpaceId } ?? 0)
        panel.setFrame(window.contentLayoutRect.offsetBy(dx: window.frame.minX, dy: window.frame.minY), display: false)
        panel.present(over: window, topFraction: 0)
        panel.setFrame(window.contentLayoutRect.offsetBy(dx: window.frame.minX, dy: window.frame.minY), display: true)
        panel.onResign = { [weak self] in self?.close() }
        // Arrow keys, Enter, Esc and ⌃1–9, before anything else sees them.
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            MainActor.assumeIsolated { self?.key(e) ?? false } ? nil : e
        }
    }

    private func key(_ e: NSEvent) -> Bool {
        let store = Store.shared
        let n = store.model.spaces.count + 1 // last slot is "New Space"
        switch e.keyCode {
        case 53: close()
        case 124: model.hl = (model.hl + 1) % n
        case 123: model.hl = (model.hl - 1 + n) % n
        case 36, 76:
            if model.hl < store.model.spaces.count { store.switchSpace(store.model.spaces[model.hl].id); close() } else { newSpace() }
        default:
            if e.modifierFlags.contains(.control), let d = Int(e.charactersIgnoringModifiers ?? ""), (1...9).contains(d), d <= store.model.spaces.count {
                store.switchSpace(store.model.spaces[d - 1].id)
                close()
                return true
            }
            return false
        }
        return true
    }

    private func newSpace() {
        close()
        DispatchQueue.main.async { Store.shared.ui.overlay = .spaceEditor(nil) }
    }

    func close() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        panel.onResign = nil
        panel.dismiss()
        let cb = onClose
        onClose = nil
        cb?()
    }
}

final class OverviewModel: ObservableObject {
    @Published var hl = 0
    @Published var drop: String?
}

struct OverviewView: View {
    @EnvironmentObject var store: Store
    @ObservedObject var model: OverviewModel
    let close: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Text("All Spaces").font(.title2.weight(.semibold)).foregroundStyle(.white)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 16) {
                    ForEach(Array(store.model.spaces.enumerated()), id: \.element.id) { i, sp in
                        card(sp, highlighted: model.hl == i).onHover { if $0 { model.hl = i } }
                    }
                    Button {
                        close()
                        DispatchQueue.main.async { store.ui.overlay = .spaceEditor(nil) }
                    } label: {
                        VStack(spacing: 8) {
                            Image(systemName: "plus").font(.title)
                            Text("New Space")
                            Text(Keys.format(store.model.settings.keybindings["newSpace"])).font(.caption).foregroundStyle(.secondary)
                        }
                        .frame(width: 200, height: 300)
                        .background(Color.white.opacity(model.hl == store.model.spaces.count ? 0.12 : 0.05), in: RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.2), style: StrokeStyle(lineWidth: 1, dash: [5])))
                    }
                    .buttonStyle(.plain)
                    .onHover { if $0 { model.hl = store.model.spaces.count } }
                }
                .padding(.horizontal, 40)
            }
            Text("Drag sessions between cards to move them · Pinch out or esc to return · ⌃1–9 jumps").font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { close() }
    }

    func card(_ sp: Space, highlighted: Bool) -> some View {
        let color = Color(nsColor: NSColor(hex: sp.color))
        let current = sp.id == store.model.activeSpaceId
        let sids = sp.allTabs.flatMap { store.model.tabs[$0]?.layout.leaves ?? [] }
        let running = sids.filter { store.rt[$0]?.status == .run }.count
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    SpaceGlyph(space: sp)
                    Text(sp.name).font(.headline).lineLimit(1)
                    Spacer()
                    if current { Text("Current").font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 2).background(color.opacity(0.3), in: Capsule()) }
                }
                Text("\(sids.count) session\(sids.count == 1 ? "" : "s")\(running > 0 ? " · \(running) running" : "")").font(.caption).foregroundStyle(.secondary)
            }
            .padding(12)
            .background(color.opacity(0.16))
            // A Space with more sessions than the card shows scrolls rather than cutting off.
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 2) {
                    if sp.allTabs.isEmpty { Text("No sessions yet").font(.caption).foregroundStyle(.secondary).padding(8) }
                    ForEach(sp.pinned, id: \.self) { row($0, active: current && sp.activeTabId == $0) }
                    ForEach(sp.folders.filter { !$0.tabs.isEmpty }) { f in
                        Text(f.name).font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.top, 6).padding(.leading, 8)
                        ForEach(f.tabs, id: \.self) { row($0, active: current && sp.activeTabId == $0) }
                    }
                    if !sp.today.isEmpty {
                        Text("Today").font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.top, 6).padding(.leading, 8)
                        ForEach(sp.today, id: \.self) { row($0, active: current && sp.activeTabId == $0) }
                    }
                }
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.automatic)
        }
        .frame(width: 240, height: 300, alignment: .top)
        .background(Color.white.opacity(highlighted ? 0.12 : 0.06), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(model.drop == sp.id ? color : (current ? color.opacity(0.8) : Color.white.opacity(highlighted ? 0.3 : 0.1)), lineWidth: model.drop == sp.id || current ? 2 : 1))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .contentShape(RoundedRectangle(cornerRadius: 14))
        .onTapGesture { store.switchSpace(sp.id); close() }
        .dropDestination(for: String.self) { items, _ in
            guard let tid = items.first, let loc = store.locate(tid), loc.spaceId != sp.id else { return false }
            store.moveTab(tid, to: Dest(section: loc.section == .pinned ? .pinned : .today, spaceId: sp.id))
            return true
        } isTargeted: { model.drop = $0 ? sp.id : (model.drop == sp.id ? nil : model.drop) }
    }

    func row(_ tid: String, active: Bool) -> some View {
        let v = TabView.make(tid)
        let (img, text) = KindIcons.image(kind: v?.active?.kind ?? ">_", icon: v?.tab.icon)
        return HStack(spacing: 7) {
            if let img { Image(nsImage: img).foregroundStyle(.secondary).frame(width: 16) } else { Text(text ?? "").frame(width: 16) }
            Text(v?.name ?? "").lineLimit(1).font(.callout)
            Spacer()
            statusMark(v)
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(active ? Color.white.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture { store.activateTab(tid); close() }
        .draggable(tid)
    }

    @ViewBuilder func statusMark(_ v: TabView?) -> some View {
        switch v?.status {
        case .run: ProgressView().controlSize(.mini)
        case .ok: Text("✓").foregroundStyle(.green).font(.caption.bold())
        case .fail: Text("✗").foregroundStyle(.red).font(.caption.bold())
        case .bell: Text("\(v?.bell ?? 0)").font(.caption2.bold()).padding(.horizontal, 4).background(.orange, in: RoundedRectangle(cornerRadius: 4))
        default: EmptyView()
        }
    }
}
