import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const { loadTestMatrix } = await import(new URL('../../tools/test-matrix/command-groups.mjs', import.meta.url));
const {
    buildSettledPhaseJoinEvidence,
    executeWeightedStepDag,
    validateSettledPhaseJoinConsistency
} = await import(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url));
const { projectFrontendPropertyModelPerf } = await import(new URL('../../tools/test/frontend-atomic/property-model-perf.mjs', import.meta.url));

const root = fileURLToPath(new URL('../..', import.meta.url));
const matrix = loadTestMatrix(root);
const packageDocument = JSON.parse(fs.readFileSync(new URL('../../src/frontend/package.json', import.meta.url)));

test('property/model/perf preserves canonical commands, package seed owner and parent metadata', () =>
{
    const projection = projectFrontendPropertyModelPerf(matrix, packageDocument);
    assert.equal(projection.qualificationEligible, false);
    assert.deepEqual(projection.entries.map((entry) => entry.id),
        ['frontend-property', 'frontend-state-machines', 'frontend-perf-regression']);
    assert.deepEqual(projection.parentDeclaration, matrix.tiers.find((tier) => tier.id === 'frontend-property-model-perf'));
    for (const entry of projection.entries)
    {
        assert.equal(entry.scriptCommand, packageDocument.scripts[entry.commandSourceRef.script]);
        assert.deepEqual(entry.dependsOn, []);
    }
    assert.match(projection.entries[0].scriptCommand, /--producer frontend-property-model-perf/u);
    assert.equal(Object.hasOwn(projection.settledProjection, 'command'), false);
});

test('each new executable lane calls only its original unsharded command or measurement owner', () =>
{
    const projection = projectFrontendPropertyModelPerf(matrix, packageDocument);
    for (const entry of projection.entries)
    {
        const source = fs.readFileSync(new URL(`../../${entry.command}`, import.meta.url), 'utf8');
        assert.equal(spawnSync('bash', ['-n', entry.command], { cwd: root }).status, 0);
        assert.match(source, /set -euo pipefail/u);
        assert.match(source, /EnsureFrontendFsusUiBaseline/u);
        assert.ok(source.includes(entry.commandSourceRef.script));
        assert.equal((source.match(/RunTier /gu) ?? []).length, 1);
        assert.doesNotMatch(source, /RunFrontendPropertyModelPerf|RunFrontendFastGroup|WriteFrontendSplitSummary|--shard|set \+e/u);
        for (const sibling of projection.entries.filter((candidate) => candidate.id !== entry.id))
        {
            assert.equal(source.includes(sibling.commandSourceRef.script), false);
        }
    }
    const perf = projection.entries[2];
    assert.equal(perf.resources.exclusiveCapacity, true);
    assert.deepEqual(perf.resources.exclusiveResources, ['benchmark-window']);
    assert.deepEqual(perf.measurement, {
        windowId: 'frontend-perf-regression',
        evidenceFile: '.tmp/frontend/frontend-perf-regression.measurement-noise.json',
        commandOwner: 'tools/test/performance-admission.mjs'
    });
});

for (const failedId of ['frontend-property', 'frontend-state-machines', 'frontend-perf-regression'])
{
    test(`existing DAG collects all three terminal states after ${failedId} failure and isolates perf`, async () =>
    {
        const projection = projectFrontendPropertyModelPerf(matrix, packageDocument);
        const active = new Set();
        const results = {};
        let joinEvidence;
        const summary = { ...projection.settledProjection, runAfterSettled: true,
            resources: { coordinationOnly: true } };
        await assert.rejects(executeWeightedStepDag([...projection.entries, summary],
            { maxParallel: 3, cpuUnits: 4, memoryGiB: 4, exclusiveResources: ['benchmark-window'] }, async (entry) =>
            {
                if (entry.id === summary.id)
                {
                    joinEvidence = buildSettledPhaseJoinEvidence({ stepId: entry.id,
                        dependencyIds: summary.settledDependsOn, dependencyOutcomes: entry.dependencyOutcomes,
                        dependencyResults: results }).evidence;
                    return { terminalState: joinEvidence.terminalState, evidence: joinEvidence };
                }
                if (entry.id === 'frontend-perf-regression')
                {
                    assert.equal(active.size, 0, 'measurement cannot overlap property/model load');
                }
                else
                {
                    assert.equal(active.has('frontend-perf-regression'), false);
                }
                active.add(entry.id);
                await new Promise((resolve) => setImmediate(resolve));
                active.delete(entry.id);
                results[entry.id] = { terminalState: entry.id === failedId ? 'failed' : 'success',
                    startedAtMs: 1, finishedAtMs: 2, durationMs: 1 };
                if (entry.id === failedId)
                {
                    throw new Error(entry.id === 'frontend-perf-regression' ? 'measurement admission refused' : 'test failure');
                }
            }), (error) =>
        {
            assert.deepEqual(Object.keys(results).sort(), projection.entries.map((entry) => entry.id).sort());
            assert.equal(error.states[failedId], 'failed');
            for (const sibling of projection.entries.filter((entry) => entry.id !== failedId))
            {
                assert.equal(error.states[sibling.id], 'success');
            }
            assert.equal(error.states[summary.id], 'failed');
            return true;
        });
        assert.equal(joinEvidence.dependencies.length, 3);
        assert.deepEqual(joinEvidence.primaryFailureRefs, [failedId]);
    });
}

test('canonical settled summary refuses omitted failed child, false success and timing tamper', () =>
{
    const projection = projectFrontendPropertyModelPerf(matrix, packageDocument);
    const ids = projection.settledProjection.settledDependsOn;
    const outcomes = Object.fromEntries(ids.map((id, index) => [id, index === 0 ? 'failed' : 'success']));
    const receipts = Object.fromEntries(ids.map((id) => [id, {
        schema: 'fsusblog.scheduler.terminal-receipt.v1', terminalState: outcomes[id]
    }]));
    const results = Object.fromEntries(ids.map((id) => [id, { ...receipts[id], durationMs: 5,
        startedAtMs: 1, finishedAtMs: 6 }]));
    const { evidence } = buildSettledPhaseJoinEvidence({ stepId: projection.settledProjection.id,
        dependencyIds: ids, dependencyOutcomes: outcomes, dependencyResults: results });
    const validate = (candidate) => validateSettledPhaseJoinConsistency({ schedulerState: 'failed',
        evidence: candidate, dependencyReceipts: receipts, canonicalDependencyOutcomes: outcomes });
    validate(evidence);
    const omitted = structuredClone(evidence);
    omitted.dependencies.shift();
    assert.throws(() => validate(omitted));
    const falseSuccess = structuredClone(evidence);
    falseSuccess.status = 'success';
    assert.throws(() => validate(falseSuccess), /state mismatch/u);
    const timing = structuredClone(evidence);
    timing.dependencies[0].durationMs += 1;
    assert.throws(() => validate(timing), /digest mismatch/u);
});

test('script changes invalidate property source digest; absent script cannot produce a plan', () =>
{
    const original = projectFrontendPropertyModelPerf(matrix, packageDocument);
    const changed = structuredClone(packageDocument);
    changed.scripts['test:property'] += ' --changed';
    assert.notEqual(projectFrontendPropertyModelPerf(matrix, changed).sourceDigest, original.sourceDigest);
    delete changed.scripts['check:frontend-state-machines'];
    assert.throws(() => projectFrontendPropertyModelPerf(matrix, changed), /missing canonical/u);
});
