import Foundation

// Parsers for the command output WidgetFeed collects, kept here so they're unit-tested.
extension LocalServer {
    // Listeners that are apps rather than dev servers.
    static let ignored = ["node-arm64", "stable", "ControlCenter", "rapportd", "Raycast", "com.docker*", "vpnkit*", "adb", "agy", "*Helper*",
                          "sharingd", "identityservicesd", "ARDAgent", "Spotify", "Discord", "WhatsApp", "Arc", "Safari", "figma_agent",
                          "Dropbox", "Electron", "OneDrive", "Notion*", "Slack*"]

    static func isIgnored(_ command: String) -> Bool {
        ignored.contains { pattern in
            switch (pattern.hasPrefix("*"), pattern.hasSuffix("*")) {
            case (true, true): return command.contains(pattern.dropFirst().dropLast())
            case (false, true): return command.hasPrefix(pattern.dropLast())
            case (true, false): return command.hasSuffix(pattern.dropFirst())
            case (false, false): return command == pattern
            }
        }
    }

    // `lsof +c 0 -nP -iTCP -sTCP:LISTEN -Fpcn` → one listener per port, lowest port first.
    // Ephemeral ports (49152+) are left out: they're apps talking to each other, not servers.
    public static func listeners(_ lsof: String) -> [(port: Int, pid: Int32, command: String)] {
        var out: [Int: (Int, Int32, String)] = [:]
        var pid: Int32 = 0
        var command = ""
        for line in lsof.split(separator: "\n") {
            let value = String(line.dropFirst())
            switch line.first {
            case "p": pid = Int32(value) ?? 0
            case "c": command = value
            case "n":
                guard let port = value.split(separator: ":").last.flatMap({ Int($0) }), port < 49152,
                      out[port] == nil, !isIgnored(command) else { continue }
                out[port] = (port, pid, command)
            default: break
            }
        }
        return out.values.sorted { $0.0 < $1.0 }.map { (port: $0.0, pid: $0.1, command: $0.2) }
    }

    // `lsof -a -p 1,2 -d cwd -Fn` → pid: working directory.
    public static func cwds(_ lsof: String) -> [Int32: String] {
        var out: [Int32: String] = [:]
        var pid: Int32 = 0
        for line in lsof.split(separator: "\n") {
            if line.first == "p" { pid = Int32(line.dropFirst()) ?? 0 }
            if line.first == "n" { out[pid] = String(line.dropFirst()) }
        }
        return out
    }

    // `ps -ww -o pid=,etime=,rss=,args= -p 1,2` → pid: (seconds running, RSS in KB, command line).
    public static func processes(_ ps: String) -> [Int32: (seconds: Int, rssKB: Int, args: String)] {
        var out: [Int32: (Int, Int, String)] = [:]
        for line in ps.split(separator: "\n") {
            let f = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
            guard f.count >= 3, let pid = Int32(f[0]), let rss = Int(f[2]) else { continue }
            out[pid] = (elapsed(String(f[1])), rss, f.count > 3 ? String(f[3].prefix(300)) : "")
        }
        return out.mapValues { (seconds: $0.0, rssKB: $0.1, args: $0.2) }
    }

    // ps etime is [[dd-]hh:]mm:ss.
    public static func elapsed(_ etime: String) -> Int {
        let parts = etime.split(separator: "-")
        let days = parts.count == 2 ? Int(parts[0]) ?? 0 : 0
        let clock = (parts.last ?? "").split(separator: ":").compactMap { Int($0) }
        let secs = clock.reduce(0) { $0 * 60 + $1 }
        return days * 86400 + secs
    }
}

extension SystemSnapshot {
    // `ping -c1 -t1 1.1.1.1` → round trip in whole ms.
    public static func pingTime(_ output: String) -> Int? {
        guard let r = output.range(of: #"time=([0-9.]+)"#, options: .regularExpression) else { return nil }
        return Double(output[r].dropFirst(5)).map { Int($0) }
    }
}

extension PullsSnapshot {
    // The two searches WidgetFeed asks GitHub for. `org` narrows both; empty means everywhere.
    public static func query(org: String) -> String {
        let safe = org.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        let scope = safe.isEmpty ? "" : " org:\(safe)"
        return """
        fragment pr on PullRequest {
          number title url isDraft updatedAt additions deletions reviewDecision
          author { login avatarUrl(size: 64) } repository { name } comments { totalCount }
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        }
        {
          review: search(type: ISSUE, first: 30, query: "is:pr is:open archived:false\(scope) review-requested:@me sort:updated-desc") { issueCount nodes { ...pr } }
          mine: search(type: ISSUE, first: 30, query: "is:pr is:open archived:false\(scope) author:@me sort:updated-desc") { issueCount nodes { ...pr } }
        }
        """
    }

    private struct Response: Decodable {
        struct Search: Decodable {
            let issueCount: Int
            let nodes: [Node?]
        }

        struct Node: Decodable {
            struct Author: Decodable { let login: String; let avatarUrl: String }
            struct Repo: Decodable { let name: String }
            struct Count: Decodable { let totalCount: Int }
            struct Commits: Decodable {
                struct Item: Decodable {
                    struct Commit: Decodable {
                        struct Rollup: Decodable { let state: String }
                        let statusCheckRollup: Rollup?
                    }
                    let commit: Commit
                }
                let nodes: [Item]
            }

            let number: Int?
            let title: String?
            let url: String?
            let isDraft: Bool?
            let updatedAt: Date?
            let additions: Int?
            let deletions: Int?
            let reviewDecision: String?
            let author: Author? // nil for deleted accounts ("ghost")
            let repository: Repo?
            let comments: Count?
            let commits: Commits?
        }

        struct Data: Decodable { let review: Search; let mine: Search }
        let data: Data
    }

    // `gh api graphql` output for `query` → the two lists.
    public static func lists(_ json: Data) -> (review: PullList, mine: PullList)? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let r = try? decoder.decode(Response.self, from: json) else { return nil }
        func list(_ s: Response.Search) -> PullList {
            let items = s.nodes.compactMap { n -> PullRequest? in
                // Issues come back as empty objects from a PR-only search; skip them.
                guard let n, let number = n.number, let url = n.url else { return nil }
                return PullRequest(number: number, title: n.title ?? "", url: url, repo: n.repository?.name ?? "", author: n.author?.login ?? "ghost",
                                   avatarURL: n.author?.avatarUrl ?? "", isDraft: n.isDraft ?? false, updatedAt: n.updatedAt ?? Date(),
                                   additions: n.additions ?? 0, deletions: n.deletions ?? 0, comments: n.comments?.totalCount ?? 0,
                                   review: n.reviewDecision, checks: n.commits?.nodes.first?.commit.statusCheckRollup?.state)
            }
            return PullList(total: s.issueCount, items: items)
        }
        return (list(r.data.review), list(r.data.mine))
    }
}
