use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_desktop_integration::DesktopIntegrationExt;

/// 全局快捷键（默认；可被 settings.json 覆盖）
const HOTKEY_MAIN: &str = "Alt+Q"; // 唤出速记窗口
const HOTKEY_HISTORY: &str = "Alt+Z"; // 唤出历史记录窗口
/// Wayland Portal 会话 ID（稳定标识；X11 下忽略）
const SESSION_ID: &str = "spark-toggle";
const SESSION_ID_HISTORY: &str = "spark-history-toggle";
/// 合成器快捷键授权对话框中展示的描述
const SESSION_DESCRIPTION: &str = "Spark 速记";
const SESSION_DESCRIPTION_HISTORY: &str = "Spark 历史记录";
/// 数据目录：~/.local/share/spark/
const APP_DIR: &str = "spark";
const NOTES_FILE: &str = "notes.jsonl";
const SETTINGS_FILE: &str = "settings.json";
/// 主窗口逻辑尺寸（须与 tauri.conf.json 保持一致）
const WIN_W: f64 = 400.0;
const WIN_H: f64 = 450.0;
/// 主窗口最小尺寸（须与 tauri.conf.json 保持一致）
const WIN_MIN_W: f64 = 320.0;
const WIN_MIN_H: f64 = 260.0;
/// 显示后的最小可见时长：忽略此窗口期内的失焦事件，
/// 避免 show/focus 事件乱序导致窗口刚弹出就被收起
const MIN_VISIBLE: Duration = Duration::from_millis(250);

/// 主窗口最近一次显示时刻（点击窗口外收起的防抖护栏）
#[derive(Default)]
struct LastShownAt(Mutex<Option<Instant>>);

/// 用户可配置项持久化在 `~/.local/share/spark/settings.json`。
/// Option 字段：None = 使用内置默认。
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct AppSettings {
    #[serde(default)]
    autostart: bool,
    #[serde(default)]
    notes_path: Option<PathBuf>,
    #[serde(default)]
    hotkey_main: Option<String>,
    #[serde(default)]
    hotkey_history: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            autostart: false,
            notes_path: None,
            hotkey_main: None,
            hotkey_history: None,
        }
    }
}

/// 全局共享的设置状态。启动时一次性从磁盘加载，写入时持久化。
#[derive(Default)]
struct SettingsState(Mutex<AppSettings>);

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home
        .join(".local")
        .join("share")
        .join(APP_DIR)
        .join(SETTINGS_FILE))
}

fn load_settings(app: &AppHandle) -> AppSettings {
    let Ok(path) = settings_path(app) else {
        return AppSettings::default();
    };
    if !path.exists() {
        return AppSettings::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<AppSettings>(&t).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &AppSettings) -> Result<(), String> {
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

fn settings_snapshot(app: &AppHandle) -> AppSettings {
    app.try_state::<SettingsState>()
        .and_then(|s| s.0.lock().ok().map(|g| g.clone()))
        .unwrap_or_default()
}

fn set_settings<F>(app: &AppHandle, mutate: F) -> Result<AppSettings, String>
where
    F: FnOnce(&mut AppSettings),
{
    let state = app.state::<SettingsState>();
    let mut g = state.0.lock().map_err(|e| format!("锁定设置失败: {e}"))?;
    mutate(&mut g);
    save_settings(app, &g)?;
    Ok(g.clone())
}

/// 笔记文件路径：自定义优先；缺省时返回默认路径
fn notes_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = settings_snapshot(app).notes_path {
        return Ok(custom);
    }
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".local").join("share").join(APP_DIR).join(NOTES_FILE))
}

fn default_notes_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".local").join("share").join(APP_DIR).join(NOTES_FILE))
}

fn effective_hotkey(custom: Option<String>, default: &str) -> String {
    custom.unwrap_or_else(|| default.to_string())
}

