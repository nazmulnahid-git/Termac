import AppKit
import Carbon.HIToolbox
import TermorcCore

// Quick Terminal (⌥Space): a drop-down panel over any app, on every Space. It opens in the
// frontmost Finder folder; "Move to Space" promotes its live session to a sidebar row with
// the scrollback intact. Left hidden for 10 minutes, a session that ran something goes to
// the Library.
@MainActor
final class QuickTerminal: NSObject, TermSessionHooks {
    static let shared = QuickTerminal()
    static let archiveAfter: TimeInterval = 10 * 60
    static let lastCwdKey = "termac.quick.lastCwd"

    private var panel: QuickPanel?
    private var session: TermSession?
    private var startCwd = ""
    private var startedAt: Millis = 0
    private var status: SessionRuntime.Status = .idle
    private var cwd = ""
    private var archiveTimer: Timer?
    private var hotKeyRef: EventHotKeyRef?
    private var handlerInstalled = false
    private var previousApp: NSRunningApplication?

    // ---- Global hotkey ------------------------------------------------------------------
    func registerHotkey() {
        if let ref = hotKeyRef { UnregisterEventHotKey(ref) }
        hotKeyRef = nil
        guard let accel = Store.shared.model.settings.keybindings["quickTerminal"], let (mods, key) = Keys.split(accel), let code = Self.keyCodes[key] else { return }
        if !handlerInstalled {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
                DispatchQueue.main.async { MainActor.assumeIsolated { QuickTerminal.shared.toggle() } }
                return noErr
            }, 1, &spec, nil, nil)
            handlerInstalled = true
        }
        var m: UInt32 = 0
        if mods.contains("Cmd") { m |= UInt32(cmdKey) }
        if mods.contains("Alt") { m |= UInt32(optionKey) }
        if mods.contains("Ctrl") { m |= UInt32(controlKey) }
        if mods.contains("Shift") { m |= UInt32(shiftKey) }
        let id = EventHotKeyID(signature: OSType(0x544D5243), id: 1) // 'TMRC'
        // Another app (a launcher, an assistant) may own the shortcut: say so, rather than
        // the shortcut silently doing nothing.
        if RegisterEventHotKey(UInt32(code), m, id, GetApplicationEventTarget(), 0, &hotKeyRef) != noErr {
            hotKeyRef = nil
            Store.shared.toast("\(Keys.format(accel)) is taken by another app", detail: "Open the Quick Terminal from the Shell menu, or pick another shortcut in Settings › Keybindings.")
        }
    }

    // Settings changed (theme, font, zoom): the drop-down follows, like the main window's sessions.
    func applySettings() {
        let store = Store.shared
        let look = store.look(for: nil)
        if let s = session {
            store.configure(s)
            store.applyLook(look, to: s)
        }
        panel?.contentView?.layer?.backgroundColor = NSColor(hex: look.bg).cgColor
        panel?.appearance = NSAppearance(named: look.dark ? .darkAqua : .aqua)
    }

    static let keyCodes: [String: Int] = {
        var m: [String: Int] = ["Space": kVK_Space, "Enter": kVK_Return, "Tab": kVK_Tab, "Esc": kVK_Escape, "Backspace": kVK_Delete,
                                "Left": kVK_LeftArrow, "Right": kVK_RightArrow, "Up": kVK_UpArrow, "Down": kVK_DownArrow,
                                "`": kVK_ANSI_Grave, ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period, "/": kVK_ANSI_Slash, ";": kVK_ANSI_Semicolon,
                                "'": kVK_ANSI_Quote, "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket, "\\": kVK_ANSI_Backslash, "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal]
        let letters: [(String, Int)] = [("A", kVK_ANSI_A), ("B", kVK_ANSI_B), ("C", kVK_ANSI_C), ("D", kVK_ANSI_D), ("E", kVK_ANSI_E), ("F", kVK_ANSI_F), ("G", kVK_ANSI_G), ("H", kVK_ANSI_H), ("I", kVK_ANSI_I), ("J", kVK_ANSI_J), ("K", kVK_ANSI_K), ("L", kVK_ANSI_L), ("M", kVK_ANSI_M), ("N", kVK_ANSI_N), ("O", kVK_ANSI_O), ("P", kVK_ANSI_P), ("Q", kVK_ANSI_Q), ("R", kVK_ANSI_R), ("S", kVK_ANSI_S), ("T", kVK_ANSI_T), ("U", kVK_ANSI_U), ("V", kVK_ANSI_V), ("W", kVK_ANSI_W), ("X", kVK_ANSI_X), ("Y", kVK_ANSI_Y), ("Z", kVK_ANSI_Z),
                                       ("0", kVK_ANSI_0), ("1", kVK_ANSI_1), ("2", kVK_ANSI_2), ("3", kVK_ANSI_3), ("4", kVK_ANSI_4), ("5", kVK_ANSI_5), ("6", kVK_ANSI_6), ("7", kVK_ANSI_7), ("8", kVK_ANSI_8), ("9", kVK_ANSI_9),
                                       ("F1", kVK_F1), ("F2", kVK_F2), ("F3", kVK_F3), ("F4", kVK_F4), ("F5", kVK_F5), ("F6", kVK_F6), ("F7", kVK_F7), ("F8", kVK_F8), ("F9", kVK_F9), ("F10", kVK_F10), ("F11", kVK_F11), ("F12", kVK_F12)]
        for (k, v) in letters { m[k] = v }
        return m
    }()

    // ---- Show / hide ------------------------------------------------------------------
    func toggle() {
        if let p = panel, p.isVisible, p.isKeyWindow { hide(); return }
        show()
    }

    func show() {
        previousApp = NSWorkspace.shared.frontmostApplication
        // A new session opens in Finder's folder when Finder is in front. Asking Finder takes
        // a moment (and the first time, a permission prompt), so it's off the main thread,
        // before we come to the front and Finder stops being frontmost.
        guard session?.alive != true, previousApp?.bundleIdentifier == "com.apple.finder" else { return present(finder: nil) }
        Task.detached(priority: .userInitiated) {
            let finder = Self.frontmostFinderFolder()
            await MainActor.run { QuickTerminal.shared.present(finder: finder) }
        }
    }

    private func present(finder: String?) {
        let p = panel ?? makePanel()
        panel = p
        archiveTimer?.invalidate()
        ensureSession(cwd: finder)
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        if let area = screen?.visibleFrame {
            p.setFrameOrigin(NSPoint(x: area.midX - p.frame.width / 2, y: area.maxY - 8 - p.frame.height))
        }
        p.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let v = session?.view { p.makeFirstResponder(v) }
        p.refreshHeader(cwd: cwd.isEmpty ? startCwd : cwd, status: status)
    }

    func hide() {
        guard let p = panel, p.isVisible else { return }
        p.orderOut(nil)
        archiveTimer?.invalidate()
        if session != nil {
            archiveTimer = Timer.scheduledTimer(withTimeInterval: Self.archiveAfter, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.archive() } }
        }
        // Give focus back to whoever had it, unless that was us.
        if let prev = previousApp, prev != NSRunningApplication.current, !(Store.shared.window?.isKeyWindow ?? false) { prev.activate() }
    }

    private func makePanel() -> QuickPanel {
        let p = QuickPanel()
        p.onResign = { [weak self] in self?.hide() }
        p.onMove = { [weak self] spaceId, pinned in self?.moveTo(spaceId, pinned: pinned) }
        return p
    }

    // Folder of the frontmost Finder window, if Finder is frontmost. No other app is probed.
    nonisolated static func frontmostFinderFolder() -> String? {
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.finder" else { return nil }
        let script = #"tell application "Finder" to if (count of Finder windows) > 0 then get POSIX path of (target of front window as alias)"#
        return System.run("/usr/bin/osascript", ["-e", script], timeout: 1.5).flatMap { $0.isEmpty ? nil : $0 }
    }

    // ---- Session ------------------------------------------------------------------------
    private func ensureSession(cwd hint: String?) {
        if let s = session, s.alive { return }
        let store = Store.shared
        var dir = hint ?? ""
        if dir.isEmpty, let last = UserDefaults.standard.string(forKey: Self.lastCwdKey), System.isDir(last) { dir = last }
        if dir.isEmpty { dir = store.home }
        let sid = uid("q")
        let s = TermSession(sid: sid)
        s.hooks = self
        session = s
        startCwd = dir
        cwd = dir
        startedAt = nowMillis()
        status = .idle
        store.configure(s)
        store.applyLook(store.look(for: nil), to: s)
        panel?.mount(s.view)
        let p = store.profileFor(store.model.defaultProfileId)
        // The Quick Terminal keeps the shell's own prompt; it has no input bar.
        let launch = ShellLaunch.make(.init(command: p.command, profileEnv: p.envPairs, startup: p.startup, spaceName: "", cwd: dir, ownPrompt: false, integrationDir: store.integrationDir))
        _ = s.start(launch, ownPrompt: false, initialCommand: "")
        s.visible = true
    }

    private func endSession(kill: Bool) {
        guard let s = session else { return }
        if kill { s.dispose() } else { s.view.removeFromSuperview() }
        session = nil
        status = .idle
    }

    private func archive() {
        guard let s = session, panel?.isVisible != true else { return }
        let store = Store.shared
        if status == .run && store.model.settings.neverArchiveRunning {
            archiveTimer = Timer.scheduledTimer(withTimeInterval: Self.archiveAfter, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.archive() } }
            return
        }
        let cmds = s.cmds.filter { !$0.cmd.isEmpty }.map { LibraryEntry.Cmd(cmd: $0.cmd, exit: $0.exit, at: $0.at) }
        // A panel opened and dismissed without running anything isn't worth keeping.
        if !cmds.isEmpty || !s.integrated {
            let ssh = cmds.reversed().lazy.compactMap { Routing.sshTarget($0.cmd) }.first
            let lastExit = cmds.reversed().first { $0.exit != nil }?.exit
            let dir = cwd.isEmpty ? startCwd : cwd
            let entry = LibraryEntry(id: s.sid, name: Meta.leafOf(dir, home: store.home), spaceId: nil, spaceName: "Quick Terminal", cwd: dir, host: ssh?.host ?? "local",
                                     status: lastExit == nil ? "idle" : lastExit == 0 ? "ok" : "fail", exitCode: lastExit, startedAt: startedAt, endedAt: nowMillis(),
                                     idleSince: Millis(s.lastActivity.timeIntervalSince1970 * 1000), reason: "quick", commands: Array(cmds.suffix(100)), lines: 0)
            store.archiveHistory(entry, s)
        }
        endSession(kill: true)
    }

    // Promote the live session into a Space: same process, same scrollback.
    private func moveTo(_ spaceId: String, pinned: Bool) {
        guard let s = session, s.alive else { return }
        let store = Store.shared
        archiveTimer?.invalidate()
        s.view.removeFromSuperview()
        session = nil
        panel?.orderOut(nil)
        store.adopt(s, spaceId: spaceId, pinned: pinned, cwd: cwd.isEmpty ? startCwd : cwd, status: status)
        NSApp.activate(ignoringOtherApps: true)
        store.window?.makeKeyAndOrderFront(nil)
    }

    // ---- Hooks -------------------------------------------------------------------------
    func termInput(_ s: TermSession, _ data: [UInt8]) { s.write(data) }
    func termBell(_ s: TermSession) {}
    func termFocus(_ s: TermSession) {}
    func termPrompt(_ s: TermSession) {}
    func termProc(_ s: TermSession, _ proc: String) {}
    func termViewState(_ s: TermSession) {}

    func termCwd(_ s: TermSession, _ dir: String) {
        cwd = dir
        UserDefaults.standard.set(dir, forKey: Self.lastCwdKey)
        panel?.refreshHeader(cwd: dir, status: status)
    }

    func termCommandStart(_ s: TermSession, _ cmd: String) {
        status = .run
        panel?.refreshHeader(cwd: cwd, status: status)
    }

    func termCommandEnd(_ s: TermSession, _ entry: TermSession.Command) {
        status = (entry.exit ?? 0) != 0 ? .fail : .ok
        panel?.refreshHeader(cwd: cwd, status: status)
    }

    func termExit(_ s: TermSession, _ code: Int32?) {
        guard s === session else { return }
        endSession(kill: false)
        hide()
    }
}

