import { deriveRepeatabilityCatalog, qualificationIdentityBinding, verifyCandidateOnceOperation } from './qualification-policy.mjs';

const { sealContentDigest, digestCanonical } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));
const { loadCanonicalRequiredEvidenceCatalog, checkRequiredEvidenceCatalog } = await import(new URL('../test-matrix/required-evidence-catalog.mjs', import.meta.url));

function exactKeys(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()))
    {
        throw new Error(`${label} fields must exactly match the material contract`);
    }
}

function reference(value)
{
    verifyCandidateOnceOperation({ operation: 'reference-static-content', reference: value });
    return structuredClone(value);
}

/** Pure planning material, awaiting upstream cohort/identity and DAG admission.
 * No resource is allocated and this document is not an executable sealed plan.
 */
export function prepareQualificationPlanMaterial(inputs, ledger = loadCanonicalRequiredEvidenceCatalog())
{
    exactKeys(inputs, ['cohortId', 'cohortReference', 'candidateIdentityReference', 'identityBinding',
        'immutableInputs', 'resourceRoot', 'portBase'], 'planning inputs');
    if (!/^[a-z][a-z0-9-]{0,79}$/u.test(inputs.cohortId)
        || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/u.test(inputs.resourceRoot)
        || inputs.resourceRoot.split('/').some((part) => !part || part === '.' || part === '..')
        || !Number.isInteger(inputs.portBase) || inputs.portBase < 1024 || inputs.portBase > 65524)
    {
        throw new Error('resource namespace/root/port allocation must be explicit, disjoint and bounded');
    }
    if (digestCanonical(inputs.identityBinding) !== digestCanonical(qualificationIdentityBinding(ledger)))
    {
        throw new Error('candidate policy/catalog/schema binding drift');
    }
    const immutableKeys = ['build', 'replay', 'temporal', 'envelope', 'fixture'];
    exactKeys(inputs.immutableInputs, immutableKeys, 'immutable inputs');
    const immutableInputs = Object.fromEntries(immutableKeys.map((key) => [key, reference(inputs.immutableInputs[key])]));
    const repeatability = deriveRepeatabilityCatalog(ledger);
    const entries = checkRequiredEvidenceCatalog(ledger);
    const requiredIds = new Set(repeatability.entries.filter((entry) => entry.required).map((entry) => entry.authorityId));
    const authorityRequirements = entries.filter((entry) => requiredIds.has(entry.authorityId)).map((entry) => ({
        authorityId: entry.authorityId,
        authorityEntryDigest: entry.contentDigest,
        producerDigest: entry.producerDigest,
        producerTierIds: [...entry.producerTierIds],
        command: entry.localProducerCommand,
        verifier: entry.producerVerifier,
        receiptSchema: entry.receiptSchema,
        locatorBindingKey: entry.locatorBindingKey,
        outputBindingKey: entry.outputBindingKey,
        requiredTestIds: [...entry.requiredTestIds],
        requiredCoverageIds: [...entry.requiredCoverageIds],
        requiredArtifactIds: [...entry.requiredArtifactIds],
        repeatability: 'per-run'
    }));
    const ordinals = [1, 2, 3].map((ordinal) =>
    {
        const runId = `${inputs.cohortId}-ordinal-${ordinal}`;
        const root = `${inputs.resourceRoot}/${runId}`;
        const ports = Object.fromEntries(['http', 'database', 'redis', 'service'].map((kind, index) => [kind, inputs.portBase + (ordinal - 1) * 4 + index]));
        return {
            ordinal,
            runId,
            namespace: runId,
            requiresPreviousPostflight: ordinal === 1 ? null : ordinal - 1,
            immutableInputs: structuredClone(immutableInputs),
            roots: { home: `${root}/home`, temporary: `${root}/tmp`, cache: `${root}/cache`, runtime: `${root}/runtime` },
            ports,
            freshPreflightRequired: true,
            freshPostflightRequired: true,
            independentDatabaseRequired: true,
            independentRedisRequired: true,
            independentServiceLifecycleRequired: true,
            authorityRequirements: structuredClone(authorityRequirements)
        };
    });
    return sealContentDigest({
        schema: 'fsusblog.release-candidate-qualification-plan-material.v1',
        admissionStatus: 'requires-verified-cohort-and-sealed-producer-dag',
        cohortId: inputs.cohortId,
        cohortReference: reference(inputs.cohortReference),
        candidateIdentityReference: reference(inputs.candidateIdentityReference),
        identityBinding: structuredClone(inputs.identityBinding),
        sequential: true,
        candidateOnce: [{ operation: 'reference-immutable-build', reference: immutableInputs.build }],
        ordinals
    });
}

export function verifyQualificationPlanMaterial(material, inputs, ledger = loadCanonicalRequiredEvidenceCatalog())
{
    if (digestCanonical(material) !== digestCanonical(prepareQualificationPlanMaterial(inputs, ledger)))
    {
        throw new Error('qualification plan material drift, collision or authority omission');
    }
    return material;
}
