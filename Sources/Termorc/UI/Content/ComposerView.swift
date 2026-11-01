import AppKit
import TermorcCore

// One history for every session: the shell's history files, plus what was run here since.
@MainActor
enum ComposerHistory {
    static var list: [String] = []
    private static var loading = false

    static func load() {
        guard !loading else { return }
        loading = true
        DispatchQueue.global(qos: .userInitiated).async {
            let h = CmdLine.history()
            DispatchQueue.main.async { list = h + list.filter { !h.contains($0) } }
        }
    }

    static func remember(_ cmd: String) {
        list = [cmd] + list.filter { $0 != cmd }
        if list.count > 5000 { list.removeLast(list.count - 5000) }
    }
}

// The input bar at the bottom of a session (Warp-style). While the shell waits at a prompt
// you type here: syntax colors, a grey suggestion from history (→ accepts), ↑/↓ recall,
// ⇥ completion, ⌃R history search, ⇧⏎ for a second line. ⏎ hands the command to the shell
// and the bar steps aside: keys go to the terminal until the next prompt. Full-screen apps
// (vim, htop) get the whole pane.
@MainActor
final class ComposerView: NSView, NSTextViewDelegate {
    enum Mode { case input, running, starting, hidden }

    let sid: String
    let store = Store.shared
    let editor = ComposerTextView()
    // The pane's folder / branch / diff chips move in here while the bar is showing.
    let chipsSlot = NSStackView()
    private let scroll = NSScrollView()
    private let running = NSStackView()
    private let runIcon = NSProgressIndicator()
    private let runCmd = NSTextField(labelWithString: "")
    private let runTime = NSTextField(labelWithString: "")
    private let stop = NSButton(title: "⌃C Stop", target: nil, action: nil)
    private let lastIcon = NSImageView()
    private let lastText = NSTextField(labelWithString: "")
    private let foot = NSStackView()
    private let placeholder = NSTextField(labelWithString: "")
    private let topLine = NSView()
    private var editorHeight: NSLayoutConstraint!
    private var recall: (prefix: String, list: [String], i: Int, draft: String)?
    private var look: TerminalLook?
    private var timer: Timer?
    private var footKey = ""
    private(set) var mode: Mode = .starting

    // Fixed height whatever the bar shows, so the terminal never resizes under a command.
    static var height: CGFloat { (CGFloat(UI.termFontSize) * CGFloat(UI.settings.lineHeight)).rounded() + UI.px(86) }

