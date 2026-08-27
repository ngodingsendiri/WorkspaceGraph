/**
 * M9 (TST-1): Playwright/Electron E2E for the full renderer flow.
 *
 * Flow: buka vault fixture → buat note → link wiki → graph → chat (mock).
 * Runs against the BUILT app (out/main, out/preload, out/renderer) — run
 * `npm run build` first. Playwright drives the real Electron binary so the
 * CSP, preload bridge and IPC wiring all run exactly like production.
 */
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'path'
import { createVaultFixture, cleanupVaultFixture } from './fixtures'

let vaultRoot: string

test.beforeAll(async () => {
  vaultRoot = createVaultFixture()
})

test.afterAll(async () => {
  if (vaultRoot) cleanupVaultFixture(vaultRoot)
})

test('full flow: open vault → create note → wiki link → graph → chat', async () => {
  const electronApp = await electron.launch({
    args: ['.'],
    cwd: path.resolve(__dirname, '../../../../'),
    env: { ...process.env, WG_E2E: '1' },
  })
  const page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // 1. Open the fixture vault through the real IPC bridge
  await page.evaluate(async (vaultPath) => {
    const api = (window as never as { api: { openWorkspace(p: string): Promise<unknown> } }).api
    await api.openWorkspace(vaultPath)
  }, vaultRoot)

  // Reload so the React store's fetchState() reads main-process state (which is
  // now open). The workspace:updated event is only sent after background indexing
  // finishes, so waiting for it would be slow and unreliable.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1000)

  // Wait for React to re-render after workspace state change
  await page.waitForTimeout(500)
  await page.waitForSelector('.app-titlebar-title')

  // Title bar shows the vault name once open
  await expect(page.locator('.app-titlebar-title')).toContainText('vault-')

  // 2. Create a new note via the preload API
  const created = await page.evaluate(async (vaultPath) => {
    const api = (window as never as { api: { createFile(p: string, c: string): Promise<unknown> } }).api
    const filePath = `${vaultPath}/Knowledge/NewE2E.md`
    await api.createFile(filePath, '# NewE2E\n\nLink ke [[Alpha]].\n')
    return filePath
  }, vaultRoot)

  // 3. Verify the file landed on disk
  const fs = await import('fs')
  expect(fs.existsSync(created)).toBe(true)

  // 4. Graph data reflects the new note + wiki link (Alpha ↔ NewE2E)
  const graphData = await page.evaluate(async () => {
    const api = (window as never as { api: { getGraphData(): Promise<{ nodes: unknown[] }> } }).api
    return await api.getGraphData()
  })
  expect(graphData.nodes.length).toBeGreaterThanOrEqual(3)

  // 5. Chat panel opens without crashing (mock/no provider is fine — panel mounts)
  await page.click('.app-titlebar-actions button[aria-label="Toggle AI panel"]')
  await expect(page.locator('.chat-panel')).toBeVisible()

  await electronApp.close()
})
