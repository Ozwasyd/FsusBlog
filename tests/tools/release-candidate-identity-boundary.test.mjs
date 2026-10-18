import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { candidatePayload } from './release-candidate-test-support.mjs';

const { candidateIdentityFields, candidateSchemaDigest, candidatePolicyDigest,
    createCandidateIdentity, verifyCandidateIdentity } = await import(new URL('../../tools/release-candidate/identity-contract.mjs', import.meta.url));

// Seal malformed inputs independently so verifier tests cannot pass just because
// the production sealer refuses to construct them.
function externallySealed(payload)
{
    const canonicalJson = (value) => Array.isArray(value)
        ? `[${value.map(canonicalJson).join(',')}]`
        : value && typeof value === 'object'
            ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
            : JSON.stringify(value);
    return { ...payload, candidateIdentityDigest: `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}` };
}

for (const field of ['sourceCommit', 'randomSeedRoot'])
{
    test(`review regression: reject JSON singleton array in ${field}`, () =>
    {
        const payload = candidatePayload();
        payload[field] = [payload[field]];
        const roundtripped = JSON.parse(JSON.stringify(payload));
        assert.throws(() => createCandidateIdentity(roundtripped), new RegExp(field, 'u'));
        assert.throws(() => verifyCandidateIdentity(externallySealed(roundtripped)), new RegExp(field, 'u'));
    });
}

test('review regression: reject hidden run metadata', () =>
{
    const payload = candidatePayload();
    Object.defineProperty(payload, 'runId', { value: 'hidden-run' });
    assert.throws(() => createCandidateIdentity(payload), /runId|enumerable/u);
    const identity = createCandidateIdentity(candidatePayload());
    Object.defineProperty(identity, 'runId', { value: 'hidden-run' });
    assert.throws(() => verifyCandidateIdentity(identity), /runId|enumerable/u);
});

test('review regression: reject hidden required input before returning a seal', () =>
{
    const payload = candidatePayload();
    Object.defineProperty(payload, 'worktreeFingerprint', { enumerable: false });
    assert.throws(() => createCandidateIdentity(payload), /worktreeFingerprint|enumerable/u);
    const identity = createCandidateIdentity(candidatePayload());
    Object.defineProperty(identity, 'worktreeFingerprint', { enumerable: false });
    assert.throws(() => verifyCandidateIdentity(identity), /worktreeFingerprint|enumerable/u);
});

test('candidate scalar boundaries reject coercible objects and direct arrays', () =>
{
    for (const field of ['sourceCommit', 'randomSeedRoot'])
    {
        const valid = candidatePayload()[field];
        for (const value of [[valid], new String(valid), { toString: () => valid }, null, 0, true])
        {
            const payload = { ...candidatePayload(), [field]: value };
            assert.throws(() => createCandidateIdentity(payload), new RegExp(field, 'u'));
            assert.throws(() => verifyCandidateIdentity(externallySealed(payload)), new RegExp(field, 'u'));
        }
    }
});

test('candidate checks descriptors for every required own key and the seal', () =>
{
    for (const field of [...Object.keys(candidateIdentityFields), 'candidateIdentityDigest'])
    {
        const identity = createCandidateIdentity(candidatePayload());
        Object.defineProperty(identity, field, { enumerable: false });
        assert.throws(() => verifyCandidateIdentity(identity), /enumerable/u, field);
        if (field !== 'candidateIdentityDigest')
        {
            const payload = candidatePayload();
            Object.defineProperty(payload, field, { enumerable: false });
            assert.throws(() => createCandidateIdentity(payload), /enumerable/u, field);
        }
    }
});

test('candidate and digest maps refuse symbol hidden and accessor properties without invoking getters', () =>
{
    const mapFields = Object.entries(candidateIdentityFields)
        .filter(([, kind]) => kind.endsWith('digest-map')).map(([field]) => field);
    for (const field of [null, ...mapFields])
    {
        for (const property of ['hidden', 'accessor', 'symbol'])
        {
            for (const sealed of [false, true])
            {
                const input = sealed ? createCandidateIdentity(candidatePayload()) : candidatePayload();
                const target = field === null ? input : input[field];
                const key = property === 'symbol' ? Symbol('runId') : 'runId';
                let getterCalled = false;
                const readHidden = () =>
                {
                    getterCalled = true;
                    return 'hidden';
                };
                const descriptor = property === 'accessor'
                    ? { enumerable: true, get: readHidden }
                    : { enumerable: property === 'symbol', value: 'hidden' };
                Object.defineProperty(target, key, descriptor);
                assert.throws(() => sealed ? verifyCandidateIdentity(input) : createCandidateIdentity(input), /enumerable/u);
                assert.equal(getterCalled, false);
            }
        }
    }
});

test('candidate refuses accessor forms of known fields and semantic IDs without invoking getters', () =>
{
    for (const sealed of [false, true])
    {
        for (const field of ['worktreeFingerprint', 'lockfileDigests'])
        {
            const input = sealed ? createCandidateIdentity(candidatePayload()) : candidatePayload();
            const target = field === 'lockfileDigests' ? input[field] : input;
            const key = field === 'lockfileDigests' ? 'declared' : field;
            let getterCalled = false;
            const readHidden = () =>
            {
                getterCalled = true;
                return 'hidden';
            };
            Object.defineProperty(target, key, { enumerable: true, get: readHidden });
            assert.throws(() => sealed ? verifyCandidateIdentity(input) : createCandidateIdentity(input), /enumerable/u);
            assert.equal(getterCalled, false);
        }
    }
});

test('candidate validates the serialized snapshot before returning its seal', () =>
{
    const payload = candidatePayload();
    let ownKeyReads = 0;
    const changingInput = new Proxy(payload, {
        ownKeys: (target) =>
        {
            ownKeyReads += 1;
            return Reflect.ownKeys(target).filter((key) => ownKeyReads === 1 || key !== 'worktreeFingerprint');
        }
    });
    assert.throws(() => createCandidateIdentity(changingInput), /missing \[worktreeFingerprint\]/u);
});

test('candidate retains frozen JSON data schema policy and independent seal compatibility', () =>
{
    const payload = candidatePayload();
    for (const [field, kind] of Object.entries(candidateIdentityFields))
    {
        if (kind.endsWith('digest-map'))
        {
            Object.freeze(payload[field]);
        }
    }
    Object.freeze(payload);
    const identity = createCandidateIdentity(payload);
    assert.deepEqual(identity, externallySealed(payload));
    assert.equal(verifyCandidateIdentity(JSON.parse(JSON.stringify(identity))).candidateIdentityDigest,
        'sha256:550b815b5788099b239e2fa625b99ca55fe088b7f0fe9ea31004d6c5fb776f85');
    assert.equal(candidateSchemaDigest, 'sha256:90f7e53163dcce94a0a8550ef7a4f6ae92e110601ca5806d7c7e7aa9013dffb7');
    assert.equal(candidatePolicyDigest, 'sha256:604b334f82956622d6b2772b7c69212912b77757bb984b22d7f01225c5c5b182');
});
