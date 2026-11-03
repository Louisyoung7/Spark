---
name: feat/edit-note
overview: 为历史记录增加「编辑」能力：后端新增 edit_note 命令（原子替换指定行、保留原 time），前端在历史列表每条加编辑按钮并支持内联编辑保存/取消；同时新建特性分支并将应用版本统一升至 0.3.0。
todos:
  - id: create-branch-bump
    content: 从 main 切出 feat/edit-note 分支，并将 Cargo.toml/package.json/tauri.conf.json 版本升到 0.3.0
    status: completed
  - id: add-edit-note-cmd
    content: 在 notes.rs 新增 edit_note 命令：按 line 改写 content、保留 time、原子写
    status: completed
    dependencies:
      - create-branch-bump
  - id: register-command
    content: 在 lib.rs 的 invoke_handler! 中注册 notes::edit_note
    status: completed
    dependencies:
      - add-edit-note-cmd
  - id: history-inline-edit
    content: 在 history.js 中为每条记录加编辑按钮并实现内联编辑与保存/取消逻辑
    status: completed
    dependencies:
      - create-branch-bump
  - id: style-and-verify
    content: 微调 styles.css 编辑态样式，编译并验证编辑/取消/空内容流程
    status: completed
    dependencies:
      - history-inline-edit
      - register-command
---

## 用户需求

历史记录界面当前每条记录仅支持复制与删除，希望新增「编辑」能力，可直接修改已有记录的内容。

## 产品概述

在现有 Spark 历史记录窗口中，为每条记录增加「编辑」操作：点击后该条内容切换为可编辑文本框，支持保存或取消。保存后将修改后的内容持久化，且保持原记录的创建时间不变。

## 核心特性

- 每条历史记录新增「编辑」按钮，点击进入内联编辑态（文本切换为 textarea + 保存/取消按钮）
- 保存时调用后端命令，按文件行号定位并改写该记录内容，时间字段保持不变
- 取消编辑恢复原文本；空内容保存时提示错误（与保存新速记行为一致）
- 编辑成功后自动刷新列表
- 应用版本号统一升至 0.3.0，并在独立特性分支 `feat/edit-note` 上实现

## 技术栈

- 后端：Rust + Tauri 2（`notes.rs` 新增命令，沿用现有原子写模式）
- 前端：原生 HTML/CSS/JS（无框架，直接调用 `window.__TAURI__.core.invoke`）
- 分支：`feat/edit-note`（从 main 切出）；版本 `0.3.0`

## 实现方案

### 总体策略

复用 `delete_note` 的「读全量 → 按 `line-1` 定位 → 临时文件 + `rename` 原子替换」模式，将“删除该行”改为“改写该行的 `content`、保留 `time`”。前端在 `history.js` 的 `render()` 中给每条记录追加「编辑」按钮，并复用已有的 `load()` 刷新与 `showToast()` 提示机制实现内联编辑。

### 关键技术决策

1. **沿用行号作稳定 id，不改写 time（方案 A）**：`list_notes` 已用 1 起始文件行号作为 `NoteEntry.line`，`edit_note` 按此定位即可，无需重新设计 id 体系，且不重排行号，零回归风险。编辑只改 `content`，保留原始 `time`，符合“修正笔误、时间语义不变”的预期。
2. **原子写保证数据安全**：与 `delete_note` 完全一致，先写 `*.jsonl.tmp` 再 `rename`，避免写一半崩溃损坏整个笔记文件。单行损坏已在 `list_notes` 中跳过，编辑前再次校验 `line` 范围，越界返回「记录不存在」。
3. **空内容校验**：`edit_note` 入口 `trim` 后若为空返回错误，前端捕获后 toast 提示，与 `save_note`/`delete_note` 行为统一。
4. **前端内联编辑复用现有结构**：`history.html` 的列表容器与 `history.js` 的 `render` 已支持动态条目；编辑按钮与 textarea 均由 JS 生成或就地切换，无需改动 HTML 结构（除非样式需要微调 `styles.css`，属可选）。

### 性能与可靠性

- 每次编辑为 O(n) 读全文件 + 单行替换 + 单次 rename，n 为笔记条数，对本地速记场景（通常数百条内）开销可忽略；与现有删除操作一致，无新增瓶颈。
- 单用户本地场景，load 到 edit 之间被并发新增记录导致行号错位的概率极低，沿用现有 line 方案即可，不在本期引入 `time` 作 id 的复杂度（YAGNI）。

## 实现注意事项

- 修改 `delete_note` 的 `Vec<&str>` 写法时，`edit_note` 需改为持有 `Vec<String>`（或解析后重建该行 JSON），注意保留其余行原文（避免二次转义改变内容）。
- `edit_note` 必须注册进 `src-tauri/src/lib.rs` 的 `invoke_handler!` 宏，否则前端调用报命令不存在。
- 版本号三处（Cargo.toml / package.json / tauri.conf.json）需同步改为 `0.3.0`，保持构建一致性。
- 分支基于 main 创建；之前 `docs/fix-hints-version` 的改动（提示文案、Cargo 0.2.0）不应混入本分支，除非用户要求合并。

## 架构设计

现有分层不变，仅扩展 notes 模块命令并接入命令路由；前端无新模块，仅在历史界面渲染逻辑中增加编辑分支。数据流：

```mermaid
flowchart LR
  A[历史界面 edit 按钮] --> B[history.js 进入内联编辑]
  B --> C[用户保存 content]
  C --> D["invoke edit_note(line, content)"]
  D --> E["notes.rs::edit_note"]
  E --> F[读全量/定位line/改写content保留time]
  F --> G[临时文件+rename 原子写]
  G --> H[返回 Ok]
  H --> I["history.js load() 刷新列表"]
```

## 目录结构

本次为在现有项目上做增量修改，仅列出受影响文件：

```
Spark/
├── src-tauri/
│   ├── Cargo.toml                          # [MODIFY] version: 0.2.0 → 0.3.0
│   ├── tauri.conf.json                     # [MODIFY] version: 0.2.0 → 0.3.0
│   └── src/
│       ├── notes.rs                       # [MODIFY] 新增 edit_note 命令：按 line 改写 content、保留 time，原子写
│       └── lib.rs                         # [MODIFY] invoke_handler! 增加 notes::edit_note
├── package.json                           # [MODIFY] version: 0.2.0 → 0.3.0
└── src/
    ├── history.js                         # [MODIFY] render() 加「编辑」按钮；实现内联编辑（textarea + 保存/取消）、调用 edit_note、空内容校验与 toast
    └── styles.css                         # [MODIFY][可选] 编辑态 textarea / 按钮样式微调
```

## 关键代码结构

仅列出必须精确定义的命令契约：

```rust
/// 编辑指定行（1 起始）的笔记内容，保留原 time；空内容返回错误。
#[tauri::command]
pub fn edit_note(app: AppHandle, line: usize, content: String) -> Result<(), String>;
```