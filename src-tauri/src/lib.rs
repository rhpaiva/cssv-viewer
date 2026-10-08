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
//
// What the viewer decides lives in `Viewer` and plain functions, which the
// unit tests (tests.rs) run without a window. The Tauri commands and the rest
// of `run` only hand the window's requests to them; the tests in test/e2e run
// those in the real app.

#![cfg_attr(coverage_nightly, feature(coverage_attribute))]

#[cfg(target_os = "linux")]
mod linux;
#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use tauri::http::{header, HeaderMap, Request, Response, StatusCode};
use tauri::ipc::InvokeBody;
use tauri::{AppHandle, Emitter, Manager, State, UriSchemeContext, UriSchemeResponder, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::StateFlags;

/// Characters kept as they are in a path segment of a cssv: URL.
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

/// The start of every cssv: URL. Webviews on Windows reach custom protocols
/// through http://<scheme>.localhost instead.
#[cfg(windows)]
const PROTOCOL: &str = "http://cssv.localhost/";
#[cfg(not(windows))]
const PROTOCOL: &str = "cssv://localhost/";

/// The variable that names the reader's home folder.
#[cfg(windows)]
const HOME: &str = "USERPROFILE";
#[cfg(not(windows))]
const HOME: &str = "HOME";

/// The largest file the protocol serves: far more than a table, its
/// stylesheets and its images need, and a link to a larger file doesn't
/// fill the memory.
const MAX_FILE: u64 = 256 * 1024 * 1024;

/// What the protocol serves a tab for one file: the file and its folder,
/// both canonical. The file is the one a tab opened, or a recent file a home
/// tab previews.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Served {
    root: PathBuf,
    file: PathBuf,
}

impl Served {
    fn new(path: &Path) -> Result<Self, String> {
        let folder = path.parent().ok_or("The file has no folder.")?;
        let root = std::fs::canonicalize(folder).map_err(error_text)?;
        let file = std::fs::canonicalize(path).map_err(error_text)?;
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

/// The paper the print preview chose: "a4" or "letter", its orientation, and
/// the margins in millimeters.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct Page {
    paper: String,
    landscape: bool,
    margin: f64,
}

/// A paper size as GTK names it: a standard one, or a custom one with its
/// name, the name shown, and its width and height in millimeters.
#[derive(Debug, PartialEq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
enum Paper {
    Standard(&'static str),
    Custom(String, String, f64, f64),
}

/// How a window prints (linux.rs): the print settings that name the PDF
/// "Print to File" writes, and the page.
#[derive(Debug, PartialEq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct Print {
    settings: Vec<(&'static str, String)>,
    paper: Paper,
    margin: f64,
}

/// The paper for a page. WebKitGTK prints a landscape page blank, so
/// landscape is a portrait page that is wider than it is tall.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn paper(page: &Page) -> Paper {
    let (name, width, height) = if page.paper == "letter" { ("na_letter", 215.9, 279.4) } else { ("iso_a4", 210.0, 297.0) };
    if page.landscape {
        Paper::Custom(format!("{name}-wide"), format!("{name} landscape"), height, width)
    } else {
        Paper::Standard(name)
    }
}

/// A file the page saves (`save_file`): its bytes, and from the request's
/// headers its name, the kind of file and the extension for the dialog's
/// filter, and the tab it comes from.
#[derive(Debug, PartialEq)]
struct Save<'a> {
    bytes: &'a [u8],
    name: String,
    kind: String,
    ext: String,
    tab: String,
}

impl<'a> Save<'a> {
    fn new(body: &'a InvokeBody, headers: &HeaderMap) -> Result<Self, String> {
        let InvokeBody::Raw(bytes) = body else {
            return Err("Expected the file's bytes.".into());
        };
        let header = |name: &str| {
            let value = headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("");
            percent_decode_str(value).decode_utf8_lossy().into_owned()
        };
        Ok(Save { bytes, name: header("x-name"), kind: header("x-kind"), ext: header("x-ext"), tab: header("x-tab") })
    }

