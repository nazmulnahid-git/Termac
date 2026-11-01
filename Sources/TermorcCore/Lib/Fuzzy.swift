import Foundation

// Subsequence fuzzy matcher. Scores contiguous runs and word starts higher and returns the
// matched character indices for highlighting.
public enum Fuzzy {
    public struct Match: Equatable {
        public let score: Double
        public let indices: [Int]
    }

    static func boundary(_ c: Character) -> Bool { c.isWhitespace || "/._-@:·".contains(c) }

    public static func match(_ query: String, _ text: String) -> Match? {
        if query.isEmpty { return Match(score: 0, indices: []) }
        let q = Array(query.lowercased())
        let t = Array(text.lowercased())

        // A plain substring always wins and is cheap to find.
        if let r = text.lowercased().range(of: query.lowercased()) {
            let at = text.lowercased().distance(from: text.lowercased().startIndex, to: r.lowerBound)
            let start = at == 0 || boundary(t[at - 1])
            let score = 100 + Double(q.count) * 4 + (start ? 30 : 0) - Double(at) * 0.5 - Double(t.count) * 0.05
            return Match(score: score, indices: Array(at..<(at + q.count)))
        }

        var score = 0.0
        var ti = 0
        var prev = -2
        var indices: [Int] = []
        for ch in q where ch != " " {
            var found = -1
            while ti < t.count {
                if t[ti] == ch { found = ti; ti += 1; break }
                ti += 1
            }
            if found == -1 { return nil }
            indices.append(found)
            score += 1
            if found == prev + 1 { score += 5 }
            if found == 0 || boundary(t[found - 1]) { score += 8 }
            prev = found
        }
        return Match(score: score - Double(t.count) * 0.05, indices: indices)
    }
}
