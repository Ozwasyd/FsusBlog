import { validateCpuCalibrationCohort } from './cpu-calibration-cohort.mjs';
import {
    assertCpuEqual, cpuDigest, defaultCpuSelectionPolicy, exactCpuFields, positiveCpuNumber, sealCpuValue, verifyCpuSeal
} from './cpu-calibration-contract.mjs';

export const cpuCalibrationSelectionSchema = 'fsusblog.effective-cpu-calibration.v1';
export const cpuSelectorVersion = 'fsusblog.cpu-calibration-selector.v1';
export { defaultCpuSelectionPolicy } from './cpu-calibration-contract.mjs';

function quantile(values, probability)
{
    const ordered = [...values].sort((left, right) => left - right);
    const position = (ordered.length - 1) * probability;
    const lower = Math.floor(position);
    return ordered[lower] + (ordered[Math.ceil(position)] - ordered[lower]) * (position - lower);
}

function statistics(candidate, samples)
{
    const valid = samples.filter((sample) => sample.valid && sample.raw.candidate === candidate);
    const values = (field) => valid.map((sample) => sample.raw.metrics[field]);
    return { candidate, count: valid.length, p50: quantile(values('wallClockMs'), 0.5),
        p90: quantile(values('wallClockMs'), 0.9), criticalPathP90: quantile(values('criticalPathMs'), 0.9),
        benchmarkCvP90: quantile(values('benchmarkCv'), 0.9), thermalP50: quantile(values('thermalCelsius'), 0.5),
        frequencyP50: quantile(values('frequencyMHz'), 0.5), vetoReasons: [] };
}

export function selectCpuCalibration(cohort, policy = defaultCpuSelectionPolicy)
{
    validateCpuCalibrationCohort(cohort);
    if (cohort.status !== 'clean')
    {
        throw new Error('explicit complete clean cohort required');
    }
    exactCpuFields(policy, Object.keys(defaultCpuSelectionPolicy), 'CPU selection policy');
    for (const [key, value] of Object.entries(policy))
    {
        positiveCpuNumber(value, key, true);
        if (key !== 'thermalBiasCelsius' && value > 0.25)
        {
            throw new Error('CPU selection tolerance exceeds supported range');
        }
    }
    if (cpuDigest(policy) !== cohort.plan.selectionPolicyDigest)
    {
        throw new Error('selection policy must be bound before candidate execution');
    }
    const stats = cohort.plan.candidates.map((candidate) => statistics(candidate, cohort.samples));
    // The lowest capacity is the conservative reference, never a hand-picked fastest sample.
    const reference = stats[0];
    for (const stat of stats)
    {
        if (stat.p90 > reference.p90 * (1 + policy.p90RegressionRatio))
        {
            stat.vetoReasons.push('p90-regression');
        }
        if (stat.criticalPathP90 > reference.criticalPathP90 * (1 + policy.criticalPathRegressionRatio))
        {
            stat.vetoReasons.push('critical-path-regression');
        }
        if (stat.benchmarkCvP90 > reference.benchmarkCvP90 * (1 + policy.cvRegressionRatio))
        {
            stat.vetoReasons.push('benchmark-cv-regression');
        }
        if (Math.abs(stat.thermalP50 - reference.thermalP50) > policy.thermalBiasCelsius
            || Math.abs(stat.frequencyP50 / reference.frequencyP50 - 1) > policy.frequencyBiasRatio)
        {
            stat.vetoReasons.push('thermal-frequency-bias');
        }
    }
    const eligible = stats.filter((stat) => stat.vetoReasons.length === 0);
    const bestP50 = Math.min(...eligible.map((stat) => stat.p50));
    const deviations = eligible.map((stat) =>
    {
        const values = cohort.samples.filter((sample) => sample.valid && sample.raw.candidate === stat.candidate)
            .map((sample) => Math.abs(sample.raw.metrics.wallClockMs - stat.p50));
        return quantile(values, 0.5);
    });
    const noiseFloorMs = Math.max(bestP50 * policy.noiseFloorRatio, ...deviations);
    const winner = eligible.filter((stat) => stat.p50 <= bestP50 + noiseFloorMs)
        .sort((left, right) => left.candidate - right.candidate)[0];
    return sealCpuValue({ schema: cpuCalibrationSelectionSchema, selectorVersion: cpuSelectorVersion,
        cohortDigest: cohort.contentDigest, identity: cohort.plan.identity, policy, stats, noiseFloorMs,
        effectiveCpuUnits: winner.candidate, confidence: 'clean-cohort', mode: cohort.plan.mode,
        bindingDigest: cpuDigest(cohort.plan.identity) });
}

export function verifyCpuCalibration(selection, cohort)
{
    verifyCpuSeal(selection, cpuCalibrationSelectionSchema);
    assertCpuEqual(selection, selectCpuCalibration(cohort, selection.policy), 'CPU calibration selection');
    return selection;
}
