//! 版本更新：查询 GitHub 最新 Release，比较版本并在应用内下载安装 deb。
//!
//! 检查时间与结果缓存在 `settings.json`，同一台机器每 24 小时最多自动检查一次。
//! 安装通过 `pkexec` 调起系统授权弹窗执行 `apt-get install`，成功后自动重启。

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
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
/// 允许打开 / 下载的本仓库地址前缀
const RELEASE_PREFIX: &str = "https://github.com/Louisyoung7/Spark/";
/// 允许下载安装包的地址前缀
const DOWNLOAD_PREFIX: &str = "https://github.com/Louisyoung7/Spark/releases/download/";
/// 自动检查间隔：24 小时
const CHECK_INTERVAL_SECS: i64 = 24 * 60 * 60;
/// 更新说明最多保留的字符数
const NOTES_MAX_CHARS: usize = 2000;
/// 单次请求的整体超时
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// 安装包下载的整体超时（大文件与慢网络）
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// 一次检查得到的结果（同时用于事件广播与设置页渲染）
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub has_update: bool,
    pub release_url: String,
    pub published_at: Option<String>,
    pub notes: String,
    /// deb 安装包下载地址（旧缓存或没有 deb 资产时为 None）
    pub download_url: Option<String>,
    /// deb 安装包字节数，用于校验下载完整性
    pub download_size: Option<u64>,
    /// epoch 秒
    pub checked_at: i64,
}

/// 下载 / 安装进度，通过 `update-progress` 事件推送给设置页
#[derive(Clone, serde::Serialize)]
struct UpdateProgress {
    /// downloading / installing
    stage: &'static str,
    downloaded: u64,
    total: u64,
}

/// 全局更新状态：内存缓存 + 检查中的并发标记。
#[derive(Default)]
pub struct UpdateState(Mutex<UpdateRuntime>);

#[derive(Default)]
struct UpdateRuntime {
    info: Option<UpdateInfo>,
    checking: bool,
    downloading: bool,
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
    #[serde(default)]
    assets: Vec<AssetResp>,
}

/// Release 中的单个附件
#[derive(Deserialize, Clone)]
struct AssetResp {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
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

/// 当前应用的安装形态，决定下载哪种产物以及如何安装
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InstallKind {
    AppImage,
    Deb,
    Rpm,
}

impl InstallKind {
    /// 附件名后缀
    fn suffix(self) -> &'static str {
        match self {
            InstallKind::AppImage => ".appimage",
            InstallKind::Deb => ".deb",
            InstallKind::Rpm => ".rpm",
        }
    }

    /// 下载到缓存目录时使用的扩展名
    fn extension(self) -> &'static str {
        match self {
            InstallKind::AppImage => "AppImage",
            InstallKind::Deb => "deb",
            InstallKind::Rpm => "rpm",
        }
    }
}

/// 识别当前进程来自 AppImage、deb 还是 rpm。
///
/// 先看 AppImage 运行时注入的环境变量，再查包管理器归属；
/// 都不是（例如直接运行编译产物）时按系统里的包管理器兜底。
fn detect_install_kind() -> InstallKind {
    if std::env::var_os("APPIMAGE").is_some() {
        return InstallKind::AppImage;
    }

    let exe = std::env::current_exe().unwrap_or_default();
    if command_succeeds("dpkg-query", &[OsStr::new("-S"), exe.as_os_str()]) {
        return InstallKind::Deb;
    }
    if command_succeeds("rpm", &[OsStr::new("-qf"), exe.as_os_str()]) {
        return InstallKind::Rpm;
    }

    if command_exists("dnf") || command_exists("zypper") {
        InstallKind::Rpm
    } else {
        InstallKind::Deb
    }
}

