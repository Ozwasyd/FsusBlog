import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSystemChromiumExecutablePath } from '../support/system-chromium.mjs'

type FixtureState = 'initial-loading' | 'failure' | 'retry-loading' | 'retry-failure' | 'retry-success'
type FixtureTheme = 'light' | 'dark'
type FixtureMode = 'default' | 'zoom-200' | 'forced-colors'

type ObservableResponsibility =
    | 'lifecycle semantics'
    | 'ARIA/live-region behavior'
    | 'retry interaction'
    | 'hit-target size'
    | 'keyboard focus'
    | 'overflow'
    | 'runtime errors'
    | 'screenshot evidence'

type AssertionContract = {
    id: string
    responsibility: ObservableResponsibility
}

type TupleAuditRecord = {
    state: FixtureState
    viewport: string
    theme: FixtureTheme
    mode: FixtureMode
    clientWidth: number
    scrollWidth: number
    runtimeErrors: string[]
    elementPresence: {
        stateContainerCount: number
        failureReasonCount: number
        retryButtonCount: number
        workbenchCount: number
        assertiveLiveRegionCount: number
        toastCount: number
        stateRole: string | null
        stateAriaLive: string | null
        retryAriaBusy: string | null
        retryAriaDescribedBy: string | null
        retryEnabled: boolean | null
    }
    assertionIds: string[]
    survivingExecutableTestIds: Record<string, string>
}

const states: readonly FixtureState[] = [
    'initial-loading',
    'failure',
    'retry-loading',
    'retry-failure',
    'retry-success'
]

