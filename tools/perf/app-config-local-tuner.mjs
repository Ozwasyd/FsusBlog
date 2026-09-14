import {
    baselineConfig,
    digestJson,
    validateConfig
} from './app-config-catalog.mjs';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function clampAligned(knob, value)
{
    const stepped = knob.range.minimum + Math.round((value - knob.range.minimum) / knob.range.step) * knob.range.step;
    return Math.min(knob.range.maximum, Math.max(knob.range.minimum, stepped));
}

function normalizedDelta(knob, baseline, value)
{
    return (value - baseline) / (knob.range.maximum - knob.range.minimum);
}

function pointId(config)
{
    return digestJson(config).slice(7, 19);
}

export function createLocalExperimentDesign({
    catalog,
    groupId,
    baseline = baselineConfig(catalog),
    identity,
    radius = 1,
    repeats = 2,
    evidenceKind = 'synthetic'
})
{
    const configValidation = validateConfig(catalog, baseline, { groupId, evidenceKind });
    if (!configValidation.valid)
    {
        throw new Error(configValidation.errors.join('\n'));
    }
    if (!identity?.sourceCommit || !identity?.buildArtifactDigest || !identity?.fixtureDigest || !identity?.toolchainDigest)
    {
        throw new Error('identity must bind sourceCommit, buildArtifactDigest, fixtureDigest and toolchainDigest');
    }
    for (const field of ['buildArtifactDigest', 'fixtureDigest', 'toolchainDigest'])
    {
        if (!DIGEST_PATTERN.test(identity[field]))
        {
            throw new Error(`identity.${field} must be a sha256 digest`);
        }
    }
    if (!/^[a-f0-9]{40}$/u.test(identity.sourceCommit))
    {
        throw new Error('identity.sourceCommit must be a 40-character commit');
    }
    if (!(radius > 0 && radius <= 1))
    {
        throw new Error('radius must be within (0, 1]');
    }
    if (!Number.isInteger(repeats) || repeats < 2)
    {
        throw new Error('repeats must be at least two');
    }

    const group = catalog.interactionGroups.find((candidate) => candidate.id === groupId);
    const byId = new Map(catalog.knobs.map((knob) => [knob.id, knob]));
    const knobs = group.knobIds.map((id) => byId.get(id));
    const levels = new Map(knobs.map((knob) =>
    {
        const span = knob.range.maximum - knob.range.minimum;
        const normalizedStep = Math.min(knob.maxNormalizedStep, group.maxNormalizedStep) * radius;
        const physicalStep = Math.max(knob.range.step, Math.round(span * normalizedStep / knob.range.step) * knob.range.step);
        return [knob.id, {
            minus: clampAligned(knob, baseline[knob.configKey] - physicalStep),
            plus: clampAligned(knob, baseline[knob.configKey] + physicalStep)
        }];
    }));

    const candidates = [structuredClone(baseline)];
    for (const knob of knobs)
    {
        for (const value of Object.values(levels.get(knob.id)))
        {
            candidates.push({ ...baseline, [knob.configKey]: value });
        }
    }
    for (let leftIndex = 0; leftIndex < knobs.length; leftIndex += 1)
    {
        for (let rightIndex = leftIndex + 1; rightIndex < knobs.length; rightIndex += 1)
        {
            const left = knobs[leftIndex];
            const right = knobs[rightIndex];
            for (const leftLevel of ['minus', 'plus'])
            {
                for (const rightLevel of ['minus', 'plus'])
                {
                    candidates.push({
                        ...baseline,
                        [left.configKey]: levels.get(left.id)[leftLevel],
                        [right.configKey]: levels.get(right.id)[rightLevel]
                    });
                }
            }
        }
    }

    const unique = new Map();
    const rejected = [];
    for (const config of candidates)
    {
        const validation = validateConfig(catalog, config, { groupId, evidenceKind });
        if (!validation.valid)
        {
            rejected.push({ config, errors: validation.errors });
            continue;
        }
        unique.set(digestJson(config), config);
    }
    const points = [...unique.values()].map((config) => ({
        id: pointId(config),
        config,
        normalizedDelta: Object.fromEntries(knobs.map((knob) => [
            knob.id,
            normalizedDelta(knob, baseline[knob.configKey], config[knob.configKey])
        ]))
    }));
    const order = [];
    for (let repeat = 1; repeat <= repeats; repeat += 1)
    {
        const balanced = [...points].sort((left, right) =>
            digestJson([identity.sourceCommit, groupId, repeat, left.id]).localeCompare(
                digestJson([identity.sourceCommit, groupId, repeat, right.id])
            ));
        for (const point of balanced)
        {
            order.push({
                sequence: order.length + 1,
                repeat,
                pointId: point.id,
                cleanupRequired: true,
                cooldownRequired: true
            });
        }
    }
    return {
        schema: 'fsusblog.app-config-experiment-design.v1',
        groupId,
        evidenceKind,
        identity: structuredClone(identity),
        identityDigest: digestJson(identity),
        catalogDigest: digestJson(catalog),
        baselineDigest: digestJson(baseline),
        radius,
        repeats,
        points,
        rejectedDesignCandidates: rejected,
        order,
        physicalSampleCount: order.length,
        fullThreeLevelGridSampleCount: (3 ** knobs.length) * repeats
    };
}

export * from './app-config-catalog.mjs';
export * from './app-config-local-model.mjs';
