import { types } from 'node:util';

const { canonicalJson, digestCanonical, sealContentDigest } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
import { aggregateRunOutcomeSchema, compareFailureTopology, validateAggregateRunOutcomeData } from './semantic-outcome-contract.mjs';
import { analyzeStrongSemanticOutcome, assertOutcomeAnalysisData } from './strong-outcome-analysis.mjs';

const setNames = ['plannedTestIds', 'executedTestIds', 'passedTestIds', 'failedTestIds', 'skippedTestIds', 'blockedTestIds'];

function require(condition, message)
{
    if (!condition)
    {
        throw new Error(`aggregate outcome analysis: ${message}`);
    }
}

function compare(left, right)
{
    return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys, label)
{
    require(value && !Array.isArray(value)
        && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()), `${label} fields are not exact`);
}

function semanticUnion(members, field)
{
    const entries = new Map();
    for (const entry of members.flatMap((member) => member.outcome[field]))
    {
        require(!entries.has(entry.semanticId) || canonicalJson(entries.get(entry.semanticId)) === canonicalJson(entry),
            `conflicting semantic owner/digest ${field}/${entry.semanticId}`);
        entries.set(entry.semanticId, entry);
    }
    return [...entries.values()].sort((left, right) => compare(left.semanticId, right.semanticId));
}

/**
 * Construct a detached DATA_ONLY aggregate from exact canonical member data.
 * Required membership, semantic owners and run identity are external expectations.
 * Correct content/fingerprints remain data, never independently verified capabilities;
 * no locator, checkpoint, publication, CAS or qualification is invoked here.
 */
export function prepareAggregateOutcomeAnalysis(options, suppliedMembers)
{
    require(options && typeof options === 'object' && !types.isProxy(options)
        && Object.getPrototypeOf(options) === Object.prototype
        && Object.hasOwn(Object.getOwnPropertyDescriptors(options), 'hostExpectedLimits')
        && Object.hasOwn(Object.getOwnPropertyDescriptor(options, 'hostExpectedLimits'), 'value'),
    'external host limits required');
    assertOutcomeAnalysisData({ options, suppliedMembers }, options.hostExpectedLimits);
    exactKeys(options, ['producerSchema', 'aggregateSchema', 'fieldDispositions', 'failureTaxonomy',
        'producerCatalog', 'expectedContractDigests', 'hostExpectedLimits', 'expected'], 'contract options');
    exactKeys(options.expected, ['runId', 'sourceCommit', 'worktreeFingerprint', 'requiredProducerIds',
        'requiredCoverageIds', 'stateSemanticDigests', 'artifactSemanticDigests'], 'aggregate expectations');
    require(Array.isArray(suppliedMembers), 'members must be an array');
    const members = [...suppliedMembers].sort((left, right) => compare(left.outcome?.producerId, right.outcome?.producerId));
    const actual = members.map((member) => member.outcome?.producerId);
    require(actual.length > 0 && new Set(actual).size === actual.length
        && canonicalJson(actual) === canonicalJson(options.expected.requiredProducerIds),
    'required producer membership must be exact-one');
    const testOwners = new Map();
    for (const member of members)
    {
        exactKeys(member, ['outcome', 'options'], 'member');
        require(canonicalJson(member.options.expectedContractDigests) === canonicalJson(options.expectedContractDigests),
            'member contract sources mismatch');
        const analysis = analyzeStrongSemanticOutcome(member.outcome, member.options);
        require(analysis.canonicalOutcome.contentDigest === member.outcome.contentDigest,
            'member wire data must already be canonical; source payload cannot be rewritten');
        require(analysis.semanticPayloadDigest === member.outcome.semanticPayloadDigest
            && analysis.outcomeFingerprint === member.outcome.outcomeFingerprint, 'member fingerprint mismatch');
        for (const id of member.outcome.plannedTestIds)
        {
            require(!testOwners.has(id), `test ID has multiple producer owners: ${id}`);
            testOwners.set(id, member.outcome.producerId);
        }
    }
    const union = (field) => [...new Set(members.flatMap((member) => member.outcome[field]))].sort();
    const failureTopology = members.flatMap((member) => member.outcome.failures).sort(compareFailureTopology);
    const observedCoverageIds = union('coverageIds');
    const complete = members.every((member) => member.outcome.producerStatus === 'success'
        && member.outcome.cleanFirstAttempt && member.outcome.qualificationEligible)
        && options.expected.requiredCoverageIds.every((id) => observedCoverageIds.includes(id));
    const placeholder = digestCanonical(null);
    const contractOptions = { ...options, expected: { ...options.expected, aggregateOutcomeFingerprint: placeholder } };
    const outcome = sealContentDigest({
        schema: aggregateRunOutcomeSchema,
        schemaVersion: '1',
        fingerprintAlgorithmVersion: options.fieldDispositions.fingerprintAlgorithmVersion,
        fieldDispositionDigest: options.expectedContractDigests.fieldDispositions,
        failureTaxonomyDigest: options.expectedContractDigests.failureTaxonomy,
        producerCatalogDigest: options.expectedContractDigests.producerCatalog,
        ...options.expected,
        producerOutcomeRefs: members.map((member) => Object.fromEntries([
            'producerId', 'producerAuthorityId', 'schema', 'contentDigest', 'semanticPayloadDigest', 'outcomeFingerprint'
        ].map((field) => [field, member.outcome[field]]))),
        ...Object.fromEntries(setNames.map((field) => [field, union(field)])),
        observedCoverageIds,
        stateSemanticDigests: semanticUnion(members, 'stateSemanticDigests'),
        artifactSemanticDigests: semanticUnion(members, 'artifactSemanticDigests'),
        failureTopology,
        producerStatusVector: members.map((member) => ({ producerId: member.outcome.producerId, status: member.outcome.producerStatus })),
        completenessStatus: complete ? 'complete' : 'incomplete',
        aggregateOutcomeFingerprint: placeholder
    });
    const preliminary = analyzeStrongSemanticOutcome(outcome, contractOptions, {}, members);
    const finalOutcome = sealContentDigest({ ...outcome, aggregateOutcomeFingerprint: preliminary.outcomeFingerprint });
    const finalOptions = { ...contractOptions, expected: { ...contractOptions.expected,
        aggregateOutcomeFingerprint: preliminary.outcomeFingerprint } };
    validateAggregateRunOutcomeData(finalOutcome, finalOptions, members);
    // Admission is repeated on the constructed result before detaching caller data.
    assertOutcomeAnalysisData(finalOutcome, options.hostExpectedLimits);
    const result = analyzeStrongSemanticOutcome(finalOutcome, finalOptions, {}, members);
    return result;
}
