import { createHash } from 'node:crypto';

import { distributionCatalog, distributionCatalogDigest, distributionScenarioDigest } from './distribution-catalog.mjs';
import { assertDigest, canonicalDigest, deepFreeze, exactKeys } from './distribution-contract.mjs';

export const distributionSamplingAlgorithm = deepFreeze({ algorithm: 'sha256-counter-u53', version: '1' });
const samplingSchema = 'fsusblog.distribution-sampling-domain.v1';
const shardSchema = 'fsusblog.distribution-sampling-shard.v1';
const samplingLimit = 1000000;
const maximumShardSize = 4096;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u;
const kernelCapabilities = new WeakSet();

function assertIdentifier(value, label)
{
    if (typeof value !== 'string' || !identifierPattern.test(value))
    {
        throw new Error(`${label}_invalid`);
    }
}

function assertOrdinal(value)
{
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
    {
        throw new Error('distribution_sampling_ordinal_invalid');
    }
}

function counterStream(domainDigest, stream)
{
    assertIdentifier(stream, 'distribution_sampling_stream');
    const prefix = createHash('sha256')
        .update('fsusblog.distribution-sha256-counter-u53.v1\0', 'utf8')
        .update(domainDigest.slice(7), 'ascii')
        .update('\0', 'ascii')
        .update(stream, 'utf8')
        .update('\0', 'ascii');
    return (ordinal) =>
    {
        assertOrdinal(ordinal);
        const bytes = prefix.copy().update(String(ordinal), 'ascii').digest();
        // The first 53 big-endian bits are exact in Node and .NET double precision.
        const numerator = bytes.readUIntBE(0, 6) * 32 + (bytes[6] >>> 3);
        return numerator / 9007199254740992;
    };
}

/**
 * Algorithm primitive only: indices have no semantic meaning or authority. Production
 * scenario parameters must come from the catalog; this API cannot create a plan.
 */
export function createWeightedIndexSampler(weights)
{
    if (!Array.isArray(weights) || Object.getPrototypeOf(weights) !== Array.prototype
        || weights.length === 0 || weights.length > maximumShardSize)
    {
        throw new Error('distribution_sampling_weights_invalid');
    }
    canonicalDigest(weights);
    let total = 0;
    const cumulative = weights.map((weight) =>
    {
        if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0)
        {
            throw new Error('distribution_sampling_weight_invalid');
        }
        const next = total + weight;
        if (!Number.isFinite(next) || next <= total)
        {
            throw new Error('distribution_sampling_weight_precision_invalid');
        }
        total = next;
        return total;
    });
    const boundaries = cumulative.map((value) => value / total);
    if (boundaries.some((value, index) => value <= (index === 0 ? 0 : boundaries[index - 1])))
    {
        throw new Error('distribution_sampling_weight_precision_invalid');
    }
    return (unitInterval) =>
    {
        if (!Number.isFinite(unitInterval) || unitInterval < 0 || unitInterval >= 1)
        {
            throw new Error('distribution_sampling_unit_interval_invalid');
        }
        let lower = 0;
        let upper = boundaries.length - 1;
        while (lower < upper)
        {
            const middle = lower + Math.floor((upper - lower) / 2);
            if (unitInterval < boundaries[middle])
            {
                upper = middle;
            }
            else
            {
                lower = middle + 1;
            }
        }
        return lower;
    };
}

/**
 * Bind the real catalog seed and PRNG to a sampling domain. This is deliberately
 * not an article/comment compiler: absent producer authorities remain absent.
 */
export function createDistributionSamplingKernel(options)
{
    exactKeys(options, ['scenarioId', 'namespace', 'sourceIdentityDigest', 'roleSetDigest'], 'distribution_sampling_options');
    assertIdentifier(options.namespace, 'distribution_sampling_namespace');
    assertDigest(options.sourceIdentityDigest, 'sourceIdentityDigest');
    assertDigest(options.roleSetDigest, 'roleSetDigest');
    const scenario = distributionCatalog.scenarios.find((candidate) => candidate.id === options.scenarioId);
    if (!scenario)
    {
        throw new Error('distribution_sampling_scenario_unknown');
    }
    exactKeys(scenario.prng, ['algorithm', 'version'], 'distribution_sampling_prng');
    if (scenario.prng.algorithm !== distributionSamplingAlgorithm.algorithm
        || scenario.prng.version !== distributionSamplingAlgorithm.version)
    {
        throw new Error('distribution_sampling_prng_unsupported');
    }
    if (typeof scenario.fixedSeed !== 'string' || scenario.fixedSeed.length === 0)
    {
        throw new Error('distribution_sampling_seed_missing');
    }
    const body = {
        schema: samplingSchema,
        purpose: 'sampling-kernel-only',
        releaseEvidenceEligible: false,
        catalogDigest: distributionCatalogDigest(distributionCatalog),
        scenarioDigest: distributionScenarioDigest(scenario),
        scenarioId: scenario.id,
        seed: scenario.fixedSeed,
        prng: distributionSamplingAlgorithm,
        namespace: options.namespace,
        sourceIdentityDigest: options.sourceIdentityDigest,
        roleSetDigest: options.roleSetDigest
    };
    const metadata = deepFreeze({ ...body, contentDigest: canonicalDigest(body) });
    const kernel = Object.freeze({
        metadata,
        unitInterval: (stream, ordinal) => counterStream(metadata.contentDigest, stream)(ordinal)
    });
    kernelCapabilities.add(kernel);
    return kernel;
}

