import { candidateIdentityFields, candidateIdentitySchema, candidateIdentityVersion, candidateSchemaDigest,
    candidatePolicyDigest, createCandidateIdentity } from '../../tools/release-candidate/identity-contract.mjs';

export const testDigest = `sha256:${'1'.repeat(64)}`;
export const otherDigest = `sha256:${'2'.repeat(64)}`;

export function candidatePayload()
{
    const payload = Object.fromEntries(Object.entries(candidateIdentityFields).map(([field, kind]) => [field,
        kind.endsWith('digest-map') ? (kind === 'nonempty-digest-map' ? { declared: testDigest } : {}) : testDigest]));
    return {
        ...payload, schema: candidateIdentitySchema, identityVersion: candidateIdentityVersion, algorithm: 'sha256',
        identitySchemaDigest: candidateSchemaDigest, identityPolicyDigest: candidatePolicyDigest,
        sourceCommit: 'a'.repeat(40), randomSeedRoot: '0'.repeat(64), businessEpochUtc: '2026-01-01T00:00:00.000Z',
        timezone: 'UTC', culture: 'Invariant', imageDigest: null, browserIdentityDigest: null
    };
}

export function candidateIdentity(overrides = {})
{
    return createCandidateIdentity({ ...candidatePayload(), ...overrides });
}

