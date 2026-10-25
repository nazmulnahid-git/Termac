// macOS / filesystem lookups used by the UI. Everything here is cheap or cached.
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::process::Command;

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
}

// Apps opened from Finder get launchd's bare PATH; git hooks (husky, lint-staged) and gh
// expect the one the user's login shell sets up, so read it once and hand it to children.
static LOGIN_PATH: LazyLock<Option<String>> = LazyLock::new(|| {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = std::process::Command::new(shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    while child.try_wait().ok()?.is_none() {
        if start.elapsed() > Duration::from_secs(4) {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let out = child.wait_with_output().ok()?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
});

pub fn login_path() -> Option<&'static str> {
    LOGIN_PATH.as_deref()
}

// Starts the login-shell PATH lookup early so the first git action doesn't wait for it.
pub fn warm_login_path() {
    std::thread::spawn(|| LazyLock::force(&LOGIN_PATH));
}

fn command(cmd: &str, args: &[&str], cwd: Option<&str>) -> Command {
    let mut c = Command::new(cmd);
    c.args(args).kill_on_drop(true);
    if let Some(path) = LOGIN_PATH.as_deref() {
        c.env("PATH", path);
    }
    // Never sit waiting on a credentials prompt nobody can see.
    c.env("GIT_TERMINAL_PROMPT", "0").env("GH_PROMPT_DISABLED", "1").env("GIT_EDITOR", "true");
    if let Some(dir) = cwd {
        c.current_dir(dir);
    }
    c
}

// Runs a command and returns its stdout, or None if it failed, timed out or exited non-zero.
pub async fn run(cmd: &str, args: &[&str], timeout_ms: u64, cwd: Option<&str>, raw: bool) -> Option<String> {
    let mut c = command(cmd, args, cwd);
    c.stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(Duration::from_millis(timeout_ms), c.output()).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    Some(if raw { text } else { text.trim().to_string() })
}

pub struct Output {
    pub ok: bool,
    pub out: String,
    pub err: String,
}

// Like run(), but keeps stderr for the UI to show and can feed stdin.
pub async fn run_full(cmd: &str, args: &[&str], timeout_ms: u64, cwd: Option<&str>, stdin: Option<&str>) -> Output {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let mut c = command(cmd, args, cwd);
    c.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let fail = |err: String| Output { ok: false, out: String::new(), err };
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => return fail(format!("Couldn't run {cmd}: {e}")),
    };
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let _ = pipe.write_all(text.as_bytes()).await;
    }
    match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output()).await {
        Err(_) => fail(format!("{cmd} timed out")),
        Ok(Err(e)) => fail(e.to_string()),
        Ok(Ok(o)) => Output {
            ok: o.status.success(),
            out: String::from_utf8_lossy(&o.stdout).into_owned(),
            err: String::from_utf8_lossy(&o.stderr).trim().to_string(),
        },
    }
}

pub fn gh_bin() -> &'static str {
    if LOGIN_PATH.is_some() {
        return "gh";
    }
    ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].into_iter().find(|p| Path::new(p).exists()).unwrap_or("gh")
}

// Like Finder: case-insensitive, with digit runs compared by value ("file2" < "file10").
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut s = String::new();
                    while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
                        s.push(c);
                        it.next();
                    }
                    s
                };
                let (na, nb) = (take(&mut a), take(&mut b));
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                let ord = x.to_lowercase().cmp(y.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                a.next();
                b.next();
            }
        }
    }
}

