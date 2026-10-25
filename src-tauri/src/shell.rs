// What the input bar (src/components/Composer.jsx) needs from the system: the user's shell
// history to recall and suggest from, and Tab completion for commands, paths and branches.
use crate::system::{home, login_path, run};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

const HISTORY_MAX: usize = 5000;
const COMPLETIONS_MAX: usize = 200;

// zsh (plain or extended ": 1700000000:0;cmd"), bash and fish histories, newest first, deduped.
pub fn history() -> Vec<String> {
    let h = home();
    let mut entries: Vec<(u64, usize, String)> = Vec::new();
    let mut order = 0usize;
    let mut push = |time: u64, cmd: String, entries: &mut Vec<(u64, usize, String)>| {
        let cmd = cmd.trim().to_string();
        if !cmd.is_empty() {
            order += 1;
            entries.push((time, order, cmd));
        }
    };
    let zsh = std::env::var("HISTFILE").ok().map(PathBuf::from).filter(|p| p.exists()).unwrap_or_else(|| h.join(".zsh_history"));
    if let Ok(bytes) = std::fs::read(&zsh) {
        let text = String::from_utf8_lossy(&bytes);
        let mut pending: Option<(u64, String)> = None;
        for line in text.lines() {
            if let Some((t, mut cmd)) = pending.take() {
                cmd.push('\n');
                cmd.push_str(line.trim_end_matches('\\'));
                if line.ends_with('\\') {
                    pending = Some((t, cmd));
                } else {
                    push(t, cmd, &mut entries);
                }
                continue;
            }
            let (time, cmd) = match line.strip_prefix(": ").and_then(|r| r.split_once(';')) {
                Some((meta, cmd)) => (meta.split(':').next().and_then(|t| t.parse().ok()).unwrap_or(0), cmd),
                None => (0, line),
            };
            if let Some(stripped) = cmd.strip_suffix('\\') {
                pending = Some((time, stripped.to_string()));
            } else {
                push(time, cmd.to_string(), &mut entries);
            }
        }
    }
    if let Ok(text) = std::fs::read_to_string(h.join(".bash_history")) {
        for line in text.lines().filter(|l| !l.starts_with('#')) {
            push(0, line.to_string(), &mut entries);
        }
    }
    if let Ok(text) = std::fs::read_to_string(h.join(".local/share/fish/fish_history")) {
        let mut cmd = None;
        for line in text.lines() {
            if let Some(c) = line.strip_prefix("- cmd: ") {
                cmd = Some(c.replace("\\n", "\n").replace("\\\\", "\\"));
            } else if let (Some(t), Some(c)) = (line.trim().strip_prefix("when: "), cmd.take()) {
                push(t.parse().unwrap_or(0), c, &mut entries);
            }
        }
    }
    // Timestamps where the file has them, otherwise file order; newest first.
    entries.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut seen = HashSet::new();
    entries.into_iter().map(|e| e.2).filter(|c| seen.insert(c.clone())).take(HISTORY_MAX).collect()
}

const BUILTINS: [&str; 24] = [
    "alias", "bg", "builtin", "cd", "command", "echo", "eval", "exec", "exit", "export", "fg", "history", "jobs", "kill", "popd", "printf", "pushd",
    "pwd", "read", "set", "source", "type", "unset", "which",
];

static COMMANDS: LazyLock<Vec<String>> = LazyLock::new(|| {
    let path = login_path().map(str::to_string).or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
    let mut names: HashSet<String> = BUILTINS.iter().map(|s| s.to_string()).collect();
    for dir in path.split(':').filter(|d| !d.is_empty()) {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            use std::os::unix::fs::PermissionsExt;
            let executable = e.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
            if executable {
                names.insert(e.file_name().to_string_lossy().into_owned());
            }
        }
    }
    let mut v: Vec<String> = names.into_iter().collect();
    v.sort();
    v
});

