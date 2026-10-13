import fs from 'node:fs';
import path from 'node:path';

const { canonicalize, entryContentDigest } = await import(new URL('../test-matrix/required-evidence-catalog.mjs', import.meta.url));
const {
    locateCurrentRunEvidence,
    verifyCurrentRunEvidenceBinding
} = await import(new URL('../test/current-run-evidence-locator.mjs', import.meta.url));
const {
    EVIDENCE_REFERENCE_SCHEMA,
    resolveEvidenceReferencePayload
} = await import(new URL('../test/current-run-evidence-publication.mjs', import.meta.url));
const { governanceContentDigest } = await import(new URL('../test/evidence-location-contract.mjs', import.meta.url));
import { loadDomainVerifier, verifyDomainVerifierRegistry } from './required-evidence-verifier-registry.mjs';

export const requiredEvidenceBindingSchema = 'fsusblog.required-evidence-binding.v1';

export class RequiredEvidenceBindingError extends Error
{
    constructor(code, message, localProducerCommand = null)
    {
        super(message);
        this.name = 'RequiredEvidenceBindingError';
        this.reasonCode = code;
        this.localProducerCommand = localProducerCommand;
    }
}

function requireCheck(condition, code, message, command = null)
{
    if (!condition)
    {
        throw new RequiredEvidenceBindingError(code, message, command);
    }
}

