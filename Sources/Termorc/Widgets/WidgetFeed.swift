import AppKit
import IOKit.ps
import SystemConfiguration
import TermorcCore
import UserNotifications
import WidgetKit

// Feeds the desktop widgets (Sources/TermorcWidgets). WidgetKit runs them sandboxed, so Termorc
// does the looking (listening ports, system stats, pull requests), writes one snapshot per
// widget (WidgetStore) and asks WidgetKit to redraw. Only widgets that are on the desktop get
// fed: WidgetKit lists them, and a newly added one says hello through the action channel.
@MainActor
final class WidgetFeed: NSObject {
    static let shared = WidgetFeed()

    private var active: Set<String> = []
    private var inFlight: Set<String> = []
    private var again: Set<String> = [] // asked for while in flight: run once more, then redraw
    private var due: [String: Date] = [:]
    private var collectedAt: [String: Date] = [:]
    private var redrawnAt: [String: Date] = [:]
    private var configsCheckedAt = Date.distantPast
    private var servers: [LocalServer] = []
    private var pullsSignature = ""
    private var timer: Timer?
    private let queue = DispatchQueue(label: "termorc.widgets", qos: .utility)
    private let sampler = SystemSampler()

    // How often each widget's data is collected, and the longest a widget goes without a redraw
    // when nothing changed (WidgetKit budgets redraws, so unchanged data waits).
    private static let every: [String: TimeInterval] = [WidgetStore.localhostKind: 5, WidgetStore.systemKind: 15, WidgetStore.pullsKind: 60]
    private static let redrawAfter: [String: TimeInterval] = [WidgetStore.localhostKind: 600, WidgetStore.systemKind: 60, WidgetStore.pullsKind: 300]

