import AppKit
import TermorcCore

// The sidebar: Favorites as tiles, then the active Space's list (Pinned, folders, Today).
// Switching Spaces is a real carousel, as in Arc: neighbouring Spaces'
// lists sit side by side on one track. A two-finger swipe drags the track 1:1 and it springs
// to the nearest Space on release, carrying the swipe's velocity. Keys, the Spaces bar and
// menus slide the same track. Swiping past the last Space fills a ＋ ring that makes a new one.
@MainActor
final class SidebarViewController: NSViewController {
    let store = Store.shared
    private let favorites = FavoritesStrip()
    private let cards = SidebarCards()
    private let rail = RailView()
    private let track = TrackView()
    private let ring = NewSpaceRing()
    private var expanded: NSView?
    private var token: ObserverToken?

    // Lists on the track, left to right, and which one sits in the viewport at offset 0. At
    // rest the track holds the shown Space with its neighbours either side, so a swipe has
    // nothing to build when it starts. Lists are kept per Space and reused.
    private var lists: [SpaceList] = []
    private var cache: [String: SpaceList] = [:]
    private var base = 0
    private var offset: CGFloat = 0 { didSet { track.offset = offset } }
    private var shownId = ""
    private var pending: String? // a swiped-to Space the store switches to once the slide is under way
    private var springing = false
    private var springGen = 0

    // Swipe state. `sx`/`sy` gather movement until the axis is decided.
    private struct Swipe {
        var on = false
        var horizontal: Bool?
        var lock = false
        var x: CGFloat = 0
        var sx: CGFloat = 0
        var sy: CGFloat = 0
        var samples: [(TimeInterval, CGFloat)] = []
    }
    private var swipe = Swipe()
    private var swallowMomentum = false

    static let commit: CGFloat = 0.22 // fraction of the width that switches Space on release…
    static let flick: CGFloat = 500 // …or a flick this fast (pt/s)
    static let auto: CGFloat = 0.6 // past this fraction the switch completes on its own
    static let create: CGFloat = 200 // pt past the last Space that creates a new one

    var dragTid: String? { SpaceList.dragTid }
    static let rootId = NSUserInterfaceItemIdentifier("sidebar")

    // Compact mode shows the rail of icon tiles instead of the full list.
    var compact = false {
        didSet {
            rail.isHidden = !compact
            expanded?.isHidden = compact
            if compact { rail.update() }
        }
    }

    override func loadView() {
        let root = NSView()
        root.identifier = Self.rootId
        rail.translatesAutoresizingMaskIntoConstraints = false
        rail.isHidden = true
        root.addSubview(rail)
        NSLayoutConstraint.activate([rail.topAnchor.constraint(equalTo: root.topAnchor), rail.bottomAnchor.constraint(equalTo: root.bottomAnchor), rail.leadingAnchor.constraint(equalTo: root.leadingAnchor), rail.trailingAnchor.constraint(equalTo: root.trailingAnchor)])
        let stack = NSStackView(views: [favorites, track, cards])
        expanded = stack
        stack.loosen()
        stack.orientation = .vertical
        stack.spacing = 0
        stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            favorites.widthAnchor.constraint(equalTo: stack.widthAnchor),
            track.widthAnchor.constraint(equalTo: stack.widthAnchor),
            cards.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        ring.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(ring)
        NSLayoutConstraint.activate([
            ring.centerYAnchor.constraint(equalTo: track.centerYAnchor), ring.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            ring.widthAnchor.constraint(equalToConstant: 48), ring.heightAnchor.constraint(equalToConstant: 76),
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
        shownId = store.model.activeSpaceId
        arrange()
        token = store.observe { [weak self] in self?.refresh() }
        refresh()
        NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] e in
            guard let self else { return e }
            return MainActor.assumeIsolated { self.scrollWheel(e) } ? nil : e
        }
    }

    override func mouseExited(with event: NSEvent) { Peek.shared.leftSidebar() }

