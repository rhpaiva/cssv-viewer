use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Mutex, MutexGuard};

use super::*;

/// Tests that set variables take turns (cargo nextest runs each test in a
/// process of its own anyway).
fn turn() -> MutexGuard<'static, ()> {
    static TURN: Mutex<()> = Mutex::new(());
    TURN.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Sets variables, or removes those set to None, until it's dropped.
struct Env(Vec<(&'static str, Option<OsString>)>);

fn env(vars: &[(&'static str, Option<&Path>)]) -> Env {
    let saved = vars.iter().map(|(name, _)| (*name, std::env::var_os(name))).collect();
    for (name, value) in vars {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
    Env(saved)
}

impl Drop for Env {
    fn drop(&mut self) {
        for (name, value) in &self.0 {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

/// A home folder with a data folder, a config folder, an AppImage and a
/// folder of desktop tools that log how they were run, for the variables the
/// viewer reads.
struct Desktop {
    dir: tempfile::TempDir,
}

impl Desktop {
    fn new() -> Self {
        let desktop = Desktop { dir: tempfile::tempdir().unwrap() };
        std::fs::write(desktop.appimage(), "").unwrap();
        let bin = desktop.path("bin");
        std::fs::create_dir(&bin).unwrap();
        let log = desktop.path("tools.log");
        for tool in ["update-mime-database", "update-desktop-database", "gtk-update-icon-cache", "xdg-mime"] {
            let script = bin.join(tool);
            std::fs::write(&script, format!("#!/bin/sh\necho \"{tool} $*\" >> '{}'\n", log.display())).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        desktop
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn appimage(&self) -> PathBuf {
        self.path("CSSV Viewer.AppImage")
    }

    fn data(&self) -> PathBuf {
        self.path("data")
    }

    fn tools(&self) -> String {
        std::fs::read_to_string(self.path("tools.log")).unwrap_or_default()
    }

    /// The variables of a viewer run as this desktop's AppImage.
    fn env(&self) -> Env {
        let path = PathBuf::from(format!("{}:/usr/bin:/bin", self.path("bin").display()));
        env(&[
            ("PATH", Some(&path)),
            ("APPIMAGE", Some(&self.appimage())),
            ("XDG_DATA_HOME", Some(&self.data())),
            ("XDG_CONFIG_HOME", Some(&self.path("config"))),
            ("HOME", Some(self.dir.path())),
        ])
    }
}

#[test]
fn exec_quotes_and_escapes_the_path() {
    assert_eq!(exec_arg("/home/ana/CSSV Viewer.AppImage"), r#""/home/ana/CSSV Viewer.AppImage""#);
    // Quoting escapes " ` $ \, then the string value doubles each backslash.
    assert_eq!(exec_arg(r#"/a"b`c$d\e"#), r#""/a\\"b\\`c\\$d\\\\e""#);
    assert_eq!(exec_arg("/100%/x.AppImage"), r#""/100%%/x.AppImage""#);
}

#[test]
fn string_values_escape_backslashes_and_read_back() {
    let path = r"/opt/a\b c/x.AppImage";
    assert_eq!(string_value(path), r"/opt/a\\b c/x.AppImage");
    assert_eq!(unescape(&string_value(path)), path);
    assert_eq!(unescape(r"a\sb\tc\\d\ne\rf\qg\"), "a b\tc\\d\ne\rfqg\\");
}

#[test]
fn paths_with_control_characters_are_refused() {
    use std::os::unix::ffi::OsStrExt;
    assert_eq!(entry_text(Path::new("/home/ana/x.AppImage")), Ok("/home/ana/x.AppImage"));
    for path in ["/tmp/a\nExec=evil", "/tmp/a\rb", "/tmp/a\tb", "/tmp/a\u{1b}b", "/tmp/a\u{7f}b"] {
        assert!(entry_text(Path::new(path)).is_err(), "{path:?}");
    }
    let not_utf8 = Path::new(std::ffi::OsStr::from_bytes(b"/tmp/\xff.AppImage"));
    assert_eq!(entry_text(not_utf8), Err("The AppImage's path isn't UTF-8, which a menu entry can't name.".into()));
    let data = tempfile::tempdir().unwrap();
    assert!(write_entry(data.path(), Path::new("/tmp/a\nb")).is_err());
    assert!(!entry_path(data.path()).exists());
}

#[test]
fn the_viewer_runs_as_an_appimage_only_when_the_file_is_there() {
    let _turn = turn();
    let desktop = Desktop::new();
    let _env = desktop.env();
    assert_eq!(appimage(), Some(desktop.appimage()));
    let gone = desktop.path("gone.AppImage");
    let _gone = env(&[("APPIMAGE", Some(&gone))]);
    assert_eq!(appimage(), None);
}

#[test]
fn the_data_folder_follows_xdg_data_home_or_the_home_folder() {
    let _turn = turn();
    let _env = env(&[("XDG_DATA_HOME", Some(Path::new("/data"))), ("HOME", Some(Path::new("/home/ana")))]);
    assert_eq!(data_home(), Some(PathBuf::from("/data")));
    let _empty = env(&[("XDG_DATA_HOME", Some(Path::new("")))]);
    assert_eq!(data_home(), Some(PathBuf::from("/home/ana/.local/share")));
    let _unset = env(&[("XDG_DATA_HOME", None), ("HOME", None)]);
    assert_eq!(data_home(), None);
}

#[test]
fn installing_writes_the_entry_media_type_and_icons() {
    let _turn = turn();
    let desktop = Desktop::new();
    let _env = desktop.env();
    assert_eq!(status(), Integration { available: true, installed: false });
    assert_eq!(set(true), Ok(Integration { available: true, installed: true }));

    let data = desktop.data();
    let entry = std::fs::read_to_string(entry_path(&data)).unwrap();
    let appimage = desktop.appimage();
    let path = appimage.to_str().unwrap();
    assert!(entry.contains(&format!("\nExec={} %F\n", exec_arg(path))), "{entry}");
    assert!(entry.contains(&format!("\nTryExec={path}\n")), "{entry}");
    assert!(entry.contains("\nMimeType=text/x-cssv;\n"), "{entry}");
    assert_eq!(installed_for(&data), Some(appimage));
    assert_eq!(std::fs::read_to_string(data.join("mime/packages/cssv-viewer.xml")).unwrap(), MIME_XML);
    for (icon, png) in icon_paths(&data) {
        assert_eq!(std::fs::read(&icon).unwrap(), png, "{}", icon.display());
    }
    let tools = desktop.tools();
    for tool in ["update-mime-database", "update-desktop-database", "gtk-update-icon-cache", "xdg-mime default cssv-viewer.desktop text/x-cssv"] {
        assert!(tools.contains(tool), "{tools}");
    }
}

#[test]
fn installing_needs_an_appimage_a_home_and_a_writable_data_folder() {
    let _turn = turn();
    let desktop = Desktop::new();
    let _env = desktop.env();
    {
        let _no_appimage = env(&[("APPIMAGE", None)]);
        assert_eq!(install(), Err("The viewer isn't running as an AppImage.".into()));
        assert_eq!(status(), Integration { available: false, installed: false });
    }
    {
        let _no_home = env(&[("XDG_DATA_HOME", None), ("HOME", None)]);
        assert_eq!(install(), Err("No home folder.".into()));
        assert_eq!(remove(), Err("No home folder.".into()));
    }
    std::fs::write(desktop.data(), "a file where the folder goes").unwrap();
    let error = install().unwrap_err();
    assert!(error.starts_with("Could not create the folder of "), "{error}");
    std::fs::remove_file(desktop.data()).unwrap();
    std::fs::create_dir_all(entry_path(&desktop.data())).unwrap(); // a folder where the entry goes
    let error = install().unwrap_err();
    assert!(error.starts_with("Could not write "), "{error}");
}

#[test]
fn removing_takes_away_only_our_own_entry() {
    let _turn = turn();
    let desktop = Desktop::new();
    let _env = desktop.env();
    let data = desktop.data();
    // Nothing installed: nothing to do.
    assert_eq!(set(false), Ok(Integration { available: true, installed: false }));
    assert_eq!(desktop.tools(), "");
    // Another app's entry by the same name stays.
    write(&entry_path(&data), b"[Desktop Entry]\nExec=other\n").unwrap();
    assert_eq!(remove(), Ok(()));
    assert!(entry_path(&data).exists());

    install().unwrap();
    std::fs::remove_file(data.join("icons/hicolor/32x32/apps/cssv-viewer.png")).unwrap(); // already gone
    let config = desktop.path("config");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(config.join("mimeapps.list"), "[Default Applications]\ntext/x-cssv=cssv-viewer.desktop\ntext/csv=other.desktop\n").unwrap();
    assert_eq!(set(false), Ok(Integration { available: true, installed: false }));
    assert!(!entry_path(&data).exists());
    assert!(!data.join("mime/packages/cssv-viewer.xml").exists());
    assert!(icon_paths(&data).all(|(icon, _)| !icon.exists()));
    assert_eq!(std::fs::read_to_string(config.join("mimeapps.list")).unwrap(), "[Default Applications]\ntext/csv=other.desktop\n");
}

#[test]
fn removing_reports_a_file_it_cannot_remove() {
    let _turn = turn();
    let desktop = Desktop::new();
    let _env = desktop.env();
    install().unwrap();
    let mime = desktop.data().join("mime/packages");
    std::fs::set_permissions(&mime, std::fs::Permissions::from_mode(0o555)).unwrap();
    let error = remove().unwrap_err();
    std::fs::set_permissions(&mime, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(error.starts_with("Could not remove "), "{error}");
}

#[test]
fn forgetting_the_default_reads_the_config_folder_from_xdg_or_home() {
    let _turn = turn();
    let desktop = Desktop::new();
    let list = "text/x-cssv=cssv-viewer.desktop\n";
    for config in ["config", ".config"] {
        std::fs::create_dir_all(desktop.path(config)).unwrap();
        std::fs::write(desktop.path(config).join("mimeapps.list"), list).unwrap();
    }
    let read = |config: &str| std::fs::read_to_string(desktop.path(config).join("mimeapps.list")).unwrap();
    let home = desktop.dir.path().to_path_buf();
    {
        let _neither = env(&[("XDG_CONFIG_HOME", None), ("HOME", None)]);
        forget_default();
    }
    assert_eq!((read("config"), read(".config")), (list.to_string(), list.to_string()));
    {
        let _home = env(&[("XDG_CONFIG_HOME", Some(Path::new(""))), ("HOME", Some(&home))]);
        forget_default();
    }
    assert_eq!(read(".config"), "\n");
    {
        let _xdg = env(&[("XDG_CONFIG_HOME", Some(&desktop.path("config")))]);
        forget_default();
        assert_eq!(read("config"), "\n");
        // Nothing of ours left: the file stays as it is.
        std::fs::write(desktop.path("config").join("mimeapps.list"), "text/csv=other.desktop").unwrap();
        forget_default();
        assert_eq!(read("config"), "text/csv=other.desktop");
        // No list at all.
        std::fs::remove_file(desktop.path("config").join("mimeapps.list")).unwrap();
        forget_default();
    }
}

#[test]
fn a_moved_appimage_takes_over_the_entry_of_one_that_is_gone() {
    let _turn = turn();
    let desktop = Desktop::new();
    let _env = desktop.env();
    let data = desktop.data();
    refresh(); // not installed
    assert!(!entry_path(&data).exists());
    install().unwrap();
    std::fs::write(desktop.path("tools.log"), "").unwrap();
    refresh(); // installed for this AppImage
    assert_eq!(desktop.tools(), "");

    let other = desktop.path("other.AppImage");
    std::fs::write(&other, "").unwrap();
    write_entry(&data, &other).unwrap();
    refresh(); // installed for another AppImage that is still there
    assert_eq!(installed_for(&data), Some(other.clone()));

    std::fs::remove_file(&other).unwrap();
    refresh(); // that one is gone
    assert_eq!(installed_for(&data), Some(desktop.appimage()));
    assert!(desktop.tools().contains("update-desktop-database"));

    let _not_appimage = env(&[("APPIMAGE", None)]);
    refresh();
    let _no_home = env(&[("APPIMAGE", Some(&desktop.appimage())), ("XDG_DATA_HOME", None), ("HOME", None)]);
    refresh();
}

#[test]
fn desktop_tools_run_without_the_appimage_libraries() {
    let _turn = turn();
    let desktop = Desktop::new();
    let report = desktop.path("bin/report");
    let out = desktop.path("report.txt");
    std::fs::write(&report, format!("#!/bin/sh\n{{ pwd; env; }} > '{}'\n", out.display())).unwrap();
    std::fs::set_permissions(&report, std::fs::Permissions::from_mode(0o755)).unwrap();
    let appdir = desktop.path("appdir");
    let home = desktop.dir.path().to_path_buf();
    let dirs = format!("{}/usr/share:/usr/local/share:/usr/share", appdir.display());
    let _env = env(&[
        ("APPDIR", Some(&appdir)),
        ("XDG_DATA_DIRS", Some(Path::new(&dirs))),
        ("HOME", Some(&home)),
        ("LD_LIBRARY_PATH", Some(Path::new("/appdir/lib"))),
        ("GTK_PATH", Some(Path::new("/appdir/gtk"))),
    ]);
    host(report.to_str().unwrap(), &[]);
    let seen = std::fs::read_to_string(&out).unwrap();
    assert!(seen.starts_with(&format!("{}\n", home.display())), "{seen}");
    assert!(seen.contains("\nXDG_DATA_DIRS=/usr/local/share:/usr/share\n"), "{seen}");
    assert!(!seen.contains("\nLD_LIBRARY_PATH=") && !seen.contains("\nGTK_PATH="), "{seen}");

    // Outside an AppImage, the data folders stay; without a home, so does the folder.
    let _outside = env(&[("APPDIR", None), ("HOME", None)]);
    host(report.to_str().unwrap(), &[]);
    let seen = std::fs::read_to_string(&out).unwrap();
    assert!(seen.starts_with(&format!("{}\n", std::env::current_dir().unwrap().display())), "{seen}");
    assert!(seen.contains(&format!("\nXDG_DATA_DIRS={dirs}\n")), "{seen}");
    // A tool that isn't there is no error.
    host(desktop.path("bin/missing").to_str().unwrap(), &[]);
}

#[test]
fn printing_sets_up_the_paper_and_names_the_pdf() {
    // GTK needs a display: `npm run coverage:rust` runs the tests in one.
    if std::env::var_os("DISPLAY").is_none() {
        eprintln!("skipped: no display for GTK");
        return;
    }
    gtk::init().unwrap();
    let print = Print {
        settings: vec![("output-basename", "budget".into()), ("output-dir", "/home/ana/tables".into())],
        paper: Paper::Standard("iso_a4"),
        margin: 12.0,
    };
    let settings = print_settings(None, &print);
    assert_eq!(settings.get("output-basename").as_deref(), Some("budget"));
    assert_eq!(settings.get("output-dir").as_deref(), Some("/home/ana/tables"));
    let setup = page_setup(&print);
    assert_eq!(setup.paper_size().name().as_deref(), Some("iso_a4"));
    assert_eq!(setup.orientation(), gtk::PageOrientation::Portrait);
    for margin in
        [setup.top_margin(gtk::Unit::Mm), setup.bottom_margin(gtk::Unit::Mm), setup.left_margin(gtk::Unit::Mm), setup.right_margin(gtk::Unit::Mm)]
    {
        assert!((margin - 12.0).abs() < 1e-9, "{margin}");
    }

    // Landscape: a portrait page wider than tall. The settings the dialog had stay.
    let print = Print { settings: Vec::new(), paper: Paper::Custom("iso_a4-wide".into(), "iso_a4 landscape".into(), 297.0, 210.0), margin: 0.0 };
    assert_eq!(print_settings(Some(settings), &print).get("output-basename").as_deref(), Some("budget"));
    let setup = page_setup(&print);
    let paper = setup.paper_size();
    assert_eq!(paper.name().as_deref(), Some("iso_a4-wide"));
    assert!((paper.width(gtk::Unit::Mm) - 297.0).abs() < 1e-6 && (paper.height(gtk::Unit::Mm) - 210.0).abs() < 1e-6);
    assert_eq!(setup.orientation(), gtk::PageOrientation::Portrait);
}
