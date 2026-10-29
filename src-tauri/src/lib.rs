// The native side of Termorc: windows, menus, PTYs and file access. The renderer reaches
// all of it through the narrow `window.termac` bridge (src/bridge.js).
mod library;
mod macos;
mod pty;
mod review;
mod shell;
mod store;
mod system;

use base64::Engine;
use library::{safe_id, Library};
use notify::Watcher;
use pty::PtyHost;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use store::{read_json, write_atomic, DebouncedWriter};
use tauri::ipc::Channel;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::menu::{AboutMetadata, CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, PhysicalPosition, RunEvent, TitleBarStyle, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tokio::sync::oneshot;

const MAIN: &str = "main";
const QUICK: &str = "quick";
// Centers the buttons in the 52px top bar (--bar-h), inside the sidebar panel's inset. tao
// grows the title bar container to button height + y and AppKit keeps the buttons near its
// bottom, so y is measured, not derived (45px bar ↔ 23.5; the buttons' center tracks y − 1).
const TRAFFIC_LIGHTS: LogicalPosition<f64> = LogicalPosition { x: 21.0, y: 27.0 };

struct Paths {
    state_file: PathBuf,
    scrollback: PathBuf,
    settings_dir: PathBuf,
    settings_file: PathBuf,
    schema_file: PathBuf,
}

#[derive(Default)]
struct Quit {
    quitting: bool,
    ready: bool,
    generation: u64,
}

struct Popup {
    seq: u64,
    tx: oneshot::Sender<Option<String>>,
    ids: Vec<String>,
}

struct AppState {
    paths: Paths,
    ptys: Arc<PtyHost>,
    library: Arc<Mutex<Library>>,
    state: Mutex<Value>,
    state_writer: DebouncedWriter,
    // Set once the final state is on disk. Quitting kills every shell, and the renderer
    // would otherwise answer those exits by closing tabs and saving the result over it.
    sealed: AtomicBool,
    // What's on disk, so our own writes don't echo back as changes.
    settings_text: Arc<Mutex<Option<String>>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    hotkey: Mutex<Option<Shortcut>>,
    quit: Mutex<Quit>,
    popup: Mutex<Option<Popup>>,
    popup_seq: AtomicU64,
    quick_show_on_load: AtomicBool,
    cleaned_up: AtomicBool,
    // Folders handed over by Finder (the Services menu, a Dock drop, `open -a`), waiting
    // for the main window to open tabs for them.
    opened_folders: Mutex<Vec<String>>,
}

fn st(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

fn scrollback_file(app: &AppHandle, id: &str) -> PathBuf {
    st(app).paths.scrollback.join(format!("{}.ans", safe_id(id)))
}

fn open_path(path: &str, reveal: bool) -> bool {
    let mut cmd = std::process::Command::new("open");
    if reveal {
        cmd.arg("-R");
    }
    cmd.arg(path).status().is_ok_and(|s| s.success())
}

// ---- PTY ---------------------------------------------------------------------------------
#[tauri::command]
fn pty_attach(app: AppHandle, window: WebviewWindow, channel: Channel<Value>) {
    st(&app).ptys.attach(window.label(), channel);
}

#[tauri::command]
async fn pty_spawn(app: AppHandle, window: WebviewWindow, opts: pty::SpawnOpts) -> Value {
    let ptys = st(&app).ptys.clone();
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || ptys.spawn(&owner, opts)).await.unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}

// The hot path commands are synchronous: they run in arrival order, so keystrokes can't race.
#[tauri::command]
fn pty_write(app: AppHandle, id: String, data: String) {
    st(&app).ptys.write(&id, data);
}

#[tauri::command]
fn pty_resize(app: AppHandle, id: String, cols: f64, rows: f64) {
    st(&app).ptys.resize(&id, cols, rows);
}

#[tauri::command]
fn pty_kill(app: AppHandle, id: String) {
    st(&app).ptys.kill(&id);
}

#[tauri::command]
fn pty_ack(app: AppHandle, id: String, bytes: f64) {
    st(&app).ptys.ack(&id, bytes.max(0.0) as usize);
}

#[tauri::command]
fn pty_hold(app: AppHandle, id: String) -> bool {
    st(&app).ptys.hold(&id)
}

#[tauri::command]
fn pty_release(app: AppHandle, id: String) {
    st(&app).ptys.release(&id);
}

// Fallback for shells without integration: ask the OS for the shell's cwd.
#[tauri::command]
async fn pty_cwd(app: AppHandle, id: String) -> Option<String> {
    let pid = st(&app).ptys.pid_of(&id)?.to_string();
    let out = system::run("lsof", &["-a", "-d", "cwd", "-p", &pid, "-Fn"], 1500, None, false).await?;
    out.lines().find_map(|l| l.strip_prefix('n')).map(str::to_string)
}

// ---- State & settings -----------------------------------------------------------------
#[tauri::command]
fn state_load(app: AppHandle, window: WebviewWindow) -> Value {
    let dark = window.theme().map_or(false, |t| t == tauri::Theme::Dark);
    json!({ "state": *st(&app).state.lock().unwrap(), "home": system::home(), "dark": dark })
}

#[tauri::command]
fn state_save(app: AppHandle, next: Value) {
    let s = st(&app);
    if s.sealed.load(Ordering::SeqCst) {
        return;
    }
    s.state_writer.save(next.to_string());
    let pick = |k: &str| next.get(k).cloned().unwrap_or(Value::Null);
    let _ = app.emit_to(
        QUICK,
        "state:changed",
        json!({ "spaces": pick("spaces"), "settings": pick("settings"), "profiles": pick("profiles"), "activeSpaceId": pick("activeSpaceId"), "defaultProfileId": pick("defaultProfileId") }),
    );
    *s.state.lock().unwrap() = next;
}

fn watch_settings(app: &AppHandle) {
    let s = st(app);
    let mut slot = s.watcher.lock().unwrap();
    if slot.is_some() {
        return;
    }
    let dir = s.paths.settings_dir.clone();
    let file = s.paths.settings_file.clone();
    let _ = std::fs::create_dir_all(&dir);
    let app2 = app.clone();
    let known = s.settings_text.clone();
    let generation = Arc::new(AtomicU64::new(0));
    // Editors often save by replacing the file, so watch the folder rather than the file.
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if !event.paths.iter().any(|p| p.file_name().is_some_and(|n| n == "settings.json")) {
            return;
        }
        let ticket = generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (generation, file, known, app) = (generation.clone(), file.clone(), known.clone(), app2.clone());
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            if generation.load(Ordering::SeqCst) != ticket {
                return;
            }
            let Ok(text) = std::fs::read_to_string(&file) else { return };
            let mut known = known.lock().unwrap();
            if known.as_deref() == Some(text.as_str()) {
                return;
            }
            *known = Some(text.clone());
            let _ = app.emit_to(MAIN, "settings:changed", text);
        });
    });
    match watcher {
        Ok(mut w) => {
            if let Err(e) = w.watch(&dir, notify::RecursiveMode::NonRecursive) {
                eprintln!("settings watch failed: {e}");
            }
            *slot = Some(w);
        }
        Err(e) => eprintln!("settings watch failed: {e}"),
    }
}