    private func refresh() {
        if compact { rail.update() }
        favorites.update()
        cards.update()
        for id in cache.keys where store.space(id) == nil { cache.removeValue(forKey: id)?.scroll.removeFromSuperview() }
        let active = store.model.activeSpaceId
        if store.space(shownId) == nil { shownId = active }
        if active != shownId, pending == nil {
            slide(to: active)
        } else if !springing, !swipe.on, lists.map(\.spaceId) != around(shownId) {
            arrange() // Spaces were added, removed or reordered
        }
        // Lists off to the side catch up once the track is at rest.
        let moving = springing || swipe.horizontal == true
        for (i, l) in lists.enumerated() where i == base || !moving { l.refresh() }
    }

    // ---- Track --------------------------------------------------------------------------
    private func list(_ id: String) -> SpaceList {
        if let l = cache[id] { return l }
        let l = SpaceList(spaceId: id)
        cache[id] = l
        return l
    }

    private func show(_ ids: [String], base b: Int, offset x: CGFloat = 0) {
        let next = ids.map(list)
        for l in lists where !next.contains(where: { $0 === l }) { l.scroll.removeFromSuperview() }
        for l in next where l.scroll.superview !== track { track.addSubview(l.scroll) }
        lists = next
        base = b
        track.panes = next.map(\.scroll)
        track.base = b
        offset = x
        for (i, l) in next.enumerated() { l.outline.isEnabled = i == b }
    }

    private func around(_ id: String) -> [String] {
        guard let i = index(id) else { return [id] }
        let all = store.model.spaces
        return [i > 0 ? all[i - 1].id : nil, id, i + 1 < all.count ? all[i + 1].id : nil].compactMap { $0 }
    }

    // The shown Space between its neighbours, `x` points from rest.
    private func arrange(offset x: CGFloat = 0) {
        let ids = around(shownId)
        show(ids, base: ids.firstIndex(of: shownId) ?? 0, offset: x)
    }

    private func rest() {
        stop()
        arrange()
        lists.forEach { $0.refresh() }
    }

    private var hasPrev: Bool { base > 0 }
    private var hasNext: Bool { base < lists.count - 1 }
    private var width: CGFloat { max(1, track.bounds.width) }
    private func index(_ id: String) -> Int? { store.model.spaces.firstIndex { $0.id == id } }

    // Where a list on the track sits on screen right now, relative to the viewport.
    private func position(of id: String) -> CGFloat {
        lists.firstIndex { $0.spaceId == id }.map { CGFloat($0 - base) * width + shownOffset } ?? 0
    }

    // The offset on screen, part way through a spring.
    private var shownOffset: CGFloat {
        guard springing, let x = track.layer?.presentation()?.bounds.origin.x else { return offset }
        return -x
    }

    private func flush() {
        guard let id = pending else { return }
        pending = nil
        store.switchSpace(id)
    }

    // A switch from anywhere (keys, Spaces bar, menus, new Space): slide from the shown Space
    // to the active one, starting wherever the track is (it may still be moving).
    private func slide(to id: String) {
        let from = shownId
        shownId = id
        guard let a = index(from), let b = index(id), a != b, view.window != nil, !compact else { return rest() }
        if swipe.on { swipe.lock = true }
        let x = position(of: from)
        stop()
        let dir: CGFloat = b > a ? 1 : -1
        if dir > 0 { show([from, id], base: 0, offset: x) } else { show([id, from], base: 1, offset: x) }
        animate(to: -dir * width, velocity: 0) { [weak self] in self?.rest() }
    }

