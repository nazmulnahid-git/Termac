// Git and GitHub behind the code review panel: where the branch stands, its history, the
// pull request, and the actions the panel offers (commit, push, stage a hunk, open a PR…).
use crate::system::{gh_bin, run, run_full, Output, PRS};
use serde::Deserialize;
use serde_json::{json, Value};

const NET: u64 = 120_000;

async fn git(root: &str, args: &[&str]) -> Option<String> {
    let mut all = vec!["-C", root];
    all.extend_from_slice(args);
    run("git", &all, 8000, None, false).await
}

async fn git_full(root: &str, args: &[&str], timeout: u64, stdin: Option<&str>) -> Output {
    let mut all = vec!["-C", root];
    all.extend_from_slice(args);
    run_full("git", &all, timeout, None, stdin).await
}

fn result(o: Output) -> Value {
    let error = if o.err.is_empty() { o.out.trim().to_string() } else { o.err.clone() };
    json!({ "ok": o.ok, "output": o.out.trim(), "error": if o.ok { Value::Null } else { json!(error) } })
}

fn fail(msg: &str) -> Value {
    json!({ "ok": false, "output": "", "error": msg })
}

// git@github.com:me/repo.git, ssh://git@github.com/me/repo, https://github.com/me/repo.git → https://github.com/me/repo
pub fn web_url(remote: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    let (host, path) = if let Some(rest) = r.strip_prefix("git@") {
        rest.split_once(':')?
    } else if let Some(rest) = r.strip_prefix("ssh://") {
        let rest = rest.split_once('@').map_or(rest, |(_, h)| h);
        rest.split_once('/')?
    } else if let Some(rest) = r.strip_prefix("https://").or_else(|| r.strip_prefix("http://")) {
        let rest = rest.split_once('@').map_or(rest, |(_, h)| h);
        rest.split_once('/')?
    } else {
        return None;
    };
    let host = host.split(':').next()?;
    Some(format!("https://{host}/{path}"))
}

async fn remote_name(root: &str) -> Option<String> {
    let remotes = git(root, &["remote"]).await?;
    let list: Vec<&str> = remotes.lines().collect();
    list.iter().find(|r| **r == "origin").or(list.first()).map(|r| r.to_string())
}

async fn upstream(root: &str) -> Option<String> {
    git(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await
}

// Where the branch stands: name, upstream, ahead/behind, remote and the default branch.
pub async fn overview(root: &str) -> Value {
    let (branch, up, remote, head) = tokio::join!(
        git(root, &["rev-parse", "--abbrev-ref", "HEAD"]),
        upstream(root),
        remote_name(root),
        git(root, &["log", "-1", "--format=%h%x1f%s"]),
    );
    let (mut ahead, mut behind) = (0, 0);
    if up.is_some() {
        if let Some(counts) = git(root, &["rev-list", "--left-right", "--count", "HEAD...@{u}"]).await {
            let mut it = counts.split_whitespace().map(|n| n.parse::<u64>().unwrap_or(0));
            ahead = it.next().unwrap_or(0);
            behind = it.next().unwrap_or(0);
        }
    } else if let Some(n) = git(root, &["rev-list", "--count", "HEAD", "--not", "--remotes"]).await {
        ahead = n.parse().unwrap_or(0);
    }
    let mut web = None;
    let mut default_branch = None;
    if let Some(r) = &remote {
        web = git(root, &["remote", "get-url", r]).await.and_then(|u| web_url(&u));
        default_branch = git(root, &["symbolic-ref", "--short", &format!("refs/remotes/{r}/HEAD")])
            .await
            .map(|b| b.strip_prefix(&format!("{r}/")).unwrap_or(&b).to_string());
    }
    if default_branch.is_none() {
        for b in ["main", "master"] {
            if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{b}")]).await.is_some() {
                default_branch = Some(b.into());
                break;
            }
        }
    }
    let head = head.map(|h| {
        let (short, subject) = h.split_once('\x1f').unwrap_or((&h, ""));
        json!({ "short": short, "subject": subject })
    });
    let branch = branch.unwrap_or_default();
    json!({
        "branch": branch, "detached": branch == "HEAD", "upstream": up, "ahead": ahead, "behind": behind,
        "remote": remote, "webUrl": web, "defaultBranch": default_branch, "head": head,
    })
}