/// 在 PATH 中查找可执行命令
fn command_exists(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

/// 命令静默执行且退出码为 0
fn command_succeeds(name: &str, args: &[&OsStr]) -> bool {
    Command::new(name)
        .args(args)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// 常见桌面环境的 polkit 认证代理进程名
const POLKIT_AGENT_NAMES: &[&str] = &[
    "gnome-shell",
    "polkit-gnome-authentication-agent-1",
    "polkit-kde-authentication-agent-1",
    "polkit-qt5-authentication-agent-1",
    "polkit-qt6-authentication-agent-1",
    "polkit-mate-authentication-agent-1",
    "mate-polkit",
    "xfce-polkit",
    "lxpolkit",
    "lxqt-policykit-agent",
    "hyprpolkitagent",
    "budgie-polkit-dialog",
    "pantheon-polkit-agent",
    "deepin-polkit-agent",
    "ukui-polkit",
    "cosmic-polkit-agent",
    "phosh",
];

fn is_polkit_agent(exe_name: &str) -> bool {
    POLKIT_AGENT_NAMES.contains(&exe_name)
}

/// 扫描 /proc 判断桌面会话里是否有 polkit 认证代理。
///
/// 没有代理时 pkexec 无法弹出授权框。读不到 /proc 时返回 true，
/// 避免因权限限制误判把更新完全阻断。
fn polkit_agent_running() -> bool {
    let Ok(entries) = fs::read_dir("/proc") else {
        return true;
    };
    for entry in entries.flatten() {
        let is_pid = entry
            .file_name()
            .to_str()
            .map(|name| !name.is_empty() && name.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false);
        if !is_pid {
            continue;
        }
        // cmdline 比 comm 更完整（comm 会被截断到 15 个字符）
        let Ok(cmdline) = fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        if cmdline.is_empty() {
            continue; // 内核线程没有 cmdline
        }
        let first = cmdline.split(|b| *b == 0).next().unwrap_or_default();
        let exe = String::from_utf8_lossy(first);
        if is_polkit_agent(exe.rsplit('/').next().unwrap_or("")) {
            return true;
        }
    }
    false
}

/// 解析 GitHub 响应；标签无法识别时返回 Ok(None)，视为「没有可用更新」
fn parse_release_json(
    json: &str,
    current: &str,
    kind: InstallKind,
) -> Result<Option<UpdateInfo>, String> {
    let release: ReleaseResp =
        serde_json::from_str(json).map_err(|e| format!("解析更新信息失败: {e}"))?;
    let Some(has_update) = is_newer(&release.tag_name, current) else {
        log::warn!("忽略无法识别的版本标签: {}", release.tag_name);
        return Ok(None);
    };
    let latest = normalize_version(&release.tag_name)
        .unwrap_or(&release.tag_name)
        .to_string();

    // 下载与当前安装形态一致的产物；没有对应附件时前端仍可回退到发布页
    let asset = pick_asset(&release.assets, kind);
    Ok(Some(UpdateInfo {
        current: current.to_string(),
        latest,
        has_update,
        release_url: release.html_url,
        published_at: release.published_at,
        notes: truncate_notes(release.body.as_deref().unwrap_or(""), NOTES_MAX_CHARS),
        download_url: asset.as_ref().map(|a| a.browser_download_url.clone()),
        download_size: asset.as_ref().map(|a| a.size).filter(|size| *size > 0),
        checked_at: 0,
    }))
}

/// 只允许打开本仓库的 GitHub 页面
fn validate_release_url(url: &str) -> bool {
    url.starts_with(RELEASE_PREFIX)
}

/// 只允许下载本仓库 Release 中的附件
fn validate_download_url(url: &str) -> bool {
    url.starts_with(DOWNLOAD_PREFIX)
}

/// 从附件中挑出与安装形态匹配的产物；只接受本仓库的下载地址
fn pick_asset(assets: &[AssetResp], kind: InstallKind) -> Option<AssetResp> {
    assets
        .iter()
        .find(|a| {
            a.name.to_ascii_lowercase().ends_with(kind.suffix())
                && validate_download_url(&a.browser_download_url)
        })
        .cloned()
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------- 网络 ----------

/// 构建带版本 UA、超时与可选代理的 Agent
fn build_agent(
    version: &str,
    proxy: Option<&str>,
    timeout: Duration,
) -> Result<ureq::Agent, String> {
    let mut builder = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .user_agent(format!("Spark/{version}"));
    if let Some(url) = proxy {
        let parsed = ureq::Proxy::new(url).map_err(|_| "代理地址无效".to_string())?;
        builder = builder.proxy(Some(parsed));
    }
    Ok(builder.build().into())
}

/// 同步请求 GitHub 最新 Release（在 blocking 线程中调用）。
/// `proxy` 为空时保留 ureq 默认行为：读取 ALL_PROXY / HTTPS_PROXY 环境变量。
fn fetch_latest(
    current: &str,
    proxy: Option<&str>,
    kind: InstallKind,
) -> Result<Option<UpdateInfo>, String> {
    let agent = build_agent(current, proxy, REQUEST_TIMEOUT)?;

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
    parse_release_json(&text, current, kind)
}

// ---------- 下载与安装 ----------

/// 流式下载安装包到缓存目录，边下边广播进度。
fn download_package(
    app: &AppHandle,
    version: &str,
    url: &str,
    expected_size: Option<u64>,
    proxy: Option<&str>,
    kind: InstallKind,
) -> Result<PathBuf, String> {
    if !validate_download_url(url) {
        return Err("无效的下载地址".to_string());
    }

    let agent = build_agent(version, proxy, DOWNLOAD_TIMEOUT)?;
    let mut response = agent
        .get(url)
        .call()
        .map_err(|e| format!("下载安装包失败: {e}"))?;
    let total = response
        .body()
        .content_length()
        .or(expected_size)
        .unwrap_or(0);

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("获取缓存目录失败: {e}"))?
        .join("updates");
    fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败: {e}"))?;
    let path = dir.join(format!("spark-update.{}", kind.extension()));

    let mut file = File::create(&path).map_err(|e| format!("创建安装包文件失败: {e}"))?;
    let mut reader = response.body_mut().as_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    let mut last_percent = u64::MAX;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("下载中断: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("写入安装包失败: {e}"))?;
        downloaded += n as u64;
        let percent = downloaded
            .saturating_mul(100)
            .checked_div(total)
            .unwrap_or(0)
            .min(100);
        if percent != last_percent {
            last_percent = percent;
            let _ = app.emit(
                "update-progress",
                UpdateProgress {
                    stage: "downloading",
                    downloaded,
                    total,
                },
            );
        }
    }
    file.flush().map_err(|e| format!("写入安装包失败: {e}"))?;
    drop(file);

    if downloaded == 0 {
        let _ = fs::remove_file(&path);
        return Err("下载的安装包为空".to_string());
    }
    // 附件大小已知时校验，避免网络截断导致装坏包
    if let Some(expected) = expected_size.filter(|size| *size > 0) {
        if downloaded != expected {
            let _ = fs::remove_file(&path);
            return Err(format!(
                "安装包大小不一致（期望 {expected} 字节，实际 {downloaded} 字节）"
            ));
        }
    }
    Ok(path)
}

/// 通过 pkexec 弹系统授权框执行安装命令。
fn run_privileged(program: &str, args: &[&OsStr]) -> Result<(), String> {
    let output = Command::new("pkexec")
        .arg(program)
        .args(args)
        .output()
        .map_err(|e| format!("无法启动系统授权程序: {e}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    // 没有认证代理时 pkexec 会直接失败，转成可操作的提示
    if stderr
        .to_ascii_lowercase()
        .contains("no authentication agent")
    {
        return Err("未检测到 polkit 认证代理，请从发布页手动下载安装".to_string());
    }

    match output.status.code() {
        // polkit：用户取消 / 未获得授权
        Some(126) => return Err("已取消系统授权，安装未执行".to_string()),
        Some(127) => return Err("未获得安装授权，请检查 polkit 认证代理后重试".to_string()),
        _ => {}
    }

    let lines: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
    let detail = lines[lines.len().saturating_sub(3)..].join(" ");
    if detail.is_empty() {
        Err(format!("安装失败（退出码 {:?}）", output.status.code()))
    } else {
        Err(format!("安装失败：{detail}"))
    }
}

/// deb：apt 安装下载好的包
fn install_deb(app: &AppHandle, path: &Path) -> Result<(), String> {
    emit_installing(app);
    run_privileged(
        "env",
        &[
            OsStr::new("DEBIAN_FRONTEND=noninteractive"),
            OsStr::new("apt-get"),
            OsStr::new("install"),
            OsStr::new("-y"),
            path.as_os_str(),
        ],
    )
}

/// rpm：按系统里的包管理器选择 dnf 或 zypper
fn install_rpm(app: &AppHandle, path: &Path) -> Result<(), String> {
    emit_installing(app);
    if command_exists("dnf") {
        return run_privileged(
            "dnf",
            &[OsStr::new("install"), OsStr::new("-y"), path.as_os_str()],
        );
    }
    if command_exists("zypper") {
        return run_privileged(
            "zypper",
            &[
                OsStr::new("--non-interactive"),
                OsStr::new("install"),
                OsStr::new("--allow-unsigned-rpm"),
                path.as_os_str(),
            ],
        );
    }
    Err("未找到 dnf / zypper，请手动安装下载好的 rpm".to_string())
}

/// AppImage：直接替换当前 AppImage 文件，无需授权。
/// 返回替换后的路径，供退出后重新启动。
fn install_appimage(app: &AppHandle, downloaded: &Path) -> Result<PathBuf, String> {
    emit_progress(app, "replacing");
    let target = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .ok_or_else(|| "未找到 AppImage 路径，请手动下载替换".to_string())?;

    // 先复制到同目录再原子替换，避免跨文件系统 rename 失败
    let mut tmp = target.clone().into_os_string();
    tmp.push(".new");
    let tmp = PathBuf::from(tmp);
    fs::copy(downloaded, &tmp).map_err(|e| format!("写入新版本失败: {e}"))?;
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("设置可执行权限失败: {e}"))?;
    if let Err(e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("替换 AppImage 失败（目录可能不可写）: {e}"));
    }
    Ok(target)
}

/// 退出后由 shell 延迟启动新 AppImage，避免与单实例保护冲突
fn relaunch_appimage(target: &Path) -> Result<(), String> {
    Command::new("sh")
        .arg("-c")
        .arg("sleep 1; exec \"$1\"")
        .arg("sh")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("启动新版本失败，请手动打开: {e}"))
}

fn emit_progress(app: &AppHandle, stage: &'static str) {
    let _ = app.emit(
        "update-progress",
        UpdateProgress {
            stage,
            downloaded: 0,
            total: 0,
        },
    );
}

fn emit_installing(app: &AppHandle) {
    emit_progress(app, "installing");
}

/// 下载并安装最新版本；成功后重启应用（不会返回）。
async fn run_download_and_install(app: &AppHandle) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    let proxy = settings::snapshot(app).proxy;
    let kind = detect_install_kind();

    // deb/rpm 依赖 pkexec 弹授权框，没有代理就不必白下载
    if kind != InstallKind::AppImage && !polkit_agent_running() {
        return Err("未检测到 polkit 认证代理，无法在应用内安装，请从发布页手动下载".to_string());
    }

    let cached = {
        let state = app.state::<UpdateState>();
        let g = state
            .0
            .lock()
            .map_err(|e| format!("锁定更新状态失败: {e}"))?;
        g.info.clone()
    };

    // 缓存结果没有附件信息（例如刚启动）时，重新请求一次 Release
    let info = match cached.filter(|i| i.has_update && i.download_url.is_some()) {
        Some(info) => info,
        None => {
            let current_for_request = current.clone();
            let proxy_for_request = proxy.clone();
            let fetched = tauri::async_runtime::spawn_blocking(move || {
                fetch_latest(&current_for_request, proxy_for_request.as_deref(), kind)
            })
            .await
            .map_err(|e| format!("检查更新失败: {e}"))??
            .filter(|i| i.has_update)
            .ok_or_else(|| "没有可下载的新版本".to_string())?;
            fetched
        }
    };

    let url = info.download_url.clone().ok_or_else(|| {
        format!(
            "该版本没有提供 {} 安装包，请从发布页手动下载",
            kind.extension()
        )
    })?;
    let expected_size = info.download_size;

    let app_for_download = app.clone();
    let version = current.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        download_package(
            &app_for_download,
            &version,
            &url,
            expected_size,
            proxy.as_deref(),
            kind,
        )
    })
    .await
    .map_err(|e| format!("下载失败: {e}"))??;

    log::info!("已下载新版本 {}（{:?}）", info.latest, kind);

    if kind == InstallKind::AppImage {
        // AppImage 不需要授权，替换文件后由新进程接管
        let target = {
            let app_for_install = app.clone();
            let install_path = path.clone();
            tauri::async_runtime::spawn_blocking(move || {
                install_appimage(&app_for_install, &install_path)
            })
            .await
            .map_err(|e| format!("安装失败: {e}"))??
        };
        let _ = fs::remove_file(&path);
        relaunch_appimage(&target)?;
        log::info!("已替换 AppImage，正在重启");
        app.exit(0);
        return Ok(());
    }

    let app_for_install = app.clone();
    let install_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || match kind {
        InstallKind::Deb => install_deb(&app_for_install, &install_path),
        InstallKind::Rpm => install_rpm(&app_for_install, &install_path),
        InstallKind::AppImage => unreachable!(),
    })
    .await
    .map_err(|e| format!("安装失败: {e}"))??;

    let _ = fs::remove_file(&path);
    log::info!("已安装新版本 {}，正在重启", info.latest);
    app.restart()
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
        // 缓存里没有附件信息；下载时会重新请求一次 Release
        download_url: None,
        download_size: None,
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

