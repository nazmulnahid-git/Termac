import Foundation

// ~/.termorc/settings.json: the user-editable mirror of Settings. The file is nested and
// snake_case (appearance.terminal.font_size); the app keeps flat camelCase keys. `fields`
// maps one to the other and drives validation and the generated JSON Schema. Same format,
// key order and indentation as the web build's settingsfile.js.
public enum SettingsFile {
    enum Kind {
        case choice([String])
        case bool
        case number(min: Double, max: Double, int: Bool)
        case string
    }

    enum Value: Equatable {
        case s(String), b(Bool), n(Double)
    }

    struct Field {
        let path: [String]
        let kind: Kind
        let desc: String?
        let get: (Settings) -> Value
        let set: (inout Settings, Value) -> Void
    }

    // Retired actions and settings older files may still list.
    static let retiredActions: Set<String> = ["findTab", "notes", "toggleFiles", "quickOpen", "toggleReview"]
    static let retiredSettings: Set<String> = ["appearance.sidebar.width"]

    static func s(_ p: String, _ kp: WritableKeyPath<Settings, String>, _ kind: Kind = .string, _ desc: String? = nil) -> Field {
        Field(path: p.components(separatedBy: "."), kind: kind, desc: desc, get: { .s($0[keyPath: kp]) }, set: { if case .s(let v) = $1 { $0[keyPath: kp] = v } })
    }

    static func b(_ p: String, _ kp: WritableKeyPath<Settings, Bool>, _ desc: String? = nil) -> Field {
        Field(path: p.components(separatedBy: "."), kind: .bool, desc: desc, get: { .b($0[keyPath: kp]) }, set: { if case .b(let v) = $1 { $0[keyPath: kp] = v } })
    }

    static func n(_ p: String, _ kp: WritableKeyPath<Settings, Double>, _ min: Double, _ max: Double, int: Bool = false, _ desc: String? = nil) -> Field {
        Field(path: p.components(separatedBy: "."), kind: .number(min: min, max: max, int: int), desc: desc, get: { .n($0[keyPath: kp]) }, set: { if case .n(let v) = $1 { $0[keyPath: kp] = v } })
    }

