// CSSV Viewer: a desktop shell around <cssv-table>, the reference renderer.
// The window holds tabs, each showing one file or the home. Section numbers
// refer to the CSSV spec.
//
// A tab loads its file through the cssv: protocol, at a URL made of the tab's
// id and the file's path, so relative URLs in the style block resolve against
// the file (4.3). The protocol serves a tab only its file's folder and the
// folders below it (11.2), leaving out hidden files and folders. The id is
// random and only the tab's page knows it, so a file can't reach the folder
// of another tab's file. Remote loads are blocked in the page itself
// (ui/viewer.js).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
mod linux;

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::ipc::InvokeBody;
use tauri::{AppHandle, Emitter, Manager, UriSchemeContext, UriSchemeResponder, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::StateFlags;

/// Characters kept as they are in a path segment of a cssv: URL.
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

/// The largest file the protocol serves: far more than a table, its
/// stylesheets and its images need, and a link to a larger file doesn't
/// fill the memory.
const MAX_FILE: u64 = 256 * 1024 * 1024;

/// What the protocol serves a tab for one file: the file and its folder,
/// both canonical. The file is the one a tab opened, or a recent file a home
/// tab previews.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Served {
    root: PathBuf,
    file: PathBuf,
}

impl Served {
    fn new(path: &Path) -> Result<Self, String> {
        let folder = path.parent().ok_or("The file has no folder.")?;
        let root = std::fs::canonicalize(folder).map_err(|e| e.to_string())?;
        let file = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        Ok(Served { root, file })
    }
}

/// A tab's file: the file, what the protocol serves for it, and the watcher
/// that tells the tab when the file changes. Dropping it stops the watcher.
struct Opened {
    path: PathBuf,
    served: Served,
    _watcher: Debouncer<RecommendedWatcher>,
}

/// A tab: the window it's in, and what the protocol serves it: its file's
/// folder, or in a home tab the folders of the recent files it previews.
struct Tab {
    window: String,
    opened: Option<Opened>,
    previews: HashSet<Served>,
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
    url_path_for(path, cfg!(windows))
}

/// url_path, for Windows or for the other systems. Nothing reads the disk
/// before this, so it refuses what file_url doesn't make: an empty, "." or
/// ".." segment, one with a slash or NUL in it once decoded, and on Windows
/// one with a backslash or a colon after the drive, or a path that starts at
/// neither a drive nor a network share.
/// A network share ("//host/share/…", from file_url's "\\host\share"
/// prefix) makes Windows connect to that host, sending it the reader's
/// credentials, so read() looks one up only on a share the tab already reads.
fn url_path_for(path: &str, windows: bool) -> Option<(&str, PathBuf)> {
    let (tab, rest) = path.strip_prefix('/')?.split_once('/')?;
    let (share, rest) = match rest.strip_prefix("//") {
        Some(rest) if windows => (true, rest),
        _ => (false, rest),
    };
    let mut names = Vec::new();
    for segment in rest.split('/') {
        let name = percent_decode_str(segment).decode_utf8().ok()?;
        if matches!(&*name, "" | "." | "..") || name.contains(['/', '\0']) || (windows && name.contains('\\')) {
            return None;
        }
        names.push(name);
    }
    if share {
        // "//host/share/folder/file.cssv"; "." and "?" would be the device
        // and verbatim namespaces, not a host.
        if names.len() < 3 || matches!(&*names[0], "." | "?") || names.iter().any(|name| name.contains(':')) {
            return None;
        }
        Some((tab, PathBuf::from(format!("\\\\{}", names.join("\\")))))
    } else if windows {
        // "C:/Users/ana/file.cssv"
        let (drive, names) = names.split_first()?;
        let [letter, b':'] = drive.as_bytes() else { return None };
        if !letter.is_ascii_alphabetic() || names.iter().any(|name| name.contains(':')) {
            return None;
        }
        Some((tab, PathBuf::from(format!("{drive}\\{}", names.join("\\")))))
    } else {
        Some((tab, PathBuf::from(format!("/{}", names.join("/")))))
    }
}

