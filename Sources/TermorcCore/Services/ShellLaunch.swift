import Foundation

// How a session's shell is started: the program, its arguments and environment, with the
// shell integration (resources/shell-integration) wired in for zsh, bash and fish. The
// integration emits OSC 633 marks for prompts, commands, exit codes and the cwd.
public struct ShellLaunch: Equatable, Sendable {
    public var executable: String
    public var args: [String]
    public var env: [String: String]
    public var cwd: String
    public var shell: String // the program's name ("zsh"), compared against the foreground process
    public var integrated: Bool

    public struct Options: Sendable {
        public var command: String // the profile's command; empty = the login shell
        public var profileEnv: [(String, String)]
        public var startup: String
        public var spaceName: String
        public var cwd: String
        public var ownPrompt: Bool // Termorc draws the prompt; the integration blanks the shell's own
        public var integrationDir: String

        public init(command: String = "", profileEnv: [(String, String)] = [], startup: String = "", spaceName: String = "", cwd: String, ownPrompt: Bool = false, integrationDir: String) {
            self.command = command
            self.profileEnv = profileEnv
            self.startup = startup
            self.spaceName = spaceName
            self.cwd = cwd
            self.ownPrompt = ownPrompt
            self.integrationDir = integrationDir
        }
    }

    // `"a b" 'c d' e` → [a b, c d, e]
    public static func splitCommand(_ cmd: String) -> [String] {
        let re = try! NSRegularExpression(pattern: #""([^"]*)"|'([^']*)'|(\S+)"#)
        let ns = cmd as NSString
        return re.matches(in: cmd, range: NSRange(location: 0, length: ns.length)).map { m in
            for i in 1...3 where m.range(at: i).location != NSNotFound { return ns.substring(with: m.range(at: i)) }
            return ""
        }
    }

    // The app's own environment minus what only made sense for us (build tools, bundle id).
    public static func cleanEnv(_ base: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        base.filter { k, _ in
            !(k.hasPrefix("CARGO") || k.hasPrefix("RUST") || k.hasPrefix("TAURI_") || k == "TERMORC_DATA_DIR" || k.hasPrefix("npm_") || k == "NODE_OPTIONS" || k == "__CFBundleIdentifier" || k == "XPC_SERVICE_NAME")
        }
    }

    public static func make(_ o: Options, baseEnv: [String: String] = ProcessInfo.processInfo.environment) -> ShellLaunch {
        let loginShell = baseEnv["SHELL"] ?? "/bin/zsh"
        let command = o.command.trimmingCharacters(in: .whitespaces).isEmpty ? "\(loginShell) -l" : o.command
        var parts = splitCommand(command)
        if parts.isEmpty { parts = [loginShell] }
        let file = parts.removeFirst()
        var args = parts
        let shell = (file as NSString).lastPathComponent

        var env = cleanEnv(baseEnv)
        for (k, v) in o.profileEnv where !k.isEmpty {
            env[k] = v.replacingOccurrences(of: #"\$space\b"#, with: NSRegularExpression.escapedTemplate(for: o.spaceName), options: .regularExpression)
        }
        let lang = env["LANG"] ?? "en_US.UTF-8"
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "Termorc"
        env["LANG"] = lang
        env["SHELL_SPACE"] = o.spaceName
        if o.ownPrompt { env["TERMORC_PROMPT"] = "1" }
        if !o.startup.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { env["TERMAC_STARTUP"] = o.startup }

        let dir = o.integrationDir
        var integrated = true
        switch shell {
        case "zsh":
            env["TERMAC_USER_ZDOTDIR"] = env["ZDOTDIR"] ?? baseEnv["HOME"] ?? System.home
            env["ZDOTDIR"] = (dir as NSString).appendingPathComponent("zsh")
        case "bash":
            if args.contains("-l") || args.contains("--login") { env["TERMAC_LOGIN"] = "1" }
            let rest = args.filter { $0 != "-l" && $0 != "--login" }
            args = ["--rcfile", (dir as NSString).appendingPathComponent("bash.sh")] + rest
        case "fish":
            args += ["--init-command", "source '\((dir as NSString).appendingPathComponent("termac.fish"))'"]
        default:
            integrated = false
        }

        // A restored session's folder may be gone; a shell that can't start would close its tab.
        let cwd = System.isDir(o.cwd) ? o.cwd : (baseEnv["HOME"] ?? System.home)
        return ShellLaunch(executable: file, args: args, env: env, cwd: cwd, shell: shell, integrated: integrated)
    }

    public var envArray: [String] { env.map { "\($0.key)=\($0.value)" }.sorted() }
}
