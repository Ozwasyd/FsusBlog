import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { aggregateRunOutcomeSchema, getSemanticOutcomeSchemaPaths,
    producerSemanticOutcomeSchema } from './semantic-outcome-contract.mjs';

const { digestCanonical, sealContentDigest } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const candidateFields = Object.freeze([
    'attemptEligibility', 'contentDigest', 'identity', 'inputAuthorityRefs', 'outcome',
    'producerAuthorityId', 'producerId', 'schema', 'schemaVersion', 'verificationStatus'
]);
const identityFields = Object.freeze([
    'buildIdentity', 'executionEnvelopeDigest', 'producerId', 'replayPlanDigest',
    'schedulerRunId', 'sourceCommit', 'temporalContextDigest', 'toolchainDigest',
    'worktreeFingerprint'
]);

export const producerSemanticOutcomeCandidateSchema =
    'fsusblog.producer-semantic-outcome-candidate.v1';
export const outcomeNormalizationRules = Object.freeze([
    'exact', 'canonical-object', 'sort-by-kind', 'content-seal', 'text', 'digest',
    'derived-digest', 'ids', 'positive-integer', 'boolean', 'nonnegative-number',
    'digest-map', 'build-artifact-map', 'reasons', 'redacted-secret', 'repository-relative-path',
    'schema-object', 'nullable-schema-object', 'records-by-id', 'records-by-semantic-id',
    'records-by-policy-id', 'records-by-projection-id', 'records-by-producer-id', 'canonical-record-set'
]);

function exactKeys(value, fields, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort()))
    {
        throw new Error(`${label} fields do not exactly match the contract`);
    }
}

function digest(value, label)
{
    if (!digestPattern.test(String(value ?? '')))
    {
        throw new Error(`${label} must be SHA-256`);
    }
}

export function readOutcomeFailureTaxonomy(file = path.join(root, 'config/testing/outcome-failure-taxonomy.json'))
{
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (registry?.schema !== 'fsusblog.outcome-failure-taxonomy.v1'
        || !Array.isArray(registry.kinds) || registry.kinds.length === 0)
    {
        throw new Error('outcome failure taxonomy is invalid');
    }
    const kinds = registry.kinds.map((entry) => entry.kind);
    if (JSON.stringify(kinds) !== JSON.stringify([...new Set(kinds)].sort())
        || registry.kinds.some((entry) => !entry.owner || !entry.proofTestId
            || !Array.isArray(entry.requiredIdentity) || entry.requiredIdentity.length === 0))
    {
        throw new Error('outcome failure taxonomy must be sorted, unique, and owned');
    }
    return new Map(registry.kinds.map((entry) => [entry.kind, entry]));
}

export function validateOutcomeFieldDispositions(file = path.join(root, 'config/testing/outcome-field-dispositions.json'), hostExpectedLimits = null)
{
    const registry = typeof file === 'string'
        ? JSON.parse(fs.readFileSync(file, 'utf8'))
        : file;
    const categories = new Set(['semantic-outcome', 'execution-identity', 'evidence-location', 'diagnostic-metadata', 'volatile-metadata', 'secret-redacted']);
    exactKeys(registry, ['schema', 'schemaVersion', 'fingerprintAlgorithmVersion',
        'entries', 'canonicalization'], 'outcome field disposition registry');
    if (registry?.schema !== 'fsusblog.outcome-field-dispositions.v2'
        || registry.schemaVersion !== '2'
        || registry.fingerprintAlgorithmVersion !== 'registry-canonical-json-sha256-v2'
        || !Array.isArray(registry.entries))
    {
        throw new Error('outcome field disposition registry is invalid');
    }
    const paths = registry.entries.map((entry) => entry.schemaPath);
    if (JSON.stringify(paths) !== JSON.stringify([...new Set(paths)])
        || registry.entries.some((entry) => !categories.has(entry.category)
            || !entry.normalizationRule || !entry.owner || !entry.proofTestId || !entry.reasonCode))
    {
        throw new Error('outcome fields must have exactly one complete disposition');
    }
    const expected = candidateFields.map((field) => `$.${field}`).sort();
    if (JSON.stringify([...paths].sort()) !== JSON.stringify(expected))
    {
        throw new Error('outcome field dispositions do not exactly cover the candidate schema');
    }
    const policy = registry.canonicalization;
    exactKeys(policy, ['schema', 'nestedFields', 'profiles', 'schemas'], 'outcome canonicalization policy');
    if (policy.schema !== 'fsusblog.outcome-canonicalization-policy.v2'
        || !Array.isArray(policy.nestedFields) || !Array.isArray(policy.profiles)
        || policy.profiles.length === 0)
    {
        throw new Error('outcome canonicalization policy is invalid');
    }
    const producerIds = new Set();
    for (const profile of policy.profiles)
    {
        exactKeys(profile, ['producerId', 'authorityId', 'fields', 'setRelations',
            'successEqualSets', 'disjointSets', 'digestBindings'], 'outcome canonicalization profile');
        if (!profile.producerId || !profile.authorityId || producerIds.has(profile.producerId)
            || !['fields', 'setRelations', 'successEqualSets', 'disjointSets', 'digestBindings']
                .every((field) => Array.isArray(profile[field])))
        {
            throw new Error('outcome canonicalization profile is duplicate or incomplete');
        }
        producerIds.add(profile.producerId);
        const complete = [...registry.entries, ...policy.nestedFields, ...profile.fields];
        const registered = new Set();
        for (const entry of complete)
        {
            exactKeys(entry, ['schemaPath', 'category', 'normalizationRule', 'owner',
                'proofTestId', 'reasonCode', ...(Object.hasOwn(entry, 'required') ? ['required'] : [])],
            'recursive field disposition');
            if (!entry.schemaPath || registered.has(entry.schemaPath)
                || !categories.has(entry.category) || !outcomeNormalizationRules.includes(entry.normalizationRule)
                || !entry.owner || !entry.proofTestId || !entry.reasonCode
                || (entry.required !== undefined && typeof entry.required !== 'boolean'))
            {
                throw new Error('recursive outcome field disposition is duplicate, unowned or unknown');
            }
            registered.add(entry.schemaPath);
        }
    }
    validateSchemaDeclarations(policy.schemas, hostExpectedLimits);
    return registry;
}

