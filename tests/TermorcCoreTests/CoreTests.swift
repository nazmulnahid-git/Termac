import Foundation
import Testing
@testable import TermorcCore

// Unit tests for TermorcCore.

private func leaf(_ s: String) -> Layout { .leaf(s) }
// 1 | 2
// 3 | 4
private func grid() -> Layout {
    .split(dir: .row, ratio: 0.5, a: .split(dir: .col, ratio: 0.5, a: leaf("1"), b: leaf("3")), b: .split(dir: .col, ratio: 0.5, a: leaf("2"), b: leaf("4")))
}

@Suite struct LayoutTests {
    @Test func leavesInOrder() {
        #expect(leaf("a").leaves == ["a"])
        #expect(grid().leaves == ["1", "3", "2", "4"])
    }

    @Test func insertEdges() {
        #expect(leaf("a").inserting("b", nextTo: "a") == .split(dir: .row, ratio: 0.5, a: leaf("a"), b: leaf("b")))
        #expect(leaf("a").inserting("b", nextTo: "a", edge: .left) == .split(dir: .row, ratio: 0.5, a: leaf("b"), b: leaf("a")))
        #expect(leaf("a").inserting("b", nextTo: "a", edge: .bottom) == .split(dir: .col, ratio: 0.5, a: leaf("a"), b: leaf("b")))
        #expect(leaf("a").inserting("b", nextTo: "a", edge: .top) == .split(dir: .col, ratio: 0.5, a: leaf("b"), b: leaf("a")))
        let t = leaf("a").inserting("b", nextTo: "a").inserting("c", nextTo: "b", edge: .bottom)
        #expect(t == .split(dir: .row, ratio: 0.5, a: leaf("a"), b: .split(dir: .col, ratio: 0.5, a: leaf("b"), b: leaf("c"))))
        #expect(t.inserting("x", nextTo: "zzz") == t)
    }

    @Test func capsAtMaxPanes() {
        var t = leaf("p0")
        for i in 1..<10 { t = t.inserting("p\(i)", nextTo: "p\(i - 1)") }
        #expect(t.leaves.count == Layout.maxPanes)
        #expect(t.inserting("extra", nextTo: "p0") == t)
    }

    @Test func insertRoot() {
        let t = leaf("a").inserting("b", nextTo: "a")
        // Beside two panes in a row, the newcomer takes a third; above them, half.
        #expect(t.insertingRoot(leaf("c"), edge: .right) == .split(dir: .row, ratio: 2.0 / 3, a: t, b: leaf("c")))
        #expect(t.insertingRoot(leaf("c"), edge: .top) == .split(dir: .col, ratio: 0.5, a: leaf("c"), b: t))
        #expect(grid().insertingRoot(leaf("5")) == grid())
    }

    @Test func remove() {
        let t = leaf("a").inserting("b", nextTo: "a")
        #expect(t.removing("b") == leaf("a"))
        #expect(t.removing("a") == leaf("b"))
        let n = leaf("a").inserting("b", nextTo: "a").inserting("c", nextTo: "b", edge: .bottom).settingRatio(0.3, at: [])
        #expect(n.removing("c") == .split(dir: .row, ratio: 0.3, a: leaf("a"), b: leaf("b")))
        #expect(n.removing("a") == .split(dir: .col, ratio: 0.5, a: leaf("b"), b: leaf("c")))
        #expect(leaf("a").removing("a") == nil)
        #expect(grid().removing("zzz") == grid())
        #expect(grid().removing("4")?.leaves == ["1", "3", "2"])
    }

    @Test func snapRatio() {
        #expect(Layout.snapRatio(0.34) == 1.0 / 3)
        #expect(Layout.snapRatio(0.51) == 0.5)
        #expect(Layout.snapRatio(0.65) == 2.0 / 3)
        #expect(Layout.snapRatio(0.4) == 0.4)
        #expect(Layout.snapRatio(0.05) == 0.15)
        #expect(Layout.snapRatio(2) == 0.85)
    }

    @Test func neighbor() {
        let g = grid()
        #expect(g.neighbor(of: "1", .right) == "2")
        #expect(g.neighbor(of: "1", .down) == "3")
        #expect(g.neighbor(of: "1", .left) == nil)
        #expect(g.neighbor(of: "4", .up) == "2")
        #expect(g.neighbor(of: "4", .left) == "3")
        #expect(leaf("a").neighbor(of: "a", .right) == nil)
    }

