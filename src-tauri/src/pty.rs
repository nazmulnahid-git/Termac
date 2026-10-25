// Owns every PTY. Output is coalesced into one message per window every few ms and
// throttled with ack-based flow control so a runaway process can't flood the renderer.
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;

const FLUSH: Duration = Duration::from_millis(4);
// Counted in UTF-16 units, the way the renderer acks (`data.length`).
const HIGH_WATER: usize = 256 * 1024;
const LOW_WATER: usize = 32 * 1024;
const PROC_POLL: Duration = Duration::from_millis(1500);
const PROMPT_MARK: &str = "\x1b]633;A";

#[derive(Deserialize, Default)]
pub struct Profile {
    command: Option<String>,
    env: Option<HashMap<String, Value>>,
    startup: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOpts {
    id: String,
    cwd: Option<String>,
    cols: Option<f64>,
    rows: Option<f64>,
    profile: Option<Profile>,
    space_name: Option<String>,
    initial_command: Option<String>,
    // Termorc draws the prompt and input bar; the shell integration blanks the shell's own.
    own_prompt: Option<bool>,
}

// Lets the reader thread park while the renderer is behind, so the kernel buffer fills
// and the process blocks on write, the same as node-pty's pause().
#[derive(Default)]
struct Gate {
    paused: Mutex<bool>,
    cv: Condvar,
}

impl Gate {
    fn set(&self, paused: bool) {
        *self.paused.lock().unwrap() = paused;
        self.cv.notify_all();
    }
    fn wait_open(&self) {
        let mut p = self.paused.lock().unwrap();
        while *p {
            p = self.cv.wait(p).unwrap();
        }
    }
}

struct Session {
    owner: String,
    shell: String,
    master: Box<dyn MasterPty + Send>,
    input: Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
    unacked: usize,
    paused: bool,
    held: bool,
    proc: String,
    gate: Arc<Gate>,
    integrated: bool,
    pending_command: String,
}

impl Session {
    fn pause(&mut self) {
        if !self.paused {
            self.paused = true;
            self.gate.set(true);
        }
    }
    fn resume(&mut self) {
        if self.paused {
            self.paused = false;
            self.gate.set(false);
        }
    }
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Session>,
    pending: HashMap<String, Vec<String>>,
    channels: HashMap<String, Channel<Value>>,
    flush_scheduled: bool,
}

pub struct PtyHost {
    inner: Mutex<Inner>,
    wake: Condvar,
    integration_dir: PathBuf,
}

fn split_command(cmd: &str) -> Vec<String> {
    let re = regex::Regex::new(r#""([^"]*)"|'([^']*)'|(\S+)"#).unwrap();
    re.captures_iter(cmd)
        .map(|c| c.get(1).or(c.get(2)).or(c.get(3)).map_or(String::new(), |m| m.as_str().to_string()))
        .collect()
}

fn clean_env() -> HashMap<String, String> {
    std::env::vars()
        .filter(|(k, _)| {
            !(k.starts_with("CARGO") || k.starts_with("RUST") || k.starts_with("TAURI_") || k == "TERMORC_DATA_DIR" || k.starts_with("npm_") || k == "NODE_OPTIONS" || k == "__CFBundleIdentifier")
        })
        .collect()
}

fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

// Decodes a read into text, carrying an incomplete UTF-8 sequence over to the next read.
fn decode(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    let mut out = String::with_capacity(carry.len());
    let mut rest: &[u8] = carry;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                rest = &[];
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(std::str::from_utf8(&rest[..valid]).unwrap());
                match e.error_len() {
                    Some(len) => {
                        out.push('\u{FFFD}');
                        rest = &rest[valid + len..];
                    }
                    None => {
                        rest = &rest[valid..];
                        break;
                    }
                }
            }
        }
    }
    let tail = rest.to_vec();
    *carry = tail;
    out
}