// The panel: a header with status, directory and "Move to Space", over the terminal.
@MainActor
final class QuickPanel: NSPanel {
    var onResign: (() -> Void)?
    var onMove: ((String, Bool) -> Void)?
    private let status = StatusMarkView()
    private let path = NSTextField(labelWithString: "")
    private let move = NSButton(title: "↗ Move to Space", target: nil, action: nil)
    private let hint = NSButton(title: "", target: nil, action: nil)
    private let host = NSView()

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 640, height: 380), styleMask: [.titled, .resizable, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = true
        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        minSize = NSSize(width: 420, height: 200)
        let root = NSView()
        root.wantsLayer = true
        let look = Store.shared.look(for: nil)
        root.layer?.backgroundColor = NSColor(hex: look.bg).cgColor
        appearance = NSAppearance(named: look.dark ? .darkAqua : .aqua)
        path.lineBreakMode = .byTruncatingHead
        path.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        move.bezelStyle = .inline
        move.target = self
        move.action = #selector(showMoveMenu)
        hint.bezelStyle = .inline
        hint.target = self
        hint.action = #selector(hideTapped)
        hint.toolTip = "Hide"
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let head = NSStackView(views: [status, path, spacer, move, hint])
        head.spacing = 8
        head.loosen()
        for v in [head, host] {
            v.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(v)
        }
        NSLayoutConstraint.activate([
            head.topAnchor.constraint(equalTo: root.topAnchor, constant: 6), head.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            head.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -10), head.heightAnchor.constraint(equalToConstant: 24),
            host.topAnchor.constraint(equalTo: head.bottomAnchor, constant: 6), host.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 10),
            host.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -6), host.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -6),
        ])
        contentView = root
    }

    override var canBecomeKey: Bool { true }

    override func resignKey() {
        super.resignKey()
        // A menu of our own (Move to Space) takes key briefly; don't hide for that.
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.isKeyWindow, NSApp.keyWindow !== self else { return }
            self.onResign?()
        }
    }

    func mount(_ v: NSView) {
        host.subviews.forEach { $0.removeFromSuperview() }
        v.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(v)
        NSLayoutConstraint.activate([v.topAnchor.constraint(equalTo: host.topAnchor), v.bottomAnchor.constraint(equalTo: host.bottomAnchor), v.leadingAnchor.constraint(equalTo: host.leadingAnchor), v.trailingAnchor.constraint(equalTo: host.trailingAnchor)])
    }

    func refreshHeader(cwd: String, status st: SessionRuntime.Status) {
        let home = Store.shared.home
        let t = Routing.tildify(cwd, home: home)
        let i = t.lastIndex(of: "/").map { t.index(after: $0) } ?? t.startIndex
        let s = NSMutableAttributedString(string: String(t[..<i]), attributes: [.foregroundColor: NSColor.secondaryLabelColor, .font: NSFont.systemFont(ofSize: 12)])
        s.append(NSAttributedString(string: String(t[i...]), attributes: [.foregroundColor: NSColor.labelColor, .font: NSFont.systemFont(ofSize: 12, weight: .semibold)]))
        path.attributedStringValue = s
        status.set(st == .run ? .run : st == .ok ? .ok : st == .fail ? .fail : .idle, bell: 0, accent: .controlAccentColor)
        hint.title = Keys.format(Store.shared.model.settings.keybindings["quickTerminal"] ?? "Alt+Space")
    }

    @objc private func hideTapped() { QuickTerminal.shared.hide() }

    @objc private func showMoveMenu() {
        let store = Store.shared
        let menu = NSMenu()
        for (i, sp) in store.model.spaces.enumerated() {
            SidebarMenus.add(menu, "\(sp.glyph)  \(sp.name)") { [weak self] in self?.onMove?(sp.id, false) }
            if i < 9 {
                menu.items.last?.keyEquivalent = "\(i + 1)"
                menu.items.last?.keyEquivalentModifierMask = .control
            }
        }
        menu.addItem(.separator())
        let current = store.activeSpace
        SidebarMenus.add(menu, "Keep pinned in \(current.name)…") { [weak self] in self?.onMove?(current.id, true) }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: move.bounds.maxY + 4), in: move)
    }
}
