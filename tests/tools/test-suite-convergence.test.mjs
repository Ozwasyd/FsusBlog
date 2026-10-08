import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    auditCompactRetentionRecords,
    auditRetentionRecords,
    buildChildIssueStatusEvidence,
    expandPathReplacementPlan,
    mergeReplacementEntries,
    scanBackendSourceLocking,
    validateReplacementChainAuthority,
    validateAfterSnapshotAuthority,
    validateChildIssueStatusEvidence,
    validateConvergencePlan,
    validateEvidenceContract,
    verifySourceLockingFixtures
} from '@fsusblog/governance-tools/test-convergence/audit';
import {
    POST_BASELINE_HISTORY_ANCHOR,
    historicalXunitMethodPresent
} from '@fsusblog/governance-tools/test-convergence/post-baseline-history';
import { parseMatrix } from '@fsusblog/governance-tools/test-matrix/parse-matrix';
import {
    compactRetentionBaseline,
    compactRetentionKey,
    decodeCompactRetentionIndex
} from '@fsusblog/governance-tools/test-retention/audit';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('#2348 canonical MFA retirement retains before identities without post-baseline self-admission', async () =>
{
    const path = 'tests/backend/Unit/BackendAuthStateMachineTests.cs';
    const sourceCommit = '865dc18c29c208d3be0dcab6442f00864e7583f2';
    const deletionCommit = '80038e83710cc9bd252aaef4c014d893d2c4bdc0';
    const sourceBlob = '5c80eb7a0183610b0b00a23fd596a7f213328242';
    const matrix = parseMatrix(readFileSync(resolve(root, 'tests/matrix.yml'), 'utf8'));
    assert.ok(!matrix.governance.retention.postBaselines.includes(
        'tests/mfa-login-continuation-retirement-baseline.json'
    ));
    assert.ok(!matrix.governance.retention.postBaselines.includes(
        'tests/auth-mfa-state-retirement-baseline.json'
    ));

    const beforeSnapshot = JSON.parse(readFileSync(resolve(root, 'tests/test-retention-before.json'), 'utf8'));
    const testKeys = decodeCompactRetentionIndex(beforeSnapshot.testIndex);
    const pathKeys = decodeCompactRetentionIndex(beforeSnapshot.pathIndex);
    const { entries, errors } = mergeReplacementEntries([{
        source: 'tests/test-retention-replacements.json',
        manifest: JSON.parse(readFileSync(resolve(root, 'tests/test-retention-replacements.json'), 'utf8'))
    }]);
    assert.deepEqual(errors, []);
    const cases = [
        ['LoginWithMfa_RequiresPartialAuthBeforeFullSession', 1, 4],
        ['IllegalTransitions_AreRejected', 8176, 5]
    ];
    const selected = cases.map(([method, position, assertionCount]) =>
    {
        const id = `xunit:${path}#FsusBlog.Server.Tests.Unit.BackendAuthStateMachineTests.${method}#case-0000`;
        const key = compactRetentionKey(id);
        assert.equal(testKeys.indexOf(key), position);
        const owner = beforeSnapshot.assertionIndex.owners.find(([testPosition]) => testPosition === position);
        assert.ok(owner);
        assert.equal(pathKeys[owner[1]], compactRetentionKey(path));
        assert.equal(owner[2].length, assertionCount);
        const entry = entries.find((candidate) => candidate.id === id);
        assert.ok(entry, id);
        assert.equal(entry.path, path);
        assert.ok(entry.replacementTestIds.length > 0);
        return entry;
    });

    const { devNull } = await import('node:os');
    const { maskCSharpTrivia } = await import(new URL('../../tools/test/csharp-source-mask.mjs', import.meta.url));
    const git = (args) => execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull }
    });
    assert.equal(git(['rev-list', '--parents', '-n', '1', deletionCommit]).trim(),
        `${deletionCommit} ${sourceCommit}`);
    assert.equal(git(['ls-tree', '-z', sourceCommit, '--', path]),
        `100644 blob ${sourceBlob}\t${path}\0`);
    assert.equal(git(['ls-tree', '-z', deletionCommit, '--', path]), '');
    const source = git(['show', `${sourceCommit}:${path}`]);
    for (const [method] of cases)
    {
        assert.equal(historicalXunitMethodPresent(source, 'BackendAuthStateMachineTests', method, maskCSharpTrivia), true);
    }

    // These membership/refusal controls are not a current after inventory or runtime qualification.
    const input = { beforeSnapshot, replacements: selected, postBaselineDeletionIds: [] };
    const accepted = auditCompactRetentionRecords(input);
    assert.deepEqual(accepted.unknownDeletionDeclarations, []);
    assert.deepEqual(accepted.mismatchedDeletionPaths, []);
    const aliases = auditCompactRetentionRecords({
        ...input,
        replacements: selected.map((entry) => ({
            ...entry,
            id: entry.id.replace('FsusBlog.Server.Tests.Unit.', '').replace('#case-0000', '')
        }))
    });
    assert.deepEqual(aliases.unknownDeletionDeclarations.map((entry) => entry.id), selected.map((entry) =>
        entry.id.replace('FsusBlog.Server.Tests.Unit.', '').replace('#case-0000', '')
    ));
    const wrongPath = auditCompactRetentionRecords({
        ...input,
        replacements: [{ ...selected[0], path: 'tests/backend/Unit/WrongOwnerTests.cs' }, selected[1]]
    });
    assert.deepEqual(wrongPath.mismatchedDeletionPaths.map((entry) => entry.id), [selected[0].id]);
    const afterRecords = [...new Set(selected.flatMap((entry) => entry.replacementTestIds))]
        .map((id) => ({ id }));
    const presentTargets = auditCompactRetentionRecords({ ...input, afterRecords });
    assert.deepEqual(presentTargets.missingReplacementTargets, []);
    const removedTarget = selected[0].replacementTestIds[0];
    const missingTarget = auditCompactRetentionRecords({
        ...input,
        afterRecords: afterRecords.filter((record) => record.id !== removedTarget)
    });
    assert.deepEqual(missingTarget.missingReplacementTargets, selected
        .filter((entry) => entry.replacementTestIds.includes(removedTarget))
        .map((entry) => ({ deletedTestId: entry.id, replacementTestId: removedTarget })));
});

