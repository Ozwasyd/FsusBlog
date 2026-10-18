import fs from 'node:fs';
import path from 'node:path';

import {
    digestJson, finite, quantile, readEvidence, requireCondition, requireProductionAuthority,
    sameIdentity, seal, syncDirectory, verifySeal, withWriterLock, writeImmutable
} from './contract.mjs';
import { cpuSchema } from './cpu-recommendations.mjs';
import { memorySchema } from './memory-recommendations.mjs';
import { startupSchema } from './startup-recommendations.mjs';

export const modelSchema = 'fsusblog.adaptive.model-candidate.v1';
export const pointerSchema = 'fsusblog.adaptive.candidate-pointer.v1';
export const terminalSchema = 'fsusblog.adaptive.lifecycle-terminal.v1';

function sortedDefaults(defaults)
{
    return structuredClone(defaults).sort((left, right) => left.producerId.localeCompare(right.producerId));
}

/** Bundles retain exact recommendation payloads and their independent source digests. */
export function createModelBundle({ cpu, memory, startup, defaults })
{
    const orderedDefaults = sortedDefaults(defaults);
    for (const [document, schema] of [[cpu, cpuSchema], [memory, memorySchema], [startup, startupSchema]])
    {
        verifySeal(document, schema);
        sameIdentity(document.identity, cpu.identity, schema);
        requireCondition(digestJson(document.ledgerHead) === digestJson(cpu.ledgerHead)
            && document.defaultsDigest === digestJson(orderedDefaults)
            && digestJson(document.learningRunIds) === digestJson(cpu.learningRunIds)
            && digestJson(document.capacity) === cpu.identity.capacityDigest,
        'recommendation-source-drift', schema);
    }
    const model = seal({
        schema: modelSchema, authority: 'DATA_ONLY', identity: cpu.identity, ledgerHead: cpu.ledgerHead,
        defaults: orderedDefaults, defaultsDigest: digestJson(orderedDefaults),
        learningRunIds: structuredClone(cpu.learningRunIds),
        recommendations: { cpu, memory, startup },
        recommendationDigests: { cpu: cpu.digest, memory: memory.digest, startup: startup.digest }
    });
    validateModelBundle(model, cpu.identity);
    return model;
}

