//! 系统托盘：菜单与左键行为。

use tauri::AppHandle;

use crate::windows::{toggle_history_window, toggle_main_window, toggle_settings_window};

/// 极简系统托盘：「显示窗口」/「历史记录」/「设置」/「退出」；左键点击 toggle 速记窗口。
#[cfg(desktop)]
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let history_item = MenuItem::with_id(app, "history", "历史记录", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show_item, &history_item, &settings_item, &quit_item],
    )?;

    let icon = app
        .default_window_icon()
        .expect("未找到默认窗口图标")
        .clone();

    TrayIconBuilder::with_id("spark-tray")
        .icon(icon)
        .tooltip("Spark 速记")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_main_window(app),
            "history" => toggle_history_window(app),
            "settings" => toggle_settings_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
