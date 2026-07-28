import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
    createChangedCriticalStrykerConfig,
    selectChangedCriticalMutation,
    validateToolPolicy
} from '../../tools/test/changed-critical-mutation.mjs'
import {
    attributeMutantsToBehaviors,
    qualifyBehaviorMutations
} from '../../tools/test/changed-critical-mutation-attribution.mjs'
import {
    sealMutationEvidenceReceipt
} from '../../tools/test/mutation-evidence-receipt.mjs'
import {
    executeChangedCriticalSelection
} from '../../tools/test/run-changed-critical-mutation.mjs'

const rawToolPolicy = readFileSync(
    new URL('../../config/testing/mutation/changed-critical-domains.v1.json', import.meta.url)
)
const toolPolicy = JSON.parse(rawToolPolicy)

const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
}

// Fixture: behavior catalog with mutationPolicy
function makeBehaviorCatalog() {
    return {
        schema: 'fsusblog.behavior-contract-catalog.v1',
        digest: 'c'.repeat(64),
        contracts: [
            {
                id: 'authentication-session-permission',
                domain: 'security',
                risk: 'critical',
                status: 'active',
                mutationPolicy: {
                    mutationRequired: true,
                    minimumMutationScore: 70,
                    requireExecutedMutants: true,
                    allowedEquivalentMutantPolicy: 'none'
                }
            },
            {
                id: 'binary-api-aeds-contract',
                domain: 'api',
                risk: 'critical',
                status: 'active',
                mutationPolicy: {
                    mutationRequired: true,
                    minimumMutationScore: 70,
                    requireExecutedMutants: true,
                    allowedEquivalentMutantPolicy: 'none'
                }
            },
            {
                id: 'code-intent-governance',
                domain: 'governance',
                risk: 'high',
                status: 'active'
                // No mutationPolicy — not mutation-required
            }
        ]
    }
}

// Fixture: owner receipt with bindings
function makeOwnerReceipt() {
    return {
        schema: 'fsusblog.behavior-owner-binding-receipt.v1',
        contentDigest: 'd'.repeat(64),
        bindings: [
            {
                behaviorId: 'authentication-session-permission',
                language: 'csharp',
                sourcePath: 'src/backend/Infrastructure/Auth/AccountSubjectHasher.cs',
                symbol: 'AccountSubjectHasher',
                bindingKind: 'attribute',
                status: 'ok'
            },
            {
                behaviorId: 'binary-api-aeds-contract',
                language: 'csharp',
                sourcePath: 'src/core/Integrity/ArticleRightsCanonicalHashV1.cs',
                symbol: 'ArticleRightsCanonicalHashV1',
                bindingKind: 'attribute',
                status: 'ok'
            },
            {
                behaviorId: 'code-intent-governance',
                language: 'javascript',
                sourcePath: 'tools/governance/check-code-intent.mjs',
                symbol: 'checkCodeIntent',
                bindingKind: 'marker',
                status: 'ok'
            }
        ],
        errors: []
    }
}

// Fixture: test binding scan
function makeTestBindingScan() {
    return {
        catalogDigest: 'c'.repeat(64),
        bindings: [
            {
                behaviorId: 'authentication-session-permission',
                testKind: 'positive',
                fullyQualifiedName: 'AccountSubjectHasherMutationTests.Run',
                canonicalTestId: 'xunit-trx:AccountSubjectHasherMutationTests#Run'
            },
            {
                behaviorId: 'authentication-session-permission',
                testKind: 'negative',
                fullyQualifiedName: 'AuthCookieServiceSecurityTests.RejectsExpired',
                canonicalTestId: 'xunit-trx:AuthCookieServiceSecurityTests#RejectsExpired'
            },
            {
                behaviorId: 'binary-api-aeds-contract',
                testKind: 'positive',
                fullyQualifiedName: 'ArticleRightsCanonicalHashTests.Run',
                canonicalTestId: 'xunit-trx:ArticleRightsCanonicalHashTests#Run'
            },
            {
                behaviorId: 'code-intent-governance',
                testKind: 'positive',
                fullyQualifiedName: 'CodeIntentTests.Valid',
                canonicalTestId: 'node-tap:tests/tools/code-intent.test.mjs#valid'
            }
        ]
    }
}

function select(changedPaths) {
    return selectChangedCriticalMutation({
        toolPolicy,
        rawToolPolicy,
        changedPaths,
        sourceState,
        ownerReceipt: makeOwnerReceipt(),
        behaviorCatalog: makeBehaviorCatalog(),
        testBindingScan: makeTestBindingScan()
    })
}

test('tool policy validates schema v2 and rejects old v1 catalog', () => {
    assert.doesNotThrow(() => validateToolPolicy(toolPolicy))
    assert.throws(
        () => validateToolPolicy({ schema: 'fsusblog.changed-critical-mutation-catalog.v1', version: 1 }),
        /schema v2/u
    )
})