// ---- SSH hosts -------------------------------------------------------------------------
fn glob_to_regex(glob: &str) -> regex::Regex {
    let mut re = String::from("^");
    for c in glob.chars() {
        match c {
            '*' => re.push_str(".*"),
            '?' => re.push('.'),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
    }
    re.push('$');
    regex::Regex::new(&re).unwrap_or_else(|_| regex::Regex::new("^$").unwrap())
}

fn read_ssh_config(file: &Path, seen: &mut HashSet<PathBuf>) -> Vec<Value> {
    if !seen.insert(file.to_path_buf()) {
        return vec![];
    }
    let text = std::fs::read_to_string(file).unwrap_or_default();
    let home = home();
    let line_re = regex::Regex::new(r"^(\S+)\s*=?\s*(.+)$").unwrap();
    let mut hosts: Vec<Value> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(m) = line_re.captures(line) else { continue };
        let key = m[1].to_lowercase();
        let val = m[2].trim();
        match key.as_str() {
            "include" => {
                for pattern in val.split_whitespace() {
                    let abs = if let Some(rest) = pattern.strip_prefix('~') {
                        home.join(rest.trim_start_matches('/'))
                    } else if pattern.starts_with('/') {
                        PathBuf::from(pattern)
                    } else {
                        home.join(".ssh").join(pattern)
                    };
                    let dir = abs.parent().map(Path::to_path_buf).unwrap_or_default();
                    let re = glob_to_regex(&abs.file_name().map_or(String::new(), |n| n.to_string_lossy().into_owned()));
                    let Ok(names) = std::fs::read_dir(&dir) else { continue };
                    let mut names: Vec<String> = names.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                    names.sort();
                    for n in names.into_iter().filter(|n| re.is_match(n)) {
                        hosts.extend(read_ssh_config(&dir.join(n), seen));
                    }
                }
            }
            "host" => {
                current.clear();
                for alias in val.split_whitespace().filter(|h| !h.contains(['*', '?', '!'])) {
                    current.push(hosts.len());
                    hosts.push(json!({ "alias": alias, "hostname": "", "user": "" }));
                }
            }
            "hostname" | "user" => {
                for &i in &current {
                    hosts[i][key.as_str()] = json!(val);
                }
            }
            _ => {}
        }
    }
    hosts
}

pub fn ssh_hosts() -> Vec<Value> {
    let hosts = read_ssh_config(&home().join(".ssh/config"), &mut HashSet::new());
    let mut seen = HashSet::new();
    hosts.into_iter().filter(|h| seen.insert(h["alias"].as_str().unwrap_or_default().to_string())).collect()
}

// ---- Git -------------------------------------------------------------------------------
static BRANCHES: LazyLock<Mutex<HashMap<String, (Instant, Option<String>)>>> = LazyLock::new(Default::default);

pub fn git_branch(cwd: &str) -> Option<String> {
    if cwd.is_empty() {
        return None;
    }
    if let Some((at, b)) = BRANCHES.lock().unwrap().get(cwd) {
        if at.elapsed() < Duration::from_millis(1500) {
            return b.clone();
        }
    }
    let mut branch = None;
    let mut dir = PathBuf::from(cwd);
    for _ in 0..40 {
        let dotgit = dir.join(".git");
        let gitdir = if dotgit.is_file() {
            std::fs::read_to_string(&dotgit)
                .ok()
                .and_then(|t| t.lines().find_map(|l| l.trim().strip_prefix("gitdir:").map(|p| dir.join(p.trim()))))
                .unwrap_or(dotgit.clone())
        } else {
            dotgit.clone()
        };
        if let Ok(head) = std::fs::read_to_string(gitdir.join("HEAD")) {
            let head = head.trim();
            branch = Some(match head.strip_prefix("ref: ") {
                Some(r) => r.strip_prefix("refs/heads/").unwrap_or(r).to_string(),
                None => head.chars().take(7).collect(),
            });
            break;
        }
        if !dir.pop() {
            break;
        }
    }
    let mut cache = BRANCHES.lock().unwrap();
    if cache.len() > 500 {
        cache.clear();
    }
    cache.insert(cwd.to_string(), (Instant::now(), branch.clone()));
    branch
}

// Changed-file count for the working tree (null outside a repo).
pub async fn git_status(cwd: &str) -> Value {
    if cwd.is_empty() {
        return Value::Null;
    }
    match run("git", &["-C", cwd, "status", "--porcelain=v1"], 3000, None, false).await {
        None => Value::Null,
        Some(out) => json!({ "changes": if out.is_empty() { 0 } else { out.lines().count() } }),
    }
}

