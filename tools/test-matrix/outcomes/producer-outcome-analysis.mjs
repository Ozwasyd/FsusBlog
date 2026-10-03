import path from 'node:path';

import {
    outcomeNormalizationRules,
    readOutcomeFailureTaxonomy,
    validateOutcomeFieldDispositions,
    validateProducerSemanticOutcomeCandidate
} from './outcome-contract.mjs';
import { canonicalJson, digestCanonical } from '../../test/attempt-provenance.mjs';

export const producerOutcomeAnalysisSchema = 'fsusblog.producer-outcome-analysis.v1';
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const categories = new Set(['semantic-outcome', 'execution-identity', 'evidence-location',
    'diagnostic-metadata', 'volatile-metadata', 'secret-redacted']);
const rules = new Set(outcomeNormalizationRules);
const omitted = Symbol('non-semantic field');

function require(condition, message)
{
    if (!condition) throw new Error(`outcome analysis: ${message}`);
}

function object(value, label)
{
    require(value !== null && typeof value === 'object'
        && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype,
    `${label} must be a plain object`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    require(Reflect.ownKeys(value).length === Object.keys(value).length
        && Object.values(descriptors).every((item) => item.enumerable && Object.hasOwn(item, 'value')),
    `${label} must contain only enumerable JSON data fields`);
}

function sequence(value, label)
{
    require(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype,
        `${label} must be an array`);
    const keys = Reflect.ownKeys(value);
    require(keys.length === value.length + 1 && keys.includes('length')
        && Array.from({ length: value.length }, (_, index) => String(index)).every((key) =>
        {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
        }), `${label} must be a dense JSON data array`);
}

function exact(value, keys, label)
{
    object(value, label);
    require(canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()),
        `${label} fields are not exact`);
}

function text(value, label)
{
    require(typeof value === 'string' && value.length > 0, `${label} must be nonempty text`);
    return value;
}

function digest(value, label)
{
    require(typeof value === 'string' && digestPattern.test(value), `${label} must be SHA-256`);
    return value;
}

function compareText(left, right)
{
    return left < right ? -1 : left > right ? 1 : 0;
}

function ids(value, label)
{
    sequence(value, label);
    value.forEach((id) => text(id, label));
    require(new Set(value).size === value.length, `${label} has duplicate IDs`);
    return [...value].sort();
}

