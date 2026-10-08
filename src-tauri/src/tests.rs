use std::sync::mpsc;

use notify_debouncer_mini::notify;
use notify_debouncer_mini::{DebouncedEvent, DebouncedEventKind};
#[cfg(not(windows))]
use proptest::prelude::*;
use tauri::http::HeaderValue;

use super::*;

fn served(root: &str, file: &str) -> Served {
    Served { root: PathBuf::from(root), file: PathBuf::from(file) }
}

/// A folder with files in it, deleted after the test.
fn folder(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (name, text) in files {
        let path = dir.path().join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    dir
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn nothing() -> Box<dyn Fn() + Send> {
    Box::new(|| {})
}

fn body(response: &Response<Cow<'static, [u8]>>) -> String {
    String::from_utf8_lossy(response.body()).into_owned()
}

#[test]
#[cfg(not(windows))]
fn url_path_round_trips_file_url() {
    let path = Path::new("/home/ana/My Files/büdget #1 100%?.cssv");
    let url = file_url("abc123", path);
    assert_eq!(url, "cssv://localhost/abc123/home/ana/My%20Files/b%C3%BCdget%20%231%20100%25%3F.cssv");
    let request = url.strip_prefix("cssv://localhost").unwrap();
    assert_eq!(url_path(request), Some(("abc123", path.to_path_buf())));
    // A colon is a file name's on Linux and macOS.
    assert_eq!(url_path_for("/abc/home/ana/a%3Ab.css", false), Some(("abc", PathBuf::from("/home/ana/a:b.css"))));
}

#[cfg(not(windows))]
proptest! {
    #[test]
    fn url_path_reads_back_any_path_file_url_makes(names in prop::collection::vec("[^/\0]{1,12}", 1..6)) {
        prop_assume!(names.iter().all(|name| name != "." && name != ".."));
        let path = PathBuf::from(format!("/{}", names.join("/")));
        let url = file_url("tab1", &path);
        prop_assert_eq!(url_path(url.strip_prefix("cssv://localhost").unwrap()), Some(("tab1", path)));
    }
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
            "abc/x.css", // not from the root
            "/abc",      // no file
            "/abc/",     // empty segment
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
        "/abc///host/share",        // a share, but no file
        "/abc////host/share/x.css", // an empty segment
        "/abc///./pipe/x",          // the device namespace
        "/abc///%3F/UNC/host/share/x.css",
        "/abc///host/share/C:x.css",
        "/abc/C:/a%5Cb.css",
        "/abc/host/share/x.css", // no drive
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
    assert_eq!(url_path_for("/abc///files/team/budget%20q1/b.cssv", true), Some(("abc", PathBuf::from(r"\\files\team\budget q1\b.cssv"))));
}

#[test]
fn network_share_reads_host_and_share() {
    let share = |s: &str| network_share(Path::new(s));
    let files = Some(("files".to_string(), "team".to_string()));
    assert_eq!(share(r"\\files\team\b.cssv"), files);
    assert_eq!(share(r"\\?\UNC\Files\TEAM\sub\b.cssv"), files);
    for path in [r"\\.\pipe\x", r"\\?\C:\x", r"C:\x", "/home/x", r"\\files", r"\\files\", r"\\\\files\team"] {
        assert_eq!(share(path), None, "{path}");
    }
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
    assert_eq!(may_read(&tab, Path::new("/home/ana/.ssh/id_ed25519"), home), Err("Hidden files and folders aren't served."));
    assert!(may_read(&tab, Path::new("/home/ana/.bashrc"), home).is_err());
    assert_eq!(may_read(&tab, Path::new("/home/ana/Documents/a.png"), home), Err("Only the files directly in the home folder are served."));
    // The filesystem's root, and a folder that holds the home folder.
    for (root, file) in [("/", "/x.cssv"), ("/home", "/home/x.cssv")] {
        let tab = [served(root, file)];
        assert_eq!(may_read(&tab, &Path::new(root).join("a.css"), home), Ok(()));
        assert!(may_read(&tab, Path::new("/home/ana/a.css"), home).is_err());
    }
    assert!(may_read(&[served("/", "/x.cssv")], Path::new("/etc/passwd"), home).is_err());
    // Without a home folder, a folder below the root serves its folders.
    assert_eq!(may_read(&[served("/home", "/home/x.cssv")], Path::new("/home/ana/a.css"), None), Ok(()));
    assert_eq!(may_read(&[served("/home", "/home/x.cssv")], Path::new("/home/ana/a.css"), Some(Path::new("/srv"))), Ok(()));
}

#[test]
fn may_read_takes_any_folder_a_home_tab_previews() {
    let home = Some(Path::new("/home/ana"));
    let tab = [served("/home/ana", "/home/ana/a.cssv"), served("/home/ana/data", "/home/ana/data/b.cssv")];
    assert_eq!(may_read(&tab, Path::new("/home/ana/data/img/x.png"), home), Ok(()));
    assert_eq!(may_read(&tab, Path::new("/srv/x.png"), home), Err("Outside the opened file's folder."));
    assert!(may_read(&tab, Path::new("/home/ana/other/x.png"), home).is_err());
    assert!(may_read(&tab, Path::new("/home/ana/data/.cache/x.png"), home).is_err());
}

#[test]
fn tab_ids_are_letters_and_digits() {
    assert_eq!(valid_tab("a1B2"), Ok(()));
    assert_eq!(valid_tab(&"x".repeat(64)), Ok(()));
    for tab in ["", "a-b", "a/b", "ü", &"x".repeat(65)] {
        assert_eq!(valid_tab(tab), Err("Malformed tab id.".into()), "{tab}");
    }
}

#[test]
fn files_are_served_with_their_media_type() {
    for (name, kind) in [
        ("a.cssv", "text/plain; charset=utf-8"),
        ("a.CSV", "text/plain; charset=utf-8"),
        ("a.txt", "text/plain; charset=utf-8"),
        ("a.css", "text/css; charset=utf-8"),
        ("a.svg", "image/svg+xml"),
        ("a.png", "image/png"),
        ("a.jpg", "image/jpeg"),
        ("a.jpeg", "image/jpeg"),
        ("a.gif", "image/gif"),
        ("a.webp", "image/webp"),
        ("a.avif", "image/avif"),
        ("a.woff2", "font/woff2"),
        ("a.woff", "font/woff"),
        ("a.ttf", "font/ttf"),
        ("a.otf", "font/otf"),
        ("a.js", "application/octet-stream"),
        ("README", "application/octet-stream"),
    ] {
        assert_eq!(content_type(Path::new(name)), kind, "{name}");
    }
}

#[test]
fn landscape_is_a_custom_paper_wider_than_tall() {
    let page = |paper: &str, landscape| Page { paper: paper.into(), landscape, margin: 10.0 };
    assert_eq!(paper(&page("a4", false)), Paper::Standard("iso_a4"));
    assert_eq!(paper(&page("letter", false)), Paper::Standard("na_letter"));
    assert_eq!(paper(&page("a4", true)), Paper::Custom("iso_a4-wide".into(), "iso_a4 landscape".into(), 297.0, 210.0));
    assert_eq!(paper(&page("letter", true)), Paper::Custom("na_letter-wide".into(), "na_letter landscape".into(), 279.4, 215.9));
}

#[test]
fn a_save_reads_its_name_kind_and_tab_from_the_headers() {
    let body = InvokeBody::Raw(b"a,b\n".to_vec());
    let mut headers = HeaderMap::new();
    headers.insert("x-name", HeaderValue::from_static("b%C3%BCdget%20q1.csv"));
    headers.insert("x-kind", HeaderValue::from_static("CSV"));
    headers.insert("x-ext", HeaderValue::from_static("csv"));
    headers.insert("x-tab", HeaderValue::from_bytes(b"t\xff").unwrap()); // not text: none
    let save = Save::new(&body, &headers).unwrap();
    assert_eq!(save, Save { bytes: b"a,b\n", name: "büdget q1.csv".into(), kind: "CSV".into(), ext: "csv".into(), tab: String::new() });
    assert_eq!(Save::new(&InvokeBody::default(), &headers), Err("Expected the file's bytes.".into()));
}

#[test]
fn a_save_writes_the_bytes_where_the_reader_chose() {
    let dir = folder(&[]);
    let body = InvokeBody::Raw(b"a,b\n".to_vec());
    let save = Save::new(&body, &HeaderMap::new()).unwrap();
    let path = dir.path().join("out.csv");
    assert_eq!(save.write(&path), Ok(Some(path_text(&path))));
    assert_eq!(std::fs::read(&path).unwrap(), b"a,b\n");
    let error = save.write(&dir.path().join("missing/out.csv")).unwrap_err();
    assert!(error.starts_with("Could not save "), "{error}");
}

#[test]
fn a_watched_file_changes_only_with_a_new_version() {
    let dir = folder(&[("a.cssv", "x"), ("b.cssv", "y")]);
    let file = dir.path().join("a.cssv");
    let mut watched = Watched::new(&file);
    let event = |name: &str| Ok(vec![DebouncedEvent::new(dir.path().join(name), DebouncedEventKind::Any)]);
    assert!(!watched.changed(Err(notify::Error::generic("lost"))));
    assert!(!watched.changed(event("b.cssv")));
    assert!(!watched.changed(event("a.cssv")), "read, not changed");
    std::fs::write(&file, "longer").unwrap();
    assert!(watched.changed(event("a.cssv")));
    assert!(!watched.changed(event("a.cssv")), "the same version again");
    std::fs::remove_file(&file).unwrap();
    assert!(!watched.changed(event("a.cssv")), "missing while it's saved");
    assert_eq!(version(&file), None);
}

#[test]
fn opening_a_file_serves_its_folder_and_tells_of_new_versions() {
    let dir = folder(&[("a.cssv", "x"), ("b.css", "y")]);
    let viewer = Viewer::default();
    let (sender, heard) = mpsc::channel();
    let changed = Box::new(move || sender.send(()).unwrap());
    let file = dir.path().join("a.cssv");
    let url = viewer.open("viewer-1", "t1", &path_text(&file), changed).unwrap();
    let canonical = std::fs::canonicalize(&file).unwrap();
    assert_eq!(url, file_url("t1", &file));
    assert_eq!(viewer.file_of("t1"), Some(file.clone()));
    // Another file in the folder changes: no news.
    std::fs::write(dir.path().join("b.css"), "changed").unwrap();
    assert!(heard.recv_timeout(Duration::from_millis(600)).is_err());
    std::fs::write(&file, "a new version").unwrap();
    heard.recv_timeout(Duration::from_secs(5)).expect("the tab hears of the new version");
    let response = viewer.read_at("viewer-1", Some(("t1", canonical)), None, MAX_FILE);
    assert_eq!(body(&response), "a new version");
}

#[test]
fn a_tab_that_fails_to_open_a_file_shows_nothing() {
    let dir = folder(&[("a.cssv", "x")]);
    let viewer = Viewer::default();
    viewer.open("viewer-1", "t1", &path_text(&dir.path().join("a.cssv")), nothing()).unwrap();
    assert_eq!(viewer.open("viewer-1", "t-1", "/x.cssv", nothing()), Err("Malformed tab id.".into()));
    assert!(viewer.open("viewer-1", "t1", "", nothing()).is_err(), "an empty path");
    assert_eq!(viewer.file_of("t1"), None, "the earlier file is gone");
    let error = viewer.open("viewer-1", "t1", &path_text(dir.path()), nothing()).unwrap_err();
    assert!(error.ends_with(" is not a file."), "{error}");
    assert!(viewer.tabs.lock().unwrap().contains_key("t1"));
    assert_eq!(viewer.file_of("t2"), None);
}

#[test]
fn a_home_tab_reads_the_recent_files_it_previews() {
    let one = folder(&[("a.cssv", "a"), ("a.css", "s")]);
    let two = folder(&[("b.cssv", "b")]);
    let viewer = Viewer::default();
    let (a, b) = (one.path().join("a.cssv"), two.path().join("b.cssv"));
    assert_eq!(viewer.preview("viewer-1", "home1", &path_text(&a)), Ok(file_url("home1", &a)));
    assert_eq!(viewer.preview("viewer-1", "home1", &path_text(&b)), Ok(file_url("home1", &b)));
    let read = |path: &Path| viewer.read_at("viewer-1", Some(("home1", std::fs::canonicalize(path).unwrap())), None, MAX_FILE);
    assert_eq!(body(&read(&one.path().join("a.css"))), "s");
    assert_eq!(body(&read(&b)), "b");
    assert_eq!(viewer.preview("viewer-1", "home-1", &path_text(&a)), Err("Malformed tab id.".into()));
    assert!(viewer.preview("viewer-1", "home1", "").is_err(), "an empty path");
    assert_eq!(viewer.preview("viewer-1", "home1", &path_text(&one.path().join("gone.cssv"))), Err("Not found.".into()));
}

#[test]
fn closing_a_tab_forgets_it_and_its_print_preview() {
    let dir = folder(&[("a.cssv", "x")]);
    let viewer = Viewer::default();
    let file = path_text(&dir.path().join("a.cssv"));
    viewer.open("viewer-1", "t1", &file, nothing()).unwrap();
    viewer.open("viewer-2", "t2", &file, nothing()).unwrap();
    let page = Page { paper: "a4".into(), landscape: false, margin: 12.0 };
    viewer.set_page("viewer-1", "t1".into(), page.clone());
    viewer.set_page("viewer-2", "t2".into(), page);
    viewer.close("t1");
    assert_eq!(viewer.file_of("t1"), None);
    assert!(viewer.printing("viewer-1").is_none());
    assert!(viewer.printing("viewer-2").is_some());
}

#[test]
fn a_print_is_named_after_the_tab_file_in_its_folder() {
    let dir = folder(&[("budget.cssv", "x")]);
    let viewer = Viewer::default();
    let file = dir.path().join("budget.cssv");
    viewer.open("viewer-1", "t1", &path_text(&file), nothing()).unwrap();
    assert_eq!(viewer.printing("viewer-1"), None, "no print preview");
    viewer.set_page("viewer-1", "t1".into(), Page { paper: "letter".into(), landscape: true, margin: 15.0 });
    assert_eq!(
        viewer.printing("viewer-1"),
        Some(Print {
            settings: vec![("output-basename", "budget".into()), ("output-dir", path_text(dir.path()))],
            paper: Paper::Custom("na_letter-wide".into(), "na_letter landscape".into(), 279.4, 215.9),
            margin: 15.0,
        })
    );
    // A tab without a file leaves GTK's names.
    viewer.set_page("viewer-1", "home1".into(), Page { paper: "a4".into(), landscape: false, margin: 0.0 });
    assert_eq!(viewer.printing("viewer-1"), Some(Print { settings: Vec::new(), paper: Paper::Standard("iso_a4"), margin: 0.0 }));
}

#[test]
fn windows_take_the_files_they_are_asked_to_open_in_order() {
    let viewer = Viewer::default();
    assert_eq!(viewer.new_window(None), "viewer-1");
    assert_eq!(viewer.new_window(Some(PathBuf::from("/b.cssv"))), "viewer-2");
    viewer.queue("viewer-1", Some(PathBuf::from("/a.cssv")));
    viewer.queue("viewer-3", None);
    assert_eq!(viewer.take_opens("viewer-1"), vec![None, Some("/a.cssv".to_string())]);
    assert_eq!(viewer.take_opens("viewer-1"), Vec::<Option<String>>::new());
    assert_eq!(viewer.take_opens("viewer-2"), vec![Some("/b.cssv".to_string())]);
    assert_eq!(viewer.take_opens("viewer-3"), vec![None]);
}

#[test]
fn a_closed_window_takes_its_tabs_with_it() {
    let dir = folder(&[("a.cssv", "x")]);
    let viewer = Viewer::default();
    let file = path_text(&dir.path().join("a.cssv"));
    viewer.open("viewer-1", "t1", &file, nothing()).unwrap();
    viewer.open("viewer-2", "t2", &file, nothing()).unwrap();
    viewer.set_page("viewer-1", "t1".into(), Page { paper: "a4".into(), landscape: false, margin: 0.0 });
    viewer.queue("viewer-1", None);
    viewer.forget("viewer-1");
    assert_eq!(viewer.file_of("t1"), None);
    assert!(viewer.file_of("t2").is_some());
    assert!(viewer.printing("viewer-1").is_none());
    assert_eq!(viewer.take_opens("viewer-1"), Vec::<Option<String>>::new());
}

#[test]
fn the_protocol_serves_a_tab_its_files_only() {
    let dir = folder(&[("a.cssv", "table"), ("brand.css", "b {}"), ("sub/.hidden.css", "h"), ("sub/x.png", "png")]);
    let viewer = Viewer::default();
    let file = dir.path().join("a.cssv");
    viewer.open("viewer-1", "t1", &path_text(&file), nothing()).unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let get = |window: &str, tab: &str, path: PathBuf| viewer.read_at(window, Some((tab, path)), None, MAX_FILE);
    let status = |response: Response<Cow<'static, [u8]>>| (response.status(), body(&response));

    let ok = get("viewer-1", "t1", root.join("brand.css"));
    assert_eq!(ok.status(), StatusCode::OK);
    assert_eq!(ok.headers()[header::CONTENT_TYPE], "text/css; charset=utf-8");
    assert_eq!(ok.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    assert_eq!(ok.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(body(&ok), "b {}");
    assert_eq!(status(get("viewer-1", "t1", root.join("sub/x.png"))), (StatusCode::OK, "png".into()));

    assert_eq!(status(viewer.read_at("viewer-1", None, None, MAX_FILE)), (StatusCode::BAD_REQUEST, "Malformed path.".into()));
    assert_eq!(status(get("viewer-1", "t9", root.join("brand.css"))), (StatusCode::FORBIDDEN, "No file is open in this tab.".into()));
    assert_eq!(status(get("viewer-2", "t1", root.join("brand.css"))), (StatusCode::FORBIDDEN, "No file is open in this tab.".into()));
    assert_eq!(status(get("viewer-1", "t1", root.join("gone.css"))), (StatusCode::NOT_FOUND, "Not found.".into()));
    assert_eq!(status(get("viewer-1", "t1", root.join("sub/.hidden.css"))).0, StatusCode::FORBIDDEN);
    assert_eq!(status(get("viewer-1", "t1", root.parent().unwrap().to_path_buf())).0, StatusCode::FORBIDDEN);
    assert_eq!(status(get("viewer-1", "t1", root.join("sub"))), (StatusCode::NOT_FOUND, "Not a file.".into()));
    assert_eq!(
        status(viewer.read_at("viewer-1", Some(("t1", root.join("brand.css"))), None, 3)),
        (StatusCode::PAYLOAD_TOO_LARGE, "Too large.".into())
    );

    // The request's own path, as the window sends it.
    let url = file_url("t1", &dir.path().join("brand.css"));
    assert_eq!(body(&viewer.read("viewer-1", url.strip_prefix(PROTOCOL.trim_end_matches('/')).unwrap())), "b {}");
}

#[test]
#[cfg(unix)]
fn the_protocol_refuses_a_file_it_cannot_read() {
    use std::os::unix::fs::PermissionsExt;
    let dir = folder(&[("a.cssv", "x"), ("locked.css", "y")]);
    let viewer = Viewer::default();
    viewer.open("viewer-1", "t1", &path_text(&dir.path().join("a.cssv")), nothing()).unwrap();
    let locked = std::fs::canonicalize(dir.path().join("locked.css")).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let response = viewer.read_at("viewer-1", Some(("t1", locked)), None, MAX_FILE);
    assert_eq!((response.status(), body(&response)), (StatusCode::NOT_FOUND, "Not found.".into()));
}

#[test]
#[cfg(target_os = "linux")]
fn the_protocol_stops_reading_a_file_longer_than_its_size() {
    // Files in /proc have a size of 0, whatever they hold.
    let proc = std::fs::canonicalize("/proc/self").unwrap();
    let viewer = Viewer::default();
    viewer.tabs.lock().unwrap().insert("t1".into(), Tab::new("viewer-1"));
    viewer.tabs.lock().unwrap().get_mut("t1").unwrap().previews.insert(Served { root: proc.clone(), file: proc.join("cmdline") });
    let response = viewer.read_at("viewer-1", Some(("t1", proc.join("status"))), None, 16);
    assert_eq!((response.status(), body(&response)), (StatusCode::PAYLOAD_TOO_LARGE, "Too large.".into()));
}

#[test]
fn the_protocol_looks_up_only_the_network_share_a_tab_reads() {
    let viewer = Viewer::default();
    viewer.tabs.lock().unwrap().insert("t1".into(), Tab::new("viewer-1"));
    viewer.tabs.lock().unwrap().get_mut("t1").unwrap().previews.insert(served(r"\\files\team", r"\\files\team\a.cssv"));
    let get = |url: &str| viewer.read_at("viewer-1", url_path_for(url, true), None, MAX_FILE);
    let other = get("/t1///elsewhere/team/b.css");
    assert_eq!((other.status(), body(&other)), (StatusCode::FORBIDDEN, "Not on the opened file's network share.".into()));
    // On the tab's own share, the file is looked up (and here not found).
    let own = get("/t1///FILES/Team/b.css");
    assert_eq!((own.status(), body(&own)), (StatusCode::NOT_FOUND, "Not found.".into()));
}

#[test]
fn the_viewer_starts_with_its_files_or_the_home() {
    let dir = folder(&[("a.cssv", "x"), ("b.cssv", "y")]);
    let args = ["--flag", "a.cssv", "missing.cssv", "b.cssv"].map(String::from);
    let paths = paths_in(args, dir.path());
    assert_eq!(paths, vec![dir.path().join("a.cssv"), dir.path().join("b.cssv")]);
    assert_eq!(opens(paths.clone()), paths.into_iter().map(Some).collect::<Vec<_>>());
    assert_eq!(opens(Vec::new()), vec![None]);
}

#[test]
fn errors_read_as_their_message() {
    assert_eq!(error_text(std::io::Error::other("no luck")), "no luck");
    assert_eq!(Served::new(Path::new("/")), Err("The file has no folder.".into()));
    assert!(Served::new(Path::new("/no/such/file")).is_err());
}
