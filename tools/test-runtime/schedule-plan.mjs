/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import { digestCanonical, freezeDeep } from '../test-fixtures/receipt/canonical.mjs';

import { requireDigest, requireSafeId, sealDocument } from './contract.mjs';

export const runtimeSchedulePlanSchema = 'fsusblog.runtime-schedule-plan.v1';
export const fixedRuntimeShuffleSeeds = Object.freeze([104729, 130363, 155921, 196613, 262147]);

export function runtimeStepCatalogDigest(steps)
{
    stepIndex(steps);
    return digestCanonical(steps.map((step) => ({
        id: step.id,
        command: step.command ?? null,
        dependsOn: step.dependsOn ?? [],
        settledDependsOn: step.settledDependsOn ?? [],
        coordinationOnly: step.resources?.coordinationOnly === true
    })));
}

function stepIndex(steps)
{
    const map = new Map();
    for (const step of steps ?? [])
    {
        const id = requireSafeId(step?.id, 'runtime step id');
        if (map.has(id))
        {
            throw new Error(`duplicate runtime step ${id}`);
        }
        map.set(id, step);
    }
    for (const [id, step] of map)
    {
        for (const dependency of [...(step.dependsOn ?? []), ...(step.settledDependsOn ?? [])])
        {
            if (!map.has(dependency))
            {
                throw new Error(`${id} depends on an unknown runtime step ${dependency}`);
            }
        }
    }
    return map;
}

function seededRandom(seed)
{
    let state = Number(seed) >>> 0;
    if (!Number.isInteger(Number(seed)) || state === 0)
    {
        throw new Error('schedule seed must be a non-zero uint32');
    }
    return () =>
    {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x1_0000_0000;
    };
}

function topologicalPreference(steps, mode, seed = null)
{
    const byId = stepIndex(steps);
    const pending = new Set(byId.keys());
    const completed = new Set();
    const order = [];
    const random = seed == null ? null : seededRandom(seed);
    while (pending.size > 0)
    {
        const ready = [...pending].filter((id) => [...(byId.get(id).dependsOn ?? []), ...(byId.get(id).settledDependsOn ?? [])]
            .every((dependency) => completed.has(dependency)))
            .sort();
        if (ready.length === 0)
        {
            throw new Error('runtime step DAG contains a dependency cycle');
        }
        if (mode === 'reverse-ready')
        {
            ready.reverse();
        }
        if (mode === 'shuffled')
        {
            for (let index = ready.length - 1; index > 0; index -= 1)
            {
                const selected = Math.floor(random() * (index + 1))
        ;[ready[index], ready[selected]] = [ready[selected], ready[index]];
            }
        }
        for (const id of ready)
        {
            order.push(id);
            pending.delete(id);
            completed.add(id);
        }
    }
    return order;
}

export function validateRuntimeSchedulePlan(plan, { steps, allowedCaps, expected = {} } = {})
{
    if (plan?.schema !== runtimeSchedulePlanSchema)
    {
        throw new Error('runtime schedule plan schema is invalid');
    }
    const byId = stepIndex(steps);
    const ids = plan.orderedStepIds;
    if (!Array.isArray(ids) || ids.length !== byId.size || new Set(ids).size !== ids.length
    || ids.some((id) => !byId.has(id)))
    {
        throw new Error('runtime schedule plan must contain every production runtime step exactly once');
    }
    const position = new Map(ids.map((id, index) => [id, index]));
    for (const id of ids)
    {
        for (const dependency of [...(byId.get(id).dependsOn ?? []), ...(byId.get(id).settledDependsOn ?? [])])
        {
            if (position.get(dependency) > position.get(id))
            {
                throw new Error(`runtime schedule plan reverses dependency ${dependency} -> ${id}`);
            }
        }
    }
    if (!Number.isInteger(plan.concurrencyCap) || plan.concurrencyCap < 1
    || (allowedCaps && !allowedCaps.includes(plan.concurrencyCap)))
    {
        throw new Error('runtime schedule plan has an unsupported concurrency cap');
    }
    for (const [field, value] of Object.entries({
        runtimeStepCatalogDigest: expected.runtimeStepCatalogDigest,
        stateCatalogDigest: expected.stateCatalogDigest,
        clockDigest: expected.clockDigest,
        replayDigest: expected.replayDigest,
        envelopeDigest: expected.envelopeDigest
    }))
    {
        if (value && plan[field] !== value)
        {
            throw new Error(`runtime schedule plan ${field} drifted`);
        }
    }
    const { contentDigest, ...body } = plan;
    const expectedDigest = sealDocument(body).contentDigest;
    if (contentDigest !== expectedDigest)
    {
        throw new Error('runtime schedule plan content digest mismatch');
    }
    return true;
}