#[tauri::command]
fn settings_load(app: AppHandle) -> Value {
    let s = st(&app);
    let text = std::fs::read_to_string(&s.paths.settings_file).ok();
    *s.settings_text.lock().unwrap() = text.clone();
    watch_settings(&app);
    json!({ "text": text, "path": s.paths.settings_file, "schemaUrl": format!("file://{}", s.paths.schema_file.display()) })
}

#[tauri::command]
fn settings_save(app: AppHandle, text: String) {
    let s = st(&app);
    let mut known = s.settings_text.lock().unwrap();
    if s.sealed.load(Ordering::SeqCst) || known.as_deref() == Some(text.as_str()) {
        return;
    }
    let _ = write_atomic(&s.paths.settings_file, text.as_bytes());
    *known = Some(text);
}

#[tauri::command]
fn settings_save_schema(app: AppHandle, text: String) {
    let file = &st(&app).paths.schema_file;
    if std::fs::read_to_string(file).ok().as_deref() != Some(text.as_str()) {
        let _ = write_atomic(file, text.as_bytes());
    }
}

#[tauri::command]
async fn settings_open(app: AppHandle) {
    // No app registered for .json opens nothing; fall back to showing it in Finder.
    let file = st(&app).paths.settings_file.to_string_lossy().into_owned();
    if !open_path(&file, false) {
        open_path(&file, true);
    }
}

#[tauri::command]
async fn scrollback_save(app: AppHandle, id: String, data: String) {
    let file = scrollback_file(&app, &id);
    let _ = tokio::fs::create_dir_all(file.parent().unwrap()).await;
    let _ = tokio::fs::write(file, data).await;
}

#[tauri::command]
async fn scrollback_load(app: AppHandle, id: String) -> String {
    tokio::fs::read(scrollback_file(&app, &id)).await.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
}

#[tauri::command]
async fn scrollback_delete(app: AppHandle, id: String) {
    let _ = tokio::fs::remove_file(scrollback_file(&app, &id)).await;
}

// ---- Library ----------------------------------------------------------------------------
async fn with_library<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&mut Library) -> T + Send + 'static) -> T {
    let lib = st(app).library.clone();
    tauri::async_runtime::spawn_blocking(move || f(&mut lib.lock().unwrap())).await.expect("library task")
}

