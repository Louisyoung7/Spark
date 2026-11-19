import js from "@eslint/js";
import globals from "globals";

// 前端代码运行在 WebView 中：浏览器全局 + ES Module。
// dist / node_modules / Rust 目录不参与检查。
export default [
  {
    ignores: ["dist/**", "node_modules/**", "src-tauri/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // 允许用 _ 前缀标记有意不使用的参数
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