function freeze(value)
{
    if (value !== null && typeof value === 'object')
    {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

function policyRules(registry, producerId, authorityId)
{
    exact(registry, ['schema', 'schemaVersion', 'fingerprintAlgorithmVersion',
        'entries', 'canonicalization'], 'disposition registry');
    const policy = registry.canonicalization;
    exact(policy, ['schema', 'nestedFields', 'profiles'], 'canonicalization policy');
    require(policy.schema === 'fsusblog.outcome-canonicalization-policy.v1'
        && Array.isArray(policy.profiles) && Array.isArray(policy.nestedFields),
    'canonicalization policy version or lists are invalid');
    const producerIds = policy.profiles.map((profile) => profile.producerId);
    require(new Set(producerIds).size === producerIds.length, 'duplicate producer profiles');
    const profile = policy.profiles.find((item) => item.producerId === producerId);
    require(profile && profile.authorityId === authorityId, 'unregistered adapter producer/authority');
    exact(profile, ['producerId', 'authorityId', 'fields', 'setRelations',
        'successEqualSets', 'disjointSets', 'digestBindings'], 'producer profile');
    const entries = [...registry.entries, ...policy.nestedFields, ...profile.fields];
    const map = new Map();
    for (const entry of entries)
    {
        const expectedKeys = ['schemaPath', 'category', 'normalizationRule', 'owner',
            'proofTestId', 'reasonCode', ...(Object.hasOwn(entry, 'required') ? ['required'] : [])];
        exact(entry, expectedKeys, 'field disposition');
        require(!map.has(entry.schemaPath) && categories.has(entry.category)
            && rules.has(entry.normalizationRule) && entry.owner && entry.proofTestId
            && entry.reasonCode && (entry.required === undefined || typeof entry.required === 'boolean'),
        'missing, duplicate or unsupported field disposition');
        map.set(entry.schemaPath, entry);
    }
    return { map, profile };
}

function normalize(value, schemaPath, map, taxonomy, producerId, semanticOnly)
{
    const disposition = map.get(schemaPath);
    require(disposition, `unregistered field ${schemaPath}`);
    const rule = disposition.normalizationRule;
    let result;
    if (rule === 'canonical-object')
    {
        object(value, schemaPath);
        const children = [...map.keys()].filter((key) => key.startsWith(`${schemaPath}.`)
            && !key.slice(schemaPath.length + 1).includes('.')
            && !key.slice(schemaPath.length + 1).includes('[]'));
        const fields = children.map((key) => key.slice(schemaPath.length + 1));
        require(Object.keys(value).every((key) => fields.includes(key)), `unknown field in ${schemaPath}`);
        require(children.every((key) => map.get(key).required === false
            || Object.hasOwn(value, key.slice(schemaPath.length + 1))), `missing field in ${schemaPath}`);
        result = {};
        for (const key of Object.keys(value).sort())
        {
            const child = normalize(value[key], `${schemaPath}.${key}`, map, taxonomy, producerId, semanticOnly);
            if (child !== omitted) result[key] = child;
        }
    }
    else if (rule === 'sort-by-kind')
    {
        sequence(value, schemaPath);
        const seen = new Set();
        result = value.map((reference) =>
        {
            exact(reference, ['kind', 'path', 'digest'], 'input reference');
            text(reference.kind, 'input reference kind');
            const referenceIdentity = canonicalJson([reference.kind, reference.path]);
            require(!seen.has(referenceIdentity), 'duplicate or ambiguous input reference');
            seen.add(referenceIdentity);
            const item = {};
            for (const key of Object.keys(reference).sort())
            {
                const child = normalize(reference[key], `${schemaPath}[].${key}`,
                    map, taxonomy, producerId, semanticOnly);
                if (child !== omitted) item[key] = child;
            }
            return item;
        }).sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
    }
    else if (rule === 'ids') result = ids(value, schemaPath);
    else if (rule === 'text') result = text(value, schemaPath);
    else if (rule === 'repository-relative-path')
    {
        text(value, schemaPath);
        require(!value.includes('\\') && !path.posix.isAbsolute(value)
            && value.split('/').every((part) => part && part !== '.' && part !== '..'),
        `${schemaPath} must be an exact repository-relative reference`);
        result = value;
    }
    else if (['digest', 'content-seal', 'derived-digest'].includes(rule)) result = digest(value, schemaPath);
    else if (rule === 'positive-integer')
    {
        require(Number.isSafeInteger(value) && value > 0, `${schemaPath} must be a positive safe integer`);
        result = value;
    }
    else if (rule === 'nonnegative-number')
    {
        require(typeof value === 'number' && Number.isFinite(value) && value >= 0,
            `${schemaPath} must be a finite nonnegative number`);
        result = Object.is(value, -0) ? 0 : value;
    }
    else if (rule === 'boolean')
    {
        require(typeof value === 'boolean', `${schemaPath} must be boolean`);
        result = value;
    }
    else if (rule === 'exact')
    {
        require(value === null || typeof value === 'string' || typeof value === 'boolean'
            || (typeof value === 'number' && Number.isFinite(value)), `${schemaPath} must be scalar`);
        result = Object.is(value, -0) ? 0 : value;
    }
    else if (rule === 'digest-map' || rule === 'build-artifact-map')
    {
        object(value, schemaPath);
        result = Object.create(null);
        for (const id of Object.keys(value).sort())
        {
            text(id, 'semantic artifact ID');
            if (rule === 'digest-map') result[id] = digest(value[id], `${schemaPath}.${id}`);
            else
            {
                exact(value[id], ['contentDigest', 'imageDigest', 'manifestDigest', 'provenanceDigest'], 'build artifact');
                result[id] = {};
                for (const key of Object.keys(value[id]).sort())
                {
                    result[id][key] = key === 'imageDigest' && value[id][key] === null
                        ? null : digest(value[id][key], `build artifact ${id}.${key}`);
                }
            }
        }
    }
    else if (rule === 'reasons')
    {
        sequence(value, 'reasons');
        const seen = new Set();
        result = value.map((reason) =>
        {
            exact(reason, ['kind', 'producerId', 'identity'], 'canonical reason');
            const definition = taxonomy.get(reason.kind);
            require(definition && reason.producerId === producerId, 'unknown or cross-producer reason');
            exact(reason.identity, definition.requiredIdentity, 'reason identity');
            require(reason.identity.producerId === producerId, 'reason identity crosses producer');
            const identity = {};
            for (const key of Object.keys(reason.identity).sort())
            {
                identity[key] = key.endsWith('Digest') ? digest(reason.identity[key], key)
                    : key === 'attemptNumber' ? (require(Number.isSafeInteger(reason.identity[key])
                        && reason.identity[key] > 0, 'reason attempt number is invalid'), reason.identity[key])
                        : text(reason.identity[key], key);
            }
            const canonical = { identity, kind: reason.kind, producerId };
            const key = canonicalJson(canonical);
            require(!seen.has(key), 'duplicate canonical reason');
            seen.add(key);
            return canonical;
        }).sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
    }
    else if (rule === 'redacted-secret')
    {
        exact(value, ['present', 'type', 'digest'], 'redacted secret');
        require(typeof value.present === 'boolean' && typeof value.type === 'string' && value.type,
            'redacted secret presence/type is invalid');
        require(value.present ? digestPattern.test(value.digest) : value.digest === null,
            'redacted secret digest does not preserve presence');
        throw new Error('outcome analysis: secret semantic-context authority bridge is required');
    }
    if (semanticOnly && (['evidence-location', 'diagnostic-metadata', 'volatile-metadata'].includes(disposition.category)
        || ['content-seal', 'derived-digest'].includes(rule))) return omitted;
    return result;
}

function validateMembership(membership, profile, success)
{
    for (const relation of profile.setRelations)
    {
        exact(relation, ['subset', 'superset'], 'set relation');
        require(Array.isArray(membership[relation.subset]) && Array.isArray(membership[relation.superset])
            && membership[relation.subset].every((id) => membership[relation.superset].includes(id)),
        'membership contains an extra or unplanned ID');
    }
    for (const group of profile.disjointSets)
    {
        const members = group.flatMap((name) => membership[name]);
        require(members.every((id) => typeof id === 'string') && new Set(members).size === members.length,
            'terminal membership sets overlap');
    }
    if (success)
    {
        for (const group of profile.successEqualSets)
        {
            require(group.every((name) => canonicalJson(membership[name]) === canonicalJson(membership[group[0]])),
                'successful membership is incomplete');
        }
        for (const group of profile.disjointSets)
        {
            require(group.slice(1).every((name) => membership[name].length === 0),
                'successful membership contains failed or blocked members');
        }
    }
    for (const binding of profile.digestBindings)
    {
        exact(binding, ['map', 'ids'], 'digest binding');
        require(canonicalJson(Object.keys(membership[binding.map]).sort()) === canonicalJson(membership[binding.ids]),
            'semantic digest map does not exactly match members');
    }
}

// This is structural semantic analysis, not receipt origin or execution authentication.
// The external expected identity is mandatory; candidate fields never supply it.
export function analyzeProducerSemanticOutcomeCandidate(candidate, {
    expectedIdentity, expectedProducerId, expectedAuthorityId, metadata = {}
})
{
    const registry = validateOutcomeFieldDispositions();
    const taxonomy = readOutcomeFailureTaxonomy();
    validateProducerSemanticOutcomeCandidate(candidate, { taxonomy,
        expectedProducerId, expectedAuthorityId });
    require(typeof expectedProducerId === 'string' && typeof expectedAuthorityId === 'string',
        'external expected producer and authority are required');
    exact(expectedIdentity, Object.keys(candidate.identity), 'external expected identity');
    require(canonicalJson(expectedIdentity) === canonicalJson(candidate.identity), 'cross-run or cross-identity candidate');
    require(candidate.outcome.semanticPayloadDigest === digestCanonical(candidate.outcome.membership),
        'adapter membership digest was tampered');
    const { map, profile } = policyRules(registry, candidate.producerId, candidate.producerAuthorityId);
    const canonical = {};
    const semantic = {};
    for (const key of Object.keys(candidate).sort())
    {
        canonical[key] = normalize(candidate[key], `$.${key}`, map, taxonomy, candidate.producerId, false);
        const value = normalize(candidate[key], `$.${key}`, map, taxonomy, candidate.producerId, true);
        if (value !== omitted) semantic[key] = value;
    }
    const canonicalMetadata = normalize(metadata, '$metadata', map, taxonomy, candidate.producerId, false);
    const semanticMetadata = normalize(metadata, '$metadata', map, taxonomy, candidate.producerId, true);
    validateMembership(canonical.outcome.membership, profile, canonical.outcome.status === 'success');
    const version = { algorithm: registry.fingerprintAlgorithmVersion,
        candidateSchema: candidate.schema, registrySchema: registry.schema,
        registryVersion: registry.schemaVersion, registryDigest: digestCanonical(registry) };
    const semanticPayload = { candidate: semantic, metadata: semanticMetadata };
    return freeze({ schema: producerOutcomeAnalysisSchema, dataOnly: true,
        producerVerificationPending: true, version,
        producerId: candidate.producerId, producerAuthorityId: candidate.producerAuthorityId,
        identity: canonical.identity, inputAuthorityRefs: canonical.inputAuthorityRefs,
        candidateDigest: candidate.contentDigest,
        summary: { status: canonical.outcome.status, membership: canonical.outcome.membership,
            reasons: canonical.outcome.reasons, attemptEligibility: canonical.attemptEligibility },
        metadata: canonicalMetadata, semanticPayload,
        semanticPayloadDigest: digestCanonical(semanticPayload),
        outcomeFingerprint: digestCanonical({ version, semanticPayload }) });
}

// No authority factory exists here: original independent input/envelope/replay/
// temporal/policy owners must provide their real held bridge before sealing.
export function sealVerifiedProducerSemanticOutcome()
{
    throw new Error('sealed producer outcome unavailable: original independent authority bridge is required');
}
