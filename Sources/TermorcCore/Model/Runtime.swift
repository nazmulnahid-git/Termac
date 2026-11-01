import Foundation

// Per-session runtime status (not persisted): what the sidebar marks and the pane header show.
public struct SessionRuntime: Equatable, Sendable {
    public enum Status: String, Sendable { case idle, run, ok, fail }

    public struct Dropped: Equatable, Sendable {
        public var host: String
        public var cmd: String
        public var at: Millis
        public var dur: Millis

        public init(host: String, cmd: String, at: Millis, dur: Millis) {
            self.host = host
            self.cmd = cmd
            self.at = at
            self.dur = dur
        }
    }

    public var status: Status = .idle
    public var command = ""
    public var cwd: String?
    public var proc = ""
    public var shell = ""
    public var alive = false
    public var integrated = false
    public var ownPrompt = false
    public var atPrompt = false
    public var exitCode: Int?
    public var duration: Millis?
    public var endedAt: Millis?
    public var cmdStart: Millis?
    public var startedAt: Millis?
    public var bell = 0
    public var branch: String?
    public var changes: Int?
    public var dropped: Dropped?
    public var scrolledUp = false
    public var newLines = 0
    public var alt = false

    public init() {}

    // A command is running, or a program other than the shell holds the terminal.
    public var busy: Bool {
        status == .run || (alive && !proc.isEmpty && proc != shell && proc != "login")
    }
}
