// CSSV Viewer: a desktop shell around <cssv-table>, the reference renderer.
// The window holds tabs, each showing one file or the home. Section numbers
// refer to the CSSV spec.
//
// A tab loads its file through the cssv: protocol, at a URL made of the tab's
// id and the file's path, so relative URLs in the style block resolve against
// the file (4.3). The protocol serves a tab only its file's folder and the
// folders below it (11.2). The id is random and only the tab's page knows it,
// so a file can't reach the folder of another tab's file. Remote loads are
// blocked in the page itself (ui/viewer.js).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
mod linux;

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::ipc::InvokeBody;
use tauri::{AppHandle, Emitter, Manager, UriSchemeContext, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::StateFlags;

/// Characters kept as they are in a path segment of a cssv: URL.
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

/// A tab's file: the file, the folder the protocol serves, and the watcher
/// that tells the tab when the file changes. Dropping it stops the watcher.
struct Opened {
    path: PathBuf,
    root: PathBuf,
    _watcher: Debouncer<RecommendedWatcher>,
}

/// A tab: the window it's in, and what the protocol serves it: its file's
/// folder, or in a home tab the folders of the recent files it previews.
struct Tab {
    window: String,
    opened: Option<Opened>,
    previews: HashSet<PathBuf>,
}

impl Tab {
    fn new(window: &str) -> Self {
        Tab { window: window.to_string(), opened: None, previews: HashSet::new() }
    }
}

#[derive(Default)]
struct Viewer {
    /// The tabs, by the id the window's page gave them.
    tabs: Mutex<HashMap<String, Tab>>,
    /// The tab whose print preview each window shows, and the page it set up.
    pages: Mutex<HashMap<String, (String, Page)>>,
    /// The files each window has yet to open in tabs; None asks for the home.
    opens: Mutex<HashMap<String, Vec<Option<PathBuf>>>>,
    windows: AtomicUsize,
}

/// A tab id the page made: letters and digits, so it fits in a URL as it is.
fn valid_tab(tab: &str) -> Result<(), String> {
    if !tab.is_empty() && tab.len() <= 64 && tab.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        Err("Malformed tab id.".into())
    }
}

/// The file a tab shows, if any.
fn file_of(app: &AppHandle, tab: &str) -> Option<PathBuf> {
    let viewer = app.state::<Viewer>();
    let tabs = viewer.tabs.lock().unwrap();
    tabs.get(tab)?.opened.as_ref().map(|o| o.path.clone())
}

/// The paper the print preview chose: "a4" or "letter", its orientation, and
/// the margins in millimeters.
#[derive(Clone, serde::Deserialize)]
pub struct Page {
    pub paper: String,
    pub landscape: bool,
    pub margin: f64,
}

/// What a window prints: the page its print preview set up, and the file of
/// the tab it's in.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn printing(app: &AppHandle, label: &str) -> Option<(Page, Option<PathBuf>)> {
    let (tab, page) = app.state::<Viewer>().pages.lock().unwrap().get(label).cloned()?;
    Some((page, file_of(app, &tab)))
}

/// The cssv: URL of a file, for a tab. Webviews on Windows reach custom
/// protocols through http://<scheme>.localhost instead.
fn file_url(tab: &str, path: &Path) -> String {
    let mut url = String::from(if cfg!(windows) { "http://cssv.localhost/" } else { "cssv://localhost/" });
    url.push_str(tab);
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => url.push_str(&format!("/{}", prefix.as_os_str().to_string_lossy())),
            Component::Normal(name) => {
                url.push('/');
                url.extend(utf8_percent_encode(&name.to_string_lossy(), SEGMENT));
            }
            _ => {}
        }
    }
    url
}

/// The inverse of file_url, from the path of a request URL: the tab and the file.
fn url_path(path: &str) -> Option<(&str, PathBuf)> {
    let (tab, rest) = path.strip_prefix('/')?.split_once('/')?;
    let decoded = percent_decode_str(rest).decode_utf8().ok()?;
    if cfg!(windows) {
        // "C:/Users/ana/file.cssv"
        Some((tab, PathBuf::from(decoded.replace('/', "\\"))))
    } else {
        Some((tab, PathBuf::from(format!("/{decoded}"))))
    }
}