#[tauri::command]
async fn library_add(app: AppHandle, entry: Map<String, Value>, ansi: Option<String>) -> Value {
    with_library(&app, move |l| l.add(entry, ansi.unwrap_or_default())).await
}

#[tauri::command]
async fn library_search(app: AppHandle, query: Option<library::Query>) -> Value {
    with_library(&app, move |l| l.search(query.unwrap_or_default())).await
}

#[tauri::command]
async fn library_content(app: AppHandle, id: String) -> String {
    with_library(&app, move |l| l.content(&id)).await
}

#[tauri::command]
async fn library_remove(app: AppHandle, id: String) {
    with_library(&app, move |l| l.remove(&id)).await
}

// ---- System -----------------------------------------------------------------------------
#[tauri::command]
async fn sys_ssh_hosts() -> Vec<Value> {
    system::ssh_hosts()
}

#[tauri::command]
async fn sys_git_branch(cwd: Option<String>) -> Option<String> {
    system::git_branch(&cwd.unwrap_or_default())
}

#[tauri::command]
async fn sys_git_status(cwd: Option<String>) -> Value {
    system::git_status(&cwd.unwrap_or_default()).await
}

#[tauri::command]
async fn sys_git_branches(cwd: Option<String>) -> Vec<String> {
    system::git_branches(&cwd.unwrap_or_default()).await
}

#[tauri::command]
async fn sys_git_pr(cwd: Option<String>, branch: Option<String>) -> Value {
    system::git_pr(&cwd.unwrap_or_default(), &branch.unwrap_or_default()).await
}

#[tauri::command]
async fn sys_list_dirs(dir: String) -> Vec<String> {
    system::list_dirs(&dir)
}

#[tauri::command]
async fn sys_git_root(cwd: Option<String>) -> Option<String> {
    system::git_root(&cwd.unwrap_or_default()).await
}

#[tauri::command]
async fn sys_list_dir(dir: String) -> Value {
    system::list_dir(&dir)
}

#[tauri::command]
async fn sys_read_file(file: String) -> Value {
    system::read_file(&file)
}

