import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkMutationInventory } from '../../tools/test/check-mutation-inventory.mjs';
import { createStrykerAuthority } from '../../tools/test/check-stryker-report.mjs';
import { readReleaseReliabilityEvidenceBinding } from '../../tools/test/release-reliability-evidence-binding.mjs';
import { sealDocument } from '../../tools/test/release-reliability-receipt.mjs';

const testId = '00000000-0000-0000-0000-000000000001';
const testName = 'FsusBlog.Server.Tests.Unit.AedsEncoderTests.Encode';
const config = { 'stryker-config': { 'test-case-filter': 'FullyQualifiedName~AedsEncoderTests', mutate: ['Algorithms/AedsEncoder.cs'], thresholds: { high: 85, low: 70, break: 70 } } };
const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function rawMutant(id, status = 'Killed', line = 1, operator = 'Arithmetic mutation')
{
    return { id, status, mutatorName: operator, replacement: `return ${id};`, location: { start: { line, column: 1 }, end: { line, column: 10 } }, coveredBy: ['Killed', 'Survived', 'Timeout'].includes(status) ? [testId] : [], killedBy: status === 'Killed' ? [testId] : [] };
}

function inputs(mutants)
{
    const report = { schemaVersion: '2', thresholds: { high: 85, low: 70 }, files: { 'Algorithms/AedsEncoder.cs': { language: 'cs', source: 'return a;\nreturn b;\nreturn c;', mutants } }, testFiles: { 'tests/backend/Unit/AedsEncoderTests.cs': { tests: [{ id: testId, name: testName }] } } };
    const executed = mutants.filter(({ status }) => ['Killed', 'Survived', 'Timeout'].includes(status));
    const traceLines = ['2026-07-11T00:59:59.0000000Z  [DBG] Stryker starting, version: "4.14.2" (e60f399b)', '2026-07-11T01:00:00.0000000Z  [DBG] Stryker started with options: StrykerOptions { ReportPath: "/repo/.tmp/mutation/reports", ReportFileName: "backend-mutation-critical", TestCaseFilter: "FullyQualifiedName~AedsEncoderTests" } (fac41b16)'];
    for (const [index, mutant] of executed.entries())
    {
        const stamp = `2026-07-11T01:00:${String(index + 1).padStart(2, '0')}`;
        traceLines.push(`${stamp}.0000000Z  [DBG] "Runner 0": Testing ["${mutant.id}: mutation"] (445b8f48)`);
        traceLines.push(`${stamp}.0250000Z  [DBG] Test run for "${mutant.id}: mutation" is "failed" (26093294)`);
    }
    const scoreable = mutants.filter(({ status }) => !['Ignored', 'CompileError'].includes(status)).length;
    traceLines.push(`2026-07-11T01:01:00.0000000Z  [INF] The final mutation score is ${(mutants.filter(({ status }) => status === 'Killed').length / scoreable * 100).toFixed(2)} %`);
    return { report, rawReport: Buffer.from(JSON.stringify(report)), reportPath: '.tmp/mutation/reports/backend-mutation-critical.json', reportAbsolutePath: '/repo/.tmp/mutation/reports/backend-mutation-critical.json', rawTrace: Buffer.from(`${traceLines.join('\n')}\n`), tracePath: '.tmp/mutation/logs/log.txt', config, rawConfig: Buffer.from(JSON.stringify(config)), configPath: 'config/testing/mutation/critical.json', tierId: 'release-mutation-critical-slice', runId: 'test-run', sourceState, generatedAt: '2026-07-11T01:02:03.000Z', repositoryRoot: '/repo', sourceRoot: 'src/core' };
}

function authority(entries)
{
    const value = inputs(entries.map(([id, status = 'Killed', operator = 'Arithmetic mutation'], index) => rawMutant(id, status, index + 1, operator)));
    return { authority: createStrykerAuthority(value), authorityInputs: value };
}

function policy(ids, changes = {})
{
    const baselineMutantIds = [...ids].sort();
    return { schema: 'fsusblog.mutation-inventory-retention.v1', scopeId: 'release-mutation-critical-slice', baselineMutantIds, baselineInventoryDigest: canonicalDigest(baselineMutantIds), requiredSourceRegions: ['src/core/Algorithms/AedsEncoder.cs'], requiredOperators: ['Arithmetic mutation'], minimumPlannedMutants: baselineMutantIds.length, minimumExecutedMutants: 1, maximumIgnoredShare: 0.2, maximumCompileErrorShare: 0.1, maximumNoCoverageShare: 0.1, retiredMutants: [], ...changes };
}

function check(entry, policyValue)
{
    return checkMutationInventory({ ...entry, policy: policyValue });
}
function policyFor(entry, changes = {})
{
    return policy(entry.authority.plannedMutantIds, changes);
}

