//! 用户偏好设置的持久化与设置类命令。
//!
//! 设置存放在 `~/.local/share/spark/settings.json`，`Option` 字段为 `None` 表示使用内置默认值。
//! 写入采用「临时文件 + 原子替换」，避免写一半崩溃损坏配置。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::config::{effective_hotkey, HOTKEY_HISTORY, HOTKEY_MAIN};
use crate::paths::{default_notes_path, settings_path};

/// 用户可配置项。`Option` 字段：None = 使用内置默认。
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub notes_path: Option<PathBuf>,
    #[serde(default)]
    pub hotkey_main: Option<String>,
    #[serde(default)]
    pub hotkey_history: Option<String>,
    /// 主题：None 表示跟随系统；持久化取值 "light" / "dark"
    #[serde(default)]
    pub theme: Option<String>,
    /// 上次检查更新的 epoch 秒（用于 24 小时节流）
    #[serde(default)]
    pub last_update_check: Option<i64>,
    /// 最近一次检查到的最新版本号（不带 v 前缀）
    #[serde(default)]
    pub latest_version: Option<String>,
    /// 最近一次检查到的更新说明摘要
    #[serde(default)]
    pub latest_update_notes: Option<String>,
}

/// 全局共享的设置状态。启动时一次性从磁盘加载，写入时持久化。
#[derive(Default)]
pub struct SettingsState(pub Mutex<AppSettings>);

// ---------- 读写 ----------

pub fn load_settings(app: &AppHandle) -> AppSettings {
    let Ok(path) = settings_path(app) else {
        return AppSettings::default();
    };
    if !path.exists() {
        return AppSettings::default();
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("读取设置失败，使用默认设置（{}）: {e}", path.display());
            return AppSettings::default();
        }
    };
    match serde_json::from_str::<AppSettings>(&text) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("解析设置失败，使用默认设置（{}）: {e}", path.display());
            AppSettings::default()
        }
    }
}

pub fn save_settings(app: &AppHandle, s: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(s).map_err(|e| format!("序列化失败: {e}"))?;
    // 临时文件 + 原子替换，避免写一半崩溃损坏配置
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("写入失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换失败: {e}"))?;
    Ok(())
}

/// 取当前设置的快照（拿不到状态时回退默认值）
pub fn snapshot(app: &AppHandle) -> AppSettings {
    app.try_state::<SettingsState>()
        .and_then(|s| s.0.lock().ok().map(|g| g.clone()))
        .unwrap_or_default()
}

/// 先落盘、成功后再替换内存值。
///
/// 写盘失败时内存保持旧值，避免「界面显示已生效、重启后又回退」的不一致。
fn save_then_commit<S>(
    current: &mut S,
    next: S,
    save: impl FnOnce(&S) -> Result<(), String>,
) -> Result<(), String> {
    save(&next)?;
    *current = next;
    Ok(())
}

/// 修改并持久化设置，返回修改后的快照。
pub fn update<F>(app: &AppHandle, mutate: F) -> Result<AppSettings, String>
where
    F: FnOnce(&mut AppSettings),
{
    let state = app.state::<SettingsState>();
    let mut g = state.0.lock().map_err(|e| format!("锁定设置失败: {e}"))?;
    let mut next = g.clone();
    mutate(&mut next);
    save_then_commit(&mut *g, next, |s| save_settings(app, s))?;
    Ok(g.clone())
}

// ---------- 路径解析 ----------

/// 当前生效的笔记文件：自定义优先，缺省时用默认位置
pub fn notes_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = snapshot(app).notes_path {
        return Ok(custom);
    }
    default_notes_path(app)
}

// ---------- 命令 ----------

/// 当前生效设置 + 默认值快照（供设置界面展示）
#[derive(serde::Serialize)]
pub struct SettingsView {
    pub autostart: bool,
    pub autostart_supported: bool,
    pub notes_path: String,
    pub notes_path_default: String,
    pub notes_path_is_default: bool,
    pub hotkey_main: String,
    pub hotkey_main_default: String,
    pub hotkey_main_custom: Option<String>,
    pub hotkey_history: String,
    pub hotkey_history_default: String,
    pub hotkey_history_custom: Option<String>,
    /// 当前主题模式：light / dark / system
    pub theme: String,
    /// 当前应用版本，用于设置页「关于」展示
    pub app_version: String,
}

