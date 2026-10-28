import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;
const appRoot = fileURLToPath(new URL(".", import.meta.url));

// https://vite.dev/config/
export default defineConfig(() => ({
  resolve: {
    alias: {
      "@zhange-base": path.resolve(appRoot, "vendor/zhange-base/design-system"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
