import ApplicationServices
import Foundation

// mouse <x> <y> [move|click|double]: moves the pointer to global top-left coordinates (in
// points), clicking there if asked. Exits 1 if this process may not post events (Accessibility).
let a = CommandLine.arguments
guard AXIsProcessTrusted() else { print("not allowed to post events: grant Accessibility to the app running this"); exit(1) }
let p = CGPoint(x: Double(a[1])!, y: Double(a[2])!)
let mode = a.count > 3 ? a[3] : "move"

func post(_ t: CGEventType, clicks: Int64 = 1) {
    let e = CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)!
    e.setIntegerValueField(.mouseEventClickState, value: clicks)
    e.post(tap: .cghidEventTap)
}

post(.mouseMoved)
if mode == "click" || mode == "double" { usleep(80_000); post(.leftMouseDown); usleep(60_000); post(.leftMouseUp) }
if mode == "double" { usleep(80_000); post(.leftMouseDown, clicks: 2); usleep(60_000); post(.leftMouseUp, clicks: 2) }
