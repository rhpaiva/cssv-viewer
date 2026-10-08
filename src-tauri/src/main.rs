// CSSV Viewer: a desktop shell around <cssv-table>, the reference renderer.
// Each window shows one file. Section numbers refer to the CSSV spec.
//
// The webview loads a file through the cssv: protocol, at a URL that mirrors
// its path, so relative URLs in the style block resolve against the file
// (4.3). The protocol only serves the opened file's folder and the folders
// below it (11.2). Remote loads are blocked in the page itself (ui/viewer.js).

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

/// A window's file: the file, the folder the protocol serves, and the
/// watcher that tells the window when the file changes. Dropping it stops
/// the watcher.
struct Opened {
    path: PathBuf,
    root: PathBuf,
    _watcher: Debouncer<RecommendedWatcher>,
}

#[derive(Default)]
struct Viewer {
    opened: Mutex<HashMap<String, Opened>>,
    /// The folders of the recent files a home window shows previews of.
    previews: Mutex<HashMap<String, HashSet<PathBuf>>>,
    /// Windows sent a file that their page hasn't opened yet.
    pending: Mutex<HashSet<String>>,
    windows: AtomicUsize,
}

/// The file a window shows, if any.
fn file_of(app: &AppHandle, label: &str) -> Option<PathBuf> {
    app.state::<Viewer>().opened.lock().unwrap().get(label).map(|o| o.path.clone())
}

