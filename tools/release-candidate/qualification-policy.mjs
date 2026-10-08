import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { digestCanonical, sealContentDigest } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));
const {
    checkRequiredEvidenceCatalog,
    loadCanonicalRequiredEvidenceCatalog,
    requiredEvidenceAuthoritiesForContext
} = await import(new URL('../test-matrix/required-evidence-catalog.mjs', import.meta.url));

export const qualificationReceiptSchemaPath = fileURLToPath(new URL(
    '../../config/schemas/release-candidate-qualification-receipt.schema.json', import.meta.url
));

const finalStatuses = Object.freeze([
    'sealed-qualified',
    'sealed-unqualified-identity-mismatch',
    'sealed-unqualified-incomplete',
    'sealed-unqualified-run-failure',
    'sealed-unqualified-retry-recovered',
    'sealed-unqualified-evidence-mismatch',
    'sealed-unqualified-outcome-drift',
    'sealed-unqualified-order-dependent',
    'sealed-unqualified-environment-drift',
    'sealed-unqualified-cleanup-failure'
]);

function freeze(value)
{
    if (value && typeof value === 'object')
    {
        for (const child of Object.values(value))
        {
            freeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

export function qualificationPolicy()
{
    return freeze(sealContentDigest({
        schema: 'fsusblog.release-candidate-qualification-policy.v1',
        version: 1,
        requiredRunCount: 3,
        ordinals: [1, 2, 3],
        sequential: true,
        states: ['collecting', ...finalStatuses],
        transitions: { collecting: [...finalStatuses] },
        requirements: {
            sealedCohort: true,
            candidateIdentityExact: true,
            immutableInputsExact: true,
            independentResources: true,
            completeFreshPreflight: true,
            completeFreshPostflight: true,
            cleanFirstAttempt: true,
            qualificationEligible: true,
            requiredEvidenceExactOne: true,
            currentRunEvidence: true,
            requiredAuthoritiesSuccess: true,
            testAssertionCoverageExact: true,
            outcomeFingerprintExact: true,
            semanticStateExact: true,
            semanticArtifactExact: true,
            failureTopologyExact: true,
            noRecoveredRetry: true,
            noDiagnosticSubstitute: true,
            noSlotReplacement: true,
            noReplanOrReseed: true
        },
        candidateOnceOperations: ['reference-immutable-build', 'reference-static-content'],
        receiptSchemaDigest: digestCanonical(JSON.parse(fs.readFileSync(qualificationReceiptSchemaPath, 'utf8')))
    }));
}

export function verifyQualificationPolicy(policy)
{
    if (digestCanonical(policy) !== digestCanonical(qualificationPolicy()))
    {
        throw new Error('qualification policy differs from the canonical three-run contract');
    }
    return policy;
}

/** Only a closed, declarative reference operation is provably static here.
 * Arbitrary shell/Node commands have no purity proof and remain per-run.
 */
export function verifyCandidateOnceOperation(operation)
{
    const keys = ['operation', 'reference'];
    if (!operation || JSON.stringify(Object.keys(operation).sort()) !== JSON.stringify(keys)
        || !qualificationPolicy().candidateOnceOperations.includes(operation.operation)
        || !operation.reference
        || JSON.stringify(Object.keys(operation.reference).sort()) !== JSON.stringify(['digest', 'path'])
        || !/^sha256:[0-9a-f]{64}$/u.test(operation.reference.digest)
        || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/u.test(operation.reference.path)
        || operation.reference.path.split('/').some((part) => !part || part === '.' || part === '..'))
    {
        throw new Error('candidate-once requires a pure content-addressed reference, without executable commands');
    }
    return operation;
}

/** Derive every classification from the existing required-evidence authority.
 * Current catalog producers are executable correctness consumers; none is static.
 */
export function deriveRepeatabilityCatalog(ledger = loadCanonicalRequiredEvidenceCatalog())
{
    const entries = checkRequiredEvidenceCatalog(ledger);
    const required = new Set(requiredEvidenceAuthoritiesForContext(undefined, entries)
        .map((entry) => entry.authorityId));
    return freeze(sealContentDigest({
        schema: 'fsusblog.release-candidate-repeatability-catalog.v1',
        requiredEvidenceCatalogDigest: ledger.contentDigest,
        qualificationPolicyDigest: qualificationPolicy().contentDigest,
        entries: entries.map((entry) => ({
            authorityId: entry.authorityId,
            authorityEntryDigest: entry.contentDigest,
            producerDigest: entry.producerDigest,
            required: required.has(entry.authorityId),
            repeatability: 'per-run'
        }))
    }));
}

export function verifyRepeatabilityCatalog(catalog, ledger = loadCanonicalRequiredEvidenceCatalog())
{
    if (digestCanonical(catalog) !== digestCanonical(deriveRepeatabilityCatalog(ledger)))
    {
        throw new Error('repeatability catalog must exactly classify the current required-evidence catalog');
    }
    return catalog;
}

/** Identity owner consumes these digests; changing any requires a new cohort. */
export function qualificationIdentityBinding(ledger = loadCanonicalRequiredEvidenceCatalog())
{
    const policy = qualificationPolicy();
    return freeze({
        qualificationPolicyDigest: policy.contentDigest,
        qualificationReceiptSchemaDigest: policy.receiptSchemaDigest,
        repeatabilityCatalogDigest: deriveRepeatabilityCatalog(ledger).contentDigest,
        requiredEvidenceCatalogDigest: ledger.contentDigest
    });
}

/** Semantic configuration IDs admitted by the existing immutable identity schema.
 * The identity owner verifies/collects the complete descriptor; no new fields are added.
 */
export function qualificationCandidateConfigurationDigests(ledger = loadCanonicalRequiredEvidenceCatalog())
{
    const binding = qualificationIdentityBinding(ledger);
    return freeze({
        'qualification-policy': binding.qualificationPolicyDigest,
        'qualification-receipt-schema': binding.qualificationReceiptSchemaDigest,
        'qualification-repeatability-catalog': binding.repeatabilityCatalogDigest
    });
}

/** Check qualification's policy slice after the upstream complete identity verifier.
 * This function does not verify source facts, collectors or the whole identity.
 */
export function verifyQualificationCandidatePolicyBinding(identity, ledger = loadCanonicalRequiredEvidenceCatalog())
{
    const required = qualificationCandidateConfigurationDigests(ledger);
    for (const [id, digest] of Object.entries(required))
    {
        if (identity?.configurationDigests?.[id] !== digest)
        {
            throw new Error(`candidate configuration binding mismatch: ${id}`);
        }
    }
    if (identity.requiredEvidenceCatalogDigest !== ledger.contentDigest)
    {
        throw new Error('candidate required-evidence catalog binding mismatch');
    }
    return identity;
}