    init(sid: String) {
        self.sid = sid
        super.init(frame: .zero)
        wantsLayer = true
        ComposerHistory.load()
        editor.composer = self
        editor.delegate = self
        editor.isRichText = false
        editor.allowsUndo = true
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.isAutomaticSpellingCorrectionEnabled = false
        editor.isContinuousSpellCheckingEnabled = false
        editor.drawsBackground = false
        editor.textContainerInset = .zero
        editor.textContainer?.lineFragmentPadding = 0
        editor.isVerticallyResizable = true
        editor.textContainer?.widthTracksTextView = true
        scroll.documentView = editor
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        editor.autoresizingMask = [.width]

        runIcon.style = .spinning
        runIcon.controlSize = .small
        runCmd.lineBreakMode = .byTruncatingTail
        runCmd.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        stop.target = self
        stop.action = #selector(stopTapped)
        stop.isBordered = false
        stop.wantsLayer = true
        stop.layer?.cornerRadius = 6
        let runSpacer = NSView()
        runSpacer.setContentHuggingPriority(.init(1), for: .horizontal)
        [runIcon, runCmd, runTime, runSpacer, stop].forEach(running.addArrangedSubview)
        running.spacing = 10
        running.loosen()

        chipsSlot.spacing = 4
        chipsSlot.loosen()
        lastIcon.symbolConfiguration = .init(pointSize: 11, weight: .semibold)
        let lastRow = NSStackView(views: [lastIcon, lastText])
        lastRow.spacing = 5
        let chipSpacer = NSView()
        chipSpacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let chipsRow = NSStackView(views: [chipsSlot, chipSpacer, lastRow])
        chipsRow.loosen()

        foot.spacing = 14
        foot.loosen()
        topLine.wantsLayer = true

        for v in [topLine, chipsRow, scroll, running, foot, placeholder] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        editorHeight = scroll.heightAnchor.constraint(equalToConstant: 20)
        NSLayoutConstraint.activate([
            topLine.topAnchor.constraint(equalTo: topAnchor), topLine.leadingAnchor.constraint(equalTo: leadingAnchor),
            topLine.trailingAnchor.constraint(equalTo: trailingAnchor), topLine.heightAnchor.constraint(equalToConstant: 1),
            foot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16), foot.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            foot.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -9),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16), scroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            scroll.bottomAnchor.constraint(equalTo: foot.topAnchor, constant: -7), editorHeight,
            running.leadingAnchor.constraint(equalTo: scroll.leadingAnchor), running.trailingAnchor.constraint(equalTo: scroll.trailingAnchor),
            running.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
            placeholder.leadingAnchor.constraint(equalTo: scroll.leadingAnchor), placeholder.topAnchor.constraint(equalTo: scroll.topAnchor),
            chipsRow.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10), chipsRow.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            chipsRow.bottomAnchor.constraint(equalTo: scroll.topAnchor, constant: -7),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    var hasFocus: Bool { window?.firstResponder === editor }

    func apply(_ look: TerminalLook) {
        self.look = look
        let p = look.palette
        let fg = NSColor(hex: p.foreground)
        layer?.backgroundColor = (look.image == nil ? NSColor(hex: look.bg) : .clear).cgColor
        topLine.layer?.backgroundColor = fg.withAlphaComponent(0.08).cgColor
        editor.insertionPointColor = NSColor(hex: look.accent)
        editor.selectedTextAttributes = [.backgroundColor: NSColor(hex: p.blue).withAlphaComponent(0.35)]
        runCmd.textColor = fg
        runTime.textColor = NSColor(hex: p.brightBlack)
        stop.layer?.backgroundColor = fg.withAlphaComponent(look.dark ? 0.08 : 0.06).cgColor
        stop.layer?.borderColor = fg.withAlphaComponent(0.08).cgColor
        stop.layer?.borderWidth = 1
        stop.attributedTitle = NSAttributedString(string: "  ⌃C Stop  ", attributes: [.foregroundColor: fg, .font: UI.font(0.82)])
        placeholder.textColor = NSColor(hex: p.brightBlack).withAlphaComponent(0.75)
        footKey = ""
        restyle()
    }

    private func setFoot(_ m: Mode) {
        guard let look else { return }
        let k = Keys.format(store.model.settings.keybindings["commandBar"])
        let key = "\(m == .running)\(k)\(UI.scale)"
        guard key != footKey else { return }
        footKey = key
        let p = look.palette
        let fg = NSColor(hex: p.foreground)
        let dim = NSColor(hex: p.brightBlack)
        let font = UI.font(0.86)
        let fill = fg.withAlphaComponent(look.dark ? 0.08 : 0.06), stroke = fg.withAlphaComponent(0.08)
        foot.arrangedSubviews.forEach { $0.removeFromSuperview() }
        hints = []
        if m == .running {
            let l = NSTextField(labelWithString: "Keys go to the running program")
            l.font = font
            l.textColor = dim
            foot.addArrangedSubview(l)
        } else {
            let views = keyHints([("⏎", "run"), ("⇧⏎", "new line"), ("↑", "history"), ("⇥", "complete"), ("⌃R", "search")], font: font, fg: fg, dim: dim, fill: fill, stroke: stroke)
            for (h, rank) in zip(views, [6, 2, 4, 3, 1]) {
                foot.addArrangedSubview(h)
                hints.append((h, rank))
            }
        }
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        foot.addArrangedSubview(spacer)
        for h in keyHints([(k, "commands")], font: font, fg: fg, dim: dim, fill: fill, stroke: stroke) {
            foot.addArrangedSubview(h)
            hints.append((h, 5))
        }
        fitHints()
    }

    // In a narrow pane the least useful hints drop out whole rather than being squeezed.
    private var hints: [(view: NSView, rank: Int)] = []

    override func layout() {
        super.layout()
        fitHints()
    }

    private func fitHints() {
        let avail = foot.bounds.width
        guard avail > 0 else { return }
        var used = hints.reduce(CGFloat(0)) { $0 + $1.view.fittingSize.width + foot.spacing }
        var drop = Set<ObjectIdentifier>()
        for h in hints.sorted(by: { $0.rank < $1.rank }) where used > avail {
            drop.insert(ObjectIdentifier(h.view))
            used -= h.view.fittingSize.width + foot.spacing
        }
        for h in hints {
            let hide = drop.contains(ObjectIdentifier(h.view))
            if h.view.isHidden != hide { h.view.isHidden = hide }
        }
    }

    // ---- State ----------------------------------------------------------------------------
    func update(_ r: SessionRuntime, focused: Bool) {
        let m: Mode = r.alt ? .hidden : r.atPrompt ? .input : r.status == .run ? .running : .starting
        mode = m
        // Hand focus back and forth with the terminal as commands start and finish, before the
        // editor stops being editable (AppKit would drop focus from it otherwise).
        if focused, let w = window, let term = store.sessions[sid]?.view {
            let fr = w.firstResponder
            let idle = fr === w || fr == nil || fr === term || fr === editor
            if m == .input, idle, fr !== editor { w.makeFirstResponder(editor) }
            else if m != .input, fr === editor { w.makeFirstResponder(term) }
        }
        isHidden = m == .hidden
        scroll.isHidden = m == .running
        running.isHidden = m != .running
        editor.isEditable = m == .input
        placeholder.stringValue = m == .starting ? "Starting shell…" : "Run a command…"
        placeholder.isHidden = !editor.string.isEmpty || m == .running
        editorHeight.constant = (CGFloat(UI.termFontSize) * CGFloat(UI.settings.lineHeight)).rounded()
        runCmd.font = UI.mono()
        runTime.font = UI.mono()
        if m == .running {
            runCmd.stringValue = r.command.isEmpty ? "Running…" : r.command
            runIcon.startAnimation(nil)
            if timer == nil {
                timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.tick() } }
            }
            tick()
        } else {
            runIcon.stopAnimation(nil)
            timer?.invalidate()
            timer = nil
        }
        let p = look?.palette ?? TermTheme.dark
        if m != .running, let code = r.exitCode {
            let ok = code == 0 || code == 130
            lastIcon.image = NSImage(systemSymbolName: ok ? "checkmark.circle.fill" : "xmark.circle.fill", accessibilityDescription: nil)
            lastIcon.contentTintColor = NSColor(hex: ok ? p.green : p.red)
            lastText.stringValue = ok ? Self.fmt(r.duration) : "exit \(code)"
            lastText.font = .monospacedDigitSystemFont(ofSize: UI.font(0.92).pointSize, weight: .regular)
            lastText.textColor = ok ? NSColor(hex: p.brightBlack) : NSColor(hex: p.red)
            lastIcon.isHidden = false
            lastText.isHidden = false
            lastText.toolTip = "Last command exited \(code)"
        } else {
            lastIcon.isHidden = true
            lastText.isHidden = true
        }
        setFoot(m)
        foot.alphaValue = focused ? 0.8 : 0.45
    }

    private func tick() {
        guard let start = store.rt[sid]?.cmdStart else { runTime.stringValue = ""; return }
        runTime.stringValue = Self.fmt(nowMillis() - start)
    }

    static func fmt(_ ms: Millis?) -> String {
        guard let ms else { return "" }
        if ms < 1000 { return "\(ms)ms" }
        let s = Int((Double(ms) / 1000).rounded())
        return s < 60 ? "\(s)s" : "\(s / 60)m \(s % 60)s"
    }

    @objc private func stopTapped() { store.sessions[sid]?.write([0x03]) }

    // ---- Text -----------------------------------------------------------------------------
    var text: String {
        get { editor.string }
        set {
            editor.string = newValue
            editor.setSelectedRange(NSRange(location: (newValue as NSString).length, length: 0))
            restyle()
        }
    }

    var caret: Int { editor.selectedRange().location }

    func textDidChange(_ notification: Notification) {
        recall = nil
        restyle()
    }

    func textViewDidChangeSelection(_ notification: Notification) { editor.needsDisplay = true }

    // Syntax colors for the typed line.
    private func restyle() {
        guard let look, let storage = editor.textStorage else { return }
        let p = look.palette
        let font = UI.mono()
        editor.font = font
        editor.typingAttributes = [.font: font, .foregroundColor: NSColor(hex: p.foreground)]
        let colors: [CmdLine.Kind: String] = [.cmd: look.accent, .flag: p.blue, .str: p.yellow, .var: p.cyan, .op: p.magenta, .assign: p.cyan, .arg: p.foreground, .space: p.foreground]
        let bold = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
        storage.beginEditing()
        var loc = 0
        for t in CmdLine.tokenize(editor.string) {
            let len = (t.t as NSString).length
            storage.setAttributes([.font: t.k == .cmd || t.k == .op ? bold : font, .foregroundColor: NSColor(hex: colors[t.k] ?? p.foreground)], range: NSRange(location: loc, length: len))
            loc += len
        }
        storage.endEditing()
        placeholder.font = font
        placeholder.isHidden = !editor.string.isEmpty || mode == .running
        editor.ghost = mode == .input && caret == (editor.string as NSString).length ? CmdLine.suggest(editor.string, ComposerHistory.list) : ""
        editor.ghostColor = NSColor(hex: p.brightBlack).withAlphaComponent(0.75)
        editor.needsDisplay = true
    }

    // Keys typed into the terminal at a prompt (or text the app inserts) land here.
    func receive(_ data: [UInt8]) {
        let d = String(decoding: data, as: UTF8.self)
        if d == "\u{03}" { return clear() }
        if d == "\r" { return submit() }
        if let f = d.unicodeScalars.first, f.value < 0x20 || f.value == 0x7f, d.count < 8 { return }
        editor.insertText(d.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n"), replacementRange: editor.selectedRange())
        window?.makeFirstResponder(editor)
    }

    func clear() {
        recall = nil
        text = ""
    }

    func submit() {
        let cmd = editor.string.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
        guard !cmd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, mode == .input else { return }
        guard store.submitCommand(sid, cmd) else { return }
        ComposerHistory.remember(cmd)
        clear()
    }

    // ---- Keys -----------------------------------------------------------------------------
    func textView(_ textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        let flags = NSApp.currentEvent?.modifierFlags ?? []
        let s = editor.string as NSString
        let pos = caret
        switch sel {
        case #selector(NSResponder.insertNewline(_:)):
            if flags.contains(.shift) || flags.contains(.option) { editor.insertText("\n", replacementRange: editor.selectedRange()); return true }
            submit()
            return true
        case #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
            editor.insertText("\n", replacementRange: editor.selectedRange())
            return true
        case #selector(NSResponder.insertTab(_:)):
            if !editor.ghost.isEmpty { text = editor.string + editor.ghost } else { complete() }
            return true
        case #selector(NSResponder.moveRight(_:)), #selector(NSResponder.moveToEndOfLine(_:)), #selector(NSResponder.moveToEndOfParagraph(_:)):
            guard !editor.ghost.isEmpty, pos == s.length else { return false }
            text = editor.string + editor.ghost
            return true
        case #selector(NSResponder.moveUp(_:)):
            guard !s.substring(to: pos).contains("\n") else { return false }
            var rc = recall ?? (editor.string, CmdLine.recallList(editor.string, ComposerHistory.list), -1, editor.string)
            if rc.i + 1 < rc.list.count {
                rc.i += 1
                let v = rc.list[rc.i]
                text = v
            }
            recall = rc
            return true
        case #selector(NSResponder.moveDown(_:)):
            guard var rc = recall, !s.substring(from: pos).contains("\n") else { return false }
            rc.i -= 1
            if rc.i < 0 { text = rc.draft; recall = nil } else { text = rc.list[rc.i]; recall = rc }
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            if !editor.string.isEmpty { clear(); return true }
            return false
        default:
            return false
        }
    }

    // ⌃ shortcuts the shell would have handled.
    func controlKey(_ c: String) -> Bool {
        switch c {
        case "c": clear()
        case "r": historySearch()
        case "l": store.sessions[sid]?.clear()
        case "u":
            let s = editor.string as NSString
            text = s.substring(from: caret)
            editor.setSelectedRange(NSRange(location: 0, length: 0))
        case "d":
            guard editor.string.isEmpty else { return false }
            store.sessions[sid]?.write([0x04])
        default: return false
        }
        return true
    }

    // ⇥: one match fills in; several fill in what they share, then offer a menu at the caret.
    private func complete() {
        let cwd = store.rt[sid]?.cwd ?? store.model.sessions[sid]?.cwd ?? store.home
        let s = editor.string as NSString
        let line = s.substring(to: caret)
        let res = CmdLine.complete(cwd: cwd, line: line)
        guard !res.items.isEmpty else { NSSound.beep(); return }
        let lineChars = Array(line)
        if res.items.count == 1 {
            let r = CmdLine.apply(editor.string, caret: lineChars.count, start: res.start, res.items[0])
            set(r.text, caret: r.caret)
            return
        }
        let shared = CmdLine.commonPrefix(res.items.map(\.value))
        let typed = String(lineChars[res.start...]).replacingOccurrences(of: "\\ ", with: " ")
        var base = editor.string
        var pos = lineChars.count
        if shared.count > typed.count {
            let r = CmdLine.apply(editor.string, caret: pos, start: res.start, .init(value: shared, kind: .dir))
            set(r.text, caret: r.caret)
            base = r.text
            pos = r.caret
        }
        let menu = NSMenu()
        let symbols: [CmdLine.Completion.Kind: String] = [.dir: "folder", .file: "doc", .cmd: "terminal", .branch: "arrow.triangle.branch"]
        for item in res.items.prefix(60) {
            SidebarMenus.add(menu, item.label ?? item.value) { [weak self] in
                let r = CmdLine.apply(base, caret: pos, start: res.start, item)
                self?.set(r.text, caret: r.caret)
            }
            menu.items.last?.image = symbols[item.kind].flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil) }
        }
        menu.popUp(positioning: nil, at: editor.caretPoint(), in: editor)
    }

    private func set(_ t: String, caret c: Int) {
        editor.string = t
        let utf16 = (String(Array(t).prefix(c)) as NSString).length
        editor.setSelectedRange(NSRange(location: utf16, length: 0))
        restyle()
        window?.makeFirstResponder(editor)
    }

    // ⌃R: fuzzy search over history in a small panel.
    private func historySearch() {
        guard let w = window else { return }
        let panel = HistorySearch(initial: editor.string) { [weak self] picked in
            guard let self else { return }
            if let picked { self.text = picked }
            self.window?.makeFirstResponder(self.editor)
        }
        panel.show(over: w)
    }
}