    /// Writes the file at the path the reader chose, and returns the path.
    fn write(&self, path: &Path) -> Result<Option<String>, String> {
        std::fs::write(path, self.bytes).map_err(|e| format!("Could not save {}: {e}", path.display()))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }
}

/// A tab's file as its watcher sees it: the file, and the version the tab
/// last heard of.
struct Watched {
    path: PathBuf,
    last: Option<(SystemTime, u64)>,
}

impl Watched {
    fn new(path: &Path) -> Self {
        Watched { path: path.to_path_buf(), last: version(path) }
    }

    /// Whether the watcher's events bring a new version of the file. Editors
    /// often save by writing a new file and renaming it over the old one, so
    /// the watcher watches the folder, and this picks out the file's events.
    /// Opening the file to read it is an event too, so only a new version
    /// counts.
    fn changed(&mut self, result: DebounceEventResult) -> bool {
        let Ok(events) = result else { return false };
        if !events.iter().any(|e| e.path.file_name() == self.path.file_name()) {
            return false;
        }
        let now = version(&self.path);
        if now.is_some() && now != self.last {
            self.last = now;
            return true;
        }
        false
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

impl Viewer {
    /// The file a tab shows, if any.
    fn file_of(&self, tab: &str) -> Option<PathBuf> {
        let tabs = self.tabs.lock().unwrap();
        tabs.get(tab)?.opened.as_ref().map(|o| o.path.clone())
    }

    /// Opens `path` in a tab of `window`: allows its folder on the protocol,
    /// calls `changed` for each new version of the file, and returns the
    /// file's URL.
    fn open(&self, window: &str, tab: &str, path: &str, changed: Box<dyn Fn() + Send>) -> Result<String, String> {
        valid_tab(tab)?;
        let mut tabs = self.tabs.lock().unwrap();
        // Whatever the tab showed before is gone, even if this file fails.
        let entry = tabs.entry(tab.to_string()).insert_entry(Tab::new(window));
        let path = std::path::absolute(path).map_err(error_text)?;
        if !path.is_file() {
            return Err(format!("{} is not a file.", path.display()));
        }
        let served = Served::new(&path)?;
        let mut file = Watched::new(&path);
        let mut watcher = new_debouncer(Duration::from_millis(150), move |result| {
            if file.changed(result) {
                changed();
            }
        })
        .map_err(error_text)?;
        watcher.watcher().watch(&served.root, RecursiveMode::NonRecursive).map_err(error_text)?;
        entry.into_mut().opened = Some(Opened { path: path.clone(), served, _watcher: watcher });
        Ok(file_url(tab, &path))
    }

    /// Lets a home tab read a recent file and its folder, for the file's
    /// preview, as a tab reads its own file's (`may_read`), and returns the
    /// file's URL.
    fn preview(&self, window: &str, tab: &str, path: &str) -> Result<String, String> {
        valid_tab(tab)?;
        let path = std::path::absolute(path).map_err(error_text)?;
        if !path.is_file() {
            return Err("Not found.".into());
        }
        let served = Served::new(&path)?;
        let mut tabs = self.tabs.lock().unwrap();
        tabs.entry(tab.to_string()).or_insert_with(|| Tab::new(window)).previews.insert(served);
        Ok(file_url(tab, &path))
    }

    /// Forgets a closed tab: its folder is no longer served, nor its file watched.
    fn close(&self, tab: &str) {
        self.tabs.lock().unwrap().remove(tab);
        self.pages.lock().unwrap().retain(|_, (printing, _)| printing != tab);
    }

    /// Keeps the print preview's page, and the tab it shows, for the print
    /// dialog, which on Linux takes its paper and orientation from GTK rather
    /// than from @page.
    fn set_page(&self, window: &str, tab: String, page: Page) {
        self.pages.lock().unwrap().insert(window.to_string(), (tab, page));
    }

    /// What a window prints: the page its print preview set up, and the PDF
    /// named after the file of the tab it's in, in the file's folder
    /// (budget.cssv prints to budget.pdf; GTK otherwise picks "output" in
    /// Documents, or in the current folder, which in an AppImage is
    /// read-only). The folder is a path, not a URI: GTK 3.24 joins it with
    /// the file name.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    fn printing(&self, window: &str) -> Option<Print> {
        let (tab, page) = self.pages.lock().unwrap().get(window).cloned()?;
        let settings = match self.file_of(&tab) {
            Some(file) => vec![
                ("output-basename", file.file_stem().unwrap_or_default().to_string_lossy().into_owned()),
                ("output-dir", file.parent().unwrap_or(&file).to_string_lossy().into_owned()),
            ],
            None => Vec::new(),
        };
        Some(Print { settings, paper: paper(&page), margin: page.margin })
    }

    /// Asks a window's page to show `path` in a tab, or the home when `path`
    /// is None.
    fn queue(&self, window: &str, path: Option<PathBuf>) {
        self.opens.lock().unwrap().entry(window.to_string()).or_default().push(path);
    }

    /// The label of a new window, whose page shows `path` when it starts.
    fn new_window(&self, path: Option<PathBuf>) -> String {
        let n = self.windows.fetch_add(1, Ordering::Relaxed) + 1;
        let label = format!("viewer-{n}");
        self.opens.lock().unwrap().insert(label.clone(), vec![path]);
        label
    }

    /// The files a window has been asked to open since it last asked, in
    /// order; None asks for the home.
    fn take_opens(&self, window: &str) -> Vec<Option<String>> {
        let opens = self.opens.lock().unwrap().remove(window).unwrap_or_default();
        opens.into_iter().map(|path| path.map(|p| p.to_string_lossy().into_owned())).collect()
    }

    /// Forgets a closed window: its tabs, its print preview and the files it
    /// had yet to open.
    fn forget(&self, window: &str) {
        self.tabs.lock().unwrap().retain(|_, tab| tab.window != window);
        self.pages.lock().unwrap().remove(window);
        self.opens.lock().unwrap().remove(window);
    }

    /// A file for the tab a request path names, if the tab may read it (`may_read`).
    fn read(&self, window: &str, path: &str) -> Response<Cow<'static, [u8]>> {
        self.read_at(window, url_path(path), home(), MAX_FILE)
    }

