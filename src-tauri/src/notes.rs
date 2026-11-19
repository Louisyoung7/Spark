//! 笔记存储：追加、读取、删除。
//!
//! 数据以 JSON Lines 形式保存在当前笔记文件（默认 `~/.local/share/spark/notes.jsonl`，
//! 可在设置中自定义）。换行由 serde_json 转义，每条记录始终占一个物理行。

use std::collections::HashSet;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Manager};

use crate::settings;

/// 笔记文件操作的全局互斥锁。
///
/// 保存是追加写，编辑 / 删除是「读入 → 改写 → 原子替换」。
/// 两者若不串行化，替换会把期间追加的新记录一并覆盖丢失。
static NOTES_LOCK: Mutex<()> = Mutex::new(());

/// 取得笔记文件锁；锁中毒说明此前有线程 panic，仍继续使用（数据本身由原子写保护）
fn lock_notes() -> MutexGuard<'static, ()> {
    NOTES_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 一条历史记录（`line` 为文件中的 1 起始行号；`time` 作为乐观校验凭证）
#[derive(serde::Serialize)]
pub struct NoteEntry {
    pub line: usize,
    pub time: String,
    pub content: String,
}

/// 备份文件中的一条记录，仅保留存储所需的两个字段
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
struct NoteRecord {
    time: String,
    content: String,
}

/// 导入结果统计
#[derive(serde::Serialize, Debug, Default, PartialEq, Eq)]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub duplicates: usize,
}

/// 按物理行读取文件。列表、编辑、删除都必须基于同一套行号，
/// 否则文件中出现空行或损坏行时，前端拿到的 id 会指向错误记录。
fn read_lines(path: &Path) -> Result<Vec<String>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(text.lines().map(|l| l.to_string()).collect())
}

/// 与笔记文件同目录、同名的附带后缀路径（`notes.jsonl` → `notes.jsonl.bak`）。
/// 不用 `with_extension`，避免自定义文件名（如 `notes.txt`）被改成别的扩展名。
fn sibling_path(path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "笔记文件路径无效".to_string())?;
    Ok(path.with_file_name(format!("{name}{suffix}")))
}

