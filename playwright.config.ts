import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'src/main/qa/e2e',
  testMatch: '*.e2e.spec.ts',
  timeout: 120000,
  expect: { timeout: 15000 },
  use: {
    headless: true,
  },
  projects: [
    {
      name: 'electron',
    },
  ],
})