test('matrix is the single current command and retention governance authority', () =>
{
    const matrix = parseMatrix(readFileSync(resolve(root, 'tests/matrix.yml'), 'utf8'));
    for (const group of Object.values(matrix.commandGroups))
    {
        const commandIds = group.commands.map(({ id }) => id);
        assert.ok(commandIds.length > 0, `${group.lane} must retain executable commands`);
        assert.equal(new Set(commandIds).size, commandIds.length, `${group.lane} command IDs must be unique`);
    }
    assert.equal(matrix.governance.retention.replacementLedger, 'tests/test-retention-replacements.json');
    const postBaselines = matrix.governance.retention.postBaselines;
    assert.equal(new Set(postBaselines).size, postBaselines.length);
    const trustedMatrix = parseMatrix(execFileSync('git', [
        'show', `${POST_BASELINE_HISTORY_ANCHOR}:tests/matrix.yml`
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } }));
    const trustedPaths = new Set(trustedMatrix.governance.retention.postBaselines);
    for (const path of trustedPaths)
    {
        assert.ok(postBaselines.includes(path), `${path} remains trusted`);
    }
    for (const baselinePath of postBaselines)
    {
        const baseline = JSON.parse(readFileSync(resolve(root, baselinePath), 'utf8'));
        assert.equal(baseline.schema, trustedPaths.has(baselinePath)
            ? 'fsusblog.issue-acceptance-baseline.v1'
            : 'fsusblog.issue-acceptance-baseline.v2');
        assert.ok(Array.isArray(baseline.records));
    }
    assert.equal(matrix.governance.retention.automaticDeletion, false);
});

test('backend source-locking owner accepts runtime artifacts and rejects production docs and test source', () =>
{
    const positive = readFileSync(
        resolve(root, 'tests/tools/fixtures/test-suite-convergence/backend-source-lock-positive.fixture.cs.txt'),
        'utf8'
    );
    const negative = readFileSync(
        resolve(root, 'tests/tools/fixtures/test-suite-convergence/backend-source-lock-negative.fixture.cs.txt'),
        'utf8'
    );

    const audit = verifySourceLockingFixtures(positive, negative);

    assert.deepEqual(audit.errors, []);
    assert.equal(audit.positive.length, 0);
    assert.deepEqual(
        new Set(audit.negative.map((violation) => violation.rule)),
        new Set([
            'production-source-read',
            'documentation-source-read',
            'test-source-read',
            'source-reader-helper',
            'generic-repo-source-reader'
        ])
    );
});