// Local branches, most recently committed first.
pub async fn git_branches(cwd: &str) -> Vec<String> {
    if cwd.is_empty() {
        return vec![];
    }
    let args = ["-C", cwd, "for-each-ref", "--sort=-committerdate", "--count=80", "--format=%(refname:short)", "refs/heads"];
    run("git", &args, 3000, None, false).await.filter(|o| !o.is_empty()).map_or(vec![], |o| o.lines().map(str::to_string).collect())
}

// Open PR for the branch via the GitHub CLI, if it's installed and signed in. Cached: it hits
// the network.
pub static PRS: LazyLock<Mutex<HashMap<String, (Instant, Value)>>> = LazyLock::new(Default::default);

pub async fn git_pr(cwd: &str, branch: &str) -> Value {
    if cwd.is_empty() || branch.is_empty() {
        return Value::Null;
    }
    let key = format!("{cwd}|{branch}");
    if let Some((at, pr)) = PRS.lock().unwrap().get(&key) {
        if at.elapsed() < Duration::from_secs(300) {
            return pr.clone();
        }
    }
    let gh = gh_bin();
    let out = run(gh, &["pr", "view", "--json", "number,url,state"], 8000, Some(cwd), false).await;
    let pr = out
        .and_then(|o| serde_json::from_str::<Value>(&o).ok())
        .filter(|j| j["number"].as_u64().is_some())
        .map_or(Value::Null, |j| json!({ "number": j["number"], "url": j["url"], "state": j["state"] }));
    let mut cache = PRS.lock().unwrap();
    if cache.len() > 200 {
        cache.clear();
    }
    cache.insert(key, (Instant::now(), pr.clone()));
    pr
}

// Visible subfolders of a directory, for the directory switcher.
pub fn list_dirs(dir: &str) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut names: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort_by(|a, b| natural_cmp(a, b));
    names.truncate(300);
    names
}

// ---- Project explorer, file viewer, code review --------------------------------------
pub async fn git_root(cwd: &str) -> Option<String> {
    if cwd.is_empty() {
        return None;
    }
    run("git", &["-C", cwd, "rev-parse", "--show-toplevel"], 2000, None, false).await
}

// One directory level for the explorer tree: folders first, then files.
pub fn list_dir(dir: &str) -> Value {
    let Ok(rd) = std::fs::read_dir(dir) else { return Value::Null };
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let is_dir = e.file_type().is_ok_and(|t| t.is_dir() || (t.is_symlink() && e.path().is_dir()));
        if is_dir { dirs.push(name) } else { files.push(name) }
    }
    dirs.sort_by(|a, b| natural_cmp(a, b));
    files.sort_by(|a, b| natural_cmp(a, b));
    let out: Vec<Value> = dirs
        .into_iter()
        .map(|n| json!({ "name": n, "dir": true }))
        .chain(files.into_iter().map(|n| json!({ "name": n, "dir": false })))
        .take(2000)
        .collect();
    Value::Array(out)
}

const MAX_VIEW: u64 = 2 << 20;

pub fn read_file(file: &str) -> Value {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(file) else { return json!({ "error": "Not a file" }) };
    if !meta.is_file() {
        return json!({ "error": "Not a file" });
    }
    let mut buf = Vec::new();
    match std::fs::File::open(file).and_then(|f| f.take(MAX_VIEW).read_to_end(&mut buf)) {
        Err(e) => json!({ "error": e.to_string() }),
        Ok(_) => {
            let binary = buf[..buf.len().min(8000)].contains(&0);
            let text = if binary { String::new() } else { String::from_utf8_lossy(&buf).into_owned() };
            json!({ "size": meta.len(), "truncated": meta.len() > MAX_VIEW, "binary": binary, "text": text })
        }
    }
}

// Every file in the project for quick-open: git's view when it's a repo (fast, respects
// .gitignore), otherwise a bounded walk that skips the usual heavy folders.
const SKIP: [&str; 10] = ["node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache", "target", "vendor", ".venv"];

