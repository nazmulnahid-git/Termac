import AppKit
import TermorcCore

// Keeps ~/.termorc/settings.json and the in-app settings in step. Changes made in the app
// write the file back; edits made in an editor apply live. While the file has a syntax
// error it isn't overwritten, so a half-finished edit is never lost.
@MainActor
final class SettingsSync {
    static let shared = SettingsSync()

    struct Status {
        var text: String?
        var error: String?
        var warnings: [String] = []
    }

    private(set) var status = Status()
    private var fileSettings: Settings? // last read from or written to the file
    private var knownText: String? // what's on disk, so our own writes don't echo back
    private var source: DispatchSourceFileSystemObject?
    private var writeWork: DispatchWorkItem?
    private var readWork: DispatchWorkItem?
    private var token: ObserverToken?
    private var sealed = false

    var paths: Paths { Store.shared.paths }
    var schemaUrl: String { "file://" + paths.schemaFile.path }

    // At boot: the file wins over state.json. With no file yet, write one.
    func load(into settings: inout Settings) {
        try? Persistence.writeIfChanged(paths.schemaFile, SettingsFile.schema())
        let text = try? String(contentsOf: paths.settingsFile, encoding: .utf8)
        knownText = text
        status.text = text
        if let text, let parsed = parse(text, over: settings) {
            settings = parsed
        }
        fileSettings = text == nil ? nil : settings
    }

    func start() {
        let store = Store.shared
        if status.text == nil { write(store.model.settings) }
        if let e = status.error { store.toast("settings.json has an error", detail: e, action: ("Open", { self.openFile() }), seconds: 8) }
        else if !status.warnings.isEmpty { store.toast("settings.json has problems", detail: status.warnings.prefix(2).joined(separator: " · "), action: ("Open", { self.openFile() }), seconds: 8) }
        watch()
        token = store.observe { [weak self] in self?.modelChanged() }
    }

    private func modelChanged() {
        let s = Store.shared.model.settings
        guard !sealed, s != fileSettings, status.error == nil else { return }
        writeWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.write(Store.shared.model.settings) }
        writeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    func write(_ s: Settings) {
        guard !sealed else { return }
        fileSettings = s
        let text = SettingsFile.toFile(s, schemaUrl: schemaUrl)
        status.text = text
        guard text != knownText else { return }
        knownText = text
        try? Persistence.writeAtomic(paths.settingsFile, Data(text.utf8))
    }

    func flush() {
        if let w = writeWork, !w.isCancelled {
            w.cancel()
            write(Store.shared.model.settings)
        }
        sealed = true
    }

    private func parse(_ text: String, over current: Settings) -> Settings? {
        do {
            let r = try SettingsFile.parse(text, over: current)
            status.error = nil
            status.warnings = r.warnings
            return r.settings
        } catch SettingsFile.ParseError.syntax(let msg) {
            status.error = msg
            status.warnings = []
            return nil
        } catch {
            status.error = "\(error)"
            return nil
        }
    }

    // Saves text typed in the in-app editor and applies it, as if edited on disk.
    func save(text: String) {
        knownText = text
        try? Persistence.writeAtomic(paths.settingsFile, Data(text.utf8))
        apply(text)
    }

    private func apply(_ text: String) {
        let store = Store.shared
        status.text = text
        let prev = store.model.settings
        guard let next = parse(text, over: prev) else {
            store.toast("settings.json has an error", detail: "\(status.error ?? ""). Keeping the last good settings.", action: ("Open", { self.openFile() }), seconds: 8)
            store.objectWillChange.send()
            return
        }
        fileSettings = next
        store.setSettings { $0 = next }
        if next.keybindings["quickTerminal"] != prev.keybindings["quickTerminal"] { QuickTerminal.shared.registerHotkey() }
        let w = status.warnings
        if !w.isEmpty { store.toast("settings.json: \(w.count) problem\(w.count > 1 ? "s" : "")", detail: w.prefix(2).joined(separator: " · "), action: ("Open", { self.openFile() }), seconds: 8) }
        else { store.toast("Settings reloaded", detail: "Applied changes from settings.json.") }
    }

    // Editors often save by replacing the file, so watch the folder rather than the file.
    private func watch() {
        try? FileManager.default.createDirectory(at: paths.settingsDir, withIntermediateDirectories: true)
        let fd = open(paths.settingsDir.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete, .extend], queue: .main)
        src.setEventHandler { [weak self] in self?.scheduleRead() }
        src.setCancelHandler { close(fd) }
        src.resume()
        source = src
    }

    private func scheduleRead() {
        readWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !sealed, let text = try? String(contentsOf: paths.settingsFile, encoding: .utf8), text != knownText else { return }
            knownText = text
            apply(text)
        }
        readWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
    }

    func openFile() {
        // No app registered for .json opens nothing; fall back to showing it in Finder.
        if !NSWorkspace.shared.open(paths.settingsFile) { NSWorkspace.shared.activateFileViewerSelecting([paths.settingsFile]) }
    }
}
