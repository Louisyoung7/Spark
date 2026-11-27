//! 回收站：删除的笔记先移入 `trash.jsonl`，保留固定天数后自动彻底删除。
//!
//! 删除、恢复、清空都会同时改动笔记文件与回收站文件，因此复用
//! [`crate::notes::lock_notes`] 串行化，避免与追加 / 编辑互相覆盖。

use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use chrono::{DateTime, Duration, FixedOffset, Local, SecondsFormat};
use tauri::AppHandle;

use crate::notes;
use crate::paths::trash_path;
use crate::settings;

/// 回收站保留天数：到期后由系统自动彻底删除
pub const RETENTION_DAYS: i64 = 30;

/// 回收站中的一条记录（`line` 为回收站文件中的 1 起始行号）
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub struct TrashEntry {
    pub line: usize,
    pub time: String,
    pub content: String,
    pub deleted_at: String,
    pub expires_at: String,
}

/// 回收站列表：附带保留天数，避免前端重复维护同一个常量
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub struct TrashView {
    pub retention_days: i64,
    pub entries: Vec<TrashEntry>,
}

/// 回收站文件中的原始记录
#[derive(serde::Deserialize, Clone, Debug, PartialEq, Eq)]
struct TrashRecord {
    time: String,
    content: String,
    deleted_at: String,
}

/// 解析一行回收站记录；空行、非法 JSON、缺字段或空内容都返回 None。
fn parse_trash_line(line: &str) -> Option<TrashRecord> {
    let raw: TrashRecord = serde_json::from_str(line.trim()).ok()?;
    let time = raw.time.trim().to_string();
    let content = raw.content.trim().to_string();
    let deleted_at = raw.deleted_at.trim().to_string();
    if time.is_empty() || content.is_empty() || deleted_at.is_empty() {
        return None;
    }
    Some(TrashRecord {
        time,
        content,
        deleted_at,
    })
}

/// 删除时间 + 保留天数得到到期时间；时间格式非法时返回 None
fn expires_at(deleted_at: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(deleted_at)
        .ok()
        .map(|t| t.with_timezone(&Local) + Duration::days(RETENTION_DAYS))
}

/// 是否已过保留期。时间无法解析时按未过期处理，避免误删无法识别的记录。
fn is_expired(deleted_at: &str, now: DateTime<Local>) -> bool {
    expires_at(deleted_at).is_some_and(|expires| expires <= now)
}

/// 过滤出未过期行，返回保留的行与删除数量；空行与损坏行原样保留。
fn purge_lines(lines: &[String], now: DateTime<Local>) -> (Vec<String>, usize) {
    let mut removed = 0;
    let kept = lines
        .iter()
        .filter(|line| {
            let expired = parse_trash_line(line).is_some_and(|r| is_expired(&r.deleted_at, now));
            if expired {
                removed += 1;
            }
            !expired
        })
        .cloned()
        .collect();
    (kept, removed)
}

/// 清理文件中已过期的记录，返回删除条数。
fn purge_file(path: &Path) -> Result<usize, String> {
    if !path.exists() {
        return Ok(0);
    }
    let lines = notes::read_lines(path)?;
    let (kept, removed) = purge_lines(&lines, Local::now());
    if removed > 0 {
        notes::write_lines_atomic(path, &kept)?;
        log::info!("回收站清理 {removed} 条过期记录");
    }
    Ok(removed)
}

/// 读取全部可展示的回收站条目，行号按物理行计算。
fn read_entries(path: &Path) -> Result<Vec<TrashEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let lines = notes::read_lines(path)?;
    Ok(lines
        .iter()
        .enumerate()
        .filter_map(|(idx, line)| {
            let record = parse_trash_line(line)?;
            let expires =
                expires_at(&record.deleted_at)?.to_rfc3339_opts(SecondsFormat::Secs, false);
            Some(TrashEntry {
                line: idx + 1,
                time: record.time,
                content: record.content,
                deleted_at: record.deleted_at,
                expires_at: expires,
            })
        })
        .collect())
}

