import {
    assertCpuEqual, cpuAssertDigest, cpuDigest, defaultCpuSelectionPolicy, exactCpuFields, positiveCpuNumber,
    sealCpuValue, validateCpuIdentity, verifyCpuSeal
} from './cpu-calibration-contract.mjs';
import { calculateEffectiveCpuFallback } from './effective-cpu-fallback.mjs';
import { validateCpuMachineIdentity } from './machine-cpu-topology.mjs';

export const cpuCandidatePlanSchema = 'fsusblog.cpu-calibration-candidate-plan.v1';
export const cpuCalibrationSampleSchema = 'fsusblog.cpu-calibration-sample.v1';
export const cpuCalibrationCohortSchema = 'fsusblog.cpu-calibration-cohort.v1';
export const cpuPrerequisiteSchema = 'fsusblog.cpu-calibration-prerequisites.v1';
const metricFields = ['wallClockMs', 'criticalPathMs', 'actualCpuUnits', 'grantedCpuUnits',
    'contextSwitches', 'rssBytes', 'psi', 'swapBytes', 'oomCount', 'resourceKills',
    'thermalCelsius', 'frequencyMHz', 'benchmarkCv'];
const sampleFields = ['sampleId', 'runId', 'candidate', 'identity', 'attempt', 'status', 'retry', 'resume',
    'partial', 'noisy', 'collectorDrift', 'benchmarkIsolation', 'exactness', 'metrics',
    'terminalSummaryDigest', 'correctnessDigest', 'uptakeDigest', 'immutableInputDigests'];

export function createCpuCandidatePlan({ topology, identity, rounds = 3, executionAdapterDigest, mode = 'production', selectionPolicyDigest = cpuDigest(defaultCpuSelectionPolicy) })
{
    validateCpuIdentity(identity);
    const fallback = calculateEffectiveCpuFallback(topology, identity.topology);
    validateCpuMachineIdentity(topology, identity);
    cpuAssertDigest(executionAdapterDigest, 'executionAdapterDigest');
    cpuAssertDigest(selectionPolicyDigest, 'selectionPolicyDigest');
    if (!Number.isSafeInteger(rounds) || rounds < 3 || rounds > 30 || !['production', 'contract-fixture'].includes(mode))
    {
        throw new Error('candidate rounds/mode invalid');
    }
    const upper = Math.floor(Math.min(fallback.allowedLogicalCpuCount, fallback.verifiedFiniteCpuLimitCores));
    if (upper < 3)
    {
        throw new Error('finite boundary cannot support upper candidate plus two lower capacities');
    }
    const candidates = [...new Set([Math.max(1, Math.floor(upper * 0.5)), Math.max(2, Math.floor(upper * 0.75)), upper])];
    if (candidates.length !== 3)
    {
        throw new Error('three distinct candidates required');
    }
    const schedule = [];
    for (let round = 0; round < rounds; round++)
    {
        for (let slot = 0; slot < candidates.length; slot++)
        {
            schedule.push({ sampleId: `r${round + 1}-s${slot + 1}`, round: round + 1,
                candidate: candidates[(slot + round) % candidates.length] });
        }
    }
    return sealCpuValue({ schema: cpuCandidatePlanSchema, topology, identity, rounds,
        executionAdapterDigest, mode, selectionPolicyDigest, candidates, schedule });
}

export function validateCpuCandidatePlan(plan)
{
    verifyCpuSeal(plan, cpuCandidatePlanSchema);
    assertCpuEqual(plan, createCpuCandidatePlan(plan), 'CPU candidate plan');
    return plan;
}

export function qualifyCpuSample(raw, plan, slot)
{
    exactCpuFields(raw, sampleFields, 'CPU sample');
    validateCpuIdentity(raw.identity);
    if (raw.sampleId !== slot.sampleId || raw.candidate !== slot.candidate || typeof raw.runId !== 'string' || !raw.runId)
    {
        throw new Error('sample ID/candidate/run mismatch');
    }
    if (!['clean-success', 'failed', 'cancelled', 'timed-out'].includes(raw.status)
        || !Number.isSafeInteger(raw.attempt) || raw.attempt < 1)
    {
        throw new Error('sample terminal status/attempt malformed');
    }
    for (const key of ['retry', 'resume', 'partial', 'noisy', 'collectorDrift', 'benchmarkIsolation', 'exactness'])
    {
        if (typeof raw[key] !== 'boolean')
        {
            throw new Error(`sample ${key} must be boolean`);
        }
    }
    exactCpuFields(raw.metrics, metricFields, 'CPU sample metrics');
    for (const [key, value] of Object.entries(raw.metrics))
    {
        positiveCpuNumber(value, `metrics.${key}`, !['wallClockMs', 'criticalPathMs', 'frequencyMHz', 'grantedCpuUnits'].includes(key));
    }
    for (const key of ['terminalSummaryDigest', 'correctnessDigest', 'uptakeDigest'])
    {
        cpuAssertDigest(raw[key], key);
    }
    if (!Array.isArray(raw.immutableInputDigests))
    {
        throw new Error('immutable input reuse must be explicit');
    }
    for (const value of raw.immutableInputDigests)
    {
        cpuAssertDigest(value, 'immutable input digest');
    }
    const reasons = [];
    if (cpuDigest(raw.identity) !== cpuDigest(plan.identity))
    {
        reasons.push('identity-drift');
    }
    if (raw.status !== 'clean-success')
    {
        reasons.push(`terminal-${raw.status}`);
    }
    if (raw.attempt !== 1 || raw.retry || raw.resume || raw.partial)
    {
        reasons.push('not-clean-first-attempt');
    }
    if (raw.noisy || raw.collectorDrift)
    {
        reasons.push('noisy-or-collector-drift');
    }
    if (raw.metrics.swapBytes || raw.metrics.oomCount || raw.metrics.resourceKills)
    {
        reasons.push('swap-oom-resource-kill');
    }
    if (!raw.exactness || !raw.benchmarkIsolation)
    {
        reasons.push('exactness-or-isolation');
    }
    if (raw.metrics.grantedCpuUnits !== raw.candidate || raw.metrics.actualCpuUnits > raw.metrics.grantedCpuUnits
        || raw.metrics.criticalPathMs > raw.metrics.wallClockMs)
    {
        reasons.push('measurement-envelope');
    }
    return sealCpuValue({ schema: cpuCalibrationSampleSchema, raw, reasons, valid: reasons.length === 0 });
}

