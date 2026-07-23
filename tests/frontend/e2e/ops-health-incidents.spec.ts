import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type FixtureState =
  | 'healthy'
  | 'one'
  | 'ten'
  | 'optional-missing'
  | 'long-path'
  | 'long-error'
type FixtureTheme = 'light' | 'dark'

const states: readonly FixtureState[] = [
  'healthy',
  'one',
  'ten',
  'optional-missing',
  'long-path',
  'long-error'
]
const themes: readonly FixtureTheme[] = ['light', 'dark']
const viewports = [
  { name: 'desktop', width: 1366, height: 768 },
  { name: 'wide', width: 1440, height: 900 },
  { name: 'boundary', width: 1024, height: 900 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'mobile', width: 375, height: 812 }
] as const
const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../fixtures/opsHealthIncidentVisual.ts', import.meta.url)
).replaceAll('\\', '/')}`
const evidenceRoot = path.resolve(
  process.cwd(),
  process.env.FSUSBLOG_OPS_HEALTH_EVIDENCE_DIR
    ?? '../../.tmp/visual-evidence/issue-1471'
)
mkdirSync(evidenceRoot, { recursive: true })
const completedEvidence: Array<{
  file: string
  height: number
  state: FixtureState
  theme: FixtureTheme
  viewport: string
  width: number
}> = []

test.describe.configure({ mode: 'parallel' })

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))
  expect(overflow).toBeLessThanOrEqual(4)
}

async function assertHitTarget(locator: Locator, minimum: number): Promise<void> {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(minimum)
  expect(box!.height).toBeGreaterThanOrEqual(minimum)
}

async function openFixture(
  page: Page,
  state: FixtureState,
  theme: FixtureTheme
): Promise<string[]> {
  const runtimeErrors: string[] = []
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          document.documentElement.dataset.opsHealthCopiedEvidence = value
        }
      }
    })
  })
  page.on('pageerror', error => runtimeErrors.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const text = message.text()
    const isViteHmrInfrastructureError = (
      text.includes('ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS')
      || text.startsWith('[vite] failed to connect to websocket')
      || text.startsWith('Failed to send error to Vite server')
    )
    if (!isViteHmrInfrastructureError) runtimeErrors.push(text)
  })
  await page.route('**/__ops-health-incident-fixture**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Ops health incident fixture</title></head>
          <body>
            <div id="ops-health-incident-fixture"></div>
            <script type="module" src="${fixtureModule}"></script>
          </body>
        </html>`
    })
  })
  await page.goto(`/__ops-health-incident-fixture?state=${state}&theme=${theme}`, {
    waitUntil: 'domcontentloaded'
  })
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.dataset.opsHealthFixtureReady
  ))).toBe('true')
  return runtimeErrors
}

for (const viewport of viewports) {
  for (const theme of themes) {
    test.describe(`ops health ${viewport.name} ${theme}`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } })

      for (const state of states) {
        test(`${state} preserves actionable incident hierarchy`, async ({ page }, testInfo) => {
          const runtimeErrors = await openFixture(page, state, theme)
          const rows = page.locator('[data-ops-incident-row]')

          await expect(page.locator('[data-ops-status-strip]')).toBeVisible()
          await expect(page.locator('[data-ops-healthy-summary]')).toBeVisible()
          await assertNoHorizontalOverflow(page)

          if (state === 'healthy' || state === 'optional-missing') {
            await expect(rows).toHaveCount(0)
            await expect(page.getByText('当前没有需要处理的异常')).toBeVisible()
            await expect(page.locator('.el-tag')).toHaveCount(0)
          }
          if (state === 'one' || state === 'long-error') {
            await expect(rows).toHaveCount(1)
          }
          if (state === 'ten') {
            await expect(rows).toHaveCount(10)
            await expect(rows.nth(0)).toContainText('严重')
            await expect(rows.nth(0)).toContainText('fixture-action-10')
            await expect(rows.nth(1)).toContainText('严重')
            await expect(rows.nth(2)).toContainText('错误')

            if (viewport.width >= 1024) {
              const third = await rows.nth(2).boundingBox()
              expect(third).not.toBeNull()
              expect(third!.y + third!.height).toBeLessThanOrEqual(viewport.height)
            }
          }

          for (const row of await rows.all()) {
            const box = await row.boundingBox()
            expect(box).not.toBeNull()
            expect(box!.height).toBeGreaterThanOrEqual(56)
          }

          if (viewport.width >= 1024 && await rows.count() > 0) {
            const severityBox = await rows.first().locator('[data-ops-severity]').boundingBox()
            const timeBox = await rows.first().locator('[data-ops-time]').boundingBox()
            expect(severityBox).not.toBeNull()
            expect(severityBox!.width).toBeGreaterThanOrEqual(72)
            expect(severityBox!.width).toBeLessThanOrEqual(96)
            expect(timeBox).not.toBeNull()
            expect(timeBox!.width).toBeGreaterThanOrEqual(120)
            expect(timeBox!.width).toBeLessThanOrEqual(160)
          }

          if (state === 'long-path') {
            const path = page.locator('[data-ops-evidence-path]').first()
            await expect(path).not.toContainText('/production-slot-blue/data-protection/artifacts/')
            const copy = page.getByRole('button', { name: '复制证据' }).first()
            await assertHitTarget(copy, 40)
            await copy.focus()
            await expect(copy).toBeFocused()
            await copy.press('Enter')
            await expect(page.getByRole('status')).toContainText('已复制')

            const disclosure = page.locator('[data-ops-evidence-disclosure]').first()
            await disclosure.focus()
            await expect(disclosure).toBeFocused()
            await disclosure.press('Enter')
            await expect(disclosure).toBeFocused()
            await expect(path).toContainText('/production-slot-blue/data-protection/artifacts/')
          }

          if (state === 'long-error') {
            const disclosure = page.locator('[data-ops-evidence-disclosure]').first()
            await disclosure.focus()
            await disclosure.press(' ')
            await expect(disclosure).toBeFocused()
            await expect(page.locator('[data-ops-evidence-detail]').first()).toBeVisible()
          }

          expect(runtimeErrors).toEqual([])
          const evidencePath = path.join(
            evidenceRoot,
            `ops-${state}-${viewport.name}-${theme}.png`
          )
          await page.screenshot({ fullPage: true, path: evidencePath })
          await testInfo.attach(`ops-${state}-${viewport.name}-${theme}`, {
            path: evidencePath,
            contentType: 'image/png'
          })
          completedEvidence.push({
            file: path.basename(evidencePath),
            height: viewport.height,
            state,
            theme,
            viewport: viewport.name,
            width: viewport.width
          })
        })
      }
    })
  }
}

test.afterAll(() => {
  completedEvidence.sort((left, right) => left.file.localeCompare(right.file))
  writeFileSync(
    path.join(evidenceRoot, 'manifest.json'),
    `${JSON.stringify({
      schema: 'fsusblog-ops-health-visual-evidence-v1',
      caseCount: completedEvidence.length,
      cases: completedEvidence
    }, null, 2)}\n`,
    'utf8'
  )
})
