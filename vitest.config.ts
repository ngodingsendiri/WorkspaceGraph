import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/*.d.ts', '**/test/**', '**/workers/**', 'electron.vite.config.ts'],
      // M9 (TST-6): soft floors — catch catastrophic coverage drops without
      // blocking legitimate refactors. Raise gradually as coverage improves.
      thresholds: {
        lines: 40,
        functions: 35,
        statements: 40,
        branches: 30
      }
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      '@main': path.resolve(__dirname, 'src/main'),
      '@workers': path.resolve(__dirname, 'src/main/workers'),
    },
  },
})