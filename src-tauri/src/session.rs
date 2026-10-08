// The session: the files the windows showed when the viewer last quit, so a
// start without files shows them again. It's a JSON list of paths in the
// app's config folder.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn file(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("session.json"))
}

pub fn save(app: &AppHandle, paths: &[PathBuf]) {
    let Some(file) = file(app) else { return };
    let paths: Vec<_> = paths.iter().map(|p| p.to_string_lossy()).collect();
    let Ok(json) = serde_json::to_string_pretty(&paths) else { return };
    if let Some(folder) = file.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    let _ = std::fs::write(file, json);
}

pub fn load(app: &AppHandle) -> Vec<PathBuf> {
    let Some(text) = file(app).and_then(|f| std::fs::read_to_string(f).ok()) else { return Vec::new() };
    serde_json::from_str::<Vec<String>>(&text).unwrap_or_default().into_iter().map(PathBuf::from).collect()
}