function dynamicAuthorityFixture({ releaseReliability = true } = {})
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-mutation-binding-'));
    const invocationId = 'mutation-binding-invocation';
    const runId = 'mutation-binding-run';
    const scenarioId = 'release-mutation-critical-slice';
    const identityPath = `.tmp/release-reliability/${invocationId}/identity.json`;
    const identity = sealDocument({
        schema: 'fsusblog.release-reliability-run-identity.v1',
        status: 'complete',
        invocationId,
        runId,
        sourceState: {
            commit: 'c'.repeat(40),
            worktreeFingerprint: `sha256:${'d'.repeat(64)}`,
            dirtyPathCount: 0,
            hashedPathCount: 1
        },
        build: { contentDigest: `sha256:${'e'.repeat(64)}` }
    });
    fs.mkdirSync(path.dirname(path.join(repositoryRoot, identityPath)), { recursive: true });
    fs.writeFileSync(path.join(repositoryRoot, identityPath), JSON.stringify(identity));
    const environment = {
        FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: invocationId,
        FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: runId,
        FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID: scenarioId,
        FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH: identityPath,
        FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST: identity.contentDigest
    };
    const binding = readReleaseReliabilityEvidenceBinding({ repositoryRoot, environment });
    const authorityInputs = inputs([rawMutant('one')]);
    authorityInputs.repositoryRoot = repositoryRoot;
    authorityInputs.reportAbsolutePath = path.join(repositoryRoot, authorityInputs.reportPath);
    authorityInputs.rawTrace = Buffer.from(
        authorityInputs.rawTrace.toString('utf8').replace(
            '/repo/.tmp/mutation/reports',
            path.dirname(authorityInputs.reportAbsolutePath)
        )
    );
    authorityInputs.releaseReliability = releaseReliability ? binding : null;
    for (const [relativePath, bytes] of [
        [authorityInputs.reportPath, authorityInputs.rawReport],
        [authorityInputs.tracePath, authorityInputs.rawTrace],
        [authorityInputs.configPath, authorityInputs.rawConfig]
    ])
    {
        const absolutePath = path.join(repositoryRoot, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, bytes);
    }
    const authority = createStrykerAuthority(authorityInputs);
    return {
        authority,
        environment: releaseReliability ? environment : {},
        policy: policy(authority.plannedMutantIds),
        repositoryRoot
    };
}

test('inventory floors, operator/source coverage, and status shares fail independently', () =>
{
    const single = authority([['one']]);
    assert.throws(() => check(single, policy([...single.authority.plannedMutantIds, ...Array.from({ length: 99 }, (_, i) => `m${i}`)])), /planned mutant count/u);
    const logical = authority([['one', 'Killed', 'Logical mutation']]);
    assert.throws(() => check(logical, policyFor(logical)), /required operator/u);
    const ignored = authority([['one'], ['two', 'Ignored']]);
    assert.throws(() => check(ignored, policyFor(ignored, { maximumIgnoredShare: 0 })), /Ignored share/u);
});

test('retirement exact mappings and new mutants are governed without automatic baseline writes', () =>
{
    const current = authority([['new']]);
    const old = authority([['old']]).authority.plannedMutantIds[0];
    assert.throws(() => check(current, policy([old], { minimumPlannedMutants: 1 })), /without retirement proof/u);
    assert.equal(check(current, policy([old], { minimumPlannedMutants: 1, retiredMutants: [{ mutantId: old, reasonCode: 'source-refactor-exact-mapping', replacementMutantIds: [current.authority.plannedMutantIds[0]], proofTestIds: [] }] })).status, 'success');
    const expanded = authority([['old'], ['new']]);
    assert.equal(check(expanded, policyFor(expanded, { baselineMutantIds: [expanded.authority.plannedMutantIds[0]], baselineInventoryDigest: canonicalDigest([expanded.authority.plannedMutantIds[0]]), minimumPlannedMutants: 1 })).inventory.planned, 2);
});

test('complete authority bindings are required and determine candidate identity', () =>
{
    const entry = authority([['one'], ['two']]);
    const baseline = policyFor(entry);
    const candidate = check(entry, baseline).candidateIdentity;
    for (const mutate of [
        (value) =>
        {
            delete value.executedMutantIds;
        },
        (value) =>
        {
            delete value.executionMatrixDigest;
        },
        (value) =>
        {
            delete value.rawTrace;
        },
        (value) =>
        {
            value.inventory[0].status = 'Unknown';
        }
    ])
    {
        const changed = structuredClone(entry.authority);
        mutate(changed);
        assert.throws(() => checkMutationInventory({ authority: changed, authorityInputs: entry.authorityInputs, policy: baseline }), /authority|unknown|execution|trace|terminal|duration/u);
    }
    const changedPolicy = policyFor(entry, { maximumIgnoredShare: 0.1 });
    assert.notEqual(candidate, check(entry, changedPolicy).candidateIdentity);
});

test('inventory rehydrates release reliability binding from current environment and identity', (context) =>
{
    const fixture = dynamicAuthorityFixture();
    context.after(() => fs.rmSync(fixture.repositoryRoot, { recursive: true, force: true }));
    assert.equal(checkMutationInventory(fixture).status, 'success');

    const tampered = structuredClone(fixture.authority);
    tampered.releaseReliability.invocationId = 'tampered-invocation';
    assert.throws(
        () => checkMutationInventory({ ...fixture, authority: tampered }),
        /authority content mismatch/u
    );
    assert.throws(
        () => checkMutationInventory({ ...fixture, environment: {} }),
        /authority content mismatch/u
    );
    assert.throws(
        () => checkMutationInventory({
            ...fixture,
            environment: {
                ...fixture.environment,
                FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: 'tampered-run'
            }
        }),
        /identity is incomplete or mismatched/u
    );
    assert.throws(
        () => checkMutationInventory({
            ...fixture,
            environment: {
                FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID:
                    fixture.environment.FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID
            }
        }),
        /binding environment is incomplete/u
    );

    const ordinary = dynamicAuthorityFixture({ releaseReliability: false });
    context.after(() => fs.rmSync(ordinary.repositoryRoot, { recursive: true, force: true }));
    assert.equal(checkMutationInventory(ordinary).status, 'success');
});
