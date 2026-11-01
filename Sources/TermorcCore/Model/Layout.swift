import Foundation
import CoreGraphics

// Split layouts are binary trees: a leaf holds one session id, a split holds two children
// laid out in a row (side by side) or column (stacked) with a ratio. JSON shape matches the
// web build: {"sid": …} or {"dir": "row"|"col", "ratio": …, "a": …, "b": …}.
public indirect enum Layout: Equatable, Codable, Sendable {
    case leaf(String)
    case split(dir: Dir, ratio: Double, a: Layout, b: Layout)

    public enum Dir: String, Codable, Sendable { case row, col }
    public enum Edge: String, Sendable { case left, right, top, bottom }
    public enum Direction: String, Sendable { case left, right, up, down }
    public enum Step: String, Codable, Sendable { case a, b }

    public static let maxPanes = 4

    private enum K: String, CodingKey { case sid, dir, ratio, a, b }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        if let sid = try c.decodeIfPresent(String.self, forKey: .sid) {
            self = .leaf(sid)
            return
        }
        self = .split(
            dir: c.v(.dir, .row),
            ratio: c.v(.ratio, 0.5),
            a: try c.decode(Layout.self, forKey: .a),
            b: try c.decode(Layout.self, forKey: .b)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case .leaf(let sid):
            try c.encode(sid, forKey: .sid)
        case let .split(dir, ratio, a, b):
            try c.encode(dir, forKey: .dir)
            try c.encode(ratio, forKey: .ratio)
            try c.encode(a, forKey: .a)
            try c.encode(b, forKey: .b)
        }
    }

    public var leaves: [String] {
        switch self {
        case .leaf(let sid): return [sid]
        case let .split(_, _, a, b): return a.leaves + b.leaves
        }
    }

    // Insert `sid` next to `target`; `edge` is where the new pane goes.
    public func inserting(_ sid: String, nextTo target: String, edge: Edge = .right) -> Layout {
        guard leaves.count < Layout.maxPanes else { return self }
        let dir: Dir = edge == .left || edge == .right ? .row : .col
        let first = edge == .left || edge == .top
        func walk(_ n: Layout) -> Layout {
            switch n {
            case .leaf(let s):
                guard s == target else { return n }
                return first ? .split(dir: dir, ratio: 0.5, a: .leaf(sid), b: n) : .split(dir: dir, ratio: 0.5, a: n, b: .leaf(sid))
            case let .split(d, r, a, b):
                return .split(dir: d, ratio: r, a: walk(a), b: walk(b))
            }
        }
        return walk(self)
    }

    // Put a whole subtree on one edge of the card (dragging a session onto it).
    public func insertingRoot(_ sub: Layout, edge: Edge = .right) -> Layout {
        guard leaves.count + sub.leaves.count <= Layout.maxPanes else { return self }
        let dir: Dir = edge == .left || edge == .right ? .row : .col
        let first = edge == .left || edge == .top
        return first ? .split(dir: dir, ratio: 0.5, a: sub, b: self) : .split(dir: dir, ratio: 0.5, a: self, b: sub)
    }

    public func removing(_ sid: String) -> Layout? {
        switch self {
        case .leaf(let s):
            return s == sid ? nil : self
        case let .split(d, r, a, b):
            let na = a.removing(sid)
            let nb = b.removing(sid)
            guard let na else { return nb }
            guard let nb else { return na }
            return .split(dir: d, ratio: r, a: na, b: nb)
        }
    }

    // Ratio of the split node at `path` (a/b steps from the root).
    public func settingRatio(_ ratio: Double, at path: [Step]) -> Layout {
        guard case let .split(d, r, a, b) = self else { return self }
        guard let step = path.first else { return .split(dir: d, ratio: ratio, a: a, b: b) }
        let rest = Array(path.dropFirst())
        return step == .a ? .split(dir: d, ratio: r, a: a.settingRatio(ratio, at: rest), b: b)
                          : .split(dir: d, ratio: r, a: a, b: b.settingRatio(ratio, at: rest))
    }

    public static func snapRatio(_ r: Double) -> Double {
        for s in [1.0 / 3, 0.5, 2.0 / 3] where abs(r - s) < 0.025 { return s }
        return min(0.85, max(0.15, r))
    }

    // Pane rectangles as fractions of the card (used for focus movement).
    public func rects() -> [String: CGRect] {
        var out: [String: CGRect] = [:]
        func walk(_ n: Layout, _ f: CGRect) {
            switch n {
            case .leaf(let sid): out[sid] = f
            case let .split(dir, ratio, a, b):
                if dir == .row {
                    walk(a, CGRect(x: f.minX, y: f.minY, width: f.width * ratio, height: f.height))
                    walk(b, CGRect(x: f.minX + f.width * ratio, y: f.minY, width: f.width * (1 - ratio), height: f.height))
                } else {
                    walk(a, CGRect(x: f.minX, y: f.minY, width: f.width, height: f.height * ratio))
                    walk(b, CGRect(x: f.minX, y: f.minY + f.height * ratio, width: f.width, height: f.height * (1 - ratio)))
                }
            }
        }
        walk(self, CGRect(x: 0, y: 0, width: 1, height: 1))
        return out
    }

    // The pane in `direction` from `sid` whose centre is nearest (y grows downward).
    public func neighbor(of sid: String, _ direction: Direction) -> String? {
        let all = rects()
        guard let from = all[sid] else { return nil }
        let (cx, cy) = (from.midX, from.midY)
        var best: String?
        var bestD = Double.infinity
        for id in leaves where id != sid {
            guard let r = all[id] else { continue }
            let (ox, oy) = (r.midX, r.midY)
            let ok: Bool
            switch direction {
            case .left: ok = ox < cx - 1e-6
            case .right: ok = ox > cx + 1e-6
            case .up: ok = oy < cy - 1e-6
            case .down: ok = oy > cy + 1e-6
            }
            guard ok else { continue }
            let d = hypot(ox - cx, oy - cy)
            if d < bestD {
                bestD = d
                best = id
            }
        }
        return best
    }
}