    static let fields: [Field] = [
        s("appearance.theme", \.termTheme, .choice(["system", "dark", "light"]), "Light or dark for the whole app, or follow the system. Spaces with a custom terminal background keep it."),
        n("appearance.zoom_level", \.zoomLevel, 50, 200, int: true, "Zoom for the whole window, in percent."),
        s("appearance.ui.font_family", \.uiFontFamily, .string, "Font for the interface (sidebar, bars, menus). \"system-ui\" is SF Pro on macOS."),
        n("appearance.ui.font_size", \.uiFontSize, 10, 20, "Interface font size in px."),
        n("appearance.ui.line_height", \.uiLineHeight, 1, 2, "Interface line height, as a multiple of the font size."),
        s("appearance.terminal.font_family", \.fontFamily, .string, "Terminal font. A comma-separated list works; SF Mono is the fallback."),
        n("appearance.terminal.font_size", \.fontSize, 9, 28, "Terminal font size in pt. ⌘= / ⌘- change it too."),
        n("appearance.terminal.line_height", \.lineHeight, 1, 2, "Terminal line height, as a multiple of the font size."),
        n("appearance.terminal.letter_spacing", \.letterSpacing, -2, 4, "Extra space between characters, in px."),
        s("appearance.terminal.font_weight", \.fontWeight, .choice(["normal", "300", "400", "500", "600", "700"]), "Weight of regular text."),
        s("appearance.terminal.font_weight_bold", \.fontWeightBold, .choice(["bold", "500", "600", "700", "800"]), "Weight of bold text."),
        s("appearance.terminal.cursor_style", \.cursorStyle, .choice(["block", "bar", "underline"])),
        b("appearance.terminal.cursor_blink", \.cursorBlink),
        s("appearance.sidebar.mode", \.sidebarMode, .choice(["expanded", "compact", "hidden"])),
        s("general.on_launch", \.onLaunch, .choice(["restore", "fresh"]), "\"fresh\" starts with only pinned sessions."),
        s("general.new_terminal_dir", \.newTerminalDir, .choice(["current", "space", "home"]), "Where new terminals start."),
        b("general.confirm_quit", \.confirmQuit, "Ask before quitting while processes are running."),
        Field(path: ["terminal", "scrollback"], kind: .number(min: 100, max: 200_000, int: true), desc: "Lines kept per session.",
              get: { .n(Double($0.scrollback)) }, set: { if case .n(let v) = $1 { $0.scrollback = Int(v) } }),
        b("terminal.option_as_meta", \.optionAsMeta, "Send ⌥ as Meta (Esc-prefixed keys) instead of typing special characters."),
        s("terminal.prompt", \.promptStyle, .choice(["termorc", "shell"]), "\"termorc\": Termorc's input bar and command blocks. \"shell\": your shell's own prompt. Applies to new sessions."),
        b("terminal.welcome", \.terminalWelcome, "Show the tips card in a new, empty session."),
        b("terminal.click_to_move", \.clickToMove, "Click inside the command you are typing to move the cursor there."),
        b("terminal.shell_priority", \.shellPriority, "Let the shell have Ctrl shortcuts that the app would otherwise take."),
        n("sessions.archive_after_hours", \.archiveAfterH, 0, 8760, "Archive idle unpinned sessions after this many hours. 0 = never."),
        b("sessions.never_archive_running", \.neverArchiveRunning),
        n("sessions.library_days", \.libraryDays, 0, 3650, int: true, "Days of history kept in the Library. 0 = forever."),
        n("notifications.after_seconds", \.notifyAfterS, 0, 86400, int: true, "Notify when a command runs longer than this. 0 = never."),
        s("notifications.os", \.osNotify, .choice(["always", "background", "never"]), "When to also send a macOS notification."),
        b("gestures.swipe_spaces", \.gestures.swipeSpaces, "Two-finger swipe switches Spaces."),
        b("gestures.pinch", \.gestures.pinch, "Pinch opens the overview of all Spaces."),
        b("gestures.edge_reveal", \.gestures.edgeReveal, "Hovering the left edge reveals a hidden sidebar."),
        b("gestures.peek", \.gestures.peek, "Hovering a session previews it."),
    ]

