import Foundation
import Testing
@testable import TermorcCore

// The parsers behind the desktop widgets (WidgetFeed), fed real command output.
@Suite struct LocalhostParsingTests {
    @Test func listenersOnePerPortSkippingApps() {
        let lsof = """
        p613
        crapportd
        f11
        n*:61574
        p624
        cControlCenter
        f10
        n*:7000
        p901
        cnode
        f20
        n*:3000
        f21
        n[::1]:3000
        p902
        cPython
        f5
        n127.0.0.1:8000
        p903
        cSlack Helper
        f9
        n127.0.0.1:9000
        p904
        cnode
        f3
        n*:55123
        """
        let found = LocalServer.listeners(lsof)
        #expect(found.map(\.port) == [3000, 8000])
        #expect(found.map(\.pid) == [901, 902])
        #expect(found.map(\.command) == ["node", "Python"])
    }

    @Test func ignoredPatterns() {
        #expect(LocalServer.isIgnored("Raycast"))
        #expect(LocalServer.isIgnored("com.docker.backend"))
        #expect(LocalServer.isIgnored("Code Helper (Plugin)"))
        #expect(LocalServer.isIgnored("Notion Calendar"))
        #expect(!LocalServer.isIgnored("node"))
        #expect(!LocalServer.isIgnored("Arc2"))
    }

    @Test func cwdsByPid() {
        let lsof = "p901\nfcwd\nn/Users/me/web app\np902\nfcwd\nn/\n"
        #expect(LocalServer.cwds(lsof) == [901: "/Users/me/web app", 902: "/"])
    }

    @Test func processes() {
        let ps = """
            1 02-19:16:38  15248 /sbin/launchd
          901    01:02:03 412000 node /Users/me/web/node_modules/.bin/next dev
          902       00:07   3152 python3
        """
        let p = LocalServer.processes(ps)
        #expect(p[1]?.seconds == 2 * 86400 + 19 * 3600 + 16 * 60 + 38)
        #expect(p[901]?.seconds == 3723)
        #expect(p[901]?.rssKB == 412_000)
        #expect(p[901]?.args == "node /Users/me/web/node_modules/.bin/next dev")
        #expect(p[902]?.seconds == 7)
        #expect(p[902]?.args == "python3")
    }

    @Test func frameworks() {
        #expect(Framework.detect("node", "node /x/node_modules/.bin/next dev").label == "Next.js")
        #expect(Framework.detect("node", "node /x/node_modules/.bin/vite --port 5173").label == "Vite")
        #expect(Framework.detect("Python", "/usr/bin/python3 -m http.server 8000").label == "Python HTTP")
        #expect(Framework.detect("Python", "uvicorn main:app").glyph == "F")
        #expect(Framework.detect("php", "php artisan serve").label == "Laravel")
        #expect(Framework.detect("node", "node server.js").label == "Node.js")
        #expect(Framework.detect("caddy", "caddy run") == Framework(label: "caddy", glyph: "C"))
    }

    @Test func project() {
        let s = LocalServer(port: 3000, pid: 1, command: "node", cwd: "/Users/me/web", args: "", started: Date(), rssKB: 0)
        #expect(s.project == "web")
        #expect(s.url == "http://localhost:3000")
        var root = s
        root.cwd = "/"
        #expect(root.project == "node")
        #expect(!root.hasProject)
    }
}

@Suite struct SystemParsingTests {
    @Test func ping() {
        #expect(SystemSnapshot.pingTime("64 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=11.928 ms") == 11)
        #expect(SystemSnapshot.pingTime("Request timeout for icmp_seq 0") == nil)
    }
}

@Suite struct PullsParsingTests {
    @Test func queryScopesToOrg() {
        #expect(PullsSnapshot.query(org: "AppifyLab").contains("archived:false org:AppifyLab review-requested:@me"))
        #expect(PullsSnapshot.query(org: "").contains("archived:false review-requested:@me"))
        // Nothing that could break out of the search string.
        #expect(!PullsSnapshot.query(org: #"x" author:evil"#).contains("\" author"))
    }

    @Test func decodesBothLists() throws {
        let json = """
        {"data":{
          "review":{"issueCount":2,"nodes":[
            {"number":12,"title":"Add billing","url":"https://github.com/o/api/pull/12","isDraft":false,"updatedAt":"2026-10-31T08:00:00Z",
             "additions":120,"deletions":4,"reviewDecision":"REVIEW_REQUIRED","author":{"login":"sara","avatarUrl":"https://avatars/u/1"},
             "repository":{"name":"api"},"comments":{"totalCount":3},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}},
            {}
          ]},
          "mine":{"issueCount":1,"nodes":[
            {"number":7,"title":"Draft","url":"https://github.com/o/web/pull/7","isDraft":true,"updatedAt":"2026-10-30T08:00:00Z",
             "additions":1,"deletions":0,"reviewDecision":null,"author":null,"repository":{"name":"web"},"comments":{"totalCount":0},
             "commits":{"nodes":[{"commit":{"statusCheckRollup":null}}]}}
          ]}
        }}
        """
        let lists = try #require(PullsSnapshot.lists(Data(json.utf8)))
        #expect(lists.review.total == 2)
        #expect(lists.review.items.count == 1)
        let pr = lists.review.items[0]
        #expect(pr.number == 12 && pr.repo == "api" && pr.author == "sara" && pr.comments == 3)
        #expect(pr.checks == "SUCCESS" && pr.review == "REVIEW_REQUIRED")
        #expect(pr.avatarFile.lastPathComponent == "sara.png")
        let draft = lists.mine.items[0]
        #expect(draft.isDraft && draft.author == "ghost" && draft.checks == nil && draft.review == nil)
    }

    @Test func rejectsErrors() {
        #expect(PullsSnapshot.lists(Data(#"{"errors":[{"message":"Bad credentials"}]}"#.utf8)) == nil)
    }
}

@Suite struct SettingsWidgetTests {
    @Test func githubOrgRoundTrips() {
        var s = Settings()
        #expect(s.githubOrg == "")
        s.githubOrg = "AppifyLab"
        let data = try! JSONEncoder().encode(s)
        #expect(try! JSONDecoder().decode(Settings.self, from: data).githubOrg == "AppifyLab")
    }
}
