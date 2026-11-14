import fs from 'node:fs';

import { readOutcomeFailureTaxonomy } from './outcome-contract.mjs';
import { assertOutcomeAnalysisData } from './strong-outcome-analysis.mjs';

const { canonicalJson, digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const { validateJsonSchema } = await import(new URL('../schema-validator/validate.mjs', import.meta.url));

const recordSets = new Set(['assertions', 'caseIdentities', 'projectionReceipts', 'failures',
    'members', 'memberOutcomes', 'failureReasons']);

function require(condition, message)
{
    if (!condition)
    {
        throw new Error(`domain outcome analysis: ${message}`);
    }
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

function ordered(left, right)
{
    const a = canonicalJson(left);
    const b = canonicalJson(right);
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Canonicalize only schema-declared ID sets and the domain's record collections.
 * Ordered lifecycle arrays retain their original order. No admitted field is dropped.
 */
function normalizeShape(value, schema, field = '')
{
    if (value === null || typeof value !== 'object')
    {
        return value;
    }
    const shape = schema.anyOf?.find((item) => item.type === (Array.isArray(value) ? 'array' : 'object')) ?? schema;
    if (Array.isArray(value))
    {
        const normalized = value.map((item) => normalizeShape(item, shape.items));
        return shape.uniqueItems || recordSets.has(field) ? normalized.sort(ordered) : normalized;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key,
        normalizeShape(value[key], shape.properties?.[key] ?? shape.additionalProperties, key)]));
}

export function normalizeOutcomeIdsMap(value)
{
    require(value !== null && typeof value === 'object' && !Array.isArray(value), 'ID map must be an object');
    return Object.fromEntries(Object.keys(value).sort().map((key) =>
    {
        const ids = value[key];
        require(key.length > 0 && Array.isArray(ids) && ids.every((id) => typeof id === 'string' && id.length > 0)
            && new Set(ids).size === ids.length, 'ID map entries must be unique nonempty IDs');
        return [key, [...ids].sort()];
    }));
}

function memberShapes()
{
    return JSON.parse(fs.readFileSync(new URL('../../../config/schemas/outcome-adapter-membership.schema.json', import.meta.url)));
}

/** Consume the original owner's closed scoped-failure shape and failure taxonomy. */
export function normalizeScopedOutcomeReasons(reasons, producerId, taxonomy = readOutcomeFailureTaxonomy())
{
    const shapes = memberShapes();
    const schema = shapes.$defs.reliability.properties.memberOutcomes.items.properties.failureReasons;
    const errors = validateJsonSchema(reasons, schema);
    require(errors.length === 0, errors.join('; '));
    const seen = new Set();
    for (const reason of reasons)
    {
        const definition = taxonomy.get(reason.kind);
        require(definition && reason.producerId === producerId && reason.identity.producerId === producerId
            && definition.requiredIdentity.every((key) => Object.hasOwn(reason.identity, key)),
        'unknown, incomplete or cross-producer scoped failure');
        require(!reason.failureClass || reason.failureClass === reason.kind.split('.')[0], 'failure class disagrees with kind');
        const key = canonicalJson(normalizeShape(reason, schema.items));
        require(!seen.has(key), 'duplicate scoped failure');
        seen.add(key);
    }
    return normalizeShape(reasons, schema, 'failureReasons');
}

/** DATA_ONLY source-bound analysis of complete domain schemas. The original
 * contract owns registration/admission; this module owns normalization only.
 * It never manufactures an authority callback, execution receipt or seal.
 */
export async function analyzeDomainProducerSemanticOutcomeCandidate(candidate, options)
{
    const limitDescriptor = options && Object.getOwnPropertyDescriptor(options, 'hostExpectedLimits');
    require(limitDescriptor && Object.hasOwn(limitDescriptor, 'value'), 'external host limits required');
    assertOutcomeAnalysisData({ candidate, options }, limitDescriptor.value);
    const keys = ['expectedIdentity', 'expectedProducerId', 'expectedAuthorityId', 'expectedSourceCommit',
        'expectedSourceDigest', 'expectedCandidateDigest', 'hostExpectedLimits', 'maxBytes'];
    require(Object.keys(options).length === keys.length && keys.every((key) => Object.hasOwn(options, key)),
        'exact external identity/source/digest and host budgets required');
    require(candidate.producerId === options.expectedProducerId
        && candidate.producerAuthorityId === options.expectedAuthorityId, 'external producer/authority mismatch');
    const { validateOutcomeAdapterCandidateData, readOutcomeAdapterCatalog } = await import('./outcome-adapter-profile-contract.mjs');
    const admission = validateOutcomeAdapterCandidateData(JSON.stringify(candidate), JSON.stringify({
        identity: options.expectedIdentity, sourceCommit: options.expectedSourceCommit,
        sourceDigest: options.expectedSourceDigest, candidateDigest: options.expectedCandidateDigest
    }), options.maxBytes);
    const catalog = readOutcomeAdapterCatalog();
    const entry = catalog.entries.find((item) => item.producerIds.includes(candidate.producerId));
    const shapes = memberShapes();
    const membership = normalizeShape(candidate.outcome.membership, shapes.$defs[entry.family]);
    if (entry.family === 'frontend')
    {
        membership.suiteTestIds = normalizeOutcomeIdsMap(membership.suiteTestIds);
    }
    const reasons = normalizeScopedOutcomeReasons(candidate.outcome.reasons, candidate.producerId);
    if (entry.family === 'reliability')
    {
        for (const member of membership.memberOutcomes)
        {
            member.failureReasons = normalizeScopedOutcomeReasons(member.failureReasons, candidate.producerId);
        }
    }
    const canonicalCandidate = { ...structuredClone(candidate), inputAuthorityRefs: structuredClone(candidate.inputAuthorityRefs).sort(ordered),
        outcome: { ...candidate.outcome, membership, reasons } };
    const semanticCandidate = { ...canonicalCandidate };
    delete semanticCandidate.contentDigest;
    semanticCandidate.outcome = { ...canonicalCandidate.outcome };
    delete semanticCandidate.outcome.semanticPayloadDigest;
    const version = { schema: 'fsusblog.domain-outcome-analysis.v1', catalogDigest: admission.catalogDigest,
        membershipSchemaDigest: admission.membershipSchemaDigest, sourceCommit: admission.sourceCommit,
        sourceDigest: admission.sourceDigest };
    return freeze({ ...admission, schema: version.schema, version, canonicalCandidate,
        semanticPayload: semanticCandidate, semanticPayloadDigest: digestCanonical(semanticCandidate),
        outcomeFingerprint: digestCanonical({ version, semanticPayload: semanticCandidate }) });
}
