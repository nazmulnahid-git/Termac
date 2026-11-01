import AppKit
import Darwin
import SwiftTerm
import TermorcCore

// What the app layer (Store) hears from a session.
@MainActor
protocol TermSessionHooks: AnyObject {
    func termInput(_ s: TermSession, _ data: [UInt8])
    func termBell(_ s: TermSession)
    func termFocus(_ s: TermSession)
    func termCwd(_ s: TermSession, _ cwd: String)
    func termCommandStart(_ s: TermSession, _ cmd: String)
    func termCommandEnd(_ s: TermSession, _ entry: TermSession.Command)
    func termPrompt(_ s: TermSession)
    func termProc(_ s: TermSession, _ proc: String)
    func termViewState(_ s: TermSession) // scrolled up / new lines / alt screen changed
    func termExit(_ s: TermSession, _ code: Int32?)
}

// One terminal per session, alive while the session lives: the SwiftTerm view, the shell's
// PTY and the shell-integration bookkeeping (commands, their rows and exit codes). Rows are
// SwiftTerm's scroll-invariant rows, so they stay put as scrollback is trimmed.
@MainActor
final class TermSession: NSObject {
    struct Command {
        var cmd: String
        var at: Millis
        var head: Int? // the prompt line the command was typed on
        var start: Int? // first output row
        var end: Int? // row after the last output row
        var exit: Int?
        var dur: Millis?
        var decorated: Bool // drawn as a block (sessions with Termorc's own prompt)
        var restored = false
    }

    struct Divider {
        var at: Millis
        var row: Int
    }

    let sid: String
    let view: TermView
    weak var hooks: TermSessionHooks?

    private var process: LocalProcess?
    private var scanner = MarkScanner()
    private var pendingInitialCommand = ""
    private var pendingCmd = ""
    private var promptRow: Int?
    private var stateTimer: Timer?
    private var restoredCols: Int?

    private(set) var alive = false
    private(set) var started = false
    private(set) var integrated = false
    private(set) var ownPrompt = false
    private(set) var atPrompt = false
    private(set) var shell = ""
    private(set) var proc = ""
    private(set) var cmds: [Command] = []
    private(set) var dividers: [Divider] = []
    private(set) var lastActivity = Date()
    private(set) var scrolledUp = false
    private(set) var newLines = 0
    private(set) var altScreen = false

    var visible = false
    var look: TerminalLook? // last applied by Store.applyLook
    weak var composer: ComposerView?
    var onChange: (() -> Void)? // blocks or scroll position changed: redraw decorations

    // At a prompt the input bar owns typing; keys that reach the terminal go there instead.
    var composerActive: Bool { ownPrompt && atPrompt && !altScreen && composer?.window != nil && composer?.isHidden == false }

    init(sid: String) {
        self.sid = sid
        view = TermView(frame: NSRect(x: 0, y: 0, width: 800, height: 480))
        super.init()
        view.session = self
        view.terminalDelegate = self
        view.useBrightColors = false
        view.optionAsMetaKey = false
    }

    var pid: pid_t { process?.shellPid ?? 0 }

