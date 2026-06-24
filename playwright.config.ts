import { defineConfig } from '@playwright/test'

// Electron e2e — 빌드된 out/ 을 실제 electron 으로 띄워 prod app:// 렌더를 검증한다.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 45_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']]
})