/// 校验回收站行号仍指向前端持有的记录（用删除时间做乐观校验）。
fn verify_trash_line(
    lines: &[String],
    line: usize,
    expected_deleted_at: &str,
) -> Result<TrashRecord, String> {
    if line == 0 || line > lines.len() {
        return Err("记录不存在".into());
    }
    let record = parse_trash_line(&lines[line - 1]).ok_or_else(|| {
        log::warn!("回收站第 {line} 行无法解析");
        "记录不存在".to_string()
    })?;
    if record.deleted_at != expected_deleted_at {
        log::warn!(
            "回收站第 {line} 行乐观校验失败：期望 {expected_deleted_at}，实际 {}",
            record.deleted_at
        );
        return Err("记录已变化，请刷新后重试".into());
    }
    Ok(record)
}

/// 追加一行并确保父目录存在。
fn append_line(path: &Path, line: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| {
            log::error!("创建回收站目录失败（{}）: {e}", dir.display());
            format!("创建目录失败: {e}")
        })?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| {
            log::error!("打开回收站文件失败（{}）: {e}", path.display());
            format!("打开文件失败: {e}")
        })?;
    writeln!(file, "{line}").map_err(|e| {
        log::error!("写入回收站失败（{}）: {e}", path.display());
        format!("写入失败: {e}")
    })
}

/// 取一行笔记的时间；空行、损坏行或时间非法都返回 None。
fn line_time(line: &str) -> Option<DateTime<FixedOffset>> {
    let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
    DateTime::parse_from_rfc3339(value.get("time")?.as_str()?).ok()
}

/// 按时间升序把记录插回笔记行，尽量还原删除前的位置。
///
/// 写入顺序决定列表顺序（列表按文件逆序展示），因此不能简单追加到末尾。
/// 时间相同时排在同时间记录之后；时间无法解析时退化为追加。
fn insert_note_line(lines: &[String], note: &str, time: &str) -> Vec<String> {
    let mut next = lines.to_vec();
    let target = DateTime::parse_from_rfc3339(time).ok();
    let index = target.and_then(|target| {
        next.iter()
            .position(|line| line_time(line).is_some_and(|t| t > target))
    });
    match index {
        Some(index) => next.insert(index, note.to_string()),
        None => next.push(note.to_string()),
    }
    next
}

/// 从笔记文件读出指定行的正文（与笔记列表共用同一套物理行号）。
fn note_content(lines: &[String], line: usize) -> Result<String, String> {
    let value = serde_json::from_str::<serde_json::Value>(lines[line - 1].trim())
        .map_err(|e| format!("记录解析失败: {e}"))?;
    value
        .get("content")
        .and_then(|c| c.as_str())
        .map(|c| c.to_string())
        .ok_or_else(|| "记录解析失败".to_string())
}

/// 删除指定行（1 起始）的笔记：先写入回收站，再从笔记文件移除。
///
/// 顺序保证中途失败最多留下一条重复记录，不会丢失数据。
#[tauri::command]
pub fn delete_note(app: AppHandle, line: usize, expected_time: String) -> Result<(), String> {
    let notes_path = settings::notes_path(&app)?;
    let trash_path = trash_path(&app)?;
    let _guard = notes::lock_notes();
    if !notes_path.exists() {
        return Ok(());
    }
    let mut lines = notes::read_lines(&notes_path)?;
    let time = notes::verify_line(&lines, line, &expected_time)?;
    let content = note_content(&lines, line)?;

    let deleted_at = Local::now().to_rfc3339_opts(SecondsFormat::Secs, false);
    let record = serde_json::json!({ "time": time, "content": content, "deleted_at": deleted_at })
        .to_string();
    if let Err(e) = append_line(&trash_path, &record) {
        log::error!("写入回收站失败（{}）: {e}", trash_path.display());
        return Err(e);
    }

    lines.remove(line - 1);
    let result = notes::write_lines_atomic(&notes_path, &lines);
    match &result {
        Ok(()) => log::info!("笔记第 {line} 行已移入回收站"),
        Err(e) => log::error!("从笔记移除第 {line} 行失败: {e}"),
    }
    result
}

/// 列出回收站记录（最新删除在前），返回前先清理过期记录。
#[tauri::command]
pub fn list_trash(app: AppHandle) -> Result<TrashView, String> {
    let path = trash_path(&app)?;
    let _guard = notes::lock_notes();
    // 清理失败不阻塞列表展示，过期记录下次启动或打开时再处理
    if let Err(e) = purge_file(&path) {
        log::warn!("清理回收站失败: {e}");
    }
    let mut entries = read_entries(&path)?;
    entries.reverse(); // 最新删除在前
    Ok(TrashView {
        retention_days: RETENTION_DAYS,
        entries,
    })
}