/** Feasibility is recomputed rather than accepted from a caller-supplied flag. */
export function validateModelBundle(model, identity)
{
    verifySeal(model, modelSchema);
    sameIdentity(model.identity, identity, 'model.identity');
    const { cpu, memory, startup } = model.recommendations;
    const defaults = sortedDefaults(model.defaults);
    requireCondition(model.defaultsDigest === digestJson(defaults), 'defaults-drift', 'model.defaults');
    requireCondition(Number.isSafeInteger(model.ledgerHead?.count) && model.ledgerHead.count >= 0
        && Array.isArray(model.learningRunIds) && model.learningRunIds.length === model.ledgerHead.count
        && new Set(model.learningRunIds).size === model.learningRunIds.length
        && model.learningRunIds.every((runId) => typeof runId === 'string' && runId.length > 0),
    'invalid-learning-membership', 'model');
    for (const [key, document, schema] of [
        ['cpu', cpu, cpuSchema], ['memory', memory, memorySchema], ['startup', startup, startupSchema]
    ])
    {
        verifySeal(document, schema);
        sameIdentity(document.identity, identity, schema);
        requireCondition(document.digest === model.recommendationDigests[key]
            && document.defaultsDigest === model.defaultsDigest
            && digestJson(document.ledgerHead) === digestJson(model.ledgerHead)
            && digestJson(document.learningRunIds) === digestJson(model.learningRunIds)
            && digestJson(document.capacity) === identity.capacityDigest,
        'recommendation-source-drift', schema);
        for (const row of document.recommendations)
        {
            finite(row.confidence, 'recommendation.confidence');
            requireCondition(row.confidence <= 1 && Number.isSafeInteger(row.sampleCount)
                && row.sampleCount === model.ledgerHead.count, 'invalid-confidence', schema);
        }
    }
    const ids = defaults.map((item) => item.producerId);
    requireCondition(new Set(ids).size === ids.length && digestJson([...ids].sort()) === identity.producerMembershipDigest,
        'producer-drift', 'model.defaults');
    for (const document of [cpu, memory])
    {
        requireCondition(document.recommendations.length === ids.length
            && digestJson(document.recommendations.map((row) => row.producerId).sort()) === digestJson([...ids].sort()),
        'producer-drift', document.schema);
    }
    requireCondition(new Set(startup.recommendations.map((row) => row.producerId)).size === startup.recommendations.length
        && startup.recommendations.every((row) => ids.includes(row.producerId)),
    'producer-drift', startup.schema);
    let totalCpu = 0;
    let totalMinimum = 0;
    let totalMemory = 0;
    const capacity = cpu.capacity;
    for (const previous of defaults)
    {
        const cpuRow = cpu.recommendations.find((row) => row.producerId === previous.producerId);
        const memoryRow = memory.recommendations.find((row) => row.producerId === previous.producerId);
        finite(cpuRow.recommendedCpuWeight, 'model.cpuWeight', 0.001);
        finite(cpuRow.recommendedMinCpuUnits, 'model.minCpuUnits', 1);
        finite(cpuRow.recommendedCpuUnits, 'model.cpuUnits', cpuRow.recommendedMinCpuUnits);
        requireCondition(Number.isSafeInteger(cpuRow.recommendedMinCpuUnits), 'invalid-minimum', previous.producerId);
        finite(memoryRow.recommendedMemoryGiB, 'model.memoryGiB', 0.001);
        requireCondition(cpuRow.decision === (cpuRow.recommendedCpuWeight === previous.cpuWeight
            && cpuRow.recommendedMinCpuUnits === previous.minCpuUnits
            && cpuRow.recommendedCpuUnits === previous.cpuUnits ? 'no-change' : 'recommend')
            && memoryRow.decision === (memoryRow.recommendedMemoryGiB === previous.memoryGiB ? 'no-change' : 'recommend'),
        'false-no-change', previous.producerId);
        totalCpu += cpuRow.recommendedCpuUnits;
        totalMinimum += cpuRow.recommendedMinCpuUnits;
        const instances = capacity.maxConcurrentInstances?.[previous.producerId];
        requireCondition(Number.isSafeInteger(instances) && instances >= 1,
            'invalid-concurrency-envelope', previous.producerId);
        totalMemory += memoryRow.recommendedMemoryGiB * (memoryRow.attribution === 'resident' ? 1 : instances);
        if (previous.benchmark)
        {
            requireCondition(cpuRow.recommendedCpuWeight === previous.cpuWeight
                && cpuRow.recommendedMinCpuUnits === previous.minCpuUnits
                && cpuRow.recommendedCpuUnits === previous.cpuUnits
                && memoryRow.recommendedMemoryGiB === previous.memoryGiB,
            'benchmark-grant-drift', previous.producerId);
        }
    }
    for (const row of startup.recommendations)
    {
        finite(row.recommendedStartupPriority, 'model.startupPriority');
        const previous = defaults.find((item) => item.producerId === row.producerId);
        requireCondition(row.decision === (row.recommendedStartupPriority === previous.startupPriority
            ? 'no-change' : 'recommend'), 'false-no-change', row.producerId);
    }
    const expectedReserve = Math.max(capacity.absoluteReserveFloorGiB,
        capacity.totalMemoryGiB * capacity.proportionalReserveFloor);
    requireCondition(memory.recommendedSystemReserveGiB === expectedReserve
        && expectedReserve > 0 && totalMemory + expectedReserve <= capacity.totalMemoryGiB,
    'infeasible-memory-envelope', 'model');
    requireCondition(totalCpu <= capacity.effectiveCpuUnits + 1e-9
        && totalMinimum <= capacity.minimumSupportedCpuUnits, 'infeasible-cpu-envelope', 'model');
    return model;
}

function isNoChange(model)
{
    return Object.values(model.recommendations)
        .every((document) => document.recommendations.every((row) => row.decision === 'no-change'));
}

