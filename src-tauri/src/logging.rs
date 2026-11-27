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

/// panic! 的 payload 可能是 &str 或 String（也可能来自 panic_any）。
fn panic_message(payload: &(dyn std::any::Any + Send)) -> &str {
    if let Some(s) = payload.downcast_ref::<&str>() {
        s
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.as_str()
    } else {
        "未知 panic 内容"
    }
}

/// 必须在日志插件初始化后调用：把 panic 位置、消息与完整 backtrace 写入日志文件。
///
/// 日志插件每条记录都会 flush，因此即使 panic 后进程退出，这些信息也不会丢。
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| l.to_string())
            .unwrap_or_else(|| "未知位置".to_string());
        let message = panic_message(info.payload());
        let backtrace = std::backtrace::Backtrace::force_capture();
        log::error!(
            target: "spark_lib::panic",
            "Rust panic at {location}: {message}\n{backtrace}"
        );
    }));
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

    #[test]
    fn panic_message_reads_str_and_string_payloads() {
        let literal: &(dyn std::any::Any + Send) = &"boom";
        assert_eq!(panic_message(literal), "boom");

        let owned = String::from("owned panic");
        let owned: &(dyn std::any::Any + Send) = &owned;
        assert_eq!(panic_message(owned), "owned panic");
    }

    #[test]
    fn panic_message_falls_back_for_unknown_payload() {
        let code = 42;
        let payload: &(dyn std::any::Any + Send) = &code;
        assert_eq!(panic_message(payload), "未知 panic 内容");
    }
}
