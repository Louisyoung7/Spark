//! 笔记存储：追加、读取、删除。
//!
//! 数据以 JSON Lines 形式保存在当前笔记文件（默认 `~/.local/share/spark/notes.jsonl`，
//! 可在设置中自定义）。换行由 serde_json 转义，每条记录始终占一个物理行。

use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use tauri::AppHandle;

use crate::settings;

/// 一条历史记录（`line` 为文件中的 1 起始行号，作为删除用的稳定 id）
#[derive(serde::Serialize)]
pub struct NoteEntry {
    pub line: usize,
    pub time: String,
    pub content: String,
}

/// 按物理行读取文件。列表、编辑、删除都必须基于同一套行号，
/// 否则文件中出现空行或损坏行时，前端拿到的 id 会指向错误记录。
fn read_lines(path: &Path) -> Result<Vec<String>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(text.lines().map(|l| l.to_string()).collect())
}

/// 先写临时文件再原子替换，避免写一半崩溃损坏数据。
fn write_lines_atomic(path: &Path, lines: &[String]) -> Result<(), String> {
    let tmp = path.with_extension("jsonl.tmp");
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

/// 编辑指定行（1 起始）的笔记内容，保留原 time；空内容返回错误。
#[tauri::command]
pub fn edit_note(app: AppHandle, line: usize, content: String) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("内容为空".into());
    }

    let path = settings::notes_path(&app)?;
    if !path.exists() {
        return Err("记录不存在".into());
    }
    let mut lines = read_lines(&path)?;
    if line == 0 || line > lines.len() {
        return Err("记录不存在".into());
    }

    // 解析原始记录，保留 time，仅更新 content
    let time = {
        let target = lines[line - 1].trim();
        if target.is_empty() {
            return Err("记录不存在".into());
        }
        let existing = serde_json::from_str::<serde_json::Value>(target)
            .map_err(|e| format!("记录解析失败: {e}"))?;
        existing
            .get("time")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string()
    };
    lines[line - 1] = serde_json::json!({ "time": time, "content": content }).to_string();

    write_lines_atomic(&path, &lines)?;
    Ok(())
}

/// 删除指定行（1 起始）的笔记，其余行写回。
#[tauri::command]
pub fn delete_note(app: AppHandle, line: usize) -> Result<(), String> {
    let path = settings::notes_path(&app)?;
    if !path.exists() {
        return Ok(());
    }
    let mut lines = read_lines(&path)?;
    if line == 0 || line > lines.len() {
        return Err("记录不存在".into());
    }
    if lines[line - 1].trim().is_empty() {
        return Err("记录不存在".into());
    }
    lines.remove(line - 1);

    write_lines_atomic(&path, &lines)?;
    Ok(())
}