fn escape(name: &str) -> String {
    name.chars().fold(String::new(), |mut s, c| {
        if " '\"\\$`!&;|()<>*?[]{}#".contains(c) {
            s.push('\\');
        }
        s.push(c);
        s
    })
}

// Completions for the word under the cursor at the end of `line`: where that word starts
// (a char index, for the input bar to replace from) and the candidates.
pub async fn complete(cwd: &str, line: &str) -> Value {
    let chars: Vec<char> = line.chars().collect();
    let mut start = chars.len();
    while start > 0 && !(chars[start - 1].is_whitespace() && (start < 2 || chars[start - 2] != '\\')) {
        start -= 1;
    }
    let word: String = chars[start..].iter().collect::<String>().replace("\\ ", " ");
    let before: String = chars[..start].iter().collect();
    let first_word = before.split(|c: char| c == '|' || c == ';' || c == '&').next_back().unwrap_or("").trim().is_empty();
    let mut items: Vec<Value> = Vec::new();

    if first_word && !word.contains('/') && !word.starts_with('.') && !word.starts_with('~') {
        items.extend(COMMANDS.iter().filter(|c| c.starts_with(&word)).take(COMPLETIONS_MAX).map(|c| json!({ "value": c, "kind": "cmd" })));
        return json!({ "start": start, "items": items });
    }

    let words: Vec<&str> = before.split_whitespace().collect();
    if words.first() == Some(&"git") && matches!(words.get(1), Some(&("checkout" | "switch" | "merge" | "rebase" | "branch" | "push" | "pull" | "log" | "diff" | "reset"))) && !word.starts_with('-') {
        let out = run("git", &["-C", cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], 3000, None, false).await.unwrap_or_default();
        items.extend(out.lines().filter(|b| b.starts_with(&word) && !b.ends_with("/HEAD")).take(60).map(|b| json!({ "value": b, "kind": "branch" })));
    }

    // Paths: "~/" and absolute paths as typed, everything else relative to the session's cwd.
    let (dir_part, base) = match word.rfind('/') {
        Some(i) => (&word[..=i], &word[i + 1..]),
        None => ("", word.as_str()),
    };
    let dir: PathBuf = if let Some(rest) = dir_part.strip_prefix("~/") {
        home().join(rest)
    } else if dir_part == "~" {
        home()
    } else if dir_part.starts_with('/') {
        PathBuf::from(dir_part)
    } else {
        Path::new(cwd).join(dir_part)
    };
    if let Ok(rd) = std::fs::read_dir(&dir) {
        let mut entries: Vec<(bool, String)> = rd
            .flatten()
            .map(|e| (e.path().is_dir(), e.file_name().to_string_lossy().into_owned()))
            .filter(|(_, n)| n.starts_with(base) && (base.starts_with('.') || !n.starts_with('.')))
            .collect();
        entries.sort_by(|a, b| crate::system::natural_cmp(&a.1, &b.1));
        for (is_dir, name) in entries.into_iter().take(COMPLETIONS_MAX) {
            let value = format!("{}{}{}", escape(dir_part), escape(&name), if is_dir { "/" } else { "" });
            items.push(json!({ "value": value, "label": name, "kind": if is_dir { "dir" } else { "file" } }));
        }
    }
    json!({ "start": start, "items": items })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn completes_commands_paths_and_escapes() {
        let dir = std::env::temp_dir().join(format!("termorc-complete-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src dir")).unwrap();
        std::fs::write(dir.join("readme.md"), "").unwrap();
        let d = dir.to_string_lossy().into_owned();

        let r = complete(&d, "ech").await;
        assert_eq!(r["start"], 0);
        assert!(r["items"].as_array().unwrap().iter().any(|i| i["value"] == "echo"));

        let r = complete(&d, "cat src").await;
        assert_eq!(r["start"], 4);
        assert_eq!(r["items"][0]["value"], "src\\ dir/");

        let r = complete(&d, "ls -la re").await;
        assert_eq!(r["items"][0]["value"], "readme.md");
        assert_eq!(r["items"][0]["kind"], "file");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