const assertionContractsByState: Record<FixtureState, readonly AssertionContract[]> = {
    'initial-loading': [
        { id: 'initial-loading.fixture-ready', responsibility: 'lifecycle semantics' },
        { id: 'initial-loading.no-runtime-errors', responsibility: 'runtime errors' },
        { id: 'initial-loading.status-role', responsibility: 'ARIA/live-region behavior' },
        { id: 'initial-loading.message', responsibility: 'lifecycle semantics' },
        { id: 'initial-loading.no-failure-message', responsibility: 'lifecycle semantics' },
        { id: 'initial-loading.no-failure-reason', responsibility: 'lifecycle semantics' },
        { id: 'initial-loading.no-retry-button', responsibility: 'retry interaction' },
        { id: 'initial-loading.no-alert-role', responsibility: 'ARIA/live-region behavior' },
        { id: 'initial-loading.no-assertive-region', responsibility: 'ARIA/live-region behavior' },
        { id: 'initial-loading.horizontal-overflow', responsibility: 'overflow' }
    ],
    failure: [
        { id: 'failure.fixture-ready', responsibility: 'lifecycle semantics' },
        { id: 'failure.no-runtime-errors', responsibility: 'runtime errors' },
        { id: 'failure.state-not-alert', responsibility: 'ARIA/live-region behavior' },
        { id: 'failure.state-not-assertive', responsibility: 'ARIA/live-region behavior' },
        { id: 'failure.message', responsibility: 'lifecycle semantics' },
        { id: 'failure.reason', responsibility: 'lifecycle semantics' },
        { id: 'failure.reason-id', responsibility: 'ARIA/live-region behavior' },
        { id: 'failure.retry-describedby', responsibility: 'ARIA/live-region behavior' },
        { id: 'failure.retry-enabled', responsibility: 'retry interaction' },
        { id: 'failure.toast-count', responsibility: 'ARIA/live-region behavior' },
        { id: 'failure.assertive-region-count', responsibility: 'ARIA/live-region behavior' },
        { id: 'failure.assertive-announcement-peak', responsibility: 'ARIA/live-region behavior' },
        { id: 'failure.toast-peak', responsibility: 'ARIA/live-region behavior' },
        { id: 'failure.retry-bounds-present', responsibility: 'hit-target size' },
        { id: 'failure.retry-height-44', responsibility: 'hit-target size' },
        { id: 'failure.retry-focused', responsibility: 'keyboard focus' },
        { id: 'failure.retry-focus-visible', responsibility: 'keyboard focus' },
        { id: 'failure.retry-focus-indicator', responsibility: 'keyboard focus' },
        { id: 'failure.horizontal-overflow', responsibility: 'overflow' },
        { id: 'failure.screenshot', responsibility: 'screenshot evidence' }
    ],
    'retry-loading': [
        { id: 'retry-loading.fixture-ready', responsibility: 'lifecycle semantics' },
        { id: 'retry-loading.no-runtime-errors', responsibility: 'runtime errors' },
        { id: 'retry-loading.retry-disabled', responsibility: 'retry interaction' },
        { id: 'retry-loading.retry-busy', responsibility: 'ARIA/live-region behavior' },
        { id: 'retry-loading.message', responsibility: 'lifecycle semantics' },
        { id: 'retry-loading.request-count', responsibility: 'retry interaction' },
        { id: 'retry-loading.toast-count', responsibility: 'ARIA/live-region behavior' },
        { id: 'retry-loading.assertive-region-count', responsibility: 'ARIA/live-region behavior' },
        { id: 'retry-loading.assertive-announcement-peak', responsibility: 'ARIA/live-region behavior' },
        { id: 'retry-loading.toast-peak', responsibility: 'ARIA/live-region behavior' },
        { id: 'retry-loading.horizontal-overflow', responsibility: 'overflow' }
    ],
    'retry-failure': [
        { id: 'retry-failure.fixture-ready', responsibility: 'lifecycle semantics' },
        { id: 'retry-failure.no-runtime-errors', responsibility: 'runtime errors' },
        { id: 'retry-failure.reason', responsibility: 'lifecycle semantics' },
        { id: 'retry-failure.retry-describedby', responsibility: 'ARIA/live-region behavior' },
        { id: 'retry-failure.state-not-alert', responsibility: 'ARIA/live-region behavior' },
        { id: 'retry-failure.state-not-assertive', responsibility: 'ARIA/live-region behavior' },
        { id: 'retry-failure.request-count', responsibility: 'retry interaction' },
        { id: 'retry-failure.assertive-announcement-peak', responsibility: 'ARIA/live-region behavior' },
        { id: 'retry-failure.toast-peak', responsibility: 'ARIA/live-region behavior' },
        { id: 'retry-failure.horizontal-overflow', responsibility: 'overflow' }
    ],
    'retry-success': [
        { id: 'retry-success.fixture-ready', responsibility: 'lifecycle semantics' },
        { id: 'retry-success.no-runtime-errors', responsibility: 'runtime errors' },
        { id: 'retry-success.no-state-region', responsibility: 'lifecycle semantics' },
        { id: 'retry-success.no-failure-reason', responsibility: 'lifecycle semantics' },
        { id: 'retry-success.no-retry-button', responsibility: 'retry interaction' },
        { id: 'retry-success.workbench-visible', responsibility: 'lifecycle semantics' },
        { id: 'retry-success.horizontal-overflow', responsibility: 'overflow' }
    ]
}

const assertionResponsibilities = Object.fromEntries(
    states.flatMap((state) => assertionContractsByState[state]).map(({ id, responsibility }) => [
        id,
        { responsibility }
    ])
) as Record<string, { responsibility: ObservableResponsibility }>

const auditRecords: TupleAuditRecord[] = []
const executablePath = resolveSystemChromiumExecutablePath()

test.use({
    launchOptions: {
        ...(executablePath ? { executablePath } : {}),
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=LocalNetworkAccessChecks']
    }
})

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
    await expect.poll(
        () => page.evaluate(() => document.documentElement.dataset.opsHealthFixtureReady),
        { timeout: 30_000 }
    ).toBe('true')
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

function executableTestId(viewport: string, theme: FixtureTheme, mode: FixtureMode): string {
    return [
        'tests/frontend/e2e/ops-health-state.spec.ts',
        `ops health state ${viewport} ${theme} ${mode}`,
        'keeps loading, failure, retry and success distinct and contained'
    ].join('#')
}