    @Test func jsonShapeMatchesWebBuild() throws {
        let json = #"{"dir":"row","ratio":0.25,"a":{"sid":"x"},"b":{"sid":"y"}}"#
        let l = try JSONDecoder().decode(Layout.self, from: Data(json.utf8))
        #expect(l == .split(dir: .row, ratio: 0.25, a: leaf("x"), b: leaf("y")))
        let back = try JSONSerialization.jsonObject(with: JSONEncoder().encode(l)) as? [String: Any]
        #expect(back?["dir"] as? String == "row")
        #expect((back?["a"] as? [String: Any])?["sid"] as? String == "x")
    }
}

@Suite struct RoutingTests {
    let home = "/Users/me"

    @Test func homePaths() {
        #expect(Routing.expandHome("~", home: home) == home)
        #expect(Routing.expandHome("~/work", home: home) == "/Users/me/work")
        #expect(Routing.expandHome("~other", home: home) == "~other")
        #expect(Routing.tildify(home, home: home) == "~")
        #expect(Routing.tildify("/Users/me/work/api", home: home) == "~/work/api")
        #expect(Routing.tildify("/Users/meow", home: home) == "/Users/meow")
    }

    @Test func sshTargets() {
        #expect(Routing.sshTarget("ssh deploy@web-01") == .init(user: "deploy", host: "web-01", raw: "deploy@web-01"))
        #expect(Routing.sshTarget("ssh WEB-01.Prod.com")?.host == "web-01.prod.com")
        #expect(Routing.sshTarget("ssh -p 22 -i key deploy@web-01")?.host == "web-01")
        #expect(Routing.sshTarget("ssh -v -A -o StrictHostKeyChecking=no -J bastion host-a")?.host == "host-a")
        #expect(Routing.sshTarget("sudo ssh root@db")?.host == "db")
        #expect(Routing.sshTarget("/usr/bin/ssh web")?.host == "web")
        #expect(Routing.sshTarget("autossh -M 0 web")?.host == "web")
        #expect(Routing.sshTarget("ls -la") == nil)
        #expect(Routing.sshTarget("sshfs host:/ /mnt") == nil)
        #expect(Routing.sshTarget("ssh -p 22") == nil)
        #expect(Routing.sshTarget(nil) == nil)
    }

    @Test func riskyCommands() {
        for cmd in ["sudo apt upgrade", "ls && sudo reboot", "systemctl restart nginx", "rm -rf /tmp/x", "rm -fr build", "shutdown -h now", #"psql -c "DROP TABLE users""#] {
            #expect(Routing.isRiskyCommand(cmd), "\(cmd)")
        }
        for cmd in ["ls", "rm file.txt", "git push", "sudoku", ""] {
            #expect(!Routing.isRiskyCommand(cmd), "\(cmd)")
        }
    }
}

@Suite struct KeysTests {
    @Test func normalizeAndFormat() {
        #expect(Keys.normalize("Cmd+Shift+d") == "Shift+Cmd+D")
        #expect(Keys.normalize("CommandOrControl+T") == "Cmd+T")
        #expect(Keys.format("Shift+Cmd+D") == "⇧⌘D")
        #expect(Keys.format("Ctrl+Left") == "⌃←")
        #expect(Keys.format("Alt+Space") == "⌥ Space")
        #expect(Keys.split("Cmd+=")?.key == "=")
        #expect(Keys.split("Cmd++")?.key == "+")
    }
}

@Suite struct MetaTests {
    @Test func kinds() {
        #expect(Meta.kindOf("npm run dev") == "js")
        #expect(Meta.kindOf("sudo docker ps") == "dk")
        #expect(Meta.kindOf("FOO=1 python3 x.py") == "py")
        #expect(Meta.kindOf("ls") == ">_")
        #expect(Meta.kindOf(nil) == ">_")
    }

    @Test func firstTokens() {
        #expect(Meta.firstToken("sudo -E npm run build") == "npm run build")
        #expect(Meta.firstToken("/usr/local/bin/node app.js") == "node")
        #expect(Meta.firstToken("FOO=1 make") == "make")
    }

