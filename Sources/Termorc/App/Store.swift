import AppKit
import Combine
import SwiftTerm
import TermorcCore

// Transient UI state (not persisted).
struct UIState {
    enum View { case terminal, library, settings }
    enum Overlay: Equatable {
        case commandBar(String)
        case spaceEditor(String?) // nil = a new Space
        case overview
        case tabStyle(String)
    }

    struct Toast {
        let id = uid("toast")
        var title: String
        var detail: String?
        var action: (label: String, run: () -> Void)?
    }

    struct Confirm {
        var sid: String
        var title: String
        var detail: String
        var label: String
        var danger: Bool
        var run: () -> Void
    }

    var view: View = .terminal
    var settingsOpen = false
    var settingsTab = "general"
    var overlay: Overlay?
    var focusedSid: String?
    var toast: Toast?
    var notify: Activity?
    var confirm: Confirm?
    var find = false
    var copied: String? // sid whose last output was just copied
    var dark = false // the system (or chosen) appearance is dark
    var termTheme = "dark" // resolved terminal theme
    var sshHosts: [SSHHost] = []
}

// The app's state and everything that changes it.
// AppKit views subscribe with `observe`; callbacks are coalesced to one per run-loop turn.
@MainActor
final class Store: ObservableObject {
    static let shared = Store()

    @Published var model: AppModel {
        didSet { if loaded && !quitting { writer.save(model.encoded()) } }
    }
    @Published var rt: [String: SessionRuntime] = [:]
    @Published var ui = UIState()

    let paths = Paths.current
    let home = System.home
    let library: Library
    var sessions: [String: TermSession] = [:] // the terminal registry
    var unloading = Set<String>() // pinned sessions being put to sleep (their exit keeps the row)
    private let writer: DebouncedWriter

    var loaded = false
    var quitting = false // past the quit confirmation: the saved state is final
    var quitRequested = false
    var ensureQueued = false
    private var listeners: [UUID: () -> Void] = [:]
    private var notifyScheduled = false
    private var cancellables: Set<AnyCancellable> = []
    var timers: [Timer] = []
    weak var window: NSWindow?

    private init() {
        writer = DebouncedWriter(url: paths.stateFile, delay: 0.3)
        library = Library(dir: paths.library)
        model = AppModel.initial()
        objectWillChange.sink { [weak self] in self?.scheduleNotify() }.store(in: &cancellables)
    }

    // ---- Observation ------------------------------------------------------------------
    @discardableResult
    func observe(_ fn: @escaping () -> Void) -> ObserverToken {
        let id = UUID()
        listeners[id] = fn
        return ObserverToken { [weak self] in self?.listeners[id] = nil }
    }

    private func scheduleNotify() {
        guard !notifyScheduled else { return }
        notifyScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            notifyScheduled = false
            for fn in listeners.values { fn() }
            afterChange()
        }
    }

    // ---- Runtime status ---------------------------------------------------------------
    func patchRt(_ sid: String, _ fn: (inout SessionRuntime) -> Void) {
        var r = rt[sid] ?? SessionRuntime()
        let before = r
        fn(&r)
        if r != before { rt[sid] = r }
    }

    // ---- Persistence ------------------------------------------------------------------
    func saveNow() {
        writer.save(model.encoded())
        writer.flush()
    }

    func sealState() {
        writer.flush(seal: true)
        library.flush()
    }

    // ---- Registry ---------------------------------------------------------------------
    @discardableResult
    func termSession(_ sid: String) -> TermSession {
        if let s = sessions[sid] { return s }
        let s = TermSession(sid: sid)
        s.hooks = self
        sessions[sid] = s
        configure(s)
        return s
    }

    func disposeSession(_ sid: String) {
        sessions.removeValue(forKey: sid)?.dispose()
        rt[sid] = nil
    }

    // Font, cursor and keyboard options from Settings; colors come from the Space look.
    func configure(_ s: TermSession) {
        let st = model.settings
        // Zoom scales terminals with the rest of the interface.
        s.view.font = Fonts.mono(st.fontFamily, size: st.fontSize * st.zoomLevel / 100, weight: st.fontWeight)
        s.view.optionAsMetaKey = st.optionAsMeta
        let blink = st.cursorBlink
        s.view.setCursorStyle(st.cursorStyle == "underline" ? (blink ? .blinkUnderline : .steadyUnderline) : st.cursorStyle == "bar" ? (blink ? .blinkBar : .steadyBar) : (blink ? .blinkBlock : .steadyBlock))
        s.view.changeScrollback(st.scrollback)
    }

    // Installing colors redraws the whole terminal, so an unchanged look is skipped.
    func applyLook(_ look: TerminalLook, to s: TermSession) {
        guard s.look != look else { return }
        s.look = look
        let p = look.palette
        s.view.installColors(p.ansi.map { SwiftTerm.Color(hex: $0) })
        // The pane paints the background, so block bands can sit under the text.
        s.view.nativeBackgroundColor = .clear
        s.view.nativeForegroundColor = NSColor(hex: p.foreground)
        s.view.caretColor = NSColor(hex: p.cursor)
        s.view.selectedTextBackgroundColor = NSColor(hex: p.selection.hex, alpha: p.selection.alpha)
    }

    func look(for space: Space?) -> TerminalLook {
        TerminalLook(space: space, fallbackTheme: ui.termTheme)
    }
}

final class ObserverToken {
    private let cancel: () -> Void
    init(_ cancel: @escaping () -> Void) { self.cancel = cancel }
    deinit { cancel() }
}

enum Fonts {
    // "SF Mono, Menlo, monospace": the first family installed; SF Mono and the generic names
    // map to the system monospaced font.
    static func mono(_ family: String, size: Double, weight: String) -> NSFont {
        let w = nsWeight(weight)
        for raw in family.split(separator: ",") {
            let name = raw.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "'\""))
            if ["SF Mono", "ui-monospace", "monospace", "SFMono-Regular"].contains(name) {
                return .monospacedSystemFont(ofSize: size, weight: w)
            }
            if let f = NSFontManager.shared.font(withFamily: name, traits: [], weight: fontManagerWeight(w), size: size) { return f }
            if let f = NSFont(name: name, size: size) { return f }
        }
        return .monospacedSystemFont(ofSize: size, weight: w)
    }

    static func nsWeight(_ w: String) -> NSFont.Weight {
        switch w {
        case "100": return .ultraLight
        case "200": return .thin
        case "300": return .light
        case "500": return .medium
        case "600": return .semibold
        case "bold", "700": return .bold
        case "800": return .heavy
        case "900": return .black
        default: return .regular
        }
    }

    // NSFontManager weights run 0–15, 5 being regular.
    static func fontManagerWeight(_ w: NSFont.Weight) -> Int {
        switch w {
        case .ultraLight: return 2
        case .thin: return 3
        case .light: return 4
        case .medium: return 6
        case .semibold: return 8
        case .bold: return 9
        case .heavy: return 10
        case .black: return 11
        default: return 5
        }
    }
}