/// The cssv: URL of a file. Webviews on Windows reach custom protocols
/// through http://<scheme>.localhost instead.
fn file_url(path: &Path) -> String {
    let mut url = String::from(if cfg!(windows) { "http://cssv.localhost" } else { "cssv://localhost" });
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

/// The inverse of file_url, from the path of a request URL.
fn url_path(path: &str) -> Option<PathBuf> {
    let decoded = percent_decode_str(path).decode_utf8().ok()?;
    if cfg!(windows) {
        // "/C:/Users/ana/file.cssv"
        Some(PathBuf::from(decoded.trim_start_matches('/').replace('/', "\\")))
    } else {
        Some(PathBuf::from(decoded.as_ref()))
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

/// Serves a file to the window that requested it, if the file lies under that
/// window's root (11.2), or, in a home window, under the folder of a recent
/// file it previews.
fn serve(ctx: UriSchemeContext<'_, tauri::Wry>, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let viewer = ctx.app_handle().state::<Viewer>();
    let label = ctx.webview_label();
    let mut roots: Vec<PathBuf> = viewer.opened.lock().unwrap().get(label).map(|o| o.root.clone()).into_iter().collect();
    roots.extend(viewer.previews.lock().unwrap().get(label).into_iter().flatten().cloned());
    if roots.is_empty() {
        return respond(StatusCode::FORBIDDEN, "text/plain", b"No file is open in this window.".to_vec());
    }
    let Some(path) = url_path(request.uri().path()) else {
        return respond(StatusCode::BAD_REQUEST, "text/plain", b"Malformed path.".to_vec());
    };
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

/// Opens `path` in the calling window: allows its folder on the protocol,
/// watches it for changes, titles the window, and returns the file's URL.
#[tauri::command]
fn open_file(window: WebviewWindow, viewer: tauri::State<'_, Viewer>, path: String) -> Result<String, String> {
    // Whatever the window showed before is gone, even if this file fails.
    viewer.pending.lock().unwrap().remove(window.label());
    viewer.opened.lock().unwrap().remove(window.label());
    viewer.previews.lock().unwrap().remove(window.label());
    let _ = window.set_title("CSSV Viewer");

    let path = std::path::absolute(PathBuf::from(&path)).map_err(|e| e.to_string())?;
    if !path.is_file() {
        return Err(format!("{} is not a file.", path.display()));
    }
    let folder = path.parent().ok_or("The file has no folder.")?;
    let root = std::fs::canonicalize(folder).map_err(|e| e.to_string())?;

    // Editors often save by writing a new file and renaming it over the old
    // one, so watch the folder and pick out this file's events. Opening the
    // file to read it is an event too, so the window only hears of a new
    // version.
    let name = path.file_name().map(|n| n.to_owned());
    let app = window.app_handle().clone();
    let label = window.label().to_string();
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
            let _ = app.emit_to(label.as_str(), "cssv-file-changed", ());
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watcher().watch(folder, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;

    let opened = Opened { path: path.clone(), root, _watcher: watcher };
    viewer.opened.lock().unwrap().insert(window.label().to_string(), opened);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let _ = window.set_title(&format!("{name} — CSSV Viewer"));
    Ok(file_url(&path))
}

/// Saves what the page made (the data as CSV, an image of the table) where
/// the reader chooses. The dialog runs here, so the page can only write to a
/// path the reader picked. The body is the file's bytes; the headers name it.
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
    if let Some(folder) = file_of(window.app_handle(), window.label()).as_deref().and_then(Path::parent) {
        dialog = dialog.set_directory(folder);
    }
    let Some(chosen) = dialog.blocking_save_file() else { return Ok(None) };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("Could not save {}: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Lets a home window read a recent file and its folder, for the file's
/// preview, and returns the file's URL.
#[tauri::command]
fn preview_file(window: WebviewWindow, viewer: tauri::State<'_, Viewer>, path: String) -> Result<String, String> {
    let path = PathBuf::from(&path);
    if !path.is_file() {
        return Err("Not found.".into());
    }
    let folder = path.parent().ok_or("The file has no folder.")?;
    let root = std::fs::canonicalize(folder).map_err(|e| e.to_string())?;
    viewer.previews.lock().unwrap().entry(window.label().to_string()).or_default().insert(root);
    Ok(file_url(&path))
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

/// Shows `path` in a window that has no file yet, or in a new window. The page
/// reads the file to open from its query string.
fn show(app: &AppHandle, path: Option<PathBuf>) {
    let query = path.map(|p| format!("file={}", utf8_percent_encode(&p.to_string_lossy(), NON_ALPHANUMERIC)));
    let viewer = app.state::<Viewer>();
    if let Some(query) = &query {
        let opened = viewer.opened.lock().unwrap();
        let mut pending = viewer.pending.lock().unwrap();
        let empty = app
            .webview_windows()
            .into_values()
            .find(|w| !opened.contains_key(w.label()) && !pending.contains(w.label()));
        if let Some(window) = empty {
            if let Ok(mut url) = window.url() {
                url.set_query(Some(query));
                pending.insert(window.label().to_string());
                let _ = window.navigate(url);
                let _ = window.set_focus();
                return;
            }
        }
    }
    let n = viewer.windows.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("viewer-{n}");
    if query.is_some() {
        viewer.pending.lock().unwrap().insert(label.clone());
    }
    let page = match &query {
        Some(query) => format!("index.html?{query}"),
        None => "index.html".to_string(),
    };
    let built = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title("CSSV Viewer")
        .inner_size(1100.0, 760.0)
        .min_inner_size(420.0, 300.0)
        .zoom_hotkeys_enabled(true)
        .build();
    match built {
        #[cfg(target_os = "linux")]
        Ok(window) => linux::name_prints(&window),
        #[cfg(not(target_os = "linux"))]
        Ok(_) => {}
        Err(error) => eprintln!("Could not open a window: {error}"),
    }
}

/// File paths among command-line arguments, relative to `cwd`.
fn paths_in(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| cwd.join(a))
        .filter(|p| p.is_file())
        .collect()
}

fn main() {
    tauri::Builder::default()
        // Starting the viewer again shows its files, or an empty window, in the
        // running instance.
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
        // Each window opens where and as large as the window with its number
        // was last time (Wayland doesn't let apps place windows).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .manage(Viewer::default())
        .register_uri_scheme_protocol("cssv", serve)
        .invoke_handler(tauri::generate_handler![open_file, preview_file, save_file, quit, integration, set_integration])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let viewer = window.state::<Viewer>();
                viewer.pending.lock().unwrap().remove(window.label());
                viewer.opened.lock().unwrap().remove(window.label());
                viewer.previews.lock().unwrap().remove(window.label());
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