// The editor: draws the grey history suggestion after the caret.
final class ComposerTextView: NSTextView {
    weak var composer: ComposerView?
    var ghost = ""
    var ghostColor = NSColor.tertiaryLabelColor

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard !ghost.isEmpty, let lm = layoutManager, let tc = textContainer else { return }
        let end = (string as NSString).length
        var rect: NSRect
        if end == 0 {
            rect = NSRect(x: textContainerInset.width, y: textContainerInset.height, width: 0, height: 0)
        } else {
            let g = lm.glyphIndexForCharacter(at: end - 1)
            rect = lm.boundingRect(forGlyphRange: NSRange(location: g, length: 1), in: tc).offsetBy(dx: textContainerInset.width, dy: textContainerInset.height)
            rect.origin.x = rect.maxX
        }
        let attrs: [NSAttributedString.Key: Any] = [.font: font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular), .foregroundColor: ghostColor]
        (ghost.components(separatedBy: "\n").first ?? ghost).draw(at: NSPoint(x: rect.minX, y: rect.minY), withAttributes: attrs)
    }

    override func keyDown(with event: NSEvent) {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if mods == .control, let c = event.charactersIgnoringModifiers?.lowercased(), composer?.controlKey(c) == true { return }
        super.keyDown(with: event)
    }

    func caretPoint() -> NSPoint {
        guard let lm = layoutManager, let tc = textContainer else { return .zero }
        let loc = selectedRange().location
        let g = lm.glyphIndexForCharacter(at: max(0, min(loc, (string as NSString).length) - 1))
        let r = lm.boundingRect(forGlyphRange: NSRange(location: g, length: 1), in: tc)
        return NSPoint(x: r.maxX + textContainerInset.width, y: r.minY)
    }
}

