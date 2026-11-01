import Foundation

// Archived sessions: a small JSON index plus one ANSI scrollback file per session
// (library/index.json, library/<id>.ans). Full-text search
// reads scrollback lazily and keeps a bounded cache of stripped, lowercased text.
public struct LibraryEntry: Codable, Equatable, Sendable, Identifiable {
    public struct Cmd: Codable, Equatable, Sendable {
        public var cmd: String
        public var exit: Int?
        public var at: Millis?
        public init(cmd: String, exit: Int?, at: Millis?) {
            self.cmd = cmd
            self.exit = exit
            self.at = at
        }
    }

    public var id: String
    public var name: String
    public var spaceId: String?
    public var spaceName: String
    public var cwd: String
    public var host: String
    public var status: String // idle | ok | fail
    public var exitCode: Int?
    public var startedAt: Millis
    public var endedAt: Millis
    public var idleSince: Millis
    public var reason: String // idle | closed
    public var commands: [Cmd]
    public var lines: Int
    public var bytes: Int?
    public var hit: String? // search results only: name | command | path | output

    public init(id: String, name: String, spaceId: String?, spaceName: String, cwd: String, host: String, status: String, exitCode: Int?, startedAt: Millis, endedAt: Millis, idleSince: Millis, reason: String, commands: [Cmd], lines: Int) {
        self.id = id
        self.name = name
        self.spaceId = spaceId
        self.spaceName = spaceName
        self.cwd = cwd
        self.host = host
        self.status = status
        self.exitCode = exitCode
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.idleSince = idleSince
        self.reason = reason
        self.commands = commands
        self.lines = lines
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.v(.id, "")
        name = c.v(.name, "")
        spaceId = c.opt(.spaceId)
        spaceName = c.v(.spaceName, "")
        cwd = c.v(.cwd, "")
        host = c.v(.host, "local")
        status = c.v(.status, "idle")
        exitCode = c.opt(.exitCode)
        startedAt = c.v(.startedAt, 0)
        endedAt = c.v(.endedAt, 0)
        idleSince = c.v(.idleSince, endedAt)
        reason = c.v(.reason, "closed")
        commands = c.v(.commands, [])
        lines = c.v(.lines, 0)
        bytes = c.opt(.bytes)
        hit = nil
    }
}

public struct LibraryQuery: Sendable {
    public var q = ""
    public var spaceId: String?
    public var cwd: String?
    public var host: String?
    public var status: String?
    public var sinceDays: Double?
    public init(q: String = "", spaceId: String? = nil, cwd: String? = nil, host: String? = nil, status: String? = nil, sinceDays: Double? = nil) {
        self.q = q
        self.spaceId = spaceId
        self.cwd = cwd
        self.host = host
        self.status = status
        self.sinceDays = sinceDays
    }
}

public final class Library: @unchecked Sendable {
    static let ansi = try! NSRegularExpression(pattern: "\\u001b\\[[0-?]*[ -/]*[@-~]|\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)|\\u001b[()][0-9A-Za-z]|\\u001b[=>78]")
    static let cacheLimit = 24 * 1024 * 1024
    static let dayMs = 86_400_000.0

    private let dir: URL
    private let lock = NSLock()
    private(set) var entries: [LibraryEntry]
    private let writer: DebouncedWriter
    private var cache: [String: String] = [:]
    private var order: [String] = []
    private var cacheSize = 0

    public init(dir: URL) {
        self.dir = dir
        let index = dir.appendingPathComponent("index.json")
        entries = (try? JSONDecoder().decode([Lenient<LibraryEntry>].self, from: Data(contentsOf: index)))?.compactMap(\.value) ?? []
        writer = DebouncedWriter(url: index, delay: 0.3)
    }

    private func file(_ id: String) -> URL { dir.appendingPathComponent(Persistence.safeId(id) + ".ans") }

    private func saveIndex() {
        let clean = entries.map { var e = $0; e.hit = nil; return e }
        if let data = try? JSONEncoder().encode(clean) { writer.save(data) }
    }

    public var count: Int { lock.withLock { entries.count } }

    public func add(_ entry: LibraryEntry, ansi: String) {
        lock.withLock {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? Data(ansi.utf8).write(to: file(entry.id))
            entries.removeAll { $0.id == entry.id }
            var e = entry
            e.bytes = ansi.utf16.count
            entries.insert(e, at: 0)
            dropCache(entry.id)
            saveIndex()
        }
    }

    public func remove(_ id: String) {
        lock.withLock { removeLocked(id) }
    }

    private func removeLocked(_ id: String) {
        entries.removeAll { $0.id == id }
        saveIndex()
        dropCache(id)
        try? FileManager.default.removeItem(at: file(id))
    }

    public func content(_ id: String) -> String {
        (try? Data(contentsOf: file(id))).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }

    // Drops entries that ended more than `days` ago (0 keeps everything).
    public func prune(days: Double) {
        guard days > 0 else { return }
        let cutoff = Double(nowMillis()) - days * Self.dayMs
        lock.withLock {
            for e in entries where Double(e.endedAt) < cutoff { removeLocked(e.id) }
        }
    }

    private func dropCache(_ id: String) {
        if let t = cache.removeValue(forKey: id) {
            cacheSize -= t.utf8.count
            order.removeAll { $0 == id }
        }
    }

    private func text(_ id: String) -> String {
        if let t = cache[id] {
            order.removeAll { $0 == id }
            order.append(id)
            return t
        }
        let raw = content(id)
        let t = Self.ansi.stringByReplacingMatches(in: raw, range: NSRange(location: 0, length: (raw as NSString).length), withTemplate: "").lowercased()
        cache[id] = t
        cacheSize += t.utf8.count
        order.append(id)
        while cacheSize > Self.cacheLimit, let old = order.first {
            order.removeFirst()
            if let v = cache.removeValue(forKey: old) { cacheSize -= v.utf8.count }
        }
        return t
    }

    public func search(_ query: LibraryQuery) -> (total: Int, results: [LibraryEntry]) {
        lock.withLock {
            let q = query.q.trimmingCharacters(in: .whitespaces).lowercased()
            let since = (query.sinceDays ?? 0) > 0 ? Double(nowMillis()) - query.sinceDays! * Self.dayMs : 0
            func set(_ s: String?) -> String? { s?.isEmpty == false ? s : nil }
            var out: [LibraryEntry] = []
            for e in entries {
                if let v = set(query.spaceId), e.spaceId != v { continue }
                if let v = set(query.cwd), e.cwd != v { continue }
                if let v = set(query.host), (e.host.isEmpty ? "local" : e.host) != v { continue }
                if let v = set(query.status), e.status != v { continue }
                if since > 0, Double(e.endedAt) < since { continue }
                if q.isEmpty {
                    out.append(e)
                } else {
                    let hit: String?
                    if e.name.lowercased().contains(q) { hit = "name" }
                    else if e.commands.contains(where: { $0.cmd.lowercased().contains(q) }) { hit = "command" }
                    else if e.cwd.lowercased().contains(q) || e.host.lowercased().contains(q) { hit = "path" }
                    else { hit = text(e.id).contains(q) ? "output" : nil }
                    if let hit {
                        var r = e
                        r.hit = hit
                        out.append(r)
                    }
                }
                if out.count >= 500 { break }
            }
            return (entries.count, out)
        }
    }

    public func flush() { writer.flush(seal: true) }
}
