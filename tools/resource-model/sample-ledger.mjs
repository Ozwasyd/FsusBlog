import fs from 'node:fs';
import path from 'node:path';

import {
    digestJson, exactIds, finite, readEvidence, requireCondition, requireProductionAuthority,
    sameIdentity, seal, syncDirectory, validateIdentity, verifySeal, withWriterLock, writeImmutable
} from './contract.mjs';

export const sampleSchema = 'fsusblog.adaptive.sample-candidate.v1';
export const ledgerRecordSchema = 'fsusblog.adaptive.ledger-record.v1';
export const evidenceRoles = Object.freeze([
    'run', 'plan', 'resource', 'performance', 'collector', 'enforcement', 'benchmark', 'noise'
]);

const metricFields = Object.freeze([
    'actualCpuUnits', 'grantedCpuUnits', 'grantEfficiency', 'capacityBlockedMs', 'throttledMs',
    'peakRssGiB', 'memoryPsi', 'majorFaults', 'readyAt', 'firstProductiveChildAt',
    'startupCapacityBlockedMs', 'downstreamUnlockValue', 'startupCpuUnits', 'startupMemoryGiB',
    'queueAgeMs', 'lifetimeMs'
]);

function validateObservations(observations, producerIds, ref)
{
    requireCondition(Array.isArray(observations), 'missing-observations', ref);
    requireCondition(digestJson(exactIds(observations.map((item) => item.producerId), ref))
        === digestJson(producerIds), 'producer-drift', ref);
    for (const observation of observations)
    {
        for (const field of metricFields)
        {
            finite(observation[field], `${ref}:${observation.producerId}.${field}`);
        }
        requireCondition(observation.grantedCpuUnits > 0 && observation.grantEfficiency <= 1
            && observation.firstProductiveChildAt >= observation.readyAt,
        'invalid-observation', ref, observation.producerId);
        requireCondition(['cpu', 'dependency', 'readiness', 'io', 'quiet', 'benchmark'].includes(observation.waitClass)
            && typeof observation.criticalPath === 'boolean', 'invalid-classification', ref);
        requireCondition(observation.attribution === 'step' || observation.attribution === 'resident'
            || observation.attribution === 'unknown', 'invalid-attribution', ref);
        for (const field of ['gcPressure', 'allocationPressure'])
        {
            requireCondition(observation[field] === null
                || typeof observation[field] === 'number' && Number.isFinite(observation[field]) && observation[field] >= 0,
            'invalid-optional-metric', `${ref}:${field}`);
        }
    }
}

/** Reconstructs mechanical clean eligibility from all raw DATA_ONLY observation inputs. */
export function createSampleCandidate({ identity, runId, attemptId, receipts, evidenceRoot })
{
    validateIdentity(identity);
    requireCondition(typeof runId === 'string' && runId.length > 0 && typeof attemptId === 'string'
        && attemptId.length > 0, 'invalid-run', 'runId/attemptId');
    requireCondition(receipts && Object.keys(receipts).sort().join() === [...evidenceRoles].sort().join(),
        'missing-raw-evidence', 'receipts');
    const raw = {};
    for (const role of evidenceRoles)
    {
        const locator = receipts[role];
        raw[role] = readEvidence(evidenceRoot, locator);
        requireCondition(raw[role].schema === 'fsusblog.adaptive.observation-input.v1'
            && raw[role].role === role && raw[role].authority === 'DATA_ONLY',
        'invalid-evidence-schema', locator.ref);
        sameIdentity(raw[role].identity, identity, locator.ref);
        requireCondition(raw[role].runId === runId && raw[role].attemptId === attemptId,
            'wrong-run-attempt', locator.ref);
    }
    const requireFact = (role, field, expected, code) => requireCondition(raw[role].facts?.[field] === expected,
        code, receipts[role].ref, field);
    for (const [field, expected] of Object.entries({
        status: 'passed', fresh: true, resumed: false, attemptOrdinal: 1, complete: true,
        calibrated: true, correctnessPassed: true
    }))
    {
        requireFact('run', field, expected, 'unclean-run');
    }
    const producers = exactIds(raw.plan.facts?.producerIds, receipts.plan.ref);
    requireCondition(identity.producerMembershipDigest === digestJson(producers),
        'producer-drift', receipts.plan.ref);
    requireCondition(digestJson(exactIds(raw.plan.facts?.planned, receipts.plan.ref))
        === digestJson(exactIds(raw.plan.facts?.executed, receipts.plan.ref)),
    'planned-executed-drift', receipts.plan.ref);
    requireCondition(identity.testMembershipDigest === digestJson([...raw.plan.facts.planned].sort()),
        'test-drift', receipts.plan.ref);
    for (const [field, expected] of Object.entries({
        complete: true, unsupportedRequiredMetrics: 0, swap: 0, oom: 0, resourceKills: 0
    }))
    {
        requireFact('resource', field, expected, 'unclean-resource');
    }
    requireFact('performance', 'verdict', 'pass', 'performance-not-pass');
    requireFact('performance', 'evaluable', true, 'performance-not-evaluable');
    requireFact('performance', 'terminal', true, 'performance-not-terminal');
    for (const role of ['collector', 'enforcement'])
    {
        requireFact(role, 'complete', true, 'incomplete-resource-boundary');
        requireFact(role, 'drift', false, 'resource-boundary-drift');
    }
    requireFact('benchmark', 'isolationValid', true, 'benchmark-invalid');
    requireFact('benchmark', 'cvValid', true, 'benchmark-invalid');
    requireFact('noise', 'thermalInvalid', false, 'noise-invalid');
    requireFact('noise', 'externalNoiseInvalid', false, 'noise-invalid');
    validateObservations(raw.resource.facts.observations, producers, receipts.resource.ref);
    return seal({
        schema: sampleSchema, authority: 'DATA_ONLY', identity: structuredClone(identity), runId, attemptId,
        receipts: structuredClone(receipts), qualification: 'mechanically-clean-candidate',
        observations: structuredClone(raw.resource.facts.observations)
            .sort((left, right) => left.producerId.localeCompare(right.producerId))
    });
}

