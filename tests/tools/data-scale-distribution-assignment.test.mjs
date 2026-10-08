import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const {
    createDistributionSamplingKernel,
    createDistributionSamplingShards,
    createWeightedIndexSampler,
    distributionSamplingAlgorithm,
    verifyDistributionSamplingShards
} = await import(new URL('../../tools/data-scale/distribution-assignment.mjs', import.meta.url));
const { distributionCatalog, distributionCatalogDigest, distributionScenarioDigest } = await import(
    new URL('../../tools/data-scale/distribution-catalog.mjs', import.meta.url)
);
const { canonicalDigest } = await import(new URL('../../tools/data-scale/distribution-contract.mjs', import.meta.url));

// Digests describe algorithm-only synthetic identities, never producer capabilities.
const options = {
    scenarioId: distributionCatalog.scenarios[0].id,
    namespace: 'unit-sampling-only',
    sourceIdentityDigest: canonicalDigest({ fixture: 'source-unit-only' }),
    roleSetDigest: canonicalDigest({ fixture: 'roles-unit-only' })
};
const request = { stream: 'content', startOrdinal: 0, count: 23, shardSize: 7 };
const copy = (value) => structuredClone(value);
const seal = (value) =>
{
    const body = { ...value };
    delete body.contentDigest;
    return { ...body, contentDigest: canonicalDigest(body) };
};

function referenceSample(domainDigest, stream, ordinal)
{
    const bytes = createHash('sha256')
        .update(`fsusblog.distribution-sha256-counter-u53.v1\0${domainDigest.slice(7)}\0${stream}\0${ordinal}`, 'utf8')
        .digest();
    const top53 = BigInt(`0x${bytes.toString('hex')}`) >> 203n;
    return Number(top53) / 2 ** 53;
}

test('closed PRNG uses the first 53 SHA256 bits and remains a numerical capability', () =>
{
    assert.deepEqual(distributionSamplingAlgorithm, { algorithm: 'sha256-counter-u53', version: '1' });
    const kernel = createDistributionSamplingKernel(options);
    assert.equal(kernel.metadata.releaseEvidenceEligible, false);
    assert.equal(kernel.metadata.purpose, 'sampling-kernel-only');
    assert.equal(kernel.metadata.seed, distributionCatalog.scenarios[0].fixedSeed);
    assert.equal(kernel.metadata.catalogDigest, distributionCatalogDigest(distributionCatalog));
    assert.equal(kernel.metadata.scenarioDigest, distributionScenarioDigest(distributionCatalog.scenarios[0]));
    assert.equal(Object.isFrozen(kernel.metadata.prng), true);
    assert.throws(() =>
    {
        kernel.metadata.seed = 'changed';
    }, TypeError);
    for (const ordinal of [0, 1, 8191, 100000, 1000000, Number.MAX_SAFE_INTEGER])
    {
        const actual = kernel.unitInterval('content', ordinal);
        assert.equal(actual, referenceSample(kernel.metadata.contentDigest, 'content', ordinal));
        assert.ok(actual >= 0 && actual < 1);
    }
});

test('every real scenario has stable and isolated source-bound sampling identity', () =>
{
    const identities = new Set();
    const namespaces = new Set();
    for (const scenario of distributionCatalog.scenarios)
    {
        const input = { ...options, scenarioId: scenario.id, namespace: `unit-${scenario.id}` };
        const first = createDistributionSamplingKernel(input);
        const second = createDistributionSamplingKernel(input);
        assert.deepEqual(first.metadata, second.metadata);
        assert.deepEqual([...createDistributionSamplingShards(first, request)], [...createDistributionSamplingShards(second, request)]);
        identities.add(first.metadata.contentDigest);
        namespaces.add(first.metadata.namespace);
    }
    assert.equal(identities.size, 8);
    assert.equal(namespaces.size, 8);
    const original = createDistributionSamplingKernel(options);
    for (const change of [
        { namespace: 'other-namespace' },
        { sourceIdentityDigest: canonicalDigest({ source: 'changed-unit-only' }) },
        { roleSetDigest: canonicalDigest({ roles: 'changed-unit-only' }) }
    ])
    {
        const changed = createDistributionSamplingKernel({ ...options, ...change });
        assert.notEqual(original.metadata.contentDigest, changed.metadata.contentDigest);
        assert.notEqual(original.unitInterval('content', 0), changed.unitInterval('content', 0));
    }
    assert.notEqual(original.unitInterval('content', 0), original.unitInterval('time', 0));
});