/// 追加一条速记到当前笔记文件（JSON Lines）。
#[tauri::command]
fn save_note(app: AppHandle, content: String) -> Result<(), String> {
    // 去掉首尾空白；内部换行保留（serde_json 会转义为 \n，JSONL 每条仍是单行）
    let content = content.trim();
    if content.is_empty() {
        return Err("内容为空".into());
    }

    let path = notes_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }

    let time = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false);
    let line = serde_json::json!({ "time": time, "content": content }).to_string();

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开文件失败: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("写入失败: {e}"))?;
    Ok(())
}

/// 一条历史记录（`line` 为文件中的 1 起始行号，作为删除用的稳定 id）
#[derive(serde::Serialize)]
struct NoteEntry {
    line: usize,
    time: String,
    content: String,
}

/// 读取全部笔记，按最新在前返回。
#[tauri::command]
fn list_notes(app: AppHandle) -> Result<Vec<NoteEntry>, String> {
    let path = notes_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    let mut notes = Vec::new();
    for (idx, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 单行损坏时跳过该行，不影响其余记录展示
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        notes.push(NoteEntry {
            line: idx + 1,
            time: v
                .get("time")
                .and_then(|t| t.as_str())
                .unwrap_or_default()
                .to_string(),
            content: v
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or_default()
                .to_string(),
        });
    }
    notes.reverse(); // 最新在前
    Ok(notes)
}

/// 删除指定行（1 起始）的笔记，其余行写回。
#[tauri::command]
fn delete_note(app: AppHandle, line: usize) -> Result<(), String> {
    let path = notes_path(&app)?;
    if !path.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    let mut lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    if line == 0 || line > lines.len() {
        return Err("记录不存在".into());
    }
    lines.remove(line - 1);
    // 先写临时文件再原子替换，避免写一半崩溃损坏数据
    let tmp = path.with_extension("jsonl.tmp");
    let body = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };
    fs::write(&tmp, body).map_err(|e| format!("写入临时文件失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换文件失败: {e}"))?;
    Ok(())
}

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
fn show_main_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
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
    app.request_desktop_activation_assist(&win, "spark-show", "main");
    // Wayland: 首次窗口可见后触发 Portal BindShortcuts（X11 下 no-op，幂等）
    app.set_shortcut_window(&win);
    // 通知前端聚焦输入框（DOM 焦点兜底）
    let _ = app.emit("focus-input", ());
}

/// 快捷键 / 托盘触发的 toggle：已显示 → 重新聚焦；隐藏 → 显示。
fn toggle_main_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        app.request_desktop_activation_assist(&win, "spark-refocus", "main");
        let _ = win.set_focus();
        let _ = app.emit("focus-input", ());
    } else {
        show_main_window(app);
    }
}

/// 显示历史记录窗口并通知前端刷新列表。
fn show_history_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("history") else {
        return;
    };
    if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
    }
    let _ = win.show();
    app.request_desktop_activation_assist(&win, "spark-history-show", "history");
    let _ = win.set_focus();
    let _ = app.emit("reload-history", ());
}

/// Alt+Z toggle：已显示 → 隐藏；隐藏 → 显示。
fn toggle_history_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("history") else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        show_history_window(app);
    }
}

/// 显示设置窗口并通知前端刷新。
fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        return;
    };
    if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
    }
    let _ = win.show();
    app.request_desktop_activation_assist(&win, "spark-settings-show", "settings");
    let _ = win.set_focus();
    let _ = app.emit("reload-settings", ());
}

/// 设置窗口 toggle：已显示 → 隐藏；隐藏 → 显示。
fn toggle_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
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
fn open_settings(app: AppHandle) {
    show_settings_window(&app);
}

