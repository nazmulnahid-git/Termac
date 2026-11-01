import AppKit

// Termorc's entry point. The app is built without a storyboard or nib: AppDelegate builds
// the menu bar and the main window in code.
let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