    @Test func durations() {
        #expect(Meta.formatDuration(1234) == "1.23s")
        #expect(Meta.formatDuration(42_000) == "42s")
        #expect(Meta.formatDuration(125_000) == "2m 5s")
        #expect(Meta.formatDuration(3_725_000) == "1h 2m")
    }

    @Test func names() {
        var rt = SessionRuntime()
        rt.cwd = "/Users/me/work/api"
        #expect(Meta.sessionName(tabName: nil, rt: rt, cwd: nil, home: "/Users/me") == "api")
        rt.status = .run
        rt.command = "npm test"
        #expect(Meta.sessionName(tabName: nil, rt: rt, cwd: nil, home: "/Users/me") == "npm test")
        #expect(Meta.sessionName(tabName: "mine", rt: rt, cwd: nil, home: "/Users/me") == "mine")
        #expect(Meta.shortName("verylongname here") == "verylo…")
    }
}

@Suite struct ModelTests {
    @Test func readsWebBuildState() throws {
        let json = """
        {"version":2,"onboarded":true,"activeSpaceId":"sp1","favorites":[],
         "spaces":[{"id":"sp1","name":"Home","glyph":"◆","iconImage":null,"color":"#3b82f6","startDir":"~","profileId":null,"archiveAfterH":null,
                    "term":{"bg":null,"image":null,"dim":0.6,"blur":0},"pinned":["t1"],"folders":[{"id":"f1","name":"Work","open":true,"tabs":[]}],"today":["t2"],"activeTabId":"t1"}],
         "tabs":{"t1":{"id":"t1","name":null,"layout":{"sid":"s1"},"activeSid":"s1","effects":{"danger":true},"createdAt":1700000000000,"color":"#e5487d"},
                 "t2":{"id":"t2","layout":{"broken":true},"activeSid":"s2"}},
         "sessions":{"s1":{"id":"s1","cwd":"/tmp","profileId":"default","command":"","createdAt":1700000000000}},
         "settings":{"fontSize":15,"fontWeight":600,"keybindings":{"commandBar":"Cmd+K","gone":"Cmd+J"},"sidebarHidden":true},
         "profiles":[{"id":"default","name":"Login shell","command":"","cwdMode":"space","cwd":"","env":[["A","1"]],"startup":""}],
         "defaultProfileId":"default","snippets":[],"recentDirs":[],"activity":[]}
        """
        let m = AppModel.migrate(Data(json.utf8))
        #expect(m.onboarded)
        #expect(m.spaces[0].pinned == ["t1"])
        #expect(m.spaces[0].folders[0].name == "Work")
        #expect(m.tabs["t1"]?.has("danger") == true)
        #expect(m.tabs["t1"]?.color == "#e5487d")
        #expect(m.tabs["t2"] == nil) // unreadable layout dropped, not the whole file
        #expect(m.settings.fontSize == 15)
        #expect(m.settings.fontWeight == "600")
        #expect(m.settings.keybindings["commandBar"] == "Cmd+K")
        #expect(m.settings.keybindings["gone"] == nil)
        #expect(m.settings.keybindings["splitRight"] == "Cmd+D")
        #expect(m.settings.sidebarMode == "hidden")
        #expect(m.profiles[0].envPairs.first! == ("A", "1"))
    }

