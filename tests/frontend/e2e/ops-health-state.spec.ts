import { expect, test, type Page } from '@playwright/test'
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type FixtureState = 'initial-loading' | 'failure' | 'retry-loading' | 'retry-failure' | 'retry-success'
type FixtureTheme = 'light' | 'dark'
type FixtureMode = 'default' | 'zoom-200' | 'forced-colors'
type FixtureViewport = (typeof viewports)[number]['name']
type AssertionResponsibility =
    | 'lifecycle-semantics'
    | 'aria-live-region'
    | 'retry-interaction'
    | 'hit-target-size'
    | 'keyboard-focus'
    | 'overflow'
    | 'runtime-errors'
    | 'screenshot-evidence'

interface AuditAssertion {
    id: string
    responsibility: AssertionResponsibility
    proposedSurvivingExecutableTestId: string
}

interface AuditRecord {
    state: FixtureState
    viewport: FixtureViewport
    theme: FixtureTheme
    mode: FixtureMode
    clientWidth: number
    scrollWidth: number
    runtimeErrors: string[]
    elementPresence: {
        stateHost: boolean
        failureReason: boolean
        retryButton: boolean
        alert: boolean
        assertiveLiveRegionCount: number
        toastCount: number
        workbench: boolean
    }
    currentExecutableTestId: string
    assertions: AuditAssertion[]
    screenshotEvidence: string | null
}

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
const auditRunId =
    process.env.FSUSBLOG_OPS_HEALTH_STATE_AUDIT_RUN_ID ??
    process.env.FSUSBLOG_TEST_RUN_ID ??
    'ops-health-state-standalone'
