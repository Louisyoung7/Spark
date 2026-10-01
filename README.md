# Spark

极简 Linux 桌面速记工具 —— 快速捕获，不打断心流。

## 使用

| 快捷键 | 功能 |
| --- | --- |
| `Alt+Q` | 唤出速记编辑窗口 |
| `Ctrl+Alt+Q` | 唤出历史记录窗口 |

### 速记窗口（记事本式编辑器）

- `Enter` 换行，自由编辑多行文本
- `Ctrl+Enter`（或点「保存」按钮）保存并收起
- `Esc` / 点击窗口外：收起并**保留草稿**，下次弹出继续写
- 顶部实时显示字数与行数；空内容保存时直接收起，不写入

### 历史记录窗口

- 记录按最新在前排列，悬停条目显示操作按钮
- **复制** / **删除** 单条记录
- 每次唤起或重新聚焦自动刷新；`Esc` 或 `✕` 关闭（不退出应用）

### 通用行为

- 再次按快捷键：速记窗口重新聚焦，历史窗口收起/唤出切换
- 关闭窗口 = 隐藏，应用常驻后台；从托盘菜单退出（左键点托盘也可切换速记窗口）
- 托盘菜单：显示窗口 / 历史记录 / **设置** / 退出；历史窗口标题栏的 ⚙ 也可进入设置

### 设置（`Ctrl+Alt+Q` → ⚙ 或托盘 → 设置）

- **开机自启**：登录后自动运行（Linux 写 `~/.config/autostart/spark.desktop`）
- **笔记保存位置**：自定义 `notes.jsonl` 路径；可随时重置为默认
- **快捷键**：分别为两个窗口自定义快捷键；X11 下立即生效，Wayland 受 Portal 限制需重启
- 所有偏好持久化在 `~/.local/share/spark/settings.json`（原子替换写回）

## 数据

笔记追加保存在 `~/.local/share/spark/notes.jsonl`（JSON Lines，每行 `{"time": ..., "content": ...}`）；自定义路径则在设置中所选的位置。
删除操作通过临时文件 + 原子替换写回，避免损坏数据；换行等特殊字符由 JSON 转义，每条记录始终单行。

## 开发

```bash
npm install
npm run tauri dev     # 开发运行
npm run tauri build   # 产出安装包
```

要求：Rust、Node.js、以及 Tauri v2 Linux 依赖（webkit2gtk-4.1、gtk3、libayatana-appindicator3-dev 等）。

## 架构

- **双窗口**：速记窗口（`main`，默认 400×450，可调整大小、禁用最大化）与历史窗口（`history`，520×560）；均无边框 / 置顶 / 不进任务栏，启动即隐藏
- **全局快捷键**：`tauri-plugin-desktop-integration` 统一注册 —— X11 直接 grab，Wayland 走 XDG Portal（首次绑定会弹系统授权对话框，属正常现象）。注：Wayland Portal 路径目前仅支持单个快捷键会话，双快捷键在 X11 下完整可用
- **窗口定位**：速记窗口显示时定位到鼠标附近（多显示器下 clamp 到所在显示器），失败回退居中
- **失焦行为**：速记窗口点击外部自动收起（带 250ms 防抖，避免 show/focus 事件乱序误收起）；历史窗口不自动收起，方便对照复制
- **常驻后台**：拦截 `CloseRequested` 改为隐藏；single-instance 防双开（第二实例唤起已有窗口后自行退出）；托盘提供退出入口
- **中文输入**：监听 `isComposing`，输入法选词不会误触发操作
- 修改快捷键：`src-tauri/src/lib.rs` 顶部的 `HOTKEY_MAIN` / `HOTKEY_HISTORY` 常量

仅支持 Linux（X11 / Wayland）。