// The editor's save. Written in place, not swapped in, so the file keeps its permissions
// (an executable script stays executable), owner and any links pointing at it.
#[tauri::command]
async fn sys_write_file(file: String, text: String) -> Value {
    match tokio::fs::write(&file, text.as_bytes()).await {
        Ok(()) => json!({ "ok": true, "size": text.len() }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
async fn sys_project_files(root: String) -> Vec<String> {
    system::project_files(&root).await
}

#[tauri::command]
async fn sys_git_changes(cwd: Option<String>) -> Value {
    system::git_changes(&cwd.unwrap_or_default()).await
}

#[derive(Deserialize, Default)]
struct DiffOpts {
    #[serde(default)]
    staged: bool,
    #[serde(default)]
    untracked: bool,
    // Lines of context around each change (git's -U); the panel widens it on request.
    context: Option<u32>,
}

#[tauri::command]
async fn sys_git_diff(root: String, file: String, opts: Option<DiffOpts>) -> Option<String> {
    let o = opts.unwrap_or_default();
    system::git_diff(&root, &file, o.staged, o.untracked, o.context.unwrap_or(3)).await
}

#[tauri::command]
async fn sys_git_stage(root: String, file: String, stage: bool) -> bool {
    system::git_stage(&root, &file, stage).await
}

#[tauri::command]
async fn sys_git_discard(root: String, file: String, untracked: bool) -> bool {
    system::git_discard(&root, &file, untracked).await
}

#[tauri::command]
async fn sys_detect_imports() -> Value {
    system::detect_imports().await
}

#[tauri::command]
async fn sys_is_dir(p: Option<String>) -> bool {
    p.is_some_and(|p| system::is_dir(&p))
}

#[tauri::command]
async fn sys_choose_dir(app: AppHandle, window: WebviewWindow, default_path: Option<String>) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    let mut dialog = app.dialog().file().set_parent(&window).set_can_create_directories(true);
    if let Some(p) = default_path.filter(|p| !p.is_empty()) {
        dialog = dialog.set_directory(p);
    }
    dialog.pick_folder(move |r| {
        let _ = tx.send(r);
    });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn sys_choose_image(app: AppHandle, window: WebviewWindow) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().set_parent(&window).add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif", "heic"]).pick_file(move |r| {
        let _ = tx.send(r);
    });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

// Background images are read once and handed over as data URLs (CSP allows data: images).
#[tauri::command]
async fn sys_read_image(file: String) -> Option<String> {
    let meta = tokio::fs::metadata(&file).await.ok()?;
    if meta.len() > 20 * 1024 * 1024 {
        return None;
    }
    let ext = PathBuf::from(&file).extension()?.to_string_lossy().to_lowercase().replace("jpg", "jpeg");
    let bytes = tokio::fs::read(&file).await.ok()?;
    Some(format!("data:image/{ext};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[tauri::command]
async fn sys_reveal(p: String) {
    open_path(&p, false);
}

#[tauri::command]
async fn sys_open_external(url: String) {
    if url.starts_with("http://") || url.starts_with("https://") {
        open_path(&url, false);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Notice {
    title: String,
    body: Option<String>,
    session_id: Option<String>,
}

#[tauri::command]
fn sys_notify(app: AppHandle, n: Notice) {
    std::thread::spawn(move || {
        let mut opts = mac_notification_sys::Notification::new();
        opts.wait_for_click(true).sound("default");
        let sent = mac_notification_sys::send_notification(&n.title, None, n.body.as_deref().unwrap_or(""), Some(&opts));
        if let Ok(mac_notification_sys::NotificationResponse::Click) = sent {
            if let Some(main) = app.get_webview_window(MAIN) {
                let _ = main.show();
                let _ = main.set_focus();
            }
            let _ = app.emit_to(MAIN, "app:jumpTo", n.session_id);
        }
    });
}

#[derive(Deserialize)]
struct Confirm {
    message: String,
    detail: Option<String>,
    ok: Option<String>,
}

#[tauri::command]
async fn sys_confirm(app: AppHandle, window: WebviewWindow, o: Confirm) -> bool {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .message(o.detail.unwrap_or_default())
        .title(o.message)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(o.ok.unwrap_or_else(|| "OK".into()), "Cancel".into()))
        .parent(&window)
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    rx.await.unwrap_or(false)
}

// ---- Input bar ---------------------------------------------------------------------------
#[tauri::command]
async fn shell_history() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(shell::history).await.unwrap_or_default()
}

#[tauri::command]
async fn shell_complete(cwd: Option<String>, line: String) -> Value {
    let cwd = cwd.filter(|c| !c.is_empty()).unwrap_or_else(|| system::home().to_string_lossy().into_owned());
    shell::complete(&cwd, &line).await
}

// ---- Code review ---------------------------------------------------------------------------
#[tauri::command]
async fn review_overview(root: String) -> Value {
    review::overview(&root).await
}

#[tauri::command]
async fn review_log(root: String, limit: Option<u32>) -> Value {
    review::log(&root, limit.unwrap_or(80)).await
}

#[tauri::command]
async fn review_show(root: String, sha: String) -> Value {
    review::show(&root, &sha).await
}

#[tauri::command]
async fn review_remote_branches(root: String) -> Vec<String> {
    review::remote_branches(&root).await
}

#[tauri::command]
async fn review_pr(root: String) -> Value {
    review::pr(&root).await
}

#[tauri::command]
async fn review_op(root: String, op: review::GitOp) -> Value {
    review::op(&root, op).await
}

// navigator.clipboard needs a fresh user gesture in WebKit; copies after an awaited menu
// would be refused, so they come through here.
#[tauri::command]
fn sys_copy(text: String) {
    macos::copy_text(&text);
}

// ---- Menus ------------------------------------------------------------------------------
fn add_items(app: &AppHandle, items: &[Value], ids: &mut Vec<String>, add: &mut dyn FnMut(&dyn IsMenuItem<Wry>) -> tauri::Result<()>) -> tauri::Result<()> {
    for it in items {
        if it["type"] == "separator" {
            add(&PredefinedMenuItem::separator(app)?)?;
            continue;
        }
        let label = it["label"].as_str().unwrap_or("");
        let enabled = it["enabled"] != Value::Bool(false);
        if let Some(sub) = it["submenu"].as_array() {
            let submenu = Submenu::new(app, label, enabled)?;
            add_items(app, sub, ids, &mut |item| submenu.append(item))?;
            add(&submenu)?;
            continue;
        }
        let id = format!("ctx:{}", ids.len());
        ids.push(match &it["id"] {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        });
        match it["checked"].as_bool() {
            Some(checked) => add(&CheckMenuItem::with_id(app, id, label, enabled, checked, None::<&str>)?)?,
            None => add(&MenuItem::with_id(app, id, label, enabled, None::<&str>)?)?,
        }
    }
    Ok(())
}

fn resolve_popup(app: &AppHandle, seq: u64, picked: Option<usize>) {
    let s = st(app);
    let mut slot = s.popup.lock().unwrap();
    if slot.as_ref().is_some_and(|p| p.seq == seq) {
        let p = slot.take().unwrap();
        let _ = p.tx.send(picked.and_then(|i| p.ids.get(i).cloned()));
    }
}

#[tauri::command]
async fn menu_popup(app: AppHandle, window: WebviewWindow, items: Vec<Value>) -> Option<String> {
    let mut ids = Vec::new();
    let menu = Menu::new(&app).ok()?;
    add_items(&app, &items, &mut ids, &mut |item| menu.append(item)).ok()?;
    let (tx, rx) = oneshot::channel();
    let seq = st(&app).popup_seq.fetch_add(1, Ordering::SeqCst);
    if let Some(old) = st(&app).popup.lock().unwrap().replace(Popup { seq, tx, ids }) {
        let _ = old.tx.send(None);
    }
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        // On macOS this blocks until the menu closes. A pick is queued as a menu event by
        // then, so a "dismissed" queued after it only lands if nothing was picked.
        let _ = window.popup_menu(&menu);
        std::thread::spawn(move || {
            let app3 = app2.clone();
            let _ = app2.run_on_main_thread(move || resolve_popup(&app3, seq, None));
        });
    });
    rx.await.ok().flatten()
}

fn build_app_menu(app: &AppHandle, bindings: &HashMap<String, String>) -> tauri::Result<Menu<Wry>> {
    let item = |label: &str, action: &str| {
        let accel = bindings.get(action).map(String::as_str).filter(|a| !a.is_empty());
        MenuItem::with_id(app, format!("act:{action}"), label, true, accel)
    };
    let sep = || PredefinedMenuItem::separator(app);
    let about = AboutMetadata { name: Some("Termorc".into()), version: Some(app.package_info().version.to_string()), ..Default::default() };
    let app_menu = Submenu::with_items(
        app,
        "Termorc",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Termorc"), Some(about))?,
            &sep()?,
            &item("Settings…", "settings")?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &MenuItem::with_id(app, "quit", "Quit Termorc", true, Some("Cmd+Q"))?,
        ],
    )?;
    let shell = Submenu::with_items(
        app,
        "Shell",
        true,
        &[
            &item("New Terminal", "newTerminal")?,
            &item("Command Bar", "commandBar")?,
            &item("Find Session…", "findTab")?,
            &sep()?,
            &item("Split Right", "splitRight")?,
            &item("Split Down", "splitDown")?,
            &item("Close Pane", "closePane")?,
            &sep()?,
            &item("Copy Last Output", "copyLastOutput")?,
            &item("Clear", "clear")?,
            &item("Find…", "find")?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("Toggle Sidebar", "toggleSidebar")?,
            &item("Focus Mode", "focusMode")?,
            &item("Library", "library")?,
            &item("Notes", "notes")?,
            &item("Project Explorer", "toggleFiles")?,
            &item("Find File…", "quickOpen")?,
            &item("Code Review", "toggleReview")?,
            &item("All Spaces", "overview")?,
            &sep()?,
            &item("Bigger", "zoomIn")?,
            &item("Smaller", "zoomOut")?,
            &item("Actual Size", "zoomReset")?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let spaces = Submenu::with_items(
        app,
        "Spaces",
        true,
        &[&item("Next Space", "nextSpace")?, &item("Previous Space", "prevSpace")?, &sep()?, &item("New Space…", "newSpace")?],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, Some("Zoom"))?, &sep()?, &PredefinedMenuItem::bring_all_to_front(app, None)?],
    )?;
    let menu = Menu::with_items(app, &[&app_menu, &shell, &edit, &view, &spaces, &window])?;
    let _ = window.set_as_windows_menu_for_nsapp();
    Ok(menu)
}

#[tauri::command]
fn app_set_menu(app: AppHandle, bindings: Option<HashMap<String, Value>>) {
    let bindings: HashMap<String, String> =
        bindings.unwrap_or_default().into_iter().filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string()))).collect();
    if let Ok(menu) = build_app_menu(&app, &bindings) {
        let _ = app.set_menu(menu);
    }
}

