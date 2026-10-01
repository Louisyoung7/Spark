//! 窗口管理：速记 / 历史 / 设置三个窗口的显示与切换，以及失焦收起策略。

use std::sync::Mutex;
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};
use tauri_plugin_desktop_integration::DesktopIntegrationExt;

use crate::config::{LABEL_HISTORY, LABEL_MAIN, LABEL_SETTINGS, MIN_VISIBLE, WIN_H, WIN_W};

/// 主窗口最近一次显示时刻（点击窗口外收起的防抖护栏）
#[derive(Default)]
pub struct LastShownAt(pub Mutex<Option<Instant>>);

/// 计算"鼠标附近"的窗口物理坐标，并 clamp 到光标所在显示器内。
/// 拿不到光标位置或匹配不到显示器时返回 None（调用方回退居中）。
/// 注意：Wayland 下 set_position 会被合成器忽略，属预期平台差异。
fn position_near_cursor(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let cursor = app.cursor_position().ok()?;
    let monitors = app.available_monitors().ok()?;
    let monitor = monitors.into_iter().find(|m| {
        let p = m.position();
        let s = m.size();
        let (x, y) = (p.x as f64, p.y as f64);
        let (w, h) = (s.width as f64, s.height as f64);
        cursor.x >= x && cursor.x < x + w && cursor.y >= y && cursor.y < y + h
    })?;

    let scale = monitor.scale_factor();
    let (mw, mh) = (WIN_W * scale, WIN_H * scale);
    let mp = monitor.position();
    let ms = monitor.size();
    let (x_min, y_min) = (mp.x as f64, mp.y as f64);
    let x_max = x_min + ms.width as f64 - mw;
    let y_max = y_min + ms.height as f64 - mh;

    // 窗口中心对齐光标，再夹进显示器可视区
    let x = if x_max > x_min { (cursor.x - mw / 2.0).clamp(x_min, x_max) } else { x_min };
    let y = if y_max > y_min { (cursor.y - mh / 2.0).clamp(y_min, y_max) } else { y_min };
    Some(PhysicalPosition::new(x as i32, y as i32))
}

/// 显示主窗口：定位（鼠标附近，失败回退居中）→ show → 原生激活聚焦。
pub fn show_main_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL_MAIN) else {
        return;
    };
    // 记录显示时刻，供"点击窗口外收起"防抖
    if let Some(state) = app.try_state::<LastShownAt>() {
        if let Ok(mut g) = state.0.lock() {
            *g = Some(Instant::now());
        }
    }
    if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
    }
    match position_near_cursor(app) {
        Some(pos) => {
            let _ = win.set_position(pos);
        }
        None => {
            let _ = win.center();
        }
    }
    let _ = win.show();
    // X11: 盖 _NET_WM_USER_TIME 时间戳并 gtk present_with_time，
    // 让窗口管理器把弹窗当作用户驱动的激活（拿到焦点）；Wayland: 无操作
    app.request_desktop_activation_assist(&win, "spark-show", LABEL_MAIN);
    // Wayland: 首次窗口可见后触发 Portal BindShortcuts（X11 下 no-op，幂等）
    app.set_shortcut_window(&win);
    // 通知前端聚焦输入框（DOM 焦点兜底）
    let _ = app.emit("focus-input", ());
}

/// 快捷键 / 托盘触发的 toggle：已显示 → 重新聚焦；隐藏 → 显示。
pub fn toggle_main_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL_MAIN) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        app.request_desktop_activation_assist(&win, "spark-refocus", LABEL_MAIN);
        let _ = win.set_focus();
        let _ = app.emit("focus-input", ());
    } else {
        show_main_window(app);
    }
}

/// 显示历史记录窗口并通知前端刷新列表。
pub fn show_history_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL_HISTORY) else {
        return;
    };
    if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
    }
    let _ = win.show();
    app.request_desktop_activation_assist(&win, "spark-history-show", LABEL_HISTORY);
    let _ = win.set_focus();
    let _ = app.emit("reload-history", ());
}

/// 历史窗口 toggle：已显示 → 隐藏；隐藏 → 显示。
pub fn toggle_history_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL_HISTORY) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        show_history_window(app);
    }
}

/// 显示设置窗口并通知前端刷新。
pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL_SETTINGS) else {
        return;
    };
    if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
    }
    let _ = win.show();
    app.request_desktop_activation_assist(&win, "spark-settings-show", LABEL_SETTINGS);
    let _ = win.set_focus();
    let _ = app.emit("reload-settings", ());
}

/// 设置窗口 toggle：已显示 → 隐藏；隐藏 → 显示。
pub fn toggle_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL_SETTINGS) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        show_settings_window(app);
    }
}

/// 前端可调用的统一入口（托盘和历史小图标都走这里）
#[tauri::command]
pub fn open_settings(app: AppHandle) {
    show_settings_window(&app);
}

/// 主窗口失焦时是否应当自动收起。
/// 刚显示的 MIN_VISIBLE 窗口期内忽略失焦，避免 show/focus 事件乱序导致弹窗闪收。
pub fn main_window_should_auto_hide(app: &AppHandle) -> bool {
    app.try_state::<LastShownAt>()
        .map(|s| {
            s.0
                .lock()
                .ok()
                .and_then(|g| g.map(|t| t.elapsed() >= MIN_VISIBLE))
                .unwrap_or(true)
        })
        .unwrap_or(true)
}

