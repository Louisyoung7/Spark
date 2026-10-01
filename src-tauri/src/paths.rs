//! 文件路径计算。
//!
//! 只做纯路径推导，不读取设置状态；涉及用户自定义路径的解析见 [`crate::settings`]。

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::config::{APP_DIR, NOTES_FILE, SETTINGS_FILE};

/// 数据目录：~/.local/share/spark/
pub fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".local").join("share").join(APP_DIR))
}

/// 默认笔记文件：~/.local/share/spark/notes.jsonl
pub fn default_notes_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join(NOTES_FILE))
}

/// 设置文件：~/.local/share/spark/settings.json
pub fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join(SETTINGS_FILE))
}