// Recent commits on HEAD, each marked with whether it has reached the remote yet.
pub async fn log(root: &str, limit: u32) -> Value {
    let n = format!("-n{}", limit.clamp(1, 500));
    let args = ["log", &n, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1f%D%x1e"];
    let (out, up) = tokio::join!(git(root, &args), upstream(root));
    let unpushed: std::collections::HashSet<String> = match up {
        Some(_) => git(root, &["rev-list", "@{u}..HEAD"]).await,
        None => git(root, &["rev-list", "HEAD", "--not", "--remotes"]).await,
    }
    .unwrap_or_default()
    .lines()
    .map(str::to_string)
    .collect();
    let commits: Vec<Value> = out
        .unwrap_or_default()
        .split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim().split('\x1f').collect();
            (f.len() >= 6).then(|| {
                json!({
                    "sha": f[0], "short": f[1], "subject": f[2], "author": f[3],
                    "time": f[4].parse::<u64>().unwrap_or(0) * 1000, "refs": f[5], "pushed": !unpushed.contains(f[0]),
                })
            })
        })
        .collect();
    json!(commits)
}

// One commit: its full message and patch.
pub async fn show(root: &str, sha: &str) -> Value {
    let msg_args = ["log", "-1", "--format=%B", sha];
    let show_args = ["show", "--format=", "--patch", "-M", "--no-color", sha];
    let (msg, patch) = tokio::join!(git(root, &msg_args), git_full(root, &show_args, 10_000, None));
    json!({ "message": msg.unwrap_or_default(), "patch": patch.out })
}

pub async fn remote_branches(root: &str) -> Vec<String> {
    let Some(remote) = remote_name(root).await else { return vec![] };
    let prefix = format!("{remote}/");
    let out = git(root, &["for-each-ref", "--format=%(refname:short)", &format!("refs/remotes/{remote}")]).await.unwrap_or_default();
    out.lines().filter_map(|l| l.strip_prefix(&prefix)).filter(|b| *b != "HEAD").map(str::to_string).collect()
}