async function recordTupleAudit(
    page: Page,
    state: FixtureState,
    viewport: string,
    theme: FixtureTheme,
    mode: FixtureMode,
    runtimeErrors: string[]
): Promise<void> {
    const stateContainer = page.locator('[data-ops-health-state]')
    const retryButton = page.getByRole('button', { name: '重新加载' })
    const stateContainerCount = await stateContainer.count()
    const retryButtonCount = await retryButton.count()
    const { clientWidth, scrollWidth } = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
    }))
    const currentExecutableTestId = executableTestId(viewport, theme, mode)
    const assertionIds = assertionContractsByState[state].map(({ id }) => id)

    auditRecords.push({
        state,
        viewport,
        theme,
        mode,
        clientWidth,
        scrollWidth,
        runtimeErrors: [...runtimeErrors],
        elementPresence: {
            stateContainerCount,
            failureReasonCount: await page.locator('[data-ops-health-failure-reason]').count(),
            retryButtonCount,
            workbenchCount: await page.locator('[data-ops-health-workbench]').count(),
            assertiveLiveRegionCount: await page.locator('[aria-live="assertive"]').count(),
            toastCount: await page.locator('.el-message').count(),
            stateRole: stateContainerCount > 0 ? await stateContainer.first().getAttribute('role') : null,
            stateAriaLive: stateContainerCount > 0 ? await stateContainer.first().getAttribute('aria-live') : null,
            retryAriaBusy: retryButtonCount > 0 ? await retryButton.getAttribute('aria-busy') : null,
            retryAriaDescribedBy: retryButtonCount > 0 ? await retryButton.getAttribute('aria-describedby') : null,
            retryEnabled: retryButtonCount > 0 ? await retryButton.isEnabled() : null
        },
        assertionIds,
        survivingExecutableTestIds: Object.fromEntries(
            assertionIds.map((assertionId) => [assertionId, currentExecutableTestId])
        )
    })
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
                    const initialLoadingRuntimeErrors = await openFixture(page, 'initial-loading', theme, mode)
                    await expect(page.locator('[data-ops-health-state]')).toHaveAttribute('role', 'status')
                    await expect(page.locator('[data-ops-health-state]')).toContainText('正在读取运维状态')
                    await expect(page.getByText('运维状态暂不可用')).toHaveCount(0)
                    await expect(page.locator('[data-ops-health-failure-reason]')).toHaveCount(0)
                    await expect(page.getByRole('button', { name: '重新加载' })).toHaveCount(0)
                    await expect(page.locator('[role="alert"]')).toHaveCount(0)
                    await expect(page.locator('[aria-live="assertive"]')).toHaveCount(0)
                    await assertNoHorizontalOverflow(page)
                    await recordTupleAudit(
                        page,
                        'initial-loading',
                        viewport.name,
                        theme,
                        mode,
                        initialLoadingRuntimeErrors
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
                    await recordTupleAudit(
                        page,
                        'failure',
                        viewport.name,
                        theme,
                        mode,
                        failureRuntimeErrors
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
                    await recordTupleAudit(
                        page,
                        'retry-loading',
                        viewport.name,
                        theme,
                        mode,
                        retryLoadingRuntimeErrors
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
                    await recordTupleAudit(
                        page,
                        'retry-failure',
                        viewport.name,
                        theme,
                        mode,
                        retryFailureRuntimeErrors
                    )

                    const retrySuccessRuntimeErrors = await openFixture(page, 'retry-success', theme, mode)
                    await expect(page.locator('[data-ops-health-state]')).toHaveCount(0)
                    await expect(page.locator('[data-ops-health-failure-reason]')).toHaveCount(0)
                    await expect(page.getByRole('button', { name: '重新加载' })).toHaveCount(0)
                    await expect(page.locator('[data-ops-health-workbench]')).toBeVisible()
                    await assertNoHorizontalOverflow(page)
                    await recordTupleAudit(
                        page,
                        'retry-success',
                        viewport.name,
                        theme,
                        mode,
                        retrySuccessRuntimeErrors
                    )
                })
            })
        }
    }
}

