// DiskLens e2e 冒烟：跑在浏览器演示模式（合成数据）上，无需 Rust 工具链。
// 前置：npx playwright install chromium
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:5180',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'npx --yes serve -l 5180 src',
    url: 'http://127.0.0.1:5180',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
