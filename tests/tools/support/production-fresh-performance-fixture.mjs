import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { captureCohort, ledgerGenesis } = await import(new URL("../../../tools/perf/production-fresh-cohort.mjs", import.meta.url));
const { byteDigest, digest, runSchema, seal } = await import(new URL("../../../tools/perf/production-fresh-contract.mjs", import.meta.url));
const { dispositionDigest, metricRegistry } = await import(new URL("../../../tools/perf/production-fresh-disposition.mjs", import.meta.url));

export function fixture(testContext)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-performance-'));
    testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const put = (locator, value) =>
    {
        const bytes = `${JSON.stringify(value, null, 4)}\n`;
        fs.writeFileSync(path.join(root, locator), bytes);
        return { locator, sha256: byteDigest(bytes) };
    };
    const run = (id, options = {}) =>
    {
        const identity = {
            machineTopology: { machineId: 'machine-A', topologyDigest: digest('topology') },
            effectiveCpuCalibration: { receiptDigest: digest('calibration'), effectiveCpuUnits: 8, finiteBoundaryCpuUnits: 8 },
            os: { name: 'linux', version: '1' }, kernel: { release: '1' }, libc: { name: 'glibc', version: '1' },
            resourceEnforcement: { mode: 'cgroup', policyDigest: digest('enforcement') }, powerPolicy: { mode: 'performance' },
            memoryReserve: { bytes: 1000 }, storage: { deviceId: 'device-A', filesystem: 'ext4' },
            toolchain: { digest: digest('toolchain') }, browser: { digest: digest('browser') }, services: { digest: digest('services') },
            physicalPlan: { steps: [{ bundleId: 'build', stepId: 'compile', cpuHeavy: options.cpuHeavy ?? true }] }, fixtures: { digest: digest('fixtures') }, tests: { digest: digest('tests') },
            collector: { version: '1', sourceDigest: digest('collector') }
        };
        identity.policy = { relativeTolerance: 0.05, benchmarkCvMaximum: 0.1, dispositionDigest };
        for (const [key, value] of Object.entries(options.identity ?? {}))
        {
            identity[key] = { ...identity[key], ...value };
        }
        const binding = { runId: id, attempt: options.attempt ?? 1, sourceDigest: digest('source'),
            buildDigest: digest('build'), planDigest: digest(identity.physicalPlan) };
        const execution = { binding, mode: 'fresh', status: 'success', terminal: true, complete: true,
            resumed: false, retryCount: 0, plannedDigest: binding.planDigest, executedDigest: binding.planDigest,
            ...options.execution };
        const wall = options.wall ?? 1000;
        const critical = options.critical ?? 800;
        const wait = options.wait ?? 100;
        const values = { wallClockMs: wall, criticalPathMs: critical, peakRssBytes: 1000,
            cpuPressure: 0.01, memoryPressure: 0.01, ioPressure: 0.01, actualCpuSeconds: options.actual ?? 6,
            grantedCpuSeconds: 8, voluntaryContextSwitches: 10, involuntaryContextSwitches: 2,
            throttleSeconds: 0, readBytes: 20, writeBytes: 10, averageRssBytes: 500, processSpawnCount: 2,
            idleCapacitySeconds: 2, reservedCpuUnits: 8, load: 1, runnableQueueDepth: 1,
            collectorCpuSeconds: 0.01, collectorNanoseconds: 100 };
        const metrics = Object.entries(values).map(([name, value]) => ({
            bundleId: 'production', stepId: 'run', name, status: 'measured', value
        }));
        metrics.push({ bundleId: 'build', stepId: 'compile', name: 'actualCpuSeconds', status: 'measured', value: options.actual ?? 6 },
            { bundleId: 'build', stepId: 'compile', name: 'grantedCpuSeconds', status: 'measured', value: 8 });
        for (const metric of metrics)
        {
            Object.assign(metric, options.metrics?.[metric.name] ?? {});
        }
        const health = { swapBytes: 0, oomCount: 0, resourceKillCount: 0, thermalValid: true, isolationValid: true,
            benchmarkCv: 0.01, ...options.health };
        const floors = Object.fromEntries(Object.keys(metricRegistry).map(name => [name, name.endsWith('Ms') || name.startsWith('waitMs:') ? 5 : 0.01]));
        Object.assign(floors, options.floors ?? {});
        const noise = { binding, valid: true, complete: true, floors, ...options.noise };
        const items = [];
        const interval = (intervalId, startMs, endMs, kind, detail, authority) =>
        {
            const owner = { intervalId, bundleId: 'build', stepId: 'compile', startMs, endMs };
            const evidence = put(`${id}-${intervalId}-state.json`, { binding, ...owner, authority, kind, detail });
            items.push({ id: intervalId, bundleId: owner.bundleId, stepId: owner.stepId, startMs, endMs, evidence: [evidence] });
        };
        interval('work', 0, critical - wait, 'actual-cpu', { actualCpuSeconds: 2 }, 'resource');
        interval('wait', critical - wait, critical, options.waitKind ?? 'dependency-blocked',
            options.waitDetail ?? { edge: 'build -> evidence' }, options.waitAuthority ?? 'scheduler');
        if (options.intervals)
        {
            options.intervals(items, put, binding);
        }
        const refs = {
            identity: put(`${id}-identity.json`, { binding, values: identity }),
            execution: put(`${id}-execution.json`, execution),
            resource: put(`${id}-resource.json`, { binding, complete: true, health, metrics,
                steps: [{ bundleId: 'build', stepId: 'compile', cpuHeavy: options.cpuHeavy ?? true,
                    samplingComplete: options.samplingComplete ?? true }] }),
            intervals: put(`${id}-intervals.json`, { binding, items }), noise: put(`${id}-noise.json`, noise)
        };
        const receipt = seal({ schema: runSchema, binding, ...refs });
        put(`${id}.json`, receipt);
        return { locator: `${id}.json`, binding, receipt, refs };
    };
    const baseline = (options = {}) =>
    {
        const locators = ['a', 'b', 'c'].map(id => run(id, options).locator);
        const cohort = captureCohort({ root, ledgerLocator: 'ledger.jsonl', runLocators: locators,
            expectedHead: ledgerGenesis, outputLocator: 'cohort.json' });
        return cohort;
    };
    return { root, put, run, baseline };
}