/// 把存储值归一为前端可用的主题模式，非法值一律按跟随系统处理
fn normalize_theme(theme: Option<&str>) -> &'static str {
    match theme {
        Some("light") => "light",
        Some("dark") => "dark",
        _ => "system",
    }
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<SettingsView, String> {
    let s = snapshot(&app);
    let cur_notes = notes_path(&app)?.to_string_lossy().to_string();
    let def_notes = default_notes_path(&app)?.to_string_lossy().to_string();
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let supported = cfg!(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    ));

    Ok(SettingsView {
        autostart: autostart_enabled,
        autostart_supported: supported,
        notes_path: cur_notes,
        notes_path_default: def_notes,
        notes_path_is_default: s.notes_path.is_none(),
        hotkey_main: effective_hotkey(s.hotkey_main.clone(), HOTKEY_MAIN),
        hotkey_main_default: HOTKEY_MAIN.to_string(),
        hotkey_main_custom: s.hotkey_main.clone(),
        hotkey_history: effective_hotkey(s.hotkey_history.clone(), HOTKEY_HISTORY),
        hotkey_history_default: HOTKEY_HISTORY.to_string(),
        hotkey_history_custom: s.hotkey_history.clone(),
        theme: normalize_theme(s.theme.as_deref()).to_string(),
        app_version: app.package_info().version.to_string(),
    })
}

/// 切换主题并广播给所有窗口。`None` / "system" 表示跟随系统。
#[tauri::command]
pub fn set_theme(app: AppHandle, theme: Option<String>) -> Result<(), String> {
    let stored = match theme.as_deref() {
        Some("light") => Some("light".to_string()),
        Some("dark") => Some("dark".to_string()),
        None | Some("system") => None,
        Some(other) => return Err(format!("未知主题: {other}")),
    };
    update(&app, |g| g.theme = stored)?;
    let mode = normalize_theme(theme.as_deref());
    // 广播模式而非解析结果：各窗口需知道自己是否「跟随系统」
    app.emit("theme-changed", mode).map_err(|e| e.to_string())
}

/// 切换登录自启；同时把目标态持久化到 settings.json（保持与插件状态一致）
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| format!("启用失败: {e}"))?;
    } else {
        autolaunch.disable().map_err(|e| format!("禁用失败: {e}"))?;
    }
    update(&app, |g| g.autostart = enabled)?;
    Ok(())
}

/// 弹出原生保存对话框让用户选择笔记文件路径。返回 None 表示用户取消。
#[tauri::command]
pub async fn pick_notes_path(app: AppHandle) -> Result<Option<String>, String> {
    let cur = notes_path(&app).ok();
    let start_dir = cur
        .as_ref()
        .and_then(|p| p.parent())
        .map(|d| d.to_path_buf());
    let default_name = cur
        .as_ref()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("notes.jsonl")
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let mut dlg = rfd::FileDialog::new()
            .set_title("选择笔记保存位置")
            .set_file_name(&default_name)
            .add_filter("JSON Lines", &["jsonl"]);
        if let Some(dir) = start_dir {
            dlg = dlg.set_directory(dir);
        }
        Ok::<_, String>(dlg.save_file().map(|p| p.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("文件对话框失败: {e}"))?
}

/// 设置/清除自定义笔记路径。`path = null` 表示恢复默认。
/// 注意：旧路径上的历史文件不会被迁移，只是不再使用。
#[tauri::command]
pub fn set_notes_path(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let new_path = path.map(PathBuf::from);
    update(&app, |g| g.notes_path = new_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with_theme(theme: &str) -> AppSettings {
        AppSettings {
            theme: Some(theme.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn save_then_commit_keeps_old_value_when_save_fails() {
        let mut current = settings_with_theme("light");

        let result = save_then_commit(&mut current, settings_with_theme("dark"), |_| {
            Err("磁盘已满".to_string())
        });

        assert!(result.is_err());
        assert_eq!(current.theme.as_deref(), Some("light"));
    }

    #[test]
    fn save_then_commit_applies_value_when_save_succeeds() {
        let mut current = settings_with_theme("light");

        save_then_commit(&mut current, settings_with_theme("dark"), |saved| {
            assert_eq!(saved.theme.as_deref(), Some("dark"));
            Ok(())
        })
        .unwrap();

        assert_eq!(current.theme.as_deref(), Some("dark"));
    }
}
