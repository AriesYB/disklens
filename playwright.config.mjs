// DiskLens e2e 冒烟：跑在浏览器演示模式（合成数据）上，无需 Rust 工具链。
// 前置：npx playwright install chromium
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  retries: 0,
  use: {
    locale: 'zh-CN',
    baseURL: 'http://127.0.0.1:5180',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5180',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