/// 当前生效设置 + 默认值快照（供设置界面展示）
#[derive(serde::Serialize)]
struct SettingsView {
    autostart: bool,
    autostart_supported: bool,
    notes_path: String,
    notes_path_default: String,
    notes_path_is_default: bool,
    hotkey_main: String,
    hotkey_main_default: String,
    hotkey_main_custom: Option<String>,
    hotkey_history: String,
    hotkey_history_default: String,
    hotkey_history_custom: Option<String>,
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<SettingsView, String> {
    let s = settings_snapshot(&app);
    let cur_notes = notes_path(&app)?.to_string_lossy().to_string();
    let def_notes = default_notes_path(&app)?.to_string_lossy().to_string();
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let supported = cfg!(any(target_os = "linux", target_os = "macos", target_os = "windows"));

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
    })
}

/// 切换登录自启；同时把目标态持久化到 settings.json（保持与插件状态一致）
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| format!("启用失败: {e}"))?;
    } else {
        autolaunch.disable().map_err(|e| format!("禁用失败: {e}"))?;
    }
    set_settings(&app, |g| g.autostart = enabled)?;
    Ok(())
}

/// 极简系统托盘：「显示窗口」/「历史记录」/「设置」/「退出」；左键点击 toggle 速记窗口。
#[cfg(desktop)]
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let history_item = MenuItem::with_id(app, "history", "历史记录", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &history_item, &settings_item, &quit_item])?;

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
            app.manage(SettingsState(Mutex::new(load_settings(app.handle()))));

            #[cfg(desktop)]
            setup_tray(app.handle())?;

            // WebKitGTK 的内容最小尺寸会撑大窗口：
            // 1) 重置 webview widget 的 size request，消除内容最小尺寸下限
            // 2) 显式收紧窗口最小约束并回到配置尺寸
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.with_webview(|webview| {
                    use gtk::prelude::WidgetExt;
                    webview.inner().set_size_request(1, 1);
                });
                let _ = win.set_maximizable(false);
                let _ = win.set_min_size(Some(tauri::LogicalSize::new(WIN_MIN_W, WIN_MIN_H)));
                let _ = win.set_size(tauri::LogicalSize::new(WIN_W, WIN_H));
            }

            let snapshot = settings_snapshot(app.handle());
            let handle = app.handle().clone();
            let cb_handle = handle.clone();
            let hk_main = effective_hotkey(snapshot.hotkey_main.clone(), HOTKEY_MAIN);
            handle.register_shortcut(SESSION_ID, SESSION_DESCRIPTION, &hk_main, move || {
                toggle_main_window(&cb_handle);
            });
            let cb_handle_history = handle.clone();
            let hk_history =
                effective_hotkey(snapshot.hotkey_history.clone(), HOTKEY_HISTORY);
            // 注：X11 下两个快捷键均可直接注册；Wayland Portal 路径下
            // desktop-integration 插件当前仅支持单快捷键会话，第二个注册
            // 会覆盖第一个的绑定状态，Wayland 环境以历史窗口快捷键为准。
            handle.register_shortcut(
                SESSION_ID_HISTORY,
                SESSION_DESCRIPTION_HISTORY,
                &hk_history,
                move || {
                    toggle_history_window(&cb_handle_history);
                },
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    // 关闭 = 隐藏，应用常驻后台，仅托盘「退出」可结束进程
                    api.prevent_close();
                    let _ = window.hide();
                }
                // 点击窗口外（失焦）→ 收起【速记窗口】，保留草稿（等同 Esc）。
                // 历史 / 设置窗口不自动收起。
                // IME 候选窗是 override-redirect 窗口，不会触发顶层失焦，不影响中文输入。
                WindowEvent::Focused(false) => {
                    if window.label() != "main" {
                        return;
                    }
                    let guard_passed = window
                        .app_handle()
                        .try_state::<LastShownAt>()
                        .map(|s| {
                            s.0
                                .lock()
                                .ok()
                                .and_then(|g| g.map(|t| t.elapsed() >= MIN_VISIBLE))
                                .unwrap_or(true)
                        })
                        .unwrap_or(true);
                    if guard_passed && window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            save_note,
            list_notes,
            delete_note,
            get_settings,
            set_autostart,
            open_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}