fn proc_name(pid: i32) -> Option<String> {
    let mut buf = [0u8; 256];
    let n = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

impl PtyHost {
    pub fn new(integration_dir: PathBuf) -> Arc<Self> {
        let host = Arc::new(PtyHost { inner: Mutex::new(Inner::default()), wake: Condvar::new(), integration_dir });
        let h = host.clone();
        std::thread::spawn(move || loop {
            {
                let mut inner = h.inner.lock().unwrap();
                while !inner.flush_scheduled {
                    inner = h.wake.wait(inner).unwrap();
                }
            }
            std::thread::sleep(FLUSH);
            h.flush();
        });
        let h = host.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(PROC_POLL);
            h.poll_processes();
        });
        host
    }

    // Each window hands over one channel; every PTY message for that window goes through it.
    pub fn attach(&self, owner: &str, channel: Channel<Value>) {
        self.inner.lock().unwrap().channels.insert(owner.to_string(), channel);
    }

    pub fn spawn(self: &Arc<Self>, owner: &str, opts: SpawnOpts) -> Value {
        if self.inner.lock().unwrap().sessions.contains_key(&opts.id) {
            return json!({ "ok": true, "existing": true });
        }
        let profile = opts.profile.unwrap_or_default();
        let space_name = opts.space_name.unwrap_or_default();
        let login_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let command = profile.command.filter(|c| !c.trim().is_empty()).unwrap_or_else(|| format!("{login_shell} -l"));
        let mut parts = split_command(&command);
        if parts.is_empty() {
            parts.push(login_shell.clone());
        }
        let file = parts.remove(0);
        let mut args = parts;
        let shell = Path::new(&file).file_name().map_or(file.clone(), |n| n.to_string_lossy().into_owned());

        let mut env = clean_env();
        for (k, v) in profile.env.unwrap_or_default() {
            if k.is_empty() {
                continue;
            }
            let v = match v {
                Value::String(s) => s,
                other => other.to_string(),
            };
            env.insert(k, regex::Regex::new(r"\$space\b").unwrap().replace_all(&v, regex::NoExpand(&space_name)).into_owned());
        }
        let lang = env.get("LANG").cloned().unwrap_or_else(|| "en_US.UTF-8".into());
        env.insert("TERM".into(), "xterm-256color".into());
        env.insert("COLORTERM".into(), "truecolor".into());
        env.insert("TERM_PROGRAM".into(), "Termorc".into());
        env.insert("LANG".into(), lang);
        env.insert("SHELL_SPACE".into(), space_name);
        if opts.own_prompt == Some(true) {
            env.insert("TERMORC_PROMPT".into(), "1".into());
        }
        if let Some(startup) = profile.startup.filter(|s| !s.trim().is_empty()) {
            env.insert("TERMAC_STARTUP".into(), startup);
        }

        let dir = &self.integration_dir;
        let mut integrated = true;
        match shell.as_str() {
            "zsh" => {
                let user = env.get("ZDOTDIR").cloned().unwrap_or_else(home);
                env.insert("TERMAC_USER_ZDOTDIR".into(), user);
                env.insert("ZDOTDIR".into(), dir.join("zsh").to_string_lossy().into_owned());
            }
            "bash" => {
                if args.iter().any(|a| a == "-l" || a == "--login") {
                    env.insert("TERMAC_LOGIN".into(), "1".into());
                }
                let rest: Vec<String> = args.drain(..).filter(|a| a != "-l" && a != "--login").collect();
                args = vec!["--rcfile".into(), dir.join("bash.sh").to_string_lossy().into_owned()];
                args.extend(rest);
            }
            "fish" => {
                args.push("--init-command".into());
                args.push(format!("source '{}'", dir.join("termac.fish").display()));
            }
            _ => integrated = false,
        }

        let size = PtySize {
            cols: opts.cols.filter(|c| *c >= 2.0).map_or(80, |c| c as u16),
            rows: opts.rows.filter(|r| *r >= 1.0).map_or(24, |r| r as u16),
            pixel_width: 0,
            pixel_height: 0,
        };
        // A restored session's folder may be gone; a shell that can't start would close its tab.
        let cwd = opts.cwd.filter(|c| Path::new(c).is_dir()).unwrap_or_else(home);

        let mut cmd = CommandBuilder::new(&file);
        cmd.args(&args);
        cmd.cwd(&cwd);
        cmd.env_clear();
        for (k, v) in &env {
            cmd.env(k, v);
        }

        let started = (|| -> anyhow_lite::Result<_> {
            let pair = native_pty_system().openpty(size).map_err(anyhow_lite::msg)?;
            let child = pair.slave.spawn_command(cmd).map_err(anyhow_lite::msg)?;
            drop(pair.slave);
            let reader = pair.master.try_clone_reader().map_err(anyhow_lite::msg)?;
            let writer = pair.master.take_writer().map_err(anyhow_lite::msg)?;
            Ok((pair.master, child, reader, writer))
        })();
        let (master, mut child, mut reader, mut writer) = match started {
            Ok(v) => v,
            Err(e) => return json!({ "ok": false, "error": e.0 }),
        };

        let id = opts.id;
        let pid = child.process_id();
        let gate = Arc::new(Gate::default());
        let (input, rx) = mpsc::channel::<Vec<u8>>();
        // Writes go through one thread per session: ordered, and a full PTY never blocks IPC.
        std::thread::spawn(move || {
            for chunk in rx {
                if writer.write_all(&chunk).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        });

        let session = Session {
            owner: owner.to_string(),
            shell: shell.clone(),
            master,
            input,
            killer: child.clone_killer(),
            pid,
            unacked: 0,
            paused: false,
            held: false,
            proc: shell.clone(),
            gate: gate.clone(),
            integrated,
            pending_command: opts.initial_command.unwrap_or_default(),
        };
        self.inner.lock().unwrap().sessions.insert(id.clone(), session);

        let reader_done = Arc::new((Mutex::new(false), Condvar::new()));
        {
            let host = self.clone();
            let id = id.clone();
            let done = reader_done.clone();
            std::thread::spawn(move || {
                let mut buf = vec![0u8; 64 * 1024];
                let mut carry = Vec::new();
                loop {
                    gate.wait_open();
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let text = decode(&mut carry, &buf[..n]);
                            if !text.is_empty() {
                                host.on_data(&id, text);
                            }
                        }
                    }
                }
                *done.0.lock().unwrap() = true;
                done.1.notify_all();
            });
        }
        {
            let host = self.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                let status = child.wait();
                // Let the reader drain what the shell printed last. A background job holding
                // the terminal open would keep it reading forever, so don't wait long.
                let (lock, cv) = &*reader_done;
                let _ = cv.wait_timeout_while(lock.lock().unwrap(), Duration::from_millis(250), |d| !*d);
                let (code, signal) = match status {
                    Ok(s) => (s.exit_code(), s.signal().map(str::to_string)),
                    Err(_) => (1, None),
                };
                host.on_exit(&id, code, signal);
            });
        }
        json!({ "ok": true, "pid": pid, "shell": shell, "integrated": integrated })
    }

    fn on_data(&self, id: &str, text: String) {
        let mut inner = self.inner.lock().unwrap();
        let Some(s) = inner.sessions.get_mut(id) else { return };
        if !s.pending_command.is_empty() && (!s.integrated || text.contains(PROMPT_MARK)) {
            let line = format!("{}\r", std::mem::take(&mut s.pending_command)).into_bytes();
            let input = s.input.clone();
            // The prompt mark comes just before the line editor starts reading; typed too early,
            // the terminal driver echoes the line once and the editor again. Give it a moment.
            let wait = if s.integrated { 60 } else { 300 };
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(wait));
                let _ = input.send(line);
            });
        }
        s.unacked += text.encode_utf16().count();
        if s.unacked > HIGH_WATER {
            s.pause();
        }
        let held = s.held;
        inner.pending.entry(id.to_string()).or_default().push(text);
        if !held && !inner.flush_scheduled {
            inner.flush_scheduled = true;
            self.wake.notify_one();
        }
    }

    fn on_exit(&self, id: &str, code: u32, signal: Option<String>) {
        self.flush();
        let mut inner = self.inner.lock().unwrap();
        let Some(s) = inner.sessions.remove(id) else { return };
        inner.pending.remove(id);
        s.gate.set(false);
        if let Some(ch) = inner.channels.get(&s.owner) {
            let _ = ch.send(json!({ "t": "exit", "id": id, "exitCode": code, "signal": signal }));
        }
    }

    pub fn flush(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.flush_scheduled = false;
        let mut batches: HashMap<String, Vec<Value>> = HashMap::new();
        let ids: Vec<String> = inner.pending.keys().cloned().collect();
        for id in ids {
            let owner = match inner.sessions.get(&id) {
                Some(s) if s.held => continue,
                Some(s) => s.owner.clone(),
                None => {
                    inner.pending.remove(&id);
                    continue;
                }
            };
            let chunks = inner.pending.remove(&id).unwrap_or_default();
            batches.entry(owner).or_default().push(json!([id, chunks.concat()]));
        }
        for (owner, batch) in batches {
            if let Some(ch) = inner.channels.get(&owner) {
                let _ = ch.send(json!({ "t": "data", "b": batch }));
            }
        }
    }

    pub fn ack(&self, id: &str, units: usize) {
        let mut inner = self.inner.lock().unwrap();
        let Some(s) = inner.sessions.get_mut(id) else { return };
        s.unacked = s.unacked.saturating_sub(units);
        if s.paused && !s.held && s.unacked < LOW_WATER {
            s.resume();
        }
    }

    pub fn write(&self, id: &str, data: String) {
        if let Some(s) = self.inner.lock().unwrap().sessions.get(id) {
            let _ = s.input.send(data.into_bytes());
        }
    }

    pub fn resize(&self, id: &str, cols: f64, rows: f64) {
        if !(cols > 1.0) || !(rows > 0.0) {
            return;
        }
        if let Some(s) = self.inner.lock().unwrap().sessions.get(id) {
            let _ = s.master.resize(PtySize { cols: cols as u16, rows: rows as u16, pixel_width: 0, pixel_height: 0 });
        }
    }

    // SIGHUP, like closing a terminal window; the exit arrives through the waiter thread.
    pub fn kill(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        let Some(s) = inner.sessions.get_mut(id) else { return };
        s.gate.set(false);
        match s.pid {
            Some(pid) => unsafe {
                libc::kill(pid as i32, libc::SIGHUP);
            },
            None => {
                let _ = s.killer.kill();
            }
        }
    }

    // Stop delivering output (and pause the process) until release(); used before a handoff.
    pub fn hold(&self, id: &str) -> bool {
        self.flush();
        let mut inner = self.inner.lock().unwrap();
        let Some(s) = inner.sessions.get_mut(id) else { return false };
        s.held = true;
        s.pause();
        true
    }

    // Hand a live session to another window (Quick Terminal → main window). Output stays
    // held until the new owner has written the transferred scrollback and calls release().
    pub fn transfer(&self, id: &str, owner: &str) -> bool {
        self.flush();
        let mut inner = self.inner.lock().unwrap();
        let Some(s) = inner.sessions.get_mut(id) else { return false };
        s.held = true;
        s.owner = owner.to_string();
        s.unacked = 0;
        true
    }

    pub fn release(&self, id: &str) {
        {
            let mut inner = self.inner.lock().unwrap();
            let Some(s) = inner.sessions.get_mut(id) else { return };
            s.held = false;
            s.resume();
        }
        self.flush();
    }

    fn poll_processes(&self) {
        let mut inner = self.inner.lock().unwrap();
        let mut changed = Vec::new();
        for (id, s) in inner.sessions.iter_mut() {
            let Some(name) = s.master.process_group_leader().and_then(proc_name) else { continue };
            if name != s.proc {
                s.proc = name.clone();
                changed.push((s.owner.clone(), id.clone(), name));
            }
        }
        for (owner, id, proc) in changed {
            if let Some(ch) = inner.channels.get(&owner) {
                let _ = ch.send(json!({ "t": "proc", "id": id, "proc": proc }));
            }
        }
    }

    pub fn pid_of(&self, id: &str) -> Option<u32> {
        self.inner.lock().unwrap().sessions.get(id).and_then(|s| s.pid)
    }

    pub fn running_count(&self) -> usize {
        let inner = self.inner.lock().unwrap();
        inner.sessions.values().filter(|s| s.proc != s.shell && s.proc != "login").count()
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = self.inner.lock().unwrap().sessions.keys().cloned().collect();
        for id in ids {
            self.kill(&id);
        }
    }
}

