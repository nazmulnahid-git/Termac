import AppKit
import TermorcCore

// One pane: a header with context chips (directory, branch, changed files) and the process
// pill, the terminal, and the pane's floating bits: "Jump to bottom", "Copied", the
// production confirm sheet and the dropped-SSH sheet.
@MainActor
final class PaneView: NSView {
    let sid: String
    let store = Store.shared
    let header = NSView()
    private let headerLine = NSView()
    private let prodChip = Chip()
    private let dirChip = Chip()
    private let branchChip = Chip()
    private let diffChip = Chip()
    private let procPill = Chip()
    private let procDot = NSView()
    private let termHost = NSView()
    private let jumpPill = PillButton()
    private let copied = PillButton()
    private var confirmSheet: SheetView?
    private var droppedSheet: SheetView?
    private var look: TerminalLook?
    private let chips = NSStackView()
    private var headerStack: NSStackView!
    private var headerHeight: NSLayoutConstraint!
    private var termInsets: [NSLayoutConstraint] = []
    private lazy var welcome = WelcomeCard()
    private lazy var composer = ComposerView(sid: sid)
    private let blocks = BlocksOverlay()
    private var termBottom: NSLayoutConstraint!
    private var composerHeight: NSLayoutConstraint!
    static let headerHeight: CGFloat = 32

    init(sid: String) {
        self.sid = sid
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = true // a narrow split pane never spills into its neighbour
        header.wantsLayer = true
        headerLine.wantsLayer = true
        termHost.translatesAutoresizingMaskIntoConstraints = false
        header.translatesAutoresizingMaskIntoConstraints = false
        headerLine.translatesAutoresizingMaskIntoConstraints = false
        addSubview(header)
        addSubview(termHost)
        header.addSubview(headerLine)

        prodChip.set(symbol: nil, text: "PRODUCTION")
        prodChip.label.font = .systemFont(ofSize: 10, weight: .bold)
        prodChip.label.textColor = .systemRed
        dirChip.onClick = { [weak self] in self?.dirMenu() }
        branchChip.onClick = { [weak self] in self?.branchMenu() }
        diffChip.onClick = { [weak self] in self?.diffMenu() }
        procDot.wantsLayer = true
        procDot.layer?.cornerRadius = 3
        procDot.translatesAutoresizingMaskIntoConstraints = false
        procPill.isBordered = false
        procPill.addSubview(procDot)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        chips.addArrangedSubview(dirChip)
        chips.addArrangedSubview(branchChip)
        chips.addArrangedSubview(diffChip)
        chips.spacing = 2
        chips.loosen()
        let stack = NSStackView(views: [prodChip, chips, spacer, procPill])
        headerStack = stack
        stack.loosen()
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(stack)

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: topAnchor),
            header.leadingAnchor.constraint(equalTo: leadingAnchor),
            header.trailingAnchor.constraint(equalTo: trailingAnchor),

