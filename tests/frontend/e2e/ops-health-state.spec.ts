import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type FixtureState = 'initial-loading' | 'failure' | 'retry-loading' | 'retry-failure' | 'retry-success'
type FixtureTheme = 'light' | 'dark'
type FixtureMode = 'default' | 'zoom-200' | 'forced-colors'

const viewports = [
    { name: 'mobile', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 900 },
    { name: 'desktop', width: 1440, height: 900 }
] as const
const themes: readonly FixtureTheme[] = ['light', 'dark']
const modes: readonly FixtureMode[] = ['default', 'zoom-200', 'forced-colors']
const fixtureModule = `/@fs/${fileURLToPath(new URL('../fixtures/opsHealthStateVisual.ts', import.meta.url)).replaceAll(
    '\\',
    '/'
)}`
const evidenceRoot = path.resolve(
    process.cwd(),
    process.env.FSUSBLOG_OPS_HEALTH_STATE_EVIDENCE_DIR ?? '../../.tmp/visual-evidence/ops-health-state'
)
mkdirSync(evidenceRoot, { recursive: true })

test.describe.configure({ mode: 'parallel' })

async function openFixture(page: Page, state: FixtureState, theme: FixtureTheme, mode: FixtureMode): Promise<void> {
    const runtimeErrors: string[] = []
    page.on('pageerror', (error) => runtimeErrors.push(error.message))
    page.on('console', (message) => {
        if (message.type() !== 'error') return
        const text = message.text()
        const expectedFailure =
            text.includes('fixture upstream unavailable') ||
            text.includes('fixture initial request failed') ||
            text.includes('fixture retry request failed')
        const viteInfrastructure =
            text.includes('ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS') ||
            text.startsWith('[vite] failed to connect to websocket') ||
            text.startsWith('Failed to send error to Vite server')
        if (!expectedFailure && !viteInfrastructure) runtimeErrors.push(text)
    })
    if (mode === 'forced-colors') {
        await page.emulateMedia({ colorScheme: theme, forcedColors: 'active' })
    } else {
        await page.emulateMedia({ colorScheme: theme, forcedColors: 'none' })
    }
    await page.route('**/__ops-health-state-fixture**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Ops health state fixture</title></head>
          <body>
            <div id="ops-health-state-fixture"></div>
            <script type="module" src="${fixtureModule}"></script>
          </body>
        </html>`
        })
    })
    await page.goto(`/__ops-health-state-fixture?state=${state}&theme=${theme}&mode=${mode}`, {
        waitUntil: 'domcontentloaded'
    })
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.opsHealthFixtureReady)).toBe('true')
    expect(runtimeErrors).toEqual([])
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow).toBeLessThanOrEqual(4)
}

async function assertVisibleKeyboardFocus(page: Page): Promise<void> {
    const retry = page.getByRole('button', { name: '重新加载' })
    await retry.focus()
    await expect(retry).toBeFocused()
    const focusEvidence = await retry.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
            boxShadow: style.boxShadow,
            focusVisible: element.matches(':focus-visible'),
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth
        }
    })
    expect(focusEvidence.focusVisible).toBe(true)
    expect(
        focusEvidence.boxShadow !== 'none' ||
            (focusEvidence.outlineStyle !== 'none' && focusEvidence.outlineWidth !== '0px')
    ).toBe(true)
}

for (const viewport of viewports) {
    for (const theme of themes) {
        for (const mode of modes) {
            test.describe(`ops health state ${viewport.name} ${theme} ${mode}`, () => {
                test.use({
                    viewport: {
                        width: viewport.width,
                        height: viewport.height
                    }
                })

                test('keeps loading, failure, retry and success distinct and contained', async ({ page }, testInfo) => {
                    await openFixture(page, 'initial-loading', theme, mode)
                    await expect(page.locator('[data-ops-health-state]')).toHaveAttribute('role', 'status')
                    await expect(page.locator('[data-ops-health-state]')).toContainText('正在读取运维状态')
                    await expect(page.getByText('运维状态暂不可用')).toHaveCount(0)
                    await expect(page.locator('[data-ops-health-failure-reason]')).toHaveCount(0)
                    await expect(page.getByRole('button', { name: '重新加载' })).toHaveCount(0)
                    await expect(page.locator('[role="alert"]')).toHaveCount(0)
                    await expect(page.locator('[aria-live="assertive"]')).toHaveCount(0)
                    await assertNoHorizontalOverflow(page)

                    await openFixture(page, 'failure', theme, mode)
                    const failure = page.locator('[data-ops-health-state]')
                    const failureReason = page.locator('[data-ops-health-failure-reason]')
                    const retry = page.getByRole('button', {
                        name: '重新加载'
                    })
                    await expect(failure).not.toHaveAttribute('role', 'alert')
                    await expect(failure).not.toHaveAttribute('aria-live', 'assertive')
                    await expect(failure).toContainText('运维状态暂不可用')
                    await expect(failureReason).toContainText('fixture upstream unavailable')
                    await expect(failureReason).toHaveAttribute('id', 'ops-health-failure-reason')
                    await expect(retry).toHaveAttribute('aria-describedby', 'ops-health-failure-reason')
                    await expect(retry).toBeEnabled()
                    await expect(page.locator('.el-message')).toHaveCount(1)
                    await expect(page.locator('[aria-live="assertive"]')).toHaveCount(1)
                    await expect(page.locator('html')).toHaveAttribute(
                        'data-ops-health-assertive-announcement-count',
                        '1'
                    )
                    await expect(page.locator('html')).toHaveAttribute('data-ops-health-toast-count', '1')
                    const retryBox = await retry.boundingBox()
                    expect(retryBox).not.toBeNull()
                    expect(retryBox!.height).toBeGreaterThanOrEqual(44)
                    await assertVisibleKeyboardFocus(page)
                    await assertNoHorizontalOverflow(page)
                    const evidencePath = path.join(
                        evidenceRoot,
                        `ops-health-failure-${viewport.name}-${theme}-${mode}.png`
                    )
                    await page.screenshot({
                        fullPage: true,
                        path: evidencePath
                    })
                    await testInfo.attach(`ops-health-failure-${viewport.name}-${theme}-${mode}`, {
                        path: evidencePath,
                        contentType: 'image/png'
                    })

                    await openFixture(page, 'retry-loading', theme, mode)
                    const retryLoading = page.getByRole('button', {
                        name: '重新加载'
                    })
                    await expect(retryLoading).toBeDisabled()
                    await expect(retryLoading).toHaveAttribute('aria-busy', 'true')
                    await expect(page.locator('[data-ops-health-state]')).toContainText('正在重新读取运维状态')
                    await retryLoading.click({ force: true })
                    await expect
                        .poll(() => page.evaluate(() => document.documentElement.dataset.opsHealthRequestCount))
                        .toBe('2')
                    await expect(page.locator('.el-message')).toHaveCount(1)
                    await expect(page.locator('[aria-live="assertive"]')).toHaveCount(1)
                    await expect(page.locator('html')).toHaveAttribute(
                        'data-ops-health-assertive-announcement-count',
                        '1'
                    )
                    await expect(page.locator('html')).toHaveAttribute('data-ops-health-toast-count', '1')
                    await assertNoHorizontalOverflow(page)

                    await openFixture(page, 'retry-failure', theme, mode)
                    await expect(page.locator('[data-ops-health-failure-reason]')).toContainText(
                        'fixture retry request failed'
                    )
                    await expect(page.getByRole('button', { name: '重新加载' })).toHaveAttribute(
                        'aria-describedby',
                        'ops-health-failure-reason'
                    )
                    await expect(page.locator('[data-ops-health-state]')).not.toHaveAttribute('role', 'alert')
                    await expect(page.locator('[data-ops-health-state]')).not.toHaveAttribute(
                        'aria-live',
                        'assertive'
                    )
                    await expect(page.locator('html')).toHaveAttribute('data-ops-health-request-count', '2')
                    await expect(page.locator('html')).toHaveAttribute(
                        'data-ops-health-assertive-announcement-count',
                        '2'
                    )
                    await expect(page.locator('html')).toHaveAttribute('data-ops-health-toast-count', '2')
                    await assertNoHorizontalOverflow(page)

                    await openFixture(page, 'retry-success', theme, mode)
                    await expect(page.locator('[data-ops-health-state]')).toHaveCount(0)
                    await expect(page.locator('[data-ops-health-failure-reason]')).toHaveCount(0)
                    await expect(page.getByRole('button', { name: '重新加载' })).toHaveCount(0)
                    await expect(page.locator('[data-ops-health-workbench]')).toBeVisible()
                    await assertNoHorizontalOverflow(page)
                })
            })
        }
    }
}
