import crypto from 'node:crypto';

export const releaseFinalSpawnSealSchema = 'fsusblog.release-final-spawn-seal.v1';

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonicalize(value[key])]));
}

function digestValue(value)
{
    return `sha256:${crypto.createHash('sha256')
        .update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

export function createReleaseFinalSpawnSeal({
    schedulerNonce,
    schedulerRunId,
    schedulerCandidateIdentityDigest,
    sourceState,
    context,
    evidenceBindings
})
{
    assert(/^[0-9a-f]{64}$/u.test(schedulerNonce ?? ''), 'release-final scheduler nonce is invalid');
    assert(Array.isArray(evidenceBindings) && evidenceBindings.length === 2,
        'release-final seal requires exactly two evidence binding receipts');
    const payload = {
        schema: releaseFinalSpawnSealSchema,
        producer: 'tools/test-matrix/release-final-spawn-seal.mjs',
        schedulerRunId,
        schedulerCandidateIdentityDigest,
        sourceState: structuredClone(sourceState),
        contextDigest: context.contentDigest,
        attemptId: context.attemptId,
        candidateIdentity: structuredClone(context.candidateIdentity),
        buildIdentity: structuredClone(context.buildIdentity),
        evidenceBindings: evidenceBindings.map((binding) => ({
            authorityId: binding.authorityId,
            bindingDigest: binding.bindingDigest,
            inputDigest: binding.inputDigest,
            producerReceiptDigest: binding.producerReceiptDigest
        })).sort((left, right) => left.authorityId.localeCompare(right.authorityId)),
        schedulerNonceDigest: digestValue(schedulerNonce)
    };
    return { ...payload, contentDigest: digestValue(payload) };
}

export function verifyReleaseFinalSpawnSeal(seal, expected)
{
    assert(seal?.schema === releaseFinalSpawnSealSchema, 'release-final spawn seal schema mismatch');
    const { contentDigest, ...payload } = seal;
    assert(contentDigest === digestValue(payload), 'release-final spawn seal content digest mismatch');
    const independentlyProduced = createReleaseFinalSpawnSeal(expected);
    assert(JSON.stringify(canonicalize(seal)) === JSON.stringify(canonicalize(independentlyProduced)),
        'release-final spawn seal does not exact-match scheduler current-run authority');
    return seal;
}
