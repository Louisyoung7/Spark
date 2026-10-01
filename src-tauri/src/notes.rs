//! 笔记存储：追加、读取、删除。
//!
//! 数据以 JSON Lines 形式保存在当前笔记文件（默认 `~/.local/share/spark/notes.jsonl`，
//! 可在设置中自定义）。换行由 serde_json 转义，每条记录始终占一个物理行。

use std::fs;
use std::fs::OpenOptions;
use std::io::Write;

use tauri::AppHandle;

use crate::settings;

/// 一条历史记录（`line` 为文件中的 1 起始行号，作为删除用的稳定 id）
#[derive(serde::Serialize)]
pub struct NoteEntry {
    pub line: usize,
    pub time: String,
    pub content: String,
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
pub fn delete_note(app: AppHandle, line: usize) -> Result<(), String> {
    let path = settings::notes_path(&app)?;
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