    @Test func wrongVersionStartsFresh() {
        let m = AppModel.migrate(Data(#"{"version":1}"#.utf8))
        #expect(m.spaces.count == 1)
        #expect(m.spaces[0].name == "Home")
    }

    @Test func roundTrips() throws {
        let m = AppModel.initial()
        let back = AppModel.migrate(m.encoded())
        #expect(back == m)
    }
}

@Suite struct ShellLaunchTests {
    let base = ["SHELL": "/bin/zsh", "HOME": "/Users/me", "PATH": "/usr/bin", "CARGO_HOME": "x", "TERMORC_DATA_DIR": "/tmp/d"]

    @Test func zshGetsIntegrationZdotdir() {
        let l = ShellLaunch.make(.init(spaceName: "work", cwd: "/", ownPrompt: true, integrationDir: "/res/si"), baseEnv: base)
        #expect(l.executable == "/bin/zsh")
        #expect(l.args == ["-l"])
        #expect(l.shell == "zsh")
        #expect(l.integrated)
        #expect(l.env["ZDOTDIR"] == "/res/si/zsh")
        #expect(l.env["TERMAC_USER_ZDOTDIR"] == "/Users/me")
        #expect(l.env["TERMORC_PROMPT"] == "1")
        #expect(l.env["SHELL_SPACE"] == "work")
        #expect(l.env["TERM_PROGRAM"] == "Termorc")
        #expect(l.env["CARGO_HOME"] == nil)
        #expect(l.env["TERMORC_DATA_DIR"] == nil)
    }

    @Test func bashAndFishAndOthers() {
        let b = ShellLaunch.make(.init(command: "/bin/bash -l", cwd: "/", integrationDir: "/si"), baseEnv: base)
        #expect(b.args == ["--rcfile", "/si/bash.sh"])
        #expect(b.env["TERMAC_LOGIN"] == "1")
        let f = ShellLaunch.make(.init(command: "fish", cwd: "/", integrationDir: "/si"), baseEnv: base)
        #expect(f.args == ["--init-command", "source '/si/termac.fish'"])
        let n = ShellLaunch.make(.init(command: #"nu -c "echo hi""#, cwd: "/", integrationDir: "/si"), baseEnv: base)
        #expect(n.args == ["-c", "echo hi"])
        #expect(!n.integrated)
    }

    @Test func profileEnvAndMissingCwd() {
        let l = ShellLaunch.make(.init(profileEnv: [("KUBE_CTX", "$space-ctx")], spaceName: "prod", cwd: "/definitely/not/here", integrationDir: "/si"), baseEnv: base)
        #expect(l.env["KUBE_CTX"] == "prod-ctx")
        #expect(l.cwd == "/Users/me")
    }
}

@Suite struct ThemeTests {
    @Test func looks() {
        var sp = Space(name: "x", color: "#3b82f6")
        #expect(TerminalLook(space: sp, fallbackTheme: "dark").bg == "#1d1d1d")
        #expect(TerminalLook(space: sp, fallbackTheme: "light").dark == false)
        sp.term.bg = "tint"
        let tint = TerminalLook(space: sp, fallbackTheme: "light")
        #expect(tint.dark)
        #expect(tint.bg == TermTheme.mix("#3b82f6", "#121318", 0.84))
    }
}

@Suite struct MarkScannerTests {
    func bytes(_ s: String) -> ArraySlice<UInt8> { ArraySlice(Array(s.utf8)) }

    @Test func splitsAroundMarks() {
        var s = MarkScanner()
        let out = s.scan(bytes("hi\u{1b}]633;A\u{07}there\u{1b}]633;D;1\u{1b}\\x"))
        #expect(out == [.bytes(Array("hi\u{1b}]633;A\u{07}".utf8)), .mark("A"), .bytes(Array("there\u{1b}]633;D;1\u{1b}\\".utf8)), .mark("D;1"), .bytes(Array("x".utf8))])
    }

    @Test func holdsAMarkSplitAcrossReads() {
        var s = MarkScanner()
        #expect(s.scan(bytes("out\u{1b}]63")) == [.bytes(Array("out".utf8))])
        #expect(s.scan(bytes("3;P;Cwd=/tmp")) == [])
        #expect(s.scan(bytes("\u{07}more")) == [.bytes(Array("\u{1b}]633;P;Cwd=/tmp\u{07}".utf8)), .mark("P;Cwd=/tmp"), .bytes(Array("more".utf8))])
    }

    @Test func passesOtherEscapes() {
        var s = MarkScanner()
        #expect(s.scan(bytes("\u{1b}[31mred\u{1b}]0;title\u{07}")) == [.bytes(Array("\u{1b}[31mred\u{1b}]0;title\u{07}".utf8))])
        #expect(s.scan(bytes("tail\u{1b}")) == [.bytes(Array("tail".utf8))])
        #expect(s.scan(bytes("[0m")) == [.bytes(Array("\u{1b}[0m".utf8))])
    }
}

@Suite struct LibraryTests {
    @Test func searchHitsNameCommandAndStrippedOutput() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("termorc-lib-\(getpid())-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let lib = Library(dir: dir)
        func entry(_ id: String, _ name: String) -> LibraryEntry {
            LibraryEntry(id: id, name: name, spaceId: nil, spaceName: "", cwd: "/tmp", host: "local", status: "idle", exitCode: nil, startedAt: 0, endedAt: nowMillis(), idleSince: 0, reason: "closed", commands: [.init(cmd: "cargo build", exit: 0, at: 0)], lines: 1)
        }
        lib.add(entry("a", "deploy"), ansi: "\u{1b}[31mERROR\u{1b}[0m: disk full\r\n")
        lib.add(entry("b", "notes"), ansi: "all good")
        #expect(lib.search(.init(q: "deploy")).results.map { [$0.id, $0.hit ?? ""] } == [["a", "name"]])
        #expect(lib.search(.init(q: "error: disk")).results.map { [$0.id, $0.hit ?? ""] } == [["a", "output"]])
        #expect(lib.search(.init(q: "cargo")).results.count == 2)
        lib.remove("a")
        #expect(lib.search(.init()).total == 1)
        lib.flush()
        #expect(Library(dir: dir).count == 1)
    }
}

@Suite struct SettingsFileTests {
    @Test func stripsJsonc() throws {
        let text = "{\n  // note\n  \"a\": \"http://x/*y*/\", /* block */\n  \"b\": [1, 2,],\n}"
        let obj = try JSONSerialization.jsonObject(with: Data(SettingsFile.stripJsonc(text).utf8)) as? [String: Any]
        #expect(obj?["a"] as? String == "http://x/*y*/")
        #expect((obj?["b"] as? [Int]) == [1, 2])
        let q = try JSONSerialization.jsonObject(with: Data(SettingsFile.stripJsonc(#"{"a": "say \"hi\" // not a comment"}"#).utf8)) as? [String: Any]
        #expect(q?["a"] as? String == #"say "hi" // not a comment"#)
    }

    @Test func roundTripsDefaults() throws {
        let r = try SettingsFile.parse(SettingsFile.toFile(Settings(), schemaUrl: nil))
        #expect(r.warnings == [])
        #expect(r.settings == Settings())
    }

    @Test func mapsNestedKeys() throws {
        let r = try SettingsFile.parse(#"{ "appearance": { "ui": { "font_size": 15 }, "terminal": { "font_weight": 500 } }, "gestures": { "pinch": false } }"#)
        #expect(r.settings.uiFontSize == 15)
        #expect(r.settings.fontWeight == "500")
        #expect(r.settings.gestures.pinch == false)
        #expect(r.settings.gestures.peek == true)
        #expect(r.settings.fontSize == 13)
    }

    @Test func clampsAndWarns() throws {
        let r = try SettingsFile.parse(#"{ "appearance": { "terminal": { "font_size": 99, "cursor_style": "beam", "cursor_blink": "yes" } } }"#)
        #expect(r.settings.fontSize == 28)
        #expect(r.settings.cursorStyle == "block")
        #expect(r.settings.cursorBlink == true)
        #expect(r.warnings.count == 3)
    }

    @Test func unknownKeysAndRetiredActions() throws {
        let r = try SettingsFile.parse(#"{ "appearance": { "fnt_size": 3 }, "keybindings": { "nope": "Cmd+X", "commandBar": "Cmd+K", "toggleReview": "Shift+Cmd+G" } }"#)
        #expect(r.warnings == ["appearance.fnt_size: unknown setting", "keybindings.nope: unknown action"])
        #expect(r.settings.keybindings["commandBar"] == "Cmd+K")
        #expect(r.settings.keybindings["toggleReview"] == nil)
    }

    @Test func syntaxErrorThrows() {
        #expect(throws: SettingsFile.ParseError.self) { try SettingsFile.parse(#"{ "appearance": "#) }
    }

    @Test func schemaDescribesEverything() throws {
        let s = try JSONSerialization.jsonObject(with: Data(SettingsFile.schema().utf8)) as? [String: Any]
        let props = s?["properties"] as? [String: Any]
        let term = ((props?["appearance"] as? [String: Any])?["properties"] as? [String: Any])?["terminal"] as? [String: Any]
        #expect(((term?["properties"] as? [String: Any])?["font_size"] as? [String: Any])?["maximum"] as? Double == 28)
        #expect(((props?["keybindings"] as? [String: Any])?["properties"] as? [String: Any])?.count == Keys.actions.count)
    }

    // Your own settings.json must read back and rewrite byte for byte.
    @Test func rewritesSettingsFileUnchanged() throws {
        let url = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".termorc/settings.json")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        let r = try SettingsFile.parse(text)
        let schema = (try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])?["$schema"] as? String
        #expect(SettingsFile.toFile(r.settings, schemaUrl: schema) == text)
    }
}

@Suite struct FuzzyTests {
    @Test func basics() {
        #expect(Fuzzy.match("", "anything") == Fuzzy.Match(score: 0, indices: []))
        #expect(Fuzzy.match("xyz", "abc") == nil)
        #expect(Fuzzy.match("api", "~/work/api")?.indices == [7, 8, 9])
        #expect(Fuzzy.match("wa", "~/work/api")?.indices == [2, 7])
        #expect(Fuzzy.match("ndev", "npm run dev")?.indices == [0, 8, 9, 10])
    }

    @Test func ranking() {
        // Substrings beat scattered matches; word starts beat mid-word hits.
        #expect(Fuzzy.match("dev", "npm run dev")!.score > Fuzzy.match("dev", "d-e-v")!.score)
        #expect(Fuzzy.match("api", "api-server")!.score > Fuzzy.match("api", "rapid")!.score)
    }
}

@Suite struct CmdLineTests {
    func kinds(_ s: String) -> [String] { CmdLine.tokenize(s).filter { $0.k != .space }.map { "\($0.k.rawValue):\($0.t)" } }

    @Test func tokenizes() {
        #expect(kinds("FOO=1 npm run dev --port 3000 | grep \"ready\" && echo $HOME") == ["assign:FOO=1", "cmd:npm", "arg:run", "arg:dev", "flag:--port", "arg:3000", "op:|", "cmd:grep", "str:\"ready\"", "op:&&", "cmd:echo", "var:$HOME"])
        #expect(CmdLine.tokenize("ls  -la").map(\.t).joined() == "ls  -la")
        #expect(kinds("echo 'unterminated") == ["cmd:echo", "str:'unterminated"])
        #expect(kinds("cat < in > out") == ["cmd:cat", "op:<", "arg:in", "op:>", "arg:out"])
    }

    @Test func suggestsAndRecalls() {
        let h = ["git status", "git push", "ls", "git status"]
        #expect(CmdLine.suggest("git s", h) == "tatus")
        #expect(CmdLine.suggest("", h) == "")
        #expect(CmdLine.suggest("git status", h) == "")
        #expect(CmdLine.recallList("git", h) == ["git status", "git push"])
    }

    @Test func appliesCompletions() {
        let r = CmdLine.apply("cd sr", caret: 5, start: 3, .init(value: "src/", kind: .dir))
        #expect(r.text == "cd src/" && r.caret == 7)
        let f = CmdLine.apply("cat rea", caret: 7, start: 4, .init(value: "readme.md", kind: .file))
        #expect(f.text == "cat readme.md " && f.caret == 14)
        #expect(CmdLine.commonPrefix(["src/", "scripts/", "secret"]) == "s")
    }

    @Test func completesCommandsPathsAndEscapes() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("termorc-complete-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("src dir"), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: dir.appendingPathComponent("readme.md").path, contents: Data())
        defer { try? FileManager.default.removeItem(at: dir) }
        let c = CmdLine.complete(cwd: dir.path, line: "ech", commands: ["echo", "ed"])
        #expect(c.start == 0 && c.items.map(\.value) == ["echo"])
        let p = CmdLine.complete(cwd: dir.path, line: "cat src")
        #expect(p.start == 4 && p.items.first?.value == "src\\ dir/")
        let f = CmdLine.complete(cwd: dir.path, line: "ls -la re")
        #expect(f.items.first?.value == "readme.md" && f.items.first?.kind == .file)
    }

    @Test func readsShellHistories() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("termorc-hist-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        try ": 1700000001:0;git status\n: 1700000003:0;make \\\nall\n: 1700000002:0;ls\n".write(to: home.appendingPathComponent(".zsh_history"), atomically: true, encoding: .utf8)
        try "#1700000000\nnpm test\n".write(to: home.appendingPathComponent(".bash_history"), atomically: true, encoding: .utf8)
        let h = CmdLine.history(home: home.path, histfile: nil)
        #expect(h == ["make \nall", "ls", "git status", "npm test"])
    }
}
