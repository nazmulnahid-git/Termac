import Foundation

// The persisted app model (state.json). Field names and shapes are kept as earlier
// versions wrote them, so their state files still restore.

public struct Look: Codable, Equatable, Sendable {
    public var bg: String? // nil = follow the theme, "tint" = Space color, or a hex color
    public var image: String? // background image file
    public var dim: Double = 0.6
    public var blur: Double = 0

    public init(bg: String? = nil, image: String? = nil, dim: Double = 0.6, blur: Double = 0) {
        self.bg = bg
        self.image = image
        self.dim = dim
        self.blur = blur
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bg = c.opt(.bg)
        image = c.opt(.image)
        dim = c.v(.dim, 0.6)
        blur = c.v(.blur, 0)
    }
}

public struct Folder: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var open = true
    public var tabs: [String] = []

    public init(id: String, name: String, open: Bool = true, tabs: [String] = []) {
        self.id = id
        self.name = name
        self.open = open
        self.tabs = tabs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.v(.id, uid("f"))
        name = c.v(.name, "Folder")
        open = c.v(.open, true)
        tabs = c.v(.tabs, [])
    }
}

public struct Space: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var glyph: String
    public var iconImage: String? // data URL of a picked image
    public var color: String
    public var startDir: String
    public var profileId: String?
    public var archiveAfterH: Double? // nil = the app setting
    public var term: Look
    public var pinned: [String]
    public var folders: [Folder]
    public var today: [String]
    public var activeTabId: String?

    public init(name: String = "Space", glyph: String = "◆", iconImage: String? = nil, color: String = "#3b82f6", startDir: String = "~", profileId: String? = nil) {
        id = uid("sp")
        self.name = name
        self.glyph = glyph
        self.iconImage = iconImage
        self.color = color
        self.startDir = startDir
        self.profileId = profileId
        archiveAfterH = nil
        term = Look()
        pinned = []
        folders = []
        today = []
        activeTabId = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.v(.id, uid("sp"))
        name = c.v(.name, "Space")
        glyph = c.v(.glyph, "◆")
        iconImage = c.opt(.iconImage)
        color = c.v(.color, "#3b82f6")
        startDir = c.v(.startDir, "~")
        profileId = c.opt(.profileId)
        archiveAfterH = c.opt(.archiveAfterH)
        term = c.v(.term, Look())
        pinned = c.v(.pinned, [])
        folders = c.v(.folders, [])
        today = c.v(.today, [])
        activeTabId = c.opt(.activeTabId)
    }

    // Pinned (loose, then each folder's) and Today, in sidebar order.
    public var allTabs: [String] { pinned + folders.flatMap(\.tabs) + today }
}

// A sidebar row: one or more panes in a split layout.
public struct Tab: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String?
    public var layout: Layout
    public var activeSid: String
    public var effects: [String: Bool] // danger, confirmPaste, noArchive
    public var createdAt: Millis
    public var icon: String? // TAB_ICONS id, or an emoji from older builds
    public var color: String? // tint for the row

    public init(id: String, name: String? = nil, layout: Layout, activeSid: String, effects: [String: Bool] = [:], createdAt: Millis = nowMillis()) {
        self.id = id
        self.name = name
        self.layout = layout
        self.activeSid = activeSid
        self.effects = effects
        self.createdAt = createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.v(.id, uid("t"))
        name = c.opt(.name)
        layout = try c.decode(Layout.self, forKey: .layout)
        activeSid = c.v(.activeSid, layout.leaves.first ?? "")
        effects = c.v(.effects, [:])
        createdAt = c.v(.createdAt, nowMillis())
        icon = c.opt(.icon)
        color = c.opt(.color)
    }

    public func has(_ effect: String) -> Bool { effects[effect] == true }
}

public struct SessionMeta: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var cwd: String
    public var profileId: String?
    public var command: String
    public var createdAt: Millis

    public init(id: String, cwd: String, profileId: String?, command: String = "", createdAt: Millis = nowMillis()) {
        self.id = id
        self.cwd = cwd
        self.profileId = profileId
        self.command = command
        self.createdAt = createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.v(.id, "")
        cwd = c.v(.cwd, "")
        profileId = c.opt(.profileId)
        command = c.v(.command, "")
        createdAt = c.v(.createdAt, nowMillis())
    }
}