/// The host and share of a Windows network path ("\\host\share\…", or
/// canonical "\\?\UNC\host\share\…"), in lower case as Windows compares
/// them; None for any other path.
fn network_share(path: &Path) -> Option<(String, String)> {
    let path = path.to_string_lossy();
    let rest = path.strip_prefix(r"\\?\UNC\").or_else(|| path.strip_prefix(r"\\").filter(|rest| !rest.starts_with(['?', '.'])))?;
    let mut parts = rest.split('\\');
    let host = parts.next().filter(|host| !host.is_empty())?;
    let share = parts.next().filter(|share| !share.is_empty())?;
    Some((host.to_lowercase(), share.to_lowercase()))
}

/// The reader's home folder, canonical, as the protocol compares paths.
fn home() -> Option<&'static Path> {
    static HOME: OnceLock<Option<PathBuf>> = OnceLock::new();
    HOME.get_or_init(|| {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
        std::fs::canonicalize(home).ok()
    })
    .as_deref()
}

/// Whether a tab may read `path`, a canonical path (11.2): a file it serves
/// (its own file, or a recent file it previews), or a file below such a
/// file's folder, but not in a hidden folder or hidden itself (a file saved
/// in the home folder would otherwise reach ~/.ssh). A folder that is the
/// home folder or holds it (the filesystem's root, /home) serves only the
/// files directly in it.
fn may_read(served: &[Served], path: &Path, home: Option<&Path>) -> Result<(), &'static str> {
    if served.iter().any(|s| s.file == path) {
        return Ok(());
    }
    let mut refusal = "Outside the opened file's folder.";
    for Served { root, .. } in served {
        let Ok(below) = path.strip_prefix(root) else { continue };
        if below.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')) {
            refusal = "Hidden files and folders aren't served.";
        } else if below.components().count() > 1 && (root.parent().is_none() || home.is_some_and(|h| h.starts_with(root))) {
            refusal = "Only the files directly in the home folder are served.";
        } else {
            return Ok(());
        }
    }
    Err(refusal)
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

/// Serves a file to the tab its URL names, on a thread of its own: a large
/// file or a slow disk would otherwise hold up the window.
fn serve(ctx: UriSchemeContext<'_, tauri::Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let window = ctx.webview_label().to_string();
    tauri::async_runtime::spawn_blocking(move || responder.respond(read(&app, &window, request.uri().path())));
}

