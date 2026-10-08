const { digestCanonical, validateBusinessEpochUtc } = await import(new URL('../test/temporal-context-contract.mjs', import.meta.url));

const policySchema = 'fsusblog.comment-snowflake-policy.v1';
const planSchema = 'fsusblog.data-scale-comment-id-plan.v1';
const maximumId = (1n << 63n) - 1n;

function requireDigest(value, label)
{
    if (!/^sha256:[a-f0-9]{64}$/u.test(value ?? ''))
    {
        throw new Error(`comment ID plan requires an exact ${label} digest`);
    }
}

/** Validate a supplied production policy; this module never chooses Snowflake parameters or node assignments. */
export function validateCommentSnowflakePolicy(policy)
{
    if (policy?.schema !== policySchema || typeof policy.algorithmVersion !== 'string'
        || !policy.algorithmVersion.trim())
    {
        throw new Error('comment ID plan requires the canonical Snowflake policy');
    }
    validateBusinessEpochUtc(policy.epoch);
    for (const field of ['nodeBits', 'sequenceBits'])
    {
        if (!Number.isInteger(policy[field]) || policy[field] < 1 || policy[field] > 20)
        {
            throw new Error(`comment Snowflake ${field} is invalid`);
        }
    }
    if (policy.nodeBits + policy.sequenceBits >= 63
        || policy.maxNodeId !== 2 ** policy.nodeBits - 1
        || policy.maxSequencePerMillisecond !== 2 ** policy.sequenceBits
        || policy.fixtureReservedNodeId !== policy.maxNodeId)
    {
        throw new Error('comment Snowflake policy bit limits or reserved node are inconsistent');
    }
    const nodes = policy.productionAssignedNodeIds;
    if (!Array.isArray(nodes) || nodes.length === 0 || new Set(nodes).size !== nodes.length
        || nodes.some((node) => !Number.isInteger(node) || node < 0 || node >= policy.fixtureReservedNodeId))
    {
        throw new Error('comment Snowflake production node inventory must prove exact reserved-node non-overlap');
    }
    requireDigest(policy.productionCoreDigest, 'production core');
    requireDigest(policy.productionNodeInventoryDigest, 'production node inventory');
    return policy;
}

function requireCore(policy, core)
{
    if (typeof core?.encode !== 'function' || typeof core?.decode !== 'function'
        || core.algorithmVersion !== policy.algorithmVersion || core.contentDigest !== policy.productionCoreDigest)
    {
        throw new Error('canonical production Snowflake encode/decode capability is missing or mismatched');
    }
}

function idText(value)
{
    if ((typeof value !== 'bigint' && typeof value !== 'string')
        || !/^[1-9][0-9]*$/u.test(String(value)) || BigInt(value) > maximumId)
    {
        throw new Error('comment Snowflake IDs must be exact positive signed 64-bit integers');
    }
    return String(value);
}

function coordinate(policy, businessEpochUtc, index)
{
    return {
        timestampMs: Date.parse(businessEpochUtc) + Math.floor(index / policy.maxSequencePerMillisecond),
        nodeId: policy.fixtureReservedNodeId,
        sequence: index % policy.maxSequencePerMillisecond
    };
}

function relationships(ids)
{
    const rootCount = Math.ceil(ids.length / 2);
    const rootIds = ids.slice(0, rootCount);
    const nested = ids.slice(rootCount).map((id, index) => ({
        id, parentId: rootIds[index % rootCount], rootId: rootIds[index % rootCount]
    }));
    return { rootIds, nested };
}

function requireDecodedCoordinate(core, id, expected)
{
    const decoded = core.decode(BigInt(id));
    if (decoded?.timestampMs !== expected.timestampMs || decoded?.nodeId !== expected.nodeId
        || decoded?.sequence !== expected.sequence)
    {
        throw new Error('comment Snowflake decoder does not reproduce the planned coordinate');
    }
}

/** Generate a sealed fixture plan only through a supplied production core; no fixture-private ID algorithm exists here. */
export function createCommentIdPlan({ policy, core, businessEpochUtc, count })
{
    validateCommentSnowflakePolicy(policy);
    requireCore(policy, core);
    validateBusinessEpochUtc(businessEpochUtc);
    if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000
        || Date.parse(businessEpochUtc) <= Date.parse(policy.epoch))
    {
        throw new Error('comment ID count or business epoch is outside the policy range');
    }
    const ids = [];
    for (let index = 0; index < count; index += 1)
    {
        const expected = Object.freeze(coordinate(policy, businessEpochUtc, index));
        const id = idText(core.encode(expected));
        if (index > 0 && BigInt(id) <= BigInt(ids[index - 1]))
        {
            throw new Error('canonical Snowflake IDs must be unique and strictly increasing');
        }
        requireDecodedCoordinate(core, id, expected);
        ids.push(id);
    }
    const { rootIds, nested } = relationships(ids);
    const plan = {
        schema: planSchema,
        algorithmVersion: policy.algorithmVersion,
        businessEpochUtc,
        nodeId: policy.fixtureReservedNodeId,
        count,
        firstId: ids[0] ?? null,
        lastId: ids.at(-1) ?? null,
        ids,
        rootIds,
        nested,
        idsDigest: digestCanonical(ids),
        rootIdsDigest: digestCanonical(rootIds),
        nestedIdsDigest: digestCanonical(nested),
        policyDigest: digestCanonical(policy)
    };
    return Object.freeze({ ...plan, contentDigest: digestCanonical(plan) });
}

/** Recompute every encoded/decoded ID and relationship rather than trusting a resealed caller's digests. */
export function verifyCommentIdPlan({ plan, policy, core })
{
    const expected = createCommentIdPlan({ policy, core, businessEpochUtc: plan?.businessEpochUtc, count: plan?.count });
    if (plan?.schema !== planSchema || digestCanonical(plan) !== digestCanonical(expected))
    {
        throw new Error('comment ID plan differs from the exact canonical core and policy replay');
    }
    return expected;
}
