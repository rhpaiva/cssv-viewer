// Linux only: setting up an AppImage to open .cssv files, and the print
// dialog's defaults.
//
// An installed package (.deb, .rpm) registers the viewer with the desktop
// itself. An AppImage is a single file the reader runs from anywhere, so on
// request it writes the same registration into the reader's home folder: a
// menu entry that runs this AppImage, the CSSV media type for *.cssv files
// (SPEC 3.3 registers none, so the name is local to the desktop), and the
// icons. The entry's name matches the window's class (cssv-viewer), which is
// how the dock and the window switcher find the icon.

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{Manager, WebviewWindow};

use crate::Integration;

const ENTRY: &str = "cssv-viewer.desktop";
const MIME: &str = "text/x-cssv";
/// The line in our menu entry that names the AppImage it runs.
const MARK: &str = "X-CSSV-Viewer-AppImage=";
const MIME_XML: &str = include_str!("../linux/cssv-viewer.xml");
const ICONS: [(&str, &[u8]); 4] = [
    ("32x32", include_bytes!("../icons/32x32.png")),
    ("128x128", include_bytes!("../icons/128x128.png")),
    ("256x256", include_bytes!("../icons/128x128@2x.png")),
    ("512x512", include_bytes!("../icons/icon.png")),
];

/// The AppImage this viewer runs from, if it does.
fn appimage() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_file())
}

fn data_home() -> Option<PathBuf> {
    match std::env::var_os("XDG_DATA_HOME") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => Some(PathBuf::from(std::env::var_os("HOME")?).join(".local/share")),
    }
}

fn entry_path(data: &Path) -> PathBuf {
    data.join("applications").join(ENTRY)
}

fn icon_paths(data: &Path) -> impl Iterator<Item = (PathBuf, &'static [u8])> + '_ {
    ICONS.into_iter().flat_map(move |(size, png)| {
        let dir = data.join("icons/hicolor").join(size);
        // The app's icon, and the same icon for .cssv files in file managers.
        [(dir.join("apps/cssv-viewer.png"), png), (dir.join("mimetypes/text-x-cssv.png"), png)]
    })
}

/// The AppImage our menu entry runs, if the entry is ours.
fn installed_for(data: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(entry_path(data)).ok()?;
    text.lines().find_map(|line| line.strip_prefix(MARK)).map(PathBuf::from)
}

pub fn status() -> Integration {
    let available = appimage().is_some();
    let installed = data_home().and_then(|d| installed_for(&d)).is_some();
    Integration { available, installed }
}

/// A value for Exec=, quoted as the Desktop Entry spec asks.
fn exec_arg(path: &Path) -> String {
    let mut out = String::from('"');
    for c in path.to_string_lossy().chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

fn write_entry(data: &Path, appimage: &Path) -> Result<(), String> {
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName=CSSV Viewer\nComment=A desktop viewer for CSSV files\n\
         Exec={} %F\nTryExec={}\nIcon=cssv-viewer\nTerminal=false\nCategories=Office;Viewer;\n\
         MimeType={MIME};\nStartupWMClass=cssv-viewer\n{MARK}{}\n",
        exec_arg(appimage),
        appimage.display(),
        appimage.display(),
    );
    write(&entry_path(data), entry.as_bytes())
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    std::fs::write(path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))
}

/// Runs one of the desktop's own tools. AppRun points the library and data
/// paths at the AppImage's copies, which the system's tools must not load.
fn host(program: &str, args: &[&str]) {
    let mut command = Command::new(program);
    command.args(args);
    for var in [
        "LD_LIBRARY_PATH", "GIO_MODULE_DIR", "GSETTINGS_SCHEMA_DIR", "GDK_PIXBUF_MODULEDIR",
        "GDK_PIXBUF_MODULE_FILE", "GTK_PATH", "GTK_EXE_PREFIX", "GTK_IM_MODULE",
        "GST_PLUGIN_SYSTEM_PATH_1_0", "GST_REGISTRY_FORK",
    ] {
        command.env_remove(var);
    }
    if let (Some(appdir), Ok(dirs)) = (std::env::var_os("APPDIR"), std::env::var("XDG_DATA_DIRS")) {
        let appdir = appdir.to_string_lossy().into_owned();
        let system: Vec<_> = dirs.split(':').filter(|d| !d.starts_with(&appdir)).collect();
        command.env("XDG_DATA_DIRS", system.join(":"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        command.current_dir(home);
    }
    // A missing tool only means the desktop picks the change up later.
    let _ = command.output();
}

fn refresh_caches(data: &Path) {
    host("update-mime-database", &[&data.join("mime").to_string_lossy()]);
    host("update-desktop-database", &[&data.join("applications").to_string_lossy()]);
    host("gtk-update-icon-cache", &["-f", "-t", &data.join("icons/hicolor").to_string_lossy()]);
}

pub fn install() -> Result<(), String> {
    let appimage = appimage().ok_or("The viewer isn't running as an AppImage.")?;
    let data = data_home().ok_or("No home folder.")?;
    write_entry(&data, &appimage)?;
    write(&data.join("mime/packages/cssv-viewer.xml"), MIME_XML.as_bytes())?;
    for (path, png) in icon_paths(&data) {
        write(&path, png)?;
    }
    refresh_caches(&data);
    host("xdg-mime", &["default", ENTRY, MIME]);
    Ok(())
}

pub fn remove() -> Result<(), String> {
    let data = data_home().ok_or("No home folder.")?;
    if installed_for(&data).is_none() {
        return Ok(()); // not ours to remove
    }
    let mut files = vec![entry_path(&data), data.join("mime/packages/cssv-viewer.xml")];
    files.extend(icon_paths(&data).map(|(path, _)| path));
    for file in files {
        match std::fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!("Could not remove {}: {e}", file.display()));
            }
            _ => {}
        }
    }
    refresh_caches(&data);
    forget_default();
    Ok(())
}