function validatePrerequisites(receipt, plan)
{
    verifyCpuSeal(receipt, cpuPrerequisiteSchema);
    exactCpuFields(receipt, ['schema', 'identityDigest', 'adapterDigest', 'mode', 'finalizerDigest',
        'uptakeDigest', 'qualified', 'contentDigest'], 'calibration prerequisites');
    for (const field of ['identityDigest', 'adapterDigest', 'finalizerDigest', 'uptakeDigest'])
    {
        cpuAssertDigest(receipt[field], field);
    }
    if (receipt.qualified !== true || receipt.identityDigest !== cpuDigest(plan.identity)
        || receipt.adapterDigest !== plan.executionAdapterDigest || receipt.mode !== plan.mode)
    {
        throw new Error('canonical finalizer/live-grant uptake prerequisite unavailable');
    }
}

export function sealCpuCalibrationCohort(plan, prerequisites, samples, diagnostics = [])
{
    validateCpuCandidatePlan(plan);
    validatePrerequisites(prerequisites, plan);
    if (!Array.isArray(samples) || !Array.isArray(diagnostics))
    {
        throw new Error('cohort samples/diagnostics must be arrays');
    }
    const seenRuns = new Set();
    const seenEvidence = new Set();
    const validCounts = Object.fromEntries(plan.candidates.map((candidate) => [candidate, 0]));
    for (const [index, sample] of samples.entries())
    {
        const slot = plan.schedule[index];
        if (!slot)
        {
            throw new Error('extra cohort sample');
        }
        verifyCpuSeal(sample, cpuCalibrationSampleSchema);
        assertCpuEqual(sample, qualifyCpuSample(sample.raw, plan, slot), 'CPU sample');
        if (seenRuns.has(sample.raw.runId) || seenEvidence.has(sample.raw.correctnessDigest)
            || seenEvidence.has(sample.raw.terminalSummaryDigest))
        {
            throw new Error('duplicate run or reused correctness/terminal evidence');
        }
        seenRuns.add(sample.raw.runId);
        seenEvidence.add(sample.raw.correctnessDigest);
        seenEvidence.add(sample.raw.terminalSummaryDigest);
        if (sample.valid)
        {
            validCounts[sample.raw.candidate]++;
        }
    }
    const drift = samples.some((sample) => sample.reasons.includes('identity-drift'));
    const clean = samples.length === plan.schedule.length && !drift
        && Object.values(validCounts).every((count) => count >= 3) && diagnostics.length === 0;
    return sealCpuValue({ schema: cpuCalibrationCohortSchema, plan, prerequisites, samples, diagnostics,
        validCounts, status: clean ? 'clean' : drift ? 'identity-drift' : 'incomplete' });
}

export function validateCpuCalibrationCohort(cohort)
{
    verifyCpuSeal(cohort, cpuCalibrationCohortSchema);
    assertCpuEqual(cohort, sealCpuCalibrationCohort(cohort.plan, cohort.prerequisites, cohort.samples, cohort.diagnostics), 'CPU cohort');
    return cohort;
}

/** Adapter must validate actual upstream terminal receipts, not status/configuration existence. */
export async function runCpuCalibrationCandidates(plan, adapter, persist = async () =>
{})
{
    validateCpuCandidatePlan(plan);
    if (adapter?.sourceDigest !== plan.executionAdapterDigest || adapter.mode !== plan.mode
        || typeof adapter.verifyPrerequisites !== 'function' || typeof adapter.runProduction !== 'function'
        || typeof adapter.verifyRun !== 'function')
    {
        throw new Error('exact tested Production adapter required');
    }
    const prerequisites = await adapter.verifyPrerequisites(plan);
    validatePrerequisites(prerequisites, plan);
    const samples = [];
    const diagnostics = [];
    await persist(sealCpuCalibrationCohort(plan, prerequisites, samples, diagnostics));
    for (const slot of plan.schedule)
    {
        let capturedResult = null;
        try
        {
            const result = await adapter.runProduction(Object.freeze({ ...slot, planDigest: plan.contentDigest,
                identity: plan.identity, mode: plan.mode }));
            capturedResult = result;
            const raw = await adapter.verifyRun(result, plan, slot);
            capturedResult = raw;
            const sample = qualifyCpuSample(raw, plan, slot);
            samples.push(sample);
            await persist(sealCpuCalibrationCohort(plan, prerequisites, samples, diagnostics));
            if (sample.reasons.includes('identity-drift'))
            {
                break;
            }
        }
        catch (error)
        {
            let rawUnavailableReason = null;
            try
            {
                cpuDigest(capturedResult);
            }
            catch
            {
                capturedResult = null;
                rawUnavailableReason = 'adapter result is not canonical JSON';
            }
            diagnostics.push({ sampleId: slot.sampleId, message: String(error.message),
                rawResult: capturedResult, rawUnavailableReason });
            break;
        }
    }
    const cohort = sealCpuCalibrationCohort(plan, prerequisites, samples, diagnostics);
    await persist(cohort);
    return cohort;
}