pub async fn project_files(root: &str) -> Vec<String> {
    if let Some(out) = run("git", &["-C", root, "ls-files", "-co", "--exclude-standard"], 5000, None, false).await {
        return if out.is_empty() { vec![] } else { out.lines().take(50000).map(str::to_string).collect() };
    }
    fn walk(root: &Path, rel: &str, depth: usize, files: &mut Vec<String>) {
        if depth > 8 || files.len() >= 20000 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(root.join(rel)) else { return };
        for e in rd.flatten() {
            if files.len() >= 20000 {
                return;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                if !SKIP.contains(&name.as_str()) {
                    walk(root, &r, depth + 1, files);
                }
            } else {
                files.push(r);
            }
        }
    }
    let mut files = Vec::new();
    walk(Path::new(root), "", 0, &mut files);
    files
}

// Changed files with line counts, staged and unstaged parts reported separately like git does.
pub async fn git_changes(cwd: &str) -> Value {
    let Some(root) = git_root(cwd).await else { return Value::Null };
    let status_args = ["-C", &root, "status", "--porcelain=v1", "-z", "--untracked-files=all"];
    let unstaged_args = ["-C", &root, "diff", "--numstat", "-z"];
    let staged_args = ["-C", &root, "diff", "--cached", "--numstat", "-z"];
    let (status, unstaged, staged) = tokio::join!(
        run("git", &status_args, 5000, None, true),
        run("git", &unstaged_args, 5000, None, true),
        run("git", &staged_args, 5000, None, true),
    );
    let counts = |out: Option<String>| {
        let mut m = HashMap::new();
        let out = out.unwrap_or_default();
        let parts: Vec<&str> = out.split('\0').collect();
        let mut i = 0;
        while i < parts.len() {
            let p = parts[i];
            if !p.is_empty() {
                let mut f = p.splitn(3, '\t');
                let (add, del, file) = (f.next().unwrap_or(""), f.next().unwrap_or(""), f.next().unwrap_or(""));
                // Renames come as "add\tdel\t" followed by two NUL-separated paths.
                let name = if file.is_empty() {
                    i += 2;
                    parts.get(i).copied().unwrap_or("")
                } else {
                    file
                };
                let num = |s: &str| if s == "-" { Value::Null } else { s.parse::<u64>().map_or(Value::Null, |n| json!(n)) };
                m.insert(name.to_string(), json!({ "add": num(add), "del": num(del) }));
            }
            i += 1;
        }
        m
    };
    let (u, c) = (counts(unstaged), counts(staged));
    let status = status.unwrap_or_default();
    let parts: Vec<&str> = status.split('\0').collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let p = parts[i];
        if p.len() >= 4 {
            let x = &p[0..1];
            let y = &p[1..2];
            let file = &p[3..];
            let mut from = Value::Null;
            if x == "R" || x == "C" {
                i += 1;
                from = parts.get(i).map_or(Value::Null, |s| json!(s));
            }
            files.push(json!({
                "path": file, "from": from, "x": x, "y": y, "untracked": x == "?",
                "staged": c.get(file).cloned().unwrap_or(Value::Null),
                "unstaged": u.get(file).cloned().unwrap_or(Value::Null),
            }));
        }
        i += 1;
    }
    json!({ "root": root, "files": files })
}