fn content_type(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "cssv" | "csv" | "txt" => "text/plain; charset=utf-8", // 3.3
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

fn respond(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        // The page (tauri://localhost) reads files with fetch(), which is cross-origin.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(body))
        .unwrap()
}

/// Serves a file to the tab its URL names, if the file lies under that tab's
/// root (11.2), or, in a home tab, under the folder of a recent file it
/// previews.
fn serve(ctx: UriSchemeContext<'_, tauri::Wry>, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let Some((tab, path)) = url_path(request.uri().path()) else {
        return respond(StatusCode::BAD_REQUEST, "text/plain", b"Malformed path.".to_vec());
    };
    let roots: Vec<PathBuf> = match ctx.app_handle().state::<Viewer>().tabs.lock().unwrap().get(tab) {
        Some(tab) if tab.window == ctx.webview_label() => tab.opened.iter().map(|o| o.root.clone()).chain(tab.previews.iter().cloned()).collect(),
        _ => Vec::new(),
    };
    if roots.is_empty() {
        return respond(StatusCode::FORBIDDEN, "text/plain", b"No file is open in this tab.".to_vec());
    }
    let Ok(path) = std::fs::canonicalize(&path) else {
        return respond(StatusCode::NOT_FOUND, "text/plain", b"Not found.".to_vec());
    };
    if !roots.iter().any(|root| path.starts_with(root)) {
        return respond(StatusCode::FORBIDDEN, "text/plain", b"Outside the opened file's folder.".to_vec());
    }
    match std::fs::read(&path) {
        Ok(body) => respond(StatusCode::OK, content_type(&path), body),
        Err(_) => respond(StatusCode::NOT_FOUND, "text/plain", b"Not found.".to_vec()),
    }
}