function highConfidence(model)
{
    return Object.values(model.recommendations).every((document) => document.recommendations
        .every((row) => row.sampleCount >= 5 && row.confidence >= 0.8));
}

/** Pure shadow projection never imports or calls the scheduler. */
export function shadowModel({ model, identity, actualDecisions })
{
    validateModelBundle(model, identity);
    requireCondition(Array.isArray(actualDecisions)
        && new Set(actualDecisions.map((row) => row.producerId)).size === actualDecisions.length,
    'invalid-decisions', 'actualDecisions');
    const cpu = model.recommendations.cpu.recommendations;
    const memory = model.recommendations.memory.recommendations;
    const startup = model.recommendations.startup.recommendations;
    const differences = actualDecisions.map((actual) =>
    {
        const previous = model.defaults.find((row) => row.producerId === actual.producerId);
        requireCondition(previous, 'unknown-producer', actual.producerId);
        const cpuRow = cpu.find((row) => row.producerId === actual.producerId);
        const memoryRow = memory.find((row) => row.producerId === actual.producerId);
        const startupRow = startup.find((row) => row.producerId === actual.producerId);
        const alternative = {
            ...actual,
            cpuUnits: previous.benchmark ? actual.cpuUnits : cpuRow.recommendedCpuUnits,
            memoryGiB: previous.benchmark ? actual.memoryGiB : memoryRow.recommendedMemoryGiB,
            startupPriority: startupRow?.recommendedStartupPriority ?? actual.startupPriority
        };
        return { producerId: actual.producerId, actual: structuredClone(actual), wouldGrant: alternative,
            wouldAdmitRank: startupRow ? startup.indexOf(startupRow) : null,
            changed: digestJson(actual) !== digestJson(alternative) };
    });
    return seal({
        schema: 'fsusblog.adaptive.shadow-candidate.v1', authority: 'DATA_ONLY',
        identity: structuredClone(identity), modelDigest: model.digest, schedulerMutationCount: 0, differences
    });
}

/** Three independently identified DATA_ONLY confirmation inputs provide candidate evaluation only. */
export function evaluateActivationCandidate({ model, identity, shadow, confirmationLocators, evidenceRoot })
{
    validateModelBundle(model, identity);
    verifySeal(shadow, 'fsusblog.adaptive.shadow-candidate.v1');
    sameIdentity(shadow.identity, identity, 'shadow.identity');
    requireCondition(shadow.modelDigest === model.digest && shadow.schedulerMutationCount === 0,
        'shadow-drift', 'shadow');
    const reasons = [];
    const confirmations = confirmationLocators.map((locator) =>
    {
        const document = readEvidence(evidenceRoot, locator);
        requireCondition(document.schema === 'fsusblog.adaptive.confirmation-input.v1'
            && document.authority === 'DATA_ONLY', 'invalid-confirmation', locator.ref);
        sameIdentity(document.identity, identity, locator.ref);
        requireCondition(document.modelDigest === model.digest && document.shadowDigest === shadow.digest,
            'confirmation-model-drift', locator.ref);
        const performance = readEvidence(evidenceRoot, document.performanceLocator);
        sameIdentity(performance.identity, identity, document.performanceLocator.ref);
        requireCondition(performance.schema === 'fsusblog.adaptive.observation-input.v1'
            && performance.authority === 'DATA_ONLY' && performance.role === 'performance'
            && performance.runId === document.runId && performance.attemptId === document.attemptId
            && performance.facts?.verdict === 'pass' && performance.facts?.evaluable === true
            && performance.facts?.terminal === true, 'confirmation-performance-rejected', locator.ref);
        requireCondition(typeof document.runId === 'string' && document.runId.length > 0
            && typeof document.attemptId === 'string' && document.attemptId.length > 0,
        'invalid-confirmation-run', locator.ref);
        finite(document.baselineWallMs, 'confirmation.baselineWallMs', 0.001);
        finite(document.currentWallMs, 'confirmation.currentWallMs', 0.001);
        finite(document.baselineCv, 'confirmation.baselineCv');
        finite(document.currentCv, 'confirmation.currentCv');
        for (const field of ['correctnessDigest', 'testDigest', 'coverageDigest', 'measurementDigest'])
        {
            requireCondition(/^sha256:[0-9a-f]{64}$/u.test(document.baseline?.[field])
                && document.baseline[field] === document.current?.[field], 'confirmation-exactness-drift', locator.ref, field);
        }
        if (document.fresh !== true || document.attemptOrdinal !== 1 || document.resumed !== false
            || document.swap !== 0 || document.oom !== 0 || document.resourceKills !== 0
            || document.benchmarkIsolationValid !== true || document.currentCv > document.baselineCv)
        {
            reasons.push({ code: 'confirmation-guardrail', evidenceRef: locator.ref });
        }
        return document;
    });
    if (confirmations.length < 3 || new Set(confirmations.map((row) => row.runId)).size !== confirmations.length
        || confirmations.some((row) => model.learningRunIds.includes(row.runId)))
    {
        reasons.push({ code: 'independent-confirmations-required', evidenceRef: 'confirmations' });
    }
    if (!highConfidence(model))
    {
        reasons.push({ code: 'low-confidence', evidenceRef: 'model' });
    }
    let p50Gain = null;
    if (confirmations.length)
    {
        const baseline = confirmations.map((row) => row.baselineWallMs);
        const current = confirmations.map((row) => row.currentWallMs);
        p50Gain = 1 - quantile(current, 0.5) / quantile(baseline, 0.5);
        if (!isNoChange(model) && p50Gain + 1e-12 < 0.05)
        {
            reasons.push({ code: 'insufficient-p50-benefit', evidenceRef: 'confirmations' });
        }
        if (quantile(current, 0.9) > quantile(baseline, 0.9))
        {
            reasons.push({ code: 'p90-regression', evidenceRef: 'confirmations' });
        }
    }
    return seal({
        schema: terminalSchema, authority: 'DATA_ONLY', identity: structuredClone(identity),
        modelDigest: model.digest, shadowDigest: shadow.digest,
        confirmationLocators: structuredClone(confirmationLocators), p50Gain, reasons,
        state: reasons.length ? 'reject' : isNoChange(model) ? 'no-change' : 'active-candidate'
    });
}

