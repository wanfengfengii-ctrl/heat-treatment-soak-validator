import { defineConfig } from "@playwright/test";

// 默认打本机 compose 映射出的 WEB_PORT；verify 服务内用 WEB_BASE_URL=http://web
const baseURL =
  process.env.WEB_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    screenshot: "only-on-failure",
  },
});
