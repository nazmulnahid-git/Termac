import AppKit
import TermorcCore

// The menu bar, built from the keybindings in Settings. Every action is a menu item, so its
// shortcut shows where Mac users look for it and AppKit dispatches the key.
@MainActor
enum MainMenu {
    static func rebuild() {
        let store = Store.shared
        let kb = store.model.settings.keybindings
        let main = NSMenu()

        func item(_ title: String, _ action: String) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: #selector(AppDelegate.runMenuAction(_:)), keyEquivalent: "")
            i.representedObject = action
            Self.setShortcut(i, kb[action])
            return i
        }
        func std(_ title: String, _ sel: Selector, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            let host = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            host.submenu = m
            main.addItem(host)
            return host
        }

        _ = submenu("Termorc", [
            std("About Termorc", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            item("Settings…", "settings"),
            .separator(),
            std("Hide Termorc", #selector(NSApplication.hide(_:)), "h"),
            std("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            std("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
            .separator(),
            std("Quit Termorc", #selector(NSApplication.terminate(_:)), "q"),
        ])

        let find = NSMenuItem(title: "Find…", action: #selector(TerminalViewFinding.performFindPanelAction(_:)), keyEquivalent: "")
        find.tag = Int(NSFindPanelAction.showFindPanel.rawValue)
        setShortcut(find, kb["find"])
        let findNext = std("Find Next", #selector(TerminalViewFinding.performFindPanelAction(_:)), "g")
        findNext.tag = Int(NSFindPanelAction.next.rawValue)
        let findPrev = std("Find Previous", #selector(TerminalViewFinding.performFindPanelAction(_:)), "g", [.command, .shift])
        findPrev.tag = Int(NSFindPanelAction.previous.rawValue)

        _ = submenu("Shell", [
            item("New Terminal", "newTerminal"),
            item("Command Bar", "commandBar"),
            item("Quick Terminal", "quickTerminal"),
            .separator(),
            item("Split Right", "splitRight"),
            item("Split Down", "splitDown"),
            item("Close Pane", "closePane"),
            .separator(),
            item("Copy Last Output", "copyLastOutput"),
            item("Clear", "clear"),
            find, findNext, findPrev,
            .separator(),
            item("Reconnect", "reconnect"),
        ])

        _ = submenu("Edit", [
            std("Undo", Selector(("undo:")), "z"),
            std("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            std("Cut", #selector(NSText.cut(_:)), "x"),
            std("Copy", #selector(NSText.copy(_:)), "c"),
            std("Paste", #selector(NSText.paste(_:)), "v"),
            std("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])

        let fullScreen = std("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
        _ = submenu("View", [
            item("Toggle Sidebar", "toggleSidebar"),
            item("Focus Mode", "focusMode"),
            item("Library", "library"),
            item("All Spaces", "overview"),
            .separator(),
            item("Bigger", "zoomIn"),
            item("Smaller", "zoomOut"),
            item("Actual Size", "zoomReset"),
            .separator(),
            fullScreen,
        ])

        // Each Space by name, ⌃1–9.
        var spaceItems: [NSMenuItem] = [item("Next Space", "nextSpace"), item("Previous Space", "prevSpace"), .separator()]
        for (i, sp) in store.model.spaces.enumerated() {
            let it = NSMenuItem(title: SpaceIcon.menuTitle(sp), action: #selector(AppDelegate.runMenuAction(_:)), keyEquivalent: i < 9 ? "\(i + 1)" : "")
            it.image = SpaceIcon.menuImage(sp)
            it.keyEquivalentModifierMask = .control
            it.representedObject = "space:\(sp.id)"
            it.state = sp.id == store.model.activeSpaceId ? .on : .off
            spaceItems.append(it)
        }
        spaceItems += [.separator(), item("New Space…", "newSpace")]
        _ = submenu("Spaces", spaceItems)

        let windowMenu = submenu("Window", [
            std("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            std("Zoom", #selector(NSWindow.performZoom(_:)), ""),
            .separator(),
            item("Previous Session", "prevTab"),
            item("Next Session", "nextTab"),
            .separator(),
            item("Focus Pane Left", "focusLeft"),
            item("Focus Pane Right", "focusRight"),
            item("Focus Pane Up", "focusUp"),
            item("Focus Pane Down", "focusDown"),
            item("Jump to Bottom", "jumpBottom"),
            .separator(),
            std("Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), ""),
        ])
        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu.submenu
    }

    // "Shift+Cmd+D" → key equivalent "d" with ⇧⌘.
    static func setShortcut(_ item: NSMenuItem, _ accel: String?) {
        guard let accel, let (mods, key) = Keys.split(accel) else { return }
        var mask: NSEvent.ModifierFlags = []
        if mods.contains("Cmd") { mask.insert(.command) }
        if mods.contains("Ctrl") { mask.insert(.control) }
        if mods.contains("Alt") { mask.insert(.option) }
        if mods.contains("Shift") { mask.insert(.shift) }
        // Menus match shifted punctuation by the character it types: ⇧[ is "{".
        if mask.contains(.shift), let shifted = shiftedPunctuation[key] {
            mask.remove(.shift)
            item.keyEquivalent = shifted
        } else {
            item.keyEquivalent = keyEquivalent(key)
        }
        item.keyEquivalentModifierMask = mask
    }

    static let shiftedPunctuation = ["[": "{", "]": "}", "=": "+", "-": "_", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?", "\\": "|", "`": "~"]

    static func keyEquivalent(_ key: String) -> String {
        func fn(_ c: Int) -> String { String(Character(UnicodeScalar(c)!)) }
        switch key {
        case "Left": return fn(NSLeftArrowFunctionKey)
        case "Right": return fn(NSRightArrowFunctionKey)
        case "Up": return fn(NSUpArrowFunctionKey)
        case "Down": return fn(NSDownArrowFunctionKey)
        case "Space": return " "
        case "Enter": return "\r"
        case "Esc": return "\u{1b}"
        case "Tab": return "\t"
        case "Backspace": return "\u{8}"
        default: return key.lowercased()
        }
    }
}

// The selector SwiftTerm's view implements for its find bar.
@objc protocol TerminalViewFinding {
    func performFindPanelAction(_ sender: Any?)
}
