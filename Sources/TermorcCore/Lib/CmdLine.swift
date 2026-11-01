import Foundation

// The input bar's text logic: shell-ish tokens for highlighting, history suggestions and
// recall, applying a completion, and the shell's own history and completions (cmdline.js and
// shell.rs in the web build).
public enum CmdLine {
    public enum Kind: String, Sendable { case space, str, op, `var`, assign, cmd, flag, arg }

    public struct Token: Equatable, Sendable {
        public let t: String
        public let k: Kind
    }

    static let pattern = try! NSRegularExpression(pattern: #"(\s+)|("(?:[^"\\]|\\.)*"?|'[^']*'?)|(\|\||&&|[|;&<>]+)|(\$\{[^}]*\}?|\$\w+)|((?:\\.|[^\s|;&<>"'$])+)"#)

    // Splits a command line into typed tokens. `cmd` marks the word in command position (start
    // of the line or after |, ;, &&, ||), where an assignment like FOO=1 doesn't count.
    public static func tokenize(_ text: String) -> [Token] {
        let ns = text as NSString
        var out: [Token] = []
        var expectCmd = true
        var pos = 0
        while pos < ns.length {
            guard let m = pattern.firstMatch(in: text, options: .anchored, range: NSRange(location: pos, length: ns.length - pos)), m.range.length > 0 else { break }
            let t = ns.substring(with: m.range)
            func has(_ i: Int) -> Bool { m.range(at: i).location != NSNotFound }
            if has(1) { out.append(Token(t: t, k: .space)) }
            else if has(2) { out.append(Token(t: t, k: .str)); expectCmd = false }
            else if has(3) { out.append(Token(t: t, k: .op)); expectCmd = t.contains(where: { "|;&".contains($0) }) }
            else if has(4) { out.append(Token(t: t, k: .var)) }
            else if has(5) {
                if expectCmd && t.range(of: #"^\w+="#, options: .regularExpression) != nil { out.append(Token(t: t, k: .assign)) }
                else if expectCmd { out.append(Token(t: t, k: .cmd)); expectCmd = false }
                else { out.append(Token(t: t, k: t.hasPrefix("-") ? .flag : .arg)) }
            }
            pos = m.range.location + m.range.length
        }
        // Anything the pattern couldn't place (a lone "$") stays plain text.
        if pos < ns.length { out.append(Token(t: ns.substring(from: pos), k: .arg)) }
        return out
    }

    // The rest of the newest history entry that starts with what's typed (zsh-autosuggestions).
    public static func suggest(_ text: String, _ history: [String]) -> String {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty, !text.contains("\n"),
              let hit = history.first(where: { $0.count > text.count && $0.hasPrefix(text) }) else { return "" }
        return String(hit.dropFirst(text.count))
    }

    // History entries for ↑/↓: those starting with what was typed when recall began.
    public static func recallList(_ prefix: String, _ history: [String]) -> [String] {
        var seen = Set<String>()
        return history.filter { $0.hasPrefix(prefix) && $0 != prefix && seen.insert($0).inserted }
    }

    public struct Completion: Equatable, Sendable {
        public enum Kind: String, Sendable { case cmd, dir, file, branch, hist }
        public var value: String
        public var label: String?
        public var kind: Kind
        public init(value: String, label: String? = nil, kind: Kind) {
            self.value = value
            self.label = label
            self.kind = kind
        }
    }

    // Replaces the word being completed (from `start` up to the caret, in characters) with the
    // value. Folders keep the caret right after the slash; anything else gets a trailing space.
    public static func apply(_ text: String, caret: Int, start: Int, _ item: Completion) -> (text: String, caret: Int) {
        let chars = Array(text)
        let tail = item.kind == .dir ? "" : " "
        let after = String(chars[min(caret, chars.count)...])
        let before = String(chars[..<min(start, chars.count)]) + item.value + (after.hasPrefix(" ") ? "" : tail)
        return (before + after, before.count)
    }

    public static func commonPrefix(_ values: [String]) -> String {
        guard var p = values.first else { return "" }
        for v in values { while !v.hasPrefix(p) { p.removeLast() } }
        return p
    }

    // ---- Shell history --------------------------------------------------------------------
    // zsh (plain or extended ": 1700000000:0;cmd"), bash and fish histories, newest first,
    // deduplicated.
    public static func history(home: String = System.home, histfile: String? = ProcessInfo.processInfo.environment["HISTFILE"], max: Int = 5000) -> [String] {
        var entries: [(Int, Int, String)] = []
        var order = 0
        func push(_ time: Int, _ cmd: String) {
            let c = cmd.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !c.isEmpty else { return }
            order += 1
            entries.append((time, order, c))
        }
        func read(_ path: String) -> String? {
            (try? Data(contentsOf: URL(fileURLWithPath: path))).map { String(decoding: $0, as: UTF8.self) }
        }
        let zsh = histfile.flatMap { FileManager.default.fileExists(atPath: $0) ? $0 : nil } ?? home + "/.zsh_history"
        if let text = read(zsh) {
            var pending: (Int, String)?
            for line in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
                if let (t, c) = pending {
                    let next = c + "\n" + (line.hasSuffix("\\") ? String(line.dropLast()) : line)
                    if line.hasSuffix("\\") { pending = (t, next) } else { pending = nil; push(t, next) }
                    continue
                }
                var time = 0
                var cmd = line
                if line.hasPrefix(": "), let semi = line.firstIndex(of: ";") {
                    time = Int(line[line.index(line.startIndex, offsetBy: 2)..<semi].split(separator: ":").first ?? "") ?? 0
                    cmd = String(line[line.index(after: semi)...])
                }
                if cmd.hasSuffix("\\") { pending = (time, String(cmd.dropLast())) } else { push(time, cmd) }
            }
        }
        if let text = read(home + "/.bash_history") {
            for line in text.split(separator: "\n") where !line.hasPrefix("#") { push(0, String(line)) }
        }
        if let text = read(home + "/.local/share/fish/fish_history") {
            var cmd: String?
            for line in text.split(separator: "\n").map(String.init) {
                if line.hasPrefix("- cmd: ") {
                    cmd = String(line.dropFirst(7)).replacingOccurrences(of: "\\n", with: "\n").replacingOccurrences(of: "\\\\", with: "\\")
                } else if let c = cmd, line.trimmingCharacters(in: .whitespaces).hasPrefix("when: ") {
                    push(Int(line.trimmingCharacters(in: .whitespaces).dropFirst(6)) ?? 0, c)
                    cmd = nil
                }
            }
        }
        // Timestamps where the file has them, otherwise file order; newest first.
        entries.sort { $0.0 != $1.0 ? $0.0 > $1.0 : $0.1 > $1.1 }
        var seen = Set<String>()
        return Array(entries.map(\.2).filter { seen.insert($0).inserted }.prefix(max))
    }

    // ---- Completion -----------------------------------------------------------------------
    static let builtins = ["alias", "bg", "builtin", "cd", "command", "echo", "eval", "exec", "exit", "export", "fg", "history", "jobs", "kill", "popd", "printf", "pushd", "pwd", "read", "set", "source", "type", "unset", "which"]

    nonisolated(unsafe) static var commandCache: [String]?

    // Executables on the login PATH, plus shell builtins.
    public static func commands(path: String? = System.loginPath ?? ProcessInfo.processInfo.environment["PATH"]) -> [String] {
        if let c = commandCache { return c }
        var names = Set(builtins)
        for dir in (path ?? "").split(separator: ":") {
            guard let items = try? FileManager.default.contentsOfDirectory(atPath: String(dir)) else { continue }
            for n in items where FileManager.default.isExecutableFile(atPath: "\(dir)/\(n)") { names.insert(n) }
        }
        let sorted = names.sorted()
        commandCache = sorted
        return sorted
    }

    static func escape(_ name: String) -> String {
        name.reduce(into: "") { s, c in
            if " '\"\\$`!&;|()<>*?[]{}#".contains(c) { s.append("\\") }
            s.append(c)
        }
    }

    // Completions for the word ending at the end of `line`: where that word starts (a
    // character index) and the candidates.
    public static func complete(cwd: String, line: String, home: String = System.home, commands: [String]? = nil) -> (start: Int, items: [Completion]) {
        let chars = Array(line)
        var start = chars.count
        while start > 0, !(chars[start - 1].isWhitespace && (start < 2 || chars[start - 2] != "\\")) { start -= 1 }
        let word = String(chars[start...]).replacingOccurrences(of: "\\ ", with: " ")
        let before = String(chars[..<start])
        let lastSegment = before.split(omittingEmptySubsequences: false, whereSeparator: { "|;&".contains($0) }).last.map(String.init) ?? ""
        let firstWord = lastSegment.trimmingCharacters(in: .whitespaces).isEmpty
        var items: [Completion] = []

        if firstWord, !word.contains("/"), !word.hasPrefix("."), !word.hasPrefix("~") {
            let list = commands ?? Self.commands()
            items = list.filter { $0.hasPrefix(word) }.prefix(200).map { Completion(value: $0, kind: .cmd) }
            return (start, items)
        }

        let words = before.split(whereSeparator: \.isWhitespace).map(String.init)
        let gitSubs: Set<String> = ["checkout", "switch", "merge", "rebase", "branch", "push", "pull", "log", "diff", "reset"]
        if words.first == "git", words.count > 1, gitSubs.contains(words[1]), !word.hasPrefix("-") {
            let out = System.run("git", ["-C", cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]) ?? ""
            items += out.split(separator: "\n").map(String.init).filter { $0.hasPrefix(word) && !$0.hasSuffix("/HEAD") }.prefix(60).map { Completion(value: $0, kind: .branch) }
        }

        // Paths: "~/" and absolute paths as typed, everything else relative to the cwd.
        let slash = word.lastIndex(of: "/")
        let dirPart = slash.map { String(word[...$0]) } ?? ""
        let base = slash.map { String(word[word.index(after: $0)...]) } ?? word
        let dir: String
        if dirPart.hasPrefix("~/") { dir = home + "/" + dirPart.dropFirst(2) }
        else if dirPart == "~" { dir = home }
        else if dirPart.hasPrefix("/") { dir = dirPart }
        else { dir = (cwd as NSString).appendingPathComponent(dirPart) }
        if let names = try? FileManager.default.contentsOfDirectory(atPath: dir) {
            let entries = names.filter { $0.hasPrefix(base) && (base.hasPrefix(".") || !$0.hasPrefix(".")) }.sorted(by: System.naturalLess).prefix(200)
            for n in entries {
                let isDir = System.isDir((dir as NSString).appendingPathComponent(n))
                items.append(Completion(value: escape(dirPart) + escape(n) + (isDir ? "/" : ""), label: n, kind: isDir ? .dir : .file))
            }
        }
        return (start, items)
    }
}
