//! 系统托盘：菜单与左键行为。

use tauri::{AppHandle, Emitter, Manager};

use crate::windows::{
    show_settings_window, toggle_history_window, toggle_main_window, toggle_settings_window,
};

/// 托盘「检查更新」菜单项句柄，用于发现新版本时动态改文字。
pub struct TrayCheckItem(pub tauri::menu::MenuItem<tauri::Wry>);

/// 极简系统托盘：「显示窗口」/「历史记录」/「设置」/「检查更新」/「退出」；
/// 左键点击 toggle 速记窗口。
#[cfg(desktop)]
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let history_item = MenuItem::with_id(app, "history", "历史记录", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let check_item = MenuItem::with_id(app, "check-update", "检查更新", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &history_item,
            &settings_item,
            &check_item,
            &quit_item,
        ],
    )?;

    // 保存句柄，供 update 模块发现新版本时修改菜单文字
    app.manage(TrayCheckItem(check_item.clone()));

    let Some(icon) = app.default_window_icon() else {
        log::error!("未找到默认窗口图标，托盘初始化失败");
        return Err(tauri::Error::AssetNotFound("默认窗口图标".into()));
    };
    let icon = icon.clone();

    TrayIconBuilder::with_id("spark-tray")
        .icon(icon)
        .tooltip("Spark 速记")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            log::debug!("托盘菜单点击: {}", event.id.as_ref());
            match event.id.as_ref() {
                "show" => toggle_main_window(app),
                "history" => toggle_history_window(app),
                "settings" => toggle_settings_window(app),
                "check-update" => {
                    show_settings_window(app);
                    if let Err(e) = app.emit("check-update", ()) {
                        log::warn!("通知检查更新失败: {e}");
                    }
                }
                "quit" => {
                    log::info!("用户从托盘退出应用");
                    app.exit(0);
                }
                other => log::warn!("收到未知托盘菜单项: {other}"),
            }
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
    log::info!("系统托盘已初始化");
    Ok(())
}

/// 修改「检查更新」菜单文字：发现新版本时显示版本号，否则恢复默认文案。
pub fn set_update_badge(app: &AppHandle, latest: Option<&str>) {
    let Some(state) = app.try_state::<TrayCheckItem>() else {
        return;
    };
    let text = match latest {
        Some(version) => format!("发现新版本 v{version}"),
        None => "检查更新".to_string(),
    };
    if let Err(e) = state.0.set_text(&text) {
        log::warn!("更新托盘菜单文字失败: {e}");
    }
}