            headerLine.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            headerLine.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            headerLine.bottomAnchor.constraint(equalTo: header.bottomAnchor),
            headerLine.heightAnchor.constraint(equalToConstant: 1),
            stack.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -12),
            stack.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            procDot.widthAnchor.constraint(equalToConstant: 6),
            procDot.heightAnchor.constraint(equalToConstant: 6),
            procDot.centerYAnchor.constraint(equalTo: procPill.centerYAnchor),
            procDot.leadingAnchor.constraint(equalTo: procPill.leadingAnchor, constant: 8),
        ])
        procPill.leadingInset = 20
        headerHeight = header.heightAnchor.constraint(equalToConstant: UI.px(Self.headerHeight))
        // The terminal's inset inside the pane, as in the web build's .term-slot.
        termInsets = [
            termHost.topAnchor.constraint(equalTo: header.bottomAnchor, constant: UI.px(10)),
            termHost.leadingAnchor.constraint(equalTo: leadingAnchor, constant: UI.px(14)),
            termHost.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -UI.px(8)),
        ]
        NSLayoutConstraint.activate(termInsets + [headerHeight])

        // The input bar sits under the terminal at a fixed height whatever it shows, so the
        // terminal never resizes under a command.
        composer.translatesAutoresizingMaskIntoConstraints = false
        composer.isHidden = true
        addSubview(composer)
        composerHeight = composer.heightAnchor.constraint(equalToConstant: 0)
        termBottom = termHost.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -UI.px(6))
        NSLayoutConstraint.activate([
            termBottom, composerHeight,
            composer.leadingAnchor.constraint(equalTo: leadingAnchor),
            composer.trailingAnchor.constraint(equalTo: trailingAnchor),
            composer.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        // Tips for a new, empty session: above the input bar, over the bottom of the output.
        welcome.translatesAutoresizingMaskIntoConstraints = false
        welcome.isHidden = true
        addSubview(welcome)
        NSLayoutConstraint.activate([
            welcome.leadingAnchor.constraint(equalTo: leadingAnchor), welcome.trailingAnchor.constraint(equalTo: trailingAnchor),
            welcome.bottomAnchor.constraint(equalTo: composer.topAnchor),
        ])
        blocks.translatesAutoresizingMaskIntoConstraints = false

        jumpPill.onClick = { [weak self] in
            guard let self else { return }
            store.sessions[sid]?.scrollToBottom()
        }
        copied.isEnabled = false
        for v in [jumpPill, copied] as [NSView] {
            v.isHidden = true
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            jumpPill.centerXAnchor.constraint(equalTo: centerXAnchor),
            jumpPill.bottomAnchor.constraint(equalTo: termHost.bottomAnchor, constant: -12),
            copied.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            copied.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 10),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    // The welcome card needs room: a narrow split drops it rather than squeezing it.
    private var wantsWelcome = false

    private func fitWelcome() {
        welcome.isHidden = !wantsWelcome || bounds.width < UI.px(380)
        welcome.compact = bounds.width < UI.px(600)
    }

    override func layout() {
        super.layout()
        fitWelcome()
    }

    // Puts the session's terminal view into this pane.
    func attach() {
        let s = store.termSession(sid)
        let v = s.view
        if v.superview !== termHost {
            // A restarted session brings a new view; drop the old one kept from before.
            for old in termHost.subviews where old is TermView { old.removeFromSuperview() }
            v.removeFromSuperview()
            v.translatesAutoresizingMaskIntoConstraints = false
            termHost.addSubview(v)
            NSLayoutConstraint.activate([v.topAnchor.constraint(equalTo: termHost.topAnchor), v.bottomAnchor.constraint(equalTo: termHost.bottomAnchor), v.leadingAnchor.constraint(equalTo: termHost.leadingAnchor), v.trailingAnchor.constraint(equalTo: termHost.trailingAnchor)])
            blocks.removeFromSuperview()
            termHost.addSubview(blocks, positioned: .below, relativeTo: v)
            NSLayoutConstraint.activate([blocks.topAnchor.constraint(equalTo: v.topAnchor), blocks.bottomAnchor.constraint(equalTo: v.bottomAnchor), blocks.leadingAnchor.constraint(equalTo: v.leadingAnchor), blocks.trailingAnchor.constraint(equalTo: v.trailingAnchor)])
        }
        blocks.session = s
        s.composer = composer
        s.onChange = { [weak self] in self?.blocks.needsDisplay = true }
        s.visible = true
        if let look { store.applyLook(look, to: s) }
    }

    // The tab is hidden: the terminal stays in the pane, so showing it again is cheap.
    func park() {
        guard let s = store.sessions[sid] else { return }
        s.visible = false
        if s.composer === composer { s.composer = nil }
        s.onChange = nil
    }

    func apply(_ look: TerminalLook) {
        self.look = look
        if let s = store.sessions[sid] { store.applyLook(look, to: s) }
        let fg = NSColor(hex: look.palette.foreground)
        layer?.backgroundColor = (look.image == nil ? NSColor(hex: look.bg) : .clear).cgColor
        header.layer?.backgroundColor = (look.image == nil ? NSColor(hex: look.bg) : NSColor(hex: look.bg, alpha: 0.55)).cgColor
        headerLine.layer?.backgroundColor = fg.withAlphaComponent(0.08).cgColor
        for c in [dirChip, branchChip, diffChip] { c.label.textColor = fg; c.icon.contentTintColor = fg.withAlphaComponent(0.65) }
        dirChip.label.font = UI.font(1, .semibold)
        branchChip.icon.contentTintColor = NSColor(hex: look.palette.green)
        branchChip.label.textColor = NSColor(hex: look.palette.green)
        for c in [branchChip, diffChip] { c.label.font = UI.font() }
        procPill.label.font = UI.font()
        procPill.label.textColor = NSColor(hex: look.palette.brightBlack)
        welcome.apply(look)
        appearance = NSAppearance(named: look.dark ? .darkAqua : .aqua)
        composer.apply(look)
        blocks.look = look
    }

    func update(focused: Bool, multi: Bool, danger: Bool) {
        let r = store.rt[sid] ?? SessionRuntime()
        let cwd = r.cwd ?? store.model.sessions[sid]?.cwd ?? store.home
        prodChip.isHidden = !danger
        if danger { header.layer?.backgroundColor = NSColor.systemRed.withAlphaComponent(0.16).blended(withFraction: 0.84, of: NSColor(hex: look?.bg ?? "#1d1d1d"))?.cgColor }
        else if let look { header.layer?.backgroundColor = (look.image == nil ? NSColor(hex: look.bg) : NSColor(hex: look.bg, alpha: 0.55)).cgColor }
        dirChip.set(symbol: "folder", text: Routing.tildify(cwd, home: store.home))
        dirChip.toolTip = "\(cwd)\nClick to change directory"
        dirChip.label.lineBreakMode = .byTruncatingHead
        branchChip.isHidden = r.branch == nil
        branchChip.set(symbol: "arrow.triangle.branch", text: r.branch ?? "")
        branchChip.toolTip = "Switch branch"
        diffChip.isHidden = r.branch == nil || r.changes == nil
        diffChip.set(symbol: "plusminus", text: "\(r.changes ?? 0)")
        diffChip.toolTip = (r.changes ?? 0) > 0 ? "\(r.changes!) changed file\(r.changes == 1 ? "" : "s")" : "Working tree clean"
        diffChip.label.textColor = (r.changes ?? 0) > 0 ? NSColor(hex: look?.palette.yellow ?? "#ecc576") : diffChip.label.textColor
        procPill.set(symbol: nil, text: Meta.procLabel(r))
        procPill.layer?.backgroundColor = nil
        procPill.toolTip = r.command.isEmpty ? nil : r.command
        let dot: NSColor = r.status == .run ? .controlAccentColor : r.status == .fail ? .systemRed : r.status == .ok ? .systemGreen : NSColor(hex: look?.palette.brightBlack ?? "#7f8392")
        procDot.layer?.backgroundColor = dot.cgColor
        // In a split, the focused pane's header gets an accent underline; the others dim.
        headerLine.layer?.backgroundColor = (multi && focused ? NSColor(hex: store.activeSpace.color) : NSColor(hex: look?.palette.foreground ?? "#ffffff").withAlphaComponent(0.08)).cgColor
        header.alphaValue = multi && !focused ? 0.6 : 1
        termHost.alphaValue = multi && !focused ? 0.86 : 1
        alphaValue = r.dropped != nil ? 0.55 : 1

        // With Termorc's prompt the input bar takes the bottom of the pane (not in full-screen apps).
        let showComposer = r.ownPrompt && !r.alt
        composer.isHidden = !showComposer
        composerHeight.constant = showComposer ? ComposerView.height : 0
        termBottom.isActive = false
        termBottom = showComposer ? termHost.bottomAnchor.constraint(equalTo: composer.topAnchor, constant: -UI.px(6)) : termHost.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -UI.px(6))
        termBottom.isActive = true
        headerHeight.constant = UI.px(Self.headerHeight)
        // With the input bar, the folder and branch chips live in it instead of the header.
        let host: NSStackView = showComposer ? composer.chipsSlot : headerStack
        if chips.superview !== host {
            chips.removeFromSuperview()
            if showComposer { composer.chipsSlot.addArrangedSubview(chips) } else { headerStack.insertArrangedSubview(chips, at: 1) }
        }
        if showComposer { composer.update(r, focused: focused) }
        let session = store.sessions[sid]
        wantsWelcome = showComposer && store.model.settings.terminalWelcome && composer.mode != .running && (session?.cmds.isEmpty ?? true) && (session?.isBlank ?? false)
        fitWelcome()
        blocks.needsDisplay = true

        jumpPill.isHidden = !r.scrolledUp
        if r.scrolledUp { jumpPill.set(symbol: "arrow.down", text: "Jump to bottom" + (r.newLines > 0 ? "  ·  \(r.newLines) new lines" : "")) }
        copied.isHidden = store.ui.copied != sid
        copied.set(symbol: "checkmark", text: "Copied output of last command  \(Keys.format(store.model.settings.keybindings["copyLastOutput"]))")

        updateConfirm()
        updateDropped(r)
    }

    private func updateConfirm() {
        let c = store.ui.confirm?.sid == sid ? store.ui.confirm : nil
        if c == nil { confirmSheet?.removeFromSuperview(); confirmSheet = nil; return }
        guard confirmSheet == nil, let c else { return }
        let s = SheetView(danger: c.danger, title: c.title, detail: c.detail, buttons: [
            ("Cancel", false, { [weak self] in self?.store.resolveConfirm(false) }),
            ("\(c.label)  ⌘↵", true, { [weak self] in self?.store.resolveConfirm(true) }),
        ])
        addSubview(s)
        s.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([s.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16), s.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16), s.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -16)])
        confirmSheet = s
    }

    private func updateDropped(_ r: SessionRuntime) {
        guard let d = r.dropped else { droppedSheet?.removeFromSuperview(); droppedSheet = nil; return }
        guard droppedSheet == nil else { return }
        let s = SheetView(danger: true, title: "Disconnected from \(d.host)", detail: "Connection closed after \(Meta.formatDuration(d.dur)) at \(Meta.clockTime(d.at)). Scrollback is kept.", buttons: [
            ("Dismiss", false, { [weak self] in guard let self else { return }; store.patchRt(sid) { $0.dropped = nil } }),
            ("Reconnect  ⌘R", true, { [weak self] in guard let self else { return }; store.reconnect(sid) }),
        ])
        addSubview(s)
        s.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([s.centerXAnchor.constraint(equalTo: centerXAnchor), s.centerYAnchor.constraint(equalTo: centerYAnchor), s.widthAnchor.constraint(lessThanOrEqualToConstant: 440)])
        droppedSheet = s
    }

    override func mouseDown(with event: NSEvent) {
        if store.focusedSid != sid { store.focusSession(sid) }
        super.mouseDown(with: event)
    }

    // ---- Switchers --------------------------------------------------------------------
    // Picking an entry types the command (cd / git switch) into the shell, so it shows up
    // in history like anything else.
    private func dirMenu() {
        let cwd = store.rt[sid]?.cwd ?? store.model.sessions[sid]?.cwd ?? store.home
        let menu = NSMenu()
        let cd = { [weak self] (path: String) in _ = self?.store.typeCommand(self?.sid, "cd \(Store.shellQuote(path))") }
        if cwd != "/" {
            let parent = (cwd as NSString).deletingLastPathComponent
            SidebarMenus.add(menu, "..  \(Routing.tildify(parent, home: store.home))") { cd(parent) }
        }
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: cwd)) ?? [])
            .filter { !$0.hasPrefix(".") && System.isDir((cwd as NSString).appendingPathComponent($0)) }
            .sorted(by: System.naturalLess).prefix(300)
        if !names.isEmpty {
            menu.addItem(.sectionHeader(title: "Folders"))
            for n in names { SidebarMenus.add(menu, "\(n)/") { cd((cwd as NSString).appendingPathComponent(n)) } }
        }
        let recent = store.model.recentDirs.filter { $0.path != cwd }.prefix(12)
        if !recent.isEmpty {
            menu.addItem(.sectionHeader(title: "Recent"))
            for d in recent { SidebarMenus.add(menu, Routing.tildify(d.path, home: store.home)) { cd(d.path) } }
        }
        menu.addItem(.separator())
        SidebarMenus.add(menu, "Copy Path") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(cwd, forType: .string)
        }
        SidebarMenus.add(menu, "Open in Finder") { NSWorkspace.shared.open(URL(fileURLWithPath: cwd)) }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: dirChip.bounds.minY - 4), in: dirChip)
    }

    private func branchMenu() {
        let cwd = store.rt[sid]?.cwd ?? ""
        let current = store.rt[sid]?.branch
        let menu = NSMenu()
        let out = System.run("git", ["-C", cwd, "for-each-ref", "--sort=-committerdate", "--count=80", "--format=%(refname:short)", "refs/heads"]) ?? ""
        menu.addItem(.sectionHeader(title: "Branches"))
        for b in out.split(separator: "\n").map(String.init) {
            SidebarMenus.add(menu, b, checked: b == current) { [weak self] in _ = self?.store.typeCommand(self?.sid, "git switch \(Store.shellQuote(b))") }
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: branchChip.bounds.minY - 4), in: branchChip)
    }

    private func diffMenu() {
        let cwd = store.rt[sid]?.cwd ?? ""
        let menu = NSMenu()
        let out = System.run("git", ["-C", cwd, "status", "--porcelain=v1"], raw: true) ?? ""
        let files = out.split(separator: "\n").map { String($0) }
        if files.isEmpty { SidebarMenus.add(menu, "Working tree clean", enabled: false) {} }
        for f in files.prefix(60) {
            let path = String(f.dropFirst(3))
            SidebarMenus.add(menu, "\(f.prefix(2).trimmingCharacters(in: .whitespaces))  \(path)") { [weak self] in _ = self?.store.typeCommand(self?.sid, "git diff -- \(Store.shellQuote(path))") }
        }
        menu.addItem(.separator())
        SidebarMenus.add(menu, "git status") { [weak self] in _ = self?.store.typeCommand(self?.sid, "git status") }
        SidebarMenus.add(menu, "git diff") { [weak self] in _ = self?.store.typeCommand(self?.sid, "git diff") }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: diffChip.bounds.minY - 4), in: diffChip)
    }
}

