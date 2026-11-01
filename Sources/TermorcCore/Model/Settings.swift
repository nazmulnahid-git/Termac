import Foundation

public struct Gestures: Codable, Equatable, Sendable {
    public var swipeSpaces = true
    public var pinch = true
    public var edgeReveal = true
    public var peek = true

    public init() {}

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Gestures()
        swipeSpaces = c.v(.swipeSpaces, d.swipeSpaces)
        pinch = c.v(.pinch, d.pinch)
        edgeReveal = c.v(.edgeReveal, d.edgeReveal)
        peek = c.v(.peek, d.peek)
    }
}

// Key names and defaults are part of state.json and ~/.termorc/settings.json, so files
// written by earlier versions keep loading.
public struct Settings: Codable, Equatable, Sendable {
    public var onLaunch = "restore" // restore | fresh
    public var newTerminalDir = "current" // current | space | home
    public var archiveAfterH: Double = 12 // 0 = never
    public var libraryDays: Double = 90 // 0 = forever
    public var neverArchiveRunning = true
    public var notifyAfterS: Double = 30 // 0 = never
    public var osNotify = "background" // always | background | never
    public var confirmQuit = true
    public var zoomLevel: Double = 100
    public var uiFontFamily = "system-ui"
    public var uiFontSize: Double = 12.5
    public var uiLineHeight: Double = 1.4
    public var fontFamily = "SF Mono, Menlo, monospace"
    public var fontSize: Double = 13
    public var lineHeight: Double = 1.4
    public var letterSpacing: Double = 0
    public var fontWeight = "normal"
    public var fontWeightBold = "600"
    public var cursorStyle = "block" // block | underline | bar
    public var cursorBlink = true
    public var termTheme = "system" // system | dark | light
    public var optionAsMeta = false
    public var scrollback: Int = 10000
    public var keybindings: [String: String] = Keys.defaultBindings()
    public var shellPriority = false
    public var gestures = Gestures()
    public var sidebarMode = "expanded" // expanded | compact | hidden
    public var clickToMove = true
    public var promptStyle = "termorc" // termorc (input bar + blocks) | shell
    public var terminalWelcome = true

    public init() {}

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Settings()
        onLaunch = c.v(.onLaunch, d.onLaunch)
        newTerminalDir = c.v(.newTerminalDir, d.newTerminalDir)
        archiveAfterH = c.v(.archiveAfterH, d.archiveAfterH)
        libraryDays = c.v(.libraryDays, d.libraryDays)
        neverArchiveRunning = c.v(.neverArchiveRunning, d.neverArchiveRunning)
        notifyAfterS = c.v(.notifyAfterS, d.notifyAfterS)
        osNotify = c.v(.osNotify, d.osNotify)
        confirmQuit = c.v(.confirmQuit, d.confirmQuit)
        zoomLevel = c.v(.zoomLevel, d.zoomLevel)
        uiFontFamily = c.v(.uiFontFamily, d.uiFontFamily)
        uiFontSize = c.v(.uiFontSize, d.uiFontSize)
        uiLineHeight = c.v(.uiLineHeight, d.uiLineHeight)
        fontFamily = c.v(.fontFamily, d.fontFamily)
        fontSize = c.v(.fontSize, d.fontSize)
        lineHeight = c.v(.lineHeight, d.lineHeight)
        letterSpacing = c.v(.letterSpacing, d.letterSpacing)
        fontWeight = Settings.weight(c, .fontWeight) ?? d.fontWeight
        fontWeightBold = Settings.weight(c, .fontWeightBold) ?? d.fontWeightBold
        cursorStyle = c.v(.cursorStyle, d.cursorStyle)
        cursorBlink = c.v(.cursorBlink, d.cursorBlink)
        termTheme = c.v(.termTheme, d.termTheme)
        optionAsMeta = c.v(.optionAsMeta, d.optionAsMeta)
        scrollback = c.v(.scrollback, d.scrollback)
        // Saved bindings over the defaults, dropping actions that no longer exist.
        let saved: [String: String] = c.v(.keybindings, [:])
        var kb = d.keybindings
        for (k, v) in saved where kb[k] != nil { kb[k] = v }
        keybindings = kb
        shellPriority = c.v(.shellPriority, d.shellPriority)
        gestures = c.v(.gestures, d.gestures)
        sidebarMode = c.v(.sidebarMode, d.sidebarMode)
        clickToMove = c.v(.clickToMove, d.clickToMove)
        promptStyle = c.v(.promptStyle, d.promptStyle)
        terminalWelcome = c.v(.terminalWelcome, d.terminalWelcome)
        // An older build stored `sidebarHidden: true`.
        if (try? decoder.container(keyedBy: Legacy.self).decodeIfPresent(Bool.self, forKey: .sidebarHidden)) == true, c.opt(.sidebarMode) as String? == nil {
            sidebarMode = "hidden"
        }
    }

    private enum Legacy: String, CodingKey { case sidebarHidden }

    // Font weights were written as strings ("normal", "600") or numbers.
    private static func weight<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> String? {
        if let s: String = c.opt(k) { return s }
        if let n: Double = c.opt(k) { return String(Int(n)) }
        return nil
    }
}
