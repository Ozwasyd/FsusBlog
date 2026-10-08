import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanCohort, cohort, contract, digest, machine, identityFor, planFor, prerequisitesFor, sampleFor, selector } from './cpu-calibration-test-support.mjs';

test('CPU candidate plan independently recomputes boundary and rotating three round schedule', () =>
{
    const plan = planFor();
    assert.deepEqual(plan.candidates, [6, 9, 12]);
    assert.deepEqual(plan.schedule.map((slot) => slot.candidate), [6, 9, 12, 9, 12, 6, 12, 6, 9]);
    cohort.validateCpuCandidatePlan(plan);
    const small = machine({ quota: '250000' });
    assert.throws(() => cohort.createCpuCandidatePlan({ topology: small, identity: identityFor(small),
        executionAdapterDigest: digest('adapter') }), /two lower/u);
    const fractional = planFor({ quota: '350000' });
    assert.deepEqual(fractional.candidates, [1, 2, 3]);
});

test('CPU cohort marks failed retry resume partial noisy swap OOM kill isolation and exactness invalid', () =>
{
    const plan = planFor();
    for (const change of [{ status: 'failed' }, { attempt: 2 }, { retry: true }, { resume: true }, { partial: true },
        { noisy: true }, { collectorDrift: true }, { benchmarkIsolation: false }, { exactness: false },
        { metrics: { swapBytes: 1 } }, { metrics: { oomCount: 1 } }, { metrics: { resourceKills: 1 } }])
    {
        const raw = sampleFor(plan, plan.schedule[0]);
        const altered = { ...raw, ...change, metrics: { ...raw.metrics, ...change.metrics } };
        assert.equal(cohort.qualifyCpuSample(altered, plan, plan.schedule[0]).valid, false);
    }
    const missingMetric = sampleFor(plan, plan.schedule[0]);
    delete missingMetric.metrics.psi;
    assert.throws(() => cohort.qualifyCpuSample(missingMetric, plan, plan.schedule[0]), /fields/u);
});

test('CPU cohort rejects duplicates missing samples reused correctness identity drift and tamper', () =>
{
    const clean = cleanCohort();
    assert.equal(clean.status, 'clean');
    cohort.validateCpuCalibrationCohort(clean);
    assert.equal(cohort.sealCpuCalibrationCohort(clean.plan, clean.prerequisites, clean.samples.slice(0, 8)).status, 'incomplete');
    assert.throws(() => cleanCohort(clean.plan, (raw) => ({ ...raw, runId: 'duplicate' })), /duplicate/u);
    assert.throws(() => cleanCohort(clean.plan, (raw) => ({ ...raw, correctnessDigest: digest('reused') })), /reused/u);
    assert.equal(cleanCohort(clean.plan, (raw) => ({ ...raw, identity: { ...raw.identity, kernel: digest('drift') } })).status, 'identity-drift');
    const damaged = structuredClone(clean);
    damaged.samples[0].raw.metrics.wallClockMs = 1;
    assert.throws(() => cohort.validateCpuCalibrationCohort(damaged), /digest/u);
});

test('CPU runner validates exact upstream adapter before any candidate spawn and persists every invalid attempt', async () =>
{
    const plan = planFor();
    let spawns = 0;
    const persisted = [];
    const adapter = { sourceDigest: plan.executionAdapterDigest, mode: plan.mode,
        verifyPrerequisites: () => prerequisitesFor(plan),
        runProduction: (slot) =>
        {
            spawns++;
            const raw = sampleFor(plan, slot);
            if (spawns === 2)
            {
                raw.status = 'failed';
            }
            return raw;
        }, verifyRun: (raw) => raw };
    await assert.rejects(cohort.runCpuCalibrationCandidates(plan, { ...adapter, sourceDigest: digest('wrong') }), /exact tested/u);
    assert.equal(spawns, 0);
    await assert.rejects(cohort.runCpuCalibrationCandidates(plan, { ...adapter, verifyPrerequisites: () =>
        contract.sealCpuValue({ ...prerequisitesFor(plan), qualified: false }) }), /digest|prerequisite/u);
    assert.equal(spawns, 0);
    const result = await cohort.runCpuCalibrationCandidates(plan, adapter, async (receipt) => persisted.push(receipt));
    assert.equal(spawns, 9);
    assert.equal(result.samples.length, 9);
    assert.equal(result.samples[1].raw.status, 'failed');
    assert.equal(result.samples[1].valid, false);
    assert.equal(result.status, 'incomplete');
    assert.ok(persisted.some((receipt) => receipt.samples.length === 2));
    assert.equal('effectiveCpuUnits' in result, false);
});

test('CPU runner stops identity drift without retry and retains original diagnostic failure', async () =>
{
    const plan = planFor();
    let spawns = 0;
    const result = await cohort.runCpuCalibrationCandidates(plan, { sourceDigest: plan.executionAdapterDigest, mode: plan.mode,
        verifyPrerequisites: () => prerequisitesFor(plan), runProduction: (slot) =>
        {
            spawns++;
            const raw = sampleFor(plan, slot);
            raw.identity.toolchain = digest('changed');
            return raw;
        }, verifyRun: (raw) => raw });
    assert.equal(spawns, 1);
    assert.equal(result.status, 'identity-drift');
    const failed = await cohort.runCpuCalibrationCandidates(plan, { sourceDigest: plan.executionAdapterDigest, mode: plan.mode,
        verifyPrerequisites: () => prerequisitesFor(plan), runProduction: () =>
        {
            throw new Error('producer failed');
        },
        verifyRun: (raw) => raw });
    assert.equal(failed.status, 'incomplete');
    assert.equal(failed.diagnostics[0].message, 'producer failed');
});

test('CPU runner retains malformed original raw result and excludes policy mutation after cohort execution', async () =>
{
    const plan = planFor();
    const malformed = sampleFor(plan, plan.schedule[0]);
    delete malformed.metrics.psi;
    const result = await cohort.runCpuCalibrationCandidates(plan, { sourceDigest: plan.executionAdapterDigest,
        mode: plan.mode, verifyPrerequisites: () => prerequisitesFor(plan), runProduction: () => malformed,
        verifyRun: (raw) => raw });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.diagnostics[0].rawResult, malformed);
    assert.equal(result.diagnostics[0].rawUnavailableReason, null);
    const clean = cleanCohort();
    assert.throws(() => selector.selectCpuCalibration(clean, { ...selector.defaultCpuSelectionPolicy,
        noiseFloorRatio: 0.03 }), /bound before candidate/u);
});