    func start() {
        // WidgetKit only talks to a real bundle; `swift run` has none.
        guard Bundle.main.bundleURL.pathExtension == "app", timer == nil else { return }
        WidgetStore.write(FeedStatus(running: true), kind: FeedStatus.kind)
        // Delivered even while Termorc is in the background, which is when widgets get clicked.
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(received(_:)), name: .init(WidgetStore.actionNotification),
                                                            object: nil, suspensionBehavior: .deliverImmediately)
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in MainActor.assumeIsolated { WidgetFeed.shared.tick() } }
        tick()
    }

    // On quit: the widgets say Termorc isn't running instead of showing frozen numbers.
    func stop() {
        guard let timer else { return }
        timer.invalidate()
        self.timer = nil
        WidgetStore.write(FeedStatus(running: false), kind: FeedStatus.kind)
        WidgetCenter.shared.reloadAllTimelines()
    }

    private func tick() {
        let now = Date()
        if now.timeIntervalSince(configsCheckedAt) > 300 { checkConfigurations() }
        for kind in active where now >= due[kind, default: .distantPast] { collect(kind) }
    }

    private func checkConfigurations() {
        configsCheckedAt = Date()
        WidgetCenter.shared.getCurrentConfigurations { result in
            guard case .success(let infos) = result else { return }
            let kinds = Set(infos.map(\.kind))
            DispatchQueue.main.async { MainActor.assumeIsolated { WidgetFeed.shared.setActive(kinds) } }
        }
    }

    private func setActive(_ kinds: Set<String>) {
        let added = kinds.subtracting(active)
        active = kinds
        for kind in added { collect(kind, redraw: true) }
    }

    // ---- Widget → app -----------------------------------------------------------------------
    // "hello:<kind>"  a widget has no data (just added, or Termorc was relaunched)
    // "stop:<pid>"    the Localhost widget's Stop button
    // "sync:pulls"    the Pull Requests widget's sync button
    @objc private func received(_ n: Notification) {
        guard let action = n.object as? String, let colon = action.firstIndex(of: ":") else { return }
        let arg = String(action[action.index(after: colon)...])
        switch action[..<colon] {
        case "hello":
            guard WidgetStore.kinds.contains(arg), Date().timeIntervalSince(collectedAt[arg] ?? .distantPast) > 10 else { return }
            active.insert(arg)
            collect(arg, redraw: true)
        case "stop":
            if let pid = Int32(arg) { stopServer(pid) }
        case "sync":
            active.insert(WidgetStore.pullsKind)
            collect(WidgetStore.pullsKind, redraw: true)
        default: break
        }
    }

    // Only a server the widget is showing; the channel is open to any local process.
    private func stopServer(_ pid: Int32) {
        guard servers.contains(where: { $0.pid == pid }) else { return }
        queue.async {
            kill(pid, SIGTERM)
            for _ in 0..<6 where kill(pid, 0) == 0 { usleep(500_000) }
            if kill(pid, 0) == 0 { kill(pid, SIGKILL) }
            DispatchQueue.main.async { MainActor.assumeIsolated { WidgetFeed.shared.collect(WidgetStore.localhostKind, redraw: true) } }
        }
    }

    // ---- Collect and publish ----------------------------------------------------------------
    private func collect(_ kind: String, redraw: Bool = false) {
        guard !inFlight.contains(kind) else {
            if redraw { again.insert(kind) }
            return
        }
        inFlight.insert(kind)
        due[kind] = Date().addingTimeInterval(Self.every[kind] ?? 60)
        let org = Store.shared.model.settings.githubOrg
        queue.async { [sampler] in
            switch kind {
            case WidgetStore.localhostKind:
                let snap = LocalhostSnapshot(servers: WidgetProbe.servers())
                DispatchQueue.main.async { MainActor.assumeIsolated { WidgetFeed.shared.publish(snap, redraw: redraw) } }
            case WidgetStore.systemKind:
                let snap = sampler.sample()
                DispatchQueue.main.async { MainActor.assumeIsolated { WidgetFeed.shared.publish(snap, redraw: redraw) } }
            default:
                let (lists, problem) = WidgetProbe.pulls(org: org)
                DispatchQueue.main.async { MainActor.assumeIsolated { WidgetFeed.shared.publish(lists, problem, redraw: redraw) } }
            }
        }
    }

    private func publish(_ snap: LocalhostSnapshot, redraw: Bool) {
        let changed = snap.servers.map { "\($0.port):\($0.pid)" } != servers.map { "\($0.port):\($0.pid)" }
        servers = snap.servers
        WidgetStore.write(snap, kind: WidgetStore.localhostKind)
        finished(WidgetStore.localhostKind, changed: changed || redraw)
    }

    private func publish(_ snap: SystemSnapshot, redraw: Bool) {
        WidgetStore.write(snap, kind: WidgetStore.systemKind)
        finished(WidgetStore.systemKind, changed: redraw)
    }

    private func publish(_ lists: (review: PullList, mine: PullList)?, _ problem: String?, redraw: Bool) {
        let previous = WidgetStore.read(PullsSnapshot.self, kind: WidgetStore.pullsKind)
        // A failed fetch keeps the last lists on screen, with the problem in the header.
        let snap = PullsSnapshot(fetchedAt: lists == nil ? previous?.fetchedAt : Date(), problem: problem,
                                 review: lists?.review ?? previous?.review, mine: lists?.mine ?? previous?.mine)
        WidgetStore.write(snap, kind: WidgetStore.pullsKind)
        if let review = lists?.review { notifyNewReviews(review) }
        let signature = ([snap.review, snap.mine].compactMap { $0 }.flatMap { l in ["\(l.total)"] + l.items.map { "\($0.url) \($0.updatedAt) \($0.checks ?? "") \($0.review ?? "")" } } + [problem ?? ""]).joined(separator: "\n")
        let changed = signature != pullsSignature
        pullsSignature = signature
        finished(WidgetStore.pullsKind, changed: changed || redraw)
    }

    private func finished(_ kind: String, changed: Bool) {
        let now = Date()
        inFlight.remove(kind)
        collectedAt[kind] = now
        if changed || now.timeIntervalSince(redrawnAt[kind] ?? .distantPast) >= Self.redrawAfter[kind] ?? 60 {
            redrawnAt[kind] = now
            WidgetCenter.shared.reloadTimelines(ofKind: kind)
        }
        if again.remove(kind) != nil { collect(kind, redraw: true) }
    }

    // A notification for each new review request, like the Übersicht widget's. The first fetch
    // only records what's already waiting.
    private func notifyNewReviews(_ list: PullList) {
        let file = WidgetStore.dir.appendingPathComponent("pulls-seen.json")
        let seen = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([String].self, from: $0) }
        if let data = try? JSONEncoder().encode(list.items.map(\.url)) { try? Persistence.writeAtomic(file, data) }
        guard let seen, Store.shared.model.settings.osNotify != "never" else { return }
        let fresh = Array(list.items.filter { !seen.contains($0.url) }.prefix(3))
        guard !fresh.isEmpty else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { ok, _ in
            guard ok else { return }
            let center = UNUserNotificationCenter.current()
            for pr in fresh {
                let content = UNMutableNotificationContent()
                content.title = "Review requested"
                content.subtitle = "\(pr.repo) #\(pr.number) · \(pr.author)"
                content.body = pr.title
                content.sound = .default
                content.userInfo = ["url": pr.url]
                center.add(UNNotificationRequest(identifier: pr.url, content: content, trigger: nil))
            }
        }
    }
}

