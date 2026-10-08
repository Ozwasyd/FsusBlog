import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { analyzeDomainProducerSemanticOutcomeCandidate, normalizeOutcomeIdsMap } = await import(new URL('../../tools/test-matrix/outcomes/domain-outcome-analysis.mjs', import.meta.url));
const { readOutcomeAdapterCatalog } = await import(new URL('../../tools/test-matrix/outcomes/outcome-adapter-profile-contract.mjs', import.meta.url));
const { sealProducerSemanticOutcomeCandidate } = await import(new URL('../../tools/test-matrix/outcomes/outcome-contract.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const shapes = JSON.parse(fs.readFileSync(new URL('../../config/schemas/outcome-adapter-membership.schema.json', import.meta.url)));
const digest = `sha256:${'1'.repeat(64)}`;

function valueFor(schema)
{
    if (Object.hasOwn(schema, 'const'))
    {
        return schema.const;
    }
    if (schema.enum)
    {
        return schema.enum[0];
    }
    if (schema.anyOf)
    {
        return valueFor(schema.anyOf[0]);
    }
    if (schema.type === 'object')
    {
        return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, valueFor(value)]));
    }
    if (schema.type === 'array')
    {
        return [];
    }
    if (schema.type === 'boolean')
    {
        return false;
    }
    if (schema.type === 'integer')
    {
        return 1;
    }
    return schema.pattern ? digest : 'fixture';
}

function fixture(family, producerIndex = 0, change = () =>
{})
{
    const entry = readOutcomeAdapterCatalog().entries.find((item) => item.family === family);
    const producerId = entry.producerIds[producerIndex];
    const identity = { producerId, schedulerRunId: 'domain-fixture-run', sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: digest, buildIdentity: digest, toolchainDigest: digest,
        executionEnvelopeDigest: digest, temporalContextDigest: digest, replayPlanDigest: digest };
    const membership = valueFor(shapes.$defs[family]);
    const reasons = [];
    change(membership, reasons, producerId);
    const candidate = sealProducerSemanticOutcomeCandidate({ producerId, producerAuthorityId: entry.authorityId,
        identity, inputAuthorityRefs: [{ kind: 'fixture', path: 'fixture/domain.json', digest }],
        attemptEligibility: { aggregateDigest: digest, attemptDigest: digest, attemptNumber: 1,
            cleanFirstAttempt: reasons.length === 0, firstFailure: reasons.length > 0, qualificationEligible: reasons.length === 0 },
        outcome: { status: reasons.length ? 'failed' : 'success', requiredMembershipVerified: reasons.length === 0,
            membership, reasons, semanticPayloadDigest: digestCanonical(membership) } });
    return { candidate, options: { expectedIdentity: structuredClone(identity), expectedProducerId: producerId,
        expectedAuthorityId: entry.authorityId, expectedSourceCommit: entry.sourceCommit,
        expectedSourceDigest: entry.sourceDigest, expectedCandidateDigest: candidate.contentDigest,
        maxBytes: 1000000, hostExpectedLimits: { maxDepth: 32, maxNodes: 100000,
            maxStringBytes: 1000000, maxArrayItems: 10000, maxObjectKeys: 10000 } } };
}

function failure(producerId, scope)
{
    return { kind: 'product.assertion', producerId, identity: { producerId, ...scope },
        failureClass: 'product', diagnosticEvidenceId: 'diagnostic:one',
        semanticArtifactIds: ['artifact:b', 'artifact:a'], stateIds: ['state:one'] };
}

