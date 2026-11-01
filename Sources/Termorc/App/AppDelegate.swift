import AppKit
import TermorcCore
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = Store.shared
    var mainWindow: MainWindowController?
    private var keyMonitor: Any?
    private var pendingFolders: [String] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let mode = ProcessInfo.processInfo.environment["TERMORC_APPEARANCE"] {
            NSApp.appearance = NSAppearance(named: mode == "light" ? .aqua : .darkAqua)
        }
        store.boot()
        MainMenu.rebuild()
        let wc = MainWindowController()
        mainWindow = wc
        store.window = wc.window
        wc.showWindow(nil)
        for dir in pendingFolders { store.openTerminal(.init(cwd: dir)) }
        pendingFolders = []
        installKeyMonitor()
        QuickTerminal.shared.registerHotkey()
        // Notifications need a real bundle; `swift run` has none.
        if Bundle.main.bundleURL.pathExtension == "app" { UNUserNotificationCenter.current().delegate = self }
        WidgetFeed.shared.start()
        NSApp.servicesProvider = self
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(appearanceChanged), name: Notification.Name("AppleInterfaceThemeChangedNotification"), object: nil)
        store.syncFocus()
    }

    @objc private func appearanceChanged() {
        DispatchQueue.main.async { self.store.applySettings() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mainWindow?.window?.makeKeyAndOrderFront(nil)
        return true
    }

    // The renderer saved scrollback and asked about running processes before the web build
    // exited; here the store does the same before AppKit terminates.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if store.quitting { return .terminateNow }
        Task {
            let ok = await store.prepareQuit()
            if !ok {
                store.quitRequested = false
                store.ensureSession()
            }
            NSApp.reply(toApplicationShouldTerminate: ok)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        WidgetFeed.shared.stop()
        if !store.quitting {
            store.quitting = true
            store.saveNow()
            store.sealState()
        }
    }

    // Folders dropped on the Dock icon, or `open -a Termorc ~/dir`, open a tab there.
    func application(_ application: NSApplication, open urls: [URL]) {
        let dirs = urls.map { u -> String in
            var isDir: ObjCBool = false
            FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir)
            return isDir.boolValue ? u.path : u.deletingLastPathComponent().path
        }
        guard store.loaded, mainWindow != nil else {
            pendingFolders += dirs
            return
        }
        for dir in dirs { store.openTerminal(.init(cwd: dir)) }
        mainWindow?.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // Finder › Services › New Termorc Tab Here.
    @objc func openFolder(_ pboard: NSPasteboard, userData: String, error: AutoreleasingUnsafeMutablePointer<NSString?>) {
        let urls = (pboard.readObjects(forClasses: [NSURL.self]) as? [URL]) ?? []
        application(NSApp, open: urls)
    }

    // ---- Actions ------------------------------------------------------------------------
    @objc func runMenuAction(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? String else { return }
        run(action)
    }

    // Every shortcut and menu item lands here (App.jsx runAction).
    func run(_ action: String) {
        let sid = store.focusedSid
        if action.hasPrefix("space:") { return store.switchSpace(String(action.dropFirst(6))) }
        switch action {
        case "commandBar": toggleOverlay(.commandBar(""))
        case "newTerminal": store.openTerminal()
        case "toggleSidebar", "focusMode": store.toggleSidebar()
        case "splitRight": store.splitActive(.right)
        case "splitDown": store.splitActive(.bottom)
        case "closePane": store.closePane(sid)
        case "copyLastOutput": store.copyLastOutput(sid)
        case "prevSpace": store.switchSpace(by: -1)
        case "nextSpace": store.switchSpace(by: 1)
        case "overview": toggleOverlay(.overview)
        case "library":
            store.ui.view = store.ui.view == .library ? .terminal : .library
            store.ui.overlay = nil
            if store.ui.view == .terminal { store.syncFocus() }
        case "settings": store.toggleSettings()
        case "newSpace": store.ui.overlay = .spaceEditor(nil)
        case "prevTab": store.cycleTab(-1)
        case "nextTab": store.cycleTab(1)
        case "focusLeft": store.focusDirection(.left)
        case "focusRight": store.focusDirection(.right)
        case "focusUp": store.focusDirection(.up)
        case "focusDown": store.focusDirection(.down)
        case "jumpBottom": if let sid { store.sessions[sid]?.scrollToBottom() }
        case "clear": if let sid { store.sessions[sid]?.clear() }
        case "find": if let sid, let v = store.sessions[sid]?.view {
            let item = NSMenuItem()
            item.tag = Int(NSFindPanelAction.showFindPanel.rawValue)
            v.performFindPanelAction(item)
        }
        case "reconnect": store.reconnect(sid)
        case "zoomIn": store.zoom(1)
        case "zoomOut": store.zoom(-1)
        case "zoomReset": store.zoom(0)
        default: break
        }
    }

    private func toggleOverlay(_ o: UIState.Overlay) {
        let same: Bool
        switch (store.ui.overlay, o) {
        case (.commandBar, .commandBar), (.overview, .overview): same = true
        default: same = false
        }
        store.ui.overlay = same ? nil : o
        if same { store.syncFocus() }
    }

    // Keys the menus can't express: ⌘1–9 and ⌃1–9, the confirm sheet, the production guard
    // on Enter, and "Shell takes priority" for ⌃/⌥ shortcuts while a terminal has focus.
    private func installKeyMonitor() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self else { return e }
            return MainActor.assumeIsolated { self.handleKey(e) }
        }
        // Pinch in for All Spaces, pinch out to return (like Mission Control).
        var pinch: CGFloat = 0
        NSEvent.addLocalMonitorForEvents(matching: .magnify) { [weak self] e in
            MainActor.assumeIsolated {
                guard let self, self.store.model.settings.gestures.pinch else { return }
                if e.phase == .began { pinch = 0 }
                pinch += e.magnification
                let open = self.store.ui.overlay == .overview
                if pinch < -0.25, !open {
                    pinch = 0
                    self.store.ui.overlay = .overview
                } else if pinch > 0.25, open {
                    pinch = 0
                    self.store.ui.overlay = nil
                }
            }
            return e
        }
    }

    private func handleKey(_ e: NSEvent) -> NSEvent? {
        guard e.window === mainWindow?.window else { return e }
        let mods = e.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
        let inTerminal = e.window?.firstResponder is TermView
        let chars = e.charactersIgnoringModifiers ?? ""

        if store.ui.confirm != nil, inTerminal {
            if e.keyCode == 53 { store.resolveConfirm(false); return nil } // Esc
            if e.keyCode == 36, mods == .command { store.resolveConfirm(true); return nil }
        }

        // Esc closes Settings, unless a shortcut is being recorded or settings.json is being
        // edited (a multi-line text view that isn't a field editor).
        if e.keyCode == 53, mods.isEmpty, store.ui.view == .settings, store.ui.overlay == nil, !KeyEvents.recording,
           !((e.window?.firstResponder as? NSTextView).map { !$0.isFieldEditor } ?? false) {
            store.closeSettings()
            return nil
        }

        if let n = Int(chars), (1...9).contains(n) {
            if mods == .command { store.activateIndex(n - 1); return nil }
        }

        if inTerminal, let sid = store.focusedSid {
            if e.keyCode == 36 || e.keyCode == 76, mods.isEmpty, !store.allowEnter(sid) { return nil }
            // Let the shell have ⌃/⌥ shortcuts the menus would otherwise take.
            if store.model.settings.shellPriority, mods == .control || mods == .option || mods == [.control, .shift] {
                (e.window?.firstResponder as? NSView)?.keyDown(with: e)
                return nil
            }
        }
        return e
    }
}

extension AppDelegate: UNUserNotificationCenterDelegate {
    // Clicking a "finished" notification jumps to the session; a review request opens the PR.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let url = (response.notification.request.content.userInfo["url"] as? String).flatMap(URL.init(string:)) {
            NSWorkspace.shared.open(url)
            return completionHandler()
        }
        let sid = response.notification.request.content.userInfo["sid"] as? String
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                NSApp.activate(ignoringOtherApps: true)
                self.mainWindow?.window?.makeKeyAndOrderFront(nil)
                if let sid { self.store.jumpTo(sid) }
            }
        }
        completionHandler()
    }
}