    /// `read`, for the tab and the path `url_path` made of the request, with
    /// the reader's home folder and the largest file served.
    fn read_at(&self, window: &str, request: Option<(&str, PathBuf)>, home: Option<&Path>, max: u64) -> Response<Cow<'static, [u8]>> {
        let refuse = |status, why: &str| respond(status, "text/plain", why.as_bytes().to_vec());
        let Some((tab, path)) = request else {
            return refuse(StatusCode::BAD_REQUEST, "Malformed path.");
        };
        let served: Vec<Served> = match self.tabs.lock().unwrap().get(tab) {
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
        if let Err(why) = may_read(&served, &path, home) {
            return refuse(StatusCode::FORBIDDEN, why);
        }
        // Only a regular file: reading a pipe or a device would never end. The
        // metadata comes without opening it, which for a pipe would wait.
        match std::fs::metadata(&path).ok().filter(std::fs::Metadata::is_file) {
            None => return refuse(StatusCode::NOT_FOUND, "Not a file."),
            Some(meta) if meta.len() > max => return refuse(StatusCode::PAYLOAD_TOO_LARGE, "Too large."),
            Some(_) => {}
        }
        // A file can be longer than its size said (one that grows, or one in
        // /proc), so the reading stops past the largest size too.
        let mut body = Vec::new();
        match std::fs::File::open(&path).and_then(|file| file.take(max + 1).read_to_end(&mut body)) {
            Ok(_) if body.len() as u64 > max => refuse(StatusCode::PAYLOAD_TOO_LARGE, "Too large."),
            Ok(_) => respond(StatusCode::OK, content_type(&path), body),
            Err(_) => refuse(StatusCode::NOT_FOUND, "Not found."),
        }
    }
}

