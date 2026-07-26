import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createStrykerAuthority } from '../../tools/test/check-stryker-report.mjs'
import { checkMutationInventory } from '../../tools/test/check-mutation-inventory.mjs'

const testId = '00000000-0000-0000-0000-000000000001'
const testName = 'FsusBlog.Server.Tests.Unit.AedsEncoderTests.Encode'
const config = { 'stryker-config': { 'test-case-filter': 'FullyQualifiedName~AedsEncoderTests', mutate: ['Algorithms/AedsEncoder.cs'], thresholds: { high: 85, low: 70, break: 70 } } }
const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const canonicalDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function rawMutant(id, status = 'Killed', line = 1, operator = 'Arithmetic mutation') {
    return { id, status, mutatorName: operator, replacement: `return ${id};`, location: { start: { line, column: 1 }, end: { line, column: 10 } }, coveredBy: ['Killed', 'Survived', 'Timeout'].includes(status) ? [testId] : [], killedBy: status === 'Killed' ? [testId] : [] }
}

function inputs(mutants) {
    const report = { schemaVersion: '2', thresholds: { high: 85, low: 70 }, files: { 'Algorithms/AedsEncoder.cs': { language: 'cs', source: 'return a;\nreturn b;\nreturn c;', mutants } }, testFiles: { 'tests/backend/Unit/AedsEncoderTests.cs': { tests: [{ id: testId, name: testName }] } } }
    const executed = mutants.filter(({ status }) => ['Killed', 'Survived', 'Timeout'].includes(status))
    const traceLines = ['2026-07-11T00:59:59.0000000Z  [DBG] Stryker starting, version: "4.14.2" (e60f399b)', '2026-07-11T01:00:00.0000000Z  [DBG] Stryker started with options: StrykerOptions { ReportPath: "/repo/.tmp/mutation/reports", ReportFileName: "backend-mutation-critical", TestCaseFilter: "FullyQualifiedName~AedsEncoderTests" } (fac41b16)']
    for (const [index, mutant] of executed.entries()) {
        const stamp = `2026-07-11T01:00:${String(index + 1).padStart(2, '0')}`
        traceLines.push(`${stamp}.0000000Z  [DBG] "Runner 0": Testing ["${mutant.id}: mutation"] (445b8f48)`)
        traceLines.push(`${stamp}.0250000Z  [DBG] Test run for "${mutant.id}: mutation" is "failed" (26093294)`)
    }
    const scoreable = mutants.filter(({ status }) => !['Ignored', 'CompileError'].includes(status)).length
    traceLines.push(`2026-07-11T01:01:00.0000000Z  [INF] The final mutation score is ${(mutants.filter(({ status }) => status === 'Killed').length / scoreable * 100).toFixed(2)} %`)
    return { report, rawReport: Buffer.from(JSON.stringify(report)), reportPath: '.tmp/mutation/reports/backend-mutation-critical.json', reportAbsolutePath: '/repo/.tmp/mutation/reports/backend-mutation-critical.json', rawTrace: Buffer.from(`${traceLines.join('\n')}\n`), tracePath: '.tmp/mutation/logs/log.txt', config, rawConfig: Buffer.from(JSON.stringify(config)), configPath: 'config/testing/mutation/critical.json', tierId: 'release-mutation-critical-slice', runId: 'test-run', sourceState, generatedAt: '2026-07-11T01:02:03.000Z', repositoryRoot: '/repo', sourceRoot: 'src/core' }
}

function authority(entries) {
    const value = inputs(entries.map(([id, status = 'Killed', operator = 'Arithmetic mutation'], index) => rawMutant(id, status, index + 1, operator)))
    return { authority: createStrykerAuthority(value), authorityInputs: value }
}

function policy(ids, changes = {}) {
    const baselineMutantIds = [...ids].sort()
    return { schema: 'fsusblog.mutation-inventory-retention.v1', scopeId: 'release-mutation-critical-slice', baselineMutantIds, baselineInventoryDigest: canonicalDigest(baselineMutantIds), requiredSourceRegions: ['src/core/Algorithms/AedsEncoder.cs'], requiredOperators: ['Arithmetic mutation'], minimumPlannedMutants: baselineMutantIds.length, minimumExecutedMutants: 1, maximumIgnoredShare: 0.2, maximumCompileErrorShare: 0.1, maximumNoCoverageShare: 0.1, retiredMutants: [], ...changes }
}

function check(entry, policyValue) { return checkMutationInventory({ ...entry, policy: policyValue }) }
function policyFor(entry, changes = {}) { return policy(entry.authority.plannedMutantIds, changes) }

test('inventory floors, operator/source coverage, and status shares fail independently', () => {
    const single = authority([['one']])
    assert.throws(() => check(single, policy([...single.authority.plannedMutantIds, ...Array.from({ length: 99 }, (_, i) => `m${i}`)])), /planned mutant count/u)
    const logical = authority([['one', 'Killed', 'Logical mutation']])
    assert.throws(() => check(logical, policyFor(logical)), /required operator/u)
    const ignored = authority([['one'], ['two', 'Ignored']])
    assert.throws(() => check(ignored, policyFor(ignored, { maximumIgnoredShare: 0 })), /Ignored share/u)
})

test('retirement exact mappings and new mutants are governed without automatic baseline writes', () => {
    const current = authority([['new']])
    const old = authority([['old']]).authority.plannedMutantIds[0]
    assert.throws(() => check(current, policy([old], { minimumPlannedMutants: 1 })), /without retirement proof/u)
    assert.equal(check(current, policy([old], { minimumPlannedMutants: 1, retiredMutants: [{ mutantId: old, reasonCode: 'source-refactor-exact-mapping', replacementMutantIds: [current.authority.plannedMutantIds[0]], proofTestIds: [] }] })).status, 'success')
    const expanded = authority([['old'], ['new']])
    assert.equal(check(expanded, policyFor(expanded, { baselineMutantIds: [expanded.authority.plannedMutantIds[0]], baselineInventoryDigest: canonicalDigest([expanded.authority.plannedMutantIds[0]]), minimumPlannedMutants: 1 })).inventory.planned, 2)
})

test('complete authority bindings are required and determine candidate identity', () => {
    const entry = authority([['one'], ['two']])
    const baseline = policyFor(entry)
    const candidate = check(entry, baseline).candidateIdentity
    for (const mutate of [
        (value) => { delete value.executedMutantIds },
        (value) => { delete value.executionMatrixDigest },
        (value) => { delete value.rawTrace },
        (value) => { value.inventory[0].status = 'Unknown' }
    ]) {
        const changed = structuredClone(entry.authority)
        mutate(changed)
        assert.throws(() => checkMutationInventory({ authority: changed, authorityInputs: entry.authorityInputs, policy: baseline }), /authority|unknown|execution|trace|terminal|duration/u)
    }
    const changedPolicy = policyFor(entry, { maximumIgnoredShare: 0.1 })
    assert.notEqual(candidate, check(entry, changedPolicy).candidateIdentity)
})
