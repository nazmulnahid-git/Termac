// The few AppKit calls Tauri doesn't wrap. Each one must run on the main thread.
use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage, NSPasteboard, NSPasteboardTypeString, NSWindow, NSWindowButton, NSWindowCollectionBehavior};
use objc2_foundation::{NSData, NSString, NSUserDefaults};
use tauri::{Runtime, WebviewWindow};

fn with_ns_window<R: Runtime>(window: &WebviewWindow<R>, f: impl FnOnce(&NSWindow) + Send + 'static) {
    let Ok(ptr) = window.ns_window() else { return };
    let ptr = ptr as usize;
    let _ = window.run_on_main_thread(move || {
        // Safety: Tauri hands out the window's live NSWindow, and we're on the main thread.
        let ns_window = unsafe { &*(ptr as *const NSWindow) };
        f(ns_window);
    });
}

pub fn set_traffic_lights_visible<R: Runtime>(window: &WebviewWindow<R>, visible: bool) {
    with_ns_window(window, move |w| {
        for kind in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton] {
            if let Some(button) = w.standardWindowButton(kind) {
                button.setHidden(!visible);
            }
        }
    });
}

// The Quick Terminal drops down over full-screen apps on whichever Space is active.
pub fn float_on_all_spaces<R: Runtime>(window: &WebviewWindow<R>) {
    with_ns_window(window, |w| {
        w.setCollectionBehavior(
            w.collectionBehavior() | NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    });
}

// Double-clicking a title bar does what System Settings › Desktop & Dock says.
pub fn titlebar_double_click<R: Runtime>(window: &WebviewWindow<R>) {
    with_ns_window(window, |w| {
        let action = NSUserDefaults::standardUserDefaults()
            .stringForKey(&NSString::from_str("AppleActionOnDoubleClick"))
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Maximize".into());
        match action.as_str() {
            "Minimize" => w.miniaturize(None),
            "None" => {}
            _ => w.zoom(None),
        }
    });
}

pub fn copy_text(text: &str) {
    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    // Safety: a constant AppKit exports.
    pb.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString });
}

// An unbundled dev build would otherwise show a generic icon in the Dock.
pub fn set_dock_icon(png: &'static [u8]) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let data = NSData::with_bytes(png);
    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
    }
}
