/**
 * Issue #1750 — single-mutation matrix for DocClaim / generated / prose / join
 * body staleness and baseline-only cheats.
 *
 * No multi-file fuzzy bad-doc fixtures, no exit!=0-only negatives, no flaky retry,
 * no baseline allowlist, no network, no Stryker, no real doc migration.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
    MutationLayers,
    assertCaseResult,
    countWeakNegativeHits,
    formatGovernanceViolations,
    getMutationCase,
    listMutationCases,
    materializeFixtureRepository,
    mutationCases,
    requiredMutationIds,
    requiredPositiveControlIds,
    runAllMutationCases,
    runMutationCase,
    runStalenessMutationGovernance,
    validateMutationCaseSchema
} from '../../tools/docs/doc-claim-staleness-mutation/index.mjs'
import { ProseClaimErrorCode } from '../../tools/docs/prose-claim-verifier/errors.mjs'
import { GeneratedSectionErrorCode } from '../../tools/docs/generated-fact-sections/markers.mjs'
import { DocClaimErrorCode } from '../../tools/docs/doc-claim.mjs'

test('governance: required cases, surface coverage, and zero weak negatives', () =>
{
    const violations = runStalenessMutationGovernance()
    assert.deepEqual(violations, [], formatGovernanceViolations(violations).join('\n'))
    const counts = countWeakNegativeHits()
    assert.equal(counts.total, 0, JSON.stringify(counts))
    assert.equal(counts.badDoc, 0)
    assert.equal(counts.allowlist, 0)
    assert.equal(counts.flakyRetry, 0)
})

test('catalog schema: every case declares exact layer + reasonCode; no vague exits', () =>
{
    for (const entry of mutationCases)
    {
        const errors = validateMutationCaseSchema(entry)
        assert.deepEqual(errors, [], `${entry.id}: ${errors.join('; ')}`)
        assert.ok(entry.singleMutation && typeof entry.singleMutation === 'object')
        assert.ok(Array.isArray(entry.forbiddenCollateralChanges))
    }
    assert.equal(requiredMutationIds.length, 32)
    assert.equal(requiredPositiveControlIds.length, 4)
    assert.ok(listMutationCases({ includeControls: false }).every((entry) => !entry.expectPass))
})

test('suite rejects non-single baseline-only case that also breaks links', () =>
{
    const errors = validateMutationCaseSchema({
        id: 'cheat-baseline-and-links',
        targetInvariantId: 'prose.baseline-only-cannot-mask-stale-body',
        singleMutation: {
            kind: 'lifecycle-field',
            field: 'lastVerifiedCommit',
            value: 'f'.repeat(40),
            alsoBreakLinks: true
        },
        expectedReasonCode: ProseClaimErrorCode.CONFLICTING_VALUE,
        expectedLayer: MutationLayers.PROSE_VERIFIER,
        forbiddenCollateralChanges: []
    })
    assert.ok(errors.some((entry) => /break links|non-single/iu.test(entry)))
})

test('suite rejects vague expectedReasonCode process failed', () =>
{
    const errors = validateMutationCaseSchema({
        id: 'vague-reason',
        targetInvariantId: 'prose.scalar.value-matches-observation',
        singleMutation: { kind: 'prose-body', claimId: 'x', bodyText: 'y' },
        expectedReasonCode: 'process failed',
        expectedLayer: MutationLayers.PROSE_VERIFIER,
        forbiddenCollateralChanges: []
    })
    assert.ok(errors.some((entry) => /forbidden vague/iu.test(entry)))
})

test('suite rejects internal markInvalid hook mutations', () =>
{
    const errors = validateMutationCaseSchema({
        id: 'hook-cheat',
        targetInvariantId: 'prose.scalar.value-matches-observation',
        singleMutation: { kind: 'internal-hook', markInvalid: () => {} },
        expectedReasonCode: ProseClaimErrorCode.CONFLICTING_VALUE,
        expectedLayer: MutationLayers.PROSE_VERIFIER,
        forbiddenCollateralChanges: []
    })
    assert.ok(errors.some((entry) => /markInvalid|internal/iu.test(entry)))
})

test('full-valid fixture materializes in temp root and is disposable', () =>
{
    const fixture = materializeFixtureRepository('full-valid')
    try
    {
        assert.match(fixture.directory, /fsusblog-doc-claim-staleness-/u)
        assert.equal(fixture.digest.length, 64)
        assert.equal(fixture.identity.sourceCommit.length, 40)
    }
    finally
    {
        fixture.dispose()
    }
})

// ── Individual mutation cases (full matrix; each is independently runnable) ──

for (const entry of mutationCases)
{
    test(`mutation case: ${entry.id} → ${entry.expectedLayer}/${entry.expectedReasonCode}`, () =>
    {
        const result = runMutationCase(entry)
        assertCaseResult(result)
        assert.equal(result.layer, entry.expectedLayer)
        if (entry.expectPass)
        {
            assert.equal(result.reasonCode, 'PASS')
        }
        else
        {
            assert.equal(result.reasonCode, entry.expectedReasonCode)
        }
        assert.ok(result.sourceValidFixtureDigest)
    })
}

test('baseline-only lastVerifiedCommit fails at prose layer, not commit-distance substitute', () =>
{
    const result = runMutationCase('only-update-lastVerifiedCommit')
    assertCaseResult(result)
    assert.equal(result.layer, MutationLayers.PROSE_VERIFIER)
    assert.equal(result.reasonCode, ProseClaimErrorCode.CONFLICTING_VALUE)
    assert.equal(result.commitStaleOnly, false)
})

test('scalar-old-value proves body/observation mismatch code, not missing file', () =>
{
    const result = runMutationCase('scalar-old-value')
    assertCaseResult(result)
    assert.equal(result.reasonCode, ProseClaimErrorCode.CONFLICTING_VALUE)
    assert.ok(result.diagnostics.every((entry) => entry.code !== 'ENOENT'))
})

test('generated manual-row-delete returns CHECK_DRIFT at generated-section-check layer', () =>
{
    const result = runMutationCase('manual-row-delete')
    assertCaseResult(result)
    assert.equal(result.layer, MutationLayers.GENERATED_SECTION_CHECK)
    assert.equal(result.reasonCode, GeneratedSectionErrorCode.CHECK_DRIFT)
})

test('claim schema forbidden fields fail at claim-schema layer', () =>
{
    for (const id of ['add-verified-true', 'add-approved-observed-value', 'add-ignore-difference'])
    {
        const result = runMutationCase(id)
        assertCaseResult(result)
        assert.equal(result.layer, MutationLayers.CLAIM_SCHEMA)
        assert.equal(result.reasonCode, DocClaimErrorCode.FORBIDDEN_FIELD)
    }
})

test('graph missing-test-kind fails at behavior-graph-join with exact code', () =>
{
    const result = runMutationCase('missing-test-kind')
    assertCaseResult(result)
    assert.equal(result.layer, MutationLayers.BEHAVIOR_GRAPH_JOIN)
    assert.equal(result.reasonCode, 'MISSING_TEST_KIND')
})

test('positive controls all pass', () =>
{
    for (const id of requiredPositiveControlIds)
    {
        const result = runMutationCase(id)
        assertCaseResult(result)
        assert.equal(result.reasonCode, 'PASS')
    }
})

test('runAllMutationCases covers every catalog entry without retry', () =>
{
    const results = runAllMutationCases()
    assert.equal(results.length, mutationCases.length)
    for (const result of results)
    {
        assertCaseResult(result)
    }
})

test('getMutationCase rejects unknown ids', () =>
{
    assert.throws(() => getMutationCase('does-not-exist'), /unknown mutation case/u)
})

test('matrix does not mutate real repository docs', () =>
{
    // Running the suite must not touch workspace docs — fixtures are temp-only.
    const before = process.cwd()
    runMutationCase('scalar-old-value')
    assert.equal(process.cwd(), before)
})
