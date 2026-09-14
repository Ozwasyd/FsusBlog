const priorityScoreSchema = 'fsusblog.test-matrix.priority-score.v1';
const priorityInputSchema = 'fsusblog.test-matrix.priority-input.v1';
const observationIndexSchema = 'fsusblog.test-observation-index.v1';
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

const defaultWeights = Object.freeze({
    startupPriority: 100,
    deadlineWeight: 1,
    changedSourceRelevance: 240,
    sourceDomainRisk: 40,
    failureProbability: 180,
    distinctFailureSignatures: 20,
    estimatedDuration: 80,
    aging: 75
});

const riskValues = Object.freeze({
    low: 0,
    medium: 0.35,
    high: 0.7,
    critical: 1
});

function rounded(value)
{
    return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizedPath(value)
{
    return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '');
}

function wildcardPattern(value)
{
    const normalized = normalizedPath(value);
    let source = '';
    for (let index = 0; index < normalized.length; index += 1)
    {
        const character = normalized[index];
        if (character === '*' && normalized[index + 1] === '*')
        {
            if (normalized[index + 2] === '/')
            {
                source += '(?:.*/)?';
                index += 2;
            }
            else
            {
                source += '.*';
                index += 1;
            }
        }
        else if (character === '*')
        {
            source += '[^/]*';
        }
        else if (character === '?')
        {
            source += '[^/]';
        }
        else
        {
            source += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
        }
    }
    return new RegExp(`^${source}$`, 'u');
}

function pathMatches(changedPath, declaration)
{
    const changed = normalizedPath(changedPath);
    const pattern = normalizedPath(declaration);
    if (!changed || !pattern)
    {
        return false;
    }
    if (pattern.includes('*') || pattern.includes('?'))
    {
        return wildcardPattern(pattern).test(changed);
    }
    return changed === pattern || changed.startsWith(`${pattern}/`);
}

function sourceDeclarations(tier)
{
    return [...new Set([
        ...(tier.triggerPaths ?? []),
        ...(tier.triggerFiles ?? []),
        ...(tier.cacheInputs ?? [])
    ].map(normalizedPath).filter(Boolean))].sort();
}

function tierTestIds(tier, binding)
{
    return [...new Set([
        ...(binding?.testIds ?? []),
        ...(tier.priorityTestIds ?? []),
        ...(tier.requiredTestIds ?? [])
    ].map(String).filter(Boolean))].sort();
}

function contribution(name, rawValue, normalizedValue, weights)
{
    const weight = Number(weights[name] ?? 0);
    return {
        rawValue,
        normalizedValue: rounded(normalizedValue),
        weight,
        contribution: rounded(normalizedValue * weight)
    };
}

export function startupAdmissionOrder(left, right)
{
    return Number(right.startupPriority ?? 0) - Number(left.startupPriority ?? 0)
    || Number(right.deadlineWeight ?? 0) - Number(left.deadlineWeight ?? 0)
    || left.id.localeCompare(right.id);
}

export function validatePriorityInput(input)
{
    const errors = [];
    if (!input || input.schema !== priorityInputSchema)
    {
        errors.push(`schema must be ${priorityInputSchema}`);
    }
    if (!Array.isArray(input?.changedPaths) || input.changedPaths.some((entry) => typeof entry !== 'string'))
    {
        errors.push('changedPaths must be an array of strings');
    }
    if (!input?.tierBindings || typeof input.tierBindings !== 'object' || Array.isArray(input.tierBindings))
    {
        errors.push('tierBindings must be an object');
    }
    if (input?.ledger?.schema !== observationIndexSchema)
    {
        errors.push(`ledger schema must be ${observationIndexSchema}`);
    }
    else if (!Array.isArray(input.ledger.tests))
    {
        errors.push('ledger.tests must be an array');
    }
    return errors;
}

function qualifiedHistory(tier, input, minimumSamples)
{
    const binding = input.tierBindings[tier.id];
    const expectedClosure = String(binding?.sourceClosureDigest ?? '');
    const testIds = tierTestIds(tier, binding);
    if (!digestPattern.test(expectedClosure) || testIds.length === 0)
    {
        return { qualified: false, reason: 'missing-tier-source-binding' };
    }
    const byId = new Map(input.ledger.tests.map((entry) => [entry.testId, entry]));
    const entries = testIds.map((testId) => byId.get(testId)).filter(Boolean);
    if (entries.length !== testIds.length)
    {
        return { qualified: false, reason: 'missing-ledger-test' };
    }
    if (entries.some((entry) => (
        entry.sourceClosureDigests?.length !== 1
    || entry.sourceClosureDigests[0] !== expectedClosure
    )))
    {
        return { qualified: false, reason: 'source-closure-mismatch' };
    }
    const samples = entries.reduce((total, entry) => total + Number(entry.samples ?? 0), 0);
    if (entries.some((entry) => (
        !Number.isInteger(Number(entry.samples))
    || Number(entry.samples) < 1
    || ['passed', 'failed', 'skipped', 'blocked'].some((outcome) => (
        !Number.isInteger(Number(entry.outcomeCounts?.[outcome]))
      || Number(entry.outcomeCounts[outcome]) < 0
    ))
    || Object.values(entry.outcomeCounts ?? {}).reduce((total, value) => total + Number(value), 0) !== Number(entry.samples)
    )))
    {
        return { qualified: false, reason: 'invalid-ledger-samples' };
    }
    if (samples < minimumSamples)
    {
        return { qualified: false, reason: 'insufficient-samples' };
    }
    const failures = entries.reduce((total, entry) => (
        total + Number(entry.outcomeCounts?.failed ?? 0) + Number(entry.outcomeCounts?.blocked ?? 0)
    ), 0);
    const signatures = new Set(entries.flatMap((entry) => Object.keys(entry.signatureCounts ?? {})));
    const durations = entries.map((entry) => Number(entry.durationMs?.p50)).filter((value) => Number.isFinite(value) && value >= 0);
    const fixtureDuration = Number(input.durationsMs?.[tier.id]);
    const durationMs = Number.isFinite(fixtureDuration) && fixtureDuration >= 0
        ? fixtureDuration
        : (durations.length === entries.length
        ? durations.reduce((total, value) => total + value, 0)
        : null);
    if (durationMs === null)
    {
        return { qualified: false, reason: 'missing-duration' };
    }
    return {
        qualified: true,
        samples,
        failureProbability: Math.min(1, failures / Math.max(1, samples)),
        distinctFailureSignatures: signatures.size,
        durationMs,
        sourceClosureDigest: expectedClosure,
        testIds
    };
}

