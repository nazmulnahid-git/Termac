import Foundation

// Display helpers: session names, kind chips, process labels, durations.
public enum Meta {
    public static let spaceColors = ["#3b82f6", "#f08a3c", "#22a06b", "#8b5cf6", "#e5487d", "#0ea5a4", "#d4a017", "#e5484d", "#64748b"]
    public static let spaceGlyphs = ["◆", "●", "▲", "■", "✦", "☾", "♣", "★"]

    static let runners: Set<String> = ["sudo", "env", "time", "npx", "pnpm", "yarn", "bunx", "exec", "nohup", "caffeinate", "command"]

    public static func firstToken(_ cmd: String?) -> String {
        guard let cmd, !cmd.isEmpty else { return "" }
        let parts = cmd.trimmingCharacters(in: .whitespaces).split(whereSeparator: \.isWhitespace).map(String.init)
        for (i, p) in parts.enumerated() {
            if p.range(of: #"^\w+="#, options: .regularExpression) != nil || runners.contains(p) || p.hasPrefix("-") { continue }
            if (p == "npm" || p == "bun"), i + 2 < parts.count, parts[i + 1] == "run" { return parts[i...(i + 2)].joined(separator: " ") }
            return p.split(separator: "/").last.map(String.init) ?? p
        }
        return parts.first ?? ""
    }

    static let kinds: [(String, String)] = [
        (#"^(node|npm|npx|pnpm|yarn|bun|bunx|deno|tsx|vite|vitest|jest|next|nuxt|astro)\b"#, "js"),
        (#"^(python3?|pip3?|pytest|poetry|uv|uvx|ipython|jupyter|django-admin|flask)\b"#, "py"),
        (#"^(psql|mysql|sqlite3|redis-cli|mongosh|pgcli)\b"#, "db"),
        (#"^(git|gh|lazygit|tig)\b"#, "git"),
        (#"^(ssh|mosh|autossh|scp|sftp)\b"#, "ssh"),
        (#"^(terraform|tofu|tfenv|pulumi)\b"#, "tf"),
        (#"^(kubectl|k9s|helm|minikube|kind)\b"#, "k8"),
        (#"^(cargo|rustc|rustup)\b"#, "rs"),
        (#"^(go)\b"#, "go"),
        (#"^(docker|docker-compose|podman|colima)\b"#, "dk"),
        (#"^(vim|nvim|vi|nano|emacs|hx|micro)\b"#, "ed"),
        (#"^(htop|top|btop|glances)\b"#, "top"),
    ]

    public static func kindOf(_ cmd: String?) -> String {
        guard let cmd, !cmd.isEmpty else { return ">_" }
        let c = cmd.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"^(((sudo|env|time|exec)\s+)|(\w+=\S*\s+))+"#, with: "", options: .regularExpression)
        for (re, k) in kinds where c.range(of: re, options: .regularExpression) != nil { return k }
        return ">_"
    }

    public static func leafOf(_ cwd: String?, home: String) -> String {
        guard let cwd, !cwd.isEmpty else { return "~" }
        let t = Routing.tildify(cwd, home: home)
        if t == "~" { return "~" }
        return t.split(separator: "/").last.map(String.init) ?? "/"
    }

    // The user's rename wins, then the running or last notable command, then the folder.
    public static func sessionName(tabName: String?, rt: SessionRuntime?, cwd: String?, home: String) -> String {
        if let n = tabName, !n.isEmpty { return n }
        if let rt, rt.status == .run, !rt.command.isEmpty { return rt.command }
        if let rt, rt.status == .fail || rt.status == .ok, !rt.command.isEmpty { return rt.command }
        return leafOf(rt?.cwd ?? cwd, home: home)
    }

    public static func shortName(_ name: String?) -> String {
        let s = (name ?? "").trimmingCharacters(in: .whitespaces).split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
        return s.count > 7 ? String(s.prefix(6)) + "…" : s
    }

    public static func procLabel(_ rt: SessionRuntime?) -> String {
        guard let rt else { return "zsh" }
        let shell = rt.shell.isEmpty ? "zsh" : rt.shell
        if rt.status == .run, !rt.command.isEmpty { return rt.command.count > 28 ? String(rt.command.prefix(27)) + "…" : rt.command }
        if rt.status == .fail { return "\(firstToken(rt.command)) · exited \(rt.exitCode ?? 1)" }
        if rt.status == .ok, !rt.command.isEmpty { return "\(firstToken(rt.command)) · done" }
        if !rt.proc.isEmpty, rt.proc != rt.shell, rt.proc != "login" { return rt.proc }
        return shell
    }

    public static func formatDuration(_ ms: Millis?) -> String {
        guard let ms else { return "" }
        let s = Double(ms) / 1000
        if s < 9.995 { return String(format: "%.2fs", s) }
        let total = Int(s.rounded())
        if total < 60 { return "\(total)s" }
        let m = total / 60
        if m < 60 { return "\(m)m \(total % 60)s" }
        return "\(m / 60)h \(m % 60)m"
    }

    public static func timeAgo(_ ts: Millis, now: Millis = nowMillis()) -> String {
        let s = max(0, Double(now - ts) / 1000)
        if s < 45 { return "just now" }
        if s < 3600 { return "\(Int((s / 60).rounded()))m ago" }
        if s < 86400 { return "\(Int((s / 3600).rounded()))h ago" }
        return "\(Int((s / 86400).rounded()))d ago"
    }

    public static func clockTime(_ ts: Millis) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: Double(ts) / 1000))
    }
}
