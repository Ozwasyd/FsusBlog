import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const contract = await import(new URL('../../tools/test/cpu-calibration-contract.mjs', import.meta.url));
const topology = await import(new URL('../../tools/test/machine-cpu-topology.mjs', import.meta.url));
const cohort = await import(new URL('../../tools/test/cpu-calibration-cohort.mjs', import.meta.url));
const selector = await import(new URL('../../tools/test/cpu-calibration-selection.mjs', import.meta.url));

export { contract, topology, cohort, selector };
export const observed = (value) => ({ disposition: 'observed', reason: null, value });
export const unavailable = (reason = 'fixture-unavailable') => ({ disposition: 'unknown', reason, value: null });
export const digest = (value) => contract.cpuDigest(value);

export function rawTopology({ logical = 16, quota = '1200000', period = '100000', physical = true,
    platform = 'linux', allowed = null, cpuset = null, smt = true } = {})
{
    const visible = allowed ?? `0-${logical - 1}`;
    const kind = platform === 'win32' ? 'windows-job' : 'linux-cgroup-v2';
    return { platform, arch: 'x64', kernel: 'fixture-kernel', machineIdentityDigest: digest('fixture-machine'),
        sources: { host: observed(`0-${logical - 1}`), online: observed(`0-${logical - 1}`), allowed: observed(visible),
            cpuset: observed(cpuset ?? visible), power: observed('fixture-performance-policy'),
            boundary: observed({ kind, ancestryComplete: true, limits: [{ locator: 'fixture-boundary', quota, period }] }),
            cores: physical ? observed(Array.from({ length: logical }, (_, cpu) => ({ cpu,
                package: '0', core: String(smt ? Math.floor(cpu / 2) : cpu),
                siblings: smt ? `${Math.floor(cpu / 2) * 2}-${Math.min(logical - 1, Math.floor(cpu / 2) * 2 + 1)}` : String(cpu),
                numa: observed('node0'), coreClass: observed(cpu < logical / 2 ? 'performance' : 'efficiency') }))) : unavailable() } };
}

export function machine(options)
{
    return topology.buildMachineCpuTopology(rawTopology(options));
}

export function identityFor(machineReceipt)
{
    const identity = Object.fromEntries(contract.cpuIdentityFields.map((field) => [field, digest(field)]));
    return { ...identity, machine: machineReceipt.raw.machineIdentityDigest, topology: machineReceipt.topologyDigest,
        finiteBoundary: digest(machineReceipt.projection.finiteBoundary), platform: digest(machineReceipt.raw.platform),
        arch: digest(machineReceipt.raw.arch), kernel: digest(machineReceipt.raw.kernel), powerPolicy: digest(machineReceipt.projection.power) };
}

export function planFor(options = {})
{
    const machineReceipt = machine(options);
    return cohort.createCpuCandidatePlan({ topology: machineReceipt, identity: identityFor(machineReceipt),
        executionAdapterDigest: digest('fixture-adapter'), mode: options.mode ?? 'contract-fixture', rounds: options.rounds ?? 3 });
}

export function prerequisitesFor(plan)
{
    return contract.sealCpuValue({ schema: cohort.cpuPrerequisiteSchema, identityDigest: digest(plan.identity),
        adapterDigest: plan.executionAdapterDigest, mode: plan.mode, finalizerDigest: digest('fixture-finalizer'),
        uptakeDigest: digest('fixture-uptake'), qualified: true });
}

export function sampleFor(plan, slot, metrics = {})
{
    return { sampleId: slot.sampleId, runId: `fixture-${slot.sampleId}`, candidate: slot.candidate,
        identity: structuredClone(plan.identity), attempt: 1, status: 'clean-success', retry: false, resume: false,
        partial: false, noisy: false, collectorDrift: false, benchmarkIsolation: true, exactness: true,
        metrics: { wallClockMs: 1000 - slot.candidate * 10, criticalPathMs: 500,
            actualCpuUnits: slot.candidate * 0.8, grantedCpuUnits: slot.candidate,
            contextSwitches: 100, rssBytes: 10000, psi: 0.1, swapBytes: 0, oomCount: 0, resourceKills: 0,
            thermalCelsius: 60, frequencyMHz: 3000, benchmarkCv: 0.01, ...metrics },
        terminalSummaryDigest: digest(`terminal-${slot.sampleId}`), correctnessDigest: digest(`correctness-${slot.sampleId}`),
        uptakeDigest: digest(`uptake-${slot.sampleId}`), immutableInputDigests: [] };
}

export function cleanCohort(plan = planFor(), transform = (raw) => raw)
{
    const samples = plan.schedule.map((slot) => cohort.qualifyCpuSample(transform(sampleFor(plan, slot), slot), plan, slot));
    return cohort.sealCpuCalibrationCohort(plan, prerequisitesFor(plan), samples);
}

export function writeActivationFixture(testContext, plan = planFor({ mode: 'production' }), transform)
{
    // A production-shaped fixture tests loader contracts only; it is not a real Production receipt.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cpu-contract-'));
    testContext.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const clean = cleanCohort(plan, transform);
    const selected = selector.selectCpuCalibration(clean);
    const store = (receipt) =>
    {
        const locator = path.join(directory, `${receipt.contentDigest.slice(7)}.json`);
        fs.writeFileSync(locator, JSON.stringify(receipt), { flag: 'wx' });
        return locator;
    };
    const reference = { cohortLocator: store(clean), cohortDigest: clean.contentDigest,
        calibrationLocator: store(selected), calibrationDigest: selected.contentDigest };
    return { directory, pointerPath: path.join(directory, 'active.json'), reference, plan, clean, selected };
}
