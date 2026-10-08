import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanCohort, cohort, contract, digest, planFor, selector } from './cpu-calibration-test-support.mjs';

test('CPU selection ranks full wall clock median and permits a clear logical upper winner', () =>
{
    const clean = cleanCohort();
    const selection = selector.selectCpuCalibration(clean);
    assert.equal(selection.effectiveCpuUnits, 12);
    assert.equal(selection.stats.length, 3);
    selector.verifyCpuCalibration(selection, clean);
    assert.equal('cpuUtilization' in selection, false);
});

test('CPU selection picks lower capacity in noise band and ignores fastest isolated outlier', () =>
{
    const tied = cleanCohort(planFor(), (raw) => ({ ...raw, metrics: { ...raw.metrics,
        wallClockMs: raw.candidate === 6 ? 1000 : 990 } }));
    assert.equal(selector.selectCpuCalibration(tied).effectiveCpuUnits, 6);
    const outlier = cleanCohort(planFor(), (raw, slot) => ({ ...raw, metrics: { ...raw.metrics,
        criticalPathMs: 40, wallClockMs: slot.candidate === 12 ? slot.round === 1 ? 50 : 1100 : 1000 } }));
    assert.equal(selector.selectCpuCalibration(outlier).effectiveCpuUnits, 6);
});

test('CPU selection vetoes faster median with p90 critical path benchmark CV or thermal frequency bias', () =>
{
    for (const change of [{ criticalPathMs: 510 }, { benchmarkCv: 0.02 }, { thermalCelsius: 75 }, { frequencyMHz: 3400 }])
    {
        const clean = cleanCohort(planFor(), (raw) => raw.candidate === 12
            ? { ...raw, metrics: { ...raw.metrics, ...change } } : raw);
        const selection = selector.selectCpuCalibration(clean);
        assert.notEqual(selection.effectiveCpuUnits, 12);
        assert.ok(selection.stats.find((stat) => stat.candidate === 12).vetoReasons.length);
    }
    const tail = cleanCohort(planFor(), (raw, slot) => ({ ...raw, metrics: { ...raw.metrics,
        wallClockMs: slot.candidate === 12 ? slot.round === 3 ? 2000 : 700 : 1000 } }));
    const selection = selector.selectCpuCalibration(tail);
    assert.equal(selection.effectiveCpuUnits, 6);
    assert.deepEqual(selection.stats[2].vetoReasons, ['p90-regression']);
});

test('CPU selection rejects invalid missing samples tampered raw receipts and changed sealed decision', () =>
{
    const clean = cleanCohort();
    const invalid = cleanCohort(clean.plan, (raw) => ({ ...raw, metrics: { ...raw.metrics, swapBytes: 1 } }));
    assert.throws(() => selector.selectCpuCalibration(invalid), /clean cohort/u);
    assert.throws(() => cohort.sealCpuCalibrationCohort(clean.plan, clean.prerequisites, clean.samples.slice(1)), /sample ID/u);
    const missing = cohort.sealCpuCalibrationCohort(clean.plan, clean.prerequisites, clean.samples.slice(0, -1));
    assert.equal(missing.status, 'incomplete');
    const tampered = structuredClone(clean);
    tampered.samples[0].raw.metrics.wallClockMs = 10;
    assert.throws(() => selector.selectCpuCalibration(tampered), /digest/u);
    const selected = selector.selectCpuCalibration(clean);
    const body = structuredClone(selected);
    delete body.contentDigest;
    const changed = contract.sealCpuValue({ ...body, effectiveCpuUnits: 6 });
    assert.throws(() => selector.verifyCpuCalibration(changed, clean), /recomputation/u);
    assert.throws(() => selector.selectCpuCalibration(clean, { ...selector.defaultCpuSelectionPolicy, noiseFloorRatio: 0.9 }), /range/u);
    assert.notEqual(digest(selected.identity), digest({ ...selected.identity, tests: digest('other') }));
});