    // Strips // and /* */ comments and trailing commas, leaving strings alone.
    public static func stripJsonc(_ text: String) -> String {
        let c = Array(text)
        var out = ""
        var i = 0
        while i < c.count {
            let ch = c[i]
            if ch == "\"" {
                var j = i + 1
                while j < c.count, c[j] != "\"" { j += c[j] == "\\" ? 2 : 1 }
                out += String(c[i..<min(j + 1, c.count)])
                i = j + 1
            } else if ch == "/", i + 1 < c.count, c[i + 1] == "/" {
                while i < c.count, c[i] != "\n" { i += 1 }
                out += "\n"
                i += 1
            } else if ch == "/", i + 1 < c.count, c[i + 1] == "*" {
                var j = i + 2
                while j + 1 < c.count, !(c[j] == "*" && c[j + 1] == "/") { j += 1 }
                let end = min(j + 2, c.count)
                out += String(c[i..<end]).map { $0 == "\n" ? "\n" : " " } // keep line numbers in errors
                i = end
            } else {
                out.append(ch)
                i += 1
            }
        }
        return out.replacingOccurrences(of: #",(\s*[}\]])"#, with: "$1", options: .regularExpression)
    }

    public struct Parsed {
        public var settings: Settings
        public var warnings: [String]
    }

    public enum ParseError: Error, Equatable { case syntax(String) }

    // Text → the settings it describes, over `current` (so state-only settings survive).
    // Missing keys get their default, invalid ones fall back (numbers are clamped) and are
    // listed in `warnings`. A syntax error throws.
    public static func parse(_ text: String, over current: Settings = Settings()) throws -> Parsed {
        let obj: Any
        do {
            obj = try JSONSerialization.jsonObject(with: Data(stripJsonc(text).utf8), options: [.fragmentsAllowed])
        } catch {
            throw ParseError.syntax((error as NSError).userInfo[NSDebugDescriptionErrorKey] as? String ?? error.localizedDescription)
        }
        guard let root = obj as? [String: Any] else { throw ParseError.syntax("The file must contain a JSON object { … }") }
        let defaults = Settings()
        var settings = current
        var warnings = unknownKeys(root, prefix: [])
        for f in fields {
            let name = f.path.joined(separator: ".")
            let def = f.get(defaults)
            guard let raw = lookup(root, f.path) else {
                f.set(&settings, def)
                continue
            }
            let (value, error) = check(f, raw, def, name)
            f.set(&settings, value)
            if let error { warnings.append(error) }
        }
        settings.keybindings = defaults.keybindings
        if let kb = root["keybindings"] {
            if let kb = kb as? [String: Any] {
                for (action, accel) in kb.sorted(by: { $0.key < $1.key }) {
                    if retiredActions.contains(action) { continue }
                    if defaults.keybindings[action] == nil { warnings.append("keybindings.\(action): unknown action") }
                    else if let a = accel as? String { settings.keybindings[action] = a.trimmingCharacters(in: .whitespaces) }
                    else { warnings.append("keybindings.\(action): expected a shortcut like \"Cmd+T\", or \"\" to turn it off") }
                }
            } else {
                warnings.append("keybindings: expected an object of \"action\": \"Shortcut\"")
            }
        }
        return Parsed(settings: settings, warnings: warnings)
    }

    static func lookup(_ obj: [String: Any], _ path: [String]) -> Any? {
        var cur: Any? = obj
        for k in path { cur = (cur as? [String: Any])?[k] }
        return cur
    }

    static func isBool(_ v: Any) -> Bool { (v as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? false }

    static func check(_ f: Field, _ raw: Any, _ def: Value, _ name: String) -> (Value, String?) {
        switch f.kind {
        case .choice(let values):
            let v: String? = (raw as? String) ?? ((raw as? NSNumber).flatMap { isBool(raw) ? nil : format($0.doubleValue) })
            if let v, values.contains(v) { return (.s(v), nil) }
            return (def, "\(name): expected one of \(values.map { "\"\($0)\"" }.joined(separator: ", "))")
        case .bool:
            if isBool(raw), let n = raw as? NSNumber { return (.b(n.boolValue), nil) }
            return (def, "\(name): expected true or false")
        case let .number(min, max, int):
            guard !isBool(raw), let n = raw as? NSNumber, n.doubleValue.isFinite else { return (def, "\(name): expected a number") }
            let value = n.doubleValue
            var v = int ? value.rounded() : value
            v = Swift.min(max, Swift.max(min, v))
            return v == value ? (.n(v), nil) : (.n(v), "\(name): \(format(value)) is out of range, using \(format(v)) (\(format(min))–\(format(max)))")
        case .string:
            if let s = raw as? String, !s.trimmingCharacters(in: .whitespaces).isEmpty { return (.s(s.trimmingCharacters(in: .whitespaces)), nil) }
            return (def, "\(name): expected a non-empty string")
        }
    }

    static let leaves = Set(fields.map { $0.path.joined(separator: ".") })
    static let sections = Set(fields.flatMap { f in (1..<f.path.count).map { f.path[0..<$0].joined(separator: ".") } })

    // Keys the app doesn't know, so typos don't fail silently.
    static func unknownKeys(_ obj: [String: Any], prefix: [String]) -> [String] {
        var out: [String] = []
        for (k, v) in obj.sorted(by: { $0.key < $1.key }) {
            if prefix.isEmpty, k == "$schema" || k == "keybindings" { continue }
            let p = prefix + [k]
            let id = p.joined(separator: ".")
            if let sub = v as? [String: Any], sections.contains(id) { out += unknownKeys(sub, prefix: p) }
            else if !leaves.contains(id), !retiredSettings.contains(id) { out.append("\(id): unknown setting") }
        }
        return out
    }

    // Numbers the way JavaScript prints them: 125, 12.5, 1.35.
    static func format(_ d: Double) -> String {
        if d == d.rounded(), abs(d) < 1e15 { return String(Int64(d)) }
        return String(d)
    }

    // ---- Writing ----------------------------------------------------------------------
    // A tiny ordered JSON tree, so the file keeps the web build's key order.
    indirect enum Node {
        case object([(String, Node)])
        case value(Value)
    }

    static func insert(_ node: inout [(String, Node)], _ path: ArraySlice<String>, _ v: Value) {
        let k = path.first!
        if path.count == 1 { node.append((k, .value(v))); return }
        if let i = node.firstIndex(where: { $0.0 == k }), case .object(var sub) = node[i].1 {
            insert(&sub, path.dropFirst(), v)
            node[i].1 = .object(sub)
        } else {
            var sub: [(String, Node)] = []
            insert(&sub, path.dropFirst(), v)
            node.append((k, .object(sub)))
        }
    }

    static func quote(_ s: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [s], options: [.withoutEscapingSlashes])
        let arr = String(decoding: data, as: UTF8.self)
        return String(arr.dropFirst().dropLast())
    }