test('single-behavior change selects only its owner mutate file and binding-derived test filter', () => {
    const selection = select(['src/core/Integrity/ArticleRightsCanonicalHashV1.cs'])

    assert.equal(selection.status, 'selected')
    assert.equal(selection.behaviors.length, 1)
    assert.equal(selection.behaviors[0].behaviorId, 'binary-api-aeds-contract')
    assert.deepEqual(selection.mutateFiles, ['src/core/Integrity/ArticleRightsCanonicalHashV1.cs'])
    assert.match(selection.testFilter, /ArticleRightsCanonicalHashTests/u)
    assert.doesNotMatch(selection.testFilter, /AccountSubjectHasher/u)
})

test('cross-behavior selection is deterministic and de-duplicated', () => {
    const forward = select([
        'src/backend/Infrastructure/Auth/AccountSubjectHasher.cs',
        'src/core/Integrity/ArticleRightsCanonicalHashV1.cs'
    ])
    const reverse = select([
        'src/core/Integrity/ArticleRightsCanonicalHashV1.cs',
        'src/backend/Infrastructure/Auth/AccountSubjectHasher.cs'
    ])

    assert.equal(forward.closureDigest, reverse.closureDigest)
    assert.equal(forward.behaviors.length, 2)
    assert.deepEqual(forward.behaviors.map((b) => b.behaviorId), [
        'authentication-session-permission',
        'binary-api-aeds-contract'
    ])
})

test('non-mutation-required behavior change produces empty selection', () => {
    const selection = select(['tools/governance/check-code-intent.mjs'])
    assert.equal(selection.status, 'empty')
    assert.deepEqual(selection.behaviors, [])
    assert.deepEqual(selection.mutateFiles, [])
})

test('unrelated changes produce empty selection and never start Stryker', () => {
    const selection = select(['docs/testing.md', 'src/frontend/src/App.vue'])
    let starts = 0
    const run = executeChangedCriticalSelection({
        selection,
        spawnStryker: () => { starts += 1; return { status: 0 } }
    })

    assert.equal(selection.status, 'empty')
    assert.equal(run.status, 'empty')
    assert.equal(run.strykerStarted, false)
    assert.equal(starts, 0)
})

test('generated config uses binding-derived test filter and owner-derived mutate files', () => {
    const selection = select(['src/core/Integrity/ArticleRightsCanonicalHashV1.cs'])
    const generated = createChangedCriticalStrykerConfig(selection, toolPolicy)

    assert.deepEqual(generated['stryker-config']['test-projects'], ['../../tests/backend/FsusBlog.Server.Tests.csproj'])
    assert.deepEqual(generated['stryker-config'].mutate, ['Integrity/ArticleRightsCanonicalHashV1.cs'])
    assert.match(generated['stryker-config']['test-case-filter'], /ArticleRightsCanonicalHashTests/u)
    assert.deepEqual(generated['stryker-config'].thresholds, { high: 85, low: 70, break: 70 })
    assert.equal(generated['stryker-config']['break-on-initial-test-failure'], true)
})

test('mutant attribution maps each mutant to unique behavior via owner receipt', () => {
    const selection = select(['src/core/Integrity/ArticleRightsCanonicalHashV1.cs'])
    const report = {
        files: {
            'src/core/Integrity/ArticleRightsCanonicalHashV1.cs': {
                language: 'cs',
                mutants: [
                    { id: '1', status: 'Killed', mutatorName: 'Arithmetic', coveredBy: ['t1'], killedBy: ['t1'] },
                    { id: '2', status: 'Survived', mutatorName: 'Boolean', coveredBy: ['t1'], killedBy: [] }
                ]
            }
        }
    }
    const { attributions, blocked } = attributeMutantsToBehaviors({
        report,
        sourceProject: 'src/core',
        ownerReceipt: makeOwnerReceipt(),
        selection
    })

    assert.equal(attributions.length, 2)
    assert.equal(blocked.length, 0)
    assert.equal(attributions[0].behaviorId, 'binary-api-aeds-contract')
    assert.equal(attributions[0].symbol, 'ArticleRightsCanonicalHashV1')
    assert.equal(attributions[0].mutator, 'Arithmetic')
    assert.equal(attributions[0].status, 'Killed')
    assert.deepEqual(attributions[0].killedTestIds, ['t1'])
    assert.equal(attributions[1].status, 'Survived')
})