/// The file's modification time and size, or None while it is missing
/// (mid-save). Reading them doesn't open the file, which would be an event.
fn version(path: &Path) -> Option<(std::time::SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// Opens `path` in a tab: allows its folder on the protocol, watches it for
/// changes, and returns the file's URL.
#[tauri::command]
fn open_file(window: WebviewWindow, viewer: tauri::State<'_, Viewer>, tab: String, path: String) -> Result<String, String> {
    valid_tab(&tab)?;
    // Whatever the tab showed before is gone, even if this file fails.
    viewer.tabs.lock().unwrap().insert(tab.clone(), Tab::new(window.label()));

    let path = std::path::absolute(PathBuf::from(&path)).map_err(|e| e.to_string())?;
    if !path.is_file() {
        return Err(format!("{} is not a file.", path.display()));
    }
    let folder = path.parent().ok_or("The file has no folder.")?;
    let root = std::fs::canonicalize(folder).map_err(|e| e.to_string())?;

    // Editors often save by writing a new file and renaming it over the old
    // one, so watch the folder and pick out this file's events. Opening the
    // file to read it is an event too, so the tab only hears of a new
    // version.
    let name = path.file_name().map(|n| n.to_owned());
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let changed = tab.clone();
    let watched = path.clone();
    let mut last = version(&path);
    let mut watcher = new_debouncer(Duration::from_millis(150), move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        if !events.iter().any(|e| e.path.file_name() == name.as_deref()) {
            return;
        }
        let now = version(&watched);
        if now.is_some() && now != last {
            last = now;
            let _ = app.emit_to(label.as_str(), "cssv-file-changed", &changed);
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watcher().watch(folder, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;

    // A tab closed meanwhile drops the watcher with it.
    if let Some(open) = viewer.tabs.lock().unwrap().get_mut(&tab) {
        open.opened = Some(Opened { path: path.clone(), root, _watcher: watcher });
    }
    Ok(file_url(&tab, &path))
}

/// Forgets a closed tab: its folder is no longer served, nor its file watched.
#[tauri::command]
fn close_tab(viewer: tauri::State<'_, Viewer>, tab: String) {
    viewer.tabs.lock().unwrap().remove(&tab);
    viewer.pages.lock().unwrap().retain(|_, (printing, _)| *printing != tab);
}

/// The files the window has been asked to open since it last asked, in order;
/// None asks for the home.
#[tauri::command]
fn take_opens(window: WebviewWindow, viewer: tauri::State<'_, Viewer>) -> Vec<Option<String>> {
    let opens = viewer.opens.lock().unwrap().remove(window.label()).unwrap_or_default();
    opens.into_iter().map(|path| path.map(|p| p.to_string_lossy().into_owned())).collect()
}

/// Saves what the page made (the data as CSV, an image of the table) where
/// the reader chooses. The dialog runs here, so the page can only write to a
/// path the reader picked. The body is the file's bytes; the headers name it
/// and the tab it comes from, whose file's folder the dialog starts in.
/// Returns the path written, or None if the reader cancelled.
#[tauri::command]
async fn save_file(window: WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file's bytes.".into());
    };
    let header = |name: &str| {
        let value = request.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("");
        percent_decode_str(value).decode_utf8_lossy().into_owned()
    };
    let (name, kind, ext) = (header("x-name"), header("x-kind"), header("x-ext"));
    let mut dialog = window.dialog().file().set_parent(&window).set_file_name(&name).add_filter(&kind, &[ext.as_str()]);
    if let Some(folder) = file_of(window.app_handle(), &header("x-tab")).as_deref().and_then(Path::parent) {
        dialog = dialog.set_directory(folder);
    }
    let Some(chosen) = dialog.blocking_save_file() else { return Ok(None) };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("Could not save {}: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Lets a home tab read a recent file and its folder, for the file's
/// preview, and returns the file's URL.
#[tauri::command]
fn preview_file(window: WebviewWindow, viewer: tauri::State<'_, Viewer>, tab: String, path: String) -> Result<String, String> {
    valid_tab(&tab)?;
    let path = PathBuf::from(&path);
    if !path.is_file() {
        return Err("Not found.".into());
    }
    let folder = path.parent().ok_or("The file has no folder.")?;
    let root = std::fs::canonicalize(folder).map_err(|e| e.to_string())?;
    let mut tabs = viewer.tabs.lock().unwrap();
    tabs.entry(tab.clone()).or_insert_with(|| Tab::new(window.label())).previews.insert(root);
    Ok(file_url(&tab, &path))
}

/// Keeps the print preview's page, and the tab it shows, for the print
/// dialog, which on Linux takes its paper and orientation from GTK rather
/// than from @page.
#[tauri::command]
fn set_page(window: WebviewWindow, viewer: tauri::State<'_, Viewer>, tab: String, page: Page) {
    viewer.pages.lock().unwrap().insert(window.label().to_string(), (tab, page));
}

/// Quits the viewer, closing every window.
#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Whether this copy of the viewer can open .cssv files from the desktop, and
/// whether it does (Linux, run as an AppImage; installers do this elsewhere).
#[tauri::command]
fn integration() -> Integration {
    #[cfg(target_os = "linux")]
    return linux::status();
    #[cfg(not(target_os = "linux"))]
    Integration::default()
}

#[tauri::command]
fn set_integration(on: bool) -> Result<Integration, String> {
    #[cfg(target_os = "linux")]
    {
        if on { linux::install()? } else { linux::remove()? }
        Ok(linux::status())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = on;
        Err("Only the Linux AppImage sets this up itself.".into())
    }
}

#[derive(Default, serde::Serialize)]
pub struct Integration {
    available: bool,
    installed: bool,
}

/// Shows `path` in a tab of the viewer's window, or the home when `path` is
/// None, making the window if there is none. The window's page takes the
/// files from `opens` when it starts, and when told that there are more.
fn show(app: &AppHandle, path: Option<PathBuf>) {
    let viewer = app.state::<Viewer>();
    if let Some(window) = app.webview_windows().into_values().next() {
        viewer.opens.lock().unwrap().entry(window.label().to_string()).or_default().push(path);
        let _ = window.emit_to(window.label(), "cssv-open", ());
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let n = viewer.windows.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("viewer-{n}");
    viewer.opens.lock().unwrap().insert(label.clone(), vec![path]);
    let built = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("CSSV Viewer")
        .inner_size(1100.0, 760.0)
        .min_inner_size(420.0, 300.0)
        .zoom_hotkeys_enabled(true)
        .build();
    match built {
        #[cfg(target_os = "linux")]
        Ok(window) => linux::prepare_prints(&window),
        #[cfg(not(target_os = "linux"))]
        Ok(_) => {}
        Err(error) => eprintln!("Could not open a window: {error}"),
    }
}

/// File paths among command-line arguments, relative to `cwd`. They're made
/// absolute without following links, so a file opened twice is found open.
fn paths_in(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| std::path::absolute(cwd.join(a)).ok())
        .filter(|p| p.is_file())
        .collect()
}

fn main() {
    tauri::Builder::default()
        // Starting the viewer again shows its files, or the home, in the
        // running instance's window.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = paths_in(args.into_iter().skip(1), Path::new(&cwd));
            if paths.is_empty() {
                show(app, None);
            }
            for path in paths {
                show(app, Some(path));
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // The window opens where and as large as it was last time (Wayland
        // doesn't let apps place windows).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .manage(Viewer::default())
        .register_uri_scheme_protocol("cssv", serve)
        .invoke_handler(tauri::generate_handler![
            open_file, close_tab, take_opens, preview_file, save_file, set_page, quit, integration, set_integration
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let viewer = window.state::<Viewer>();
                viewer.tabs.lock().unwrap().retain(|_, tab| tab.window != window.label());
                viewer.pages.lock().unwrap().remove(window.label());
                viewer.opens.lock().unwrap().remove(window.label());
            }
        })
        .setup(|app| {
            #[cfg(target_os = "linux")]
            linux::refresh();
            let cwd = std::env::current_dir().unwrap_or_default();
            let paths = paths_in(std::env::args().skip(1), &cwd);
            // Started without files: the home, with the recent ones.
            if paths.is_empty() {
                show(app.handle(), None);
            }
            for path in paths {
                show(app.handle(), Some(path));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the CSSV Viewer")
        .run(|_app, _event| {
            // On macOS, Finder opens files through an event rather than the
            // command line, and clicking the Dock icon with every window
            // closed asks for a window.
            #[cfg(target_os = "macos")]
            match _event {
                tauri::RunEvent::Opened { urls } => {
                    for url in urls {
                        if let Ok(path) = url.to_file_path() {
                            show(_app, Some(path));
                        }
                    }
                }
                tauri::RunEvent::Reopen { has_visible_windows: false, .. } => show(_app, None),
                _ => {}
            }
        });
}