// Error plumbing for spawn without pulling in anyhow.
mod anyhow_lite {
    pub struct Error(pub String);
    pub type Result<T> = std::result::Result<T, Error>;
    pub fn msg(e: impl std::fmt::Display) -> Error {
        Error(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn host() -> (Arc<PtyHost>, Arc<Mutex<Vec<Value>>>) {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("shell-integration");
        let host = PtyHost::new(dir);
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        host.attach(
            "main",
            Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(s) = body {
                    sink.lock().unwrap().push(serde_json::from_str(&s).unwrap());
                }
                Ok(())
            }),
        );
        (host, got)
    }

    fn output(got: &Mutex<Vec<Value>>, id: &str) -> String {
        let mut out = String::new();
        for m in got.lock().unwrap().iter().filter(|m| m["t"] == "data") {
            for pair in m["b"].as_array().unwrap() {
                if pair[0] == id {
                    out.push_str(pair[1].as_str().unwrap());
                }
            }
        }
        out
    }

    fn wait_for(mut f: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn opts(id: &str, command: &str, initial: &str) -> SpawnOpts {
        serde_json::from_value(json!({ "id": id, "cols": 80, "rows": 24, "profile": { "command": command }, "spaceName": "work", "initialCommand": initial })).unwrap()
    }

    #[test]
    fn decode_carries_split_utf8() {
        let mut carry = Vec::new();
        let bytes = "héllo ✓".as_bytes();
        let cut = bytes.len() - 1;
        let a = decode(&mut carry, &bytes[..cut]);
        let b = decode(&mut carry, &bytes[cut..]);
        assert_eq!(format!("{a}{b}"), "héllo ✓");
        assert_eq!(decode(&mut carry, &[0xff, b'x']), "\u{FFFD}x");
    }

    #[test]
    fn zsh_runs_initial_command_and_reports_exit() {
        let (host, got) = host();
        let res = host.spawn("main", opts("z1", "/bin/zsh -f", ""));
        assert_eq!(res["ok"], true, "{res}");
        host.write("z1", "echo $TERM_PROGRAM:$SHELL_SPACE:$((40+2))\r".into());
        assert!(wait_for(|| output(&got, "z1").contains("Termorc:work:42")), "{}", output(&got, "z1"));
        host.write("z1", "exit 3\r".into());
        assert!(wait_for(|| got.lock().unwrap().iter().any(|m| m["t"] == "exit" && m["id"] == "z1")));
        let exit = got.lock().unwrap().iter().find(|m| m["t"] == "exit").cloned().unwrap();
        assert_eq!(exit["exitCode"], 3);
    }

    #[test]
    fn integrated_zsh_emits_prompt_marks_and_runs_initial_command() {
        let (host, got) = host();
        let res = host.spawn("main", opts("z2", "/bin/zsh", "echo started-$((6*7))"));
        assert_eq!(res["integrated"], true);
        assert!(wait_for(|| output(&got, "z2").contains("started-42")), "{}", output(&got, "z2"));
        assert!(output(&got, "z2").contains("\x1b]633;A"));
        host.kill("z2");
        assert!(wait_for(|| got.lock().unwrap().iter().any(|m| m["t"] == "exit" && m["id"] == "z2")));
    }

    #[test]
    fn flow_control_pauses_until_acked() {
        let (host, got) = host();
        host.spawn("main", opts("f1", "/bin/sh -c 'yes 0123456789abcdef | head -c 3000000; echo; echo DONE'", ""));
        // Without acks the reader stops near the high-water mark.
        std::thread::sleep(Duration::from_millis(600));
        let stalled = output(&got, "f1").len();
        assert!(stalled < 1_000_000, "read {stalled} bytes without acks");
        assert!(!output(&got, "f1").contains("DONE"));
        // Acking what arrived lets it run to completion.
        let mut acked = 0;
        assert!(wait_for(|| {
            let len = output(&got, "f1").encode_utf16().count();
            host.ack("f1", len - acked);
            acked = len;
            output(&got, "f1").contains("DONE")
        }));
    }

    #[test]
    fn hold_and_transfer_move_output_to_new_owner() {
        let (host, got) = host();
        let quick = Arc::new(Mutex::new(0usize));
        let q = quick.clone();
        host.attach("quick", Channel::new(move |_| {
            *q.lock().unwrap() += 1;
            Ok(())
        }));
        host.spawn("quick", opts("t1", "/bin/zsh -f", ""));
        assert!(wait_for(|| *quick.lock().unwrap() > 0));
        assert!(host.hold("t1"));
        assert!(host.transfer("t1", "main"));
        host.write("t1", "echo moved-$((1+1))\r".into());
        std::thread::sleep(Duration::from_millis(300));
        assert!(!output(&got, "t1").contains("moved-2"), "held output leaked");
        host.release("t1");
        assert!(wait_for(|| output(&got, "t1").contains("moved-2")));
        host.kill("t1");
    }
}
