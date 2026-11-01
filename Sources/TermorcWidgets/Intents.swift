import AppIntents
import AppKit
import WidgetKit

// The widgets' buttons. They run in this sandboxed extension, then WidgetKit redraws the widget;
// what needs Termorc itself (stopping a server, syncing) goes over Feed.post.

struct CopyTextIntent: AppIntent {
    static let title: LocalizedStringResource = "Copy"
    static let isDiscoverable = false

    @Parameter(title: "Text") var text: String

    init() {}
    init(_ text: String) { self.text = text }

    @MainActor
    func perform() async throws -> some IntentResult {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        return .result()
    }
}

// First tap on Stop: the button turns into a red "Stop?" for three seconds.
struct AskStopServerIntent: AppIntent {
    static let title: LocalizedStringResource = "Stop Server"
    static let isDiscoverable = false

    @Parameter(title: "Process") var pid: Int

    init() {}
    init(_ pid: Int32) { self.pid = Int(pid) }

    func perform() async throws -> some IntentResult {
        WidgetState.set(WidgetState.confirmStop, "\(pid)", for: 3)
        return .result()
    }
}

// Second tap: Termorc sends SIGTERM, then SIGKILL after three seconds, and redraws the list.
struct StopServerIntent: AppIntent {
    static let title: LocalizedStringResource = "Confirm Stop Server"
    static let isDiscoverable = false

    @Parameter(title: "Process") var pid: Int

    init() {}
    init(_ pid: Int32) { self.pid = Int(pid) }

    func perform() async throws -> some IntentResult {
        WidgetState.clear(WidgetState.confirmStop)
        WidgetState.set(WidgetState.stopping, "\(pid)", for: 8)
        Feed.post("stop:\(pid)")
        return .result()
    }
}

struct ShowPullsIntent: AppIntent {
    static let title: LocalizedStringResource = "Show Pull Requests"
    static let isDiscoverable = false

    @Parameter(title: "Tab") var tab: String

    init() {}
    init(_ tab: String) { self.tab = tab }

    func perform() async throws -> some IntentResult {
        WidgetState.pullsTab = tab
        return .result()
    }
}

struct SyncPullsIntent: AppIntent {
    static let title: LocalizedStringResource = "Sync Pull Requests"
    static let isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        WidgetState.set(WidgetState.syncing, "\(Date().timeIntervalSince1970)", for: 20)
        Feed.post("sync:pulls")
        return .result()
    }
}