test('ambiguous multi-owner file reports blocked mutants', () => {
    const ownerReceipt = {
        bindings: [
            { behaviorId: 'authentication-session-permission', sourcePath: 'src/backend/Shared.cs', symbol: 'SharedA', status: 'ok' },
            { behaviorId: 'binary-api-aeds-contract', sourcePath: 'src/backend/Shared.cs', symbol: 'SharedB', status: 'ok' }
        ]
    }
    const selection = {
        behaviors: [
            { behaviorId: 'authentication-session-permission' },
            { behaviorId: 'binary-api-aeds-contract' }
        ]
    }
    const report = {
        files: {
            'src/backend/Shared.cs': {
                mutants: [{ id: '1', status: 'Killed', mutatorName: 'Arithmetic', coveredBy: [], killedBy: [] }]
            }
        }
    }
    const { attributions, blocked } = attributeMutantsToBehaviors({
        report,
        sourceProject: 'src/backend',
        ownerReceipt,
        selection
    })

    assert.equal(attributions.length, 0)
    assert.equal(blocked.length, 1)
    assert.equal(blocked[0].reason, 'ambiguous-owner-boundary')
})

test('per-behavior qualification fails on survived mutants regardless of domain score', () => {
    const attributions = [
        { mutantId: 'm1', behaviorId: 'binary-api-aeds-contract', status: 'Killed', sourcePath: 'a.cs', symbol: 'A', mutator: 'Arith', coveredTestIds: ['t1'], killedTestIds: ['t1'] },
        { mutantId: 'm2', behaviorId: 'binary-api-aeds-contract', status: 'Killed', sourcePath: 'a.cs', symbol: 'A', mutator: 'Arith', coveredTestIds: ['t1'], killedTestIds: ['t1'] },
        { mutantId: 'm3', behaviorId: 'binary-api-aeds-contract', status: 'Survived', sourcePath: 'a.cs', symbol: 'A', mutator: 'Bool', coveredTestIds: ['t1'], killedTestIds: [] },
        { mutantId: 'm4', behaviorId: 'authentication-session-permission', status: 'Killed', sourcePath: 'b.cs', symbol: 'B', mutator: 'Arith', coveredTestIds: ['t2'], killedTestIds: ['t2'] }
    ]
    const { qualifications, failed } = qualifyBehaviorMutations({
        attributions,
        blocked: [],
        behaviorCatalog: makeBehaviorCatalog()
    })

    assert.equal(failed, true)
    const aeds = qualifications.find((q) => q.behaviorId === 'binary-api-aeds-contract')
    const auth = qualifications.find((q) => q.behaviorId === 'authentication-session-permission')
    assert.equal(aeds.qualified, false)
    assert.equal(aeds.survived, 1)
    assert.ok(aeds.failures.some((f) => /survived/u.test(f)))
    assert.equal(auth.qualified, true)
})

test('mutation evidence receipt seals and validates', () => {
    const receipt = sealMutationEvidenceReceipt({
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64),
        catalogDigest: 'c'.repeat(64),
        selectionDigest: 'e'.repeat(64),
        ownerReceiptDigest: 'f'.repeat(64),
        testBindingScanDigest: '1'.repeat(64),
        rawReportDigest: '2'.repeat(64),
        rawTraceDigest: '3'.repeat(64),
        attributions: [
            { mutantId: 'm1', behaviorId: 'binary-api-aeds-contract', sourcePath: 'a.cs', symbol: 'A', mutator: 'Arith', status: 'Killed', coveredTestIds: ['t1'], killedTestIds: ['t1'] }
        ],
        qualifications: [
            { behaviorId: 'binary-api-aeds-contract', mutationRequired: true, executed: 1, killed: 1, survived: 0, timeout: 0, noCoverage: 0, score: 100, minimumMutationScore: 70, qualified: true, failures: [] }
        ],
        blockedCount: 0,
        status: 'ok',
        failureReasons: []
    })

    assert.equal(receipt.schema, 'fsusblog.mutation-evidence-receipt.v1')
    assert.match(receipt.contentDigest, /^[a-f0-9]{64}$/u)
    assert.equal(receipt.status, 'ok')
    assert.equal(receipt.attributions.length, 1)
    assert.equal(receipt.qualifications[0].qualified, true)
})

test('checked-in nightly and fixed release mutation lanes remain present', () => {
    const matrix = readFileSync(new URL('../matrix.yml', import.meta.url), 'utf8')
    const defaults = JSON.parse(readFileSync(
        new URL('../../config/testing/mutation/default.json', import.meta.url), 'utf8'
    ))
    const critical = JSON.parse(readFileSync(
        new URL('../../config/testing/mutation/critical.json', import.meta.url), 'utf8'
    ))

    assert.match(matrix, /- id: backend-mutation\n/u)
    assert.match(matrix, /- id: release-mutation-critical-slice\n/u)
    assert.ok(defaults['stryker-config'].mutate.length > 1)
    assert.deepEqual(critical['stryker-config'].mutate, ['Algorithms/AedsEncoder.cs'])
})
