import { readFileSync } from 'node:fs';

const { digestCanonical, sealContentDigest } = await import(new URL('../../../tools/test/attempt-provenance.mjs', import.meta.url));
const { analyzeStrongSemanticOutcome } = await import(new URL('../../../tools/test-matrix/outcomes/strong-outcome-analysis.mjs', import.meta.url));

export const digest = (text) => digestCanonical(text);
const source = (relative) => JSON.parse(readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8'));

/** Explicit synthetic DATA_ONLY material. This fixture grants no producer authority. */
export function producerFixture(index = 0, status = 'success')
{
    const materials = {
        producerSchema: source('config/schemas/producer-semantic-outcome.schema.json'),
        aggregateSchema: source('config/schemas/aggregate-run-outcome.schema.json'),
        fieldDispositions: source('config/testing/outcome-field-dispositions.json'),
        failureTaxonomy: source('config/testing/outcome-failure-taxonomy.json'),
        producerCatalog: source('config/testing/correctness-attempt-producers.json')
    };
    const producerId = materials.producerCatalog.entries[index].producerId;
    const identity = {
        producerId, producerAuthorityId: 'fixture-authority', sourceCommit: '1'.repeat(40),
        worktreeFingerprint: digest('worktree'), schedulerRunId: 'fixture-run',
        executionEnvelopeDigest: digest(`envelope:${index}`), replayPlanDigest: digest(`plan:${index}`),
        temporalContextDigest: digest('temporal')
    };
    const failed = status === 'failed' || status === 'partial';
    const blocked = status === 'blocked' || status === 'cancelled';
    const ids = [`test:${index}:a`, `test:${index}:b`];
    const assertions = ids.map((testId, ordinal) => ({
        id: `assertion:${index}:${ordinal}`, testId,
        status: ordinal === 1 && failed ? 'failed' : ordinal === 1 && blocked ? 'blocked' : 'passed',
        failureClass: ordinal === 1 && (failed || blocked) ? 'product' : null,
        failureKind: ordinal === 1 && (failed || blocked) ? 'product.assertion' : null,
        failureIdentity: ordinal === 1 && (failed || blocked)
            ? { producerId, testId, assertionId: `assertion:${index}:${ordinal}` } : null
    }));
    const failures = assertions.filter((item) => item.failureKind).map((item) => ({
        producerId, testId: item.testId, assertionId: item.id,
        failureClass: item.failureClass, failureKind: item.failureKind, identity: item.failureIdentity
    }));
    const outcome = sealContentDigest({
        schema: 'fsusblog.producer-semantic-outcome.v1', schemaVersion: '1',
        fingerprintAlgorithmVersion: 'registry-canonical-json-sha256-v2',
        fieldDispositionDigest: digestCanonical(materials.fieldDispositions),
        failureTaxonomyDigest: digestCanonical(materials.failureTaxonomy),
        producerCatalogDigest: digestCanonical(materials.producerCatalog),
        ...identity,
        policyDigests: [{ policyId: 'fixture-policy', digest: digest('policy') }],
        plannedTestIds: ids, executedTestIds: blocked ? [ids[0]] : ids,
        passedTestIds: failed || blocked ? [ids[0]] : ids,
        failedTestIds: failed ? [ids[1]] : [], skippedTestIds: [], blockedTestIds: blocked ? [ids[1]] : [],
        assertions, failures, scenarioIds: [`scenario:${index}`], coverageIds: [`coverage:${index}`],
        artifactSemanticDigests: [{ semanticId: `artifact:${index}`, owner: 'fixture-owner', digest: digest('artifact') }],
        stateSemanticDigests: [{ semanticId: `state:${index}`, owner: 'fixture-owner', digest: digest('state') }],
        projectionReceipts: [], redactedSecrets: [],
        cleanFirstAttempt: true, qualificationEligible: status === 'success', producerStatus: status,
        semanticPayloadDigest: digest('placeholder'), outcomeFingerprint: digest('placeholder')
    });
    return bindFixture(outcome, materials);
}

/** Recompute explicit fixture expectations after a test's deliberate data change. */
export function bindFixture(outcome, materials)
{
    const options = {
        ...materials,
        expectedContractDigests: Object.fromEntries(['producerSchema', 'aggregateSchema', 'fieldDispositions',
            'failureTaxonomy', 'producerCatalog'].map((key) => [key, digestCanonical(materials[key])])),
        hostExpectedLimits: { maxDepth: 32, maxNodes: 100000, maxStringBytes: 8000000, maxArrayItems: 10000, maxObjectKeys: 10000 },
        expected: {
            identity: Object.fromEntries(['producerId', 'producerAuthorityId', 'sourceCommit', 'worktreeFingerprint',
                'schedulerRunId', 'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest'].map((key) => [key, outcome[key]])),
            ...Object.fromEntries(['plannedTestIds', 'scenarioIds', 'coverageIds', 'policyDigests', 'artifactSemanticDigests',
                'stateSemanticDigests', 'projectionReceipts', 'redactedSecrets', 'semanticPayloadDigest', 'outcomeFingerprint']
                .map((key) => [key, outcome[key]])),
            assertionIds: outcome.assertions.map((item) => item.id).sort()
        }
    };
    const preliminary = analyzeStrongSemanticOutcome(sealContentDigest(outcome), options);
    const finalOutcome = sealContentDigest({ ...outcome,
        semanticPayloadDigest: preliminary.semanticPayloadDigest, outcomeFingerprint: preliminary.outcomeFingerprint });
    return { outcome: finalOutcome, options: { ...options, expected: { ...options.expected,
        semanticPayloadDigest: preliminary.semanticPayloadDigest, outcomeFingerprint: preliminary.outcomeFingerprint } } };
}

export function aggregateOptions(members)
{
    const base = members[0];
    return { ...base.options, expected: {
        runId: base.outcome.schedulerRunId, sourceCommit: base.outcome.sourceCommit,
        worktreeFingerprint: base.outcome.worktreeFingerprint,
        requiredProducerIds: members.map((item) => item.outcome.producerId).sort(),
        requiredCoverageIds: [...new Set(members.flatMap((item) => item.outcome.coverageIds))].sort(),
        stateSemanticDigests: members.flatMap((item) => item.outcome.stateSemanticDigests)
            .sort((left, right) => left.semanticId < right.semanticId ? -1 : left.semanticId > right.semanticId ? 1 : 0),
        artifactSemanticDigests: members.flatMap((item) => item.outcome.artifactSemanticDigests)
            .sort((left, right) => left.semanticId < right.semanticId ? -1 : left.semanticId > right.semanticId ? 1 : 0)
    } };
}
