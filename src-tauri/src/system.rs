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
}