function validateSchemaDeclarations(declarations, hostExpectedLimits)
{
    const schemaFiles = new Map([
        [aggregateRunOutcomeSchema, 'aggregate-run-outcome.schema.json'],
        [producerSemanticOutcomeSchema, 'producer-semantic-outcome.schema.json']
    ]);
    if (!Array.isArray(declarations)
        || JSON.stringify(declarations.map((item) => item.schema).sort()) !== JSON.stringify([...schemaFiles.keys()]))
    {
        throw new Error('strong schema dispositions must exactly register the known schemas');
    }
    const categories = new Set(['semantic-outcome', 'execution-identity', 'evidence-location',
        'diagnostic-metadata', 'volatile-metadata', 'secret-redacted']);
    for (const declaration of declarations)
    {
        exactKeys(declaration, ['schema', 'fields'], 'strong schema disposition declaration');
        if (!Array.isArray(declaration.fields) || declaration.fields.length === 0)
        {
            throw new Error('strong schema dispositions must have owned fields');
        }
        const paths = new Set();
        for (const entry of declaration.fields)
        {
            exactKeys(entry, ['schemaPath', 'category', 'normalizationRule', 'owner',
                'proofTestId', 'reasonCode'], 'strong schema field disposition');
            if (typeof entry.schemaPath !== 'string' || !entry.schemaPath.startsWith('$.')
                || paths.has(entry.schemaPath) || !categories.has(entry.category)
                || !outcomeNormalizationRules.includes(entry.normalizationRule)
                || ['owner', 'proofTestId', 'reasonCode'].some((field) =>
                    typeof entry[field] !== 'string' || !entry[field].trim()))
            {
                throw new Error('strong schema disposition is duplicate, unowned or unknown');
            }
            paths.add(entry.schemaPath);
        }
    }
    // Legacy candidate-v1 validation checks declarations, not strong-schema coverage.
    // Full analysis must supply its actual external host budget; no defaults exist.
    if (hostExpectedLimits === null) return;
    if (hostExpectedLimits === null || typeof hostExpectedLimits !== 'object' || types.isProxy(hostExpectedLimits))
    {
        throw new Error('fixed schema coverage requires external host limits');
    }
    const byteLimit = Object.getOwnPropertyDescriptor(hostExpectedLimits, 'maxStringBytes')?.value;
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 1)
    {
        throw new Error('fixed schema coverage requires a finite byte budget');
    }
    const sourceSchema = (name) =>
    {
        const bytes = fs.readFileSync(path.join(root, 'config/schemas', name));
        if (bytes.length > byteLimit)
        {
            throw new Error('fixed schema source byte budget exceeded');
        }
        return JSON.parse(bytes.toString('utf8'));
    };
    const contracts = { producerSchema: sourceSchema(schemaFiles.get(producerSemanticOutcomeSchema)),
        aggregateSchema: sourceSchema(schemaFiles.get(aggregateRunOutcomeSchema)) };
    for (const declaration of declarations)
    {
        const expectedPaths = getSemanticOutcomeSchemaPaths(declaration.schema, contracts, hostExpectedLimits);
        if (JSON.stringify(declaration.fields.map((entry) => entry.schemaPath).sort()) !== JSON.stringify(expectedPaths))
        {
            throw new Error('strong schema disposition coverage is incomplete or unknown');
        }
    }
}

function validateIdentity(identity)
{
    exactKeys(identity, identityFields, 'candidate identity');
    for (const field of identityFields.filter((field) => field.endsWith('Digest') || field === 'worktreeFingerprint'))
    {
        digest(identity[field], `identity.${field}`);
    }
    if (!/^[0-9a-f]{40}$/u.test(identity.sourceCommit)
        || !identity.schedulerRunId || !identity.producerId)
    {
        throw new Error('candidate source/run/producer identity is invalid');
    }
}