// The lookups, run on WidgetFeed's queue.
enum WidgetProbe {
    static func servers() -> [LocalServer] {
        guard let out = System.run("/usr/sbin/lsof", ["+c", "0", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], timeout: 5, usePath: false, anyStatus: true) else { return [] }
        let listeners = LocalServer.listeners(out)
        guard !listeners.isEmpty else { return [] }
        let pids = Set(listeners.map(\.pid)).map(String.init).joined(separator: ",")
        let cwds = LocalServer.cwds(System.run("/usr/sbin/lsof", ["-a", "-p", pids, "-d", "cwd", "-Fn"], timeout: 5, usePath: false, anyStatus: true) ?? "")
        let procs = LocalServer.processes(System.run("/bin/ps", ["-ww", "-o", "pid=,etime=,rss=,args=", "-p", pids], usePath: false, anyStatus: true) ?? "")
        let now = Date()
        return listeners.compactMap { l in
            guard let p = procs[l.pid] else { return nil } // exited since lsof looked
            return LocalServer(port: l.port, pid: l.pid, command: l.command, cwd: cwds[l.pid] ?? "", args: p.args,
                               started: now.addingTimeInterval(-Double(p.seconds)), rssKB: p.rssKB)
        }
    }

    static func pulls(org: String) -> ((review: PullList, mine: PullList)?, String?) {
        guard System.run("which", ["gh"]) != nil else { return (nil, "Install the GitHub CLI: brew install gh") }
        guard let out = System.run("gh", ["api", "graphql", "-f", "query=\(PullsSnapshot.query(org: org))"], timeout: 20, raw: true) else {
            let signedIn = System.run("gh", ["auth", "status"], timeout: 5) != nil
            return (nil, signedIn ? "Can't reach GitHub, will retry" : "Run gh auth login to see pull requests")
        }
        guard let lists = PullsSnapshot.lists(Data(out.utf8)) else { return (nil, "Unexpected reply from GitHub, will retry") }
        saveAvatars(lists.review.items + lists.mine.items)
        return (lists, nil)
    }

