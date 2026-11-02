import Foundation

// Keybindings are stored as accelerator strings ("Shift+Cmd+D"), the same values the web
// build wrote, so one setting drives the key handler, the menu and the global hotkey.
public struct ActionDef: Sendable {
    public let id: String
    public let label: String
    public let def: String
    public let global: Bool
}

public enum Keys {
    public static let actions: [ActionDef] = [
        .init(id: "commandBar", label: "Command bar", def: "Cmd+T", global: false),
        .init(id: "newTerminal", label: "New terminal in current directory", def: "Cmd+N", global: false),
        .init(id: "quickTerminal", label: "Quick Terminal (global)", def: "Alt+Space", global: true),
        .init(id: "toggleSidebar", label: "Show / hide sidebar", def: "Cmd+S", global: false),
        .init(id: "focusMode", label: "Hide sidebar (focus mode)", def: "Ctrl+Cmd+S", global: false),
        .init(id: "splitRight", label: "Split right", def: "Cmd+D", global: false),
        .init(id: "splitDown", label: "Split down", def: "Shift+Cmd+D", global: false),
        .init(id: "closePane", label: "Close pane", def: "Cmd+W", global: false),
        .init(id: "copyLastOutput", label: "Copy last command's output", def: "Shift+Cmd+C", global: false),
        .init(id: "prevSpace", label: "Previous Space", def: "Ctrl+Alt+Left", global: false),
        .init(id: "nextSpace", label: "Next Space", def: "Ctrl+Alt+Right", global: false),
        .init(id: "overview", label: "All Spaces overview", def: "Ctrl+Alt+Up", global: false),
        .init(id: "library", label: "Library", def: "Cmd+Y", global: false),
        .init(id: "settings", label: "Settings", def: "Cmd+,", global: false),
        .init(id: "prevTab", label: "Previous session", def: "Shift+Cmd+[", global: false),
        .init(id: "nextTab", label: "Next session", def: "Shift+Cmd+]", global: false),
        .init(id: "focusLeft", label: "Focus pane left", def: "Alt+Cmd+Left", global: false),
        .init(id: "focusRight", label: "Focus pane right", def: "Alt+Cmd+Right", global: false),
        .init(id: "focusUp", label: "Focus pane up", def: "Alt+Cmd+Up", global: false),
        .init(id: "focusDown", label: "Focus pane down", def: "Alt+Cmd+Down", global: false),
        .init(id: "jumpBottom", label: "Jump to bottom", def: "Cmd+Down", global: false),
        .init(id: "clear", label: "Clear scrollback", def: "Cmd+K", global: false),
        .init(id: "find", label: "Find in terminal", def: "Cmd+F", global: false),
        .init(id: "reconnect", label: "Reconnect dropped SSH", def: "Cmd+R", global: false),
        .init(id: "newSpace", label: "New Space", def: "Shift+Cmd+N", global: false),
        .init(id: "zoomIn", label: "Bigger text", def: "Cmd+=", global: false),
        .init(id: "zoomOut", label: "Smaller text", def: "Cmd+-", global: false),
        .init(id: "zoomReset", label: "Actual size", def: "Cmd+0", global: false),
    ]

    public static func defaultBindings() -> [String: String] {
        Dictionary(uniqueKeysWithValues: actions.map { ($0.id, $0.def) })
    }

    // Defaults that were changed: macOS takes ⌃← ⌃→ (switch desktops) and ⌃↑ (Mission
    // Control), and ⌃N belongs to the shell. settings.json lists every binding, so once (the
    // first launch after the change) a value equal to one of these reads as the new default.
    static let formerDefaults = ["prevSpace": "Ctrl+Left", "nextSpace": "Ctrl+Right", "overview": "Ctrl+Up", "newSpace": "Ctrl+N"]

    public static func upgraded(_ action: String, _ accel: String) -> String {
        formerDefaults[action] == accel ? (actions.first { $0.id == action }?.def ?? accel) : accel
    }

    public static func label(_ id: String) -> String {
        actions.first { $0.id == id }?.label ?? id
    }

    static let modOrder = ["Shift", "Ctrl", "Alt", "Cmd"]
    static let aliases = ["Command": "Cmd", "CommandOrControl": "Cmd", "CmdOrCtrl": "Cmd", "Control": "Ctrl", "Option": "Alt", "Meta": "Cmd"]

    public static func normalize(_ a: String) -> String {
        guard !a.isEmpty else { return "" }
        var parts = a.components(separatedBy: "+")
        // "Cmd++" splits into an empty last part: the key is "+".
        if a.hasSuffix("++") { parts.removeLast(2); parts.append("+") }
        let key = parts.removeLast()
        let mods = parts.map { aliases[$0] ?? $0 }.sorted { (modOrder.firstIndex(of: $0) ?? 9) < (modOrder.firstIndex(of: $1) ?? 9) }
        return (mods + [key.count == 1 ? key.uppercased() : key]).joined(separator: "+")
    }

    // A parsed accelerator: modifier names and the key ("D", "Left", ",", "Space"…).
    public static func split(_ a: String) -> (mods: Set<String>, key: String)? {
        let n = normalize(a)
        guard !n.isEmpty else { return nil }
        var parts = n.components(separatedBy: "+")
        if n.hasSuffix("++") { parts.removeLast(2); parts.append("+") }
        let key = parts.removeLast()
        return (Set(parts), key)
    }

    static let glyph = ["Shift": "⇧", "Ctrl": "⌃", "Alt": "⌥", "Cmd": "⌘", "Left": "←", "Right": "→", "Up": "↑", "Down": "↓", "Enter": "↵", "Esc": "esc", "Space": "Space", "Tab": "⇥", "Backspace": "⌫"]

    public static func format(_ a: String?) -> String {
        guard let a, let (mods, key) = split(a) else { return "" }
        let order = ["Ctrl", "Alt", "Shift", "Cmd"]
        let m = order.filter { mods.contains($0) }.compactMap { glyph[$0] }.joined()
        if let g = glyph[key] { return m + (key == "Space" ? " Space" : g) }
        return m + key
    }

    // Shortcuts the shell normally owns; with "Shell takes priority" they pass through.
    public static func isShellKey(_ accel: String) -> Bool {
        accel.hasPrefix("Ctrl+") || accel.hasPrefix("Alt+")
    }
}