fn on_menu_event(app: &AppHandle, id: &str) {
    if let Some(n) = id.strip_prefix("ctx:") {
        let seq = st(app).popup.lock().unwrap().as_ref().map(|p| p.seq);
        if let Some(seq) = seq {
            resolve_popup(app, seq, n.parse().ok());
        }
    } else if let Some(action) = id.strip_prefix("act:") {
        let target = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
        let label = target.map_or(MAIN.to_string(), |w| w.label().to_string());
        let _ = app.emit_to(label.as_str(), "menu:action", action);
    } else if id == "quit" {
        begin_quit(app);
    }
}

// ---- Windows ----------------------------------------------------------------------------
fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Termorc")
        .inner_size(1280.0, 800.0)
        .min_inner_size(720.0, 420.0)
        .visible(false)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(TRAFFIC_LIGHTS)
        .disable_drag_drop_handler()
        // Sessions keep streaming while the window is hidden; WebKit mustn't nap the page,
        // or unacked output would pause the shells.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()?;
    paint_background(&window, (0x0f, 0x10, 0x13), (0xf2, 0xf2, 0xf0));
    // Shown once the page has painted (app_ready), or after a beat in case it never says so.
    let w = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(2500));
        if !w.is_visible().unwrap_or(true) {
            let _ = w.show();
            let _ = w.set_focus();
        }
    });
    Ok(window)
}

