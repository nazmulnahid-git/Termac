import AppKit
import TermorcCore

// Pointer-driven drag for sidebar sessions and folders, modelled on Arc:
// the row lifts off and follows the pointer, the list opens a gap where it will land, and on
// release it settles into that gap. Other drops:
//   the middle of another session, held a moment   → the two merge into one split session
//   an edge of the terminal card                     → split the card with it
//   a Space in the Spaces bar                        → move it there (hovering switches Space)
//   Favorites                                        → make it a Favorite
// Hovering a closed folder springs it open. Esc cancels.
@MainActor
final class SidebarDrag {
    enum Item: Equatable {
        case tab(String)
        case folder(spaceId: String, folderId: String)
    }

    enum Target: Equatable {
        case list(Dest, spring: String?) // a gap in a list; `spring` is a closed folder to open
        case arming(String, hold: Dest?) // over the middle of a session, waiting to merge
        case merge(String, hold: Dest?)
        case card(Layout.Edge)
        case space(String)
        case folders(Int)

        // Where the gap stays while the pointer is elsewhere.
        var hold: Dest? {
            switch self {
            case .list(let d, _): return d
            case .arming(_, let h), .merge(_, let h): return h
            default: return nil
            }
        }
    }

    static private(set) var current: SidebarDrag?
    static var active: Bool { current != nil }

    static let threshold: CGFloat = 4
    static let springDelay: TimeInterval = 0.55
    static let mergeDelay: TimeInterval = 0.42
    static let settle: TimeInterval = 0.17

    let item: Item
    let origin: Dest? // where the dragged session came from (with its index)
    let originFolder: Int?
    private(set) var target: Target?
    private let window: NSWindow
    private let ghost: DragGhost
    private var mergeTimer: Timer?
    private var springTimer: Timer?
    private var springKey: String?
    private weak var card: CardView?
    private weak var hotTab: SpaceTab?
    private var pointer = NSPoint.zero // window coordinates
    // With no Favorites yet, their drop zone opens only when the pointer heads for the top of
    // the sidebar, so starting a drag never shifts the list under it.
    private(set) var nearFavorites = false

    var tid: String? { if case .tab(let t) = item { return t } else { return nil } }