/// 把回收站中的指定记录恢复到笔记末尾，保留原记录时间。
///
/// 已存在相同 `time + content` 时不重复写入，保证重复点击不会产生副本。
#[tauri::command]
pub fn restore_trash_note(
    app: AppHandle,
    line: usize,
    expected_deleted_at: String,
) -> Result<(), String> {
    let notes_path = settings::notes_path(&app)?;
    let trash_path = trash_path(&app)?;
    let _guard = notes::lock_notes();
    if !trash_path.exists() {
        return Err("记录不存在".into());
    }
    let mut trash_lines = notes::read_lines(&trash_path)?;
    let record = verify_trash_line(&trash_lines, line, &expected_deleted_at)?;

    let note_lines = if notes_path.exists() {
        notes::read_lines(&notes_path)?
    } else {
        Vec::new()
    };
    let exists = note_lines.iter().any(|line| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            return false;
        };
        value.get("time").and_then(|t| t.as_str()) == Some(record.time.as_str())
            && value.get("content").and_then(|c| c.as_str()) == Some(record.content.as_str())
    });
    if !exists {
        // 保留原时间，并按时间插回原位置，避免恢复后跑到列表最前面
        let note =
            serde_json::json!({ "time": &record.time, "content": &record.content }).to_string();
        let merged = insert_note_line(&note_lines, &note, &record.time);
        if let Some(dir) = notes_path.parent() {
            fs::create_dir_all(dir).map_err(|e| {
                log::error!("创建笔记目录失败（{}）: {e}", dir.display());
                format!("创建目录失败: {e}")
            })?;
        }
        notes::write_lines_atomic(&notes_path, &merged)?;
        log::info!("回收站第 {line} 行已恢复到笔记文件");
    } else {
        log::debug!("回收站第 {line} 行已存在，跳过恢复");
    }

    trash_lines.remove(line - 1);
    notes::write_lines_atomic(&trash_path, &trash_lines)
}

/// 彻底删除回收站中的指定记录。
#[tauri::command]
pub fn purge_trash_note(
    app: AppHandle,
    line: usize,
    expected_deleted_at: String,
) -> Result<(), String> {
    let path = trash_path(&app)?;
    let _guard = notes::lock_notes();
    if !path.exists() {
        return Err("记录不存在".into());
    }
    let mut lines = notes::read_lines(&path)?;
    verify_trash_line(&lines, line, &expected_deleted_at)?;
    lines.remove(line - 1);
    notes::write_lines_atomic(&path, &lines)
}

/// 清空回收站。
#[tauri::command]
pub fn empty_trash(app: AppHandle) -> Result<(), String> {
    let path = trash_path(&app)?;
    let _guard = notes::lock_notes();
    if !path.exists() {
        return Ok(());
    }
    notes::write_lines_atomic(&path, &[])?;
    log::info!("回收站已清空");
    Ok(())
}

