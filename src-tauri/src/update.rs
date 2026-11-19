//! 版本更新检查：查询 GitHub 最新 Release，与当前版本比较并缓存结果。
//!
//! 第一阶段只做「检查 + 提示 + 跳转下载」，不负责应用内安装。
//! 检查时间与结果缓存在 `settings.json`，同一台机器每 24 小时最多自动检查一次。

use std::sync::Mutex;
use std::time::Duration;

use semver::Version;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::settings;
use crate::tray;

/// GitHub 最新 Release 接口（草稿与预发布不会出现在这里）
const RELEASES_API: &str = "https://api.github.com/repos/Louisyoung7/Spark/releases/latest";
/// 允许打开的下载页地址前缀
const RELEASE_PREFIX: &str = "https://github.com/Louisyoung7/Spark/";
/// 自动检查间隔：24 小时
const CHECK_INTERVAL_SECS: i64 = 24 * 60 * 60;
/// 更新说明最多保留的字符数
const NOTES_MAX_CHARS: usize = 2000;
/// 单次请求的整体超时
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// 一次检查得到的结果（同时用于事件广播与设置页渲染）
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub has_update: bool,
    pub release_url: String,
    pub published_at: Option<String>,
    pub notes: String,
    /// epoch 秒
    pub checked_at: i64,
}

/// 全局更新状态：内存缓存 + 检查中的并发标记。
#[derive(Default)]
pub struct UpdateState(Mutex<UpdateRuntime>);

#[derive(Default)]
struct UpdateRuntime {
    info: Option<UpdateInfo>,
    checking: bool,
}

/// GitHub Release 响应中实际用到的字段
#[derive(Deserialize)]
struct ReleaseResp {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
}

// ---------- 纯函数（可单测） ----------

/// 去掉可能存在的 `v` / `V` 前缀
fn normalize_version(raw: &str) -> Option<&str> {
    let t = raw.trim();
    let t = t
        .strip_prefix('v')
        .or_else(|| t.strip_prefix('V'))
        .unwrap_or(t);
    (!t.is_empty()).then_some(t)
}

fn parse_version(raw: &str) -> Option<Version> {
    Version::parse(normalize_version(raw)?).ok()
}

/// 远端版本是否比当前版本新；任一方无法解析时返回 None
fn is_newer(latest: &str, current: &str) -> Option<bool> {
    Some(parse_version(latest)? > parse_version(current)?)
}

/// 距上次检查是否已超过间隔；从未检查过时返回 true
fn should_check(last: Option<i64>, now: i64, interval_secs: i64) -> bool {
    match last {
        Some(last) => now.saturating_sub(last) >= interval_secs,
        None => true,
    }
}

