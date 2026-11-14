import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { digestJson } = await import(new URL('../../../tools/resource-model/contract.mjs', import.meta.url));
const { recommendCpu } = await import(new URL('../../../tools/resource-model/cpu-recommendations.mjs', import.meta.url));
const { recommendMemory } = await import(new URL('../../../tools/resource-model/memory-recommendations.mjs', import.meta.url));
const { createModelBundle, shadowModel } = await import(new URL('../../../tools/resource-model/model-lifecycle.mjs', import.meta.url));
const {
    appendSampleCandidate, createSampleCandidate, emptyLedgerHead, evidenceRoles
} = await import(new URL('../../../tools/resource-model/sample-ledger.mjs', import.meta.url));
const { recommendStartup } = await import(new URL('../../../tools/resource-model/startup-recommendations.mjs', import.meta.url));

export function fixture(context, { count = 5, capacity: capacityOverrides = {}, row: rowOverrides = {},
    defaults: defaultOverrides = {} } = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-resource-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const capacity = {
        effectiveCpuUnits: 8, minimumSupportedCpuUnits: 4, totalMemoryGiB: 16,
        absoluteReserveFloorGiB: 2, proportionalReserveFloor: 0.1,
        maxConcurrentInstances: { alpha: 1, beta: 1 }, ...capacityOverrides
    };
    const identity = {
        machineId: 'fixture-host-instance-A', physicalPlanDigest: digestJson({ producers: ['alpha', 'beta'] }),
        producerMembershipDigest: digestJson(['alpha', 'beta']), capacityDigest: digestJson(capacity),
        metricSchemaDigest: digestJson('fixture-metrics-v1'), testMembershipDigest: digestJson(['test-a', 'test-b'])
    };
    const defaults = ['alpha', 'beta'].map((producerId) => ({
        producerId, cpuWeight: 2, minCpuUnits: 1, cpuUnits: 4, memoryGiB: 4,
        startupPriority: 0, benchmark: false, ...defaultOverrides[producerId]
    }));
    const observations = ['alpha', 'beta'].map((producerId) => ({
        producerId, actualCpuUnits: 2, grantedCpuUnits: 2, grantEfficiency: 1,
        capacityBlockedMs: 1000, throttledMs: 0, peakRssGiB: 2, memoryPsi: 0, majorFaults: 0,
        readyAt: 100, firstProductiveChildAt: 200, startupCapacityBlockedMs: 1000,
        downstreamUnlockValue: 4, startupCpuUnits: 1, startupMemoryGiB: 1, queueAgeMs: 1000,
        lifetimeMs: 10000, criticalPath: true, waitClass: 'cpu', attribution: 'step',
        gcPressure: null, allocationPressure: null, ...rowOverrides[producerId]
    }));
    const evidenceRoot = path.join(root, 'evidence');
    const directory = path.join(root, 'ledger');
    fs.mkdirSync(evidenceRoot);
    let head = emptyLedgerHead(identity);
    const samples = [];
    const writeInput = (ref, document) =>
    {
        fs.writeFileSync(path.join(evidenceRoot, ref), JSON.stringify(document));
        return { ref, digest: digestJson(document) };
    };
    const makeSample = (index, mutate = () =>
    {}) =>
    {
        const runId = `learning-${index}`;
        const attemptId = `${runId}-attempt-1`;
        const facts = {
            run: { status: 'passed', fresh: true, resumed: false, attemptOrdinal: 1, complete: true,
                calibrated: true, correctnessPassed: true },
            plan: { producerIds: ['alpha', 'beta'], planned: ['test-a', 'test-b'], executed: ['test-a', 'test-b'] },
            resource: { complete: true, unsupportedRequiredMetrics: 0, swap: 0, oom: 0, resourceKills: 0,
                observations: structuredClone(observations) },
            performance: { verdict: 'pass', evaluable: true, terminal: true },
            collector: { complete: true, drift: false }, enforcement: { complete: true, drift: false },
            benchmark: { isolationValid: true, cvValid: true },
            noise: { thermalInvalid: false, externalNoiseInvalid: false }
        };
        mutate(facts);
        const receipts = Object.fromEntries(evidenceRoles.map((role) => [role, writeInput(`${runId}-${role}.json`, {
            schema: 'fsusblog.adaptive.observation-input.v1', authority: 'DATA_ONLY',
            role, identity, runId, attemptId, facts: facts[role]
        })]));
        return { identity, runId, attemptId, receipts, evidenceRoot };
    };
    for (let index = 0; index < count; index += 1)
    {
        const sample = createSampleCandidate(makeSample(index));
        samples.push(sample);
        head = appendSampleCandidate({ directory, head, sample, identity, evidenceRoot });
    }
    const ledger = { directory, head, identity, evidenceRoot };
    const inputs = { ledger, defaults, capacity };
    return { root, evidenceRoot, directory, head, identity, defaults, capacity, observations,
        samples, inputs, makeSample, writeInput };
}

export function ready(producerId, overrides = {})
{
    return {
        producerId, readyAt: 100, dependenciesSatisfied: true, markersSealed: true,
        cpuFeasible: true, memoryFeasible: true, exclusiveAvailable: true, filesystemOrdered: true,
        stateConflictFree: true, outputConflictFree: true, benchmarkAllowed: true, ...overrides
    };
}

export function modelFixture(context, options = {})
{
    const history = fixture(context, options);
    const cpu = recommendCpu(history.inputs);
    const memory = recommendMemory(history.inputs);
    const startup = recommendStartup({ ...history.inputs, identity: history.identity,
        candidates: [ready('alpha'), ready('beta')], now: 1000 });
    const model = createModelBundle({ cpu, memory, startup, defaults: history.defaults });
    const actualDecisions = history.defaults.map((item) => ({
        producerId: item.producerId, cpuUnits: item.cpuUnits, memoryGiB: item.memoryGiB,
        startupPriority: item.startupPriority
    }));
    const shadow = shadowModel({ model, identity: history.identity, actualDecisions });
    const confirmations = (mutate = () =>
    {}, prefix = 'confirmation') => [0, 1, 2].map((index) =>
    {
        const runId = `${prefix}-${index}`;
        const attemptId = `${runId}-attempt-1`;
        const performanceLocator = history.writeInput(`${runId}-performance.json`, {
            schema: 'fsusblog.adaptive.observation-input.v1', authority: 'DATA_ONLY',
            role: 'performance', identity: history.identity, runId, attemptId,
            facts: { verdict: 'pass', evaluable: true, terminal: true }
        });
        const exactness = Object.fromEntries(['correctnessDigest', 'testDigest', 'coverageDigest', 'measurementDigest']
            .map((field) => [field, digestJson(field)]));
        const document = {
            schema: 'fsusblog.adaptive.confirmation-input.v1', authority: 'DATA_ONLY',
            identity: history.identity, modelDigest: model.digest, shadowDigest: shadow.digest,
            runId, attemptId, performanceLocator, fresh: true, attemptOrdinal: 1, resumed: false,
            swap: 0, oom: 0, resourceKills: 0, baselineWallMs: 1000, currentWallMs: 900,
            baselineCv: 0.02, currentCv: 0.02, benchmarkIsolationValid: true,
            baseline: { ...exactness }, current: { ...exactness }
        };
        mutate(document, index);
        return history.writeInput(`${runId}.json`, document);
    });
    return { ...history, model, shadow, actualDecisions, confirmations,
        modelDirectory: path.join(history.root, 'models') };
}
