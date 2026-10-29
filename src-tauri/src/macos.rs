// The few AppKit calls Tauri doesn't wrap. Each one must run on the main thread.
use objc2::rc::Retained;
use objc2::runtime::NSObject;
use objc2::{define_class, msg_send, AllocAnyThread, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext, NSImage, NSImageSymbolConfiguration, NSPasteboard,
    NSPasteboardTypeString, NSUpdateDynamicServices, NSWindow, NSWindowButton, NSWindowCollectionBehavior,
};
use objc2_foundation::{NSData, NSDictionary, NSPoint, NSRect, NSString, NSURL, NSUserDefaults};
use std::sync::OnceLock;
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

// ---- SF Symbols --------------------------------------------------------------------------
// The chrome's icons are SF Symbols, drawn by AppKit at the screen's scale into PNGs. The
// page uses them as masks, so they take the color of the text around them.
pub struct Symbol {
    pub png: Vec<u8>,
    pub width: f64,
    pub height: f64,
}

// `weight` is an NSFontWeight (regular 0, medium 0.23, semibold 0.3); `scale` is pixels per point.
pub fn render_symbol(name: &str, size: f64, weight: f64, scale: f64) -> Option<Symbol> {
    let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(&NSString::from_str(name), None)?;
    let image = image.imageWithSymbolConfiguration(&NSImageSymbolConfiguration::configurationWithPointSize_weight(size, weight))?;
    let pt = image.size();
    let (w, h) = ((pt.width * scale).ceil() as isize, (pt.height * scale).ceil() as isize);
    // Safety: null planes make AppKit allocate the buffer; a constant AppKit exports.
    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            w,
            h,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            0,
            0,
        )
    }?;
    rep.setSize(pt);
    let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&ctx));
    image.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), pt));
    ctx.flushGraphics();
    NSGraphicsContext::restoreGraphicsState_class();
    // Safety: an empty properties dictionary.
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
    Some(Symbol { png: png.to_vec(), width: pt.width, height: pt.height })
}

// ---- Finder service ------------------------------------------------------------------------
// "New Termorc Tab Here" in Finder's right-click Services menu. Info.plist declares the
// service (NSMessage openFolder); this object receives the folders Finder hands over.
static OPEN_FOLDERS: OnceLock<Box<dyn Fn(Vec<String>) + Send + Sync>> = OnceLock::new();

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class doesn't implement Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TermorcServiceProvider"]
    struct ServiceProvider;

    impl ServiceProvider {
        #[unsafe(method(openFolder:userData:error:))]
        fn open_folder(&self, pboard: &NSPasteboard, _user_data: Option<&NSString>, _error: *mut std::ffi::c_void) {
            let file_url = NSString::from_str("public.file-url");
            let mut paths = Vec::new();
            for item in pboard.pasteboardItems().map(|a| a.to_vec()).unwrap_or_default() {
                let Some(url) = item.stringForType(&file_url) else { continue };
                if let Some(path) = NSURL::URLWithString(&url).and_then(|u| u.path()) {
                    paths.push(path.to_string());
                }
            }
            if let Some(open) = OPEN_FOLDERS.get() {
                open(paths);
            }
        }
    }
);

pub fn register_services(open: impl Fn(Vec<String>) + Send + Sync + 'static) {
    let _ = OPEN_FOLDERS.set(Box::new(open));
    let Some(mtm) = MainThreadMarker::new() else { return };
    let provider: Retained<ServiceProvider> = unsafe { msg_send![ServiceProvider::alloc(mtm), init] };
    unsafe { NSApplication::sharedApplication(mtm).setServicesProvider(Some(&provider)) };
    // NSApp keeps only a weak reference; the provider lives as long as the app.
    std::mem::forget(provider);
    NSUpdateDynamicServices();
}
