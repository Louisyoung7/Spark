import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

const srcPath = (p) => fileURLToPath(new URL(p, import.meta.url));

// Tauri 多页前端：root 指向 src（HTML/JS/CSS 所在），
// 打包输出到项目根 dist，供 src-tauri 的 frontendDist 引用。
export default defineConfig({
  root: srcPath("src"),
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: srcPath("src/index.html"),
        history: srcPath("src/history.html"),
        settings: srcPath("src/settings.html"),
      },
    },
  },
  clearScreen: false,
  server: {
    strictPort: true,
    port: 5173,
  },
});