// The open PR for the current branch, with its checks folded into counts.
pub async fn pr(root: &str) -> Value {
    let fields = "number,url,state,title,isDraft,reviewDecision,statusCheckRollup,baseRefName,headRefName,additions,deletions,changedFiles,mergeable,comments";
    let o = run_full(gh_bin(), &["pr", "view", "--json", fields], 15_000, Some(root), None).await;
    if !o.ok {
        let e = o.err.to_lowercase();
        if e.starts_with("couldn't run") {
            return json!({ "gh": false });
        }
        if e.contains("no pull requests found") || e.contains("no open pull requests") {
            return json!({ "gh": true, "pr": null });
        }
        return json!({ "gh": true, "pr": null, "error": o.err });
    }
    let Ok(mut pr) = serde_json::from_str::<Value>(&o.out) else { return json!({ "gh": true, "pr": null }) };
    let (mut passed, mut failed, mut pending) = (0, 0, 0);
    let mut checks = Vec::new();
    for c in pr["statusCheckRollup"].as_array().cloned().unwrap_or_default() {
        let name = c["name"].as_str().or(c["context"].as_str()).unwrap_or("check").to_string();
        let verdict = c["conclusion"].as_str().filter(|s| !s.is_empty()).or(c["state"].as_str()).unwrap_or("");
        let state = match verdict {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => "pass",
            "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => "fail",
            _ => "pending",
        };
        match state {
            "pass" => passed += 1,
            "fail" => failed += 1,
            _ => pending += 1,
        }
        checks.push(json!({ "name": name, "state": state, "url": c["detailsUrl"].as_str().or(c["targetUrl"].as_str()) }));
    }
    pr["checks"] = json!({ "passed": passed, "failed": failed, "pending": pending, "list": checks });
    pr["comments"] = json!(pr["comments"].as_array().map_or(0, Vec::len));
    pr.as_object_mut().map(|m| m.remove("statusCheckRollup"));
    json!({ "gh": true, "pr": pr })
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum GitOp {
    Commit {
        message: String,
        #[serde(default)]
        amend: bool,
        #[serde(default)]
        all: bool,
    },
    Push {
        #[serde(default)]
        force: bool,
    },
    Pull,
    Fetch,
    // Stage, unstage or discard one hunk: a patch built from the diff the panel shows.
    Apply {
        patch: String,
        #[serde(default)]
        cached: bool,
        #[serde(default)]
        reverse: bool,
    },
    StageAll {
        stage: bool,
    },
    DiscardAll {
        #[serde(default)]
        untracked: Vec<String>,
    },
    Switch {
        branch: String,
        #[serde(default)]
        create: bool,
    },
    UndoCommit,
    PrCreate {
        title: String,
        #[serde(default)]
        body: String,
        base: Option<String>,
        #[serde(default)]
        draft: bool,
    },
    PrComment {
        body: String,
    },
    PrReady,
    PrMerge {
        method: String,
    },
}

async fn push(root: &str, force: bool) -> Output {
    if upstream(root).await.is_some() {
        let args: &[&str] = if force { &["push", "--force-with-lease"] } else { &["push"] };
        return git_full(root, args, NET, None).await;
    }
    let Some(remote) = remote_name(root).await else {
        return Output { ok: false, out: String::new(), err: "This repository has no remote to push to.".into() };
    };
    git_full(root, &["push", "-u", &remote, "HEAD"], NET, None).await
}

pub async fn op(root: &str, op: GitOp) -> Value {
    let forget_pr = || PRS.lock().unwrap().retain(|k, _| !k.starts_with(root));
    match op {
        GitOp::Commit { message, amend, all } => {
            if all {
                let added = git_full(root, &["add", "-A"], 20_000, None).await;
                if !added.ok {
                    return result(added);
                }
            }
            let mut args = vec!["commit"];
            if amend {
                args.push("--amend");
            }
            let message = message.trim();
            if message.is_empty() {
                if !amend {
                    return fail("Write a commit message first.");
                }
                args.push("--no-edit");
                result(git_full(root, &args, 60_000, None).await)
            } else {
                args.extend(["-F", "-"]);
                result(git_full(root, &args, 60_000, Some(message)).await)
            }
        }
        GitOp::Push { force } => result(push(root, force).await),
        GitOp::Pull => result(git_full(root, &["pull"], NET, None).await),
        GitOp::Fetch => result(git_full(root, &["fetch", "--prune"], NET, None).await),
        GitOp::Apply { patch, cached, reverse } => {
            let mut args = vec!["apply", "--whitespace=nowarn", "--recount"];
            if cached {
                args.push("--cached");
            }
            if reverse {
                args.push("--reverse");
            }
            args.push("-");
            result(git_full(root, &args, 20_000, Some(&patch)).await)
        }
        GitOp::StageAll { stage } => {
            let args: &[&str] = if stage { &["add", "-A"] } else { &["reset", "-q"] };
            result(git_full(root, args, 20_000, None).await)
        }
        GitOp::DiscardAll { untracked } => {
            let restored = git_full(root, &["restore", "--worktree", "--", "."], 20_000, None).await;
            if !restored.ok && !restored.err.contains("did not match any file") {
                return result(restored);
            }
            if untracked.is_empty() {
                return result(Output { ok: true, out: String::new(), err: String::new() });
            }
            let mut args = vec!["clean", "-f", "--"];
            args.extend(untracked.iter().map(String::as_str));
            result(git_full(root, &args, 20_000, None).await)
        }
        GitOp::Switch { branch, create } => {
            forget_pr();
            let args: Vec<&str> = if create { vec!["switch", "-c", &branch] } else { vec!["switch", &branch] };
            result(git_full(root, &args, 30_000, None).await)
        }
        GitOp::UndoCommit => result(git_full(root, &["reset", "--soft", "HEAD~1"], 20_000, None).await),
        GitOp::PrCreate { title, body, base, draft } => {
            // gh can't open a PR for a branch the remote hasn't seen; push it first.
            let pushed = push(root, false).await;
            if !pushed.ok && !pushed.err.contains("Everything up-to-date") {
                return result(pushed);
            }
            let mut args = vec!["pr", "create", "--title", &title, "--body-file", "-"];
            if let Some(b) = base.as_deref().filter(|b| !b.is_empty()) {
                args.extend(["--base", b]);
            }
            if draft {
                args.push("--draft");
            }
            forget_pr();
            result(run_full(gh_bin(), &args, NET, Some(root), Some(&body)).await)
        }
        GitOp::PrComment { body } => result(run_full(gh_bin(), &["pr", "comment", "--body-file", "-"], NET, Some(root), Some(&body)).await),
        GitOp::PrReady => {
            forget_pr();
            result(run_full(gh_bin(), &["pr", "ready"], NET, Some(root), None).await)
        }
        GitOp::PrMerge { method } => {
            let flag = match method.as_str() {
                "merge" => "--merge",
                "rebase" => "--rebase",
                _ => "--squash",
            };
            forget_pr();
            result(run_full(gh_bin(), &["pr", "merge", flag], NET, Some(root), None).await)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_urls_become_web_urls() {
        assert_eq!(web_url("git@github.com:me/repo.git").as_deref(), Some("https://github.com/me/repo"));
        assert_eq!(web_url("https://github.com/me/repo.git").as_deref(), Some("https://github.com/me/repo"));
        assert_eq!(web_url("ssh://git@github.com:22/me/repo").as_deref(), Some("https://github.com/me/repo"));
        assert_eq!(web_url("https://token@gitlab.com/g/sub/repo").as_deref(), Some("https://gitlab.com/g/sub/repo"));
        assert_eq!(web_url("/local/path"), None);
    }

    #[tokio::test]
    async fn commit_hunk_staging_and_undo() {
        let dir = std::env::temp_dir().join(format!("termorc-review-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().into_owned();
        let sh = |args: &[&str]| std::process::Command::new("git").arg("-C").arg(&d).args(args).output().unwrap();
        sh(&["init", "-q", "-b", "main"]);
        sh(&["config", "user.email", "t@t"]);
        sh(&["config", "user.name", "t"]);
        let body: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        std::fs::write(dir.join("f.txt"), &body).unwrap();
        let r = op(&d, GitOp::Commit { message: "init".into(), amend: false, all: true }).await;
        assert_eq!(r["ok"], true, "{r}");

        // Two edits far apart make two hunks; stage only the first.
        std::fs::write(dir.join("f.txt"), body.replace("line 2\n", "line two\n").replace("line 29\n", "line twenty-nine\n")).unwrap();
        let diff = String::from_utf8(sh(&["diff", "--no-color", "-U3"]).stdout).unwrap();
        let head: String = diff.lines().take_while(|l| !l.starts_with("@@")).map(|l| format!("{l}\n")).collect();
        let first: String = diff.lines().skip_while(|l| !l.starts_with("@@")).enumerate().take_while(|(i, l)| *i == 0 || !l.starts_with("@@")).map(|(_, l)| format!("{l}\n")).collect();
        let r = op(&d, GitOp::Apply { patch: format!("{head}{first}"), cached: true, reverse: false }).await;
        assert_eq!(r["ok"], true, "{r}");
        let staged = String::from_utf8(sh(&["diff", "--cached"]).stdout).unwrap();
        assert!(staged.contains("+line two") && !staged.contains("twenty-nine"));

        let r = op(&d, GitOp::Commit { message: "first hunk\n\nwith a body".into(), amend: false, all: false }).await;
        assert_eq!(r["ok"], true, "{r}");
        let commits = log(&d, 10).await;
        assert_eq!(commits[0]["subject"], "first hunk");
        assert_eq!(commits[0]["pushed"], false);
        assert_eq!(overview(&d).await["ahead"], 2);
        assert!(show(&d, commits[0]["sha"].as_str().unwrap()).await["patch"].as_str().unwrap().contains("+line two"));

        assert_eq!(op(&d, GitOp::UndoCommit).await["ok"], true);
        assert_eq!(log(&d, 10).await.as_array().unwrap().len(), 1);
        assert_eq!(op(&d, GitOp::Commit { message: " ".into(), amend: false, all: false }).await["ok"], false);
        let r = op(&d, GitOp::Push { force: false }).await;
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("no remote"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
