import { expect, test, type Page } from '@playwright/test'
import {
    captureAuditRecord,
    evidenceRoot,
    modes,
    themes,
    viewports,
    type FixtureMode,
    type FixtureState,
    type FixtureTheme
} from '../support/ops-health-state-audit'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureModule = `/@fs/${fileURLToPath(new URL('../fixtures/opsHealthStateVisual.ts', import.meta.url)).replaceAll(
    '\\',
    '/'
)}`

test.describe.configure({ mode: 'parallel' })

async function openFixture(
    page: Page,
    state: FixtureState,
    theme: FixtureTheme,
    mode: FixtureMode
): Promise<string[]> {
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
    return runtimeErrors
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
                    const initialRuntimeErrors = await openFixture(page, 'initial-loading', theme, mode)
                    await expect(page.locator('[data-ops-health-state]')).toHaveAttribute('role', 'status')
                    await expect(page.locator('[data-ops-health-state]')).toContainText('正在读取运维状态')
                    await expect(page.getByText('运维状态暂不可用')).toHaveCount(0)
                    await expect(page.locator('[data-ops-health-failure-reason]')).toHaveCount(0)
                    await expect(page.getByRole('button', { name: '重新加载' })).toHaveCount(0)
                    await expect(page.locator('[role="alert"]')).toHaveCount(0)
                    await expect(page.locator('[aria-live="assertive"]')).toHaveCount(0)
                    await assertNoHorizontalOverflow(page)
                    await captureAuditRecord(
                        page,
                        'initial-loading',
                        viewport.name,
                        theme,
                        mode,
                        initialRuntimeErrors,
                        [
                            ['initial-loading.fixture-ready', 'lifecycle-semantics'],
                            ['initial-loading.runtime-errors', 'runtime-errors'],
                            ['initial-loading.role-status', 'aria-live-region'],
                            ['initial-loading.copy', 'lifecycle-semantics'],
                            ['initial-loading.failure-copy-absent', 'lifecycle-semantics'],
                            ['initial-loading.failure-reason-absent', 'lifecycle-semantics'],
                            ['initial-loading.retry-absent', 'retry-interaction'],
                            ['initial-loading.alert-absent', 'aria-live-region'],
                            ['initial-loading.assertive-live-region-absent', 'aria-live-region'],
                            ['initial-loading.horizontal-overflow', 'overflow']
                        ]
                    )

                    const failureRuntimeErrors = await openFixture(page, 'failure', theme, mode)
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
                    await captureAuditRecord(
                        page,
                        'failure',
                        viewport.name,
                        theme,
                        mode,
                        failureRuntimeErrors,
                        [
                            ['failure.fixture-ready', 'lifecycle-semantics'],
                            ['failure.runtime-errors', 'runtime-errors'],
                            ['failure.not-alert', 'aria-live-region'],
                            ['failure.not-assertive-live-region', 'aria-live-region'],
                            ['failure.copy', 'lifecycle-semantics'],
                            ['failure.reason-copy', 'lifecycle-semantics'],
                            ['failure.reason-id', 'aria-live-region'],
                            ['failure.retry-describedby', 'aria-live-region'],
                            ['failure.retry-enabled', 'retry-interaction'],
                            ['failure.toast-count', 'aria-live-region'],
                            ['failure.assertive-live-region-count', 'aria-live-region'],
                            ['failure.peak-assertive-announcement-count', 'aria-live-region'],
                            ['failure.peak-toast-count', 'aria-live-region'],
                            ['failure.retry-box-present', 'hit-target-size'],
                            ['failure.retry-target-height-44', 'hit-target-size'],
                            ['failure.retry-focused', 'keyboard-focus'],
                            ['failure.retry-focus-visible', 'keyboard-focus'],
                            ['failure.retry-focus-indicator', 'keyboard-focus'],
                            ['failure.horizontal-overflow', 'overflow'],
                            ['failure.screenshot', 'screenshot-evidence']
                        ],
                        path.relative(process.cwd(), evidencePath).replaceAll('\\', '/')
                    )

                    const retryLoadingRuntimeErrors = await openFixture(page, 'retry-loading', theme, mode)
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
                    await captureAuditRecord(
                        page,
                        'retry-loading',
                        viewport.name,
                        theme,
                        mode,
                        retryLoadingRuntimeErrors,
                        [
                            ['retry-loading.fixture-ready', 'lifecycle-semantics'],
                            ['retry-loading.runtime-errors', 'runtime-errors'],
                            ['retry-loading.retry-disabled', 'retry-interaction'],
                            ['retry-loading.retry-busy', 'aria-live-region'],
                            ['retry-loading.copy', 'lifecycle-semantics'],
                            ['retry-loading.request-count', 'retry-interaction'],
                            ['retry-loading.toast-count', 'aria-live-region'],
                            ['retry-loading.assertive-live-region-count', 'aria-live-region'],
                            ['retry-loading.peak-assertive-announcement-count', 'aria-live-region'],
                            ['retry-loading.peak-toast-count', 'aria-live-region'],
                            ['retry-loading.horizontal-overflow', 'overflow']
                        ]
                    )

                    const retryFailureRuntimeErrors = await openFixture(page, 'retry-failure', theme, mode)
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
                    await captureAuditRecord(
                        page,
                        'retry-failure',
                        viewport.name,
                        theme,
                        mode,
                        retryFailureRuntimeErrors,
                        [
                            ['retry-failure.fixture-ready', 'lifecycle-semantics'],
                            ['retry-failure.runtime-errors', 'runtime-errors'],
                            ['retry-failure.reason-copy', 'lifecycle-semantics'],
                            ['retry-failure.retry-describedby', 'aria-live-region'],
                            ['retry-failure.not-alert', 'aria-live-region'],
                            ['retry-failure.not-assertive-live-region', 'aria-live-region'],
                            ['retry-failure.request-count', 'retry-interaction'],
                            ['retry-failure.peak-assertive-announcement-count', 'aria-live-region'],
                            ['retry-failure.peak-toast-count', 'aria-live-region'],
                            ['retry-failure.horizontal-overflow', 'overflow']
                        ]
                    )

                    const retrySuccessRuntimeErrors = await openFixture(page, 'retry-success', theme, mode)
                    await expect(page.locator('[data-ops-health-state]')).toHaveCount(0)
                    await expect(page.locator('[data-ops-health-failure-reason]')).toHaveCount(0)
                    await expect(page.getByRole('button', { name: '重新加载' })).toHaveCount(0)
                    await expect(page.locator('[data-ops-health-workbench]')).toBeVisible()
                    await assertNoHorizontalOverflow(page)
                    await captureAuditRecord(
                        page,
                        'retry-success',
                        viewport.name,
                        theme,
                        mode,
                        retrySuccessRuntimeErrors,
                        [
                            ['retry-success.fixture-ready', 'lifecycle-semantics'],
                            ['retry-success.runtime-errors', 'runtime-errors'],
                            ['retry-success.state-host-absent', 'lifecycle-semantics'],
                            ['retry-success.failure-reason-absent', 'lifecycle-semantics'],
                            ['retry-success.retry-absent', 'retry-interaction'],
                            ['retry-success.workbench-visible', 'lifecycle-semantics'],
                            ['retry-success.horizontal-overflow', 'overflow']
                        ]
                    )
                })
            })
        }
    }
}
