//! 全局快捷键：启动时注册、设置变更时热更、录制模式暂停。
//!
//! X11 下通过 `global-shortcut` 插件直接注册，支持即时重新绑定；
//! Wayland 走 XDG Portal 会话（由 `desktop-integration` 插件管理），无法热更。

use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_desktop_integration::DesktopIntegrationExt;

use crate::config::{
    effective_hotkey, is_wayland, non_empty, HOTKEY_HISTORY, HOTKEY_MAIN, SESSION_DESCRIPTION,
    SESSION_DESCRIPTION_HISTORY, SESSION_ID, SESSION_ID_HISTORY,
};
use crate::settings;
use crate::windows::{toggle_history_window, toggle_main_window};

/// 是否处于快捷键录制模式（录制期间全局快捷键被临时注销）
#[derive(Default)]
pub struct Capturing(pub Mutex<bool>);

/// 按当前设置重新注册两个全局快捷键。
/// - Ok(true)：X11，已立即生效
/// - Ok(false)：Wayland，无法热更，需重启应用
/// - Err：快捷键字符串无法解析 / 已被占用等真实失败
pub fn rebind(app: &AppHandle) -> Result<bool, String> {
    if is_wayland() {
        return Ok(false);
    }
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let gs = app.global_shortcut();
    // 清掉启动时经 desktop-integration 注册的旧绑定，再按新设置重新注册
    gs.unregister_all()
        .map_err(|e| format!("清理旧快捷键失败: {e}"))?;

    let s = settings::snapshot(app);
    let hk_main = effective_hotkey(s.hotkey_main.clone(), HOTKEY_MAIN);
    let hk_history = effective_hotkey(s.hotkey_history.clone(), HOTKEY_HISTORY);

    let handle_main = app.clone();
    gs.on_shortcut(hk_main.as_str(), move |_app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            toggle_main_window(&handle_main);
        }
    })
    .map_err(|e| format!("快捷键「{hk_main}」无效或已被占用: {e}"))?;

    let handle_history = app.clone();
    gs.on_shortcut(hk_history.as_str(), move |_app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            toggle_history_window(&handle_history);
        }
    })
    .map_err(|e| format!("快捷键「{hk_history}」无效或已被占用: {e}"))?;

    Ok(true)
}

/// 启动时注册全局快捷键。X11 走 direct grab，Wayland 走 Portal 会话。
pub fn register_on_startup(app: &AppHandle) {
    let snapshot = settings::snapshot(app);
    let handle = app.clone();

    let cb_main = handle.clone();
    let hk_main = effective_hotkey(snapshot.hotkey_main.clone(), HOTKEY_MAIN);
    handle.register_shortcut(SESSION_ID, SESSION_DESCRIPTION, &hk_main, move || {
        toggle_main_window(&cb_main);
    });

    let cb_history = handle.clone();
    let hk_history = effective_hotkey(snapshot.hotkey_history.clone(), HOTKEY_HISTORY);
    // 注：X11 下两个快捷键均可直接注册；Wayland Portal 路径下
    // desktop-integration 插件当前仅支持单快捷键会话，第二个注册
    // 会覆盖第一个的绑定状态，Wayland 环境以历史窗口快捷键为准。
    handle.register_shortcut(
        SESSION_ID_HISTORY,
        SESSION_DESCRIPTION_HISTORY,
        &hk_history,
        move || {
            toggle_history_window(&cb_history);
        },
    );
}

/// 保存自定义快捷键的结果
#[derive(serde::Serialize)]
pub struct HotkeyResult {
    /// 是否已立即生效（Wayland 下为 false，需重启）
    pub applied: bool,
    /// 供前端展示的提示语
    pub message: String,
}

/// 保存自定义快捷键（null / 空串表示恢复默认）。
/// 持久化后会立即重新注册全局快捷键，X11 下无需重启；
/// Wayland 的 Portal 会话不支持热更，此时返回 applied=false 提示重启。
#[tauri::command]
pub fn set_hotkeys(
    app: AppHandle,
    hotkey_main: Option<String>,
    hotkey_history: Option<String>,
) -> Result<HotkeyResult, String> {
    let hk_main = hotkey_main.and_then(non_empty);
    let hk_history = hotkey_history.and_then(non_empty);

    // 两个窗口的快捷键不能相同，否则后者会注册失败
    if let (Some(a), Some(b)) = (&hk_main, &hk_history) {
        if a.eq_ignore_ascii_case(b) {
            return Err("两个快捷键不能相同".into());
        }
    }

    // 保存旧值，注册失败时回滚，避免留下永远注册不上的死配置
    let prev = settings::snapshot(&app);
    settings::update(&app, |g| {
        g.hotkey_main = hk_main;
        g.hotkey_history = hk_history;
    })?;

    match rebind(&app) {
        Ok(true) => Ok(HotkeyResult {
            applied: true,
            message: "已生效".into(),
        }),
        Ok(false) => Ok(HotkeyResult {
            applied: false,
            message: "已保存，重启应用后生效（Wayland 限制）".into(),
        }),
        Err(e) => {
            // 回滚并恢复旧绑定，保证应用始终有可用快捷键
            let _ = settings::update(&app, |g| {
                g.hotkey_main = prev.hotkey_main.clone();
                g.hotkey_history = prev.hotkey_history.clone();
            });
            let _ = rebind(&app);
            Err(e)
        }
    }
}

/// 进入快捷键录制模式：临时注销全部全局快捷键，
/// 避免用户按下 Alt+Q 这类组合时把对应窗口弹出来打断录制。
#[tauri::command]
pub fn begin_hotkey_capture(app: AppHandle) -> Result<(), String> {
    if is_wayland() {
        // Portal 会话里的绑定无法临时注销，录制时可能触发，属已知限制
        return Ok(());
    }
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| format!("暂停快捷键失败: {e}"))?;
    set_capturing(&app, true);
    Ok(())
}

/// 退出录制模式：按当前设置重新注册全局快捷键。
#[tauri::command]
pub fn end_hotkey_capture(app: AppHandle) -> Result<(), String> {
    if is_wayland() {
        return Ok(());
    }
    set_capturing(&app, false);
    rebind(&app)?;
    Ok(())
}

fn set_capturing(app: &AppHandle, value: bool) {
    if let Some(s) = app.try_state::<Capturing>() {
        if let Ok(mut g) = s.0.lock() {
            *g = value;
        }
    }
}

/// 若正处于录制模式则退出并恢复绑定。
/// 用于窗口失焦等异常中断场景，避免全局快捷键一直处于注销状态。
pub fn abort_capture_if_any(app: &AppHandle) {
    let was_capturing = app
        .try_state::<Capturing>()
        .and_then(|s| {
            s.0.lock().ok().map(|mut g| {
                let v = *g;
                *g = false;
                v
            })
        })
        .unwrap_or(false);
    if was_capturing && !is_wayland() {
        let _ = rebind(app);
    }
}
