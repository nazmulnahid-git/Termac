import AppKit
import SwiftUI
import TermorcCore

// The Space editor: name, icon, color, shell profile, start directory, archive policy, and
// the terminal background (preset, custom color or image with dim and blur).
struct SpaceEditor: View {
    @EnvironmentObject var store: Store
    let spaceId: String?
    let close: () -> Void
    @State private var form: Space
    @FocusState private var nameFocused: Bool

    init(spaceId: String?, close: @escaping () -> Void) {
        self.spaceId = spaceId
        self.close = close
        let s = Store.shared.model
        if let sp = s.spaces.first(where: { $0.id == spaceId }) {
            _form = State(initialValue: sp)
        } else {
            // A new Space: the first color and glyph not already taken.
            let color = Meta.spaceColors.first { c in !s.spaces.contains { $0.color.lowercased() == c } } ?? Meta.spaceColors[0]
            let glyph = Meta.spaceGlyphs.first { g in !s.spaces.contains { $0.glyph == g } } ?? Meta.spaceGlyphs[0]
            var sp = Space(name: "", glyph: glyph, color: color)
            sp.term = Look()
            _form = State(initialValue: sp)
        }
    }

    var editing: Bool { spaceId != nil }

    var body: some View {
        let color = Color(nsColor: NSColor(hex: form.color))
        let look = TerminalLook(space: form, fallbackTheme: store.ui.termTheme)
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                glyphView(size: 18).foregroundStyle(color)
                Text(form.name.trimmingCharacters(in: .whitespaces).isEmpty ? (editing ? "Untitled Space" : "New Space") : form.name)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(form.name.isEmpty ? .secondary : .primary)
                Spacer()
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
            .background(color.opacity(0.14))
            Form {
                TextField("Name", text: $form.name, prompt: Text("Work, Side project, Servers…")).focused($nameFocused)
                LabeledContent("Icon") {
                    HStack(spacing: 6) {
                        ForEach(Meta.spaceGlyphs, id: \.self) { g in
                            Button { form.glyph = g; form.iconImage = nil } label: {
                                Text(g).frame(width: 26, height: 26)
                                    .background(form.iconImage == nil && form.glyph == g ? color.opacity(0.25) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                            }.buttonStyle(.plain)
                        }
                        Button { chooseIcon() } label: {
                            Group {
                                if let img = iconImage { Image(nsImage: img).resizable().scaledToFill() } else { Image(systemName: "photo.badge.plus") }
                            }
                            .frame(width: 26, height: 26).clipShape(RoundedRectangle(cornerRadius: 6))
                        }.buttonStyle(.plain).help(form.iconImage == nil ? "Use an image…" : "Change image…")
                    }
                }
                LabeledContent("Color") {
                    HStack(spacing: 6) {
                        ForEach(Meta.spaceColors, id: \.self) { c in
                            Button { form.color = c } label: {
                                Circle().fill(Color(nsColor: NSColor(hex: c))).frame(width: 18, height: 18)
                                    .overlay(Circle().stroke(Color.primary, lineWidth: form.color.lowercased() == c ? 2 : 0).padding(-3))
                            }.buttonStyle(.plain)
                        }
                        ColorPicker("", selection: Binding(get: { color }, set: { form.color = hex(NSColor($0)) }), supportsOpacity: false).labelsHidden()
                    }
                }
                Picker("Shell profile", selection: Binding(get: { form.profileId ?? "" }, set: { form.profileId = $0.isEmpty ? nil : $0 })) {
                    Text("Default profile").tag("")
                    ForEach(store.model.profiles) { Text($0.name).tag($0.id) }
                }
                LabeledContent("Start directory") {
                    HStack {
                        TextField("", text: $form.startDir, prompt: Text("~")).font(.body.monospaced())
                        Button("Choose…") {
                            let p = NSOpenPanel()
                            p.canChooseDirectories = true
                            p.canChooseFiles = false
                            p.directoryURL = URL(fileURLWithPath: Routing.expandHome(form.startDir.isEmpty ? "~" : form.startDir, home: store.home))
                            if p.runModal() == .OK, let u = p.url { form.startDir = Routing.tildify(u.path, home: store.home) }
                        }
                    }
                }
                Picker("Archive after", selection: Binding(get: { form.archiveAfterH ?? -1 }, set: { form.archiveAfterH = $0 < 0 ? nil : $0 })) {
                    Text("Default (\(hoursLabel(store.model.settings.archiveAfterH)))").tag(-1.0)
                    ForEach([1.0, 4, 12, 24, 72, 0], id: \.self) { Text(hoursLabel($0)).tag($0) }
                }
                Section("Terminal") {
                    LabeledContent("Background") {
                        VStack(alignment: .trailing, spacing: 4) {
                            HStack(spacing: 5) {
                                ForEach(TermTheme.presets, id: \.id) { p in
                                    let bg = p.bg == "tint" ? TermTheme.resolveBg(Look(bg: "tint"), spaceColor: form.color, fallbackTheme: "dark") : (p.bg ?? TermTheme.palette(store.ui.termTheme).background)
                                    Button { form.term.bg = p.bg } label: {
                                        RoundedRectangle(cornerRadius: 5).fill(Color(nsColor: NSColor(hex: bg))).frame(width: 22, height: 22)
                                            .overlay(RoundedRectangle(cornerRadius: 5).stroke(form.term.bg == p.bg ? Color.accentColor : Color.secondary.opacity(0.3), lineWidth: form.term.bg == p.bg ? 2 : 0.5))
                                            .overlay(p.bg == nil ? Image(systemName: "circle.lefthalf.filled").font(.caption2).foregroundStyle(.secondary) : nil)
                                    }.buttonStyle(.plain).help(p.name)
                                }
                                ColorPicker("", selection: Binding(get: { Color(nsColor: NSColor(hex: look.bg)) }, set: { form.term.bg = hex(NSColor($0)) }), supportsOpacity: false).labelsHidden()
                            }
                            Text(TermTheme.presets.first { $0.bg == form.term.bg }?.name ?? "Custom \(form.term.bg ?? "")").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    LabeledContent("Image") {
                        HStack {
                            if let img = form.term.image { Text((img as NSString).lastPathComponent).lineLimit(1).truncationMode(.middle).foregroundStyle(.secondary) }
                            Button(form.term.image == nil ? "Choose image…" : "Change…") { chooseImage() }
                            if form.term.image != nil { Button("Remove") { form.term.image = nil } }
                        }
                    }
                    if form.term.image != nil {
                        LabeledContent("Dim") { HStack { Slider(value: $form.term.dim, in: 0...0.95); Text("\(Int(form.term.dim * 100))%").monospacedDigit().frame(width: 40) } }
                        LabeledContent("Blur") { HStack { Slider(value: $form.term.blur, in: 0...20, step: 1); Text("\(Int(form.term.blur))px").monospacedDigit().frame(width: 40) } }
                    }
                    preview(look)
                }
            }
            .formStyle(.grouped)
            .frame(maxHeight: .infinity)
            HStack {
                if editing && store.model.spaces.count > 1 {
                    Button("Delete Space…", role: .destructive) { close(); store.deleteSpace(form.id) }
                }
                Spacer()
                Button("Cancel", action: close).keyboardShortcut(.cancelAction)
                Button(editing ? "Save Space" : "Create Space", action: submit).keyboardShortcut(.defaultAction).tint(color)
                    .disabled(form.name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { nameFocused = true }
    }

    private var iconImage: NSImage? {
        guard let s = form.iconImage, let comma = s.firstIndex(of: ","), let data = Data(base64Encoded: String(s[s.index(after: comma)...])) else { return nil }
        return NSImage(data: data)
    }

    @ViewBuilder func glyphView(size: CGFloat) -> some View {
        if let img = iconImage { Image(nsImage: img).resizable().frame(width: size + 4, height: size + 4).clipShape(RoundedRectangle(cornerRadius: 4)) }
        else { Text(form.glyph).font(.system(size: size)) }
    }

    func hoursLabel(_ h: Double) -> String {
        switch h {
        case 0: return "Never"
        case 1: return "1 hour idle"
        case 72: return "3 days idle"
        default: return "\(Int(h)) hours idle"
        }
    }

    func hex(_ c: NSColor) -> String {
        let c = c.usingColorSpace(.sRGB) ?? c
        return TermTheme.toHex((Double(c.redComponent * 255), Double(c.greenComponent * 255), Double(c.blueComponent * 255)))
    }

    func preview(_ look: TerminalLook) -> some View {
        let p = look.palette
        func c(_ h: String) -> Color { Color(nsColor: NSColor(hex: h)) }
        return VStack(alignment: .leading, spacing: 2) {
            (Text("❯ ").foregroundColor(c(p.green)) + Text("git status"))
            (Text("On branch ") + Text("main").foregroundColor(c(p.magenta)))
            Text("modified:   src/app.ts").foregroundColor(c(p.red))
            (Text("❯ ").foregroundColor(c(p.green)) + Text("█").foregroundColor(c(p.cursor)))
        }
        .font(.system(size: 12, design: .monospaced))
        .foregroundColor(c(p.foreground))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background {
            ZStack {
                c(look.bg)
                if let path = look.image, let img = NSImage(contentsOfFile: path) {
                    // Filling, the image takes its own size; in an overlay of a view that
                    // has the box's size, and clipped, it can't be seen over the rows above.
                    Color.clear
                        .overlay { Image(nsImage: img).resizable().scaledToFill().blur(radius: look.blur) }
                        .clipped()
                    c(look.bg).opacity(look.dim)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
            // Clipping only hides the overflow: a large image still took every click in the
            // sheet. The preview is decoration, so it takes none.
            .allowsHitTesting(false)
        }
    }

    func chooseImage() {
        let p = NSOpenPanel()
        p.allowedContentTypes = [.png, .jpeg, .webP, .gif, .heic]
        if p.runModal() == .OK, let u = p.url { form.term.image = u.path }
    }

    // Space icons are stored as small PNG data URLs.
    func chooseIcon() {
        let p = NSOpenPanel()
        p.allowedContentTypes = [.png, .jpeg, .webP, .gif, .heic]
        guard p.runModal() == .OK, let u = p.url, let img = NSImage(contentsOf: u) else { return }
        let side: CGFloat = 64
        let out = NSImage(size: NSSize(width: side, height: side))
        out.lockFocus()
        let s = img.size
        let scale = max(side / s.width, side / s.height)
        img.draw(in: NSRect(x: (side - s.width * scale) / 2, y: (side - s.height * scale) / 2, width: s.width * scale, height: s.height * scale))
        out.unlockFocus()
        guard let tiff = out.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
        form.iconImage = "data:image/png;base64," + png.base64EncodedString()
    }

    func submit() {
        var f = form
        f.name = f.name.trimmingCharacters(in: .whitespaces)
        guard !f.name.isEmpty else { return }
        if f.startDir.trimmingCharacters(in: .whitespaces).isEmpty { f.startDir = "~" }
        if editing {
            store.updateSpace(f.id) { sp in
                sp.name = f.name; sp.glyph = f.glyph; sp.iconImage = f.iconImage; sp.color = f.color
                sp.profileId = f.profileId; sp.startDir = f.startDir; sp.archiveAfterH = f.archiveAfterH; sp.term = f.term
            }
        } else {
            store.createSpace(f)
        }
        MainMenu.rebuild()
        close()
    }
}

// Icon & color for one session. Picks apply right away, so the sidebar row behind the
// sheet previews them.
struct TabStyleEditor: View {
    @EnvironmentObject var store: Store
    let tid: String
    let close: () -> Void
    let columns = Array(repeating: GridItem(.fixed(30), spacing: 6), count: 12)

    var body: some View {
        let tab = store.model.tabs[tid]
        VStack(alignment: .leading, spacing: 14) {
            Text("Icon & color").font(.headline)
            Text("Icon").font(.subheadline).foregroundStyle(.secondary)
            LazyVGrid(columns: columns, spacing: 6) {
                cell(selected: tab?.icon == nil) { Image(systemName: "nosign") } action: { store.setTabStyle(tid, icon: .some(nil)) }
                ForEach(KindIcons.tabIcons, id: \.0) { id, spec in
                    cell(selected: tab?.icon == id) { Image(nsImage: KindIcons.symbol(spec) ?? NSImage()) } action: { store.setTabStyle(tid, icon: .some(id)) }
                        .help(id)
                }
            }
            Text("Color").font(.subheadline).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button { store.setTabStyle(tid, color: .some(nil)) } label: {
                    Circle().stroke(Color.secondary, style: StrokeStyle(lineWidth: 1, dash: [3])).frame(width: 20, height: 20)
                }.buttonStyle(.plain).help("No color")
                ForEach(Meta.spaceColors, id: \.self) { c in
                    Button { store.setTabStyle(tid, color: .some(c)) } label: {
                        Circle().fill(Color(nsColor: NSColor(hex: c))).frame(width: 20, height: 20)
                            .overlay(Circle().stroke(Color.primary, lineWidth: tab?.color == c ? 2 : 0).padding(-3))
                    }.buttonStyle(.plain)
                }
            }
            HStack {
                Button("Reset") { store.setTabStyle(tid, icon: .some(nil), color: .some(nil)) }
                Spacer()
                Button("Done", action: close).keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    func cell<V: View>(selected: Bool, @ViewBuilder _ content: () -> V, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            content().frame(width: 30, height: 30)
                .background(selected ? Color.accentColor.opacity(0.25) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain)
    }
}

// Presents whichever overlay the store asks for: the command bar, the Space editor, the
// All Spaces overview, or a session's Icon & Color sheet.
@MainActor
final class Overlays {
    static let shared = Overlays()
    private var shown: UIState.Overlay?
    private var commandBar: CommandBar?
    private var modal: ModalOverlay?
    private var overview: OverviewPanel?

    func update(in window: NSWindow?) {
        let store = Store.shared
        let want = store.ui.overlay
        guard want != shown, let window else { return }
        dismissCurrent()
        shown = want
        switch want {
        case .commandBar(let initial):
            let bar = CommandBar(initial: initial)
            bar.onClose = { [weak self] in self?.closed() }
            commandBar = bar
            bar.show(over: window)
        case .spaceEditor(let id):
            // Its form's natural height, a little taller when a background image adds rows.
            let image = id.flatMap { store.space($0)?.term.image } != nil
            present(AnyView(SpaceEditor(spaceId: id, close: { [weak self] in self?.endSheet() })), width: 560, height: image ? 790 : 690, on: window)
        case .tabStyle(let tid):
            present(AnyView(TabStyleEditor(tid: tid, close: { [weak self] in self?.endSheet() })), width: 460, height: nil, on: window)
        case .overview:
            let o = OverviewPanel()
            o.onClose = { [weak self] in self?.closed() }
            overview = o
            o.show(over: window)
        case nil:
            break
        }
    }

    // `height` is what the card would like; it never grows past the window. Without one the
    // card takes the content's own height.
    private func present(_ view: AnyView, width: CGFloat, height: CGFloat?, on window: NSWindow) {
        guard let root = window.contentView else { return }
        let host = NSHostingView(rootView: view.environmentObject(Store.shared))
        let h = height ?? host.fittingSize.height
        host.sizingOptions = []
        let m = ModalOverlay(content: host, width: width, height: h)
        m.onDismiss = { [weak self] in self?.endSheet() }
        modal = m
        m.show(in: root)
    }

    private func endSheet() {
        modal?.close()
        modal = nil
        closed()
    }

    private func dismissCurrent() {
        if let c = commandBar { c.onClose = nil; c.close() }
        commandBar = nil
        if let o = overview { o.onClose = nil; o.close() }
        overview = nil
        modal?.close()
        modal = nil
    }

    // The overlay went away on its own (Esc, a pick, a click outside).
    private func closed() {
        commandBar = nil
        overview = nil
        modal = nil
        shown = nil
        let store = Store.shared
        if store.ui.overlay != nil { store.ui.overlay = nil }
        store.syncFocus()
    }
}

// The same in SwiftUI.
struct SpaceGlyph: View {
    let space: Space
    var size: CGFloat = 13

    var body: some View {
        if let img = SpaceIcon.image(space) {
            Image(nsImage: img).resizable().scaledToFill().frame(width: size + 2, height: size + 2).clipShape(RoundedRectangle(cornerRadius: size * 0.24))
        } else {
            Text(space.glyph).font(.system(size: size)).foregroundStyle(Color(nsColor: NSColor(hex: space.color)))
        }
    }
}

// A sheet inside the window: a faint backdrop over the window and a card
// centred on it that never grows past the window (its form scrolls instead). A click on the
// backdrop or Esc closes it.
@MainActor
final class ModalOverlay: NSView {
    var onDismiss: (() -> Void)?
    private let frameView = NSView() // carries the shadow; the card inside clips to its corners
    private let card = NSView()

    init(content: NSView, width: CGFloat, height: CGFloat) {
        super.init(frame: .zero)
        wantsLayer = true
        frameView.wantsLayer = true
        frameView.shadow = {
            let s = NSShadow()
            s.shadowBlurRadius = 40
            s.shadowOffset = NSSize(width: 0, height: -16)
            s.shadowColor = NSColor.black.withAlphaComponent(0.45)
            return s
        }()
        card.wantsLayer = true
        card.layer?.cornerRadius = 14
        card.layer?.cornerCurve = .continuous
        card.layer?.masksToBounds = true
        card.layer?.borderWidth = 0.5
        for v in [frameView, card, content] { v.translatesAutoresizingMaskIntoConstraints = false }
        addSubview(frameView)
        frameView.addSubview(card)
        card.addSubview(content)
        func pin(_ a: NSView, _ b: NSView) -> [NSLayoutConstraint] {
            [a.topAnchor.constraint(equalTo: b.topAnchor), a.bottomAnchor.constraint(equalTo: b.bottomAnchor), a.leadingAnchor.constraint(equalTo: b.leadingAnchor), a.trailingAnchor.constraint(equalTo: b.trailingAnchor)]
        }
        // Below the window's hold on its own size (500), so the card gives way to the window
        // instead of growing it.
        func prefer(_ c: NSLayoutConstraint) -> NSLayoutConstraint {
            c.priority = .init(490)
            return c
        }
        // Centred in the space below the toolbar, keeping clear of it and the window's edges.
        let below = safeAreaLayoutGuide
        NSLayoutConstraint.activate(pin(card, frameView) + pin(content, card) + [
            frameView.centerXAnchor.constraint(equalTo: centerXAnchor),
            { let c = frameView.centerYAnchor.constraint(equalTo: below.centerYAnchor); c.priority = .init(480); return c }(),
            frameView.topAnchor.constraint(greaterThanOrEqualTo: below.topAnchor, constant: 12),
            frameView.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -20),
            frameView.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -40),
            prefer(frameView.widthAnchor.constraint(equalToConstant: width)),
            prefer(frameView.heightAnchor.constraint(equalToConstant: height)),
        ])
        updateColors()
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateColors()
    }

    private func updateColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            layer?.backgroundColor = NSColor.black.withAlphaComponent(dark ? 0.32 : 0.16).cgColor
            card.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
            card.layer?.borderColor = (dark ? NSColor.white.withAlphaComponent(0.14) : NSColor.black.withAlphaComponent(0.18)).cgColor
        }
    }

    func show(in root: NSView) {
        translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(self, positioned: .above, relativeTo: nil)
        NSLayoutConstraint.activate([topAnchor.constraint(equalTo: root.topAnchor), bottomAnchor.constraint(equalTo: root.bottomAnchor), leadingAnchor.constraint(equalTo: root.leadingAnchor), trailingAnchor.constraint(equalTo: root.trailingAnchor)])
        root.layoutSubtreeIfNeeded()
        // Fade in with the card rising a few points.
        alphaValue = 0
        frameView.layer?.transform = CATransform3DMakeTranslation(0, -8, 0)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.22
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1)
            ctx.allowsImplicitAnimation = true
            animator().alphaValue = 1
            frameView.layer?.transform = CATransform3DIdentity
        }
        window?.makeFirstResponder(card.subviews.first)
    }

    func close() {
        onDismiss = nil
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.14
            animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated { self?.removeFromSuperview() }
        })
    }

    override func mouseDown(with event: NSEvent) {
        if !frameView.frame.contains(convert(event.locationInWindow, from: nil)) { onDismiss?() }
    }

    // Nothing behind the backdrop reacts to the pointer.
    override func scrollWheel(with event: NSEvent) {}
    override func rightMouseDown(with event: NSEvent) {}
    override func resetCursorRects() { addCursorRect(bounds, cursor: .arrow) }

    override func cancelOperation(_ sender: Any?) { onDismiss?() }
}