// A small borderless chip: an SF Symbol and a label, clickable.
final class Chip: NSButton {
    let icon = NSImageView()
    let label = NSTextField(labelWithString: "")
    var onClick: (() -> Void)?
    var leadingInset: CGFloat = 8 { didSet { leading.constant = icon.isHidden ? leadingInset : leadingInset } }
    private var leading: NSLayoutConstraint!

    init() {
        super.init(frame: .zero)
        title = ""
        isBordered = false
        wantsLayer = true
        layer?.cornerRadius = 6
        target = self
        action = #selector(tap)
        icon.symbolConfiguration = .init(pointSize: 11, weight: .medium)
        label.font = .systemFont(ofSize: 12)
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let stack = NSStackView(views: [icon, label])
        stack.spacing = 5
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        leading = stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8)
        NSLayoutConstraint.activate([leading, stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8), stack.centerYAnchor.constraint(equalTo: centerYAnchor), heightAnchor.constraint(equalToConstant: 22)])
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    required init?(coder: NSCoder) { fatalError() }

    func set(symbol: String?, text: String) {
        icon.image = symbol.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil) }
        icon.isHidden = symbol == nil
        if label.stringValue != text { label.stringValue = text }
    }

    @objc private func tap() { onClick?() }

    override func resetCursorRects() {
        if onClick != nil { addCursorRect(bounds, cursor: .pointingHand) }
    }
}