export function createRuntimeSchedulePlan({
    steps,
    kind,
    concurrencyCap,
    seed = null,
    maxConcurrency,
    runtimeStepCatalogDigest,
    stateCatalogDigest,
    clockDigest,
    replayDigest,
    envelopeDigest
})
{
    const supportedKinds = new Set(['canonical', 'fully-serial', 'reverse-ready', 'shuffled']);
    if (!supportedKinds.has(kind))
    {
        throw new Error(`unsupported runtime schedule kind ${kind}`);
    }
    const max = Math.max(1, Math.floor(Number(maxConcurrency)));
    const cap = Number(concurrencyCap);
    const allowedCaps = [...new Set([1, Math.min(2, max), max])];
    if (!allowedCaps.includes(cap))
    {
        throw new Error(`concurrency cap must be one of ${allowedCaps.join(', ')}`);
    }
    if (kind === 'fully-serial' && cap !== 1)
    {
        throw new Error('fully-serial schedule requires concurrency cap 1');
    }
    if (kind === 'shuffled' && !fixedRuntimeShuffleSeeds.includes(Number(seed)))
    {
        throw new Error('shuffled runtime schedule requires one of the fixed seeds');
    }
    const mode = kind === 'canonical' || kind === 'fully-serial' ? 'canonical' : kind;
    const orderedStepIds = topologicalPreference(steps, mode, kind === 'shuffled' ? Number(seed) : null);
    const body = {
        schema: runtimeSchedulePlanSchema,
        planId: `${kind}-${kind === 'shuffled' ? seed : 'fixed'}-cap-${cap}`,
        kind,
        seed: kind === 'shuffled' ? Number(seed) : null,
        concurrencyCap: cap,
        orderedStepIds,
        runtimeStepCatalogDigest: requireDigest(runtimeStepCatalogDigest, 'runtimeStepCatalogDigest'),
        stateCatalogDigest: requireDigest(stateCatalogDigest, 'stateCatalogDigest'),
        clockDigest: requireDigest(clockDigest, 'clockDigest'),
        replayDigest: requireDigest(replayDigest, 'replayDigest'),
        envelopeDigest: requireDigest(envelopeDigest, 'envelopeDigest')
    };
    const plan = sealDocument(body);
    validateRuntimeSchedulePlan(plan, { steps, allowedCaps });
    return freezeDeep(plan);
}

export function createRequiredRuntimeSchedulePlans(options)
{
    const max = Math.max(1, Math.floor(Number(options.maxConcurrency)));
    const caps = [...new Set([1, Math.min(2, max), max])];
    const descriptors = [
        { kind: 'canonical', seed: null },
        { kind: 'fully-serial', seed: null },
        { kind: 'reverse-ready', seed: null },
        ...fixedRuntimeShuffleSeeds.map((seed) => ({ kind: 'shuffled', seed }))
    ];
    const plans = [];
    for (const descriptor of descriptors)
    {
        for (const cap of caps)
        {
            if (descriptor.kind === 'fully-serial' && cap !== 1)
            {
                plans.push(freezeDeep({
                    schema: runtimeSchedulePlanSchema,
                    planId: `fully-serial-fixed-cap-${cap}`,
                    kind: descriptor.kind,
                    seed: null,
                    concurrencyCap: cap,
                    deduplicatedBy: 'fully-serial-fixed-cap-1',
                    deduplicationProof: 'fully-serial has a semantic cap of one; higher requested caps cannot admit overlap'
                }));
                continue;
            }
            plans.push(createRuntimeSchedulePlan({ ...options, ...descriptor, concurrencyCap: cap }));
        }
    }
    return Object.freeze(plans);
}

export function orderStepsByPlan(steps, plan)
{
    validateRuntimeSchedulePlan(plan, { steps });
    const byId = new Map(steps.map((step) => [step.id, step]));
    return plan.orderedStepIds.map((id) => byId.get(id));
}