/// 当前安装形态与授权能力，供设置页决定应用内安装还是跳转下载
#[derive(serde::Serialize)]
pub struct UpdateCapability {
    /// appimage / deb / rpm
    pub install_kind: &'static str,
    /// 是否依赖 polkit 授权（AppImage 不需要）
    pub requires_polkit: bool,
    /// 是否检测到 polkit 认证代理；不需要授权时恒为 true
    pub polkit_agent: bool,
}

#[tauri::command]
pub fn get_update_capability() -> UpdateCapability {
    let kind = detect_install_kind();
    UpdateCapability {
        install_kind: match kind {
            InstallKind::AppImage => "appimage",
            InstallKind::Deb => "deb",
            InstallKind::Rpm => "rpm",
        },
        requires_polkit: kind != InstallKind::AppImage,
        polkit_agent: kind == InstallKind::AppImage || polkit_agent_running(),
    }
}

/// 检查更新。`force = false` 时受 24 小时节流限制（启动静默检查使用）。
#[tauri::command]
pub async fn check_update(app: AppHandle, force: bool) -> Result<Option<UpdateInfo>, String> {
    check_update_inner(app, force).await
}

/// 应用内下载并安装最新版本。成功后自动重启，不会返回。
#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<(), String> {
    {
        let state = app.state::<UpdateState>();
        let mut g = state
            .0
            .lock()
            .map_err(|e| format!("锁定更新状态失败: {e}"))?;
        if g.downloading {
            return Err("正在下载更新…".to_string());
        }
        g.downloading = true;
    }

    let result = run_download_and_install(&app).await;

    // 出错时恢复标记，允许重试；成功路径会重启进程
    if let Some(state) = app.try_state::<UpdateState>() {
        if let Ok(mut g) = state.0.lock() {
            g.downloading = false;
        }
    }
    result
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
    // 显式配置的代理优先；未配置时 fetch_latest 读取环境变量
    let proxy = settings::snapshot(&app).proxy;
    let kind = detect_install_kind();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        fetch_latest(&current_for_request, proxy.as_deref(), kind)
    })
    .await;
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
        let info = parse_release_json(json, "0.10.0", InstallKind::Deb)
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
        assert!(parse_release_json(json, "0.10.0", InstallKind::Deb)
            .unwrap()
            .is_none());
    }

    #[test]
    fn parse_release_json_picks_deb_asset() {
        let json = r#"{
            "tag_name": "v0.11.0",
            "html_url": "https://github.com/Louisyoung7/Spark/releases/tag/v0.11.0",
            "assets": [
                {
                    "name": "Spark_0.11.0_amd64.AppImage",
                    "browser_download_url": "https://github.com/Louisyoung7/Spark/releases/download/v0.11.0/Spark_0.11.0_amd64.AppImage",
                    "size": 100
                },
                {
                    "name": "Spark_0.11.0_amd64.deb",
                    "browser_download_url": "https://github.com/Louisyoung7/Spark/releases/download/v0.11.0/Spark_0.11.0_amd64.deb",
                    "size": 2048
                }
            ]
        }"#;
        let info = parse_release_json(json, "0.10.0", InstallKind::Deb)
            .unwrap()
            .unwrap();
        assert_eq!(
            info.download_url.as_deref(),
            Some("https://github.com/Louisyoung7/Spark/releases/download/v0.11.0/Spark_0.11.0_amd64.deb")
        );
        assert_eq!(info.download_size, Some(2048));

        // 同一份 Release 在 AppImage / rpm 形态下应选中各自产物
        let image = parse_release_json(json, "0.10.0", InstallKind::AppImage)
            .unwrap()
            .unwrap();
        assert_eq!(
            image.download_url.as_deref(),
            Some("https://github.com/Louisyoung7/Spark/releases/download/v0.11.0/Spark_0.11.0_amd64.AppImage")
        );
        assert!(parse_release_json(json, "0.10.0", InstallKind::Rpm)
            .unwrap()
            .unwrap()
            .download_url
            .is_none());
    }

    #[test]
    fn pick_asset_ignores_foreign_urls() {
        let assets = vec![AssetResp {
            name: "Spark_0.11.0_amd64.deb".to_string(),
            browser_download_url: "https://example.com/Spark_0.11.0_amd64.deb".to_string(),
            size: 1,
        }];
        assert!(pick_asset(&assets, InstallKind::Deb).is_none());
    }

    #[test]
    fn recognizes_common_polkit_agents() {
        assert!(is_polkit_agent("polkit-gnome-authentication-agent-1"));
        assert!(is_polkit_agent("polkit-kde-authentication-agent-1"));
        assert!(is_polkit_agent("hyprpolkitagent"));
        assert!(is_polkit_agent("gnome-shell"));
        assert!(!is_polkit_agent("bash"));
        assert!(!is_polkit_agent(""));
    }

    #[test]
    fn validate_download_url_only_allows_release_assets() {
        assert!(validate_download_url(
            "https://github.com/Louisyoung7/Spark/releases/download/v0.11.0/Spark_0.11.0_amd64.deb"
        ));
        assert!(!validate_download_url(
            "https://github.com/Louisyoung7/Spark/releases/tag/v0.11.0"
        ));
        assert!(!validate_download_url(
            "https://example.com/Spark_0.11.0_amd64.deb"
        ));
    }

    #[test]
    fn parse_release_json_handles_empty_body() {
        let json = r#"{
            "tag_name": "v0.10.0",
            "html_url": "https://github.com/Louisyoung7/Spark/releases/tag/v0.10.0"
        }"#;
        let info = parse_release_json(json, "0.10.0", InstallKind::Deb)
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
