# Spark

极简 Linux 桌面速记工具 —— 快速捕获，不打断心流。

## 使用

按 `Ctrl+Alt+Space`（应用需在后台运行）→ 弹窗出现 → 输入想法 → `Enter` 保存 → 窗口消失。

- `Enter` 保存并关闭；`Esc` 取消（草稿保留，下次弹出还在）
- 再次按快捷键：窗口已显示时重新聚焦
- 关闭窗口 = 隐藏，应用常驻后台；从托盘图标退出（左键点托盘也可切换窗口）

笔记追加保存在 `~/.local/share/spark/notes.jsonl`（JSON Lines，每行 `{"time": ..., "content": ...}`）。

## 开发

```bash
npm install
npm run tauri dev     # 开发运行
npm run tauri build   # 产出安装包
```

要求：Rust、Node.js、以及 Tauri v2 Linux 依赖（webkit2gtk-4.1、gtk3、libayatana-appindicator3-dev 等）。

## 架构

- **全局快捷键**：`tauri-plugin-desktop-integration` 统一注册 —— X11 直接 grab，Wayland 走 XDG Portal（首次绑定会弹系统授权对话框，属正常现象）
- **窗口**：无边框 / 置顶 / 不进任务栏，启动即隐藏；显示时定位到鼠标附近（多显示器下 clamp），失败回退居中
- **常驻后台**：拦截 `CloseRequested` 改为隐藏；single-instance 防双开；托盘提供退出入口
- 修改快捷键：`src-tauri/src/lib.rs` 顶部的 `HOTKEY` 常量

仅支持 Linux（X11 / Wayland）。