/// A file for the tab a request path names, if the tab may read it (may_read).
fn read(app: &AppHandle, window: &str, path: &str) -> Response<Cow<'static, [u8]>> {
    let refuse = |status, why: &str| respond(status, "text/plain", why.as_bytes().to_vec());
    let Some((tab, path)) = url_path(path) else {
        return refuse(StatusCode::BAD_REQUEST, "Malformed path.");
    };
    let served: Vec<Served> = match app.state::<Viewer>().tabs.lock().unwrap().get(tab) {
        Some(tab) if tab.window == window => tab.opened.iter().map(|o| o.served.clone()).chain(tab.previews.iter().cloned()).collect(),
        _ => Vec::new(),
    };
    if served.is_empty() {
        return refuse(StatusCode::FORBIDDEN, "No file is open in this tab.");
    }
    // Looking up a path on a network share connects to its host: only on a
    // share the tab already reads from.
    if path.to_string_lossy().starts_with(r"\\")
        && !network_share(&path).is_some_and(|share| served.iter().any(|s| network_share(&s.root).as_ref() == Some(&share)))
    {
        return refuse(StatusCode::FORBIDDEN, "Not on the opened file's network share.");
    }
    let Ok(path) = std::fs::canonicalize(&path) else {
        return refuse(StatusCode::NOT_FOUND, "Not found.");
    };
    if let Err(why) = may_read(&served, &path, home()) {
        return refuse(StatusCode::FORBIDDEN, why);
    }
    // Only a regular file: reading a pipe or a device would never end. The
    // metadata comes without opening it, which for a pipe would wait.
    match std::fs::metadata(&path) {
        Ok(meta) if !meta.is_file() => return refuse(StatusCode::NOT_FOUND, "Not a file."),
        Ok(meta) if meta.len() > MAX_FILE => return refuse(StatusCode::PAYLOAD_TOO_LARGE, "Too large."),
        Ok(_) => {}
        Err(_) => return refuse(StatusCode::NOT_FOUND, "Not found."),
    }
    let mut body = Vec::new();
    match std::fs::File::open(&path).and_then(|file| file.take(MAX_FILE + 1).read_to_end(&mut body)) {
        Ok(_) if body.len() as u64 > MAX_FILE => refuse(StatusCode::PAYLOAD_TOO_LARGE, "Too large."),
        Ok(_) => respond(StatusCode::OK, content_type(&path), body),
        Err(_) => refuse(StatusCode::NOT_FOUND, "Not found."),
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
    let served = Served::new(&path)?;

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
        open.opened = Some(Opened { path: path.clone(), served, _watcher: watcher });
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
/// preview, as a tab reads its own file's (may_read), and returns the file's
/// URL.
#[tauri::command]
fn preview_file(window: WebviewWindow, viewer: tauri::State<'_, Viewer>, tab: String, path: String) -> Result<String, String> {
    valid_tab(&tab)?;
    let path = std::path::absolute(PathBuf::from(&path)).map_err(|e| e.to_string())?;
    if !path.is_file() {
        return Err("Not found.".into());
    }
    let served = Served::new(&path)?;
    let mut tabs = viewer.tabs.lock().unwrap();
    tabs.entry(tab.clone()).or_insert_with(|| Tab::new(window.label())).previews.insert(served);
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
        .register_asynchronous_uri_scheme_protocol("cssv", serve)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_path_round_trips_file_url() {
        let path = Path::new("/home/ana/My Files/büdget #1 100%?.cssv");
        let url = file_url("abc123", path);
        let request = url.strip_prefix("cssv://localhost").unwrap();
        assert_eq!(url_path_for(request, false), Some(("abc123", path.to_path_buf())));
        // A colon is a file name's on Linux and macOS.
        assert_eq!(url_path_for("/abc/home/ana/a%3Ab.css", false), Some(("abc", PathBuf::from("/home/ana/a:b.css"))));
    }

    #[test]
    fn url_path_maps_a_drive_on_windows() {
        assert_eq!(
            url_path_for("/abc/C:/Users/ana/My%20Files/b%C3%BCdget.cssv", true),
            Some(("abc", PathBuf::from("C:\\Users\\ana\\My Files\\büdget.cssv")))
        );
        assert_eq!(url_path_for("/abc/d:/x.cssv", true), Some(("abc", PathBuf::from("d:\\x.cssv"))));
    }

    #[test]
    fn url_path_refuses_what_file_url_does_not_make() {
        for windows in [false, true] {
            for path in [
                "/abc",                       // no file
                "/abc/",                      // empty segment
                "/abc/C:/a/../b.css",
                "/abc/C:/a/%2e%2e/b.css",
                "/abc/C:/a/%2E./b.css",
                "/abc/C:/a/./b.css",
                "/abc/C:/a//b.css",
                "/abc/C:/a/",
                "/abc/C:/a%2F..%2Fb.css",
                "/abc/C:/a%00.css",
                "/abc/C:/%FF.css", // not UTF-8
            ] {
                assert_eq!(url_path_for(path, windows), None, "{path} (windows: {windows})");
            }
        }
        for path in [
            "/abc/%5C%5Chost/share/x.css",
            "/abc/%5Chost/x.css",
            "/abc///host/share",          // a share, but no file
            "/abc////host/share/x.css",   // an empty segment
            "/abc///./pipe/x",            // the device namespace
            "/abc///%3F/UNC/host/share/x.css",
            "/abc///host/share/C:x.css",
            "/abc/C:/a%5Cb.css",
            "/abc/host/share/x.css",  // no drive
            "/abc/CC:/x.css",
            "/abc/1:/x.css",
            "/abc/C%3A/x.css%3Astream", // an alternate data stream
            "/abc/C:/x.css:stream",
        ] {
            assert_eq!(url_path_for(path, true), None, "{path}");
        }
        // A network share is Windows only; elsewhere "//" is an empty segment.
        assert_eq!(url_path_for("/abc///host/share/x.css", false), None);
        // Elsewhere a backslash is an ordinary character in a file name.
        assert_eq!(url_path_for("/abc/home/a%5Cb.css", false), Some(("abc", PathBuf::from("/home/a\\b.css"))));
    }

    #[test]
    fn url_path_maps_a_network_share_on_windows() {
        assert_eq!(
            url_path_for("/abc///files/team/budget%20q1/b.cssv", true),
            Some(("abc", PathBuf::from(r"\\files\team\budget q1\b.cssv")))
        );
    }

    #[test]
    fn network_share_reads_host_and_share() {
        let share = |s: &str| network_share(Path::new(s));
        let files = Some(("files".to_string(), "team".to_string()));
        assert_eq!(share(r"\\files\team\b.cssv"), files);
        assert_eq!(share(r"\\?\UNC\Files\TEAM\sub\b.cssv"), files);
        for path in [r"\\.\pipe\x", r"\\?\C:\x", r"C:\x", "/home/x", r"\\files", r"\\\\files\team"] {
            assert_eq!(share(path), None, "{path}");
        }
    }

    fn served(root: &str, file: &str) -> Served {
        Served { root: PathBuf::from(root), file: PathBuf::from(file) }
    }

    #[test]
    fn may_read_serves_the_folder_below_the_file() {
        let tab = [served("/home/ana/tables", "/home/ana/tables/budget.cssv")];
        let home = Some(Path::new("/home/ana"));
        assert_eq!(may_read(&tab, Path::new("/home/ana/tables/budget.cssv"), home), Ok(()));
        assert_eq!(may_read(&tab, Path::new("/home/ana/tables/brand.css"), home), Ok(()));
        assert_eq!(may_read(&tab, Path::new("/home/ana/tables/fonts/a.woff2"), home), Ok(()));
        assert!(may_read(&tab, Path::new("/home/ana/tables/.git/config"), home).is_err());
        assert!(may_read(&tab, Path::new("/home/ana/tables/.env"), home).is_err());
        assert!(may_read(&tab, Path::new("/home/ana/brand.css"), home).is_err());
        assert!(may_read(&tab, Path::new("/home/ana/tablesx/a.css"), home).is_err());
    }

    #[test]
    fn may_read_serves_only_the_top_of_the_home_folder() {
        let home = Some(Path::new("/home/ana"));
        let tab = [served("/home/ana", "/home/ana/.budget.cssv")];
        assert_eq!(may_read(&tab, Path::new("/home/ana/.budget.cssv"), home), Ok(())); // the file itself
        assert_eq!(may_read(&tab, Path::new("/home/ana/brand.css"), home), Ok(()));
        assert!(may_read(&tab, Path::new("/home/ana/.ssh/id_ed25519"), home).is_err());
        assert!(may_read(&tab, Path::new("/home/ana/.bashrc"), home).is_err());
        assert!(may_read(&tab, Path::new("/home/ana/Documents/a.png"), home).is_err());
        // The filesystem's root, and a folder that holds the home folder.
        for (root, file) in [("/", "/x.cssv"), ("/home", "/home/x.cssv")] {
            let tab = [served(root, file)];
            assert_eq!(may_read(&tab, &Path::new(root).join("a.css"), home), Ok(()));
            assert!(may_read(&tab, Path::new("/home/ana/a.css"), home).is_err());
        }
        assert!(may_read(&[served("/", "/x.cssv")], Path::new("/etc/passwd"), home).is_err());
        // Without a home folder, a folder below the root serves its folders.
        assert_eq!(may_read(&[served("/home", "/home/x.cssv")], Path::new("/home/ana/a.css"), None), Ok(()));
    }

    #[test]
    fn may_read_takes_any_folder_a_home_tab_previews() {
        let home = Some(Path::new("/home/ana"));
        let tab = [served("/home/ana", "/home/ana/a.cssv"), served("/home/ana/data", "/home/ana/data/b.cssv")];
        assert_eq!(may_read(&tab, Path::new("/home/ana/data/img/x.png"), home), Ok(()));
        assert!(may_read(&tab, Path::new("/home/ana/other/x.png"), home).is_err());
        assert!(may_read(&tab, Path::new("/home/ana/data/.cache/x.png"), home).is_err());
    }
}