// Matches the page background so resizing never flashes white at the edges.
fn paint_background(window: &WebviewWindow, dark: (u8, u8, u8), light: (u8, u8, u8)) {
    let (r, g, b) = if window.theme().map_or(false, |t| t == tauri::Theme::Dark) { dark } else { light };
    let _ = window.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
}

fn create_quick_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, QUICK, WebviewUrl::App("quick.html".into()))
        .title("Quick Terminal")
        .inner_size(640.0, 380.0)
        .min_inner_size(420.0, 200.0)
        .visible(false)
        .resizable(true)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .disable_drag_drop_handler()
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()?;
    paint_background(&window, (0x13, 0x14, 0x17), (0xfc, 0xfc, 0xfa));
    // Keeps the native rounded corners and shadow, without the buttons.
    macos::set_traffic_lights_visible(&window, false);
    macos::float_on_all_spaces(&window);
    Ok(window)
}

fn hide_quick(app: &AppHandle) {
    let Some(quick) = app.get_webview_window(QUICK) else { return };
    if !quick.is_visible().unwrap_or(false) {
        return;
    }
    let _ = quick.hide();
    let _ = app.emit_to(QUICK, "quick:visibility", json!({ "visible": false }));
}

async fn show_quick(app: AppHandle) {
    let Some(quick) = app.get_webview_window(QUICK) else { return };
    // Read Finder's folder before we come to the front and it stops being frontmost.
    let cwd = system::frontmost_folder().await;
    if let Ok(cursor) = app.cursor_position() {
        if let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) {
            let area = monitor.work_area();
            let width = quick.outer_size().map_or(0, |s| s.width) as i32;
            let x = area.position.x + (area.size.width as i32 - width) / 2;
            let y = area.position.y + (8.0 * monitor.scale_factor()) as i32;
            let _ = quick.set_position(PhysicalPosition::new(x, y));
        }
    }
    let _ = quick.show();
    let _ = quick.set_focus();
    let _ = app.emit_to(QUICK, "quick:visibility", json!({ "visible": true, "cwd": cwd }));
}

fn toggle_quick(app: &AppHandle) {
    let Some(quick) = app.get_webview_window(QUICK) else {
        // First use: build it, and show it once its page says it's listening (quick_loaded).
        st(app).quick_show_on_load.store(true, Ordering::SeqCst);
        if let Err(e) = create_quick_window(app) {
            eprintln!("quick terminal: {e}");
        }
        return;
    };
    if quick.is_visible().unwrap_or(false) && quick.is_focused().unwrap_or(false) {
        return hide_quick(app);
    }
    tauri::async_runtime::spawn(show_quick(app.clone()));
}

fn show_main(app: &AppHandle) {
    let main = match app.get_webview_window(MAIN) {
        Some(w) => w,
        None => match create_main_window(app) {
            Ok(w) => w,
            Err(_) => return,
        },
    };
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
}

#[tauri::command]
fn app_set_hotkey(app: AppHandle, accel: Option<String>) -> bool {
    let s = st(&app);
    let gs = app.global_shortcut();
    let mut current = s.hotkey.lock().unwrap();
    if let Some(old) = current.take() {
        let _ = gs.unregister(old);
    }
    let Some(accel) = accel.filter(|a| !a.is_empty()) else { return true };
    let Ok(shortcut) = accel.parse::<Shortcut>() else { return false };
    if gs.register(shortcut).is_err() {
        return false;
    }
    *current = Some(shortcut);
    true
}