function modelFile(directory, digest)
{
    requireCondition(/^sha256:[a-f0-9]{64}$/u.test(digest), 'invalid-model-digest', 'pointer');
    return path.join(directory, `${digest.slice(7)}.json`);
}

function readPointer(directory)
{
    const file = path.join(directory, 'candidate-active.json');
    return fs.existsSync(file) ? verifySeal(JSON.parse(fs.readFileSync(file, 'utf8')), pointerSchema) : null;
}

function atomicPointer(directory, pointer)
{
    const temporary = path.join(directory, `.pointer-${process.pid}`);
    try
    {
        writeImmutable(temporary, pointer);
        fs.renameSync(temporary, path.join(directory, 'candidate-active.json'));
        syncDirectory(directory);
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
    }
}

/** Local candidate CAS publication keeps immutable models and a terminal record before switching. */
export function publishCandidatePointer({ directory, model, identity, shadow, confirmationLocators,
    evidenceRoot, expectedPointerDigest })
{
    return withWriterLock(directory, () =>
    {
        const current = readPointer(directory);
        requireCondition((current?.digest ?? null) === expectedPointerDigest, 'pointer-cas-conflict', 'candidate-active.json');
        const evaluation = evaluateActivationCandidate({ model, identity, shadow, confirmationLocators, evidenceRoot });
        if (evaluation.state === 'reject' || evaluation.state === 'no-change')
        {
            writeImmutable(path.join(directory, `terminal-${evaluation.digest.slice(7)}.json`), evaluation);
            return evaluation;
        }
        if (current)
        {
            sameIdentity(current.identity, identity, 'candidate-active.json');
        }
        const file = modelFile(directory, model.digest);
        if (!fs.existsSync(file))
        {
            writeImmutable(file, model);
        }
        else
        {
            requireCondition(digestJson(JSON.parse(fs.readFileSync(file, 'utf8'))) === digestJson(model),
                'stored-model-tamper', file);
        }
        const pointer = seal({
            schema: pointerSchema, authority: 'DATA_ONLY', identity: structuredClone(identity),
            modelDigest: model.digest, previousModelDigest: current?.modelDigest ?? null,
            previousPointerDigest: current?.digest ?? null, evaluationDigest: evaluation.digest
        });
        writeImmutable(path.join(directory, `terminal-${evaluation.digest.slice(7)}.json`), evaluation);
        atomicPointer(directory, pointer);
        return { state: evaluation.state, authority: 'DATA_ONLY', modelDigest: evaluation.modelDigest,
            terminal: evaluation, pointer };
    });
}

