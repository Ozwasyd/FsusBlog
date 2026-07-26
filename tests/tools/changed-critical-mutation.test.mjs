import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import test from 'node:test'

import {
    createChangedCriticalStrykerConfig,
    selectChangedCriticalMutation
} from '../../tools/test/changed-critical-mutation.mjs'
import {
    createChangedCriticalMutationAuthority,
    validateChangedCriticalMutationAuthority
} from '../../tools/test/changed-critical-mutation-evidence.mjs'
import {
    executeChangedCriticalSelection
} from '../../tools/test/run-changed-critical-mutation.mjs'

const rawCatalog = readFileSync(
    new URL('../../config/testing/mutation/changed-critical-domains.v1.json', import.meta.url)
)
const catalog = JSON.parse(rawCatalog)
const fixtures = JSON.parse(readFileSync(
    new URL('./fixtures/changed-critical-mutation-selection.json', import.meta.url),
    'utf8'
))
const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
}
const rawTestId = '00000000-0000-0000-0000-000000000002'
const testName = 'FsusBlog.Server.Tests.Unit.ArticleRightsCanonicalHashTests.Run'

function select(changedPaths, selectedCatalog = catalog, selectedRawCatalog = rawCatalog) {
    return selectChangedCriticalMutation({
        catalog: selectedCatalog,
        rawCatalog: selectedRawCatalog,
        changedPaths,
        sourceState
    })
}

function report(statuses = ['Killed', 'Killed', 'Killed', 'Survived']) {
    const source = 'public sealed class Subject {}'
    return {
        schemaVersion: '2',
        thresholds: { high: 85, low: 70 },
        files: {
            'src/core/Integrity/ArticleRightsCanonicalHashV1.cs': {
                language: 'cs',
                source,
                mutants: statuses.map((status, index) => ({
                    id: String(index + 1),
                    status,
                    mutatorName: 'Arithmetic mutation',
                    replacement: `replacement-${index}`,
                    location: {
                        start: { line: 1, column: index + 1 },
                        end: { line: 1, column: index + 2 }
                    },
                    coveredBy: ['CompileError', 'Ignored', 'NoCoverage'].includes(status)
                        ? []
                        : [rawTestId],
                    killedBy: status === 'Killed' ? [rawTestId] : []
                }))
            }
        },
        testFiles: {
            'tests/backend/Unit/ArticleRightsCanonicalHashTests.cs': {
                tests: [{ id: rawTestId, name: testName }]
            }
        }
    }
}

function mutationScore(inputReport) {
    const mutants = Object.values(inputReport.files).flatMap(({ mutants: values }) => values)
    const killed = mutants.filter(({ status }) => status === 'Killed').length
    const scoreable = mutants.filter(({ status }) =>
        ['Killed', 'NoCoverage', 'Survived', 'Timeout'].includes(status)
    ).length
    return Number(((killed / scoreable) * 100).toFixed(2))
}

function traceFor(inputReport, inputConfig, reportPath) {
    const reportName = basename(reportPath, extname(reportPath))
    const mutants = Object.values(inputReport.files).flatMap(({ mutants: values }) => values)
    const executed = mutants.filter(
        ({ status }) => ['Killed', 'Survived', 'Timeout'].includes(status)
    )
    const lines = [
        '2026-07-22T23:59:59.0000000Z  [DBG] '
        + 'Stryker starting, version: "4.14.2" (e60f399b)',
        '2026-07-23T00:00:00.0000000Z  [DBG] Stryker started with options: '
        + `StrykerOptions { ReportPath: "${dirname(reportPath)}", `
        + `ReportFileName: "${reportName}", `
        + `TestCaseFilter: "${inputConfig['stryker-config']['test-case-filter']}" } (fac41b16)`
    ]
    executed.forEach((mutant, index) => {
        const start = new Date(Date.parse('2026-07-23T00:00:01.000Z') + index * 100)
            .toISOString()
            .replace('.000Z', '.0000000Z')
        const end = new Date(Date.parse('2026-07-23T00:00:01.025Z') + index * 100)
            .toISOString()
            .replace('.025Z', '.0250000Z')
        const label = `${mutant.id}: mutation`
        const outcome = mutant.status === 'Killed'
            ? 'failed'
            : mutant.status === 'Timeout'
                ? 'timeout'
                : 'passed'
        lines.push(
            `${start}  [DBG] "Runner 0": Testing ${JSON.stringify([label])} (445b8f48)`
        )
        lines.push(
            `${end}  [DBG] Test run for "${label}" is "${outcome}" (26093294)`
        )
    })
    lines.push(
        `2026-07-23T00:00:10.0000000Z  [INF] The final mutation score is `
        + `${mutationScore(inputReport).toFixed(2)} % (2ef58de4)`
    )
    return Buffer.from(`${lines.join('\n')}\n`)
}