#[tauri::command]
fn app_focus_main(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn app_traffic_lights(window: WebviewWindow, visible: bool) {
    macos::set_traffic_lights_visible(&window, visible);
}

#[tauri::command]
fn app_set_zoom(window: WebviewWindow, percent: f64) {
    let _ = window.set_zoom((percent / 100.0).clamp(0.5, 3.0));
}

#[tauri::command]
fn app_titlebar_double_click(window: WebviewWindow) {
    macos::titlebar_double_click(&window);
}

// The page has painted its first frame: show the window without a blank flash.
#[tauri::command]
fn app_ready(window: WebviewWindow) {
    if window.label() == MAIN && !window.is_visible().unwrap_or(true) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn quick_loaded(app: AppHandle) {
    if st(&app).quick_show_on_load.swap(false, Ordering::SeqCst) {
        tauri::async_runtime::spawn(show_quick(app));
    }
}

#[tauri::command]
fn quick_hide(app: AppHandle) {
    hide_quick(&app);
}

#[tauri::command]
fn quick_promote(app: AppHandle, payload: Value) -> bool {
    let id = payload["sessionId"].as_str().unwrap_or_default().to_string();
    if app.get_webview_window(MAIN).is_none() || !st(&app).ptys.transfer(&id, MAIN) {
        return false;
    }
    let _ = app.emit_to(MAIN, "session:adopt", payload);
    hide_quick(&app);
    show_main(&app);
    true
}

// ---- Quitting -----------------------------------------------------------------------------
// The renderer saves scrollback and asks about running processes before we exit.
fn begin_quit(app: &AppHandle) {
    let s = st(app);
    let mut q = s.quit.lock().unwrap();
    let main_alive = app.get_webview_window(MAIN).is_some();
    if q.ready || !main_alive {
        drop(q);
        return finish_quit(app);
    }
    if q.quitting {
        return;
    }
    q.quitting = true;
    q.generation += 1;
    let generation = q.generation;
    drop(q);
    let _ = app.emit_to(MAIN, "app:willQuit", json!({ "running": s.ptys.running_count() }));
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(8));
        let stuck = {
            let s = st(&app);
            let q = s.quit.lock().unwrap();
            q.quitting && !q.ready && q.generation == generation
        };
        if stuck {
            finish_quit(&app);
        }
    });
}

fn finish_quit(app: &AppHandle) {
    st(app).quit.lock().unwrap().ready = true;
    cleanup(app);
    app.exit(0);
}

fn cleanup(app: &AppHandle) {
    let s = st(app);
    if s.cleaned_up.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.global_shortcut().unregister_all();
    s.watcher.lock().unwrap().take();
    s.state_writer.flush_sync();
    s.sealed.store(true, Ordering::SeqCst);
    s.library.lock().unwrap().flush_sync();
    s.ptys.kill_all();
}

// Queues folders to open as new tabs and tells the main window; the window takes the queue
// (app_take_folders) when told, and once at startup in case it wasn't listening yet.
fn open_folders(app: &AppHandle, paths: Vec<PathBuf>) {
    let dirs: Vec<String> = paths
        .into_iter()
        .filter_map(|p| if p.is_dir() { Some(p) } else { p.parent().map(PathBuf::from) })
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if dirs.is_empty() {
        return;
    }
    st(app).opened_folders.lock().unwrap().extend(dirs);
    show_main(app);
    let _ = app.emit_to(MAIN, "app:foldersOpened", ());
}

#[tauri::command]
fn app_take_folders(app: AppHandle) -> Vec<String> {
    std::mem::take(&mut *st(&app).opened_folders.lock().unwrap())
}

#[tauri::command]
fn app_quit(app: AppHandle) {
    begin_quit(&app);
}

#[tauri::command]
fn app_quit_ready(app: AppHandle) {
    finish_quit(&app);
}

#[tauri::command]
fn app_quit_cancel(app: AppHandle) {
    st(&app).quit.lock().unwrap().quitting = false;
}

// ---- Startup --------------------------------------------------------------------------------
fn app_paths() -> (PathBuf, Paths) {
    let home = system::home();
    // TERMORC_DATA_DIR keeps a development build off your everyday sessions and settings.
    let custom = std::env::var_os("TERMORC_DATA_DIR").map(PathBuf::from);
    let support = home.join("Library/Application Support");
    let user = custom.clone().unwrap_or_else(|| support.join("Termorc"));
    let state_file = user.join("state.json");
    // The app was called Termac before; carry its data over on first launch under the new name.
    let legacy = support.join("Termac");
    if custom.is_none() && !state_file.exists() && legacy.join("state.json").exists() {
        copy_dir(&legacy, &user);
    }
    let settings_dir = custom.map_or_else(|| home.join(".termorc"), |d| d.join("settings"));
    let paths = Paths {
        scrollback: user.join("scrollback"),
        settings_file: settings_dir.join("settings.json"),
        schema_file: settings_dir.join("settings.schema.json"),
        settings_dir,
        state_file,
    };
    (user, paths)
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
    let _ = std::fs::create_dir_all(to);
    let Ok(rd) = std::fs::read_dir(from) else { return };
    for e in rd.flatten() {
        let name = e.file_name();
        if name.to_string_lossy().starts_with("Singleton") {
            continue;
        }
        let (src, dst) = (e.path(), to.join(&name));
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            copy_dir(&src, &dst);
        } else {
            let _ = std::fs::copy(&src, &dst);
        }
    }
}