    // ---- Lifecycle ------------------------------------------------------------------
    func start(_ launch: ShellLaunch, ownPrompt wantsOwnPrompt: Bool, initialCommand: String) -> String? {
        guard !alive else { return nil }
        started = true
        alive = true
        shell = launch.shell
        proc = launch.shell
        integrated = launch.integrated
        ownPrompt = wantsOwnPrompt && launch.integrated
        view.hidesIdleCaret = ownPrompt
        pendingInitialCommand = initialCommand
        let p = LocalProcess(delegate: self, dispatchQueue: .main)
        process = p
        let result = p.startProcessChecked(executable: launch.executable, args: launch.args, environment: launch.envArray, execName: nil, currentDirectory: launch.cwd)
        if case .failure(let error) = result {
            alive = false
            view.feed(text: "\r\n\u{1b}[31mCould not start shell: \(error)\u{1b}[0m\r\n")
            return "\(error)"
        }
        // A non-integrated shell never marks its prompt: send the initial command after a beat.
        if !integrated, !initialCommand.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.sendInitialCommand() }
        }
        return nil
    }

    // SIGHUP, like closing a terminal window; the exit arrives through processTerminated.
    func kill() {
        guard alive, pid > 0 else { return }
        Darwin.kill(pid, SIGHUP)
    }

    func dispose() {
        kill()
        stateTimer?.invalidate()
        view.removeFromSuperview()
        hooks = nil
    }

    func write(_ text: String) { write(Array(text.utf8)) }

    func write(_ bytes: [UInt8]) {
        guard alive, let process else { return }
        process.send(data: bytes[...])
    }

    private func sendInitialCommand() {
        guard !pendingInitialCommand.isEmpty else { return }
        let line = pendingInitialCommand + "\r"
        pendingInitialCommand = ""
        write(line)
    }

    // The foreground process of the terminal (polled by the registry).
    func pollProcess() {
        guard alive, let fd = process?.childfd, fd >= 0 else { return }
        let pgid = tcgetpgrp(fd)
        guard pgid > 0 else { return }
        var buf = [CChar](repeating: 0, count: 256)
        guard proc_name(pgid, &buf, UInt32(buf.count)) > 0 else { return }
        let name = String(cString: buf)
        if name != proc {
            proc = name
            hooks?.termProc(self, name)
        }
    }

    // ---- Output -----------------------------------------------------------------------
    private func received(_ slice: ArraySlice<UInt8>) {
        lastActivity = Date()
        for piece in scanner.scan(slice) {
            switch piece {
            case .bytes(let b):
                view.feed(byteArray: b[...])
                if scrolledUp { newLines += b.reduce(0) { $1 == 0x0A ? $0 + 1 : $0 } }
            case .mark(let payload):
                onMark(payload)
            }
        }
        scheduleStateCheck()
    }

    private func scheduleStateCheck() {
        guard stateTimer == nil else { return }
        stateTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.stateTimer = nil
                self?.checkViewState()
            }
        }
    }

    func checkViewState() {
        onChange?()
        let alt = view.terminalInputStateSnapshot()?.isAlternateBuffer ?? false
        let up = view.canScroll && view.scrollPosition < 0.999
        if !up { newLines = 0 }
        if alt != altScreen || up != scrolledUp || up {
            altScreen = alt
            scrolledUp = up
            hooks?.termViewState(self)
        }
    }

    // The cursor's scroll-invariant row right now.
    func cursorRow() -> Int? {
        view.terminalContentSnapshot(region: .history(maximumScrollbackRows: -1))?.cursorRow
    }

    // ---- Shell integration marks ------------------------------------------------------
    private func onMark(_ payload: String) {
        let parts = payload.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)
        let code = parts.first.map(String.init) ?? ""
        let arg = parts.count > 1 ? String(parts[1]) : ""
        integrated = true
        let now = nowMillis()
        switch code {
        case "E":
            pendingCmd = arg.trimmingCharacters(in: .whitespaces)
        case "A":
            atPrompt = true
            view.syncCaret()
            // The prompt line is where the command will be echoed: the block's header line.
            promptRow = cursorRow()
            if !pendingInitialCommand.isEmpty {
                // The mark comes just before the line editor reads; typed too early, the
                // terminal driver echoes the line once and the editor again.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { [weak self] in self?.sendInitialCommand() }
            }
            hooks?.termPrompt(self)
        case "C":
            let entry = Command(cmd: pendingCmd, at: now, head: promptRow, start: cursorRow(), end: nil, exit: nil, dur: nil, decorated: ownPrompt)
            pendingCmd = ""
            promptRow = nil
            atPrompt = false
            view.syncCaret()
            cmds.append(entry)
            if cmds.count > 200 { cmds.removeFirst(cmds.count - 200) }
            hooks?.termCommandStart(self, entry.cmd)
            onChange?()
        case "D":
            guard var entry = cmds.last, entry.end == nil else { break }
            entry.end = cursorRow()
            entry.exit = Int(arg) ?? 0
            entry.dur = now - entry.at
            cmds[cmds.count - 1] = entry
            hooks?.termCommandEnd(self, entry)
            onChange?()
        case "P":
            if arg.hasPrefix("Cwd=") { hooks?.termCwd(self, String(arg.dropFirst(4))) }
        default:
            break
        }
    }

    // ---- Reading the buffer ---------------------------------------------------------
    var lastFinished: Command? { cmds.last { $0.end != nil } }

    // The text a command printed, trailing blank lines dropped.
    func output(of entry: Command) -> String? {
        guard let start = entry.start, let end = entry.end, end >= start,
              let snap = view.terminalContentSnapshot(region: .history(maximumScrollbackRows: 100_000), buffer: .normal) else { return nil }
        var lines = snap.rows.filter { $0.absoluteRow >= start && $0.absoluteRow < end }.map { $0.text }
        while let last = lines.last, last.trimmingCharacters(in: .whitespaces).isEmpty { lines.removeLast() }
        return lines.joined(separator: "\n")
    }

    // Nothing printed yet but the blank prompt line (a restored session has its scrollback).
    var isBlank: Bool {
        guard let snap = view.terminalContentSnapshot(region: .history(maximumScrollbackRows: 1)) else { return false }
        return snap.capturedRange.lowerBound == snap.liveTopRow && snap.rows.allSatisfy { $0.text.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    // Text of the line the cursor is on, soft-wrapped lines joined (the production guard).
    func cursorLine() -> String {
        guard let snap = view.terminalContentSnapshot(region: .history(maximumScrollbackRows: 200)),
              var i = snap.rows.firstIndex(where: { $0.absoluteRow == snap.cursorRow }) else { return "" }
        var text = snap.rows[i].text
        while i > 0, snap.rows[i].isWrapped {
            i -= 1
            text = snap.rows[i].text + text
        }
        return text
    }

    // Last `n` non-empty lines, plain, for Peek.
    func tail(_ n: Int) -> [TerminalContentRowSnapshot] {
        guard let snap = view.terminalContentSnapshot(region: .history(maximumScrollbackRows: n + 50)) else { return [] }
        var rows = snap.rows.filter { $0.absoluteRow <= snap.cursorRow }
        while let last = rows.last, last.text.trimmingCharacters(in: .whitespaces).isEmpty { rows.removeLast() }
        return Array(rows.suffix(n))
    }

    // Scroll-invariant row of the viewport's top line, and how far that space is offset from
    // the buffer indexes scrollTo takes (the lines trimmed off the top so far).
    func viewportTop() -> (row: Int, trimmed: Int)? {
        guard let top = view.terminalContentSnapshot(region: .viewport)?.rows.first?.absoluteRow else { return nil }
        return (top, top - view.terminalStateSnapshot().viewportRow)
    }

    func scroll(toRow row: Int) {
        guard let vp = viewportTop() else { return }
        view.scrollTo(row: max(0, row - vp.trimmed))
    }

    func scrollToBottom() {
        guard let snap = view.terminalContentSnapshot(region: .history(maximumScrollbackRows: -1)), let vp = viewportTop() else { return }
        view.scrollTo(row: snap.liveTopRow - vp.trimmed)
    }

    func clear() {
        view.feed(text: "\u{1b}[H\u{1b}[2J")
        view.clearScrollback()
        cmds.removeAll()
        dividers.removeAll()
    }

    // ---- Saved history ----------------------------------------------------------------
    // Saved scrollback starts with a private OSC listing the blocks (and restore dividers) by
    // row, so a restored session draws the same block headers as a live one. Files saved by
    // earlier versions use the same format.
    static let legacyBanner = try! NSRegularExpression(pattern: "(?:\\r\\n)?(?:\\u001b\\[[0-9;]*m)*─{4} restored · [^\\r\\n]*?─{4}(?:\\u001b\\[[0-9;]*m)*")

    func saveHistory(scrollback: Int = 3000) -> String {
        let termRows = view.terminalInputStateSnapshot()?.dimensions.rows ?? 24
        let cols = view.terminalInputStateSnapshot()?.dimensions.cols ?? 80
        guard let snap = view.terminalContentSnapshot(region: .history(maximumScrollbackRows: scrollback + termRows), buffer: .normal) else { return "" }
        let rows = snap.rows
        guard let lastIdx = rows.lastIndex(where: { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }) else { return "" }
        let firstIdx = max(0, lastIdx + 1 - scrollback - termRows)
        let first = rows[firstIdx].absoluteRow
        let last = rows[lastIdx].absoluteRow
        func row(_ r: Int?) -> Int? {
            guard let r, r >= first else { return nil }
            return min(r, last + 1) - first
        }
        var blocks: [[String: Any]] = []
        for e in cmds {
            guard let head = row(e.head), e.decorated || e.restored else { continue }
            var b: [String: Any] = ["cmd": e.cmd, "at": e.at, "head": head]
            b["exit"] = e.exit ?? NSNull()
            b["dur"] = e.dur ?? NSNull()
            b["start"] = row(e.start) ?? NSNull()
            b["end"] = row(e.end) ?? NSNull()
            blocks.append(b)
        }
        let span = last - first
        let divs: [[String: Any]] = dividers.compactMap { d in
            guard let r = row(d.row), r < span else { return nil }
            return ["at": d.at, "row": r]
        }
        let meta: [String: Any] = ["cols": cols, "rows": span, "blocks": blocks, "dividers": divs]
        guard let json = try? JSONSerialization.data(withJSONObject: meta), let header = String(data: json, encoding: .utf8) else { return "" }
        let body = ANSISerializer.serialize(rows[firstIdx...lastIdx])
        return "\u{1b}]7701;\(header)\u{07}" + body
    }

    // Writes saved history into a fresh session, then a divider where this launch picks up.
    func restore(_ saved: String, at: Millis = nowMillis()) {
        guard !saved.isEmpty else { return }
        var content = saved
        var meta: [String: Any]?
        if content.hasPrefix("\u{1b}]7701;"), let bel = content.firstIndex(of: "\u{07}") {
            let json = content[content.index(content.startIndex, offsetBy: 7)..<bel]
            meta = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
            content = String(content[content.index(after: bel)...])
        } else {
            let ns = content as NSString
            content = Self.legacyBanner.stringByReplacingMatches(in: content, range: NSRange(location: 0, length: ns.length), withTemplate: "")
        }
        // Rows only line up at the width they were saved at; the next layout reflows them.
        if let cols = meta?["cols"] as? Int, cols > 1, cols != view.terminalInputStateSnapshot()?.dimensions.cols {
            let rows = view.terminalInputStateSnapshot()?.dimensions.rows ?? 24
            view.resize(cols: cols, rows: rows)
            restoredCols = cols
        }
        // One row for the divider, the next for the shell's first prompt.
        view.feed(text: content + "\u{1b}[0m\r\n\r\n")
        guard let cur = cursorRow() else { return }
        let rows = (meta?["rows"] as? Int) ?? (cur - 2)
        func mark(_ r: Int?) -> Int? {
            guard let r else { return nil }
            return cur + (min(r, rows + 1) - rows - 2)
        }
        var restored: [Command] = []
        for b in (meta?["blocks"] as? [[String: Any]]) ?? [] {
            guard let head = mark(b["head"] as? Int) else { continue }
            restored.append(Command(cmd: b["cmd"] as? String ?? "", at: (b["at"] as? NSNumber)?.int64Value ?? 0, head: head,
                                    start: mark(b["start"] as? Int), end: mark(b["end"] as? Int), exit: b["exit"] as? Int,
                                    dur: (b["dur"] as? NSNumber)?.int64Value, decorated: true, restored: true))
        }
        cmds = restored + cmds
        for d in (meta?["dividers"] as? [[String: Any]]) ?? [] {
            if let r = mark(d["row"] as? Int) { dividers.append(Divider(at: (d["at"] as? NSNumber)?.int64Value ?? 0, row: r)) }
        }
        dividers.append(Divider(at: at, row: cur - 1))
        onChange?()
    }
}

// ---- LocalProcess ------------------------------------------------------------------------
extension TermSession: LocalProcessDelegate {
    nonisolated func processTerminated(_ source: LocalProcess, exitCode: Int32?) {
        MainActor.assumeIsolated {
            alive = false
            stateTimer?.invalidate()
            hooks?.termExit(self, exitCode)
        }
    }

    nonisolated func dataReceived(slice: ArraySlice<UInt8>) {
        MainActor.assumeIsolated { received(slice) }
    }

    nonisolated func getWindowSize() -> winsize {
        MainActor.assumeIsolated {
            let d = view.terminalInputStateSnapshot()?.dimensions
            return winsize(ws_row: UInt16(d?.rows ?? 24), ws_col: UInt16(d?.cols ?? 80), ws_xpixel: 0, ws_ypixel: 0)
        }
    }
}

// ---- TerminalView ------------------------------------------------------------------------
extension TermSession: TerminalViewDelegate {
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard let fd = process?.childfd, fd >= 0 else { return }
        var size = winsize(ws_row: UInt16(newRows), ws_col: UInt16(newCols), ws_xpixel: 0, ws_ypixel: 0)
        _ = PseudoTerminalHelpers.setWinSize(masterPtyDescriptor: fd, windowSize: &size)
    }

    func setTerminalTitle(source: TerminalView, title: String) {}

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {
        // OSC 7 from shells without our integration (file://host/path).
        guard !integrated, let directory, let url = URL(string: directory), url.isFileURL else { return }
        hooks?.termCwd(self, url.path)
    }

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        hooks?.termInput(self, Array(data))
    }

    func scrolled(source: TerminalView, position: Double) {
        checkViewState()
    }

    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), ["http", "https", "file"].contains(url.scheme ?? "") else { return }
        NSWorkspace.shared.open(url)
    }

    func bell(source: TerminalView) {
        hooks?.termBell(self)
    }

    func clipboardCopy(source: TerminalView, content: Data) {
        guard let text = String(data: content, encoding: .utf8) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func clipboardRead(source: TerminalView) -> Data? { nil }

    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}

    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

