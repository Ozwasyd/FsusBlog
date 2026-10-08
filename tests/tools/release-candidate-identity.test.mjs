import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import { candidatePayload, candidateIdentity, testDigest, otherDigest } from './release-candidate-test-support.mjs';

const { candidateIdentityFields, candidateSchemaDigest, candidatePolicyDigest, createCandidateIdentity,
    verifyCandidateIdentity, diffCandidateIdentities } = await import(new URL('../../tools/release-candidate/identity-contract.mjs', import.meta.url));

test('candidate identity binds its closed schema and policy content', () =>
{
    const identity = candidateIdentity();
    assert.equal(verifyCandidateIdentity(identity), identity);
    assert.equal(identity.identitySchemaDigest, candidateSchemaDigest);
    assert.equal(identity.identityPolicyDigest, candidatePolicyDigest);
    assert.equal(identity.schema, 'fsusblog.release-candidate-identity.v1');
    assert.equal(Object.keys(identity).length, Object.keys(candidateIdentityFields).length + 1);
});

test('every candidate semantic input changes its identity and names the mismatch field', () =>
{
    const baseline = candidateIdentity();
    for (const [field, kind] of Object.entries(candidateIdentityFields))
    {
        if (['schema', 'version', 'algorithm', 'schema-digest', 'policy-digest'].includes(kind))
        {
            continue;
        }
        let value = otherDigest;
        if (kind.endsWith('digest-map'))
        {
            value = { local: otherDigest };
        }
        if (kind === 'commit')
        {
            value = 'b'.repeat(40);
        }
        if (kind === 'seed')
        {
            value = '1'.repeat(64);
        }
        if (kind === 'epoch')
        {
            value = '2026-01-02T00:00:00.000Z';
        }
        if (kind === 'timezone')
        {
            value = 'Europe/London';
        }
        if (kind === 'text')
        {
            value = 'en-US';
        }
        const changed = candidateIdentity({ [field]: value });
        assert.notEqual(changed.candidateIdentityDigest, baseline.candidateIdentityDigest, field);
        assert.ok(diffCandidateIdentities(baseline, changed).some((change) => change.field.startsWith(field)), field);
    }
});

test('candidate excludes run metadata and rejects unknown future fields instead of dropping them', () =>
{
    for (const field of ['runId', 'ordinal', 'PID', 'pid', 'port', 'startedAt', 'duration', 'logs', 'mtime', 'ttl', 'age', 'newField'])
    {
        assert.throws(() => createCandidateIdentity({ ...candidatePayload(), [field]: 'diagnostic' }), /unknown/u);
    }
    const runA = { candidateIdentity: candidateIdentity(), runId: 'run-a', pid: 1, port: 123, startedAt: 'one' };
    const runB = { candidateIdentity: candidateIdentity(), runId: 'run-b', pid: 2, port: 456, startedAt: 'two' };
    assert.deepEqual(diffCandidateIdentities(runA.candidateIdentity, runB.candidateIdentity), []);
});

test('candidate requires explicit applicability and rejects omitted or undefined fields', () =>
{
    for (const field of Object.keys(candidateIdentityFields))
    {
        const payload = candidatePayload();
        delete payload[field];
        assert.throws(() => createCandidateIdentity(payload), /missing/u, field);
        assert.throws(() => createCandidateIdentity({ ...candidatePayload(), [field]: undefined }), Error, field);
    }
    assert.equal(candidateIdentity().imageDigest, null);
    assert.throws(() => candidateIdentity({ fixtureSchemaDigest: null }), /digest/u);
    assert.throws(() => candidateIdentity({ lockfileDigests: {} }), /explicit/u);
});

test('candidate rejects path branch tag timestamp and malformed content identities', () =>
{
    for (const value of ['master', 'v1.0', '/tmp/image', 'latest', 'sha256:short', '2026-01-01'])
    {
        assert.throws(() => candidateIdentity({ imageDigest: value }), /digest/u);
        assert.throws(() => candidateIdentity({ sourceCommit: value }), /40-hex/u);
    }
    assert.throws(() => candidateIdentity({ repositorySubmoduleOrAliasDigests: { '/tmp/local': testDigest } }), /semantic ID/u);
    assert.throws(() => candidateIdentity({ businessEpochUtc: '2026-02-30T00:00:00.000Z' }), /epoch/u);
    assert.throws(() => candidateIdentity({ timezone: 'Ambient' }), /timezone/u);
});

test('candidate algorithm schema and policy mismatches fail independently', () =>
{
    for (const patch of [{ algorithm: 'sha1' }, { identityVersion: 2 }, { schema: 'unknown' },
        { identitySchemaDigest: otherDigest }, { identityPolicyDigest: otherDigest }])
    {
        assert.throws(() => candidateIdentity(patch), /mismatch/u);
    }
});

test('candidate comparison independently rejects payload and digest tamper', () =>
{
    const baseline = candidateIdentity();
    assert.throws(() => verifyCandidateIdentity({ ...baseline, candidateIdentityDigest: otherDigest }), /digest mismatch/u);
    assert.throws(() => diffCandidateIdentities(baseline, { ...baseline, worktreeFingerprint: otherDigest }), /digest mismatch/u);
    assert.throws(() => verifyCandidateIdentity({ ...baseline, imageDigest: 'tag-only' }), /concrete/u);
});

test('candidate canonicalization ignores object and semantic map insertion order', () =>
{
    const payload = candidatePayload();
    payload.repositorySubmoduleOrAliasDigests = { ui: testDigest, core: otherDigest };
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    reordered.repositorySubmoduleOrAliasDigests = { core: otherDigest, ui: testDigest };
    assert.deepEqual(createCandidateIdentity(payload), createCandidateIdentity(reordered));
});
