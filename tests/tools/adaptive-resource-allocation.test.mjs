import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { seal } = await import(new URL('../../tools/resource-model/contract.mjs', import.meta.url));
const { recommendCpu } = await import(new URL('../../tools/resource-model/cpu-recommendations.mjs', import.meta.url));
const {
    evaluateActivationCandidate, publishCandidatePointer, selectCandidateModel, validateModelBundle
} = await import(new URL('../../tools/resource-model/model-lifecycle.mjs', import.meta.url));

import { fixture, modelFixture } from './support/adaptive-resource-fixtures.mjs';

const unchanged = {
    actualCpuUnits: 1, criticalPath: false, capacityBlockedMs: 0, peakRssGiB: 4 / 1.3,
    downstreamUnlockValue: 0, startupCapacityBlockedMs: 0, queueAgeMs: 0
};

function allocationFixture(context, options = {})
{
    return modelFixture(context, {
        row: { alpha: unchanged, beta: unchanged },
        defaults: { alpha: { cpuUnits: 6 }, beta: { cpuUnits: 2 } }, ...options
    });
}

function publication(data, overrides = {})
{
    return { directory: data.modelDirectory, model: data.model, identity: data.identity, shadow: data.shadow,
        evidenceRoot: data.evidenceRoot, confirmationLocators: overrides.confirmationLocators ?? data.confirmations(),
        expectedPointerDigest: null,
        ...overrides };
}

test('adaptive CPU classifies normalized six two to four four grants as actual recommendations', (context) =>
{
    const data = allocationFixture(context);
    const rows = data.model.recommendations.cpu.recommendations;
    assert.deepEqual(data.defaults.map((row) => row.cpuUnits), [6, 2]);
    assert.deepEqual(rows.map((row) => row.recommendedCpuUnits), [4, 4]);
    assert.deepEqual(rows.map((row) => row.recommendedCpuWeight), [2, 2]);
    assert.deepEqual(rows.map((row) => row.decision), ['recommend', 'recommend']);
    assert.ok(data.shadow.differences.every((row) => row.changed));
    assert.equal(data.shadow.schedulerMutationCount, 0);
    assert.equal(validateModelBundle(data.model, data.identity), data.model);
});

test('adaptive CPU preserves held grants for every protected or insufficient learning case', (context) =>
{
    for (const row of [
        { waitClass: 'dependency' }, { waitClass: 'readiness' }, { throttledMs: 1 },
        { waitClass: 'quiet' }, { waitClass: 'benchmark' }
    ])
    {
        const data = fixture(context, { defaults: { alpha: { cpuUnits: 6 }, beta: { cpuUnits: 2 } },
            row: { alpha: row } });
        const result = recommendCpu(data.inputs);
        assert.equal(result.recommendations[0].recommendedCpuUnits, 6);
        assert.equal(result.recommendations[0].decision, 'no-change');
        assert.equal(result.recommendations[1].recommendedCpuUnits, 2);
    }
    for (const count of [0, 1, 4])
    {
        const data = fixture(context, { count, defaults: { alpha: { cpuUnits: 6 }, beta: { cpuUnits: 2 } } });
        const rows = recommendCpu(data.inputs).recommendations;
        assert.deepEqual(rows.map((row) => row.recommendedCpuUnits), [6, 2]);
        assert.ok(rows.every((row) => row.decision === 'no-change'));
    }
});

test('adaptive CPU refuses protected held grants that exceed the unchanged envelope', (context) =>
{
    const data = fixture(context, { count: 0,
        defaults: { alpha: { cpuUnits: 6 }, beta: { cpuUnits: 6 } } });
    assert.throws(() => recommendCpu(data.inputs), { code: 'infeasible-cpu-envelope' });
});

test('adaptive bundle refuses resealed false no change when only actual CPU grants changed', (context) =>
{
    const data = allocationFixture(context);
    const model = structuredClone(data.model);
    const cpu = model.recommendations.cpu;
    delete cpu.digest;
    for (const row of cpu.recommendations)
    {
        row.decision = 'no-change';
    }
    model.recommendations.cpu = seal(cpu);
    model.recommendationDigests.cpu = model.recommendations.cpu.digest;
    delete model.digest;
    assert.throws(() => validateModelBundle(seal(model), data.identity), { code: 'false-no-change' });
});

test('adaptive allocation changes require all three confirmations and the original five percent benefit', (context) =>
{
    const data = allocationFixture(context);
    for (const [wall, expected] of [[1000, 'reject'], [951, 'reject'], [950, 'active-candidate']])
    {
        const locators = data.confirmations((row) =>
        {
            row.currentWallMs = wall;
        }, `benefit-${wall}`);
        const terminal = evaluateActivationCandidate({ ...publication(data), confirmationLocators: locators });
        assert.equal(terminal.state, expected);
        if (expected === 'reject')
        {
            assert.ok(terminal.reasons.some((row) => row.code === 'insufficient-p50-benefit'));
        }
        const incomplete = evaluateActivationCandidate({ ...publication(data), confirmationLocators: locators.slice(0, 2) });
        assert.equal(incomplete.state, 'reject');
        assert.ok(incomplete.reasons.some((row) => row.code === 'independent-confirmations-required'));
    }
});

test('adaptive zero benefit grant changes reject and retain the existing CAS pointer and model', (context) =>
{
    const current = modelFixture(context);
    const first = publishCandidatePointer(publication(current));
    const file = path.join(current.modelDirectory, 'candidate-active.json');
    const before = fs.readFileSync(file);
    const changed = allocationFixture(context);
    const terminal = publishCandidatePointer(publication(changed, {
        directory: current.modelDirectory, expectedPointerDigest: first.pointer.digest,
        confirmationLocators: changed.confirmations((row) =>
        {
            row.currentWallMs = 1000;
        })
    }));
    assert.equal(terminal.state, 'reject');
    assert.equal(terminal.p50Gain, 0);
    assert.ok(terminal.reasons.some((row) => row.code === 'insufficient-p50-benefit'));
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(selectCandidateModel({ directory: current.modelDirectory, identity: current.identity,
        defaults: current.defaults, planSealed: false }).model.digest, current.model.digest);
    assert.equal(JSON.parse(fs.readFileSync(path.join(current.modelDirectory,
        `terminal-${terminal.digest.slice(7)}.json`))).state, 'reject');
});