function fixtureRun(selection, statuses = ['Killed', 'Killed', 'Killed', 'Survived']) {
    const config = createChangedCriticalStrykerConfig(selection, catalog)
    const rawConfig = Buffer.from(`${JSON.stringify(config, null, 2)}\n`)
    const mutationReport = report(statuses)
    const rawReport = Buffer.from(`${JSON.stringify(mutationReport, null, 2)}\n`)
    const paths = {
        config: '.tmp/mutation/changed-critical/run/configs/src-core.json',
        report: '.tmp/mutation/changed-critical/run/physical/src-core/reports/changed-critical-mutation.json',
        trace: '.tmp/mutation/changed-critical/run/physical/src-core/logs/log-20260723.txt'
    }
    const reportAbsolutePath = resolve(paths.report)
    return {
        sourceProject: 'src/core',
        config,
        rawConfig,
        report: mutationReport,
        rawReport,
        reportAbsolutePath,
        rawTrace: traceFor(mutationReport, config, reportAbsolutePath),
        paths
    }
}

test('single-domain change selects only its exact mutate file and owned test filter', () => {
    const selection = select(fixtures.singleDomain)

    assert.equal(selection.status, 'selected')
    assert.deepEqual(
        selection.domains.map(({ id }) => id),
        ['article-rights-canonicalization']
    )
    assert.deepEqual(
        selection.mutateFiles,
        ['src/core/Integrity/ArticleRightsCanonicalHashV1.cs']
    )
    assert.match(selection.testFilter, /ArticleRightsCanonicalHashTests/u)
    assert.doesNotMatch(selection.testFilter, /PasskeyServiceTests/u)
})

test('cross-domain selection is deterministic, de-duplicated, and source-bound', () => {
    const forward = select(fixtures.crossDomain)
    const reverse = select([...fixtures.crossDomain].reverse())

    assert.equal(forward.closureDigest, reverse.closureDigest)
    assert.deepEqual(forward.mutateFiles, [
        'src/backend/Infrastructure/Auth/AccountSubjectHasher.cs',
        'src/core/Integrity/ArticleRightsCanonicalHashV1.cs'
    ])
    assert.deepEqual(forward.domains.map(({ id }) => id), [
        'article-rights-canonicalization',
        'authentication-session-passkey'
    ])
    assert.equal(
        new Set(forward.testOwners.map(({ id }) => id)).size,
        forward.testOwners.length
    )
})

test('critical source without a complete domain mapping fails closed with missing fields', () => {
    const broken = structuredClone(catalog)
    broken.domains = broken.domains.map((domain) => ({
        ...domain,
        sourcePatterns: domain.sourcePatterns.filter(
            (pattern) => !pattern.includes('Services/Security')
        )
    }))
    const rawBroken = Buffer.from(`${JSON.stringify(broken, null, 2)}\n`)

    assert.throws(
        () => select(fixtures.unmappedCritical, broken, rawBroken),
        /NewCriticalBoundary\.cs.*missing fields: domain, testOwners, mutationPolicy/u
    )
})

test('unrelated changes produce a structured empty selection and never start Stryker', () => {
    const selection = select(fixtures.unrelated)
    let starts = 0
    const run = executeChangedCriticalSelection({
        selection,
        spawnStryker: () => {
            starts += 1
            return { status: 0 }
        }
    })

    assert.equal(selection.status, 'empty')
    assert.deepEqual(selection.domains, [])
    assert.deepEqual(selection.mutateFiles, [])
    assert.equal(selection.testFilter, '')
    assert.equal(run.status, 'empty')
    assert.equal(run.strykerStarted, false)
    assert.equal(starts, 0)
})

test('generated config is run-bound and preserves reviewed mutation semantics', () => {
    const selection = select(fixtures.singleDomain)
    const generated = createChangedCriticalStrykerConfig(selection, catalog)

    assert.deepEqual(
        generated['stryker-config']['test-projects'],
        ['../../tests/backend/FsusBlog.Server.Tests.csproj']
    )
    assert.deepEqual(
        generated['stryker-config'].mutate,
        ['Integrity/ArticleRightsCanonicalHashV1.cs']
    )
    assert.equal(
        generated['stryker-config']['test-case-filter'],
        selection.projectClosures[0].testFilter
    )
    assert.deepEqual(
        generated['stryker-config'].thresholds,
        { high: 85, low: 70, break: 70 }
    )
    assert.equal(generated['stryker-config']['break-on-initial-test-failure'], true)
})