function disabledResult(tiers, reason)
{
    return {
        schema: priorityScoreSchema,
        modelVersion: 1,
        mode: 'startup-fallback',
        fallbackReason: reason,
        ranked: [...tiers].sort(startupAdmissionOrder).map((tier) => ({
            tierId: tier.id,
            score: null,
            breakdown: {
                schema: priorityScoreSchema,
                modelVersion: 1,
                sourceBinding: null,
                fallbackReason: reason,
                signals: {
                    startupPriority: contribution(
                        'startupPriority',
                        Number(tier.startupPriority ?? 0),
                        Number(tier.startupPriority ?? 0),
                        defaultWeights
                    ),
                    deadlineWeight: contribution(
                        'deadlineWeight',
                        Number(tier.deadlineWeight ?? 0),
                        Number(tier.deadlineWeight ?? 0),
                        defaultWeights
                    )
                }
            }
        }))
    };
}

export function rankReadyTiers(tiers, input, options = {})
{
    const baseline = [...tiers].sort(startupAdmissionOrder);
    if (options.enabled === false)
    {
        return disabledResult(baseline, 'disabled');
    }
    const errors = validatePriorityInput(input);
    if (errors.length > 0)
    {
        return disabledResult(baseline, errors.join('; '));
    }
    if (tiers.length < 2)
    {
        return disabledResult(baseline, 'single-ready-tier');
    }

    const minimumSamples = Math.max(1, Number(options.minimumSamples ?? input.minimumSamples ?? 3));
    const histories = new Map(tiers.map((tier) => [tier.id, qualifiedHistory(tier, input, minimumSamples)]));
    const unqualified = baseline.find((tier) => !histories.get(tier.id).qualified);
    if (unqualified)
    {
        return disabledResult(baseline, `${unqualified.id}:${histories.get(unqualified.id).reason}`);
    }

    const weights = { ...defaultWeights, ...(input.weights ?? {}), ...(options.weights ?? {}) };
    const maxDuration = Math.max(1, ...[...histories.values()].map((entry) => entry.durationMs));
    const agingCap = Math.max(1, Number(options.agingCap ?? input.agingCap ?? 4));
    const changedPaths = [...new Set(input.changedPaths.map(normalizedPath).filter(Boolean))].sort();
    const scored = baseline.map((tier) =>
    {
        const history = histories.get(tier.id);
        const declarations = sourceDeclarations(tier);
        const relevantPaths = changedPaths.filter((changedPath) => declarations.some((entry) => pathMatches(changedPath, entry)));
        const age = Math.max(0, Math.min(agingCap, Number(options.readyAges?.get?.(tier.id) ?? options.readyAges?.[tier.id] ?? 0)));
        const signals = {
            startupPriority: contribution('startupPriority', Number(tier.startupPriority ?? 0), Number(tier.startupPriority ?? 0), weights),
            deadlineWeight: contribution('deadlineWeight', Number(tier.deadlineWeight ?? 0), Number(tier.deadlineWeight ?? 0), weights),
            changedSourceRelevance: contribution('changedSourceRelevance', relevantPaths, relevantPaths.length > 0 ? 1 : 0, weights),
            sourceDomainRisk: contribution('sourceDomainRisk', tier.risk ?? 'low', riskValues[tier.risk] ?? 0, weights),
            failureProbability: contribution('failureProbability', history.failureProbability, history.failureProbability, weights),
            distinctFailureSignatures: contribution(
                'distinctFailureSignatures',
                history.distinctFailureSignatures,
                Math.min(1, history.distinctFailureSignatures / 4),
                weights
            ),
            estimatedDuration: contribution('estimatedDuration', history.durationMs, 1 - history.durationMs / maxDuration, weights),
            aging: contribution('aging', age, age / agingCap, weights)
        };
        return {
            tierId: tier.id,
            score: rounded(Object.values(signals).reduce((total, signal) => total + signal.contribution, 0)),
            breakdown: {
                schema: priorityScoreSchema,
                modelVersion: 1,
                sourceBinding: {
                    sourceClosureDigest: history.sourceClosureDigest,
                    testIds: history.testIds,
                    samples: history.samples
                },
                signals
            }
        };
    }).sort((left, right) => right.score - left.score
    || startupAdmissionOrder(
        tiers.find((tier) => tier.id === left.tierId),
        tiers.find((tier) => tier.id === right.tierId)
    ));
    return {
        schema: priorityScoreSchema,
        modelVersion: 1,
        mode: 'dynamic',
        fallbackReason: null,
        ranked: scored
    };
}

export const prioritySchemas = Object.freeze({
    input: priorityInputSchema,
    score: priorityScoreSchema
});