/// 按字符截断更新说明，避免切断多字节字符
fn truncate_notes(body: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (i, ch) in body.trim().chars().enumerate() {
        if i >= max_chars {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

/// 解析 GitHub 响应；标签无法识别时返回 Ok(None)，视为「没有可用更新」
fn parse_release_json(json: &str, current: &str) -> Result<Option<UpdateInfo>, String> {
    let release: ReleaseResp =
        serde_json::from_str(json).map_err(|e| format!("解析更新信息失败: {e}"))?;
    let Some(has_update) = is_newer(&release.tag_name, current) else {
        log::warn!("忽略无法识别的版本标签: {}", release.tag_name);
        return Ok(None);
    };
    let latest = normalize_version(&release.tag_name)
        .unwrap_or(&release.tag_name)
        .to_string();

    Ok(Some(UpdateInfo {
        current: current.to_string(),
        latest,
        has_update,
        release_url: release.html_url,
        published_at: release.published_at,
        notes: truncate_notes(release.body.as_deref().unwrap_or(""), NOTES_MAX_CHARS),
        checked_at: 0,
    }))
}

/// 只允许打开本仓库的 GitHub 页面
fn validate_release_url(url: &str) -> bool {
    url.starts_with(RELEASE_PREFIX)
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------- 网络 ----------

/// 同步请求 GitHub 最新 Release（在 blocking 线程中调用）
fn fetch_latest(current: &str) -> Result<Option<UpdateInfo>, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .user_agent(format!("Spark/{current}"))
        .build()
        .into();

    let mut response = match agent
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call()
    {
        Ok(r) => r,
        // 还没有正式发布的 Release：按「无更新」处理
        Err(ureq::Error::StatusCode(404)) => return Ok(None),
        Err(ureq::Error::StatusCode(403)) => {
            return Err("GitHub 接口请求过于频繁，请稍后再试".to_string())
        }
        Err(e) => return Err(format!("检查更新失败: {e}")),
    };

    let text = response
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("读取更新信息失败: {e}"))?;
    parse_release_json(&text, current)
}

// ---------- 状态读取 ----------

/// 从内存或持久化缓存还原最近一次检查结果
fn cached_info(app: &AppHandle, current: &str) -> Option<UpdateInfo> {
    if let Some(state) = app.try_state::<UpdateState>() {
        if let Ok(g) = state.0.lock() {
            if let Some(info) = &g.info {
                return Some(info.clone());
            }
        }
    }

    let saved = settings::snapshot(app);
    let latest = saved.latest_version?;
    let has_update = is_newer(&latest, current)?;
    Some(UpdateInfo {
        current: current.to_string(),
        release_url: format!("{RELEASE_PREFIX}releases/tag/v{latest}"),
        latest,
        has_update,
        published_at: None,
        notes: saved.latest_update_notes.unwrap_or_default(),
        checked_at: saved.last_update_check.unwrap_or(0),
    })
}

// ---------- 命令 ----------

/// 读取最近一次检查结果，供设置页在打开时立即渲染
#[tauri::command]
pub fn get_update_status(app: AppHandle) -> Option<UpdateInfo> {
    let current = app.package_info().version.to_string();
    cached_info(&app, &current)
}

/// 检查更新。`force = false` 时受 24 小时节流限制（启动静默检查使用）。
#[tauri::command]
pub async fn check_update(app: AppHandle, force: bool) -> Result<Option<UpdateInfo>, String> {
    check_update_inner(app, force).await
}

async fn check_update_inner(app: AppHandle, force: bool) -> Result<Option<UpdateInfo>, String> {
    let current = app.package_info().version.to_string();

    if !force {
        let last = settings::snapshot(&app).last_update_check;
        if !should_check(last, now_epoch(), CHECK_INTERVAL_SECS) {
            return Ok(cached_info(&app, &current));
        }
    }

    // 三个入口可能同时触发，检查期间拒绝重复请求
    {
        let state = app.state::<UpdateState>();
        let mut g = state
            .0
            .lock()
            .map_err(|e| format!("锁定更新状态失败: {e}"))?;
        if g.checking {
            return Err("正在检查更新…".to_string());
        }
        g.checking = true;
    }

    let current_for_request = current.clone();
    let joined =
        tauri::async_runtime::spawn_blocking(move || fetch_latest(&current_for_request)).await;
    let checked = match joined {
        Ok(result) => result,
        Err(e) => Err(format!("检查更新失败: {e}")),
    };

    if let Some(state) = app.try_state::<UpdateState>() {
        if let Ok(mut g) = state.0.lock() {
            g.checking = false;
        }
    }

    // 无论成败都记录检查时间，避免离线时每次启动都重试
    let (cache_version, cache_notes) = match &checked {
        Ok(Some(info)) => (Some(info.latest.clone()), Some(info.notes.clone())),
        Ok(None) => (None, None),
        Err(_) => {
            let saved = settings::snapshot(&app);
            (saved.latest_version, saved.latest_update_notes)
        }
    };
    if let Err(e) = settings::update(&app, |g| {
        g.last_update_check = Some(now_epoch());
        g.latest_version = cache_version;
        g.latest_update_notes = cache_notes;
    }) {
        log::warn!("保存更新检查缓存失败: {e}");
    }

    match checked {
        Ok(Some(mut info)) => {
            info.checked_at = now_epoch();
            if let Some(state) = app.try_state::<UpdateState>() {
                if let Ok(mut g) = state.0.lock() {
                    g.info = Some(info.clone());
                }
            }
            let badge = info.has_update.then_some(info.latest.as_str());
            tray::set_update_badge(&app, badge);
            let _ = app.emit("update-status", &info);
            Ok(Some(info))
        }
        Ok(None) => {
            if let Some(state) = app.try_state::<UpdateState>() {
                if let Ok(mut g) = state.0.lock() {
                    g.info = None;
                }
            }
            tray::set_update_badge(&app, None);
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// 用系统默认浏览器打开 Release 页面
#[tauri::command]
pub fn open_release_page(app: AppHandle, url: String) -> Result<(), String> {
    if !validate_release_url(&url) {
        return Err("无效的下载地址".to_string());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("打开下载页失败: {e}"))
}

// ---------- 启动检查 ----------

/// 启动时按持久化缓存恢复托盘提示
pub fn apply_cached_badge(app: &AppHandle) {
    let current = app.package_info().version.to_string();
    let latest = settings::snapshot(app).latest_version;
    let badge = latest
        .as_deref()
        .filter(|l| is_newer(l, &current).unwrap_or(false));
    tray::set_update_badge(app, badge);
}

/// 启动后后台静默检查一次；失败只写日志
pub fn spawn_startup_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        match check_update_inner(app, false).await {
            Ok(Some(info)) if info.has_update => {
                log::info!("发现新版本 {}（当前 {}）", info.latest, info.current);
            }
            Ok(_) => log::debug!("启动检查更新：已是最新版本"),
            Err(e) => log::warn!("启动检查更新失败: {e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_newer_compares_semver() {
        assert_eq!(is_newer("0.11.0", "0.10.0"), Some(true));
        assert_eq!(is_newer("0.10.0", "0.10.0"), Some(false));
        assert_eq!(is_newer("0.9.0", "0.10.0"), Some(false));
        assert_eq!(is_newer("v0.11.0", "v0.10.0"), Some(true));
    }

    #[test]
    fn is_newer_rejects_invalid_tags() {
        assert_eq!(is_newer("latest", "0.10.0"), None);
        assert_eq!(is_newer("", "0.10.0"), None);
        assert_eq!(is_newer("0.11.0", "not-a-version"), None);
    }

    #[test]
    fn should_check_respects_interval() {
        let day = 24 * 60 * 60;
        assert!(should_check(None, 1_000, day));
        assert!(!should_check(Some(1_000), 1_000 + day - 1, day));
        assert!(should_check(Some(1_000), 1_000 + day, day));
    }

    #[test]
    fn truncate_notes_handles_multibyte_chars() {
        assert_eq!(truncate_notes("  短句  ", 10), "短句");
        assert_eq!(truncate_notes("一二三四五", 3), "一二三…");
        assert_eq!(truncate_notes("", 10), "");
    }

    #[test]
    fn parse_release_json_reads_update_info() {
        let json = r#"{
            "tag_name": "v0.11.0",
            "html_url": "https://github.com/Louisyoung7/Spark/releases/tag/v0.11.0",
            "body": "- 新增版本检查",
            "published_at": "2026-11-20T00:00:00Z"
        }"#;
        let info = parse_release_json(json, "0.10.0")
            .unwrap()
            .expect("应识别为可解析的版本");
        assert_eq!(info.latest, "0.11.0");
        assert!(info.has_update);
        assert_eq!(info.notes, "- 新增版本检查");
    }

    #[test]
    fn parse_release_json_ignores_invalid_tag() {
        let json = r#"{
            "tag_name": "nightly",
            "html_url": "https://github.com/Louisyoung7/Spark/releases/tag/nightly",
            "body": null,
            "published_at": null
        }"#;
        assert!(parse_release_json(json, "0.10.0").unwrap().is_none());
    }

    #[test]
    fn parse_release_json_handles_empty_body() {
        let json = r#"{
            "tag_name": "v0.10.0",
            "html_url": "https://github.com/Louisyoung7/Spark/releases/tag/v0.10.0"
        }"#;
        let info = parse_release_json(json, "0.10.0")
            .unwrap()
            .expect("同版本也应返回检查结果");
        assert!(!info.has_update);
        assert_eq!(info.notes, "");
    }

    #[test]
    fn validate_release_url_only_allows_repo_pages() {
        assert!(validate_release_url(
            "https://github.com/Louisyoung7/Spark/releases/tag/v0.11.0"
        ));
        assert!(!validate_release_url(
            "http://github.com/Louisyoung7/Spark/x"
        ));
        assert!(!validate_release_url(
            "https://example.com/Louisyoung7/Spark"
        ));
    }
}
