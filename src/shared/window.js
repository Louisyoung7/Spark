// 无边框窗口没有标题栏，由顶栏承担拖动职责。
// 按钮、输入控件上的按下不触发，避免影响点击。
export function enableWindowDragging(appWindow, header) {
  if (!header) return;
  header.addEventListener("mousedown", (event) => {
    if (event.target.closest("button, input, textarea, a, select")) return;
    event.preventDefault();
    appWindow.startDragging();
  });
}