export function rollbackCandidatePointer({ directory, identity, expectedPointerDigest })
{
    return withWriterLock(directory, () =>
    {
        const current = readPointer(directory);
        requireCondition(current?.digest === expectedPointerDigest && current.previousModelDigest,
            'rollback-unavailable', 'candidate-active.json');
        sameIdentity(current.identity, identity, 'candidate-active.json');
        const previous = JSON.parse(fs.readFileSync(modelFile(directory, current.previousModelDigest), 'utf8'));
        validateModelBundle(previous, identity);
        requireCondition(previous.digest === current.previousModelDigest, 'stored-model-tamper', 'rollback');
        const terminal = seal({
            schema: terminalSchema, authority: 'DATA_ONLY', state: 'rollback', identity: structuredClone(identity),
            modelDigest: previous.digest, previousPointerDigest: current.digest
        });
        const pointer = seal({
            schema: pointerSchema, authority: 'DATA_ONLY', identity: structuredClone(identity),
            modelDigest: previous.digest, previousModelDigest: current.modelDigest,
            previousPointerDigest: current.digest, evaluationDigest: terminal.digest
        });
        writeImmutable(path.join(directory, `terminal-${terminal.digest.slice(7)}.json`), terminal);
        atomicPointer(directory, pointer);
        return { state: terminal.state, authority: 'DATA_ONLY', modelDigest: terminal.modelDigest,
            terminal, pointer };
    });
}

function freezeTree(value)
{
    if (value && typeof value === 'object')
    {
        Object.values(value).forEach(freezeTree);
        Object.freeze(value);
    }
    return value;
}

/** A pre-seal snapshot is immutable; each new selection rereads disk, with no model cache. */
export function selectCandidateModel({ directory, identity, defaults, planSealed })
{
    requireCondition(planSealed === false, 'selection-after-plan-seal', 'plan');
    const fallback = (reason) => freezeTree({ selection: 'defaults', reason, defaults: sortedDefaults(defaults) });
    try
    {
        const pointer = readPointer(directory);
        if (!pointer)
        {
            return fallback('no-active-candidate');
        }
        sameIdentity(pointer.identity, identity, 'candidate-active.json');
        requireCondition(/^sha256:[a-f0-9]{64}$/u.test(pointer.evaluationDigest),
            'invalid-terminal-digest', 'candidate-active.json');
        const terminal = verifySeal(JSON.parse(fs.readFileSync(path.join(directory,
            `terminal-${pointer.evaluationDigest.slice(7)}.json`), 'utf8')), terminalSchema);
        requireCondition(terminal.digest === pointer.evaluationDigest && terminal.modelDigest === pointer.modelDigest
            && ['active-candidate', 'rollback'].includes(terminal.state), 'pointer-terminal-drift', 'pointer');
        sameIdentity(terminal.identity, identity, 'terminal.identity');
        const model = JSON.parse(fs.readFileSync(modelFile(directory, pointer.modelDigest), 'utf8'));
        validateModelBundle(model, identity);
        requireCondition(model.digest === pointer.modelDigest, 'stored-model-tamper', 'model');
        requireCondition(model.defaultsDigest === digestJson(sortedDefaults(defaults)), 'defaults-drift', 'defaults');
        requireCondition(highConfidence(model), 'low-confidence', 'model');
        return freezeTree({ selection: 'candidate', pointerDigest: pointer.digest, model });
    }
    catch (error)
    {
        return fallback(error.code ?? 'unreadable-model');
    }
}

export function activateProductionModel()
{
    requireProductionAuthority();
}