function validateSamplingRequest(kernel, options)
{
    if (!kernelCapabilities.has(kernel))
    {
        throw new Error('distribution_sampling_kernel_invalid');
    }
    exactKeys(options, ['stream', 'startOrdinal', 'count', 'shardSize'], 'distribution_sampling_request');
    assertIdentifier(options.stream, 'distribution_sampling_stream');
    assertOrdinal(options.startOrdinal);
    if (!Number.isSafeInteger(options.count) || options.count < 1 || options.count > samplingLimit
        || options.count - 1 > Number.MAX_SAFE_INTEGER - options.startOrdinal)
    {
        throw new Error('distribution_sampling_count_invalid');
    }
    if (!Number.isSafeInteger(options.shardSize) || options.shardSize < 1 || options.shardSize > maximumShardSize)
    {
        throw new Error('distribution_sampling_shard_size_invalid');
    }
}

/**
 * Yield bounded, content-addressed numerical sample shards. No role assignments,
 * database IDs, graph objects, compiler receipts or release eligibility are emitted.
 */
export function* createDistributionSamplingShards(kernel, options)
{
    validateSamplingRequest(kernel, options);
    const request = { ...options };
    const sample = counterStream(kernel.metadata.contentDigest, request.stream);
    let generated = 0;
    while (generated < request.count)
    {
        const length = Math.min(request.shardSize, request.count - generated);
        const startOrdinal = request.startOrdinal + generated;
        const samples = Array.from({ length }, (_, index) => sample(startOrdinal + index));
        const body = { schema: shardSchema, kernelDigest: kernel.metadata.contentDigest, stream: request.stream, startOrdinal, samples };
        yield deepFreeze({ ...body, contentDigest: canonicalDigest(body) });
        generated += length;
    }
}

/** Independently replay every counter and enforce contiguous shard coverage. */
export function verifyDistributionSamplingShards(kernel, options, shards)
{
    validateSamplingRequest(kernel, options);
    const request = { ...options };
    if (!shards || typeof shards[Symbol.iterator] !== 'function')
    {
        throw new Error('distribution_sampling_shards_invalid');
    }
    const sample = counterStream(kernel.metadata.contentDigest, request.stream);
    const shardDigests = createHash('sha256');
    let verified = 0;
    let shardCount = 0;
    for (const shard of shards)
    {
        exactKeys(shard, ['schema', 'kernelDigest', 'stream', 'startOrdinal', 'samples', 'contentDigest'], 'distribution_sampling_shard');
        const { contentDigest, ...body } = shard;
        assertDigest(contentDigest, 'shard.contentDigest');
        if (shard.schema !== shardSchema || shard.kernelDigest !== kernel.metadata.contentDigest
            || shard.stream !== request.stream || shard.startOrdinal !== request.startOrdinal + verified
            || !Array.isArray(shard.samples) || shard.samples.length !== Math.min(request.shardSize, request.count - verified)
            || shard.samples.length === 0)
        {
            throw new Error('distribution_sampling_shard_coverage_invalid');
        }
        if (canonicalDigest(body) !== contentDigest)
        {
            throw new Error('distribution_sampling_shard_digest_mismatch');
        }
        for (let index = 0; index < shard.samples.length; index += 1)
        {
            if (shard.samples[index] !== sample(shard.startOrdinal + index))
            {
                throw new Error('distribution_sampling_shard_replay_mismatch');
            }
        }
        verified += shard.samples.length;
        shardCount += 1;
        shardDigests.update(contentDigest.slice(7), 'ascii');
    }
    if (verified !== request.count)
    {
        throw new Error('distribution_sampling_shard_count_mismatch');
    }
    return deepFreeze({
        purpose: 'sampling-replay-only',
        releaseEvidenceEligible: false,
        kernelDigest: kernel.metadata.contentDigest,
        stream: request.stream,
        startOrdinal: request.startOrdinal,
        sampleCount: verified,
        shardCount,
        shardSequenceDigest: `sha256:${shardDigests.digest('hex')}`
    });
}
