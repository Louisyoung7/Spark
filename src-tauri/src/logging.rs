//! 统一日志通道：前端通过 `log_frontend` 把异常写到后端同一个日志文件。
//!
//! 日志内容只包含错误与位置信息，不记录笔记正文，避免泄露用户内容。

/// 单条前端日志最多保留的字符数，防止异常页面瞬间撑满日志文件。
const MAX_MESSAGE_CHARS: usize = 2000;

fn truncate(message: &str) -> &str {
    match message.char_indices().nth(MAX_MESSAGE_CHARS) {
        Some((byte, _)) => &message[..byte],
        None => message,
    }
}

/// 接收 WebView 上报的日志；日志插件已保证此处调用时全局 logger 可用。
#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    let message = truncate(&message);
    match level.as_str() {
        "error" => log::error!(target: "spark_lib::frontend", "{message}"),
        "warn" => log::warn!(target: "spark_lib::frontend", "{message}"),
        "info" => log::info!(target: "spark_lib::frontend", "{message}"),
        "debug" => log::debug!(target: "spark_lib::frontend", "{message}"),
        other => log::warn!(target: "spark_lib::frontend", "未知日志级别 {other}: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_keeps_short_messages() {
        assert_eq!(truncate("正常日志"), "正常日志");
    }

    #[test]
    fn truncate_does_not_split_multibyte_chars() {
        let message = "赞".repeat(MAX_MESSAGE_CHARS + 10);
        assert_eq!(truncate(&message), "赞".repeat(MAX_MESSAGE_CHARS));
    }

    #[test]
    fn truncate_keeps_message_at_limit() {
        let message = "x".repeat(MAX_MESSAGE_CHARS);
        assert_eq!(truncate(&message), message);
    }
}