/// 启动时清理过期记录，避免应用长期驻留后台时回收站无限增长。
pub fn purge_expired(app: &AppHandle) -> Result<usize, String> {
    let path = trash_path(app)?;
    let _guard = notes::lock_notes();
    purge_file(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(time: &str, content: &str, deleted_at: &str) -> String {
        serde_json::json!({ "time": time, "content": content, "deleted_at": deleted_at })
            .to_string()
    }

    fn days_ago(days: i64) -> String {
        (Local::now() - Duration::days(days)).to_rfc3339_opts(SecondsFormat::Secs, false)
    }

    #[test]
    fn parse_trash_line_accepts_valid_record() {
        let parsed = parse_trash_line(&record("t1", "内容", "d1")).unwrap();
        assert_eq!(parsed.time, "t1");
        assert_eq!(parsed.content, "内容");
        assert_eq!(parsed.deleted_at, "d1");
    }

    #[test]
    fn parse_trash_line_rejects_invalid_records() {
        assert!(parse_trash_line("").is_none());
        assert!(parse_trash_line("not json").is_none());
        assert!(parse_trash_line(r#"{"time":"t1","content":"内容"}"#).is_none());
        assert!(parse_trash_line(r#"{"time":"t1","deleted_at":"d1"}"#).is_none());
        assert!(parse_trash_line(r#"{"time":"t1","content":"  ","deleted_at":"d1"}"#).is_none());
        assert!(parse_trash_line(r#"{"time":" ","content":"内容","deleted_at":"d1"}"#).is_none());
        assert!(parse_trash_line(r#"{"time":"t1","content":"内容","deleted_at":" "}"#).is_none());
    }

    #[test]
    fn is_expired_respects_retention_days() {
        let now = Local::now();
        assert!(is_expired(&days_ago(RETENTION_DAYS + 1), now));
        assert!(!is_expired(&days_ago(RETENTION_DAYS - 1), now));
    }

    #[test]
    fn is_expired_keeps_unparsable_timestamp() {
        assert!(!is_expired("not-a-time", Local::now()));
    }

    #[test]
    fn purge_lines_removes_only_expired_records() {
        let lines = vec![
            record("t1", "过期", &days_ago(RETENTION_DAYS + 1)),
            record("t2", "保留", &days_ago(1)),
            String::new(),
            "not json".to_string(),
        ];
        let (kept, removed) = purge_lines(&lines, Local::now());

        assert_eq!(removed, 1);
        assert_eq!(kept.len(), 3);
        assert_eq!(kept[0], lines[1]);
        assert_eq!(kept[1], String::new());
        assert_eq!(kept[2], "not json");
    }

    #[test]
    fn verify_trash_line_checks_deleted_at() {
        let lines = vec![record("t1", "内容", "d1")];
        assert!(verify_trash_line(&lines, 1, "d2").is_err());
        assert_eq!(verify_trash_line(&lines, 1, "d1").unwrap().content, "内容");
    }

    #[test]
    fn verify_trash_line_rejects_out_of_range_and_invalid() {
        let lines = vec![record("t1", "内容", "d1"), "not json".to_string()];
        assert!(verify_trash_line(&lines, 0, "d1").is_err());
        assert!(verify_trash_line(&lines, 3, "d1").is_err());
        assert!(verify_trash_line(&lines, 2, "d1").is_err());
    }

    #[test]
    fn note_content_reads_content_by_physical_line() {
        let lines = vec![String::new(), record("t1", "正文", "d1")];
        assert_eq!(note_content(&lines, 2).unwrap(), "正文");
        assert!(note_content(&lines, 1).is_err());
    }

    #[test]
    fn insert_note_line_restores_original_position() {
        let lines = vec![
            record("2026-11-01T10:00:00+08:00", "一", "d"),
            record("2026-11-03T10:00:00+08:00", "三", "d"),
        ];
        let restored = record("2026-11-02T10:00:00+08:00", "二", "d");

        let merged = insert_note_line(&lines, &restored, "2026-11-02T10:00:00+08:00");

        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0], lines[0]);
        assert_eq!(merged[1], restored);
        assert_eq!(merged[2], lines[1]);
    }

    #[test]
    fn insert_note_line_appends_when_newest() {
        let lines = vec![record("2026-11-01T10:00:00+08:00", "一", "d")];
        let restored = record("2026-11-05T10:00:00+08:00", "二", "d");

        let merged = insert_note_line(&lines, &restored, "2026-11-05T10:00:00+08:00");

        assert_eq!(merged.last().unwrap(), &restored);
    }

    #[test]
    fn insert_note_line_keeps_equal_time_after_existing() {
        let lines = vec![
            record("2026-11-01T10:00:00+08:00", "一", "d"),
            record("2026-11-01T10:00:00+08:00", "二", "d"),
        ];
        let restored = record("2026-11-01T10:00:00+08:00", "三", "d");

        let merged = insert_note_line(&lines, &restored, "2026-11-01T10:00:00+08:00");

        assert_eq!(merged.len(), 3);
        assert_eq!(merged[2], restored);
    }

    #[test]
    fn insert_note_line_skips_corrupt_lines_when_ordering() {
        let lines = vec![
            "not json".to_string(),
            record("2026-11-03T10:00:00+08:00", "三", "d"),
        ];
        let restored = record("2026-11-02T10:00:00+08:00", "二", "d");

        let merged = insert_note_line(&lines, &restored, "2026-11-02T10:00:00+08:00");

        assert_eq!(merged[0], "not json");
        assert_eq!(merged[1], restored);
    }

    #[test]
    fn insert_note_line_appends_when_time_invalid() {
        let lines = vec![record("2026-11-01T10:00:00+08:00", "一", "d")];
        let restored = record("not-a-time", "二", "d");

        let merged = insert_note_line(&lines, &restored, "not-a-time");

        assert_eq!(merged.last().unwrap(), &restored);
    }
}