    // Widgets can't load remote images; keep each author's avatar on disk for a week.
    static func saveAvatars(_ prs: [PullRequest]) {
        try? FileManager.default.createDirectory(at: WidgetStore.avatars, withIntermediateDirectories: true)
        var done = Set<String>()
        for pr in prs where done.insert(pr.author).inserted && !pr.avatarURL.isEmpty {
            let modified = (try? pr.avatarFile.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            guard modified.map({ -$0.timeIntervalSinceNow > 7 * 86400 }) ?? true else { continue }
            System.run("/usr/bin/curl", ["-sfL", "-m", "10", "-o", pr.avatarFile.path, pr.avatarURL], timeout: 12, usePath: false)
        }
    }
}

// CPU, memory, disk, battery and network. Used on WidgetFeed's queue only; it keeps the
// counters that CPU load and network speed are worked out from between samples.
final class SystemSampler: @unchecked Sendable {
    private let host = mach_host_self()
    private var cpuTicks: (busy: UInt64, total: UInt64)?
    private var bytes: (iface: String, rx: UInt64, tx: UInt64, at: Date)?
    private var down: [Double] = []
    private var up: [Double] = []
    private var wan: (ip: String?, at: Date)?
    private var names: [String: String] = [:]
    private lazy var model = Self.modelName()
    private lazy var chip = Self.sysctl("machdep.cpu.brand_string").replacingOccurrences(of: "Apple ", with: "")
    private lazy var bootedAt: Date = {
        var tv = timeval()
        var size = MemoryLayout<timeval>.size
        sysctlbyname("kern.boottime", &tv, &size, nil, 0)
        return Date(timeIntervalSince1970: TimeInterval(tv.tv_sec))
    }()

    func sample() -> SystemSnapshot {
        let now = Date()
        let iface = primaryInterface()
        var lan: String?
        var rate = (down: 0.0, up: 0.0)
        if let iface {
            let info = interface(iface)
            lan = info.lan
            if let b = bytes, b.iface == iface, now > b.at {
                let dt = now.timeIntervalSince(b.at)
                rate = (Double(Self.delta(info.rx, b.rx)) / dt, Double(Self.delta(info.tx, b.tx)) / dt)
            }
            bytes = (iface, info.rx, info.tx, now)
        }
        down = Array((down + [rate.down]).suffix(40))
        up = Array((up + [rate.up]).suffix(40))
        if iface != nil, now.timeIntervalSince(wan?.at ?? .distantPast) > 600 {
            wan = (System.run("/usr/bin/curl", ["-s", "-m", "3", "https://api.ipify.org"], timeout: 4, usePath: false), now)
        }
        let ping = iface == nil ? nil : System.run("/sbin/ping", ["-c1", "-t1", "1.1.1.1"], timeout: 2, usePath: false).flatMap(SystemSnapshot.pingTime)
        let disk = try? URL(fileURLWithPath: "/").resourceValues(forKeys: [.volumeTotalCapacityKey, .volumeAvailableCapacityForImportantUsageKey])
        let total = Int64(disk?.volumeTotalCapacity ?? 0)
        let free = disk?.volumeAvailableCapacityForImportantUsage ?? 0
        let power = battery()
        return SystemSnapshot(at: now, model: model, chip: chip, bootedAt: bootedAt, cpu: cpu(), memory: memory(),
                              diskUsed: total > 0 ? Int((total - free) * 100 / total) : 0, diskFree: free,
                              battery: power.percent, charging: power.charging, remaining: power.remaining,
                              network: iface.map(displayName), ping: ping, lan: lan, wan: iface == nil ? nil : wan?.ip, down: down, up: up)
    }