// The terminal NSView. The main window reports when one becomes first responder, so
// clicking a pane focuses its session.
final class TermView: TerminalView {
    weak var session: TermSession?

    // Sessions with Termorc's own prompt hide the cursor at the prompt, and while the terminal
    // isn't focused: commands are typed in the input bar, and the cursor
    // would only sit on the blank prompt line. A running program (an editor, a password
    // prompt) shows it. SwiftTerm re-adds its caret view as the cursor moves but keeps it
    // hidden once hidden.
    var hidesIdleCaret = false { didSet { syncCaret() } }
    private weak var caret: NSView?
    private var focused = false

    override var hasFocus: Bool {
        get { super.hasFocus }
        set {
            super.hasFocus = newValue
            focused = newValue
            syncCaret()
        }
    }

    override func didAddSubview(_ subview: NSView) {
        super.didAddSubview(subview)
        if String(describing: type(of: subview)) == "CaretView" {
            caret = subview
            syncCaret()
        }
    }

    func syncCaret() { caret?.isHidden = hidesIdleCaret && (!focused || session?.atPrompt == true) }
}

// Cells to ANSI text: SGR runs for colors and styles, rows joined with CRLF except where a
// row soft-wraps into the next.
enum ANSISerializer {
    static func serialize(_ rows: ArraySlice<TerminalContentRowSnapshot>) -> String {
        var out = ""
        var current = Attribute.empty
        var idx = rows.startIndex
        while idx < rows.endIndex {
            let row = rows[idx]
            let next = rows.index(after: idx)
            let wrapsIntoNext = next < rows.endIndex && rows[next].isWrapped
            var cells = row.cells
            if !wrapsIntoNext {
                while let last = cells.last, last.attribute == Attribute.empty || last.attribute.bg == .defaultInvertedColor || last.attribute.bg == .defaultColor,
                      last.text.trimmingCharacters(in: .whitespaces).isEmpty {
                    cells.removeLast()
                }
            }
            for cell in cells where cell.width > 0 {
                if cell.attribute != current {
                    out += sgr(cell.attribute)
                    current = cell.attribute
                }
                out += cell.text.isEmpty ? " " : cell.text
            }
            if !wrapsIntoNext, next < rows.endIndex {
                if current != Attribute.empty {
                    out += "\u{1b}[0m"
                    current = .empty
                }
                out += "\r\n"
            }
            idx = next
        }
        if current != Attribute.empty { out += "\u{1b}[0m" }
        return out
    }

