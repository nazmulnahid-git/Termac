import AppKit
import TermorcCore

// What sessions report back, and the boot / checkpoint / quit flow.
extension Store: TermSessionHooks {
    func termInput(_ s: TermSession, _ data: [UInt8]) {
        if s.composerActive, let c = s.composer {
            c.receive(data)
            return
        }
        let eff = effects(s.sid)
        if eff["confirmPaste"] == true {
            var body = String(decoding: data, as: UTF8.self)
            body = body.replacingOccurrences(of: "\u{1b}[200~", with: "").replacingOccurrences(of: "\u{1b}[201~", with: "")
            let trimmed = body.replacingOccurrences(of: #"[\r\n]+$"#, with: "", options: .regularExpression)
            if body.count > 1, trimmed.contains(where: { $0 == "\r" || $0 == "\n" }) {
                let lines = body.components(separatedBy: CharacterSet(charactersIn: "\r\n")).filter { !$0.isEmpty }.count
                confirmThen(s.sid, title: "Paste \(lines) lines?", detail: "Multi-line pastes run each line as a command on this session.", label: "Paste") { [weak s] in s?.write(data) }
                return
            }
        }
        s.write(data)
    }

    func termBell(_ s: TermSession) {
        if s.visible && NSApp.isActive { return }
        patchRt(s.sid) { $0.bell += 1 }
    }

    func termFocus(_ s: TermSession) {
        // Only a terminal on screen in the active card can claim focus: AppKit restores the
        // previous first responder after a sheet, which may belong to another Space by now.
        guard s.visible, s.view.window != nil, activeTab?.layout.leaves.contains(s.sid) == true else { return }
        if ui.focusedSid != s.sid { focusSession(s.sid) }
    }

    func termPrompt(_ s: TermSession) {
        patchRt(s.sid) { $0.atPrompt = true }
    }

    func termCommandStart(_ s: TermSession, _ cmd: String) {
        patchRt(s.sid) {
            $0.status = .run
            $0.atPrompt = false
            $0.command = cmd
            $0.cmdStart = nowMillis()
            $0.exitCode = nil
            $0.dropped = nil
        }
    }

    func termCwd(_ s: TermSession, _ cwd: String) {
        guard rt[s.sid]?.cwd != cwd else { return }
        patchRt(s.sid) { $0.cwd = cwd }
        refreshGit(s.sid, cwd)
        guard model.sessions[s.sid] != nil else { return }
        var next = model
        if cwd != home {
            let prev = next.recentDirs.first { $0.path == cwd }
            next.recentDirs = Array(([RecentDir(path: cwd, visits: (prev?.visits ?? 0) + 1, last: nowMillis())] + next.recentDirs.filter { $0.path != cwd }).prefix(200))
        }
        next.sessions[s.sid]?.cwd = cwd
        model = next
    }

    func termCommandEnd(_ s: TermSession, _ entry: TermSession.Command) {
        let visible = s.visible && NSApp.isActive
        let exit = entry.exit ?? 0
        let dur = entry.dur ?? 0
        let interrupted = exit == 130
        let failed = exit != 0 && !interrupted
        patchRt(s.sid) {
            $0.status = failed ? .fail : (!interrupted && (dur >= 3000 || !visible)) ? .ok : .idle
            $0.exitCode = exit
            $0.duration = dur
            $0.endedAt = nowMillis()
            if let ssh = Routing.sshTarget(entry.cmd), exit == 255, dur > 5000 {
                $0.dropped = .init(host: ssh.host, cmd: entry.cmd, at: nowMillis(), dur: dur)
            }
        }
        // Any command can touch the working tree, so the change count is re-read after each.
        if let cwd = rt[s.sid]?.cwd { refreshGit(s.sid, cwd) }
        let threshold = model.settings.notifyAfterS * 1000
        if threshold > 0, Double(dur) >= threshold, !visible, !interrupted { notifyFinished(s.sid, entry) }
    }

    func termProc(_ s: TermSession, _ proc: String) {
        patchRt(s.sid) {
            $0.proc = proc
            if !s.integrated { $0.status = proc == s.shell || proc == "login" ? .idle : .run }
        }
    }

    func termViewState(_ s: TermSession) {
        patchRt(s.sid) {
            $0.alt = s.altScreen
            $0.scrolledUp = s.scrolledUp
            $0.newLines = s.newLines
        }
    }

    func termExit(_ s: TermSession, _ code: Int32?) {
        onExit(s.sid, code)
    }

    // ---- Boot ---------------------------------------------------------------------------
    func boot() {
        var s = Persistence.loadState(paths)

        // Drop dangling references left by a crash.
        let referenced = Set(s.favorites + s.spaces.flatMap(\.allTabs))
        var tabs = s.tabs.filter { referenced.contains($0.key) }
        if s.settings.onLaunch == "fresh" {
            for sp in s.spaces { for tid in sp.today { tabs[tid] = nil } }
            for i in s.spaces.indices { s.spaces[i].today = [] }
        }
        let live = Set(tabs.values.flatMap(\.layout.leaves))
        s.tabs = tabs
        s.sessions = s.sessions.filter { live.contains($0.key) }
        // Sessions whose shell never wrote a meta record get one, so they can start.
        for sid in live where s.sessions[sid] == nil { s.sessions[sid] = SessionMeta(id: sid, cwd: home, profileId: nil) }
        for i in s.spaces.indices where s.spaces[i].activeTabId.flatMap({ tabs[$0] }) == nil { s.spaces[i].activeTabId = nil }
        // The tabs lists may still name tabs that are gone.
        for i in s.spaces.indices {
            s.spaces[i].pinned = s.spaces[i].pinned.filter { tabs[$0] != nil }
            s.spaces[i].today = s.spaces[i].today.filter { tabs[$0] != nil }
            for j in s.spaces[i].folders.indices { s.spaces[i].folders[j].tabs = s.spaces[i].folders[j].tabs.filter { tabs[$0] != nil } }
        }
        s.favorites = s.favorites.filter { tabs[$0] != nil }
        SettingsSync.shared.load(into: &s.settings)
        model = s
        loaded = true
        applySettings()
        SettingsSync.shared.start()

        let favSids = Set(s.favorites.flatMap { tabs[$0]?.layout.leaves ?? [] })
        for (sid, meta) in s.sessions {
            let session = termSession(sid)
            session.restore(Persistence.readScrollback(sid, paths))
            patchRt(sid) {
                $0.cwd = meta.cwd
                $0.status = .idle
            }
            if favSids.contains(sid) { startSession(sid) }
        }
        syncFocus()
        ensureSession()

        DispatchQueue.global(qos: .utility).async {
            let hosts = SSHConfig.hosts()
            DispatchQueue.main.async { Store.shared.ui.sshHosts = hosts }
        }
        System.warmLoginPath()
        // The command list ⇥ completes from, ready before the first ⇥.
        DispatchQueue.global(qos: .utility).async { _ = System.loginPath; _ = CmdLine.commands() }
        DispatchQueue.global(qos: .utility).async { [library, days = s.settings.libraryDays] in library.prune(days: days) }

        func every(_ seconds: TimeInterval, _ fn: @escaping @MainActor () -> Void) {
            timers.append(Timer.scheduledTimer(withTimeInterval: seconds, repeats: true) { _ in MainActor.assumeIsolated { fn() } })
        }
        every(1.5) { [weak self] in self?.sessions.values.forEach { $0.pollProcess() } }
        every(5 * 60) { [weak self] in self?.tidy() }
        every(60) { [weak self] in self?.checkpointScrollback() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in self?.tidy() }
    }

    // Scrollback is otherwise written only on a clean quit. Checkpoint sessions that printed
    // something since the last pass, so a crash or force-quit still restores their output.
    // Serializing thousands of rows per session is slow, so it runs off the main thread.
    private static var checkpointedAt: [String: Date] = [:]
    private static let historyQueue = DispatchQueue(label: "termorc.history", qos: .utility)

    func checkpointScrollback() {
        for (sid, s) in sessions where model.sessions[sid] != nil {
            if let at = Store.checkpointedAt[sid], at >= s.lastActivity { continue }
            Store.checkpointedAt[sid] = Date()
            let (view, cmds, dividers, paths) = (s.view, s.cmds, s.dividers, paths)
            Store.historyQueue.async {
                let text = TermSession.history(of: view, cmds: cmds, dividers: dividers, scrollback: 3000)
                // A closed session's terminal has nothing to copy: keep what's saved.
                if !text.isEmpty { Persistence.writeScrollback(sid, text, paths) }
                // The view is AppKit's: let the main thread drop the last reference to it.
                DispatchQueue.main.async { _ = view }
            }
        }
    }

    // A session's scrollback into the Library, serialized off the main thread like a checkpoint.
    // The Library list refreshes once it's written.
    func archiveHistory(_ entry: LibraryEntry, _ s: TermSession) {
        let (view, cmds, dividers, library) = (s.view, s.cmds, s.dividers, library)
        Store.historyQueue.async {
            library.add(entry, ansi: TermSession.history(of: view, cmds: cmds, dividers: dividers, scrollback: 5000))
            DispatchQueue.main.async {
                Store.shared.objectWillChange.send()
                _ = view // released on the main thread
            }
        }
    }

    // ---- Quit -----------------------------------------------------------------------------
    var runningCount: Int { sessions.values.filter { $0.alive && !$0.proc.isEmpty && $0.proc != $0.shell && $0.proc != "login" }.count }

    func prepareQuit() async -> Bool {
        let running = runningCount
        if model.settings.confirmQuit, running > 0 {
            let ok = await confirm("Quit Termorc with \(running) running process\(running > 1 ? "es" : "")?", detail: "Running commands will be stopped. Sessions and scrollback are restored next launch.", ok: "Quit")
            if !ok { return false }
        }
        quitting = true
        // A checkpoint or archive still writing must finish, and not land after the final save.
        Store.historyQueue.sync {}
        for (sid, s) in sessions where model.sessions[sid] != nil {
            Persistence.writeScrollback(sid, s.saveHistory(), paths)
        }
        // `quitting` stops further saves: write the final model now, then seal the file so
        // the shells' exits can't save over it.
        SettingsSync.shared.flush()
        saveNow()
        sealState()
        for s in sessions.values { s.kill() }
        return true
    }
}

extension Store {
    // A Quick Terminal session promoted into a Space: adopt the live terminal with its
    // scrollback as a new row there.
    func adopt(_ s: TermSession, spaceId: String, pinned: Bool, cwd: String, status: SessionRuntime.Status) {
        let now = nowMillis()
        let tid = uid("t")
        let sp = space(spaceId) ?? activeSpace
        var next = model
        next.sessions[s.sid] = SessionMeta(id: s.sid, cwd: cwd, profileId: model.defaultProfileId, createdAt: now)
        next.tabs[tid] = Tab(id: tid, layout: .leaf(s.sid), activeSid: s.sid, createdAt: now)
        next = Store.attach(next, tid, Dest(section: pinned ? .pinned : .today, spaceId: sp.id))
        next = Store.setActiveTab(next, sp.id, tid)
        s.hooks = self
        sessions[s.sid] = s
        configure(s)
        model = next
        patchRt(s.sid) {
            $0.cwd = cwd
            $0.shell = s.shell
            $0.proc = s.proc
            $0.alive = true
            $0.integrated = s.integrated
            $0.status = status
        }
        ui.view = .terminal
        syncFocus()
    }
}