test('authority binds source, raw reports, traces, test GUIDs, and mutant outcomes', () => {
    const selection = select(fixtures.singleDomain)
    const rawSelection = Buffer.from(`${JSON.stringify(selection, null, 2)}\n`)
    const runs = [fixtureRun(selection)]
    const authority = createChangedCriticalMutationAuthority({
        selection,
        rawSelection,
        catalog,
        rawCatalog,
        runs,
        selectionPath: '.tmp/mutation/changed-critical/run/selection.json',
        runId: 'changed-critical-fixture',
        generatedAt: '2026-07-23T00:00:00.000Z'
    })

    assert.equal(authority.sourceState.commit, sourceState.commit)
    assert.equal(
        authority.catalog.sha256,
        createHash('sha256').update(rawCatalog).digest('hex')
    )
    assert.deepEqual(authority.mutateFiles, selection.mutateFiles)
    assert.equal(authority.testFilter, selection.testFilter)
    assert.deepEqual(authority.mutants, {
        executed: 4,
        killed: 3,
        survived: 1,
        timeout: 0,
        noCoverage: 0,
        compileError: 0,
        ignored: 0
    })
    assert.equal(authority.physicalRuns[0].score, 75)
    assert.deepEqual(authority.executedTestIds, [testName])
    assert.deepEqual(authority.testIdentities, [{
        rawTestId,
        fullyQualifiedName: testName
    }])
    assert.match(authority.rawReportDigest, /^[0-9a-f]{64}$/u)
    assert.match(authority.rawTraceDigest, /^[0-9a-f]{64}$/u)
    assert.match(authority.traceBatchDigest, /^[0-9a-f]{64}$/u)
    assert.equal(authority.physicalRuns[0].traceExecution.strykerVersion, '4.14.2')
    assert.equal(authority.physicalRuns[0].traceExecution.batches.length, 4)
})

test('authority validator rejects stale report, source, config, catalog, or zero mutants', () => {
    const selection = select(fixtures.singleDomain)
    const rawSelection = Buffer.from(`${JSON.stringify(selection, null, 2)}\n`)
    const runs = [fixtureRun(selection, ['Killed', 'Killed', 'Killed'])]
    const authority = createChangedCriticalMutationAuthority({
        selection,
        rawSelection,
        catalog,
        rawCatalog,
        runs,
        selectionPath: 'selection.json',
        runId: 'current',
        generatedAt: '2026-07-23T00:00:00.000Z'
    })
    const base = {
        authority,
        selection,
        rawSelection,
        catalog,
        rawCatalog,
        runs,
        expectedSourceState: sourceState
    }

    assert.throws(
        () => validateChangedCriticalMutationAuthority({
            ...base,
            runs: [{
                ...runs[0],
                rawReport: Buffer.from(
                    `${JSON.stringify(report(['Killed', 'Survived']), null, 2)}\n`
                )
            }]
        }),
        /raw Stryker report content|authority content mismatch/u
    )
    assert.throws(
        () => validateChangedCriticalMutationAuthority({
            ...base,
            expectedSourceState: { ...sourceState, commit: 'c'.repeat(40) }
        }),
        /source commit mismatch/u
    )
    assert.throws(
        () => validateChangedCriticalMutationAuthority({
            ...base,
            runs: [{ ...runs[0], rawConfig: Buffer.from('{}') }]
        }),
        /raw Stryker config content|authority content mismatch/u
    )
    assert.throws(
        () => validateChangedCriticalMutationAuthority({
            ...base,
            rawCatalog: Buffer.from('{}')
        }),
        /catalog digest mismatch/u
    )

    const zeroRun = fixtureRun(selection, ['Ignored', 'CompileError'])
    assert.throws(
        () => createChangedCriticalMutationAuthority({
            selection,
            rawSelection,
            catalog,
            rawCatalog,
            runs: [zeroRun],
            selectionPath: 'selection.json',
            runId: 'zero',
            generatedAt: '2026-07-23T00:00:00.000Z'
        }),
        /must execute at least one mutant/u
    )
})

test('changed-critical runner requires verbose trace production and records trace in manifest', () => {
    const runner = readFileSync(
        new URL('../../tools/test/run-changed-critical-mutation.mjs', import.meta.url),
        'utf8'
    )

    assert.match(runner, /--log-to-file/u)
    assert.match(runner, /'--verbosity'/u)
    assert.match(runner, /tracePath/u)
    assert.match(runner, /trace: physical\.paths\.trace/u)
})

test('checked-in nightly and fixed release mutation lanes remain present and unchanged in purpose', () => {
    const matrix = readFileSync(new URL('../matrix.yml', import.meta.url), 'utf8')
    const defaults = JSON.parse(readFileSync(
        new URL('../../config/testing/mutation/default.json', import.meta.url),
        'utf8'
    ))
    const critical = JSON.parse(readFileSync(
        new URL('../../config/testing/mutation/critical.json', import.meta.url),
        'utf8'
    ))

    assert.match(matrix, /- id: backend-mutation\n/u)
    assert.match(matrix, /- id: release-mutation-critical-slice\n/u)
    assert.ok(defaults['stryker-config'].mutate.length > 1)
    assert.deepEqual(critical['stryker-config'].mutate, ['Algorithms/AedsEncoder.cs'])
})