// A floating capsule over the terminal ("↓ Jump to bottom", "✓ Copied…").
final class PillButton: NSVisualEffectView {
    private let chip = Chip()
    var onClick: (() -> Void)? { didSet { chip.onClick = onClick } }
    var isEnabled = true

    override init(frame: NSRect) {
        super.init(frame: frame)
        material = .hudWindow
        blendingMode = .withinWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = 15
        chip.translatesAutoresizingMaskIntoConstraints = false
        chip.label.font = .systemFont(ofSize: 12, weight: .medium)
        addSubview(chip)
        NSLayoutConstraint.activate([chip.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6), chip.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6), chip.topAnchor.constraint(equalTo: topAnchor, constant: 4), chip.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4)])
    }

    required init?(coder: NSCoder) { fatalError() }

    func set(symbol: String, text: String) { chip.set(symbol: symbol, text: text) }
}

// An inline sheet anchored in a pane: the production confirm, the dropped-SSH notice.
final class SheetView: NSVisualEffectView {
    private var actions: [() -> Void] = []

    init(danger: Bool, title: String, detail: String, buttons: [(String, Bool, () -> Void)]) {
        super.init(frame: .zero)
        material = .hudWindow
        blendingMode = .withinWindow
        state = .active
        appearance = NSAppearance(named: .darkAqua)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.borderWidth = 1
        layer?.borderColor = (danger ? NSColor.systemRed.withAlphaComponent(0.5) : NSColor.separatorColor).cgColor
        let bang = NSImageView(image: NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: nil)!)
        bang.contentTintColor = danger ? .systemRed : .systemOrange
        let t = NSTextField(labelWithString: title)
        t.font = .systemFont(ofSize: 13, weight: .semibold)
        let d = NSTextField(wrappingLabelWithString: detail)
        d.font = .systemFont(ofSize: 12)
        d.textColor = .secondaryLabelColor
        let texts = NSStackView(views: [t, d])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 2
        var views: [NSView] = [bang, texts]
        actions = buttons.map(\.2)
        for (i, b) in buttons.enumerated() {
            let btn = NSButton(title: b.0, target: self, action: #selector(tap(_:)))
            btn.tag = i
            btn.bezelStyle = .rounded
            if b.1 {
                btn.keyEquivalent = "\r"
                btn.keyEquivalentModifierMask = .command
                if danger { btn.bezelColor = .systemRed }
            }
            views.append(btn)
        }
        let row = NSStackView(views: views)
        row.loosen()
        row.spacing = 12
        row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14), row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12), row.topAnchor.constraint(equalTo: topAnchor, constant: 12), row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12)])
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc private func tap(_ b: NSButton) { actions[b.tag]() }
}