test('identity seal includes fixed seed, PRNG, catalog and exact scenario bytes', () =>
{
    const { contentDigest, ...body } = createDistributionSamplingKernel(options).metadata;
    assert.equal(contentDigest, canonicalDigest(body));
    for (const change of [
        { seed: 'changed-unit-seed' },
        { prng: { algorithm: 'sha256-counter-u53', version: '2' } },
        { catalogDigest: canonicalDigest({ catalog: 'changed-unit-only' }) },
        { scenarioDigest: canonicalDigest({ scenario: 'changed-unit-only' }) }
    ])
    {
        assert.notEqual(contentDigest, canonicalDigest({ ...body, ...change }));
    }
});

test('sampling refuses unknown scenario and injected private seed, PRNG, shape or entropy inputs', () =>
{
    assert.throws(() => createDistributionSamplingKernel({ ...options, scenarioId: 'unknown' }), /scenario_unknown/u);
    for (const field of ['seed', 'prng', 'weights', 'compiler', 'now', 'random', 'mediaUrl'])
    {
        assert.throws(() => createDistributionSamplingKernel({ ...options, [field]: 'unit-only' }), /fields_invalid/u);
    }
    for (const namespace of ['', 'contains\0delimiter', 'contains space', 'x'.repeat(129)])
    {
        assert.throws(() => createDistributionSamplingKernel({ ...options, namespace }), /namespace_invalid/u);
    }
    assert.throws(() => createDistributionSamplingKernel({ ...options, roleSetDigest: 'unknown' }), /sha256/u);
    const kernel = createDistributionSamplingKernel(options);
    for (const ordinal of [-1, -0, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
    {
        assert.throws(() => kernel.unitInterval('content', ordinal), /ordinal_invalid/u);
    }
    assert.throws(() => kernel.unitInterval('content\0other', 0), /stream_invalid/u);
});

test('weighted primitive follows non-uniform boundaries and snapshots unit-only weights', () =>
{
    const weights = [1, 3, 12];
    const sample = createWeightedIndexSampler(weights);
    weights[0] = 1000;
    assert.equal(sample(0), 0);
    assert.equal(sample(1 / 16 - Number.EPSILON), 0);
    assert.equal(sample(1 / 16), 1);
    assert.equal(sample(1 / 4 - Number.EPSILON), 1);
    assert.equal(sample(1 / 4), 2);
    assert.equal(sample(1 - Number.EPSILON), 2);
    const counts = [0, 0, 0];
    const kernel = createDistributionSamplingKernel(options);
    for (let ordinal = 0; ordinal < 16000; ordinal += 1)
    {
        counts[sample(kernel.unitInterval('unit-only-weight-table', ordinal))] += 1;
    }
    assert.ok(counts[0] > 800 && counts[0] < 1200);
    assert.ok(counts[1] > 2600 && counts[1] < 3400);
    assert.ok(counts[2] > 11400 && counts[2] < 12600);
});

test('weighted primitive rejects empty, invalid and numerically invisible classes', () =>
{
    for (const weights of [[], null, [0, 1], [-1, 2], [NaN], [Infinity], [1, Number.EPSILON / 4], [Number.MAX_VALUE, Number.MAX_VALUE], Array(4097).fill(1)])
    {
        assert.throws(() => createWeightedIndexSampler(weights), /distribution_/u);
    }
    const sample = createWeightedIndexSampler([1]);
    for (const value of [-1, 1, NaN, Infinity, '0'])
    {
        assert.throws(() => sample(value), /unit_interval_invalid/u);
    }
});

test('weighted primitive refuses sparse, accessor, hidden and prototype-manipulated tables', () =>
{
    const sparse = Array(3);
    sparse[2] = 1;
    const hidden = Object.defineProperty([1], '0', { value: 1, enumerable: false });
    const accessor = Object.defineProperty([1], '0', { get: () => 1, enumerable: true });
    const extra = Object.assign([1], { privateWeight: 2 });
    const prototype = Object.defineProperty([1], '__proto__', { value: { injected: true }, enumerable: true });
    const inherited = Object.setPrototypeOf([1], Object.create(Array.prototype));
    for (const weights of [sparse, hidden, accessor, extra, prototype, inherited])
    {
        assert.throws(() => createWeightedIndexSampler(weights), /distribution_/u);
    }
});

test('bounded sample shards independently replay all ordinals and never report assignment or release completion', () =>
{
    const kernel = createDistributionSamplingKernel(options);
    const shards = [...createDistributionSamplingShards(kernel, request)];
    assert.deepEqual(shards.map((shard) => shard.samples.length), [7, 7, 7, 2]);
    assert.deepEqual(shards.map((shard) => shard.startOrdinal), [0, 7, 14, 21]);
    assert.equal(Object.isFrozen(shards[0].samples), true);
    const result = verifyDistributionSamplingShards(kernel, request, shards);
    assert.equal(result.sampleCount, 23);
    assert.equal(result.shardCount, 4);
    assert.equal(result.purpose, 'sampling-replay-only');
    assert.equal(result.releaseEvidenceEligible, false);
    assert.equal(Object.hasOwn(result, 'assignmentCount'), false);
    assert.deepEqual(result, verifyDistributionSamplingShards(kernel, request, createDistributionSamplingShards(kernel, request)));
    const subrange = { ...request, startOrdinal: 100 };
    assert.equal(verifyDistributionSamplingShards(kernel, subrange, createDistributionSamplingShards(kernel, subrange)).sampleCount, 23);
});

test('shard verifier rejects tamper even after a digest is recomputed', () =>
{
    const kernel = createDistributionSamplingKernel(options);
    const original = [...createDistributionSamplingShards(kernel, request)];
    const unsealed = copy(original);
    unsealed[0].samples[0] = 0;
    assert.throws(() => verifyDistributionSamplingShards(kernel, request, unsealed), /digest_mismatch/u);
    const resealed = copy(original);
    resealed[0].samples[0] = 0;
    resealed[0] = seal(resealed[0]);
    assert.throws(() => verifyDistributionSamplingShards(kernel, request, resealed), /replay_mismatch/u);
    for (const mutate of [
        (shards) => shards.pop(),
        (shards) => shards.push(copy(shards[0])),
        (shards) => shards.splice(1, 1),
        (shards) => shards.reverse(),
        (shards) =>
        {
            shards[0].startOrdinal = 1;
        },
        (shards) =>
        {
            shards[0].stream = 'time';
        },
        (shards) =>
        {
            shards[0].samples.pop();
        },
        (shards) =>
        {
            shards[0].schema = 'assignment-plan';
        },
        (shards) =>
        {
            shards[0].releaseEvidenceEligible = true;
        }
    ])
    {
        const shards = copy(original);
        mutate(shards);
        assert.throws(() => verifyDistributionSamplingShards(kernel, request, shards), /distribution_sampling_shard/u);
    }
    const other = createDistributionSamplingKernel({ ...options, namespace: 'another-scenario-instance' });
    assert.throws(() => verifyDistributionSamplingShards(other, request, original), /coverage_invalid/u);
});

test('stream generation and replay snapshot inputs before caller iteration mutates them', () =>
{
    const kernel = createDistributionSamplingKernel(options);
    const mutable = { ...request };
    const iterator = createDistributionSamplingShards(kernel, mutable);
    const first = iterator.next().value;
    mutable.count = 100;
    mutable.stream = 'changed';
    const shards = [first, ...iterator];
    assert.equal(verifyDistributionSamplingShards(kernel, request, shards).sampleCount, 23);
    const replayRequest = { ...request };
    function* adversarialIterator()
    {
        replayRequest.count = 1;
        replayRequest.stream = 'changed';
        yield* shards;
    }
    assert.equal(verifyDistributionSamplingShards(kernel, replayRequest, adversarialIterator()).sampleCount, 23);
});

test('unsafe ordinal interval fails before the first shard or verifier input is consumed', () =>
{
    const kernel = createDistributionSamplingKernel(options);
    const unsafe = { ...request, startOrdinal: Number.MAX_SAFE_INTEGER, count: 2, shardSize: 1 };
    const iterator = createDistributionSamplingShards(kernel, unsafe);
    assert.throws(() => iterator.next(), /distribution_sampling_count_invalid/u);
    let consumed = false;
    function* input()
    {
        consumed = true;
        yield {};
    }
    assert.throws(() => verifyDistributionSamplingShards(kernel, unsafe, input()), /distribution_sampling_count_invalid/u);
    assert.equal(consumed, false);
    for (const valid of [
        { startOrdinal: Number.MAX_SAFE_INTEGER, count: 1, shardSize: 1 },
        { startOrdinal: Number.MAX_SAFE_INTEGER - 1, count: 2, shardSize: 1 },
        { startOrdinal: Number.MAX_SAFE_INTEGER - 2, count: 3, shardSize: 2 }
    ])
    {
        const validRequest = { ...request, ...valid };
        const shards = [...createDistributionSamplingShards(kernel, validRequest)];
        assert.equal(verifyDistributionSamplingShards(kernel, validRequest, shards).sampleCount, valid.count);
    }
});

test('stream requests reject impossible count, memory size and forged local capability', () =>
{
    const kernel = createDistributionSamplingKernel(options);
    for (const change of [
        { count: 0 }, { count: 1000001 }, { count: 0.5 },
        { shardSize: 0 }, { shardSize: 4097 }, { shardSize: 0.5 },
        { startOrdinal: Number.MAX_SAFE_INTEGER }, { stream: 'unsafe\0stream' }, { privateParameter: true }
    ])
    {
        assert.throws(() => [...createDistributionSamplingShards(kernel, { ...request, ...change })], /distribution_sampling_/u);
    }
    assert.throws(() => [...createDistributionSamplingShards({ ...kernel }, request)], /kernel_invalid/u);
    assert.throws(() => verifyDistributionSamplingShards(kernel, request, {}), /shards_invalid/u);
});

for (const count of [100000, 1000000])
{
    test(`actual numerical sampler streams and replays ${count} samples with bounded shards`, (context) =>
    {
        const kernel = createDistributionSamplingKernel(options);
        const measuredRequest = { stream: 'algorithm-resource-probe', startOrdinal: 0, count, shardSize: 1024 };
        const before = process.memoryUsage();
        const start = process.hrtime.bigint();
        let maximumLength = 0;
        let maximumHeap = before.heapUsed;
        let maximumRss = before.rss;
        function* observedShards()
        {
            for (const shard of createDistributionSamplingShards(kernel, measuredRequest))
            {
                maximumLength = Math.max(maximumLength, shard.samples.length);
                const memory = process.memoryUsage();
                maximumHeap = Math.max(maximumHeap, memory.heapUsed);
                maximumRss = Math.max(maximumRss, memory.rss);
                yield shard;
            }
        }
        const result = verifyDistributionSamplingShards(kernel, measuredRequest, observedShards());
        const elapsedMilliseconds = Number(process.hrtime.bigint() - start) / 1000000;
        assert.equal(result.sampleCount, count);
        assert.equal(result.shardCount, Math.ceil(count / 1024));
        assert.equal(maximumLength, 1024);
        assert.ok(maximumHeap - before.heapUsed < 64 * 1024 * 1024, 'algorithm-only streaming heap growth exceeds 64 MiB');
        context.diagnostic(JSON.stringify({
            scope: 'numerical-sampler-and-replay-only',
            sampleCount: count,
            elapsedMilliseconds,
            observedHeapGrowthBytes: maximumHeap - before.heapUsed,
            observedRssGrowthBytes: maximumRss - before.rss,
            maximumShardSamples: maximumLength,
            assignmentPlanVerified: false,
            releaseEvidenceEligible: false
        }));
    });
}
