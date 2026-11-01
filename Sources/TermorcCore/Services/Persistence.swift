import Foundation

// Where Termorc keeps its files. The same locations the web build used, so sessions,
// scrollback, the Library and settings.json carry straight over.
public struct Paths: Sendable {
    public let dataDir: URL // ~/Library/Application Support/Termorc
    public let stateFile: URL
    public let scrollback: URL
    public let library: URL
    public let settingsDir: URL // ~/.termorc
    public let settingsFile: URL
    public let schemaFile: URL

    public static let current = Paths()

    init() {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        let support = home.appendingPathComponent("Library/Application Support")
        // TERMORC_DATA_DIR keeps a development build off your everyday sessions and settings.
        let custom = ProcessInfo.processInfo.environment["TERMORC_DATA_DIR"].map { URL(fileURLWithPath: $0) }
        dataDir = custom ?? support.appendingPathComponent("Termorc")
        stateFile = dataDir.appendingPathComponent("state.json")
        scrollback = dataDir.appendingPathComponent("scrollback")
        library = dataDir.appendingPathComponent("library")
        settingsDir = custom.map { $0.appendingPathComponent("settings") } ?? home.appendingPathComponent(".termorc")
        settingsFile = settingsDir.appendingPathComponent("settings.json")
        schemaFile = settingsDir.appendingPathComponent("settings.schema.json")

        // The app was called Termac before; carry its data over on first launch.
        let legacy = support.appendingPathComponent("Termac")
        if custom == nil, !fm.fileExists(atPath: stateFile.path), fm.fileExists(atPath: legacy.appendingPathComponent("state.json").path) {
            try? fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
            for name in ["state.json", "scrollback", "library"] {
                try? fm.copyItem(at: legacy.appendingPathComponent(name), to: dataDir.appendingPathComponent(name))
            }
        }
    }

    public func scrollbackFile(_ id: String) -> URL {
        scrollback.appendingPathComponent(Persistence.safeId(id) + ".ans")
    }
}

public enum Persistence {
    public static func safeId(_ id: String) -> String {
        String(id.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") })
    }

    // tmp + rename, so a crash mid-write never leaves a torn file.
    public static func writeAtomic(_ url: URL, _ data: Data) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(getpid()).tmp")
        try data.write(to: tmp)
        if FileManager.default.fileExists(atPath: url.path) {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        } else {
            try FileManager.default.moveItem(at: tmp, to: url)
        }
    }

    public static func loadState(_ paths: Paths = .current) -> AppModel {
        let data = try? Data(contentsOf: paths.stateFile)
        // Keep one copy of the state as the web build left it, in case this build reads it
        // differently; it's never overwritten afterwards.
        let backup = paths.dataDir.appendingPathComponent("state.web-backup.json")
        if let data, !FileManager.default.fileExists(atPath: backup.path) {
            try? data.write(to: backup)
        }
        return AppModel.migrate(data)
    }

    public static func readScrollback(_ id: String, _ paths: Paths = .current) -> String {
        guard let data = try? Data(contentsOf: paths.scrollbackFile(id)) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    public static func writeScrollback(_ id: String, _ text: String, _ paths: Paths = .current) {
        try? writeAtomic(paths.scrollbackFile(id), Data(text.utf8))
    }

    public static func removeScrollback(_ id: String, _ paths: Paths = .current) {
        try? FileManager.default.removeItem(at: paths.scrollbackFile(id))
    }
}

// Coalesces frequent saves into one write per `delay`, off the main thread. `flush` is for quit.
public final class DebouncedWriter: @unchecked Sendable {
    private let url: URL
    private let delay: TimeInterval
    private let queue = DispatchQueue(label: "termorc.writer")
    private let lock = NSLock()
    private var pending: Data?
    private var scheduled = false
    private var sealed = false

    public init(url: URL, delay: TimeInterval) {
        self.url = url
        self.delay = delay
    }

    public func save(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        guard !sealed else { return }
        pending = data
        guard !scheduled else { return }
        scheduled = true
        queue.asyncAfter(deadline: .now() + delay) { [self] in
            lock.lock()
            scheduled = false
            let data = pending
            pending = nil
            lock.unlock()
            if let data { try? Persistence.writeAtomic(url, data) }
        }
    }

    // Writes what's pending now; with `seal`, later saves are ignored (the state is final).
    public func flush(seal: Bool = false) {
        lock.lock()
        let data = pending
        pending = nil
        if seal { sealed = true }
        lock.unlock()
        queue.sync {
            if let data { try? Persistence.writeAtomic(url, data) }
        }
    }
}

extension Persistence {
    public static func writeIfChanged(_ url: URL, _ text: String) throws {
        if (try? String(contentsOf: url, encoding: .utf8)) == text { return }
        try writeAtomic(url, Data(text.utf8))
    }
}