test('backend source-locking owner does not mistake a temporary JSON artifact for repository source', () =>
{
    const source = `
    public void ReadsArtifact(string directory)
    {
        string json = File.ReadAllText(Path.Combine(directory, "summary.json"));
    }
  `;

    assert.deepEqual(scanBackendSourceLocking(source, 'ArtifactBehaviorTests.cs'), []);
});

test('backend source-locking owner reconstructs segmented repository paths', () =>
{
    const source = `
    public void ReadsSource()
    {
        string text = File.ReadAllText(Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "src",
            "backend",
            "Services",
            "ExampleService.cs"));
    }
  `;

    const violations = scanBackendSourceLocking(source, 'SegmentedSourceTests.cs');

    assert.equal(violations.length, 1);
    assert.equal(violations[0].target, 'src/backend/Services/ExampleService.cs');
    assert.equal(violations[0].rule, 'production-source-read');
});

test('replacement merge accepts identical declarations and reports conflicting owners', () =>
{
    const base = {
        deletedTests: [{
            id: 'xunit:old#Old.Test',
            path: 'tests/backend/Unit/Old.cs',
            replacementTestIds: ['xunit:new#New.Test'],
            reason: 'behavior replacement'
        }]
    };
    const identical = structuredClone(base);
    const conflicting = structuredClone(base);
    conflicting.deletedTests[0].replacementTestIds = ['xunit:other#Other.Test'];

    const clean = mergeReplacementEntries([
        { source: 'first.json', manifest: base },
        { source: 'second.json', manifest: identical }
    ]);
    const conflict = mergeReplacementEntries([
        { source: 'first.json', manifest: base },
        { source: 'conflict.json', manifest: conflicting }
    ]);

    assert.equal(clean.entries.length, 1);
    assert.deepEqual(clean.errors, []);
    assert.equal(conflict.conflicts.length, 1);
    assert.match(conflict.errors[0], /conflicting replacement declarations/u);
});

test('replacement chains remain acyclic without a fixed historical edge count', () =>
{
    const historical = [{
        id: 'xunit:old#Old.A',
        path: 'tests/backend/Unit/Old.cs',
        replacementTestIds: ['xunit:old#Old.B']
    }, {
        id: 'xunit:old#Old.B',
        path: 'tests/backend/Unit/Old.cs',
        replacementTestIds: ['xunit:current#Current.Test']
    }];
    assert.deepEqual(validateReplacementChainAuthority(historical).errors, []);

    const appendedChain = [...historical, {
        id: 'xunit:newer#Newer.C',
        path: 'tests/backend/Unit/Newer.cs',
        replacementTestIds: ['xunit:old#Old.B']
    }];
    assert.deepEqual(validateReplacementChainAuthority(appendedChain).errors, []);

    const coordinatedRetarget = structuredClone(historical);
    coordinatedRetarget[0].replacementTestIds = ['xunit:newer#Newer.C'];
    coordinatedRetarget.push({
        id: 'xunit:newer#Newer.C',
        path: 'tests/backend/Unit/Newer.cs',
        replacementTestIds: ['xunit:current#Current.Test']
    });
    assert.deepEqual(validateReplacementChainAuthority(coordinatedRetarget).errors, []);

    const cyclic = structuredClone(historical);
    cyclic[1].replacementTestIds = ['xunit:old#Old.A'];
    assert.match(validateReplacementChainAuthority(cyclic).errors[0], /contains a cycle/u);
});

test('issue-local replacement manifest count is exact', () =>
{
    const merged = mergeReplacementEntries([{
        source: 'issue-1050.json',
        manifest: {
            expectedDeletedTestIds: 2,
            deletedTests: [{
                id: 'xunit:old#Old.Test',
                path: 'tests/backend/Unit/Old.cs',
                replacementTestIds: ['xunit:new#New.Test'],
                reason: 'replace source assertion with behavior'
            }]
        }
    }]);

    assert.ok(merged.errors.some((error) => error.includes('expectedDeletedTestIds is 2, found 1')));
});