export function validateSampleCandidate(sample, evidenceRoot)
{
    verifySeal(sample, sampleSchema);
    const rebuilt = createSampleCandidate({ ...sample, evidenceRoot });
    requireCondition(rebuilt.digest === sample.digest, 'sample-reconstruction-drift', sample.receipts.resource.ref);
    return rebuilt;
}

/** A trusted explicit head detects truncation as well as replacement; no directory discovery occurs. */
export function readSampleLedger({ directory, head, identity, evidenceRoot })
{
    validateIdentity(identity);
    requireCondition(head && Number.isSafeInteger(head.count) && head.count >= 0,
        'invalid-ledger-head', 'head');
    let previousDigest = digestJson({ schema: ledgerRecordSchema, identity });
    const samples = [];
    const seenRuns = new Set();
    for (let ordinal = 1; ordinal <= head.count; ordinal += 1)
    {
        const ref = path.join(directory, `${ordinal}.json`);
        const record = verifySeal(JSON.parse(fs.readFileSync(ref, 'utf8')), ledgerRecordSchema);
        requireCondition(record.ordinal === ordinal && record.previousDigest === previousDigest,
            'ledger-chain-drift', ref);
        sameIdentity(record.sample.identity, identity, ref);
        validateSampleCandidate(record.sample, evidenceRoot);
        requireCondition(!seenRuns.has(record.sample.runId), 'duplicate-run', ref);
        seenRuns.add(record.sample.runId);
        samples.push(record.sample);
        previousDigest = record.digest;
    }
    requireCondition(previousDigest === head.digest, 'ledger-head-drift', 'head');
    return { identity: structuredClone(identity), head: structuredClone(head), samples };
}

export function emptyLedgerHead(identity)
{
    validateIdentity(identity);
    return { count: 0, digest: digestJson({ schema: ledgerRecordSchema, identity }) };
}

/** Append-only candidate storage; this does not enroll samples in Production learning. */
export function appendSampleCandidate({ directory, head, sample, identity, evidenceRoot })
{
    return withWriterLock(directory, () =>
    {
        const history = readSampleLedger({ directory, head, identity, evidenceRoot });
        sameIdentity(sample.identity, identity, 'sample.identity');
        validateSampleCandidate(sample, evidenceRoot);
        requireCondition(!history.samples.some((item) => item.runId === sample.runId),
            'duplicate-run', sample.receipts.run.ref);
        const ordinal = head.count + 1;
        const record = seal({
            schema: ledgerRecordSchema, authority: 'DATA_ONLY', ordinal,
            previousDigest: head.digest, sample
        });
        const file = path.join(directory, `${ordinal}.json`);
        requireCondition(!fs.existsSync(file), 'replacement-refused', file);
        const temporary = path.join(directory, `.record-${process.pid}`);
        try
        {
            writeImmutable(temporary, record);
            fs.linkSync(temporary, file);
            syncDirectory(directory);
        }
        finally
        {
            fs.rmSync(temporary, { force: true });
        }
        return { count: ordinal, digest: record.digest };
    });
}

export function enrollProductionSample()
{
    requireProductionAuthority();
}

/** Re-read chain and raw receipts for every recommendation, including later tampering. */
export function recommendationInputs({ ledger, defaults, capacity })
{
    const history = readSampleLedger(ledger);
    const ids = exactIds(defaults.map((item) => item.producerId), 'defaults');
    requireCondition(digestJson(ids) === history.identity.producerMembershipDigest,
        'producer-drift', 'defaults');
    requireCondition(digestJson(capacity) === history.identity.capacityDigest, 'capacity-drift', 'capacity');
    finite(capacity.effectiveCpuUnits, 'capacity.effectiveCpuUnits', 1);
    finite(capacity.minimumSupportedCpuUnits, 'capacity.minimumSupportedCpuUnits', 1);
    requireCondition(capacity.minimumSupportedCpuUnits <= capacity.effectiveCpuUnits,
        'invalid-capacity-floor', 'capacity');
    finite(capacity.totalMemoryGiB, 'capacity.totalMemoryGiB', 0.001);
    for (const item of defaults)
    {
        finite(item.cpuWeight, 'defaults.cpuWeight', 0.001);
        finite(item.minCpuUnits, 'defaults.minCpuUnits', 1);
        requireCondition(Number.isSafeInteger(item.minCpuUnits), 'invalid-minimum', item.producerId);
        finite(item.cpuUnits, 'defaults.cpuUnits', item.minCpuUnits);
        finite(item.memoryGiB, 'defaults.memoryGiB', 0.001);
        finite(item.startupPriority, 'defaults.startupPriority');
        requireCondition(item.benchmark === true || item.benchmark === false,
            'missing-benchmark-classification', item.producerId);
    }
    return {
        ...history, defaults: structuredClone(defaults).sort((left, right) => left.producerId.localeCompare(right.producerId)),
        rows: (id) => history.samples.flatMap((sample) => sample.observations.filter((row) => row.producerId === id))
    };
}
