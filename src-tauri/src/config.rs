//! 全局常量、窗口标识与不依赖应用状态的纯工具函数。
//!
//! 本模块不依赖任何其他业务模块，是依赖图的根节点。

use std::time::Duration;

// ---------- 全局快捷键 ----------

/// 唤出速记窗口的默认快捷键（可被 settings.json 覆盖）
pub const HOTKEY_MAIN: &str = "Alt+Q";
/// 唤出历史记录窗口的默认快捷键（可被 settings.json 覆盖）
pub const HOTKEY_HISTORY: &str = "Ctrl+Alt+Q";

/// Wayland Portal 会话 ID（稳定标识；X11 下忽略）
pub const SESSION_ID: &str = "spark-toggle";
pub const SESSION_ID_HISTORY: &str = "spark-history-toggle";
/// 合成器快捷键授权对话框中展示的描述
pub const SESSION_DESCRIPTION: &str = "Spark 速记";
pub const SESSION_DESCRIPTION_HISTORY: &str = "Spark 历史记录";

// ---------- 数据文件 ----------

/// 数据目录名：~/.local/share/spark/
pub const APP_DIR: &str = "spark";
pub const NOTES_FILE: &str = "notes.jsonl";
pub const SETTINGS_FILE: &str = "settings.json";

// ---------- 窗口 ----------

pub const LABEL_MAIN: &str = "main";
pub const LABEL_HISTORY: &str = "history";
pub const LABEL_SETTINGS: &str = "settings";

/// 主窗口逻辑尺寸（须与 tauri.conf.json 保持一致）
pub const WIN_W: f64 = 400.0;
pub const WIN_H: f64 = 450.0;
/// 主窗口最小尺寸（须与 tauri.conf.json 保持一致）
pub const WIN_MIN_W: f64 = 320.0;
pub const WIN_MIN_H: f64 = 260.0;

/// 显示后的最小可见时长：忽略此窗口期内的失焦事件，
/// 避免 show/focus 事件乱序导致窗口刚弹出就被收起
pub const MIN_VISIBLE: Duration = Duration::from_millis(250);

// ---------- 工具函数 ----------

/// 是否运行在 Wayland（Portal 会话无法热更快捷键）
pub fn is_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// 取自定义快捷键，未设置时回退默认值
pub fn effective_hotkey(custom: Option<String>, default: &str) -> String {
    custom.unwrap_or_else(|| default.to_string())
}

/// 去掉首尾空白，空串返回 None（用于把前端的 "" 归一为「未设置」）
pub fn non_empty(s: String) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}
