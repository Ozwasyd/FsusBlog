import { URL } from 'node:url';

const { digestCanonical, sealContentDigest } = await import(new URL('../attempt-provenance.mjs', import.meta.url));
const { validateCanonicalTestId, validateReplayPlan } = await import(new URL('../execution-replay-contract.mjs', import.meta.url));

export const staticAssertionMembershipSchema = 'fsusblog.static-assertion-membership.v1';

function same(left, right, label)
{
    if (digestCanonical(left) !== digestCanonical(right))
    {
        throw new Error(`static assertion membership ${label} mismatch`);
    }
}

function exactKeys(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error(`static assertion membership ${label} must be an object`);
    }
    same(Object.keys(value).sort(), [...keys].sort(), `${label} fields`);
}

function testIds(values, label)
{
    if (!Array.isArray(values))
    {
        throw new Error(`static assertion membership ${label} must be an array`);
    }
    values.forEach(validateCanonicalTestId);
    same(values, [...new Set(values)].sort(), `${label} sorted unique roster`);
    return values;
}

/** Preserve original assertion identities while consuming the replay owner's exact canonical enumeration. */
export function validateStaticAssertionMembership(producer, membership, replayPlan)
{
    exactKeys(membership, ['schema', 'producerId', 'legacyPhysicalTestIds', 'assertionBindings',
        'additionalTestIds', 'contentDigest'], 'receipt');
    const { contentDigest, ...body } = membership;
    same(contentDigest, digestCanonical(body), 'content digest');
    same(membership.schema, staticAssertionMembershipSchema, 'schema');
    same(membership.producerId, producer.id, 'producer');
    same(membership.legacyPhysicalTestIds, producer.legacyPhysicalTestIds, 'original logical test IDs');
    const replay = validateReplayPlan(replayPlan);
    same(replay.producer.id, producer.id, 'replay producer');
    if (!Array.isArray(membership.assertionBindings))
    {
        throw new Error('static assertion membership requires original assertion bindings');
    }
    const original = [...producer.assertionBindings].sort((left, right) => left.id.localeCompare(right.id));
    const supplied = [...membership.assertionBindings].sort((left, right) => left.id.localeCompare(right.id));
    same(supplied.map(entry => entry.id), original.map(entry => entry.id), 'original assertion roster');
    const observed = [];
    supplied.forEach((entry, index) =>
    {
        exactKeys(entry, [...Object.keys(original[index]), 'replayTestIds'], 'assertion');
        const { replayTestIds, ...binding } = entry;
        same(binding, original[index], 'original assertion/test/coverage/artifact identity');
        if (testIds(replayTestIds, 'assertion replay IDs').length === 0)
        {
            throw new Error('static assertion membership requires a replay observation for every original assertion');
        }
        observed.push(...replayTestIds);
    });
    observed.push(...testIds(membership.additionalTestIds, 'additional replay IDs'));
    if (new Set(observed).size !== observed.length)
    {
        throw new Error('static assertion membership cannot assign one test to multiple assertions');
    }
    same(observed.sort(), replay.testEnumerationOrder, 'complete replay enumeration');
    if (observed.length === 0)
    {
        throw new Error('static assertion membership requires explicit physical test membership');
    }
    return sealContentDigest({
        schema: 'fsusblog.static-assertion-membership-projection.v1',
        producerId: producer.id,
        originalAssertionBindings: original,
        legacyPhysicalTestIds: producer.legacyPhysicalTestIds,
        replayTestIds: observed,
        membershipDigest: membership.contentDigest,
        replayPlanDigest: replay.planDigest,
        qualificationEligible: false
    });
}