public struct Profile: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var command: String // empty = the login shell
    public var cwdMode: String // space | home | custom
    public var cwd: String
    public var env: [[String]] // [name, value] pairs
    public var startup: String

    public static let `default` = Profile(id: "default", name: "Login shell")

    public init(id: String = uid("p"), name: String, command: String = "", cwdMode: String = "space", cwd: String = "", env: [[String]] = [], startup: String = "") {
        self.id = id
        self.name = name
        self.command = command
        self.cwdMode = cwdMode
        self.cwd = cwd
        self.env = env
        self.startup = startup
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.v(.id, uid("p"))
        name = c.v(.name, "Profile")
        command = c.v(.command, "")
        cwdMode = c.v(.cwdMode, "space")
        cwd = c.v(.cwd, "")
        env = c.v(.env, [])
        startup = c.v(.startup, "")
    }

    public var envPairs: [(String, String)] {
        env.compactMap { $0.count >= 1 && !$0[0].isEmpty ? ($0[0], $0.count > 1 ? $0[1] : "") : nil }
    }
}

public struct Snippet: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var command: String
    public var spaceId: String?
    public var createdAt: Millis

    public init(id: String, name: String, command: String, spaceId: String?, createdAt: Millis) {
        self.id = id
        self.name = name
        self.command = command
        self.spaceId = spaceId
        self.createdAt = createdAt
    }
}

public struct RecentDir: Codable, Equatable, Sendable {
    public var path: String
    public var visits: Int
    public var last: Millis

    public init(path: String, visits: Int, last: Millis) {
        self.path = path
        self.visits = visits
        self.last = last
    }
}

// A long job that finished out of sight.
public struct Activity: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var sid: String
    public var spaceId: String
    public var command: String
    public var exit: Int
    public var dur: Millis
    public var at: Millis
    public var seen: Bool

    public init(id: String, sid: String, spaceId: String, command: String, exit: Int, dur: Millis, at: Millis, seen: Bool) {
        self.id = id
        self.sid = sid
        self.spaceId = spaceId
        self.command = command
        self.exit = exit
        self.dur = dur
        self.at = at
        self.seen = seen
    }
}

public struct AppModel: Codable, Equatable, Sendable {
    public var version = 2
    public var onboarded = false
    public var spaces: [Space]
    public var activeSpaceId: String
    public var favorites: [String] = []
    public var tabs: [String: Tab] = [:]
    public var sessions: [String: SessionMeta] = [:]
    public var settings = Settings()
    public var profiles: [Profile] = [.default]
    public var defaultProfileId = "default"
    public var snippets: [Snippet] = []
    public var recentDirs: [RecentDir] = []
    public var activity: [Activity] = []

    public static func initial() -> AppModel {
        let home = Space(name: "Home", glyph: "◆", color: "#3b82f6")
        return AppModel(spaces: [home], activeSpaceId: home.id)
    }

    init(spaces: [Space], activeSpaceId: String) {
        self.spaces = spaces
        self.activeSpaceId = activeSpaceId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let base = AppModel.initial()
        version = c.v(.version, 2)
        onboarded = c.v(.onboarded, false)
        spaces = c.v(.spaces, base.spaces)
        activeSpaceId = c.v(.activeSpaceId, base.activeSpaceId)
        favorites = c.v(.favorites, [])
        // A tab whose layout can't be read is dropped rather than failing the whole file.
        let rawTabs: [String: Lenient<Tab>] = c.v(.tabs, [:])
        tabs = rawTabs.compactMapValues(\.value)
        sessions = c.v(.sessions, [:])
        settings = c.v(.settings, Settings())
        profiles = c.v(.profiles, [.default])
        defaultProfileId = c.v(.defaultProfileId, "default")
        snippets = c.v(.snippets, [])
        recentDirs = c.v(.recentDirs, [])
        activity = c.v(.activity, [])
    }

    // Fills in what an older or partial state file is missing.
    public static func migrate(_ data: Data?) -> AppModel {
        guard let data, var s = try? JSONDecoder().decode(AppModel.self, from: data), s.version == 2 else { return .initial() }
        if s.spaces.isEmpty { s.spaces = AppModel.initial().spaces }
        if !s.spaces.contains(where: { $0.id == s.activeSpaceId }) { s.activeSpaceId = s.spaces[0].id }
        if s.profiles.isEmpty { s.profiles = [.default] }
        return s
    }

    public func encoded() -> Data {
        (try? JSONEncoder().encode(self)) ?? Data()
    }
}

struct Lenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

private let uidAlphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
private var uidCounter = 0

// Ids: prefix + base-36 time + counter + random tail.
public func uid(_ prefix: String = "x") -> String {
    uidCounter = (uidCounter + 1) % 1_000_000
    func b36(_ n: Int64) -> String { String(n, radix: 36) }
    let tail = String((0..<4).map { _ in uidAlphabet.randomElement()! })
    return prefix + b36(nowMillis()) + b36(Int64(uidCounter)) + tail
}