    // ---- Tracking ---------------------------------------------------------------------------
    // Runs from a mouse-down on a row or tile. Returns false when the button came up before the
    // pointer moved far enough to be a drag: the mouse-up is put back, so the caller handles
    // the press as an ordinary click.
    static func track(_ item: Item, source: NSView, event: NSEvent) -> Bool {
        guard current == nil, let window = source.window else { return false }
        let start = event.locationInWindow
        var last = start
        var drag: SidebarDrag?
        NSEvent.startPeriodicEvents(afterDelay: 0.1, withPeriod: 0.03) // auto-scroll near the list's edges
        defer { NSEvent.stopPeriodicEvents() }
        while true {
            guard let e = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp, .keyDown, .periodic], until: .distantFuture, inMode: .eventTracking, dequeue: true) else { continue }
            switch e.type {
            case .leftMouseUp:
                guard let drag else {
                    window.postEvent(e, atStart: true)
                    return false
                }
                drag.finish(cancel: false)
                return true
            case .leftMouseDragged:
                last = e.locationInWindow
                if drag == nil {
                    guard hypot(last.x - start.x, last.y - start.y) >= threshold else { continue }
                    let d = SidebarDrag(item, source: source, start: start, window: window)
                    d.pointer = last
                    current = d
                    d.begin()
                    drag = d
                }
                drag?.update(last)
            case .periodic:
                // A release that never reached this window (another app or a system dialog
                // took it) would leave this loop, and Termorc, waiting forever.
                if NSEvent.pressedMouseButtons & 1 == 0 {
                    guard let drag else {
                        if let up = NSEvent.mouseEvent(with: .leftMouseUp, location: last, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                       windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 0) {
                            window.postEvent(up, atStart: true)
                        }
                        return false
                    }
                    drag.finish(cancel: false)
                    return true
                }
                if let drag, drag.autoscroll(last) { drag.update(last) }
            case .keyDown where e.keyCode == 53: // Esc
                guard let drag else { continue }
                drag.finish(cancel: true)
                // The button is still down: let its release go nowhere.
                _ = window.nextEvent(matching: .leftMouseUp, until: .distantFuture, inMode: .eventTracking, dequeue: true)
                return true
            default:
                break
            }
        }
    }

    private init(_ item: Item, source: NSView, start: NSPoint, window: NSWindow) {
        self.item = item
        self.window = window
        let store = Store.shared
        switch item {
        case .tab(let t):
            var o = store.locate(t)
            if let d = o { o?.index = SidebarDrag.list(d, store.model).firstIndex(of: t) ?? -1 }
            origin = o
            originFolder = nil
        case .folder(let s, let f):
            origin = nil
            originFolder = store.space(s)?.folders.firstIndex { $0.id == f }
        }
        ghost = DragGhost(source: source, grab: start)
    }

    private func begin() {
        Peek.shared.close()
        NSCursor.closedHand.push()
        ghost.show(in: window, at: pointer)
        syncViews()
    }

    private func update(_ p: NSPoint) {
        pointer = p
        ghost.move(to: p)
        if let strip = FavoritesStrip.current, tid != nil {
            let r = strip.convert(strip.bounds, to: nil)
            let near = p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY - 36
            if near != nearFavorites {
                nearFavorites = near
                strip.update()
            }
        }
        let t = hit(p)
        ghost.style = { () -> DragGhost.Style in
            switch t {
            case .card: return .overCard
            case .arming, .merge: return .overMerge
            default: return .lifted
            }
        }()
        armSpring(t)
        setTarget(t)
    }

    private func setTarget(_ t: Target?) {
        guard t != target else { return }
        target = t
        mergeTimer?.invalidate()
        if case .arming(let over, let hold) = t {
            mergeTimer = timer(Self.mergeDelay) { [weak self] in
                guard let self, self.target == t else { return }
                self.setTarget(.merge(over, hold: hold))
            }
        }
        syncViews()
    }

    // Hovering a closed folder opens it; hovering a Space in the Spaces bar switches to it.
    private func armSpring(_ t: Target?) {
        let store = Store.shared
        var key: String?
        if case .space(let s) = t, s != store.model.activeSpaceId { key = "space:\(s)" }
        if case .list(let d, let fid?) = t, let s = d.spaceId, store.space(s)?.folders.first(where: { $0.id == fid })?.open == false { key = "folder:\(s):\(fid)" }
        guard key != springKey else { return }
        springTimer?.invalidate()
        springKey = key
        guard let key else { return }
        springTimer = timer(Self.springDelay) { [weak self] in
            guard let self, self.springKey == key else { return }
            let parts = key.split(separator: ":").map(String.init)
            if parts[0] == "space" { store.switchSpace(parts[1]) } else { store.updateFolder(parts[1], parts[2]) { $0.open = true } }
        }
    }

    private func timer(_ delay: TimeInterval, _ fn: @escaping () -> Void) -> Timer {
        // Common modes: the tracking loop runs the run loop in event-tracking mode.
        let t = Timer(timeInterval: delay, repeats: false) { _ in MainActor.assumeIsolated { fn() } }
        RunLoop.main.add(t, forMode: .common)
        return t
    }

    // ---- Hit testing ------------------------------------------------------------------------
    private func hit(_ p: NSPoint) -> Target? {
        guard let root = window.contentView, let sup = root.superview, var v = root.hitTest(sup.convert(p, from: nil)) else { return nil }
        while true {
            if let tab = v as? SpaceTab { return tid == nil ? target : .space(tab.spaceId) }
            if let strip = v as? FavoritesStrip { return tid == nil ? target : .list(Dest(section: .fav, index: strip.dropIndex(at: p)), spring: nil) }
            if let o = v as? SidebarOutlineView, let list = o.list { return list.dropTarget(at: p, for: self) }
            if let c = v as? CardView {
                guard let tid, let tab = Store.shared.activeTab, tid != tab.id, let src = Store.shared.model.tabs[tid],
                      tab.layout.leaves.count + src.layout.leaves.count <= Layout.maxPanes, Store.shared.ui.view == .terminal else { return nil }
                card = c
                return .card(c.edge(for: c.convert(p, from: nil)))
            }
            // Gaps between the sidebar's sections keep the current target rather than flicker.
            if v.identifier == SidebarViewController.rootId { return target }
            guard let up = v.superview else { return nil }
            v = up
        }
    }

    // Scrolls the list under the pointer when it's near the list's top or bottom edge.
    private func autoscroll(_ p: NSPoint) -> Bool {
        guard let root = window.contentView, let sup = root.superview, var v = root.hitTest(sup.convert(p, from: nil)) else { return false }
        while !(v is SidebarScrollView) {
            guard let up = v.superview else { return false }
            v = up
        }
        let clip = (v as! SidebarScrollView).contentView
        let y = clip.convert(p, from: nil).y - clip.bounds.minY
        let edge: CGFloat = 28
        let dy: CGFloat = y < edge ? -(edge - y) / 3 : y > clip.bounds.height - edge ? (y - clip.bounds.height + edge) / 3 : 0
        guard dy != 0, let doc = clip.documentView else { return false }
        let maxY = max(0, doc.frame.height - clip.bounds.height)
        let ny = min(maxY, max(0, clip.bounds.origin.y + dy * (clip.isFlipped ? 1 : -1)))
        guard ny != clip.bounds.origin.y else { return false }
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: ny))
        (v as! SidebarScrollView).reflectScrolledClipView(clip)
        return true
    }

    // ---- Views ------------------------------------------------------------------------------
    // Every list shows the gap where the drop would land (or the origin while the pointer is
    // elsewhere), and the row, card edge or Space it would go to lights up.
    private func syncViews() {
        SpaceList.all.forEach { $0.showDrag(self) }
        FavoritesStrip.current?.update()
        if case .card(let e) = target, let card { card.showDrop(e, tid: tid ?? "") } else { card?.hideDrop() }
        var hot: SpaceTab?
        if case .space = target, let tab = hotTabUnderPointer() { hot = tab }
        if hot !== hotTab {
            hotTab?.dropHot = false
            hot?.dropHot = true
            hotTab = hot
        }
    }

    private func hotTabUnderPointer() -> SpaceTab? {
        guard let root = window.contentView, let sup = root.superview, case .space(let id) = target else { return nil }
        let p = sup.convert(pointer, from: nil)
        var v = root.hitTest(p)
        while let cur = v, !(cur is SpaceTab) { v = cur.superview }
        return (v as? SpaceTab)?.spaceId == id ? v as? SpaceTab : nil
    }

    // The gap a list shows: the target's, or the origin's while there's none.
    var gap: Dest? {
        if let h = target?.hold { return h }
        if case .folders = target { return nil }
        return origin
    }

    var folderGap: Int? {
        if case .folders(let i) = target { return i }
        return originFolder
    }

    // ---- Drop -------------------------------------------------------------------------------
    private func finish(cancel: Bool) {
        mergeTimer?.invalidate()
        springTimer?.invalidate()
        NSCursor.pop()
        let store = Store.shared
        var t = cancel ? nil : target
        if case .arming(_, let hold) = t { t = hold.map { .list($0, spring: nil) } }
        // Fly into the gap (or onto the merge row); card and Space drops just fade.
        let landing: NSRect? = {
            switch t {
            case .merge(let over, _): return SpaceList.all.lazy.compactMap { $0.windowRect(ofTab: over) }.first
            case .card, .space: return nil
            default: return SpaceList.all.lazy.compactMap { $0.windowRectOfGap() }.first
            }
        }()
        if case .merge = t { ghost.style = .overMerge }
        ghost.land(at: landing, fade: landing == nil || { if case .merge = t { return true }; return false }()) { [self] in
            switch (item, t) {
            case (.tab(let tid), .list(let d, _)?): store.moveTab(tid, to: d)
            case (.tab(let tid), .merge(let over, _)?): store.mergeTabs(tid, into: over)
            case (.tab(let tid), .card(let e)?): store.mergeIntoActive(tid, edge: e)
            case (.tab(let tid), .space(let s)?): store.moveTab(tid, to: Dest(section: store.locate(tid)?.section == .pinned ? .pinned : .today, spaceId: s))
            case (.folder(let s, let f), .folders(let i)?): store.moveFolder(s, f, to: i)
            default: break
            }
            Self.current = nil
            card?.hideDrop()
            hotTab?.dropHot = false
            SpaceList.all.forEach { $0.showDrag(nil) }
            FavoritesStrip.current?.update()
        }
    }

    // The tabs of a list, as the model has them.
    static func list(_ d: Dest, _ s: AppModel) -> [String] {
        if d.section == .fav { return s.favorites }
        guard let sp = s.spaces.first(where: { $0.id == d.spaceId }) else { return [] }
        if let f = d.folderId { return sp.folders.first { $0.id == f }?.tabs ?? [] }
        return d.section == .pinned ? sp.pinned : sp.today
    }

    // Two sessions fit in one split.
    static func canMerge(_ src: String, into target: String) -> Bool {
        let tabs = Store.shared.model.tabs
        guard let a = tabs[src], let b = tabs[target], src != target else { return false }
        return a.layout.leaves.count + b.layout.leaves.count <= Layout.maxPanes
    }
}