fn integration_dir(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("shell-integration");
    }
    app.path().resource_dir().map(|d| d.join("shell-integration")).unwrap_or_default()
}

pub fn run() {
    let (user, paths) = app_paths();
    let state: Value = read_json(&paths.state_file).unwrap_or(Value::Null);

    let mut builder = tauri::Builder::default();
    // A dev build runs beside the installed app instead of handing off to it.
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| show_main(app)));
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_quick(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let handle = app.handle();
            let library_days = state.pointer("/settings/libraryDays").and_then(Value::as_f64).unwrap_or(90.0);
            let hotkey = state.pointer("/settings/keybindings/quickTerminal").and_then(Value::as_str).unwrap_or("Alt+Space").to_string();
            app.manage(AppState {
                ptys: PtyHost::new(integration_dir(handle)),
                library: Arc::new(Mutex::new(Library::new(user.join("library")))),
                state_writer: DebouncedWriter::new(paths.state_file.clone(), 400),
                state: Mutex::new(state),
                paths,
                sealed: AtomicBool::new(false),
                settings_text: Default::default(),
                watcher: Mutex::new(None),
                hotkey: Mutex::new(None),
                quit: Mutex::new(Quit::default()),
                popup: Mutex::new(None),
                popup_seq: AtomicU64::new(0),
                quick_show_on_load: AtomicBool::new(false),
                cleaned_up: AtomicBool::new(false),
                opened_folders: Mutex::new(Vec::new()),
            });
            let services = handle.clone();
            macos::register_services(move |paths| open_folders(&services, paths.into_iter().map(PathBuf::from).collect()));
            if cfg!(debug_assertions) {
                macos::set_dock_icon(include_bytes!("../icons/icon.png"));
            } else {
                // Notifications otherwise post as another app; a bundled build has its own identity.
                let _ = mac_notification_sys::set_application(&app.config().identifier);
            }
            system::warm_login_path();
            app_set_menu(handle.clone(), None);
            create_main_window(handle)?;
            app_set_hotkey(handle.clone(), Some(hotkey));
            let lib = st(handle).library.clone();
            std::thread::spawn(move || lib.lock().unwrap().prune(library_days));
            Ok(())
        })
        .on_menu_event(|app, event| on_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| match event {
            // Closing the window hides it so sessions keep running; ⌘Q quits.
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN => {
                if !st(window.app_handle()).quit.lock().unwrap().ready {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            WindowEvent::Focused(false) if window.label() == QUICK => hide_quick(window.app_handle()),
            WindowEvent::ThemeChanged(_) => {
                if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                    match w.label() {
                        MAIN => paint_background(&w, (0x0f, 0x10, 0x13), (0xf2, 0xf2, 0xf0)),
                        _ => paint_background(&w, (0x13, 0x14, 0x17), (0xfc, 0xfc, 0xfa)),
                    }
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            pty_attach,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_ack,
            pty_hold,
            pty_release,
            pty_cwd,
            state_load,
            state_save,
            settings_load,
            settings_save,
            settings_save_schema,
            settings_open,
            scrollback_save,
            scrollback_load,
            scrollback_delete,
            library_add,
            library_search,
            library_content,
            library_remove,
            sys_ssh_hosts,
            sys_git_branch,
            sys_git_status,
            sys_git_branches,
            sys_git_pr,
            sys_list_dirs,
            sys_git_root,
            sys_list_dir,
            sys_read_file,
            sys_project_files,
            sys_write_file,
            sys_git_changes,
            sys_git_diff,
            sys_git_stage,
            sys_git_discard,
            sys_detect_imports,
            sys_is_dir,
            sys_choose_dir,
            sys_choose_image,
            sys_read_image,
            sys_reveal,
            sys_open_external,
            sys_notify,
            sys_confirm,
            sys_copy,
            shell_history,
            shell_complete,
            review_overview,
            review_log,
            review_show,
            review_remote_branches,
            review_pr,
            review_op,
            menu_popup,
            app_set_menu,
            app_set_hotkey,
            app_focus_main,
            app_traffic_lights,
            app_set_zoom,
            app_titlebar_double_click,
            app_ready,
            app_take_folders,
            app_quit,
            app_quit_ready,
            app_quit_cancel,
            quick_loaded,
            quick_hide,
            quick_promote,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Termorc");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            if !st(app).quit.lock().unwrap().ready {
                api.prevent_exit();
                begin_quit(app);
            }
        }
        RunEvent::Exit => cleanup(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => open_folders(app, urls.iter().filter_map(|u| u.to_file_path().ok()).collect()),
        _ => {}
    });
}
