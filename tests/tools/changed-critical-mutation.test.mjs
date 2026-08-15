import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
    attributeMutantsToBehaviors,
    qualifyBehaviorMutations
} from '../../tools/test/changed-critical-mutation-attribution.mjs';
import {
    createChangedCriticalStrykerConfig,
    selectChangedCriticalMutation,
    validateToolPolicy
} from '../../tools/test/changed-critical-mutation.mjs';
import {
    sealMutationEvidenceReceipt
} from '../../tools/test/mutation-evidence-receipt.mjs';
import {
    executeChangedCriticalSelection,
    isolateReviewedMutationRegions,
    prepareChangedCriticalMutationSandbox,
    verifyChangedCriticalMutationTrace
} from '../../tools/test/run-changed-critical-mutation.mjs';

const rawToolPolicy = readFileSync(
    new URL('../../config/testing/mutation/changed-critical-domains.v1.json', import.meta.url)
);
const toolPolicy = JSON.parse(rawToolPolicy);

const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
};

// Fixture: behavior catalog with mutationPolicy
function makeBehaviorCatalog()
{
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
    };
}

// Fixture: owner receipt with bindings
function makeOwnerReceipt()
{
    return {
        schema: 'fsusblog.behavior-owner-binding-receipt.v1',
        contentDigest: 'd'.repeat(64),
        bindings: [
            {
                behaviorId: 'authentication-session-permission',
                language: 'csharp',
                sourcePath: 'src/backend/Infrastructure/Auth/AccountSubjectHasher.cs',
                symbol: 'AccountSubjectHasher',
                bindingKind: 'reviewed-runtime-kernel',
                mutationScope: { kind: 'whole-file' },
                mutationPattern: 'src/backend/Infrastructure/Auth/AccountSubjectHasher.cs',
                status: 'ok'
            },
            {
                behaviorId: 'binary-api-aeds-contract',
                language: 'csharp',
                sourcePath: 'src/core/Integrity/ArticleRightsCanonicalHashV1.cs',
                symbol: 'ArticleRightsCanonicalHashV1',
                bindingKind: 'reviewed-runtime-kernel',
                mutationScope: { kind: 'whole-file' },
                mutationPattern: 'src/core/Integrity/ArticleRightsCanonicalHashV1.cs',
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
    };
}

// Fixture: test binding scan
function makeTestBindingScan()
{
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
    };
}

function select(changedPaths)
{
    return selectChangedCriticalMutation({
        toolPolicy,
        rawToolPolicy,
        changedPaths,
        sourceState,
        ownerReceipt: makeOwnerReceipt(),
        behaviorCatalog: makeBehaviorCatalog(),
        testBindingScan: makeTestBindingScan()
    });
}

test('tool policy validates schema v3 and rejects the retired v2 catalog', () =>
{
    assert.doesNotThrow(() => validateToolPolicy(toolPolicy));
    assert.throws(() => validateToolPolicy({
        ...toolPolicy,
        schema: 'fsusblog.changed-critical-mutation-tool-policy.v2',
        version: 2
    }), /schema v3/u);
    assert.throws(() => validateToolPolicy({
        ...toolPolicy,
        defaults: { ...toolPolicy.defaults, coverageAnalysis: 'perTest' }
    }), /perTestInIsolation coverageAnalysis/u);
});

test('single-behavior change selects only its owner mutate file and binding-derived test filter', () =>
{
    const selection = select(['src/core/Integrity/ArticleRightsCanonicalHashV1.cs']);

    assert.equal(selection.status, 'selected');
    assert.equal(selection.behaviors.length, 1);
    assert.equal(selection.behaviors[0].behaviorId, 'binary-api-aeds-contract');
    assert.deepEqual(selection.mutateFiles, ['src/core/Integrity/ArticleRightsCanonicalHashV1.cs']);
    assert.match(selection.testFilter, /ArticleRightsCanonicalHashTests/u);
    assert.doesNotMatch(selection.testFilter, /AccountSubjectHasher/u);
});

test('cross-behavior selection is deterministic and de-duplicated', () =>
{
    const forward = select([
        'src/backend/Infrastructure/Auth/AccountSubjectHasher.cs',
        'src/core/Integrity/ArticleRightsCanonicalHashV1.cs'
    ]);
    const reverse = select([
        'src/core/Integrity/ArticleRightsCanonicalHashV1.cs',
        'src/backend/Infrastructure/Auth/AccountSubjectHasher.cs'
    ]);

    assert.equal(forward.closureDigest, reverse.closureDigest);
    assert.equal(forward.behaviors.length, 2);
    assert.deepEqual(forward.behaviors.map((b) => b.behaviorId), [
        'authentication-session-permission',
        'binary-api-aeds-contract'
    ]);
});

test('same-project behaviors become separate binding-derived execution closures', () =>
{
    const ownerReceipt = makeOwnerReceipt();
    ownerReceipt.bindings = ownerReceipt.bindings.map((binding) =>
        binding.behaviorId === 'binary-api-aeds-contract'
            ? {
                ...binding,
                sourcePath: 'src/backend/Infrastructure/Binary/BinaryEnvelopePolicy.cs',
                symbol: 'BinaryEnvelopePolicy',
                mutationPattern: 'src/backend/Infrastructure/Binary/BinaryEnvelopePolicy.cs'
            }
            : binding);
    const selection = selectChangedCriticalMutation({
        toolPolicy,
        rawToolPolicy,
        changedPaths: [
            'src/backend/Infrastructure/Auth/AccountSubjectHasher.cs',
            'src/backend/Infrastructure/Binary/BinaryEnvelopePolicy.cs'
        ],
        sourceState,
        ownerReceipt,
        behaviorCatalog: makeBehaviorCatalog(),
        testBindingScan: makeTestBindingScan()
    });

    assert.deepEqual(
        selection.executionClosures.map(({ runKey, sourceProject, mutateFiles, testFilters }) => ({
            runKey,
            sourceProject,
            mutateFiles,
            testFilters
        })),
        [
            {
                runKey: 'authentication-session-permission--src-backend',
                sourceProject: 'src/backend',
                mutateFiles: ['Infrastructure/Auth/AccountSubjectHasher.cs'],
                testFilters: ['AccountSubjectHasherMutationTests', 'AuthCookieServiceSecurityTests']
            },
            {
                runKey: 'binary-api-aeds-contract--src-backend',
                sourceProject: 'src/backend',
                mutateFiles: ['Infrastructure/Binary/BinaryEnvelopePolicy.cs'],
                testFilters: ['ArticleRightsCanonicalHashTests']
            }
        ]
    );
});

test('non-mutation-required behavior change produces empty selection', () =>
{
    const selection = select(['tools/governance/check-code-intent.mjs']);
    assert.equal(selection.status, 'empty');
    assert.deepEqual(selection.behaviors, []);
    assert.deepEqual(selection.mutateFiles, []);
});

test('unrelated changes produce empty selection and never start Stryker', () =>
{
    const selection = select(['README.md', 'src/frontend/src/App.vue']);
    let starts = 0;
    const run = executeChangedCriticalSelection({
        selection,
        spawnStryker: () =>
        {
            starts += 1;
            return { status: 0 };
        }
    });

    assert.equal(selection.status, 'empty');
    assert.equal(run.status, 'empty');
    assert.equal(run.strykerStarted, false);
    assert.equal(starts, 0);
});

test('docs-only/binding/catalog change triggers the full required behavior closure (never skips)', () =>
{
    const selection = select(['docs/testing.md']);

    assert.equal(selection.status, 'selected');
    assert.equal(selection.scope, 'pr');
    assert.deepEqual(selection.behaviors.map((b) => b.behaviorId), [
        'authentication-session-permission',
        'binary-api-aeds-contract'
    ]);
    assert.ok(selection.reasons.some((reason) => reason.startsWith('governance-change:')));
    assert.deepEqual(selection.mutateFiles, [
        'src/backend/Infrastructure/Auth/AccountSubjectHasher.cs',
        'src/core/Integrity/ArticleRightsCanonicalHashV1.cs'
    ]);
});

test('binding/catalog config change triggers the full required behavior closure', () =>
{
    const selection = select(['config/contracts/behavior-contracts.json']);

    assert.equal(selection.status, 'selected');
    assert.deepEqual(selection.behaviors.map((b) => b.behaviorId), [
        'authentication-session-permission',
        'binary-api-aeds-contract'
    ]);
});

test('generated config uses binding-derived test filter and owner-derived mutate files', () =>
{
    const selection = select(['src/core/Integrity/ArticleRightsCanonicalHashV1.cs']);
    const generated = createChangedCriticalStrykerConfig(selection, toolPolicy);

    assert.deepEqual(generated['stryker-config']['test-projects'], ['../../tests/backend/FsusBlog.Server.Tests.csproj']);
    assert.deepEqual(generated['stryker-config'].mutate, ['Integrity/ArticleRightsCanonicalHashV1.cs']);
    assert.match(generated['stryker-config']['test-case-filter'], /ArticleRightsCanonicalHashTests/u);
    assert.equal(generated['stryker-config']['coverage-analysis'], 'perTestInIsolation');
    assert.deepEqual(generated['stryker-config'].thresholds, { high: 85, low: 70, break: 70 });
    assert.equal(generated['stryker-config']['break-on-initial-test-failure'], true);
    assert.equal(generated['stryker-config'].concurrency, 1);
});

test('tool policy requires one canonical positive Stryker runner count', () =>
{
    assert.deepEqual(toolPolicy.executionLimits, {
        maxConcurrentTestRunners: 1
    });
    assert.throws(
        () => validateToolPolicy({
            ...toolPolicy,
            executionLimits: {
                ...toolPolicy.executionLimits,
                maxConcurrentTestRunners: 0
            }
        }),
        /maxConcurrentTestRunners must be a positive integer/u
    );
    assert.throws(
        () => validateToolPolicy({
            ...toolPolicy,
            executionLimits: {
                ...toolPolicy.executionLimits,
                timeoutMs: 600_000
            }
        }),
        /execution limits must use only maxConcurrentTestRunners/u
    );
});

test('physical mutation sandbox preserves selected inputs and marks only non-selected C# as generated', () =>
{
    const repository = mkdtempSync(resolve(tmpdir(), 'fsusblog-mutation-sandbox-test-'));
    let sandbox;
    try
    {
        mkdirSync(resolve(repository, 'src/backend'), { recursive: true });
        writeFileSync(resolve(repository, 'src/backend/Selected.cs'), 'class Selected {}\n');
        writeFileSync(resolve(repository, 'src/backend/Other.cs'), 'class Other {}\n');
        for (const args of [
            ['init', '-q'],
            ['config', 'user.email', 'test@example.invalid'],
            ['config', 'user.name', 'Test'],
            ['add', '.'],
            ['commit', '-qm', 'fixture']
        ])
        {
            const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
        }
        const commit = spawnSync(
            'git',
            ['rev-parse', 'HEAD'],
            { cwd: repository, encoding: 'utf8' }
        ).stdout.trim();
        writeFileSync(
            resolve(repository, 'src/backend/Selected.cs'),
            'class Selected { int Current => 1; }\n'
        );
        writeFileSync(resolve(repository, 'src/backend/Untracked.cs'), 'class Untracked {}\n');

        sandbox = prepareChangedCriticalMutationSandbox({
            root: repository,
            sourceState: {
                commit,
                worktreeFingerprint: 'a'.repeat(64)
            },
            sourceProject: 'src/backend',
            mutateTargets: [
                {
                    sourcePath: 'Selected.cs',
                    mutationScope: { kind: 'whole-file' }
                },
                {
                    sourcePath: 'Untracked.cs',
                    mutationScope: { kind: 'whole-file' }
                }
            ]
        });

        assert.equal(
            readFileSync(resolve(sandbox.projectRoot, 'Selected.cs'), 'utf8'),
            'class Selected { int Current => 1; }\n'
        );
        assert.equal(
            readFileSync(resolve(sandbox.projectRoot, 'Untracked.cs'), 'utf8'),
            'class Untracked {}\n'
        );
        assert.match(
            readFileSync(resolve(sandbox.projectRoot, 'Other.cs'), 'utf8'),
            /^\/\/ <auto-generated \/>\n#nullable enable\nclass Other \{\}/u
        );
        assert.deepEqual(sandbox.selected, ['Selected.cs', 'Untracked.cs']);
        assert.deepEqual(sandbox.suppressed, ['Other.cs']);
    }
    finally
    {
        if (sandbox)
        {
            rmSync(sandbox.root, { recursive: true, force: true });
        }
        rmSync(repository, { recursive: true, force: true });
    }
});

test('regional sandbox isolation preserves line numbers and disables unreviewed instrumentation', () =>
{
    const source = [
        'using System;',
        'using System.Collections.Generic;',
        '',
        'namespace Example;',
        '',
        'internal sealed class Sample',
        '{',
        '',
        '    internal int First(bool enabled)',
        '        => enabled ? 1 : 0;',
        '',
        '    private int Unreviewed() => 2;',
        '',
        '    internal int Second() => 3;',
        '',
        '}',
        ''
    ].join('\n');
    const isolated = isolateReviewedMutationRegions(
        source,
        'Sample.cs',
        {
            kind: 'line-regions',
            regions: [
                { startLine: 9, endLineExclusive: 12 },
                { startLine: 14, endLineExclusive: 16 }
            ]
        }
    );
    const lines = isolated.source.split('\n');

    assert.equal(isolated.source.split('\n').length, source.split('\n').length);
    assert.equal(lines[0], '// Stryker disable all: outside reviewed runtime kernel');
    assert.equal(lines[2], 'using System;');
    assert.equal(lines[7], '    // Stryker restore all: reviewed runtime kernel begins');
    assert.equal(lines[10], '    // Stryker disable all: reviewed runtime kernel ends');
    assert.equal(lines[12], '    // Stryker restore all: reviewed runtime kernel begins');
    assert.equal(lines[14], '    // Stryker disable all: reviewed runtime kernel ends');
    assert.equal(lines[11], '    private int Unreviewed() => 2;');
    assert.deepEqual(isolated.directiveLines, [1, 8, 11, 13, 15]);
});

test('regional sandbox isolation fails closed without blank boundary guards', () =>
{
    assert.throws(
        () => isolateReviewedMutationRegions(
            'using System;\nnamespace Example;\ninternal int Value => 1;\n',
            'Sample.cs',
            {
                kind: 'line-regions',
                regions: [{ startLine: 3, endLineExclusive: 4 }]
            }
        ),
        /blank pre-namespace guard line|blank guard before line/u
    );
});

test('physical trace must prove the exact owner-derived mutation file closure', () =>
{
    const projectRoot = '/tmp/physical-scope/src/backend';
    const rawTrace = Buffer.from(
        '2026-01-01 [DBG] Mutating "/tmp/physical-scope/src/backend/B.cs"\n'
        + '2026-01-01 [DBG] Mutating "/tmp/physical-scope/src/backend/A.cs"\n'
    );
    assert.deepEqual(
        verifyChangedCriticalMutationTrace({
            rawTrace,
            sandboxProjectRoot: projectRoot,
            mutateFiles: ['A.cs', 'B.cs']
        }),
        ['A.cs', 'B.cs']
    );
    assert.throws(
        () => verifyChangedCriticalMutationTrace({
            rawTrace: Buffer.from(
                `${rawTrace}2026-01-01 [DBG] Mutating "/tmp/physical-scope/src/backend/Outside.cs"\n`
            ),
            sandboxProjectRoot: projectRoot,
            mutateFiles: ['A.cs', 'B.cs']
        }),
        /physical mutation scope did not match/u
    );
});

test('mutant attribution maps each mutant to unique behavior via owner receipt', () =>
{
    const selection = select(['src/core/Integrity/ArticleRightsCanonicalHashV1.cs']);
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
    };
    const { attributions, blocked } = attributeMutantsToBehaviors({
        report,
        sourceProject: 'src/core',
        ownerReceipt: makeOwnerReceipt(),
        selection
    });

    assert.equal(attributions.length, 2);
    assert.equal(blocked.length, 0);
    assert.equal(attributions[0].behaviorId, 'binary-api-aeds-contract');
    assert.equal(attributions[0].symbol, 'ArticleRightsCanonicalHashV1');
    assert.equal(attributions[0].mutator, 'Arithmetic');
    assert.equal(attributions[0].status, 'Killed');
    assert.deepEqual(attributions[0].killedTestIds, ['t1']);
    assert.equal(attributions[1].status, 'Survived');
});