test('backend unit scoped assertion retains case test and all admitted evidence fields', async () =>
{
    const f = fixture('backend', 0, (membership, reasons, producerId) =>
    {
        membership.plannedTestIds = ['test:one'];
        membership.executedTestIds = ['test:one'];
        membership.failedTestIds = ['test:one'];
        membership.caseIdentities = [{ testId: 'test:one', caseId: 'case:one', inputDigest: digest,
            shrinkSequenceIdentity: digest, transitionIds: ['transition:one'] }];
        membership.assertions = [{ testId: 'test:one', caseId: 'case:one', assertionId: 'assertion:one',
            status: 'failed', evidenceId: 'diagnostic:one' }];
        reasons.push(failure(producerId, { testId: 'test:one', caseId: 'case:one', assertionId: 'assertion:one' }));
    });
    const result = await analyzeDomainProducerSemanticOutcomeCandidate(f.candidate, f.options);
    assert.deepEqual(result.canonicalCandidate.outcome.reasons[0], { ...f.candidate.outcome.reasons[0],
        semanticArtifactIds: ['artifact:a', 'artifact:b'] });
    assert.equal(result.producerVerificationPending, true);
    assert.equal(result.dataOnly, true);
    assert.equal(Object.isFrozen(f.candidate.identity), false);
});

test('backend xunit fixture uses the registered producer source without losing assertion scope', async () =>
{
    const f = fixture('backend', 1, (_membership, reasons, producerId) =>
    {
        reasons.push(failure(producerId, { testId: 'xunit:test', assertionId: 'xunit:assertion' }));
    });
    const result = await analyzeDomainProducerSemanticOutcomeCandidate(f.candidate, f.options);
    assert.equal(result.canonicalCandidate.outcome.reasons[0].identity.testId, 'xunit:test');
    assert.equal(result.version.sourceCommit, f.options.expectedSourceCommit);
});

test('frontend suite test map normalizes dynamic keys and ID ordering with stable fingerprints', async () =>
{
    const make = (ids) => fixture('frontend', 0, (membership) =>
    {
        membership.plannedSuiteIds = ['suite:one'];
        membership.executedSuiteIds = ['suite:one'];
        membership.passedSuiteIds = ['suite:one'];
        membership.plannedTestIds = ids;
        membership.executedTestIds = ids;
        membership.passedTestIds = ids;
        membership.suiteTestIds = { 'suite:one': ids };
    });
    const left = make(['test:b', 'test:a']);
    const right = make(['test:a', 'test:b']);
    const a = await analyzeDomainProducerSemanticOutcomeCandidate(left.candidate, left.options);
    const b = await analyzeDomainProducerSemanticOutcomeCandidate(right.candidate, right.options);
    assert.deepEqual(a.canonicalCandidate.outcome.membership.suiteTestIds, { 'suite:one': ['test:a', 'test:b'] });
    assert.equal(a.outcomeFingerprint, b.outcomeFingerprint);
    assert.deepEqual(normalizeOutcomeIdsMap({ z: ['b', 'a'], a: [] }), { a: [], z: ['a', 'b'] });
});

test('frontend failed assertions preserve identity and semantic artifact references', async () =>
{
    const f = fixture('frontend', 0, (membership, reasons, producerId) =>
    {
        const reason = failure(producerId, { testId: 'test:one', assertionId: 'assertion:one' });
        reasons.push(reason);
        membership.plannedTestIds = ['test:one'];
        membership.executedTestIds = ['test:one'];
        membership.failedTestIds = ['test:one'];
        membership.plannedSuiteIds = ['suite:one'];
        membership.executedSuiteIds = ['suite:one'];
        membership.failedSuiteIds = ['suite:one'];
        membership.suiteTestIds = { 'suite:one': ['test:one'] };
        membership.failures = [{ producerId, testId: 'test:one', assertionId: 'assertion:one', failureClass: 'product',
            failureKind: reason.kind, identity: reason.identity, semanticArtifactIds: reason.semanticArtifactIds }];
        membership.assertions = [{ id: 'assertion:one', testId: 'test:one', status: 'failed',
            failureClass: 'product', failureKind: reason.kind, failureIdentity: reason.identity }];
    });
    const result = await analyzeDomainProducerSemanticOutcomeCandidate(f.candidate, f.options);
    assert.deepEqual(result.canonicalCandidate.outcome.membership.assertions, f.candidate.outcome.membership.assertions);
    assert.deepEqual(result.canonicalCandidate.outcome.membership.failures[0].semanticArtifactIds, ['artifact:a', 'artifact:b']);
});

