import Foundation
import TermorcCore

// What the widget gallery shows before a widget is added.
enum Samples {
    private static let now = Date()

    static let servers = [
        LocalServer(port: 3000, pid: 1, command: "node", cwd: "/Users/me/web", args: "next dev", started: now.addingTimeInterval(-8100), rssKB: 412_000),
        LocalServer(port: 5173, pid: 2, command: "node", cwd: "/Users/me/dashboard", args: "vite", started: now.addingTimeInterval(-1500), rssKB: 186_000),
        LocalServer(port: 8000, pid: 3, command: "Python", cwd: "/Users/me/api", args: "uvicorn main:app --reload", started: now.addingTimeInterval(-600), rssKB: 64_000),
    ]

    private static let down: [Double] = (0..<40).map { i -> Double in
        let x = Double(i)
        return 60e3 + 40e3 * sin(x / 4) + Double(i % 7) * 9e3
    }

    private static let up: [Double] = (0..<40).map { i -> Double in 18e3 + 10e3 * cos(Double(i) / 5) }

    static let system = SystemSnapshot(model: "MacBook Pro", chip: "M3 Pro", bootedAt: now.addingTimeInterval(-3 * 86400 - 7200), cpu: 18, memory: 64,
                                       diskUsed: 58, diskFree: 412_000_000_000, battery: 82, charging: false, remaining: 312, network: "Wi-Fi",
                                       ping: 14, lan: "192.168.1.24", wan: "203.0.113.7",
                                       down: down, up: up)

    static let pulls: PullsSnapshot = {
        func pr(_ n: Int, _ title: String, _ repo: String, _ author: String, _ hours: Double, checks: String?, review: String?, draft: Bool = false) -> PullRequest {
            PullRequest(number: n, title: title, url: "https://github.com/acme/\(repo)/pull/\(n)", repo: repo, author: author, avatarURL: "",
                        isDraft: draft, updatedAt: now.addingTimeInterval(-hours * 3600), additions: 120 * n % 900 + 12, deletions: 37 * n % 300,
                        comments: n % 4, review: review, checks: checks)
        }
        let review = [pr(412, "Add billing webhooks", "api", "sara", 0.4, checks: "SUCCESS", review: nil),
                      pr(388, "Move settings to the new layout", "web", "omar", 3, checks: "PENDING", review: nil),
                      pr(97, "Fix flaky upload test", "cli", "lee", 26, checks: "FAILURE", review: "CHANGES_REQUESTED")]
        let mine = [pr(415, "Dark mode for the dashboard", "web", "me", 1, checks: "SUCCESS", review: "APPROVED"),
                    pr(101, "Retry failed syncs", "cli", "me", 50, checks: nil, review: nil, draft: true)]
        return PullsSnapshot(fetchedAt: now, problem: nil, review: PullList(total: review.count, items: review), mine: PullList(total: mine.count, items: mine))
    }()
}
