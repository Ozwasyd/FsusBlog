import { URL } from 'node:url';

const { canonicalJson, digestCanonical } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));

export const candidateIdentitySchema = 'fsusblog.release-candidate-identity.v1';
export const candidateIdentityVersion = 1;
export const digestPattern = /^sha256:[0-9a-f]{64}$/u;

// This closed descriptor is the sole candidate-input schema. Receipts remain
// under their existing domain owners; only their content identities enter here.
export const candidateIdentityFields = Object.freeze({
    schema: 'schema',
    identityVersion: 'version',
    algorithm: 'algorithm',
    identitySchemaDigest: 'schema-digest',
    identityPolicyDigest: 'policy-digest',
    sourceCommit: 'commit',
    repositoryIdentityDigest: 'digest',
    worktreeFingerprint: 'digest',
    sourcePolicyDigest: 'digest',
    repositorySubmoduleOrAliasDigests: 'digest-map',
    lockfileDigests: 'nonempty-digest-map',
    configurationDigests: 'nonempty-digest-map',
    testMatrixDigest: 'digest',
    coverageRegistryDigest: 'digest',
    lifecycleRegistryDigest: 'digest',
    requiredEvidenceCatalogDigest: 'digest',
    projectionCatalogDigests: 'digest-map',
    stateDomainCatalogDigest: 'digest',
    retryPolicyDigest: 'digest',
    outcomeNormalizationPolicyDigest: 'digest',
    immutableBuildReceiptDigest: 'digest',
    immutableBuildArtifactSetDigest: 'digest',
    toolchainDigest: 'digest',
    imageDigest: 'nullable-digest',
    fixtureProfileDigest: 'digest',
    fixtureCatalogDigest: 'digest',
    fixtureSchemaDigest: 'digest',
    fixtureSeedDigest: 'digest',
    fixturePolicyDigest: 'digest',
    fixtureVariantPlanDigest: 'digest',
    fixtureProducerDagDigest: 'digest',
    fixtureReceiptDigest: 'digest',
    executionEnvelopePlanDigest: 'digest',
    replayPlanDigest: 'digest',
    schedulerPlanDigest: 'digest',
    randomSeedRoot: 'seed',
    temporalContextDigest: 'digest',
    businessEpochUtc: 'epoch',
    timezone: 'timezone',
    culture: 'text',
    runtimeIdentityDigest: 'digest',
    browserIdentityDigest: 'nullable-digest',
    serviceImageDigests: 'digest-map',
    serviceTopologyDigest: 'digest',
    networkPolicyDigest: 'digest'
});

export const candidateIdentityPolicy = Object.freeze({
    schema: 'fsusblog.release-candidate-input-policy.v1',
    inputChange: 'new-candidate',
    expiry: 'none',
    nullableFields: ['browserIdentityDigest', 'imageDigest'],
    runMetadata: ['runId', 'ordinal', 'pid', 'port', 'startedAt', 'duration', 'logs'],
    collectionAuthorities: ['source', 'aliases', 'policy', 'build', 'fixture', 'execution']
});

export const candidateSchemaDigest = digestCanonical(candidateIdentityFields);
export const candidatePolicyDigest = digestCanonical(candidateIdentityPolicy);

export function exactKeys(value, keys, label)
{
    if (!value || Object.getPrototypeOf(value) !== Object.prototype)
    {
        throw new Error(`${label} must be a plain object`);
    }
    const missing = keys.filter((key) => !Object.hasOwn(value, key));
    const unknown = Object.keys(value).filter((key) => !keys.includes(key));
    if (missing.length || unknown.length)
    {
        throw new Error(`${label}: missing [${missing.join(', ')}]; unknown [${unknown.join(', ')}]`);
    }
}

export function requireDigest(value, label)
{
    if (typeof value !== 'string' || !digestPattern.test(value))
    {
        throw new Error(`${label} must be a concrete sha256 content digest`);
    }
    return value;
}