    // Busy share of all CPU ticks since the last sample (since boot on the first).
    private func cpu() -> Int {
        var info = host_cpu_load_info()
        var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info>.stride / MemoryLayout<integer_t>.stride)
        let ok = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics(host, HOST_CPU_LOAD_INFO, $0, &count) }
        }
        guard ok == KERN_SUCCESS else { return 0 }
        let t = info.cpu_ticks // user, system, idle, nice
        let busy = UInt64(t.0) + UInt64(t.1) + UInt64(t.3)
        let total = busy + UInt64(t.2)
        let prev = cpuTicks ?? (0, 0)
        cpuTicks = (busy, total)
        guard total > prev.total else { return 0 }
        return Int((Double(busy - prev.busy) * 100 / Double(total - prev.total)).rounded())
    }

    // Active + wired + compressed, as Activity Monitor's "Memory Used" counts it.
    private func memory() -> Int {
        var vm = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.stride / MemoryLayout<integer_t>.stride)
        let ok = withUnsafeMutablePointer(to: &vm) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(host, HOST_VM_INFO64, $0, &count) }
        }
        guard ok == KERN_SUCCESS else { return 0 }
        let pages = UInt64(vm.active_count) + UInt64(vm.wire_count) + UInt64(vm.compressor_page_count)
        return Int(pages * UInt64(sysconf(_SC_PAGESIZE)) * 100 / ProcessInfo.processInfo.physicalMemory)
    }

    private func battery() -> (percent: Int?, charging: Bool, remaining: Int?) {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { return (nil, true, nil) }
        for src in list {
            guard let d = IOPSGetPowerSourceDescription(info, src)?.takeUnretainedValue() as? [String: Any],
                  d[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
                  let cur = d[kIOPSCurrentCapacityKey] as? Int, let max = d[kIOPSMaxCapacityKey] as? Int, max > 0 else { continue }
            let ac = d[kIOPSPowerSourceStateKey] as? String == kIOPSACPowerValue
            let mins = d[kIOPSTimeToEmptyKey] as? Int ?? -1
            return (cur * 100 / max, ac, !ac && mins > 0 ? mins : nil)
        }
        return (nil, true, nil)
    }

    private func primaryInterface() -> String? {
        guard let store = SCDynamicStoreCreate(nil, "Termorc" as CFString, nil, nil),
              let v = SCDynamicStoreCopyValue(store, "State:/Network/Global/IPv4" as CFString) as? [String: Any] else { return nil }
        return v["PrimaryInterface"] as? String
    }

    // "en0" → "Wi-Fi", as System Settings › Network names it.
    private func displayName(_ bsd: String) -> String {
        if let name = names[bsd] { return name }
        let all = SCNetworkInterfaceCopyAll() as? [SCNetworkInterface] ?? []
        let name = all.first { SCNetworkInterfaceGetBSDName($0) as String? == bsd }.flatMap { SCNetworkInterfaceGetLocalizedDisplayName($0) as String? } ?? bsd
        names[bsd] = name
        return name
    }

    private func interface(_ name: String) -> (lan: String?, rx: UInt64, tx: UInt64) {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return (nil, 0, 0) }
        defer { freeifaddrs(head) }
        var lan: String?
        var rx: UInt64 = 0, tx: UInt64 = 0
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let ifa = p.pointee
            guard String(cString: ifa.ifa_name) == name, let addr = ifa.ifa_addr else { continue }
            switch Int32(addr.pointee.sa_family) {
            case AF_INET:
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 { lan = String(cString: host) }
            case AF_LINK:
                if let data = ifa.ifa_data?.assumingMemoryBound(to: if_data.self).pointee {
                    rx = UInt64(data.ifi_ibytes)
                    tx = UInt64(data.ifi_obytes)
                }
            default: break
            }
        }
        return (lan, rx, tx)
    }

    // The interface byte counters are 32-bit and wrap at 4 GB.
    private static func delta(_ now: UInt64, _ before: UInt64) -> UInt64 {
        now >= before ? now - before : now + (1 << 32) - before
    }

    private static func sysctl(_ name: String) -> String {
        var size = 0
        sysctlbyname(name, nil, &size, nil, 0)
        var buf = [CChar](repeating: 0, count: max(size, 1))
        sysctlbyname(name, &buf, &size, nil, 0)
        return String(cString: buf)
    }

    // "MacBook Pro", from System Information; falls back to "Mac".
    private static func modelName() -> String {
        guard let out = System.run("/usr/sbin/system_profiler", ["SPHardwareDataType", "-json"], timeout: 10, usePath: false),
              let json = try? JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any],
              let hw = (json["SPHardwareDataType"] as? [[String: Any]])?.first,
              let name = hw["machine_name"] as? String else { return "Mac" }
        return name
    }
}