const auditPath = path.join(evidenceRoot, 'matrix-reduction-audit.json')
const auditLock = path.join(
    evidenceRoot,
    `.matrix-reduction-audit.${auditRunId.replaceAll(/[^a-zA-Z0-9_.-]/gu, '_')}.lock`
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

function executableTestId(
    viewport: FixtureViewport,
    theme: FixtureTheme,
    mode: FixtureMode
): string {
    return `ops-health-state/${viewport}/${theme}/${mode}/keeps-loading-failure-retry-success-distinct-contained`
}

function auditAssertions(
    currentTestId: string,
    entries: ReadonlyArray<readonly [string, AssertionResponsibility]>
): AuditAssertion[] {
    return entries.map(([id, responsibility]) => ({
        id,
        responsibility,
        proposedSurvivingExecutableTestId: currentTestId
    }))
}

function expectedAuditKeys(): string[] {
    return viewports.flatMap((viewport) =>
        themes.flatMap((theme) =>
            modes.flatMap((mode) =>
                (
                    [
                        'initial-loading',
                        'failure',
                        'retry-loading',
                        'retry-failure',
                        'retry-success'
                    ] as const
                ).map((state) => `${state}/${viewport.name}/${theme}/${mode}`)
            )
        )
    ).sort()
}

async function acquireAuditLock(): Promise<void> {
    const deadline = Date.now() + 30_000
    while (true) {
        try {
            mkdirSync(auditLock)
            return
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            if (Date.now() >= deadline) {
                throw new Error(`ops health audit lock timed out: ${auditLock}`)
            }
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
    }
}

async function recordAudit(record: AuditRecord): Promise<void> {
    await acquireAuditLock()
    try {
        const existing = existsSync(auditPath)
            ? (JSON.parse(readFileSync(auditPath, 'utf8')) as {
                  runId?: string
                  records?: AuditRecord[]
              })
            : null
        const records = existing?.runId === auditRunId ? [...(existing.records ?? [])] : []
        const key = `${record.state}/${record.viewport}/${record.theme}/${record.mode}`
        if (
            records.some(
                (candidate) =>
                    `${candidate.state}/${candidate.viewport}/${candidate.theme}/${candidate.mode}` === key
            )
        ) {
            throw new Error(`duplicate ops health audit tuple: ${key}`)
        }
        records.push(record)
        records.sort((left, right) =>
            `${left.state}/${left.viewport}/${left.theme}/${left.mode}`.localeCompare(
                `${right.state}/${right.viewport}/${right.theme}/${right.mode}`
            )
        )

        const expectedKeys = expectedAuditKeys()
        const actualKeys = records
            .map((candidate) =>
                `${candidate.state}/${candidate.viewport}/${candidate.theme}/${candidate.mode}`
            )
            .sort()
        if (records.length > expectedKeys.length) {
            throw new Error(`ops health audit emitted ${records.length} records; expected 90`)
        }
        const complete = records.length === expectedKeys.length
        if (
            complete &&
            (actualKeys.length !== expectedKeys.length ||
                actualKeys.some((candidate, index) => candidate !== expectedKeys[index]))
        ) {
            throw new Error('ops health audit is missing or duplicated state/rendered-dimension tuples')
        }
        if (
            complete &&
            records.some(
                (candidate) =>
                    candidate.clientWidth <= 0 ||
                    candidate.scrollWidth <= 0 ||
                    candidate.scrollWidth - candidate.clientWidth > 4 ||
                    candidate.runtimeErrors.length > 0 ||
                    candidate.assertions.length === 0
            )
        ) {
            throw new Error('ops health audit contains an invalid rendered observation')
        }

        const currentTestIds = [...new Set(records.map((candidate) => candidate.currentExecutableTestId))].sort()
        const replacementMap = records
            .flatMap((candidate) =>
                candidate.assertions.map((assertion) => ({
                    tuple: `${candidate.state}/${candidate.viewport}/${candidate.theme}/${candidate.mode}`,
                    assertionId: assertion.id,
                    responsibility: assertion.responsibility,
                    currentExecutableTestId: candidate.currentExecutableTestId,
                    proposedSurvivingExecutableTestId:
                        assertion.proposedSurvivingExecutableTestId
                }))
            )
            .sort((left, right) =>
                `${left.tuple}/${left.assertionId}`.localeCompare(`${right.tuple}/${right.assertionId}`)
            )
        const assertionIdsByState = Object.fromEntries(
            (
                [
                    'initial-loading',
                    'failure',
                    'retry-loading',
                    'retry-failure',
                    'retry-success'
                ] as const
            ).map((state) => [
                state,
                [
                    ...new Set(
                        records
                            .filter((candidate) => candidate.state === state)
                            .flatMap((candidate) => candidate.assertions.map((assertion) => assertion.id))
                    )
                ].sort()
            ])
        )
        const sharedAssertionFamilies = [
            {
                responsibility: 'runtime-errors',
                assertionIds: Object.values(assertionIdsByState)
                    .flat()
                    .filter((id) => id.endsWith('.runtime-errors'))
                    .sort()
            },
            {
                responsibility: 'overflow',
                assertionIds: Object.values(assertionIdsByState)
                    .flat()
                    .filter((id) => id.endsWith('.horizontal-overflow'))
                    .sort()
            },
            {
                responsibility: 'lifecycle-semantics',
                assertionIds: Object.values(assertionIdsByState)
                    .flat()
                    .filter((id) => id.endsWith('.fixture-ready'))
                    .sort()
            }
        ]
        const screenshotCount = records.filter((candidate) => candidate.screenshotEvidence !== null).length
        if (complete && screenshotCount !== 18) {
            throw new Error(`ops health audit captured ${screenshotCount} failure screenshots; expected 18`)
        }
        const document = {
            schema: 'fsusblog.ops-health-state-matrix-reduction-audit.v1',
            runId: auditRunId,
            expectedRecordCount: 90,
            recordCount: records.length,
            complete,
            decision: complete ? 'keep-current' : null,
            decisionReason: complete
                ? 'Every non-failure state retains a viewport/theme/mode-specific overflow and runtime-error oracle; no equal-or-stronger executable survivor removes those rendered-dimension responsibilities.'
                : null,
            oracleComparison: complete
                ? {
                      'initial-loading': {
                          failureStateOracleIsEqualOrStronger: false,
                          reason: 'Initial loading owns status-role, loading-copy, absence, overflow, and runtime-error oracles that failure rendering does not execute.'
                      },
                      failure: {
                          failureStateOracleIsEqualOrStronger: true,
                          reason: 'The failure-state records are their own exact executable survivors.'
                      },
                      'retry-loading': {
                          failureStateOracleIsEqualOrStronger: false,
                          reason: 'Retry loading owns disabled/busy, request-count, overflow, and runtime-error oracles that failure rendering does not execute.'
                      },
                      'retry-failure': {
                          failureStateOracleIsEqualOrStronger: false,
                          reason: 'Retry failure owns second-attempt reason/count, overflow, and runtime-error oracles that failure rendering does not execute.'
                      },
                      'retry-success': {
                          failureStateOracleIsEqualOrStronger: false,
                          reason: 'Retry success owns workbench/absence, overflow, and runtime-error oracles that failure rendering does not execute.'
                      }
                  }
                : null,
            currentTopology: {
                executableTestCount: 18,
                navigationCount: 90,
                failureScreenshotCount: 18
            },
            proposedTopology: complete
                ? {
                      executableTestCount: 18,
                      navigationCount: 90,
                      failureScreenshotCount: 18,
                      survivingExecutableTestIds: currentTestIds,
                      preserves: {
                          states: [
                              'initial-loading',
                              'failure',
                              'retry-loading',
                              'retry-failure',
                              'retry-success'
                          ],
                          viewports: ['mobile', 'tablet', 'desktop'],
                          themes: ['light', 'dark'],
                          modes: ['default', 'zoom-200', 'forced-colors'],
                          retryTargetMinimumHeightPx: 44,
                          keyboardFocus: true,
                          ariaRelationships: true,
                          toastAndLiveRegionCounts: true,
                          requestCounts: true,
                          overflowChecks: true,
                          runtimeErrorChecks: true
                      }
                  }
                : null,
            assertionIdsByState,
            failureOnlyAssertionIds: assertionIdsByState.failure,
            sharedAssertionFamilies,
            replacementMap,
            records
        }
        const next = `${auditPath}.next-${process.pid}`
        writeFileSync(next, `${JSON.stringify(document, null, 2)}\n`)
        renameSync(next, auditPath)
    } finally {
        rmSync(auditLock, { recursive: true, force: true })
    }
}

async function captureAuditRecord(
    page: Page,
    state: FixtureState,
    viewport: FixtureViewport,
    theme: FixtureTheme,
    mode: FixtureMode,
    runtimeErrors: string[],
    assertionEntries: ReadonlyArray<readonly [string, AssertionResponsibility]>,
    screenshotEvidence: string | null = null
): Promise<void> {
    const observation = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        elementPresence: {
            stateHost: document.querySelector('[data-ops-health-state]') !== null,
            failureReason: document.querySelector('[data-ops-health-failure-reason]') !== null,
            retryButton: document.querySelector('[data-ops-health-retry]') !== null,
            alert: document.querySelector('[role="alert"]') !== null,
            assertiveLiveRegionCount: document.querySelectorAll('[aria-live="assertive"]').length,
            toastCount: document.querySelectorAll('.el-message, .fsusblog-motion-toast').length,
            workbench: document.querySelector('[data-ops-health-workbench]') !== null
        }
    }))
    const currentTestId = executableTestId(viewport, theme, mode)
    await recordAudit({
        state,
        viewport,
        theme,
        mode,
        clientWidth: observation.clientWidth,
        scrollWidth: observation.scrollWidth,
        runtimeErrors: [...runtimeErrors],
        elementPresence: observation.elementPresence,
        currentExecutableTestId: currentTestId,
        assertions: auditAssertions(currentTestId, assertionEntries),
        screenshotEvidence
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