test('ambiguous multi-owner file reports blocked mutants', () =>
{
    const ownerReceipt = {
        bindings: [
            { behaviorId: 'authentication-session-permission', sourcePath: 'src/backend/Shared.cs', symbol: 'SharedA', status: 'ok' },
            { behaviorId: 'binary-api-aeds-contract', sourcePath: 'src/backend/Shared.cs', symbol: 'SharedB', status: 'ok' }
        ]
    };
    const selection = {
        behaviors: [
            { behaviorId: 'authentication-session-permission' },
            { behaviorId: 'binary-api-aeds-contract' }
        ]
    };
    const report = {
        files: {
            'src/backend/Shared.cs': {
                mutants: [{ id: '1', status: 'Killed', mutatorName: 'Arithmetic', coveredBy: [], killedBy: [] }]
            }
        }
    };
    const { attributions, blocked } = attributeMutantsToBehaviors({
        report,
        sourceProject: 'src/backend',
        ownerReceipt,
        selection
    });

    assert.equal(attributions.length, 0);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].reason, 'ambiguous-owner-boundary');
});

test('per-behavior qualification keeps survived mutants scoreable and enforces the declared threshold', () =>
{
    const attributions = [
        { mutantId: 'm1', behaviorId: 'binary-api-aeds-contract', status: 'Killed', sourcePath: 'a.cs', symbol: 'A', mutator: 'Arith', coveredTestIds: ['t1'], killedTestIds: ['t1'] },
        { mutantId: 'm2', behaviorId: 'binary-api-aeds-contract', status: 'Killed', sourcePath: 'a.cs', symbol: 'A', mutator: 'Arith', coveredTestIds: ['t1'], killedTestIds: ['t1'] },
        { mutantId: 'm3', behaviorId: 'binary-api-aeds-contract', status: 'Survived', sourcePath: 'a.cs', symbol: 'A', mutator: 'Bool', coveredTestIds: ['t1'], killedTestIds: [] },
        { mutantId: 'm4', behaviorId: 'authentication-session-permission', status: 'Killed', sourcePath: 'b.cs', symbol: 'B', mutator: 'Arith', coveredTestIds: ['t2'], killedTestIds: ['t2'] }
    ];
    const { qualifications, failed } = qualifyBehaviorMutations({
        attributions,
        blocked: [],
        behaviorCatalog: makeBehaviorCatalog()
    });

    assert.equal(failed, true);
    const aeds = qualifications.find((q) => q.behaviorId === 'binary-api-aeds-contract');
    const auth = qualifications.find((q) => q.behaviorId === 'authentication-session-permission');
    assert.equal(aeds.qualified, false);
    assert.equal(aeds.survived, 1);
    assert.ok(aeds.failures.some((f) => /mutation score 66\.67 < minimum 70/u.test(f)));
    assert.equal(auth.qualified, true);
});

test('mutation evidence receipt seals and validates', () =>
{
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
    });

    assert.equal(receipt.schema, 'fsusblog.mutation-evidence-receipt.v1');
    assert.match(receipt.contentDigest, /^[a-f0-9]{64}$/u);
    assert.equal(receipt.status, 'ok');
    assert.equal(receipt.attributions.length, 1);
    assert.equal(receipt.qualifications[0].qualified, true);
});

test('checked-in nightly and fixed release mutation lanes remain present', () =>
{
    const matrix = readFileSync(new URL('../matrix.yml', import.meta.url), 'utf8');
    const defaults = JSON.parse(readFileSync(
        new URL('../../config/testing/mutation/default.json', import.meta.url), 'utf8'
    ));
    const critical = JSON.parse(readFileSync(
        new URL('../../config/testing/mutation/critical.json', import.meta.url), 'utf8'
    ));

    assert.match(matrix, /- id: backend-mutation\n/u);
    assert.match(matrix, /- id: release-mutation-critical-slice\n/u);
    assert.ok(defaults['stryker-config'].mutate.length > 1);
    assert.deepEqual(critical['stryker-config'].mutate, ['Algorithms/AedsEncoder.cs']);
});