// The lifted row: a snapshot of it that follows the pointer, raised with a shadow and an
// accent ring; it shrinks over the card and nearly vanishes into a row it would merge with.
@MainActor
final class DragGhost: NSView {
    enum Style { case lifted, overCard, overMerge }

    private let card = CALayer()
    private let grab: NSPoint // where in the row the pointer took hold
    private let size: NSSize

    var style: Style = .lifted {
        didSet { if style != oldValue { applyStyle(animated: true) } }
    }

    init(source: NSView, grab start: NSPoint) {
        let b = source.bounds
        size = b.size
        let local = source.convert(start, from: nil)
        grab = NSPoint(x: local.x - b.minX, y: source.isFlipped ? b.maxY - local.y : local.y - b.minY)
        super.init(frame: .zero)
        wantsLayer = true
        let img = NSImage(size: b.size)
        if let rep = source.bitmapImageRepForCachingDisplay(in: b) {
            source.cacheDisplay(in: b, to: rep)
            img.addRepresentation(rep)
        }
        card.contents = img
        card.contentsGravity = .resize
        card.bounds = CGRect(origin: .zero, size: b.size)
        card.cornerRadius = 8
        card.cornerCurve = .continuous
        card.masksToBounds = false
        card.shadowColor = NSColor.black.cgColor
        card.shadowOffset = CGSize(width: 0, height: -10)
        card.borderWidth = 1
        layer?.addSublayer(card)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func show(in window: NSWindow, at p: NSPoint) {
        guard let root = window.contentView else { return }
        frame = root.bounds
        autoresizingMask = [.width, .height]
        root.addSubview(self, positioned: .above, relativeTo: nil)
        effectiveAppearance.performAsCurrentDrawingAppearance {
            card.backgroundColor = NSColor.controlBackgroundColor.cgColor
            card.borderColor = UI.accent().cgColor
        }
        move(to: p, animated: false)
        applyStyle(animated: false)
        // Lift: grow slightly and gain the shadow.
        DispatchQueue.main.async { [weak self] in self?.applyStyle(animated: true, lift: true) }
    }

    func move(to p: NSPoint, animated: Bool = false) {
        let q = convert(p, from: nil)
        CATransaction.begin()
        CATransaction.setDisableActions(!animated)
        card.position = CGPoint(x: q.x - grab.x + size.width / 2, y: q.y - grab.y + size.height / 2)
        CATransaction.commit()
    }

    private var lifted = false

    private func applyStyle(animated: Bool, lift: Bool = false) {
        if lift { lifted = true }
        CATransaction.begin()
        CATransaction.setAnimationDuration(animated ? 0.16 : 0)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1))
        switch style {
        case .lifted:
            card.transform = lifted ? CATransform3DMakeScale(1.03, 1.03, 1) : CATransform3DIdentity
            card.opacity = 1
        case .overCard:
            card.transform = CATransform3DMakeScale(0.94, 0.94, 1)
            card.opacity = 0.85
        case .overMerge:
            card.transform = CATransform3DConcat(CATransform3DMakeScale(0.6, 0.6, 1), CATransform3DMakeTranslation(18, -12, 0))
            card.opacity = 0.2
        }
        card.shadowOpacity = lifted ? 0.3 : 0.1
        card.shadowRadius = lifted ? 16 : 3
        card.borderWidth = lifted ? 1 : 0
        CATransaction.commit()
    }

    // Settles into `rect` (window coordinates) or fades where it is, then removes itself.
    func land(at rect: NSRect?, fade: Bool, then done: @escaping () -> Void) {
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        CATransaction.begin()
        CATransaction.setAnimationDuration(reduce ? 0 : SidebarDrag.settle)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1))
        CATransaction.setCompletionBlock { [weak self] in
            MainActor.assumeIsolated {
                self?.removeFromSuperview()
                done()
            }
        }
        if let rect {
            let r = convert(rect, from: nil)
            card.position = CGPoint(x: r.midX, y: r.midY)
        }
        if fade || rect == nil {
            card.opacity = 0
            if rect == nil { card.transform = CATransform3DMakeScale(0.9, 0.9, 1) }
        } else {
            card.transform = CATransform3DIdentity
            card.shadowOpacity = 0.1
            card.shadowRadius = 3
            card.borderWidth = 0
        }
        CATransaction.commit()
    }
}