    static func render(_ n: Node, _ indent: String) -> String {
        switch n {
        case .value(.s(let s)): return quote(s)
        case .value(.b(let b)): return b ? "true" : "false"
        case .value(.n(let d)): return format(d)
        case .object(let kv):
            if kv.isEmpty { return "{}" }
            let inner = indent + "  "
            return "{\n" + kv.map { "\(inner)\(quote($0.0)): \(render($0.1, inner))" }.joined(separator: ",\n") + "\n\(indent)}"
        }
    }

    public static func toFile(_ settings: Settings, schemaUrl: String?) -> String {
        var root: [(String, Node)] = []
        if let schemaUrl, !schemaUrl.isEmpty { root.append(("$schema", .value(.s(schemaUrl)))) }
        for f in fields { insert(&root, f.path[...], f.get(settings)) }
        // Object.keys order in the web build: the defaults' order, as ACTIONS lists them.
        let order = Keys.actions.map(\.id)
        let kb = order.compactMap { id in settings.keybindings[id].map { (id, Node.value(.s($0))) } }
        root.append(("keybindings", .object(kb)))
        return render(.object(root), "") + "\n"
    }

    // JSON Schema (draft-07) for editors: completion, hover docs and squiggles for bad values.
    public static func schema() -> String {
        let defaults = Settings()
        var root: [String: Any] = ["$schema": "http://json-schema.org/draft-07/schema#", "title": "Termorc settings", "type": "object", "additionalProperties": false]
        var props: [String: Any] = ["$schema": ["type": "string"]]
        func place(_ path: ArraySlice<String>, _ leaf: [String: Any], into props: inout [String: Any]) {
            let k = path.first!
            if path.count == 1 { props[k] = leaf; return }
            var node = props[k] as? [String: Any] ?? ["type": "object", "properties": [String: Any](), "additionalProperties": false]
            var sub = node["properties"] as? [String: Any] ?? [:]
            place(path.dropFirst(), leaf, into: &sub)
            node["properties"] = sub
            props[k] = node
        }
        for f in fields {
            var leaf: [String: Any] = [:]
            switch f.get(defaults) {
            case .s(let s): leaf["default"] = s
            case .b(let b): leaf["default"] = b
            case .n(let d): leaf["default"] = d
            }
            if let d = f.desc { leaf["description"] = d }
            switch f.kind {
            case .choice(let v): leaf["enum"] = v
            case .bool: leaf["type"] = "boolean"
            case let .number(min, max, int):
                leaf["type"] = int ? "integer" : "number"
                leaf["minimum"] = min
                leaf["maximum"] = max
            case .string: leaf["type"] = "string"
            }
            place(f.path[...], leaf, into: &props)
        }
        props["keybindings"] = [
            "type": "object",
            "description": "Shortcuts as Electron accelerators (\"Shift+Cmd+D\"). Use \"\" to turn one off.",
            "properties": Dictionary(uniqueKeysWithValues: Keys.actions.map { ($0.id, ["type": "string", "description": $0.label, "default": $0.def]) }),
            "additionalProperties": false,
        ]
        root["properties"] = props
        let data = try! JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self) + "\n"
    }
}
