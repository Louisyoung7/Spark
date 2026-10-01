//! Spark —— 极简 Linux 桌面速记工具。
//!
//! 本文件只负责组装：插件注册、窗口事件分发、命令路由。
//! 具体业务逻辑分散在下列模块（依赖方向单向，无环）：
//!
//! ```text
//! config ──> paths ──> settings ──> notes
//!                          └──────> hotkeys ──> tray
//!              config ──> windows ──────┘
//! ```

mod config;
mod hotkeys;
mod notes;
mod paths;
mod settings;
mod tray;
mod windows;

use std::sync::Mutex;

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::config::{is_wayland, LABEL_MAIN, LABEL_SETTINGS, WIN_H, WIN_MIN_H, WIN_MIN_W, WIN_W};
use crate::hotkeys::{Capturing, abort_capture_if_any, register_on_startup};
use crate::settings::SettingsState;
use crate::windows::{LastShownAt, main_window_should_auto_hide, show_main_window};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance 必须最先注册：第二实例唤起已有窗口后自行退出
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        // 统一全局快捷键：X11 直接 grab，Wayland 走 XDG Portal
        .plugin(tauri_plugin_desktop_integration::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_xdg_portal::init())
        // 开机自启：Linux 写 ~/.config/autostart/spark.desktop
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--silent"]),
        ))
        .setup(|app| {
            app.manage(LastShownAt::default());
            app.manage(Capturing::default());
            app.manage(SettingsState(Mutex::new(settings::load_settings(
                app.handle(),
            ))));

            #[cfg(desktop)]
            tray::setup(app.handle())?;

            init_main_window(app);

            register_on_startup(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                // 关闭 = 隐藏，应用常驻后台，仅托盘「退出」可结束进程
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Focused(false) => {
                // 设置窗口：若在录制快捷键时切走，恢复绑定，
                // 否则全局快捷键会一直处于注销状态
                if window.label() == LABEL_SETTINGS {
                    if !is_wayland() {
                        abort_capture_if_any(window.app_handle());
                    }
                    return;
                }
                // 点击窗口外（失焦）→ 收起【速记窗口】，保留草稿（等同 Esc）。
                // 历史窗口不自动收起，避免查阅/复制时切到其他应用就被关闭。
                // IME 候选窗是 override-redirect 窗口，不会触发顶层失焦，不影响中文输入。
                if window.label() != LABEL_MAIN {
                    return;
                }
                if main_window_should_auto_hide(window.app_handle())
                    && window.is_visible().unwrap_or(false)
                {
                    let _ = window.hide();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            notes::save_note,
            notes::list_notes,
            notes::delete_note,
            settings::get_settings,
            settings::set_autostart,
            settings::pick_notes_path,
            settings::set_notes_path,
            hotkeys::set_hotkeys,
            hotkeys::begin_hotkey_capture,
            hotkeys::end_hotkey_capture,
            windows::open_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// WebKitGTK 的内容最小尺寸会撑大窗口：
/// 1) 重置 webview widget 的 size request，消除内容最小尺寸下限
/// 2) 显式收紧窗口最小约束、禁用最大化并回到配置尺寸
fn init_main_window(app: &mut tauri::App) {
    let Some(win) = app.get_webview_window(LABEL_MAIN) else {
        return;
    };
    let _ = win.with_webview(|webview| {
        use gtk::prelude::WidgetExt;
        webview.inner().set_size_request(1, 1);
    });
    let _ = win.set_maximizable(false);
    let _ = win.set_min_size(Some(tauri::LogicalSize::new(WIN_MIN_W, WIN_MIN_H)));
    let _ = win.set_size(tauri::LogicalSize::new(WIN_W, WIN_H));
}
