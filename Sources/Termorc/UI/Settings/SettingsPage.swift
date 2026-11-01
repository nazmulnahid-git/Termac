import AppKit
import SwiftUI
import TermorcCore

// SwiftUI has a `Settings` scene too.
typealias AppSettings = TermorcCore.Settings

// Settings as a page in place of the terminal: its groups down the left,
// the chosen group's form on the right. While it's open the sidebar shows a Settings row.
struct SettingsPage: View {
    @EnvironmentObject var store: Store

    static let tabs: [(id: String, symbol: String, label: String)] = [
        ("general", "gearshape", "General"),
        ("appearance", "paintpalette", "Appearance"),
        ("profiles", "terminal", "Profiles"),
        ("keybindings", "keyboard", "Keybindings"),
        ("gestures", "hand.draw", "Gestures"),
        ("file", "curlybraces", "settings.json"),
    ]

    var body: some View {
        let tab = Self.tabs.first { $0.id == store.ui.settingsTab } ?? Self.tabs[0]
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Self.tabs, id: \.id) { t in
                    if t.id == "file" { Divider().padding(.vertical, 6).padding(.horizontal, 8) }
                    navRow(t, on: t.id == tab.id)
                }
                Spacer()
                Button { SettingsSync.shared.openFile() } label: {
                    Label("Open in external editor", systemImage: "arrow.up.forward.square")
                }
                .buttonStyle(.borderless)
                .help(Routing.tildify(store.paths.settingsFile.path, home: store.home))
                .padding(8)
            }
            .padding(10)
            .frame(width: 210)
            Divider()
            VStack(spacing: 0) {
                HStack {
                    Text(tab.label).font(.title3.weight(.semibold))
                    Spacer()
                    Button { store.closeSettings() } label: { Image(systemName: "xmark").padding(4) }
                        .buttonStyle(.borderless)
                        .help("Close Settings (Esc)")
                }
                .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 2)
                page(tab.id).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    func navRow(_ t: (id: String, symbol: String, label: String), on: Bool) -> some View {
        Button { store.ui.settingsTab = t.id } label: {
            HStack(spacing: 8) {
                Image(systemName: t.symbol).foregroundStyle(on ? Color.accentColor : .secondary).frame(width: 20)
                Text(t.label)
                Spacer()
                if t.id == "file", SettingsSync.shared.status.error != nil {
                    Circle().fill(.red).frame(width: 7, height: 7).help(SettingsSync.shared.status.error ?? "")
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 30)
            .contentShape(Rectangle())
            .background(on ? Color.primary.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder func page(_ id: String) -> some View {
        switch id {
        case "appearance": AppearanceSettings()
        case "profiles": ProfilesSettings()
        case "keybindings": KeybindingSettings()
        case "gestures": GestureSettings()
        case "file": FileSettings()
        default: GeneralSettings()
        }
    }

    // The page inside the content area, sized by it.
    static func host() -> NSView {
        let h = NSHostingView(rootView: SettingsPage().environmentObject(Store.shared))
        h.sizingOptions = []
        return h
    }
}

// ---- Bindings ---------------------------------------------------------------------------
@MainActor
func setting<T>(_ kp: WritableKeyPath<AppSettings, T>) -> Binding<T> {
    Binding(get: { Store.shared.model.settings[keyPath: kp] }, set: { v in Store.shared.setSettings { $0[keyPath: kp] = v } })
}

struct Hint: View {
    let text: String
    var body: some View { Text(text).font(.caption).foregroundStyle(.secondary) }
}

// ---- General ----------------------------------------------------------------------------
struct GeneralSettings: View {
    @EnvironmentObject var store: Store

    var body: some View {
        Form {
            Section {
                Picker("On launch", selection: setting(\.onLaunch)) {
                    Text("Restore all Spaces and sessions").tag("restore")
                    Text("Start fresh — keeps pinned").tag("fresh")
                }
                Picker("New terminals open in", selection: setting(\.newTerminalDir)) {
                    Text("Current session's directory").tag("current")
                    Text("Space start directory").tag("space")
                    Text("Home").tag("home")
                }
                LabeledContent("Quick Terminal hotkey") { ShortcutRecorder(action: "quickTerminal") }
            }
            Section {
                Picker("Archive unpinned sessions after", selection: setting(\.archiveAfterH)) {
                    Text("1 hour idle").tag(1.0); Text("4 hours idle").tag(4.0); Text("12 hours idle").tag(12.0)
                    Text("24 hours idle").tag(24.0); Text("3 days idle").tag(72.0); Text("Never").tag(0.0)
                }
                Picker("Keep Library history for", selection: setting(\.libraryDays)) {
                    Text("30 days").tag(30.0); Text("90 days").tag(90.0); Text("365 days").tag(365.0); Text("Forever").tag(0.0)
                }
                Toggle("Never archive sessions with running processes", isOn: setting(\.neverArchiveRunning))
            }
            Section {
                Picker("Notify when a command finishes after", selection: setting(\.notifyAfterS)) {
                    Text("10 seconds").tag(10.0); Text("30 seconds").tag(30.0); Text("1 minute").tag(60.0); Text("5 minutes").tag(300.0); Text("Never").tag(0.0)
                }
                Picker("Also send a macOS notification", selection: setting(\.osNotify)) {
                    Text("Always").tag("always"); Text("Only when Termorc is in background").tag("background"); Text("Never").tag("never")
                }
                Toggle("Confirm quit with running processes", isOn: setting(\.confirmQuit))
                Toggle(isOn: setting(\.optionAsMeta)) {
                    Text("Use ⌥ as Meta key")
                    Hint(text: "Sends Esc-prefixed keys to the shell instead of typing special characters.")
                }
                Picker(selection: setting(\.promptStyle)) {
                    Text("Termorc").tag("termorc"); Text("Shell").tag("shell")
                } label: {
                    Text("Prompt")
                    Hint(text: "Termorc: an input bar with history, completion and suggestions, and each command in its own block. Shell: your shell's own prompt and theme. Applies to new sessions.")
                }
                .pickerStyle(.segmented)
                Toggle(isOn: setting(\.terminalWelcome)) {
                    Text("Tips in new sessions")
                    Hint(text: "A short card of shortcuts above the input bar until you run something.")
                }
                Toggle(isOn: setting(\.clickToMove)) {
                    Text("Click to move the cursor")
                    Hint(text: "Click inside the command you're typing to put the cursor there. Needs shell integration.")
                }
            }
        }
        .formStyle(.grouped)
    }
}

// ---- Appearance -------------------------------------------------------------------------
struct AppearanceSettings: View {
    @EnvironmentObject var store: Store
    static let fonts = ["SF Mono, Menlo, monospace", "Menlo", "JetBrains Mono", "Fira Code", "Cascadia Code", "Hack", "IBM Plex Mono", "Source Code Pro", "Monaco"]
    @State private var fontDraft = ""

    var body: some View {
        let s = store.model.settings
        let t = TermTheme.palette(store.ui.termTheme)
        Form {
            Section("Interface") {
                Picker(selection: setting(\.zoomLevel)) {
                    ForEach([80.0, 90, 100, 110, 125, 150], id: \.self) { Text("\(Int($0))%").tag($0) }
                } label: {
                    Text("Zoom")
                    Hint(text: "Text size of the sidebar and bars.")
                }
            }
            Section("Terminal") {
                preview(s, t)
                LabeledContent {
                    HStack {
                        TextField("", text: $fontDraft, onCommit: { store.setSettings { $0.fontFamily = fontDraft.trimmingCharacters(in: .whitespaces).isEmpty ? AppSettings().fontFamily : fontDraft } })
                            .textFieldStyle(.roundedBorder)
                            .onAppear { fontDraft = s.fontFamily }
                        Menu("") { ForEach(Self.fonts, id: \.self) { f in Button(f) { fontDraft = f; store.setSettings { $0.fontFamily = f } } } }
                            .menuStyle(.borderlessButton).fixedSize()
                        Stepper("\(Int(s.fontSize)) pt", value: setting(\.fontSize), in: 9...28, step: 1).fixedSize()
                    }
                } label: {
                    Text("Font")
                    Hint(text: "Only installed fonts are used; others fall back to SF Mono.")
                }
                LabeledContent("Weight") {
                    HStack {
                        Picker("", selection: setting(\.fontWeight)) {
                            Text("Light").tag("300"); Text("Regular").tag("normal"); Text("Medium").tag("500"); Text("Semibold").tag("600")
                        }.fixedSize()
                        Text("Bold").foregroundStyle(.secondary)
                        Picker("", selection: setting(\.fontWeightBold)) {
                            Text("Medium").tag("500"); Text("Semibold").tag("600"); Text("Bold").tag("bold"); Text("Heavy").tag("800")
                        }.fixedSize()
                    }
                }
                LabeledContent("Cursor") {
                    HStack {
                        Picker("", selection: setting(\.cursorStyle)) {
                            Text("Block").tag("block"); Text("Bar").tag("bar"); Text("Underline").tag("underline")
                        }.pickerStyle(.segmented).fixedSize()
                        Toggle("Blink", isOn: setting(\.cursorBlink))
                    }
                }
                Picker(selection: setting(\.termTheme)) {
                    Text("Follow system").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark")
                } label: {
                    Text("Appearance")
                    Hint(text: "The window, sidebar and terminals. Spaces with a custom background keep it.")
                }
                .pickerStyle(.segmented)
                Picker("Scrollback lines", selection: setting(\.scrollback)) {
                    Text("1,000").tag(1000); Text("5,000").tag(5000); Text("10,000").tag(10000); Text("50,000").tag(50000)
                }
            }
            Section("Sidebar") {
                Picker(selection: setting(\.sidebarMode)) {
                    Text("Expanded").tag("expanded"); Text("Compact").tag("compact"); Text("Hidden").tag("hidden")
                } label: {
                    Text("Sidebar")
                    Hint(text: "\(Keys.format(s.keybindings["toggleSidebar"])) shows and hides it · hover the left edge to peek while hidden")
                }
                .pickerStyle(.segmented)
            }
            Section("Per-Space backgrounds") {
                ForEach(store.model.spaces) { sp in
                    LabeledContent {
                        Button("Edit…") { store.ui.overlay = .spaceEditor(sp.id); NSApp.mainWindow?.makeKeyAndOrderFront(nil) }
                    } label: {
                        HStack {
                            RoundedRectangle(cornerRadius: 4).fill(Color(nsColor: NSColor(hex: TermTheme.resolveBg(sp.term, spaceColor: sp.color, fallbackTheme: store.ui.termTheme))))
                                .frame(width: 22, height: 16).overlay(RoundedRectangle(cornerRadius: 4).stroke(.separator))
                            SpaceGlyph(space: sp)
                            Text(sp.name)
                            Text(lookLabel(sp.term)).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
    }

    func lookLabel(_ term: Look) -> String {
        let name = TermTheme.presets.first { $0.bg == term.bg }?.name ?? "Custom \(term.bg ?? "")"
        return term.image.map { "\(name) · \(($0 as NSString).lastPathComponent)" } ?? name
    }

    func preview(_ s: AppSettings, _ t: Palette) -> some View {
        let font = Font(Fonts.mono(s.fontFamily, size: s.fontSize, weight: s.fontWeight))
        func c(_ hex: String) -> Color { Color(nsColor: NSColor(hex: hex)) }
        return VStack(alignment: .leading, spacing: 2) {
            (Text("❯ ").foregroundColor(c(t.green)) + Text("kubectl get pods -n staging"))
            Text("NAME                      READY   STATUS").foregroundColor(c(t.brightBlack))
            (Text("api-7d9c6b9f5-2xkqp       1/1     ") + Text("Running").foregroundColor(c(t.green)))
            (Text("worker-5f8d77c4c-1p4mz    0/1     ") + Text("Pending").foregroundColor(c(t.yellow)))
            (Text("❯ ").foregroundColor(c(t.green)) + Text("█").foregroundColor(c(t.cursor)))
        }
        .font(font)
        .foregroundColor(c(t.foreground))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(c(t.background), in: RoundedRectangle(cornerRadius: 8))
    }
}

// ---- Profiles ---------------------------------------------------------------------------
struct ProfilesSettings: View {
    @EnvironmentObject var store: Store
    @State private var selId: String?

    var body: some View {
        let profiles = store.model.profiles
        let sel = profiles.first { $0.id == (selId ?? store.model.defaultProfileId) } ?? profiles.first
        HStack(alignment: .top, spacing: 0) {
            VStack(spacing: 0) {
                List(selection: Binding(get: { sel?.id }, set: { selId = $0 })) {
                    ForEach(profiles) { p in
                        HStack {
                            Text(p.name.isEmpty ? "Untitled" : p.name)
                            Spacer()
                            if p.id == store.model.defaultProfileId { Text("default").font(.caption2).foregroundStyle(.secondary) }
                        }.tag(p.id)
                    }
                }
                .listStyle(.bordered)
                HStack {
                    Button { add() } label: { Image(systemName: "plus") }.buttonStyle(.borderless)
                    Spacer()
                }.padding(6)
            }
            .frame(width: 180)
            .frame(maxHeight: .infinity)
            if let sel { ProfileEditor(profile: sel).id(sel.id) }
        }
        .padding()
    }

    func add() {
        let p = Profile(id: uid("pf"), name: "New profile")
        store.model.profiles.append(p)
        selId = p.id
    }
}

struct ProfileEditor: View {
    @EnvironmentObject var store: Store
    let profile: Profile

    func up(_ fn: @escaping (inout Profile) -> Void) {
        guard let i = store.model.profiles.firstIndex(where: { $0.id == profile.id }) else { return }
        fn(&store.model.profiles[i])
    }

    func field(_ kp: WritableKeyPath<Profile, String>) -> Binding<String> {
        Binding(get: { store.model.profiles.first { $0.id == profile.id }?[keyPath: kp] ?? "" }, set: { v in up { $0[keyPath: kp] = v } })
    }

    var body: some View {
        let p = store.model.profiles.first { $0.id == profile.id } ?? profile
        let isDefault = store.model.defaultProfileId == p.id
        Form {
            TextField("Name", text: field(\.name))
            TextField("Command", text: field(\.command), prompt: Text("Login shell ($SHELL -l)")).font(.body.monospaced())
            Picker("Working directory", selection: field(\.cwdMode)) {
                Text("Space default (from Space settings)").tag("space"); Text("Home").tag("home"); Text("Custom").tag("custom")
            }
            if p.cwdMode == "custom" {
                HStack {
                    TextField("Directory", text: field(\.cwd), prompt: Text("~/path")).font(.body.monospaced())
                    Button("Choose…") {
                        let panel = NSOpenPanel()
                        panel.canChooseDirectories = true
                        panel.canChooseFiles = false
                        panel.canCreateDirectories = true
                        if panel.runModal() == .OK, let url = panel.url { up { $0.cwd = url.path; $0.cwdMode = "custom" } }
                    }
                }
            }
            Section {
                ForEach(Array(p.env.enumerated()), id: \.offset) { i, kv in
                    HStack {
                        TextField("NAME", text: Binding(get: { kv.first ?? "" }, set: { v in up { if $0.env.indices.contains(i) { $0.env[i] = [v.trimmingCharacters(in: .whitespaces), $0.env[i].count > 1 ? $0.env[i][1] : ""] } } }))
                        TextField("value", text: Binding(get: { kv.count > 1 ? kv[1] : "" }, set: { v in up { if $0.env.indices.contains(i) { $0.env[i] = [$0.env[i].first ?? "", v] } } }))
                        Button { up { $0.env.remove(at: i) } } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless)
                    }.font(.body.monospaced()).labelsHidden()
                }
                Button("Add variable") { up { $0.env.append(["", ""]) } }
            } header: {
                Text("Environment")
            } footer: {
                Hint(text: "$space expands to the Space name.")
            }
            Section("Start commands") {
                TextEditor(text: field(\.startup)).font(.body.monospaced()).frame(height: 70)
            }
            LabeledContent("Used by") {
                let used = store.model.spaces.filter { $0.profileId == p.id || (isDefault && $0.profileId == nil) }
                if used.isEmpty {
                    Text("No Spaces").foregroundStyle(.secondary)
                } else {
                    HStack(spacing: 10) {
                        ForEach(used) { sp in HStack(spacing: 4) { SpaceGlyph(space: sp, size: 11); Text(sp.name) } }
                    }.foregroundStyle(.secondary)
                }
            }
            HStack {
                Button(isDefault ? "Default profile" : "Set as default") { store.model.defaultProfileId = p.id }.disabled(isDefault)
                Spacer()
                Button("Delete", role: .destructive) { delete(p) }.disabled(store.model.profiles.count < 2)
            }
        }
        .formStyle(.grouped)
    }

    func delete(_ p: Profile) {
        Task {
            guard await store.confirm("Delete profile “\(p.name)”?", detail: "Spaces using it fall back to the default profile.", ok: "Delete") else { return }
            let rest = store.model.profiles.filter { $0.id != p.id }
            guard !rest.isEmpty else { return }
            for sp in store.model.spaces where sp.profileId == p.id { store.updateSpace(sp.id) { $0.profileId = nil } }
            if store.model.defaultProfileId == p.id { store.model.defaultProfileId = rest[0].id }
            store.model.profiles = rest
        }
    }
}

// ---- Keybindings ------------------------------------------------------------------------
struct KeybindingSettings: View {
    @EnvironmentObject var store: Store
    @State private var query = ""

    var body: some View {
        let kb = store.model.settings.keybindings
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        Form {
            Section {
                TextField("Search actions", text: $query)
                ForEach(Keys.actions.filter { q.isEmpty || $0.label.lowercased().contains(q) || Keys.format(kb[$0.id]).lowercased().contains(q) }, id: \.id) { a in
                    LabeledContent {
                        ShortcutRecorder(action: a.id)
                    } label: {
                        HStack {
                            Text(a.label)
                            if a.global { Text("global").font(.caption2).padding(.horizontal, 5).background(.quaternary, in: Capsule()) }
                        }
                    }
                }
            } footer: {
                Hint(text: "Click a shortcut to change it · Delete clears · Esc cancels")
            }
            Section {
                Toggle(isOn: setting(\.shellPriority)) {
                    Text("Shell takes priority")
                    Hint(text: "Shortcuts that conflict with your shell (e.g. ⌃R) are passed through unless “Shell takes priority” is on.")
                }
            }
            HStack {
                Spacer()
                Button("Reset to defaults") {
                    Task {
                        guard await store.confirm("Reset all shortcuts to their defaults?", detail: "", ok: "Reset") else { return }
                        store.setSettings { $0.keybindings = Keys.defaultBindings() }
                        QuickTerminal.shared.registerHotkey()
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}

// A key cap that records the next shortcut pressed. Taken by another action: offer to swap.
struct ShortcutRecorder: View {
    @EnvironmentObject var store: Store
    let action: String
    @State private var recording = false
    @State private var monitor: Any?
    @State private var conflict: (accel: String, other: String)?

    var body: some View {
        let accel = store.model.settings.keybindings[action] ?? ""
        HStack(spacing: 6) {
            if let c = conflict {
                Text("Used by \(Keys.label(c.other))").font(.caption).foregroundStyle(.orange)
                Button("Swap") { commit([action: c.accel, c.other: accel]) }
                Button("Clear other") { commit([action: c.accel, c.other: ""]) }
                Button("Cancel") { conflict = nil }
            }
            Button {
                recording ? stop() : start()
            } label: {
                Text(recording ? "Press keys…" : (accel.isEmpty ? "—" : Keys.format(accel)))
                    .font(.system(.body, design: .rounded))
                    .frame(minWidth: 90)
            }
            .buttonStyle(.bordered)
            .tint(recording ? .accentColor : nil)
        }
        .onDisappear { stop() }
    }

    func start() {
        conflict = nil
        recording = true
        KeyEvents.recording = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            MainActor.assumeIsolated {
                if e.keyCode == 53 { stop(); return }
                if e.keyCode == 51 || e.keyCode == 117 { commit([action: ""]); stop(); return }
                guard let accel = KeyEvents.accel(e), accel.contains("+") || e.keyCode >= 96 else { return }
                stop()
                let kb = store.model.settings.keybindings
                if let other = Keys.actions.first(where: { $0.id != action && Keys.normalize(kb[$0.id] ?? "") == accel }) {
                    conflict = (accel, other.id)
                } else {
                    commit([action: accel])
                }
            }
            return nil
        }
    }

    func stop() {
        recording = false
        KeyEvents.recording = false
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    func commit(_ patch: [String: String]) {
        conflict = nil
        store.setSettings { s in for (k, v) in patch { s.keybindings[k] = v } }
        if patch["quickTerminal"] != nil { QuickTerminal.shared.registerHotkey() }
    }
}

enum KeyEvents {
    static var recording = false // a shortcut recorder has the keyboard
    // An NSEvent as an accelerator string ("Shift+Cmd+D"), from the physical key so ⌥ and ⇧
    // don't change it (⌥Space must not become a non-breaking space).
    static let names: [UInt16: String] = [
        123: "Left", 124: "Right", 125: "Down", 126: "Up", 49: "Space", 53: "Esc", 36: "Enter", 76: "Enter", 51: "Backspace", 48: "Tab",
        18: "1", 19: "2", 20: "3", 21: "4", 23: "5", 22: "6", 26: "7", 28: "8", 25: "9", 29: "0",
        43: ",", 47: ".", 44: "/", 41: ";", 39: "'", 33: "[", 30: "]", 42: "\\", 27: "-", 24: "=", 50: "`",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12",
    ]

    static func accel(_ e: NSEvent) -> String? {
        let key: String
        if let n = names[e.keyCode] { key = n }
        else if let c = e.charactersIgnoringModifiers?.uppercased(), c.count == 1, c.first!.isLetter { key = c }
        else { return nil }
        let f = e.modifierFlags
        var mods: [String] = []
        if f.contains(.shift) { mods.append("Shift") }
        if f.contains(.control) { mods.append("Ctrl") }
        if f.contains(.option) { mods.append("Alt") }
        if f.contains(.command) { mods.append("Cmd") }
        return (mods + [key]).joined(separator: "+")
    }
}

// ---- Gestures ---------------------------------------------------------------------------
struct GestureSettings: View {
    @EnvironmentObject var store: Store

    var body: some View {
        Form {
            Section {
                gestureRow("Switch Space", "Two-finger swipe on sidebar", "hand.draw", \.gestures.swipeSpaces)
                gestureRow("All Spaces", "Pinch out · pinch in to return", "arrow.up.left.and.arrow.down.right", \.gestures.pinch)
                LabeledContent {
                    Text("Always on").foregroundStyle(.secondary)
                } label: {
                    Label { Text("Scrollback"); Hint(text: "Two-finger scroll in terminal") } icon: { Image(systemName: "arrow.up.and.down") }
                }
                gestureRow("Reveal sidebar", "When the sidebar is hidden, hover the left edge", "sidebar.left", \.gestures.edgeReveal)
                gestureRow("Peek session", "Hover a sidebar row", "eye", \.gestures.peek)
                LabeledContent {
                    Text(Keys.format(store.model.settings.keybindings["copyLastOutput"])).foregroundStyle(.secondary)
                } label: {
                    Label { Text("Copy last output"); Hint(text: "Shortcut") } icon: { Image(systemName: "doc.on.doc") }
                }
            }
        }
        .formStyle(.grouped)
    }

    func gestureRow(_ title: String, _ sub: String, _ symbol: String, _ kp: WritableKeyPath<AppSettings, Bool>) -> some View {
        Toggle(isOn: setting(kp)) {
            Label { Text(title); Hint(text: sub) } icon: { Image(systemName: symbol) }
        }
    }
}

// ---- settings.json ----------------------------------------------------------------------
struct FileSettings: View {
    @EnvironmentObject var store: Store
    @State private var text = ""
    @State private var dirty = false

    var body: some View {
        let sync = SettingsSync.shared
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(Routing.tildify(store.paths.settingsFile.path, home: store.home)).font(.callout.monospaced()).foregroundStyle(.secondary)
                Spacer()
                Button("Open in Editor") { sync.openFile() }
                Button("Save") { sync.save(text: text); dirty = false }.keyboardShortcut("s").disabled(!dirty)
            }
            if let e = sync.status.error {
                Label(e, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.callout)
            }
            ForEach(sync.status.warnings, id: \.self) { w in
                Label(w, systemImage: "exclamationmark.circle").foregroundStyle(.orange).font(.callout)
            }
            TextEditor(text: $text)
                .font(.system(size: 12, design: .monospaced))
                .frame(maxHeight: .infinity)
                .onChange(of: text) { _, _ in dirty = text != (sync.status.text ?? "") }
            Hint(text: "Edits saved here or in any editor apply right away. While the file has an error, Termorc keeps the last good settings and leaves the file alone.")
        }
        .padding()
        .onAppear { text = sync.status.text ?? ""; dirty = false }
        .onReceive(store.$model) { _ in
            if !dirty { DispatchQueue.main.async { text = SettingsSync.shared.status.text ?? text } }
        }
    }
}