// ⌃R history search: type to filter, ↵ inserts, esc closes.
@MainActor
final class HistorySearch: NSObject, NSTextFieldDelegate, NSTableViewDataSource, NSTableViewDelegate {
    private let panel = OverlayPanel(size: NSSize(width: 560, height: 340))
    private let field = NSTextField()
    private let table = NSTableView()
    private var items: [String] = []
    private var done: ((String?) -> Void)?
    private static var current: HistorySearch?

    init(initial: String, done: @escaping (String?) -> Void) {
        self.done = done
        super.init()
        field.placeholderString = "Search history"
        field.stringValue = initial
        field.isBordered = false
        field.focusRingType = .none
        field.drawsBackground = false
        field.font = .systemFont(ofSize: 15)
        field.delegate = self
        let col = NSTableColumn(identifier: .init("h"))
        table.addTableColumn(col)
        table.headerView = nil
        table.backgroundColor = .clear
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.doubleAction = #selector(pick)
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.drawsBackground = false
        for v in [field, scroll] {
            v.translatesAutoresizingMaskIntoConstraints = false
            panel.content.addSubview(v)
        }
        NSLayoutConstraint.activate([
            field.topAnchor.constraint(equalTo: panel.content.topAnchor, constant: 12), field.leadingAnchor.constraint(equalTo: panel.content.leadingAnchor, constant: 14),
            field.trailingAnchor.constraint(equalTo: panel.content.trailingAnchor, constant: -14),
            scroll.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 8), scroll.leadingAnchor.constraint(equalTo: panel.content.leadingAnchor, constant: 6),
            scroll.trailingAnchor.constraint(equalTo: panel.content.trailingAnchor, constant: -6), scroll.bottomAnchor.constraint(equalTo: panel.content.bottomAnchor, constant: -6),
        ])
        filter()
    }

    func show(over w: NSWindow) {
        Self.current = self
        panel.present(over: w, topFraction: 0.3)
        panel.makeFirstResponder(field)
        panel.onResign = { [weak self] in self?.finish(nil) }
    }

    private func filter() {
        let q = field.stringValue.trimmingCharacters(in: .whitespaces)
        if q.isEmpty { items = Array(ComposerHistory.list.prefix(50)) }
        else {
            var scored: [(String, Double)] = []
            for h in ComposerHistory.list {
                if let m = Fuzzy.match(q, h), m.score > 0 { scored.append((h, m.score)) }
                if scored.count > 400 { break }
            }
            items = scored.sorted { $0.1 > $1.1 }.prefix(50).map(\.0)
        }
        table.reloadData()
        if !items.isEmpty { table.selectRowIndexes([0], byExtendingSelection: false) }
    }

    func controlTextDidChange(_ obj: Notification) { filter() }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        switch sel {
        case #selector(NSResponder.moveDown(_:)): move(1)
        case #selector(NSResponder.moveUp(_:)): move(-1)
        case #selector(NSResponder.insertNewline(_:)): pick()
        case #selector(NSResponder.cancelOperation(_:)): finish(nil)
        default: return false
        }
        return true
    }

    private func move(_ d: Int) {
        guard !items.isEmpty else { return }
        let r = ((table.selectedRow + d) % items.count + items.count) % items.count
        table.selectRowIndexes([r], byExtendingSelection: false)
        table.scrollRowToVisible(r)
    }

    @objc private func pick() {
        let r = table.selectedRow
        finish(r >= 0 && r < items.count ? items[r] : nil)
    }

    private func finish(_ v: String?) {
        panel.onResign = nil
        panel.dismiss()
        let cb = done
        done = nil
        Self.current = nil
        cb?(v)
    }

    func numberOfRows(in tableView: NSTableView) -> Int { items.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let l = NSTextField(labelWithString: items[row])
        l.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        l.lineBreakMode = .byTruncatingTail
        return l
    }
}
