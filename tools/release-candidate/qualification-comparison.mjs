const { digestCanonical } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));

const semanticFields = ['aggregateOutcomeFingerprint', 'stateSemanticDigests', 'artifactSemanticDigests', 'failureTopology'];
const materialFields = ['ordinal', 'runId', ...semanticFields];
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function validateMaterial(material, index)
{
    if (!material || JSON.stringify(Object.keys(material).sort()) !== JSON.stringify([...materialFields].sort())
        || material.ordinal !== index + 1 || typeof material.runId !== 'string' || !material.runId
        || !digestPattern.test(material.aggregateOutcomeFingerprint)
        || !Array.isArray(material.failureTopology))
    {
        throw new Error('comparison requires exact normalized ordinal material in order 1/2/3');
    }
    for (const field of ['stateSemanticDigests', 'artifactSemanticDigests'])
    {
        const value = material[field];
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.entries(value).some(([id, digest]) => !id || !digestPattern.test(digest)))
        {
            throw new Error(`invalid normalized ${field}`);
        }
    }
}

/** Compare already-normalized DATA_ONLY material without granting qualification.
 * Candidate/ledger/receipt verification and clean attempt admission belong to the
 * independent qualification verifier, which must consume the upstream authorities.
 */
export function compareQualificationSemantics(materials)
{
    if (!Array.isArray(materials) || materials.length !== 3)
    {
        throw new Error('comparison requires exactly three ordinals, without selection or replacement');
    }
    materials.forEach(validateMaterial);
    if (new Set(materials.map((material) => material.runId)).size !== 3)
    {
        throw new Error('comparison requires three distinct run IDs');
    }
    const comparisons = Object.fromEntries(semanticFields.map((field) =>
    {
        const expected = digestCanonical(materials[0][field]);
        const differences = materials.slice(1).filter((material) => digestCanonical(material[field]) !== expected)
            .map((material) => ({ field, ordinals: [1, material.ordinal], producerIds: [], testIds: [] }));
        return [field, { equal: differences.length === 0, differences }];
    }));
    return {
        schema: 'fsusblog.release-candidate-semantic-comparison.v1',
        comparisonOnly: true,
        equal: Object.values(comparisons).every((comparison) => comparison.equal),
        comparisons
    };
}

/** Project the actual strong aggregate DATA_ONLY API without granting authority.
 * The caller must use the upstream analyzer with complete external expectations.
 * No raw receipt normalization, producer verification or fingerprinting occurs here.
 */
export function comparisonMaterialFromAggregateAnalysis(analysis, ordinal)
{
    const outcome = analysis?.canonicalOutcome;
    if (![1, 2, 3].includes(ordinal) || analysis?.schema !== 'fsusblog.strong-outcome-analysis.v1'
        || analysis.dataOnly !== true || analysis.producerVerificationPending !== true
        || outcome?.schema !== 'fsusblog.aggregate-run-outcome.v1'
        || analysis.inputContentDigest !== outcome.contentDigest
        || analysis.outcomeFingerprint !== outcome.aggregateOutcomeFingerprint)
    {
        throw new Error('comparison extraction requires upstream aggregate DATA_ONLY analysis');
    }
    const digestMap = (entries) =>
    {
        if (!Array.isArray(entries))
        {
            throw new Error('aggregate semantic entries must be explicit arrays');
        }
        const result = {};
        for (const entry of entries)
        {
            if (!entry || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['digest', 'owner', 'semanticId'])
                || typeof entry.semanticId !== 'string' || !entry.semanticId
                || typeof entry.owner !== 'string' || !entry.owner || !digestPattern.test(entry.digest)
                || Object.hasOwn(result, entry.semanticId))
            {
                throw new Error('aggregate semantic entries must have exact unique ID/owner/digest');
            }
            Object.defineProperty(result, entry.semanticId, { value: entry.digest, enumerable: true });
        }
        return result;
    };
    const material = {
        ordinal,
        runId: outcome.runId,
        aggregateOutcomeFingerprint: outcome.aggregateOutcomeFingerprint,
        stateSemanticDigests: digestMap(outcome.stateSemanticDigests),
        artifactSemanticDigests: digestMap(outcome.artifactSemanticDigests),
        failureTopology: structuredClone(outcome.failureTopology)
    };
    validateMaterial(material, ordinal - 1);
    return material;
}
