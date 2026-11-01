import Foundation

// What Termorc hands the desktop widgets (Sources/TermorcWidgets). WidgetKit sandboxes the
// widget extension, so it can't run lsof, ps or gh; the app collects everything, writes one
// JSON snapshot per widget into `WidgetStore.dir` and asks WidgetKit to redraw. The extension's
// entitlements let it read that one folder.
public enum WidgetStore {
    public static let localhostKind = "termorc.localhost"
    public static let systemKind = "termorc.system"
    public static let pullsKind = "termorc.pulls"
    public static let kinds = [localhostKind, systemKind, pullsKind]

    // Widget → app: buttons post this distributed notification with "verb:argument" as the
    // object (a sandboxed sender can't attach userInfo). See WidgetFeed.handle.
    public static let actionNotification = "com.termorc.widget.action"

    // Fixed (TERMORC_DATA_DIR doesn't move it): the sandbox exception in
    // Resources/widgets/TermorcWidgets.entitlements names this path.
    public static let dir: URL = realHome.appendingPathComponent("Library/Application Support/Termorc/widgets")
    public static var avatars: URL { dir.appendingPathComponent("avatars") }

    // Inside the sandbox NSHomeDirectory() is the extension's container; this is the user's.
    public static var realHome: URL {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { return URL(fileURLWithPath: String(cString: dir)) }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    static func file(_ kind: String) -> URL { dir.appendingPathComponent("\(kind).json") }

    public static func write<T: Encodable>(_ value: T, kind: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? Persistence.writeAtomic(file(kind), data)
    }

    public static func read<T: Decodable>(_ type: T.Type, kind: String) -> T? {
        guard let data = try? Data(contentsOf: file(kind)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

// Whether Termorc is feeding the widgets; false after a clean quit.
public struct FeedStatus: Codable, Sendable {
    public var running: Bool
    public var at: Date

    public init(running: Bool, at: Date = Date()) {
        self.running = running
        self.at = at
    }

    public static let kind = "feed"
}

// ---- Localhost ----------------------------------------------------------------------------

public struct LocalServer: Codable, Equatable, Sendable {
    public var port: Int
    public var pid: Int32
    public var command: String // process name, as lsof +c 0 reports it
    public var cwd: String
    public var args: String
    public var started: Date
    public var rssKB: Int

    public init(port: Int, pid: Int32, command: String, cwd: String, args: String, started: Date, rssKB: Int) {
        self.port = port
        self.pid = pid
        self.command = command
        self.cwd = cwd
        self.args = args
        self.started = started
        self.rssKB = rssKB
    }

    public var hasProject: Bool { !cwd.isEmpty && cwd != "/" }
    public var project: String { hasProject ? (cwd as NSString).lastPathComponent : command }
    public var url: String { "http://localhost:\(port)" }
    public var framework: Framework { Framework.detect(command, args) }
}

public struct LocalhostSnapshot: Codable, Sendable {
    public var at: Date
    public var servers: [LocalServer]

    public init(at: Date = Date(), servers: [LocalServer]) {
        self.at = at
        self.servers = servers
    }
}

public struct Framework: Equatable, Sendable {
    public let label: String
    public let glyph: String

    // First match wins, so the specific tools sit above the runtimes they run on.
    static let known: [(String, String, String)] = [
        (#"next(-server|/dist| dev| start|$)"#, "Next.js", "N"),
        ("nuxt", "Nuxt", "N"),
        ("astro", "Astro", "A"),
        ("remix", "Remix", "R"),
        ("svelte", "SvelteKit", "S"),
        ("storybook", "Storybook", "SB"),
        ("vite", "Vite", "V"),
        ("@nestjs|nest start", "NestJS", "N"),
        ("react-scripts", "React", "R"),
        ("expo|metro", "Expo", "E"),
        ("webpack", "Webpack", "W"),
        (#"artisan serve"#, "Laravel", "L"),
        (#"manage\.py runserver"#, "Django", "dj"),
        ("uvicorn|fastapi", "FastAPI", "F"),
        ("flask", "Flask", "F"),
        (#"http\.server"#, "Python HTTP", "Py"),
        ("rails|puma", "Rails", "R"),
        (#"\bbun\b"#, "Bun", "B"),
        (#"\bdeno\b"#, "Deno", "D"),
        (#"\bphp\b"#, "PHP", "P"),
        ("(?i)python", "Python", "Py"),
        (#"\bnode\b"#, "Node.js", "JS"),
        ("java", "Java", "J"),
        (#"\bgo\b|/go-build"#, "Go", "Go"),
    ]

    public static func detect(_ command: String, _ args: String) -> Framework {
        let hay = "\(command) \(args)"
        for (re, label, glyph) in known where hay.range(of: re, options: .regularExpression) != nil {
            return Framework(label: label, glyph: glyph)
        }
        return Framework(label: command, glyph: command.first.map { String($0).uppercased() } ?? "?")
    }
}

// ---- System -------------------------------------------------------------------------------

public struct SystemSnapshot: Codable, Sendable {
    public var at: Date
    public var model: String // "MacBook Pro"
    public var chip: String // "M3 Pro"
    public var bootedAt: Date
    public var cpu: Int // percent
    public var memory: Int // percent
    public var diskUsed: Int // percent
    public var diskFree: Int64 // bytes
    public var battery: Int? // percent; nil without a battery
    public var charging: Bool // on AC power
    public var remaining: Int? // minutes on battery, when macOS has an estimate
    public var network: String? // "Wi-Fi", "Ethernet"; nil when offline
    public var ping: Int? // ms to 1.1.1.1
    public var lan: String?
    public var wan: String?
    public var down: [Double] // bytes/s, oldest first
    public var up: [Double]

    public init(at: Date = Date(), model: String, chip: String, bootedAt: Date, cpu: Int, memory: Int, diskUsed: Int, diskFree: Int64,
                battery: Int?, charging: Bool, remaining: Int?, network: String?, ping: Int?, lan: String?, wan: String?, down: [Double], up: [Double]) {
        self.at = at
        self.model = model
        self.chip = chip
        self.bootedAt = bootedAt
        self.cpu = cpu
        self.memory = memory
        self.diskUsed = diskUsed
        self.diskFree = diskFree
        self.battery = battery
        self.charging = charging
        self.remaining = remaining
        self.network = network
        self.ping = ping
        self.lan = lan
        self.wan = wan
        self.down = down
        self.up = up
    }
}

// ---- Pull requests ------------------------------------------------------------------------

public struct PullRequest: Codable, Equatable, Sendable {
    public var number: Int
    public var title: String
    public var url: String
    public var repo: String
    public var author: String
    public var avatarURL: String
    public var isDraft: Bool
    public var updatedAt: Date
    public var additions: Int
    public var deletions: Int
    public var comments: Int
    public var review: String? // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED
    public var checks: String? // SUCCESS | FAILURE | ERROR | PENDING | EXPECTED

    public init(number: Int, title: String, url: String, repo: String, author: String, avatarURL: String, isDraft: Bool, updatedAt: Date,
                additions: Int, deletions: Int, comments: Int, review: String?, checks: String?) {
        self.number = number
        self.title = title
        self.url = url
        self.repo = repo
        self.author = author
        self.avatarURL = avatarURL
        self.isDraft = isDraft
        self.updatedAt = updatedAt
        self.additions = additions
        self.deletions = deletions
        self.comments = comments
        self.review = review
        self.checks = checks
    }

    // Where WidgetFeed saves the author's avatar; widgets can't load remote images.
    public var avatarFile: URL { WidgetStore.avatars.appendingPathComponent(Persistence.safeId(author) + ".png") }
}

public struct PullList: Codable, Equatable, Sendable {
    public var total: Int
    public var items: [PullRequest]

    public init(total: Int, items: [PullRequest]) {
        self.total = total
        self.items = items
    }
}

public struct PullsSnapshot: Codable, Sendable {
    public var at: Date // last fetch attempt
    public var fetchedAt: Date? // last successful fetch
    public var problem: String? // why the last fetch failed, for the empty state
    public var review: PullList?
    public var mine: PullList?

    public init(at: Date = Date(), fetchedAt: Date?, problem: String?, review: PullList?, mine: PullList?) {
        self.at = at
        self.fetchedAt = fetchedAt
        self.problem = problem
        self.review = review
        self.mine = mine
    }
}
