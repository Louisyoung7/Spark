import { enterWithIndent, indentSelection } from "../editor/index.js";

// 列表编辑的基础快捷键：速记窗口与历史编辑浮层共用同一套手感。
export const listKeyCommands = {
  Tab: (view) => {
    indentSelection(view, 1);
    return true;
  },
  "Shift-Tab": (view) => {
    indentSelection(view, -1);
    return true;
  },
  Enter: (view) => {
    enterWithIndent(view);
    return true;
  },
};

// 保存快捷键：Ctrl-Enter 与跨平台的 Mod-Enter 指向同一动作。
export function saveCommands(onSave) {
  return {
    "Ctrl-Enter": () => {
      onSave();
      return true;
    },
    "Mod-Enter": () => {
      onSave();
      return true;
    },
  };
}