pub async fn git_diff(root: &str, file: &str, staged: bool, untracked: bool) -> Option<String> {
    if untracked {
        // git diff --no-index exits 1 when files differ, so read stdout whatever the status.
        let out = tokio::time::timeout(
            Duration::from_secs(5),
            Command::new("git").args(["-C", root, "diff", "--no-index", "--no-color", "--", "/dev/null", file]).kill_on_drop(true).output(),
        )
        .await;
        return Some(out.ok().and_then(Result::ok).map_or(String::new(), |o| String::from_utf8_lossy(&o.stdout).into_owned()));
    }
    let mut args = vec!["-C", root, "diff", "--no-color", "-U3"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", file]);
    run("git", &args, 5000, None, false).await
}

pub async fn git_stage(root: &str, file: &str, stage: bool) -> bool {
    let args: Vec<&str> = if stage { vec!["-C", root, "add", "--", file] } else { vec!["-C", root, "restore", "--staged", "--", file] };
    run("git", &args, 5000, None, false).await.is_some()
}

pub async fn git_discard(root: &str, file: &str, untracked: bool) -> bool {
    let args: Vec<&str> =
        if untracked { vec!["-C", root, "clean", "-f", "--", file] } else { vec!["-C", root, "restore", "--worktree", "--source=HEAD", "--", file] };
    run("git", &args, 5000, None, false).await.is_some()
}

// Folder of the frontmost Finder window, if Finder is frontmost. No other app is probed.
pub async fn frontmost_folder() -> Option<String> {
    let asn = run("lsappinfo", &["front"], 800, None, false).await.filter(|s| !s.is_empty())?;
    let info = run("lsappinfo", &["info", "-only", "bundleid", &asn], 800, None, false).await?;
    if !info.contains("com.apple.finder") {
        return None;
    }
    let script = r#"tell application "Finder" to if (count of Finder windows) > 0 then get POSIX path of (target of front window as alias)"#;
    run("osascript", &["-e", script], 1500, None, false).await.filter(|s| !s.is_empty())
}

pub fn is_dir(p: &str) -> bool {
    Path::new(p).is_dir()
}

pub async fn detect_imports() -> Value {
    let ssh = ssh_hosts();
    let home = home();
    let mut iterm = Vec::new();
    let plist = home.join("Library/Preferences/com.googlecode.iterm2.plist");
    if plist.exists() {
        let p = plist.to_string_lossy();
        if let Some(Value::Array(list)) =
            run("plutil", &["-extract", "New Bookmarks", "json", "-o", "-", &p], 3000, None, false).await.and_then(|j| serde_json::from_str(&j).ok())
        {
            for b in list {
                let s = |k: &str| b[k].as_str().unwrap_or("").to_string();
                iterm.push(json!({
                    "name": b["Name"].as_str().filter(|n| !n.is_empty()).unwrap_or("iTerm2 profile"),
                    "command": if s("Custom Command") == "Yes" { s("Command") } else { String::new() },
                    "cwd": if s("Custom Directory") == "Yes" { s("Working Directory") } else { String::new() },
                }));
            }
        }
    }
    let names = ["work", "Work", "Projects", "projects", "Developer", "code", "Code", "dev", "src", "repos", "side", "Side", "personal", "Sites"];
    let mut folders: Vec<String> = Vec::new();
    for n in names {
        let p = home.join(n);
        if let Some(real) = p.is_dir().then(|| std::fs::canonicalize(&p).ok()).flatten() {
            let real = real.to_string_lossy().into_owned();
            if !folders.contains(&real) {
                folders.push(real);
            }
        }
    }
    json!({ "ssh": ssh, "iterm": iterm, "folders": folders, "home": home })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order_matches_finder() {
        let mut v = vec!["file10", "File2", "file1", "alpha"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["alpha", "file1", "File2", "file10"]);
    }

    #[tokio::test]
    async fn git_changes_reports_renames_and_untracked() {
        let dir = std::env::temp_dir().join(format!("termorc-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().into_owned();
        let git = |args: &[&str]| std::process::Command::new("git").arg("-C").arg(&d).args(args).output().unwrap();
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "init"]);
        git(&["mv", "a.txt", "b.txt"]);
        std::fs::write(dir.join("b.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(dir.join("new.txt"), "x").unwrap();

        let out = git_changes(&d).await;
        let files = out["files"].as_array().unwrap();
        let renamed = files.iter().find(|f| f["path"] == "b.txt").unwrap();
        assert_eq!(renamed["x"], "R");
        assert_eq!(renamed["from"], "a.txt");
        assert_eq!(renamed["unstaged"]["add"], 1);
        assert!(files.iter().any(|f| f["path"] == "new.txt" && f["untracked"] == true));
        assert!(git_diff(&d, "new.txt", false, true).await.unwrap().contains("+x"));
        assert_eq!(git_branch(&d).as_deref().map(|b| !b.is_empty()), Some(true));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
