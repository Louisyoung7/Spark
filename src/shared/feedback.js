// 瞬时状态提示：显示一段时间后自动淡出。
// 速记窗口与设置窗口共用，仅持续时长不同。
export function createFlashStatus(el, duration = 1500) {
  let timer = null;
  return (text, isError = false) => {
    el.textContent = text;
    el.classList.toggle("error", isError);
    el.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove("show"), duration);
  };
}
