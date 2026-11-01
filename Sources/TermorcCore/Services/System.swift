import Foundation

// Filesystem and process lookups used by the UI. Everything here is cheap or cached.
public enum System {
    public static let home = FileManager.default.homeDirectoryForCurrentUser.path

    // Apps opened from Finder get launchd's bare PATH; git hooks and gh expect the one the
    // user's login shell sets up, so read it once (in the background) and hand it to children.
    nonisolated(unsafe) private static var loginPathValue: String?
    private static let loginPathOnce: Void = {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        loginPathValue = run(shell, ["-l", "-c", "printf %s \"$PATH\""], timeout: 4, usePath: false)
    }()

    public static var loginPath: String? {
        _ = loginPathOnce
        return loginPathValue
    }

    public static func warmLoginPath() {
        DispatchQueue.global(qos: .utility).async { _ = loginPathOnce }
    }

    // Runs a program and returns trimmed stdout, or nil on failure, timeout or non-zero exit
    // (`anyStatus` keeps the output of tools like lsof that exit 1 on a partial result).
    @discardableResult
    public static func run(_ cmd: String, _ args: [String], timeout: TimeInterval = 3, cwd: String? = nil, usePath: Bool = true, raw: Bool = false, anyStatus: Bool = false) -> String? {
        let p = Process()
        if cmd.hasPrefix("/") {
            p.executableURL = URL(fileURLWithPath: cmd)
            p.arguments = args
        } else {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = [cmd] + args
        }
        var env = ProcessInfo.processInfo.environment
        if usePath, let path = loginPath { env["PATH"] = path }
        // Never sit waiting on a credentials prompt nobody can see.
        env["GIT_TERMINAL_PROMPT"] = "0"
        env["GH_PROMPT_DISABLED"] = "1"
        env["GIT_EDITOR"] = "true"
        p.environment = env
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let done = DispatchSemaphore(value: 0)
        var data = Data()
        DispatchQueue.global().async {
            data = out.fileHandleForReading.readDataToEndOfFile()
            done.signal()
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            p.terminate()
            return nil
        }
        p.waitUntilExit()
        guard p.terminationStatus == 0 || anyStatus else { return nil }
        let text = String(decoding: data, as: UTF8.self)
        return raw ? text : text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // ---- Git ----------------------------------------------------------------------------
    nonisolated(unsafe) private static var branchCache: [String: (Date, String?)] = [:]
    private static let branchLock = NSLock()

    // Reads .git/HEAD walking up from `cwd` (no process); cached briefly.
    public static func gitBranch(_ cwd: String) -> String? {
        guard !cwd.isEmpty else { return nil }
        branchLock.lock()
        if let (at, b) = branchCache[cwd], Date().timeIntervalSince(at) < 1.5 {
            branchLock.unlock()
            return b
        }
        branchLock.unlock()
        var branch: String?
        var dir = URL(fileURLWithPath: cwd)
        for _ in 0..<40 {
            let dotgit = dir.appendingPathComponent(".git")
            var gitdir = dotgit
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: dotgit.path, isDirectory: &isDir), !isDir.boolValue,
               let text = try? String(contentsOf: dotgit, encoding: .utf8),
               let line = text.split(separator: "\n").first(where: { $0.hasPrefix("gitdir:") }) {
                gitdir = URL(fileURLWithPath: line.dropFirst(7).trimmingCharacters(in: .whitespaces), relativeTo: dir)
            }
            if let head = try? String(contentsOf: gitdir.appendingPathComponent("HEAD"), encoding: .utf8) {
                let h = head.trimmingCharacters(in: .whitespacesAndNewlines)
                if h.hasPrefix("ref: ") {
                    let r = String(h.dropFirst(5))
                    branch = r.hasPrefix("refs/heads/") ? String(r.dropFirst(11)) : r
                } else {
                    branch = String(h.prefix(7))
                }
                break
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        branchLock.lock()
        if branchCache.count > 500 { branchCache.removeAll() }
        branchCache[cwd] = (Date(), branch)
        branchLock.unlock()
        return branch
    }

    // Changed-file count for the working tree (nil outside a repo).
    public static func gitChanges(_ cwd: String) -> Int? {
        guard !cwd.isEmpty, let out = run("git", ["-C", cwd, "status", "--porcelain=v1"]) else { return nil }
        return out.isEmpty ? 0 : out.split(separator: "\n").count
    }

    public static func isDir(_ p: String) -> Bool {
        var d: ObjCBool = false
        return FileManager.default.fileExists(atPath: p, isDirectory: &d) && d.boolValue
    }

    // Like Finder: case-insensitive, digit runs compared by value ("file2" < "file10").
    public static func naturalLess(_ a: String, _ b: String) -> Bool {
        a.compare(b, options: [.caseInsensitive, .numeric]) == .orderedAscending
    }
}
