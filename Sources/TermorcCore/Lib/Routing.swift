import Foundation

// Path and command-line helpers: ~ expansion, ssh targets, and the commands a danger
// session asks about before running.
public enum Routing {
    public static func expandHome(_ p: String, home: String) -> String {
        if p == "~" { return home }
        if p.hasPrefix("~/") { return home + p.dropFirst() }
        return p
    }

    public static func tildify(_ p: String, home: String) -> String {
        guard !p.isEmpty, !home.isEmpty else { return p }
        if p == home { return "~" }
        if p.hasPrefix(home + "/") { return "~" + p.dropFirst(home.count) }
        return p
    }

    public struct SSHTarget: Equatable, Sendable {
        public let user: String
        public let host: String
        public let raw: String
    }

    // "ssh -p 22 deploy@web-01" → web-01.
    public static func sshTarget(_ command: String?) -> SSHTarget? {
        guard let command else { return nil }
        let parts = command.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !parts.isEmpty else { return nil }
        var i = parts[0] == "sudo" ? 1 : 0
        guard i < parts.count, parts[i].range(of: #"(^|/)(ssh|mosh|autossh)$"#, options: .regularExpression) != nil else { return nil }
        var withArg: Set<String> = ["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-b", "-c", "-E", "-e", "-m", "-O", "-Q", "-S", "-W", "-w", "-B", "-I"]
        if parts[i].hasSuffix("autossh") { withArg.insert("-M") }
        i += 1
        while i < parts.count {
            let a = parts[i]
            if withArg.contains(a) { i += 2; continue }
            if a.hasPrefix("-") { i += 1; continue }
            if let at = a.lastIndex(of: "@") {
                let user = at > a.startIndex ? String(a[..<at]) : ""
                return SSHTarget(user: user, host: String(a[a.index(after: at)...]).lowercased(), raw: a)
            }
            return SSHTarget(user: "", host: a.lowercased(), raw: a)
        }
        return nil
    }

    private static let risky: [NSRegularExpression] = [
        #"(^|[\s;&|(])sudo\s"#,
        #"\b(reboot|shutdown|halt|poweroff)\b"#,
        #"\b(systemctl|service)\s+\S*\s*(restart|stop|reload|disable)\b"#,
        #"\brm\s+-\w*[rf]"#,
    ].map { try! NSRegularExpression(pattern: $0) } + [try! NSRegularExpression(pattern: #"\b(drop|truncate)\s+(table|database)\b"#, options: .caseInsensitive)]

    // Commands that need an explicit OK on a danger (production) session.
    public static func isRiskyCommand(_ line: String) -> Bool {
        let l = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !l.isEmpty else { return false }
        let range = NSRange(l.startIndex..., in: l)
        return risky.contains { $0.firstMatch(in: l, range: range) != nil }
    }
}