function validateReasons(reasons, producerId, taxonomy)
{
    if (!Array.isArray(reasons))
    {
        throw new Error('outcome reasons must be an array');
    }
    for (const reason of reasons)
    {
        const rule = taxonomy.get(reason?.kind);
        if (!rule || reason.producerId !== producerId
            || rule.requiredIdentity.some((field) => reason.identity?.[field] === undefined))
        {
            throw new Error(`unknown or incomplete canonical failure: ${reason?.kind ?? 'missing'}`);
        }
    }
}

export function validateProducerSemanticOutcomeCandidate(candidate, {
    taxonomy = readOutcomeFailureTaxonomy(),
    expectedProducerId = null,
    expectedAuthorityId = null
} = {})
{
    exactKeys(candidate, candidateFields, 'producer semantic outcome candidate');
    validateOutcomeFieldDispositions();
    if (candidate.schema !== producerSemanticOutcomeCandidateSchema || candidate.schemaVersion !== '1'
        || candidate.verificationStatus !== 'verified'
        || (expectedProducerId && candidate.producerId !== expectedProducerId)
        || (expectedAuthorityId && candidate.producerAuthorityId !== expectedAuthorityId))
    {
        throw new Error('producer semantic candidate schema, producer, authority, or verification is invalid');
    }
    validateIdentity(candidate.identity);
    if (candidate.identity.producerId !== candidate.producerId)
    {
        throw new Error('candidate identity crosses producerId');
    }
    if (!Array.isArray(candidate.inputAuthorityRefs) || candidate.inputAuthorityRefs.length === 0
        || candidate.inputAuthorityRefs.some((reference) => !reference?.kind || !reference?.path
            || !digestPattern.test(String(reference.digest ?? ''))))
    {
        throw new Error('candidate input authority references are incomplete');
    }
    exactKeys(candidate.attemptEligibility, [
        'aggregateDigest', 'attemptDigest', 'attemptNumber', 'cleanFirstAttempt',
        'firstFailure', 'qualificationEligible'
    ], 'candidate attempt eligibility');
    digest(candidate.attemptEligibility.aggregateDigest, 'attemptEligibility.aggregateDigest');
    digest(candidate.attemptEligibility.attemptDigest, 'attemptEligibility.attemptDigest');
    if (!Number.isInteger(candidate.attemptEligibility.attemptNumber)
        || candidate.attemptEligibility.attemptNumber < 1
        || typeof candidate.attemptEligibility.cleanFirstAttempt !== 'boolean'
        || typeof candidate.attemptEligibility.firstFailure !== 'boolean'
        || typeof candidate.attemptEligibility.qualificationEligible !== 'boolean')
    {
        throw new Error('candidate attempt eligibility is invalid');
    }
    exactKeys(candidate.outcome, [
        'membership', 'reasons', 'requiredMembershipVerified', 'semanticPayloadDigest', 'status'
    ], 'candidate outcome');
    digest(candidate.outcome.semanticPayloadDigest, 'outcome.semanticPayloadDigest');
    validateReasons(candidate.outcome.reasons, candidate.producerId, taxonomy);
    const validShape = ['blocked', 'cancelled', 'failed', 'success'].includes(candidate.outcome.status)
        && (candidate.outcome.status === 'success'
            ? candidate.outcome.requiredMembershipVerified === true && candidate.outcome.reasons.length === 0
            : candidate.outcome.requiredMembershipVerified === false && candidate.outcome.reasons.length > 0);
    if (!validShape)
    {
        throw new Error('candidate semantic outcome shape is inconsistent');
    }
    if (candidate.outcome.status === 'success'
        && (candidate.attemptEligibility.attemptNumber !== 1
            || candidate.attemptEligibility.cleanFirstAttempt !== true
            || candidate.attemptEligibility.firstFailure !== false
            || candidate.attemptEligibility.qualificationEligible !== true))
    {
        throw new Error('successful candidate is not clean first attempt');
    }
    const unsigned = { ...candidate };
    delete unsigned.contentDigest;
    if (candidate.contentDigest !== digestCanonical(unsigned))
    {
        throw new Error('candidate content digest mismatch');
    }
    return candidate;
}

export function sealProducerSemanticOutcomeCandidate(value)
{
    const candidate = sealContentDigest({
        schema: producerSemanticOutcomeCandidateSchema,
        schemaVersion: '1',
        ...value,
        verificationStatus: 'verified'
    });
    return validateProducerSemanticOutcomeCandidate(candidate);
}

export function externalCandidateVerification(candidate, {
    expectedIdentity = candidate.identity,
    authorityIssue,
    verificationReceiptDigest
})
{
    validateProducerSemanticOutcomeCandidate(candidate);
    for (const [field, expected] of Object.entries(expectedIdentity))
    {
        if (candidate.identity[field] !== expected)
        {
            throw new Error(`candidate identity crosses ${field}`);
        }
    }
    return {
        verified: true,
        authorityIssue,
        producerId: candidate.producerId,
        producerAuthorityId: candidate.producerAuthorityId,
        candidateSchema: candidate.schema,
        candidateDigest: candidate.contentDigest,
        verificationReceiptDigest,
        identity: candidate.identity,
        outcome: candidate.outcome
    };
}