/// An error as the page shows it.
fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// A tab id the page made: letters and digits, so it fits in a URL as it is.
fn valid_tab(tab: &str) -> Result<(), String> {
    if !tab.is_empty() && tab.len() <= 64 && tab.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        Err("Malformed tab id.".into())
    }
}

/// The cssv: URL of a file, for a tab.
fn file_url(tab: &str, path: &Path) -> String {
    let mut url = format!("{PROTOCOL}{tab}");
    for component in path.components() {
        match component {
            #[cfg(windows)]
            Component::Prefix(prefix) => {
                url.push('/');
                url.push_str(&prefix.as_os_str().to_string_lossy());
            }
            Component::Normal(name) => {
                url.push('/');
                url.extend(utf8_percent_encode(&name.to_string_lossy(), SEGMENT));
            }
            _ => {}
        }
    }
    url
}

/// The inverse of `file_url`, from the path of a request URL: the tab and the file.
fn url_path(path: &str) -> Option<(&str, PathBuf)> {
    url_path_for(path, cfg!(windows))
}

/// `url_path`, for Windows or for the other systems. Nothing reads the disk
/// before this, so it refuses what `file_url` doesn't make: an empty, "." or
/// ".." segment, one with a slash or NUL in it once decoded, and on Windows
/// one with a backslash or a colon after the drive, or a path that starts at
/// neither a drive nor a network share.
/// A network share ("//host/share/…", from `file_url`'s "\\host\share"
/// prefix) makes Windows connect to that host, sending it the reader's
/// credentials, so `read` looks one up only on a share the tab already reads.
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
    static HOME_FOLDER: OnceLock<Option<PathBuf>> = OnceLock::new();
    HOME_FOLDER.get_or_init(|| std::fs::canonicalize(std::env::var_os(HOME)?).ok()).as_deref()
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

/// The file's modification time and size, or None while it is missing
/// (mid-save). Reading them doesn't open the file, which would be an event.
fn version(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// File paths among command-line arguments, relative to `cwd`. They're made
/// absolute without following links, so a file opened twice is found open.
fn paths_in(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter().filter(|a| !a.starts_with('-')).filter_map(|a| std::path::absolute(cwd.join(a)).ok()).filter(|p| p.is_file()).collect()
}

/// What to show for the files the viewer is started with: each of them, or
/// the home, with the recent files, when there are none.
fn opens(paths: Vec<PathBuf>) -> Vec<Option<PathBuf>> {
    if paths.is_empty() {
        vec![None]
    } else {
        paths.into_iter().map(Some).collect()
    }
}

/// Serves a file to the tab its URL names, on a thread of its own: a large
/// file or a slow disk would otherwise hold up the window.
fn serve(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let window = ctx.webview_label().to_string();
    tauri::async_runtime::spawn_blocking(move || responder.respond(app.state::<Viewer>().read(&window, request.uri().path())));
}

/// Opens `path` in a tab, and tells the tab when the file changes.
#[tauri::command]
fn open_file(window: WebviewWindow, viewer: State<'_, Viewer>, tab: String, path: String) -> Result<String, String> {
    let (app, label, changed) = (window.app_handle().clone(), window.label().to_string(), tab.clone());
    let notify = move || {
        let _ = app.emit_to(label.as_str(), "cssv-file-changed", &changed);
    };
    viewer.open(window.label(), &tab, &path, Box::new(notify))
}

#[tauri::command]
fn close_tab(viewer: State<'_, Viewer>, tab: String) {
    viewer.close(&tab);
}

#[tauri::command]
fn take_opens(window: WebviewWindow, viewer: State<'_, Viewer>) -> Vec<Option<String>> {
    viewer.take_opens(window.label())
}

/// Saves what the page made (the data as CSV, an image of the table) where
/// the reader chooses. The dialog runs here, so the page can only write to a
/// path the reader picked. The body is the file's bytes; the headers name it
/// and the tab it comes from, whose file's folder the dialog starts in.
/// Returns the path written, or None if the reader cancelled.
#[tauri::command]
async fn save_file(window: WebviewWindow, viewer: State<'_, Viewer>, request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    let save = Save::new(request.body(), request.headers())?;
    let mut dialog = window.dialog().file().set_parent(&window).set_file_name(&save.name).add_filter(&save.kind, &[save.ext.as_str()]);
    if let Some(folder) = viewer.file_of(&save.tab).as_deref().and_then(Path::parent) {
        dialog = dialog.set_directory(folder);
    }
    let Some(chosen) = dialog.blocking_save_file() else { return Ok(None) };
    save.write(&chosen.into_path().map_err(error_text)?)
}

#[tauri::command]
fn preview_file(window: WebviewWindow, viewer: State<'_, Viewer>, tab: String, path: String) -> Result<String, String> {
    viewer.preview(window.label(), &tab, &path)
}

#[tauri::command]
fn set_page(window: WebviewWindow, viewer: State<'_, Viewer>, tab: String, page: Page) {
    viewer.set_page(window.label(), tab, page);
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
    return linux::set(on);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = on;
        Err("Only the Linux AppImage sets this up itself.".into())
    }
}