test('retention audit reports every undeclared deletion and missing replacement target in one pass', () =>
{
    const beforeRecords = [
        { id: 'xunit:old#Old.One', path: 'tests/backend/Unit/Old.cs' },
        { id: 'xunit:old#Old.Two', path: 'tests/backend/Unit/Old.cs' },
        { id: 'xunit:keep#Keep.Test', path: 'tests/backend/Unit/Keep.cs' }
    ];
    const afterRecords = [
        { id: 'xunit:keep#Keep.Test', path: 'tests/backend/Unit/Keep.cs' },
        { id: 'xunit:new#New.Test', path: 'tests/backend/Unit/New.cs' }
    ];
    const replacements = [{
        id: 'xunit:old#Old.One',
        path: 'tests/backend/Unit/Old.cs',
        replacementTestIds: ['xunit:missing#Missing.Test'],
        source: 'issue.json'
    }];

    const audit = auditRetentionRecords({ beforeRecords, afterRecords, replacements });

    assert.deepEqual(audit.missingDeletionMappings, [
        { id: 'xunit:old#Old.Two', path: 'tests/backend/Unit/Old.cs' }
    ]);
    assert.deepEqual(audit.missingReplacementTargets, [{
        deletedTestId: 'xunit:old#Old.One',
        replacementTestId: 'xunit:missing#Missing.Test'
    }]);
    assert.equal(audit.errors.length, 2);
});

test('retention audit accepts a declared deletion whose replacement exists after convergence', () =>
{
    const beforeRecords = [{ id: 'xunit:old#Old.Test', path: 'tests/backend/Unit/Old.cs' }];
    const afterRecords = [{ id: 'xunit:new#New.Test', path: 'tests/backend/Unit/New.cs' }];
    const replacements = [{
        id: 'xunit:old#Old.Test',
        path: 'tests/backend/Unit/Old.cs',
        replacementTestIds: ['xunit:new#New.Test'],
        source: 'issue.json'
    }];

    const audit = auditRetentionRecords({ beforeRecords, afterRecords, replacements });

    assert.deepEqual(audit.errors, []);
    assert.equal(audit.deletedRecords.length, 1);
});

test('compact retention audit resolves hashed deletions, replacement targets, and path bindings', () =>
{
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const beforeSnapshot = compactRetentionBaseline({
        schema: 'fsusblog.test-retention-audit.v2',
        sourceState,
        testRecords: [{
            id: 'xunit:old#Old.Test',
            path: 'tests/backend/Unit/Old.cs',
            framework: 'xunit',
            assertionTargets: ['Assert.Equal(expected, actual)'],
            coverageIds: ['contract'],
            tierIds: ['backend-unit'],
            tierInvocationCount: 1,
            timing: { samples: 0, p50Ms: null, p95Ms: null },
            failureHistory: { runs: 0, failures: 0, lastFailureAt: null },
            riskTags: ['security']
        }],
        retainedEvidence: { coverageIds: ['contract'], testRecordCount: 1, uniqueAssertionTargetCount: 1 },
        catalogSnapshot: {
            matrixTierIds: ['backend-unit'],
            productionRequiredTierIds: ['backend-unit'],
            matrixArtifactPaths: [],
            matrixEvidencePaths: [],
            coverageIds: ['contract'],
            requirementIds: [],
            releaseEvidencePaths: [],
            sourceDigests: {}
        },
        replacementManifestBaseline: {
            deletedTestIds: [],
            assertionBeforeTargets: [],
            tierFromIds: []
        }
    }, {
        optimizationEvidence: {
            coverage: {
                backend: { summary: { linecoverage: 80, branchcoverage: 60 } },
                frontend: { summary: { linecoverage: 70, branchcoverage: 50 } },
                merged: { summary: { linecoverage: 75, branchcoverage: 55 } }
            },
            criticalMutationSlice: {
                evidenceMode: 'scope-identity',
                testIds: ['xunit:old#Old.Test'],
                scopeIds: ['release-mutation-critical-slice']
            }
        }
    });
    const replacement = {
        id: 'xunit:old#Old.Test',
        path: 'tests/backend/Unit/Old.cs',
        replacementTestIds: ['xunit:new#New.Test'],
        source: 'issue.json'
    };

    const accepted = auditCompactRetentionRecords({
        beforeSnapshot,
        afterRecords: [{ id: 'xunit:new#New.Test', path: 'tests/backend/Unit/New.cs' }],
        replacements: [replacement]
    });
    const wrongPath = auditCompactRetentionRecords({
        beforeSnapshot,
        afterRecords: [{ id: 'xunit:new#New.Test', path: 'tests/backend/Unit/New.cs' }],
        replacements: [{ ...replacement, path: 'tests/backend/Unit/Wrong.cs' }]
    });
    const postBaseline = {
        id: 'xunit:post-baseline#PostBaseline.Removed',
        path: 'tests/backend/Unit/PostBaseline.cs',
        replacementTestIds: ['xunit:new#New.Test'],
        source: 'issue-post-baseline.json'
    };
    const acceptedPostBaseline = auditCompactRetentionRecords({
        beforeSnapshot,
        afterRecords: [{ id: 'xunit:new#New.Test', path: 'tests/backend/Unit/New.cs' }],
        replacements: [replacement, postBaseline],
        postBaselineDeletionIds: [postBaseline.id]
    });
    const rejectedUnknown = auditCompactRetentionRecords({
        beforeSnapshot,
        afterRecords: [{ id: 'xunit:new#New.Test', path: 'tests/backend/Unit/New.cs' }],
        replacements: [replacement, postBaseline]
    });

    assert.deepEqual(accepted.errors, []);
    assert.equal(accepted.deletedRecords.length, 1);
    assert.equal(wrongPath.mismatchedDeletionPaths.length, 1);
    assert.deepEqual(acceptedPostBaseline.unknownDeletionDeclarations, []);
    assert.deepEqual(rejectedUnknown.unknownDeletionDeclarations, [{
        id: postBaseline.id,
        source: postBaseline.source
    }]);
});