function validateField(value, kind, field)
{
    if (kind === 'digest' || kind === 'schema-digest' || kind === 'policy-digest')
    {
        requireDigest(value, field);
    }
    else if (kind === 'nullable-digest')
    {
        if (value !== null)
        {
            requireDigest(value, field);
        }
    }
    else if (kind.endsWith('digest-map'))
    {
        if (!value || Object.getPrototypeOf(value) !== Object.prototype
            || (kind === 'nonempty-digest-map' && Object.keys(value).length === 0))
        {
            throw new Error(`${field} must be an explicit semantic-ID digest map`);
        }
        for (const [id, digest] of Object.entries(value))
        {
            if (!/^[a-z][a-z0-9._-]*$/u.test(id))
            {
                throw new Error(`${field}: invalid semantic ID ${id}`);
            }
            requireDigest(digest, `${field}.${id}`);
        }
    }
    else if (kind === 'commit' && !/^[0-9a-f]{40}$/u.test(value ?? ''))
    {
        throw new Error(`${field} must be a full lowercase 40-hex commit`);
    }
    else if (kind === 'seed' && !/^[0-9a-f]{64}$/u.test(value ?? ''))
    {
        throw new Error(`${field} must be an explicit 256-bit root seed`);
    }
    else if (kind === 'epoch')
    {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
            || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
        {
            throw new Error(`${field} must be a concrete canonical business epoch`);
        }
    }
    else if (kind === 'timezone')
    {
        if (typeof value !== 'string')
        {
            throw new Error(`${field} must be explicit`);
        }
        try
        {
            new Intl.DateTimeFormat('en', { timeZone: value });
        }
        catch
        {
            throw new Error(`${field} must be an explicit valid timezone`);
        }
    }
    else if (kind === 'text' && (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(value)))
    {
        throw new Error(`${field} must be an explicit culture`);
    }
}

function verifyPayload(payload)
{
    exactKeys(payload, Object.keys(candidateIdentityFields), 'candidate identity');
    for (const [field, kind] of Object.entries(candidateIdentityFields))
    {
        validateField(payload[field], kind, field);
    }
    if (payload.schema !== candidateIdentitySchema || payload.identityVersion !== candidateIdentityVersion
        || payload.algorithm !== 'sha256' || payload.identitySchemaDigest !== candidateSchemaDigest
        || payload.identityPolicyDigest !== candidatePolicyDigest)
    {
        throw new Error('candidate identity schema/version/algorithm/policy mismatch');
    }
    return payload;
}

/** Seal only complete inputs. Run metadata belongs in a separate run receipt. */
export function createCandidateIdentity(payload)
{
    verifyPayload(payload);
    const copied = JSON.parse(canonicalJson(payload));
    return { ...copied, candidateIdentityDigest: digestCanonical(copied) };
}

/** Recompute the content before comparing any supplied digest string. */
export function verifyCandidateIdentity(identity)
{
    exactKeys(identity, [...Object.keys(candidateIdentityFields), 'candidateIdentityDigest'], 'candidate identity');
    const { candidateIdentityDigest, ...payload } = identity;
    verifyPayload(payload);
    requireDigest(candidateIdentityDigest, 'candidateIdentityDigest');
    if (digestCanonical(payload) !== candidateIdentityDigest)
    {
        throw new Error('candidate identity digest mismatch');
    }
    return identity;
}

export function diffCandidateIdentities(left, right)
{
    verifyCandidateIdentity(left);
    verifyCandidateIdentity(right);
    const changes = [];
    const visit = (a, b, field) =>
    {
        if (canonicalJson(a) === canonicalJson(b))
        {
            return;
        }
        if (a && b && typeof a === 'object' && typeof b === 'object')
        {
            for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
            {
                visit(a[key] ?? null, b[key] ?? null, `${field}.${key}`);
            }
        }
        else
        {
            changes.push({ field, left: a, right: b });
        }
    };
    for (const field of Object.keys(candidateIdentityFields))
    {
        visit(left[field], right[field], field);
    }
    return changes;
}