test.afterAll(() => {
    auditRecords.sort((left, right) => {
        const leftKey = `${left.state}:${left.viewport}:${left.theme}:${left.mode}`
        const rightKey = `${right.state}:${right.viewport}:${right.theme}:${right.mode}`
        return leftKey.localeCompare(rightKey)
    })

    const expectedTuples = new Set(
        states.flatMap((state) =>
            viewports.flatMap((viewport) =>
                themes.flatMap((theme) =>
                    modes.map((mode) => `${state}::${viewport.name}::${theme}::${mode}`)
                )
            )
        )
    )
    const observedTuples = new Set<string>()
    for (const record of auditRecords) {
        const tuple = `${record.state}::${record.viewport}::${record.theme}::${record.mode}`
        if (observedTuples.has(tuple)) throw new Error(`duplicate ops health audit tuple: ${tuple}`)
        observedTuples.add(tuple)
    }

    const missingTuples = [...expectedTuples].filter((tuple) => !observedTuples.has(tuple))
    if (auditRecords.length !== 90 || observedTuples.size !== 90 || missingTuples.length > 0) {
        throw new Error(
            `ops health audit requires exactly 90 unique tuples; records=${auditRecords.length} unique=${observedTuples.size} missing=${missingTuples.join(',')}`
        )
    }

    const observedAssertionIds = new Set(auditRecords.flatMap((record) => record.assertionIds))
    const registeredAssertionIds = Object.keys(assertionResponsibilities)
    const missingAssertionIds = registeredAssertionIds.filter((id) => !observedAssertionIds.has(id))
    if (missingAssertionIds.length > 0) {
        throw new Error(`ops health audit omitted current assertions: ${missingAssertionIds.join(',')}`)
    }

    for (const record of auditRecords) {
        for (const assertionId of record.assertionIds) {
            if (!assertionResponsibilities[assertionId]) {
                throw new Error(`ops health audit assertion has no responsibility: ${assertionId}`)
            }
            const survivor = record.survivingExecutableTestIds[assertionId]
            if (!survivor || !survivor.startsWith('tests/frontend/e2e/ops-health-state.spec.ts#')) {
                throw new Error(`ops health audit assertion has no exact executable survivor: ${assertionId}`)
            }
        }
    }

    const retryAndSuccessStates: readonly FixtureState[] = [
        'retry-loading',
        'retry-failure',
        'retry-success'
    ]
    const retryAndSuccessRecords = auditRecords.filter((record) => retryAndSuccessStates.includes(record.state))
    const preservesRenderedDimensionOracles = retryAndSuccessRecords.length === 54
        && retryAndSuccessRecords.every((record) =>
            record.assertionIds.includes(`${record.state}.horizontal-overflow`)
            && record.assertionIds.includes(`${record.state}.no-runtime-errors`)
        )
    if (!preservesRenderedDimensionOracles) {
        throw new Error('ops health audit lost retry/success rendered-dimension oracles')
    }

    const auditReport = {
        schema: 'fsusblog-ops-health-matrix-reduction-audit-v1',
        decision: 'keep-current',
        decisionReason: 'Retry-loading, retry-failure, and retry-success each retain viewport/theme/mode-specific overflow and runtime-error oracles in the current executable matrix. No equal-or-stronger executable survivor exists outside the current tuple, so removing any of those tuples would violate the issue decision rule.',
        totalTuples: auditRecords.length,
        uniqueTuples: observedTuples.size,
        currentTopology: {
            executableTests: 18,
            navigationsPerTest: 5,
            totalNavigations: 90,
            failureStateScreenshots: 18,
            viewportClasses: viewports.map((viewport) => viewport.name),
            themeClasses: themes,
            modeClasses: modes,
            states
        },
        assertionResponsibilities,
        records: auditRecords
    }

    writeFileSync(
        path.join(evidenceRoot, 'matrix-reduction-audit.json'),
        `${JSON.stringify(auditReport, null, 2)}\n`,
        'utf8'
    )
})
