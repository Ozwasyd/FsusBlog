import assert from 'node:assert/strict';
import test from 'node:test';

const { createCommentIdPlan, validateCommentSnowflakePolicy, verifyCommentIdPlan } = await import(new URL('../../tools/data-scale/comment-id-plan.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../tools/test/temporal-context-contract.mjs', import.meta.url));

const businessEpochUtc = '2024-02-29T23:59:59.000Z';
const policy = {
    schema: 'fsusblog.comment-snowflake-policy.v1',
    algorithmVersion: 'controlled-contract-core',
    epoch: '2000-01-01T00:00:00.000Z',
    nodeBits: 5,
    sequenceBits: 4,
    maxNodeId: 31,
    maxSequencePerMillisecond: 16,
    fixtureReservedNodeId: 31,
    productionAssignedNodeIds: [0, 1],
    productionCoreDigest: `sha256:${'a'.repeat(64)}`,
    productionNodeInventoryDigest: `sha256:${'b'.repeat(64)}`
};

// A coordinate registry proves the adapter contract without implementing or
// claiming parity with SqlSugar's unavailable production Snowflake core.
function controlledCore()
{
    const encoded = new Map();
    const decoded = new Map();
    return {
        algorithmVersion: policy.algorithmVersion,
        contentDigest: policy.productionCoreDigest,
        encode(coordinate)
        {
            const key = digestCanonical(coordinate);
            if (!encoded.has(key))
            {
                const id = 1_000_000_000_000_000_000n + BigInt(encoded.size);
                encoded.set(key, id);
                decoded.set(id, { ...coordinate });
            }
            return encoded.get(key);
        },
        decode: (id) => decoded.get(id)
    };
}

test('comment plan requires the production core and nonoverlapping node authority', () =>
{
    assert.throws(() => createCommentIdPlan({ policy, businessEpochUtc, count: 1 }), /capability is missing/u);
    assert.throws(() => createCommentIdPlan({ policy, core: { ...controlledCore(), contentDigest: `sha256:${'c'.repeat(64)}` }, businessEpochUtc, count: 1 }), /mismatched/u);
    for (const productionAssignedNodeIds of [[], [31], [0, 0], [-1], [32]])
    {
        assert.throws(() => validateCommentSnowflakePolicy({ ...policy, productionAssignedNodeIds }), /non-overlap/u);
    }
    assert.throws(() => validateCommentSnowflakePolicy({ ...policy, fixtureReservedNodeId: 30 }), /inconsistent/u);
    assert.throws(() => validateCommentSnowflakePolicy({ ...policy, productionNodeInventoryDigest: null }), /inventory/u);
});

test('comment plan streams explicit coordinates through the supplied core across sequence rollover', () =>
{
    const core = controlledCore();
    const plan = createCommentIdPlan({ policy, core, businessEpochUtc, count: 100_000 });
    assert.equal(new Set(plan.ids).size, 100_000);
    assert.equal(plan.rootIds.length, 50_000);
    assert.equal(plan.nested.length, 50_000);
    assert.deepEqual(core.decode(BigInt(plan.ids[15])), {
        timestampMs: Date.parse(businessEpochUtc), nodeId: 31, sequence: 15
    });
    assert.deepEqual(core.decode(BigInt(plan.ids[16])), {
        timestampMs: Date.parse(businessEpochUtc) + 1, nodeId: 31, sequence: 0
    });
    assert.ok(plan.ids.every((id, index) => index === 0 || BigInt(id) > BigInt(plan.ids[index - 1])));
    const roots = new Set(plan.rootIds);
    assert.ok(plan.nested.every((row) => roots.has(row.parentId) && roots.has(row.rootId)));
    assert.equal(createCommentIdPlan({ policy, core, businessEpochUtc, count: 100_000 }).contentDigest, plan.contentDigest);
    assert.equal(verifyCommentIdPlan({ plan, policy, core }).contentDigest, plan.contentDigest);
});

test('comment plan rejects duplicate numeric lossy and decoder-drifted IDs', () =>
{
    const duplicate = controlledCore();
    duplicate.encode = () => 1n;
    duplicate.decode = () => ({ timestampMs: Date.parse(businessEpochUtc), nodeId: 31, sequence: 0 });
    assert.throws(() => createCommentIdPlan({ policy, core: duplicate, businessEpochUtc, count: 2 }), /strictly increasing/u);
    for (const id of [1, 0n, -1n, '01', 1n << 63n])
    {
        assert.throws(() => createCommentIdPlan({ policy, core: { ...controlledCore(), encode: () => id }, businessEpochUtc, count: 1 }), /exact positive/u);
    }
    assert.throws(() => createCommentIdPlan({ policy, core: { ...controlledCore(), decode: () => ({}) }, businessEpochUtc, count: 1 }), /coordinate/u);
});

test('comment replay rejects resealed IDs policy and root relation tamper', () =>
{
    const core = controlledCore();
    const plan = createCommentIdPlan({ policy, core, businessEpochUtc, count: 4 });
    for (const mutate of [
        (changed) =>
        {
            changed.ids[0] = '1';
        },
        (changed) =>
        {
            changed.nested[0].rootId = '1';
        },
        (changed) =>
        {
            changed.policyDigest = `sha256:${'c'.repeat(64)}`;
        }
    ])
    {
        const changed = structuredClone(plan);
        mutate(changed);
        changed.idsDigest = digestCanonical(changed.ids);
        changed.nestedIdsDigest = digestCanonical(changed.nested);
        delete changed.contentDigest;
        changed.contentDigest = digestCanonical(changed);
        assert.throws(() => verifyCommentIdPlan({ plan: changed, policy, core }), /canonical core/u);
    }
    assert.equal(createCommentIdPlan({ policy, core, businessEpochUtc, count: 0 }).firstId, null);
    assert.throws(() => createCommentIdPlan({ policy, core, businessEpochUtc: policy.epoch, count: 1 }), /policy range/u);
});