    static func sgr(_ a: Attribute) -> String {
        var p = ["0"]
        let s = a.style
        if s.contains(.bold) { p.append("1") }
        if s.contains(.dim) { p.append("2") }
        if s.contains(.italic) { p.append("3") }
        if s.contains(.underline) { p.append("4") }
        if s.contains(.blink) { p.append("5") }
        if s.contains(.inverse) { p.append("7") }
        if s.contains(.invisible) { p.append("8") }
        if s.contains(.crossedOut) { p.append("9") }
        switch a.fg {
        case .ansi256(let c) where c < 8: p.append("\(30 + Int(c))")
        case .ansi256(let c) where c < 16: p.append("\(90 + Int(c) - 8)")
        case .ansi256(let c): p.append("38;5;\(c)")
        case let .trueColor(r, g, b): p.append("38;2;\(r);\(g);\(b)")
        default: break
        }
        switch a.bg {
        case .ansi256(let c) where c < 8: p.append("\(40 + Int(c))")
        case .ansi256(let c) where c < 16: p.append("\(100 + Int(c) - 8)")
        case .ansi256(let c): p.append("48;5;\(c)")
        case let .trueColor(r, g, b): p.append("48;2;\(r);\(g);\(b)")
        default: break
        }
        return "\u{1b}[" + p.joined(separator: ";") + "m"
    }
}