/// 先备份原文件，再写临时文件并原子替换，避免写一半崩溃损坏数据；
/// 一次误删 / 误改后仍可从 `.bak` 找回上一版。
fn write_lines_atomic(path: &Path, lines: &[String]) -> Result<(), String> {
    if path.exists() {
        let backup = sibling_path(path, ".bak")?;
        fs::copy(path, &backup).map_err(|e| format!("备份原文件失败: {e}"))?;
    }
    let tmp = sibling_path(path, ".tmp")?;
    let body = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };
    fs::write(&tmp, body).map_err(|e| format!("写入临时文件失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("替换文件失败: {e}"))?;
    Ok(())
}

/// 追加一条速记到当前笔记文件。
#[tauri::command]
pub fn save_note(app: AppHandle, content: String) -> Result<(), String> {
    // 去掉首尾空白；内部换行保留（serde_json 会转义为 \n，JSONL 每条仍是单行）
    let content = content.trim();
    if content.is_empty() {
        return Err("内容为空".into());
    }

    let path = settings::notes_path(&app)?;
    let _guard = lock_notes();
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

/// 读取全部笔记，按最新在前返回。
#[tauri::command]
pub fn list_notes(app: AppHandle) -> Result<Vec<NoteEntry>, String> {
    let path = settings::notes_path(&app)?;
    // 与追加 / 替换写共用同一把锁，避免读到写到一半的文件
    let _guard = lock_notes();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let lines = read_lines(&path)?;

    let mut notes = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
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

/// 将前端生成的 PNG 字节写入用户选择的位置，返回保存路径；用户取消时返回 None。
#[tauri::command]
pub async fn save_image(
    app: AppHandle,
    data: Vec<u8>,
    default_name: String,
) -> Result<Option<String>, String> {
    if data.is_empty() {
        return Err("图片数据为空".into());
    }
    let start_dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .ok();

    tauri::async_runtime::spawn_blocking(move || {
        let mut dlg = rfd::FileDialog::new()
            .set_title("导出图片")
            .set_file_name(&default_name)
            .add_filter("PNG 图片", &["png"]);
        if let Some(dir) = start_dir {
            dlg = dlg.set_directory(dir);
        }
        let Some(path) = dlg.save_file() else {
            return Ok::<_, String>(None);
        };
        fs::write(&path, &data).map_err(|e| format!("写入图片失败: {e}"))?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("保存图片失败: {e}"))?
}

/// 取出某物理行的 `time`，并校验它仍与前端持有的值一致。
///
/// 行号只是位置而非稳定 id：文件被外部修改后下标可能指向另一条记录。
/// 用 `time` 做乐观校验，不一致时拒绝写入，避免静默改错 / 删错。
fn verify_line(lines: &[String], line: usize, expected_time: &str) -> Result<String, String> {
    if line == 0 || line > lines.len() {
        return Err("记录不存在".into());
    }
    let target = lines[line - 1].trim();
    if target.is_empty() {
        return Err("记录不存在".into());
    }
    let existing = serde_json::from_str::<serde_json::Value>(target)
        .map_err(|e| format!("记录解析失败: {e}"))?;
    let time = existing
        .get("time")
        .and_then(|t| t.as_str())
        .unwrap_or_default();
    if time != expected_time {
        return Err("记录已变化，请刷新后重试".into());
    }
    Ok(time.to_string())
}

/// 编辑指定行（1 起始）的笔记内容，保留原 time；空内容返回错误。
#[tauri::command]
pub fn edit_note(
    app: AppHandle,
    line: usize,
    content: String,
    expected_time: String,
) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("内容为空".into());
    }

    let path = settings::notes_path(&app)?;
    let _guard = lock_notes();
    if !path.exists() {
        return Err("记录不存在".into());
    }
    let mut lines = read_lines(&path)?;

    // 解析原始记录，校验 time 未变化，仅更新 content
    let time = verify_line(&lines, line, &expected_time)?;
    lines[line - 1] = serde_json::json!({ "time": time, "content": content }).to_string();

    write_lines_atomic(&path, &lines)?;
    Ok(())
}

/// 删除指定行（1 起始）的笔记，其余行写回。
#[tauri::command]
pub fn delete_note(app: AppHandle, line: usize, expected_time: String) -> Result<(), String> {
    let path = settings::notes_path(&app)?;
    let _guard = lock_notes();
    if !path.exists() {
        return Ok(());
    }
    let mut lines = read_lines(&path)?;
    verify_line(&lines, line, &expected_time)?;
    lines.remove(line - 1);

    write_lines_atomic(&path, &lines)?;
    Ok(())
}

/// 解析备份文件中的一行；空行、非法 JSON、缺字段或空内容都返回 None。
fn parse_note_line(line: &str) -> Option<NoteRecord> {
    let raw: NoteRecord = serde_json::from_str(line.trim()).ok()?;
    let time = raw.time.trim().to_string();
    let content = raw.content.trim().to_string();
    if time.is_empty() || content.is_empty() {
        return None;
    }
    Some(NoteRecord { time, content })
}

/// 把备份文本合并进已有行：已有行原样保留，新记录追加在末尾。
/// 去重同时覆盖「与库内记录重复」和「备份文件内部重复」。
fn merge_import(existing: &[String], imported_text: &str) -> (Vec<String>, ImportResult) {
    let mut seen: HashSet<NoteRecord> = existing
        .iter()
        .filter_map(|line| parse_note_line(line))
        .collect();

    let mut result = ImportResult::default();
    let mut merged = existing.to_vec();
    for line in imported_text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Some(record) = parse_note_line(line) else {
            result.skipped += 1;
            continue;
        };
        if !seen.insert(record.clone()) {
            result.duplicates += 1;
            continue;
        }
        merged.push(serde_json::to_string(&record).unwrap_or_default());
        result.imported += 1;
    }
    (merged, result)
}

/// 导出当前笔记文件到用户选择的位置，返回目标路径；用户取消时返回 None。
#[tauri::command]
pub async fn export_notes(app: AppHandle) -> Result<Option<String>, String> {
    let path = settings::notes_path(&app)?;
    if !path.exists() {
        return Err("暂无可导出的笔记".into());
    }

    let start_dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .ok();
    let default_name = format!(
        "spark-notes-{}.jsonl",
        chrono::Local::now().format("%Y%m%d")
    );

    tauri::async_runtime::spawn_blocking(move || {
        let mut dlg = rfd::FileDialog::new()
            .set_title("导出笔记备份")
            .set_file_name(&default_name)
            .add_filter("JSON Lines", &["jsonl"])
            .add_filter("JSON", &["json"]);
        if let Some(dir) = start_dir {
            dlg = dlg.set_directory(dir);
        }
        let Some(dest) = dlg.save_file() else {
            return Ok::<_, String>(None);
        };
        // 目标就是源文件时拒绝，否则 fs::copy 会先截断源文件
        if dest == path
            || (dest.exists() && fs::canonicalize(&dest).ok() == fs::canonicalize(&path).ok())
        {
            return Err("不能覆盖正在使用的笔记文件".into());
        }

        let _guard = lock_notes();
        fs::copy(&path, &dest).map_err(|e| format!("写入备份失败: {e}"))?;
        Ok(Some(dest.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("导出失败: {e}"))?
}

/// 从用户选择的 JSONL 备份合并导入笔记，返回统计；用户取消时返回 None。
#[tauri::command]
pub async fn import_notes(app: AppHandle) -> Result<Option<ImportResult>, String> {
    let path = settings::notes_path(&app)?;
    let start_dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .ok();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut dlg = rfd::FileDialog::new()
            .set_title("导入笔记备份")
            .add_filter("JSON Lines", &["jsonl"])
            .add_filter("JSON", &["json"]);
        if let Some(dir) = start_dir {
            dlg = dlg.set_directory(dir);
        }
        let Some(src) = dlg.pick_file() else {
            return Ok::<_, String>(None);
        };
        let text = fs::read_to_string(&src).map_err(|e| format!("读取备份失败: {e}"))?;

        let _guard = lock_notes();
        let existing = if path.exists() {
            read_lines(&path)?
        } else {
            Vec::new()
        };
        let (lines, result) = merge_import(&existing, &text);
        if result.imported > 0 {
            if let Some(dir) = path.parent() {
                fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
            }
            write_lines_atomic(&path, &lines)?;
        }
        Ok(Some(result))
    })
    .await
    .map_err(|e| format!("导入失败: {e}"))??;

    if result.as_ref().is_some_and(|r| r.imported > 0) {
        let _ = app.emit("reload-history", ());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一条合法记录行
    fn entry(time: &str) -> String {
        serde_json::json!({ "time": time, "content": "内容" }).to_string()
    }

    #[test]
    fn verify_line_returns_time_when_matched() {
        let lines = vec![entry("t1"), entry("t2")];
        assert_eq!(verify_line(&lines, 2, "t2").unwrap(), "t2");
    }

    #[test]
    fn verify_line_rejects_changed_time() {
        let lines = vec![entry("t1")];
        assert!(verify_line(&lines, 1, "t0").is_err());
    }

    #[test]
    fn verify_line_rejects_out_of_range_and_blank() {
        let lines = vec![String::new(), entry("t1")];
        assert!(verify_line(&lines, 0, "t1").is_err());
        assert!(verify_line(&lines, 3, "t1").is_err());
        assert!(verify_line(&lines, 1, "").is_err());
    }

    #[test]
    fn verify_line_rejects_corrupted_json() {
        let lines = vec!["not json".to_string()];
        assert!(verify_line(&lines, 1, "t1").is_err());
    }

    #[test]
    fn sibling_path_keeps_original_extension() {
        let bak = sibling_path(Path::new("/tmp/notes.jsonl"), ".bak").unwrap();
        assert_eq!(bak, PathBuf::from("/tmp/notes.jsonl.bak"));
        let bak = sibling_path(Path::new("/tmp/notes.txt"), ".bak").unwrap();
        assert_eq!(bak, PathBuf::from("/tmp/notes.txt.bak"));
    }

    #[test]
    fn write_lines_atomic_writes_file_and_keeps_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.jsonl");
        fs::write(&path, "old\n").unwrap();

        write_lines_atomic(&path, &[entry("t1"), String::new(), entry("t2")]).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text, format!("{}\n\n{}\n", entry("t1"), entry("t2")));
        assert_eq!(
            fs::read_to_string(dir.path().join("notes.jsonl.bak")).unwrap(),
            "old\n"
        );
        assert!(!dir.path().join("notes.jsonl.tmp").exists());
    }

    #[test]
    fn write_lines_atomic_handles_empty_slice() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.jsonl");
        write_lines_atomic(&path, &[]).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
    }

    #[test]
    fn read_lines_keeps_physical_line_positions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.jsonl");
        fs::write(&path, format!("{}\n\n{}\n", entry("t1"), entry("t2"))).unwrap();
        assert_eq!(read_lines(&path).unwrap().len(), 3);
    }

    fn record(time: &str, content: &str) -> String {
        serde_json::json!({ "time": time, "content": content }).to_string()
    }

    #[test]
    fn parse_note_line_accepts_valid_record() {
        let parsed = parse_note_line(&record("t1", "内容")).unwrap();
        assert_eq!(parsed.time, "t1");
        assert_eq!(parsed.content, "内容");
    }

    #[test]
    fn parse_note_line_rejects_invalid_records() {
        assert!(parse_note_line("").is_none());
        assert!(parse_note_line("not json").is_none());
        assert!(parse_note_line(r#"{"content":"内容"}"#).is_none());
        assert!(parse_note_line(r#"{"time":"t1"}"#).is_none());
        assert!(parse_note_line(r#"{"time":"t1","content":123}"#).is_none());
        assert!(parse_note_line(r#"{"time":"t1","content":"  "}"#).is_none());
        assert!(parse_note_line(r#"{"time":" ","content":"内容"}"#).is_none());
    }

    #[test]
    fn merge_import_appends_into_empty_file() {
        let text = format!("{}\n{}", record("t1", "a"), record("t2", "b"));
        let (lines, result) = merge_import(&[], &text);
        assert_eq!(lines.len(), 2);
        assert_eq!(
            result,
            ImportResult {
                imported: 2,
                skipped: 0,
                duplicates: 0
            }
        );
    }

    #[test]
    fn merge_import_skips_records_already_present() {
        let existing = vec![record("t1", "a")];
        let (lines, result) = merge_import(&existing, &record("t1", "a"));
        assert_eq!(lines, existing);
        assert_eq!(result.imported, 0);
        assert_eq!(result.duplicates, 1);
    }

    #[test]
    fn merge_import_dedupes_within_backup_file() {
        let text = format!("{}\n{}", record("t1", "a"), record("t1", "a"));
        let (lines, result) = merge_import(&[], &text);
        assert_eq!(lines.len(), 1);
        assert_eq!(result.imported, 1);
        assert_eq!(result.duplicates, 1);
    }

    #[test]
    fn merge_import_counts_skipped_and_preserves_existing_lines() {
        let existing = vec![record("t1", "a"), String::new(), "not json".to_string()];
        let text = format!("\n{}\nbroken", record("t2", "b"));
        let (lines, result) = merge_import(&existing, &text);

        assert_eq!(&lines[..existing.len()], existing.as_slice());
        assert_eq!(lines.len(), existing.len() + 1);
        assert_eq!(result.imported, 1);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.duplicates, 0);
    }

    #[test]
    fn merge_import_accepts_crlf_input() {
        let text = format!("{}\r\n{}\r\n", record("t1", "a"), record("t2", "b"));
        let (lines, result) = merge_import(&[], &text);
        assert_eq!(lines.len(), 2);
        assert_eq!(result.imported, 2);
        assert_eq!(result.skipped, 0);
    }
}