function same(left, right)
{
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function immutable(value)
{
    if (value && typeof value === 'object')
    {
        Object.values(value).forEach(immutable);
        Object.freeze(value);
    }
    return value;
}

function exactIds(actual, expected, field)
{
    requireCheck(Array.isArray(actual) && actual.every((id) => typeof id === 'string' && id.length > 0)
        && new Set(actual).size === actual.length && same([...actual].sort(), [...expected].sort()),
    'REQUIRED_IDS_MISMATCH', `${field}: missing, duplicate or unknown correctness IDs`);
    return { expected: [...expected], actual: [...actual], verified: true };
}

// Owner describe() only reads the receipt's schema layout. It receives no run
// context or expected values with which to manufacture missing business fields.
async function evaluateRequiredEvidenceBinding(options)
{
    const allowed = new Set(['authorityId', 'catalog', 'context', 'domainInputs',
        'expectedIdentity', 'explicitInputs', 'reference', 'locatorRegistry',
        'repositoryRoot', 'verifierRegistry']);
    for (const key of Object.keys(options))
    {
        requireCheck(allowed.has(key), 'UNSUPPORTED_BINDING_INPUT', `binding API does not accept ${key}`);
    }
    const { authorityId, catalog, context, domainInputs, expectedIdentity,
        explicitInputs, reference, locatorRegistry, repositoryRoot, verifierRegistry } = options;
    try
    {
        verifyDomainVerifierRegistry(verifierRegistry, { catalog, repositoryRoot });
    }
    catch (error)
    {
        throw new RequiredEvidenceBindingError('REGISTRY_REJECTED', error.message);
    }
    const entries = catalog.entries.filter((entry) => entry.authorityId === authorityId);
    requireCheck(entries.length === 1, 'UNKNOWN_AUTHORITY', 'catalog authority must be exact-one');
    const entry = entries[0];
    const locators = locatorRegistry.entries.filter((locator) => locator.authorityId === entry.locatorBindingKey);
    requireCheck(locators.length === 1 && locators[0].producerId === entry.canonicalOwner,
        'LOCATOR_OWNER_MISMATCH', `${authorityId}: canonical locator/producer binding must be exact-one`);
    const registryEntry = locators[0];
    const cardinality = (Array.isArray(explicitInputs) ? explicitInputs.length : 0) + (reference ? 1 : 0);
    requireCheck(cardinality === 1, cardinality === 0 ? 'MISSING_EVIDENCE' : 'AMBIGUOUS_EVIDENCE',
        `${authorityId}: evidence input must be exact-one`, cardinality === 0 ? entry.localProducerCommand : null);
    let located;
    try
    {
        located = locateCurrentRunEvidence({ context, registry: locatorRegistry, registryEntry,
            repositoryRoot, ...(explicitInputs === undefined ? {} : { explicitInputs }),
            ...(reference === undefined ? {} : { reference }) });
        verifyCurrentRunEvidenceBinding(located.bindingReceipt,
            { context, registry: locatorRegistry, registryEntry, repositoryRoot });
    }
    catch (error)
    {
        throw new RequiredEvidenceBindingError('LOCATOR_REJECTED', error.message,
            entry.localProducerCommand);
    }
    requireCheck(located.receipt.schema === EVIDENCE_REFERENCE_SCHEMA,
        'UNSUPPORTED_REFERENCE', 'required evidence must be a canonical current-run payload reference');
    const resolved = resolveEvidenceReferencePayload(located.receipt,
        { repositoryRoot, ownedRoots: context.ownedRoots });
    const receipt = immutable(structuredClone(resolved.payload));
    requireCheck(receipt.schema === entry.receiptSchema, 'RECEIPT_SCHEMA_MISMATCH', 'producer payload schema mismatch');
    const { descriptor, verifier } = await loadDomainVerifier({ registry: verifierRegistry,
        catalog, authorityId, repositoryRoot });
    let description;
    try
    {
        description = await verifier.describe(receipt, immutable({ repositoryRoot, receiptPath: resolved.file }));
    }
    catch (error)
    {
        throw new RequiredEvidenceBindingError('OWNER_DESCRIPTION_REJECTED', error.message);
    }
    requireCheck(description && typeof description === 'object', 'OWNER_DESCRIPTION_MISSING', 'owner schema description is required');
    requireCheck(/^sha256:[a-f0-9]{64}$/u.test(description.contentDigest ?? ''),
        'CONTENT_DIGEST_MISSING', 'owner must expose the producer content digest');
    const identityChecks = {};
    const contextFields = { sourceCommit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint,
        runId: context.schedulerRunId, schedulerRunId: context.schedulerRunId, attemptId: context.attemptId };
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'runId'])
    {
        requireCheck(same(description.identity?.[field], contextFields[field]),
            'IDENTITY_MISMATCH', `${authorityId}: original producer ${field} is missing or outside this run`);
        identityChecks[field] = { actual: description.identity[field], expected: contextFields[field], verified: true };
    }
    for (const field of entry.requiredIdentityFields)
    {
        const actual = field === 'fileDigest' ? located.receipt.payload.digest
            : field === 'contentDigest' ? description.contentDigest : description.identity?.[field];
        requireCheck(Object.hasOwn(expectedIdentity ?? {}, field)
            && actual !== undefined && expectedIdentity[field] !== undefined
            && same(actual, expectedIdentity[field])
            && (!Object.hasOwn(contextFields, field) || same(actual, contextFields[field])),
        'IDENTITY_MISMATCH', `${authorityId}: ${field} is missing or mismatched`);
        identityChecks[field] = { actual, expected: expectedIdentity[field], verified: true };
    }
    // Image and policy belong to the independently supplied candidate identity.
    // The locator already compared the whole candidate object to its reference;
    // an opaque candidate id/digest alone is not an image/policy binding.
    for (const field of ['imageIdentity', 'policyIdentity'])
    {
        requireCheck(Object.hasOwn(expectedIdentity ?? {}, field)
            && located.receipt.candidateIdentity?.[field] !== undefined && expectedIdentity[field] !== undefined
            && same(located.receipt.candidateIdentity[field], expectedIdentity[field]),
        'IDENTITY_MISMATCH', `${authorityId}: ${field} is missing or mismatched`);
        identityChecks[field] = { actual: located.receipt.candidateIdentity[field], expected: expectedIdentity[field], verified: true };
    }
    const idChecks = Object.fromEntries([
        ['testIds', 'requiredTestIds'], ['coverageIds', 'requiredCoverageIds'], ['artifactIds', 'requiredArtifactIds']
    ].map(([actual, required]) => [required, exactIds(description[actual], entry[required], actual)]));
    requireCheck(verifier.successStatuses.includes(description.status), 'PRODUCER_NOT_SUCCESS', 'producer is not successful');
    const diagnostic = description.evidenceClass === 'diagnostic';
    requireCheck((!diagnostic && (verifier.correctnessClasses ?? ['correctness']).includes(description.evidenceClass))
        || (diagnostic && entry.allowDiagnostic),
    'DIAGNOSTIC_SUBSTITUTE', 'diagnostic or unclassified evidence cannot satisfy correctness');
    let result;
    try
    {
        result = await verifier.verify(immutable({ receipt, entry: structuredClone(entry),
            context: structuredClone(context), domainInputs: structuredClone(domainInputs), repositoryRoot,
            receiptPath: resolved.file }));
    }
    catch (error)
    {
        throw new RequiredEvidenceBindingError('DOMAIN_VERIFIER_FAILED', error.message);
    }
    requireCheck(result && typeof result === 'object' && !Array.isArray(result)
        && result.status === 'success' && Array.isArray(result.reasonCodes) && result.reasonCodes.length === 0,
    'DOMAIN_VERIFIER_FAILED', 'domain verifier did not return structured success');
    // A verifier cannot change producer bytes to obtain admission.
    requireCheck(same(JSON.parse(fs.readFileSync(resolved.file, 'utf8')), receipt),
        'PRODUCER_MUTATED', 'domain verifier changed producer evidence');
    verifyDomainVerifierRegistry(verifierRegistry, { catalog, repositoryRoot });
    verifyCurrentRunEvidenceBinding(located.bindingReceipt,
        { context, registry: locatorRegistry, registryEntry, repositoryRoot });
    const body = {
        schema: requiredEvidenceBindingSchema,
        status: diagnostic ? 'diagnostic' : 'success',
        qualificationEligible: !diagnostic,
        authorityId,
        producerId: entry.canonicalOwner,
        catalog: { schema: catalog.catalogSchema, ledgerSchema: catalog.schema,
            version: catalog.version, contentDigest: catalog.contentDigest, entryDigest: entryContentDigest(entry) },
        context: { schedulerRunId: context.schedulerRunId, attemptId: context.attemptId,
            sourceCommit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint,
            candidateIdentity: context.candidateIdentity, buildIdentity: context.buildIdentity,
            contentDigest: context.contentDigest },
        receipt: { schema: receipt.schema, ref: path.relative(repositoryRoot, resolved.file).replaceAll(path.sep, '/'),
            fileDigest: located.receipt.payload.digest, contentDigest: description.contentDigest,
            producerReceiptDigest: located.receipt.producerReceiptDigest },
        locatorBinding: located.bindingReceipt,
        identityChecks,
        idChecks,
        domainVerifier: { ...descriptor, registryDigest: verifierRegistry.contentDigest,
            result: structuredClone(result), resultDigest: governanceContentDigest(result) },
        reasonCodes: [],
        failurePath: 'fail-closed-without-fallback'
    };
    requireCheck(/^sha256:[a-f0-9]{64}$/u.test(body.receipt.contentDigest ?? ''),
        'CONTENT_DIGEST_MISSING', 'owner must expose the verified producer content digest');
    return immutable({ ...body, contentDigest: governanceContentDigest(body) });
}

export async function createRequiredEvidenceBinding(options)
{
    try
    {
        return await evaluateRequiredEvidenceBinding(options);
    }
    catch (error)
    {
        if (error instanceof RequiredEvidenceBindingError)
        {
            throw error;
        }
        throw new RequiredEvidenceBindingError('VERIFIER_REJECTED', error.message);
    }
}

export async function verifyRequiredEvidenceBinding(binding, options)
{
    requireCheck(binding?.schema === requiredEvidenceBindingSchema
        && binding.contentDigest === governanceContentDigest(binding), 'BINDING_TAMPER', 'binding schema or digest mismatch');
    const expected = await createRequiredEvidenceBinding(options);
    requireCheck(same(binding, expected), 'BINDING_REPLAY_MISMATCH',
        'binding differs from independent current-source/owner/locator verification');
    return binding;
}