test('retention audit inherits pre-baseline declarations but rejects a wrong baseline path', () =>
{
    const beforeRecords = [{ id: 'xunit:old#Old.Test', path: 'tests/backend/Unit/Old.cs' }];
    const replacements = [
        {
            id: 'xunit:old#Old.Test',
            path: 'tests/backend/Unit/Wrong.cs',
            replacementTestIds: ['xunit:new#New.Test'],
            source: 'issue.json'
        },
        {
            id: 'vitest:prebaseline#removed',
            path: 'tests/frontend/unit/Removed.test.ts',
            replacementTestIds: ['vitest:new#behavior'],
            source: 'baseline.json'
        }
    ];

    const audit = auditRetentionRecords({
        beforeRecords,
        replacements,
        preBaselineDeletionIds: ['vitest:prebaseline#removed']
    });

    assert.deepEqual(audit.unknownDeletionDeclarations, []);
    assert.deepEqual(audit.mismatchedDeletionPaths, [{
        id: 'xunit:old#Old.Test',
        declaredPath: 'tests/backend/Unit/Wrong.cs',
        baselinePath: 'tests/backend/Unit/Old.cs',
        source: 'issue.json'
    }]);
});

test('final after snapshot must be independently run-bound and source-bound', () =>
{
    const before = {
        sourceState: {
            commit: '1'.repeat(40),
            worktreeFingerprint: '2'.repeat(64)
        }
    };
    const valid = {
        schema: 'fsusblog.test-retention-audit.v2',
        generatedAt: '2026-07-11T00:00:00.000Z',
        sourceState: {
            commit: '3'.repeat(40),
            worktreeFingerprint: '4'.repeat(64)
        },
        producer: {
            runId: 'production-fresh-20260711',
            generatedAt: '2026-07-11T00:00:00.000Z',
            sourceState: {
                commit: '3'.repeat(40),
                worktreeFingerprint: '4'.repeat(64)
            }
        }
    };
    const stale = structuredClone(valid);
    stale.snapshotRole = 'before-test-reduction';
    stale.sourceState = structuredClone(before.sourceState);
    stale.producer.sourceState = structuredClone(before.sourceState);
    stale.producer.runId = '';

    assert.deepEqual(validateAfterSnapshotAuthority(before, valid, { required: true }), []);
    const errors = validateAfterSnapshotAuthority(before, stale, { required: true });
    assert.ok(errors.some((error) => error.includes('cannot reuse')));
    assert.ok(errors.some((error) => error.includes('run id is missing')));
    assert.ok(errors.some((error) => error.includes('before source state')));
    assert.deepEqual(validateAfterSnapshotAuthority(before, null), []);
    assert.deepEqual(
        validateAfterSnapshotAuthority(before, null, { required: true }),
        ['final convergence requires an after retention snapshot']
    );
});

test('final evidence contracts report every invalid status field', () =>
{
    const errors = validateEvidenceContract(
        {
            schema: 'wrong.schema',
            status: 'blocked',
            producer: { runId: '' },
            summary: { linecoverage: 'not-a-number' }
        },
        {
            path: 'evidence.json',
            assertions: [
                { field: 'schema', equals: 'expected.schema' },
                { field: 'status', oneOf: ['ok', 'success'] },
                { field: 'producer.runId', nonEmpty: true },
                { field: 'summary.linecoverage', finiteNumber: true }
            ]
        }
    );

    assert.equal(errors.length, 4);
    assert.ok(errors.every((error) => error.startsWith('evidence.json:')));
});

