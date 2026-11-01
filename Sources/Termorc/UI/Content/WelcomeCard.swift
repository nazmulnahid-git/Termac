import AppKit
import TermorcCore

// A short card of shortcuts above the input bar in a new, empty session, until you run
// something ("Tips in new sessions" in Settings).
@MainActor
final class WelcomeCard: NSView {
    private let stack = NSStackView()
    private let hide = NSButton(title: "Don't show again", target: nil, action: nil)
    private let line = NSView()
    private var key = ""

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        hide.isBordered = false
        hide.target = self
        hide.action = #selector(dontShow)
        hide.translatesAutoresizingMaskIntoConstraints = false
        line.wantsLayer = true
        line.translatesAutoresizingMaskIntoConstraints = false
        for v in [stack, hide, line] as [NSView] { addSubview(v) }
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 18), stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -16), stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -20),
            hide.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16), hide.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            line.topAnchor.constraint(equalTo: topAnchor), line.leadingAnchor.constraint(equalTo: leadingAnchor),
            line.trailingAnchor.constraint(equalTo: trailingAnchor), line.heightAnchor.constraint(equalToConstant: 1),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc private func dontShow() { Store.shared.setSettings { $0.terminalWelcome = false } }

    func apply(_ look: TerminalLook) {
        let kb = Store.shared.model.settings.keybindings
        let k = "\(look.bg)\(UI.scale)\(kb["commandBar"] ?? "")\(kb["splitRight"] ?? "")"
        guard k != key else { return }
        key = k
        let p = look.palette
        let fg = NSColor(hex: p.foreground), dim = NSColor(hex: p.brightBlack)
        layer?.backgroundColor = NSColor(hex: look.bg).withAlphaComponent(look.image == nil ? 1 : 0.85).cgColor
        line.layer?.backgroundColor = fg.withAlphaComponent(0.08).cgColor
        hide.attributedTitle = NSAttributedString(string: "Don't show again", attributes: [.foregroundColor: dim, .font: UI.font(0.86)])
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        let logo = NSImageView(image: NSApp.applicationIconImage ?? NSImage())
        logo.imageScaling = .scaleProportionallyUpOrDown
        logo.widthAnchor.constraint(equalToConstant: UI.px(36)).isActive = true
        logo.heightAnchor.constraint(equalToConstant: UI.px(36)).isActive = true
        let title = NSTextField(labelWithString: "New terminal session")
        title.font = UI.font(1.45, .semibold)
        title.textColor = fg
        let head = NSStackView(views: [logo, title])
        head.spacing = 12
        stack.addArrangedSubview(head)
        stack.setCustomSpacing(12, after: head)

        let font = UI.font()
        let fill = fg.withAlphaComponent(look.dark ? 0.08 : 0.06), stroke = fg.withAlphaComponent(0.08)
        func cap(_ s: String) -> NSView { KeyCap(s, font: UI.font(0.95), fg: fg, fill: fill, stroke: stroke) }
        func text(_ s: String) -> NSView {
            let l = NSTextField(labelWithString: s)
            l.font = font
            l.textColor = fg.withAlphaComponent(0.9)
            return l
        }
        let rows: [[NSView]] = [
            [cap(Keys.format(kb["commandBar"])), text("jump anywhere: sessions, folders, SSH hosts, snippets")],
            [cap("↑"), text("cycle past commands,"), cap("⌃R"), text("to search them")],
            [cap("⇥"), text("complete commands, paths and branches")],
            [cap(Keys.format(kb["splitRight"])), text("split the pane")],
        ]
        for r in rows {
            let s = NSStackView(views: r)
            s.spacing = 8
            stack.addArrangedSubview(s)
        }
    }
}