#[derive(Debug, Default, PartialEq, serde::Serialize)]
struct Integration {
    available: bool,
    installed: bool,
}

/// Shows `path` in a tab of the viewer's window, or the home when `path` is
/// None, making the window if there is none. The window's page takes the
/// files from `opens` when it starts, and when told that there are more.
fn show(app: &AppHandle, path: Option<PathBuf>) -> tauri::Result<()> {
    let viewer = app.state::<Viewer>();
    if let Some(window) = app.webview_windows().into_values().next() {
        viewer.queue(window.label(), path);
        let _ = window.emit_to(window.label(), "cssv-open", ());
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, viewer.new_window(path), WebviewUrl::App("index.html".into()))
        .title("CSSV Viewer")
        .inner_size(1100.0, 760.0)
        .min_inner_size(420.0, 300.0)
        .zoom_hotkeys_enabled(true)
        .build()?;
    #[cfg(target_os = "linux")]
    linux::prepare_prints(&window);
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    Ok(())
}

/// The commands, as the window's pages call them. Tauri's macros write the
/// code that reads each command's arguments and calls it, so coverage leaves
/// that out, as it does the rest of Tauri; the commands themselves count.
#[cfg_attr(coverage_nightly, coverage(off))]
fn commands() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![open_file, close_tab, take_opens, preview_file, save_file, set_page, quit, integration, set_integration]
}

/// Runs the viewer.
///
/// # Panics
///
/// If Tauri can't start: it has no window to show an error in.
pub fn run() {
    tauri::Builder::default()
        // Starting the viewer again shows its files, or the home, in the
        // running instance's window.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            for path in opens(paths_in(args.into_iter().skip(1), Path::new(&cwd))) {
                let _ = show(app, path);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // The window opens where and as large as it was last time (Wayland
        // doesn't let apps place windows).
        .plugin(
            tauri_plugin_window_state::Builder::default().with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED).build(),
        )
        .manage(Viewer::default())
        .register_asynchronous_uri_scheme_protocol("cssv", serve)
        .invoke_handler(commands())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<Viewer>().forget(window.label());
            }
        })
        .setup(|app| {
            #[cfg(target_os = "linux")]
            linux::refresh();
            let cwd = std::env::current_dir().unwrap_or_default();
            for path in opens(paths_in(std::env::args().skip(1), &cwd)) {
                show(app.handle(), path)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the CSSV Viewer")
        .run(|app, event| {
            // On macOS, Finder opens files through an event rather than the
            // command line, and clicking the Dock icon with every window
            // closed asks for a window.
            #[cfg(target_os = "macos")]
            match event {
                tauri::RunEvent::Opened { urls } => {
                    for url in urls {
                        if let Ok(path) = url.to_file_path() {
                            let _ = show(app, Some(path));
                        }
                    }
                }
                tauri::RunEvent::Reopen { has_visible_windows: false, .. } => {
                    let _ = show(app, None);
                }
                _ => {}
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
