import type { Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type FixtureState = 'initial-loading' | 'failure' | 'retry-loading' | 'retry-failure' | 'retry-success'
export type FixtureTheme = 'light' | 'dark'
export type FixtureMode = 'default' | 'zoom-200' | 'forced-colors'
export type FixtureViewport = (typeof viewports)[number]['name']
export type AssertionResponsibility =
    | 'lifecycle-semantics'
    | 'aria-live-region'
    | 'retry-interaction'
    | 'hit-target-size'
    | 'keyboard-focus'
    | 'overflow'
    | 'runtime-errors'
    | 'screenshot-evidence'

export interface AuditAssertion {
    id: string
    responsibility: AssertionResponsibility
    proposedSurvivingExecutableTestId: string
}

export interface AuditRecord {
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

export const viewports = [
    { name: 'mobile', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 900 },
    { name: 'desktop', width: 1440, height: 900 }
] as const
export const themes: readonly FixtureTheme[] = ['light', 'dark']
export const modes: readonly FixtureMode[] = ['default', 'zoom-200', 'forced-colors']
export const evidenceRoot = path.resolve(
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

export async function captureAuditRecord(
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