    // Lightly underdamped spring (settles in ~300 ms with a hint of follow-through). It runs
    // in Core Animation, so it stays smooth while the main thread swaps the terminals in.
    private func animate(to target: CGFloat, velocity v: CGFloat, done: @escaping () -> Void) {
        stop()
        let from = offset
        offset = target
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, abs(target - from) > 0.5, let layer = track.layer else { return done() }
        // On the track's bounds origin, which is -offset.
        let a = CASpringAnimation(keyPath: "bounds.origin.x")
        a.mass = 1
        a.stiffness = 300
        a.damping = 31
        a.fromValue = -from
        a.toValue = -target
        a.initialVelocity = v / (target - from) // in distances per second, toward the target
        a.duration = a.settlingDuration
        springing = true
        let gen = springGen
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.springGen == gen else { return }
                self.springing = false
                done()
            }
        }
        layer.add(a, forKey: "slide")
        CATransaction.commit()
    }

    // Halts a spring where it is on screen.
    private func stop() {
        guard springing else { return }
        let x = shownOffset
        springGen += 1
        springing = false
        track.layer?.removeAnimation(forKey: "slide")
        offset = x
    }

    // ---- Swipe ----------------------------------------------------------------------------
    // Resistance that approaches `max` points however far you pull.
    private func rubber(_ d: CGFloat, _ max: CGFloat) -> CGFloat { max * (1 - 1 / ((d * 0.6) / max + 1)) }

    // Points per second over the last 80 ms of the swipe, within what a hand can do (events
    // that arrive bunched together would otherwise read as a huge flick).
    private func velocity(at now: TimeInterval) -> CGFloat {
        let recent = swipe.samples.filter { now - $0.0 < 0.08 }
        guard let first = recent.first, let last = recent.last, recent.count >= 2 else { return 0 }
        let v = recent.dropFirst().reduce(0) { $0 + $1.1 } / CGFloat(max(0.016, last.0 - first.0))
        return min(3000, max(-3000, v))
    }

    // Returns true when the event was used (and shouldn't scroll the list).
    private func scrollWheel(_ e: NSEvent) -> Bool {
        guard let win = view.window, store.model.settings.gestures.swipeSpaces, store.ui.overlay == nil, !view.isHiddenOrHasHiddenAncestor, e.hasPreciseScrollingDeltas else { return false }
        // Some scroll events (from other input sources) arrive without a window; their location
        // is then in screen coordinates.
        let inWindow = e.window === win ? e.locationInWindow : (e.window == nil ? win.convertPoint(fromScreen: e.locationInWindow) : nil)
        guard let at = inWindow else { return false }
        // Momentum after a horizontal swipe belongs to the swipe.
        if !e.momentumPhase.isEmpty { return swallowMomentum }
        if e.phase.contains(.began) || e.phase.contains(.mayBegin) {
            guard view.bounds.contains(view.convert(at, from: nil)) else { return false }
            swipe = Swipe(on: true)
            swallowMomentum = false
            return false
        }
        // A swipe whose start we didn't see starts here.
        if !swipe.on, e.phase.contains(.changed), view.bounds.contains(view.convert(at, from: nil)) {
            swipe = Swipe(on: true)
            swallowMomentum = false
        }
        guard swipe.on else { return false }
        if e.phase.contains(.ended) || e.phase.contains(.cancelled) {
            swipe.on = false
            if swipe.horizontal == true {
                if !swipe.lock { release(velocity(at: e.timestamp)) }
                ring.progress = 0
            }
            // The list still gets the end of the gesture so its own scrolling state settles.
            return false
        }
        guard !e.phase.isEmpty else { return false }
        // Natural scrolling: content follows the fingers.
        var dx = e.scrollingDeltaX * (e.isDirectionInvertedFromDevice ? 1 : -1)
        if swipe.horizontal == nil {
            swipe.sx += dx
            swipe.sy += e.scrollingDeltaY
            if hypot(swipe.sx, swipe.sy) < 6 { return false }
            swipe.horizontal = abs(swipe.sx) > abs(swipe.sy)
            guard swipe.horizontal == true else { return false }
            swallowMomentum = true
            Peek.shared.close()
            if !compact { begin() }
            dx = swipe.sx
        }
        guard swipe.horizontal == true else { return false }
        if swipe.lock { return true }
        swipe.x += dx
        swipe.samples.append((e.timestamp, dx))
        if swipe.samples.count > 16 { swipe.samples.removeFirst() }
        if compact { return true }
        let r = drag(swipe.x)
        let p = min(1, max(0, (r.past - 16) / (Self.create - 16)))
        ring.progress = p
        if p >= 1 {
            swipe.lock = true
            ring.pop()
            store.createBlankSpace()
        } else if r.toward != 0, r.frac >= Self.auto {
            swipe.lock = true
            release(velocity(at: e.timestamp))
        }
        return true
    }

    // Catches the track wherever it is (a slide may still be springing) and puts the shown
    // Space's neighbours beside it.
    private func begin() {
        flush()
        stop()
        let x = position(of: shownId)
        arrange(offset: x)
        swipe.x = x
    }

    private func drag(_ dx: CGFloat) -> (past: CGFloat, frac: CGFloat, toward: Int) {
        var x = dx
        var past: CGFloat = 0
        if x < 0 && !hasNext {
            past = -x
            x = -rubber(past, 110)
        } else if x > 0 && !hasPrev {
            x = rubber(x, 56)
        }
        offset = x
        return (past, abs(x) / width, x < 0 ? (hasNext ? 1 : 0) : (hasPrev ? -1 : 0))
    }

    private func release(_ v: CGFloat) {
        if compact {
            // The rail just switches, no carousel.
            if swipe.x < -40 || v < -Self.flick { store.switchSpace(by: 1) } else if swipe.x > 40 || v > Self.flick { store.switchSpace(by: -1) }
            return
        }
        let w = width
        var dir = 0
        if hasNext, offset < -w * Self.commit || v < -Self.flick { dir = 1 }
        else if hasPrev, offset > w * Self.commit || v > Self.flick { dir = -1 }
        guard dir != 0 else {
            return animate(to: 0, velocity: v) { [weak self] in self?.rest() }
        }
        let target = lists[base + dir].spaceId
        pending = target
        shownId = target
        animate(to: -CGFloat(dir) * w, velocity: v) { [weak self] in
            self?.flush()
            self?.rest()
        }
        // The terminals switch once the slide is committed and running.
        DispatchQueue.main.async { [weak self] in self?.flush() }
    }
}

