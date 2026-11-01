import Foundation

// Finds the shell integration's OSC 633 marks in PTY output. The terminal is fed up to the
// end of each mark before the mark is handled, so the cursor position read then is exactly
// where the shell was when it printed it. A mark split across reads is held back until the
// rest arrives.
public struct MarkScanner {
    public enum Piece: Equatable {
        case bytes([UInt8])
        case mark(String) // payload after "633;", e.g. "A", "D;0", "P;Cwd=/tmp"
    }

    static let intro: [UInt8] = [0x1B, 0x5D, 0x36, 0x33, 0x33, 0x3B] // ESC ] 6 3 3 ;
    static let maxHeld = 8192

    private var held: [UInt8] = []

    public init() {}

    public mutating func scan(_ chunk: ArraySlice<UInt8>) -> [Piece] {
        var data = held
        held.removeAll(keepingCapacity: true)
        data.append(contentsOf: chunk)
        var out: [Piece] = []
        var segStart = 0
        var i = 0
        let n = data.count
        while i < n {
            guard data[i] == 0x1B else { i += 1; continue }
            // How much of the intro matches here.
            var k = 0
            while k < Self.intro.count, i + k < n, data[i + k] == Self.intro[k] { k += 1 }
            if k < Self.intro.count {
                if i + k == n {
                    // The data ends partway into what may be an intro: hold the tail.
                    if i > segStart { out.append(.bytes(Array(data[segStart..<i]))) }
                    held = Array(data[i..<n])
                    return out
                }
                i += 1
                continue
            }
            // Payload up to BEL or ST (ESC \).
            var j = i + k
            var end: Int?
            var payloadEnd = j
            while j < n {
                if data[j] == 0x07 { payloadEnd = j; end = j + 1; break }
                if data[j] == 0x1B {
                    if j + 1 == n { break }
                    if data[j + 1] == 0x5C { payloadEnd = j; end = j + 2; break }
                }
                j += 1
            }
            guard let end else {
                if n - i <= Self.maxHeld {
                    if i > segStart { out.append(.bytes(Array(data[segStart..<i]))) }
                    held = Array(data[i..<n])
                    return out
                }
                // Not a mark after all (no terminator in sight): pass it through.
                i += 1
                continue
            }
            out.append(.bytes(Array(data[segStart..<end])))
            out.append(.mark(String(decoding: data[(i + k)..<payloadEnd], as: UTF8.self)))
            segStart = end
            i = end
        }
        if segStart < n { out.append(.bytes(Array(data[segStart..<n]))) }
        return out
    }
}