/// Takes the viewer out of mimeapps.list, where `xdg-mime default` made it
/// the app for .cssv files.
fn forget_default() {
    let config = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => match std::env::var_os("HOME") {
            Some(home) => PathBuf::from(home).join(".config"),
            None => return,
        },
    };
    let list = config.join("mimeapps.list");
    let Ok(text) = std::fs::read_to_string(&list) else { return };
    let ours = format!("{MIME}={ENTRY}");
    let kept: Vec<_> = text.lines().filter(|line| line.trim() != ours).collect();
    if kept.len() < text.lines().count() {
        let _ = std::fs::write(&list, kept.join("\n") + "\n");
    }
}

/// At start: if the menu entry runs an AppImage that is gone (moved, or
/// replaced by a newer download), point it at this one.
pub fn refresh() {
    let (Some(appimage), Some(data)) = (appimage(), data_home()) else { return };
    if let Some(old) = installed_for(&data) {
        if old != appimage && !old.is_file() {
            let _ = write_entry(&data, &appimage);
            host("update-desktop-database", &[&data.join("applications").to_string_lossy()]);
        }
    }
}

/// Sets up the print dialog: the PDF that "Print to File" writes is named
/// after the opened file, in its folder (budget.cssv prints to budget.pdf;
/// GTK otherwise picks "output" in Documents, or in the current folder, which
/// in an AppImage is read-only), and the page is the print preview's, since
/// WebKitGTK takes paper and orientation from GTK, not from @page.
pub fn prepare_prints(window: &WebviewWindow) {
    use webkit2gtk::{PrintOperationExt, WebViewExt};
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let _ = window.with_webview(move |webview| {
        webview.inner().connect_print(move |_, operation| {
            if let Some(file) = crate::file_of(&app, &label) {
                let settings = operation.print_settings().unwrap_or_else(gtk::PrintSettings::new);
                if let Some(stem) = file.file_stem() {
                    settings.set("output-basename", Some(&stem.to_string_lossy()));
                }
                // A path, not a URI: GTK 3.24 joins it with the file name.
                if let Some(dir) = file.parent() {
                    settings.set("output-dir", Some(&dir.to_string_lossy()));
                }
                operation.set_print_settings(&settings);
            }
            if let Some(page) = crate::page_of(&app, &label) {
                let setup = gtk::PageSetup::new();
                let (name, w, h) = if page.paper == "letter" { ("na_letter", 215.9, 279.4) } else { ("iso_a4", 210.0, 297.0) };
                // WebKitGTK prints a landscape page blank, so landscape is a
                // portrait page that is wider than it is tall.
                let paper = if page.landscape {
                    gtk::PaperSize::new_custom(&format!("{name}-wide"), &format!("{name} landscape"), h, w, gtk::Unit::Mm)
                } else {
                    gtk::PaperSize::new(Some(name))
                };
                setup.set_paper_size(&paper);
                setup.set_orientation(gtk::PageOrientation::Portrait);
                setup.set_top_margin(page.margin, gtk::Unit::Mm);
                setup.set_bottom_margin(page.margin, gtk::Unit::Mm);
                setup.set_left_margin(page.margin, gtk::Unit::Mm);
                setup.set_right_margin(page.margin, gtk::Unit::Mm);
                operation.set_page_setup(&setup);
            }
            false // go on to the print dialog
        });
    });
}
