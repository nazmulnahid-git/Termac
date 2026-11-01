import Foundation

// Hosts from ~/.ssh/config (following Include), for the command bar's `@` search.
public struct SSHHost: Equatable, Sendable, Identifiable {
    public var alias: String
    public var hostName: String?
    public var user: String?
    public var id: String { alias }
}

public enum SSHConfig {
    public static func hosts(file: URL = URL(fileURLWithPath: System.home).appendingPathComponent(".ssh/config")) -> [SSHHost] {
        var seen = Set<String>()
        var visited = Set<String>()
        return read(file, &visited).filter { seen.insert($0.alias).inserted }
    }

    static func read(_ file: URL, _ visited: inout Set<String>) -> [SSHHost] {
        guard visited.insert(file.standardizedFileURL.path).inserted, let text = try? String(contentsOf: file, encoding: .utf8) else { return [] }
        var out: [SSHHost] = []
        var current: [Int] = []
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }
            let parts = line.split(maxSplits: 1, whereSeparator: { $0 == " " || $0 == "\t" || $0 == "=" }).map { String($0).trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2 else { continue }
            let (key, value) = (parts[0].lowercased(), parts[1])
            switch key {
            case "host":
                current = []
                for alias in value.split(separator: " ").map(String.init) where !alias.contains("*") && !alias.contains("?") && !alias.hasPrefix("!") {
                    current.append(out.count)
                    out.append(SSHHost(alias: alias))
                }
            case "match":
                current = []
            case "hostname":
                for i in current { out[i].hostName = value }
            case "user":
                for i in current { out[i].user = value }
            case "include":
                for pattern in value.split(separator: " ").map(String.init) {
                    let path = Routing.expandHome(pattern, home: System.home)
                    let full = path.hasPrefix("/") ? path : URL(fileURLWithPath: System.home).appendingPathComponent(".ssh").appendingPathComponent(path).path
                    for match in glob(full) { out += read(URL(fileURLWithPath: match), &visited) }
                }
            default:
                break
            }
        }
        return out
    }

    static func glob(_ pattern: String) -> [String] {
        var g = glob_t()
        defer { globfree(&g) }
        guard Darwin.glob(pattern, 0, nil, &g) == 0 else { return [] }
        return (0..<Int(g.gl_pathc)).compactMap { g.gl_pathv[$0].flatMap { String(cString: $0) } }
    }
}