test('frontend begun blocked test retains executed membership and native suite terminal status', async () =>
{
    const f = fixture('frontend', 0, (membership, reasons, producerId) =>
    {
        membership.plannedTestIds = ['test:begun'];
        membership.executedTestIds = ['test:begun'];
        membership.blockedTestIds = ['test:begun'];
        membership.plannedSuiteIds = ['suite:one'];
        membership.executedSuiteIds = ['suite:one'];
        membership.blockedSuiteIds = ['suite:one'];
        membership.suiteTestIds = { 'suite:one': ['test:begun'] };
        reasons.push({ kind: 'infra.process-signal', producerId,
            identity: { producerId, testId: 'test:begun', attemptNumber: 1 } });
    });
    const result = await analyzeDomainProducerSemanticOutcomeCandidate(f.candidate, f.options);
    const membership = result.canonicalCandidate.outcome.membership;
    assert.deepEqual(membership.executedTestIds, ['test:begun']);
    assert.deepEqual(membership.blockedTestIds, ['test:begun']);
    assert.deepEqual(membership.blockedSuiteIds, ['suite:one']);
    assert.deepEqual(membership.failedTestIds, []);
    assert.equal(result.producerVerificationPending, true);
});

test('browser failure retains project browser test and assertion identity', async () =>
{
    const f = fixture('browser', 0, (_membership, reasons, producerId) =>
    {
        reasons.push(failure(producerId, { projectId: 'project:one', browserId: 'browser:one',
            testId: 'test:one', assertionId: 'assertion:one' }));
    });
    const result = await analyzeDomainProducerSemanticOutcomeCandidate(f.candidate, f.options);
    assert.deepEqual(result.canonicalCandidate.outcome.reasons[0].identity, f.candidate.outcome.reasons[0].identity);
});

test('reliability preserves scenario action scope and ordered lifecycle data', async () =>
{
    const f = fixture('reliability', 0, (membership, reasons, producerId) =>
    {
        const reason = failure(producerId, { scenarioId: 'scenario:one', phase: 'verify',
            actionId: 'action:one', assertionId: 'assertion:one' });
        reasons.push(reason);
        membership.scenarioIds = ['scenario:one'];
        membership.memberOutcomes = [{ scenarioId: 'scenario:one', planned: true, executed: true,
            terminalClassification: 'product-failure', reachedPhase: 'verify', failureReasons: [reason],
            lifecycle: ['setup', 'verify'].map((phase) => ({ actionId: phase, phase, status: 'passed',
                stateDomains: ['state:b', 'state:a'], isolationEvidenceDigest: digest })), semanticEvidence: null }];
    });
    const result = await analyzeDomainProducerSemanticOutcomeCandidate(f.candidate, f.options);
    const member = result.canonicalCandidate.outcome.membership.memberOutcomes[0];
    assert.deepEqual(member.lifecycle.map((item) => item.phase), ['setup', 'verify']);
    assert.deepEqual(member.failureReasons[0].identity, f.candidate.outcome.reasons[0].identity);
    assert.deepEqual(member.lifecycle[0].stateDomains, ['state:a', 'state:b']);
});

test('all three original build schema shapes remain admitted by the separate domain API', async () =>
{
    for (const family of ['immutable-build-semantic-outcome', 'release-projection-semantic-outcome', 'release-finalizer-semantic-outcome'])
    {
        const f = fixture(family);
        const result = await analyzeDomainProducerSemanticOutcomeCandidate(f.candidate, f.options);
        assert.deepEqual(result.canonicalCandidate.outcome.membership, f.candidate.outcome.membership);
        assert.equal(result.normalizationStatus, 'existing-v2');
    }
});