// Lays the lists side by side; `offset` moves them all, the `base` list sits at 0.
// Moving the track shifts its bounds, so the lists slide as cached layers without being laid
// out again.
final class TrackView: NSView {
    var panes: [NSView] = [] { didSet { needsLayout = true } }
    var base = 0 { didSet { needsLayout = true } }
    var offset: CGFloat = 0 { didSet { setBoundsOrigin(NSPoint(x: -offset, y: 0)) } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        for (i, p) in panes.enumerated() {
            p.frame = NSRect(x: CGFloat(i - base) * bounds.width, y: 0, width: bounds.width, height: bounds.height)
        }
    }
}

// The ＋ ring at the sidebar's edge that fills as you swipe past the last Space.
final class NewSpaceRing: NSView {
    private let track = CAShapeLayer()
    private let ring = CAShapeLayer()
    private let plus = NSImageView(image: NSImage(systemSymbolName: "plus", accessibilityDescription: "New Space")!)
    private let label = NSTextField(labelWithString: "New Space")

    var progress: CGFloat = 0 {
        didSet {
            ring.strokeEnd = progress
            alphaValue = progress > 0.02 ? 1 : 0
            let s = 0.55 + progress * 0.45
            layer?.sublayerTransform = CATransform3DMakeScale(s, s, 1)
            label.alphaValue = max(0, (progress - 0.45) * 2.2)
        }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        alphaValue = 0
        for l in [track, ring] {
            l.lineWidth = 2.5
            layer?.addSublayer(l)
        }
        track.fillColor = NSColor.windowBackgroundColor.cgColor
        track.strokeColor = NSColor.separatorColor.cgColor
        ring.fillColor = nil
        ring.strokeColor = NSColor.controlAccentColor.cgColor
        ring.strokeEnd = 0
        plus.symbolConfiguration = .init(pointSize: 15, weight: .semibold)
        label.font = .systemFont(ofSize: 11, weight: .semibold)
        label.textColor = .secondaryLabelColor
        for v in [plus, label] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            plus.centerXAnchor.constraint(equalTo: centerXAnchor), plus.topAnchor.constraint(equalTo: topAnchor, constant: 15),
            label.centerXAnchor.constraint(equalTo: centerXAnchor), label.topAnchor.constraint(equalTo: topAnchor, constant: 54),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        let r = NSRect(x: 4, y: 4, width: 40, height: 40)
        // Start at 12 o'clock, clockwise (flipped coordinates).
        let path = CGMutablePath()
        path.addArc(center: CGPoint(x: r.midX, y: r.midY), radius: 19, startAngle: -.pi / 2, endAngle: 1.5 * .pi, clockwise: false)
        track.path = path
        ring.path = path
        track.frame = bounds
        ring.frame = bounds
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func pop() {
        progress = 1
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.38
            animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated { self?.progress = 0 }
        })
    }
}