test('child issue evidence requires the exact closed #1032 through #1050 set', () =>
{
    const issues = Array.from({ length: 19 }, (_, index) => ({
        number: 1032 + index,
        state: 'closed',
        closed_at: '2026-07-11T01:00:00.000Z',
        html_url: `https://github.com/example/repo/issues/${1032 + index}`
    }));
    const closed = buildChildIssueStatusEvidence(issues, {
        repository: 'example/repo',
        capturedAt: '2026-07-11T02:00:00.000Z'
    });
    const blocked = buildChildIssueStatusEvidence(
        issues.filter((issue) => issue.number !== 1040).map((issue) => (
      issue.number === 1041 ? { ...issue, state: 'open', closed_at: null } : issue
        )),
        { repository: 'example/repo', capturedAt: '2026-07-11T02:00:00.000Z' }
    );

    assert.equal(closed.status, 'closed');
    assert.deepEqual(validateChildIssueStatusEvidence(closed), []);
    const errors = validateChildIssueStatusEvidence(blocked);
    assert.ok(errors.some((error) => error.includes('every issue')));
    assert.ok(errors.some((error) => error.includes('#1041 is not closed')));
    assert.ok(errors.some((error) => error.includes('#1041 has no valid closedAt')));
});

test('path migration expansion emits every exact baseline test ID', () =>
{
    const beforeRecords = [
        { id: 'vitest:old#one', path: 'tests/frontend/unit/old.test.ts' },
        { id: 'vitest:old#two', path: 'tests/frontend/unit/old.test.ts' },
        { id: 'vitest:mixed#source-only', path: 'tests/frontend/unit/mixed.test.ts' }
    ];
    const expanded = expandPathReplacementPlan(beforeRecords, {
        replacementOwners: { behavior: ['vitest:new#behavior'] },
        wholeFileMigrations: [{
            path: 'tests/frontend/unit/old.test.ts',
            expectedRecords: 2,
            replacementOwner: 'behavior'
        }],
        selectiveTestMigrations: [{
            deletedTestId: 'vitest:mixed#source-only',
            replacementOwner: 'behavior'
        }]
    });

    assert.deepEqual(expanded.errors, []);
    assert.deepEqual(expanded.entries.map((entry) => entry.id), [
        'vitest:old#one',
        'vitest:old#two',
        'vitest:mixed#source-only'
    ]);
    assert.ok(expanded.entries.every((entry) => entry.replacementTestIds[0] === 'vitest:new#behavior'));
});

test('convergence plan enforces all child issues exactly once and only earlier dependencies', () =>
{
    const validPlan = {
        trackingIssue: 1051,
        finalEvidencePaths: [],
        finalEvidenceContracts: [],
        sourceLockingOwners: {
            backend: 'tools/check-test-suite-convergence.mjs',
            frontend: 'tests/frontend/checks/static/check-frontend-test-governance.mjs'
        },
        stages: [
            { order: 0, issues: [1032] },
            { order: 1, issues: [1033, 1034, 1035, 1036] },
            { order: 2, issues: [1037, 1038, 1039, 1040, 1041, 1042] },
            { order: 3, issues: [1043, 1044, 1045, 1046, 1047, 1048, 1049, 1050] }
        ],
        issueDependencies: {
            1033: [1032],
            1043: [1037],
            1051: Array.from({ length: 19 }, (_, index) => 1032 + index)
        }
    };
    const invalidPlan = structuredClone(validPlan);
    invalidPlan.stages[3].issues = invalidPlan.stages[3].issues.filter((issue) => issue !== 1050);
    invalidPlan.issueDependencies[1043] = [1049];
    invalidPlan.issueDependencies[1051] = invalidPlan.issueDependencies[1051].filter((issue) => issue !== 1050);

    assert.deepEqual(validateConvergencePlan(validPlan), []);
    assert.ok(validateConvergencePlan(invalidPlan).some((error) => error.includes('misses issue #1050')));
    assert.ok(validateConvergencePlan(invalidPlan).some((error) => error.includes('non-earlier issue #1049')));
    assert.ok(validateConvergencePlan(invalidPlan).some((error) => error.includes('must depend on every issue')));
});
