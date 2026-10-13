import assert from 'node:assert/strict';
import test from 'node:test';

const { aggregateAttemptReceiptSchema, attemptReceiptSchema, digestCanonical,
    retryPolicyById, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { canonicalTestId, planExactShards, REPLAY_PLAN_SCHEMA, sealReplayPlan } = await import(new URL('../../tools/test/execution-replay-contract.mjs', import.meta.url));
const { evidenceProjectionReceiptSchema, sealProjectionDocument } = await import(new URL('../../tools/test-matrix/evidence-projection.mjs', import.meta.url));
const { adaptBackendTestSemanticOutcome, backendCaseCatalogSchema, backendFrameworkReportSchema,
    backendTestOutcomeAuthorityId, verifyBackendTestSemanticOutcomeCandidate } = await import(new URL('../../tools/test-matrix/outcomes/backend-test-adapter.mjs', import.meta.url));
const { readOutcomeFailureTaxonomy, validateProducerSemanticOutcomeCandidate } = await import(new URL('../../tools/test-matrix/outcomes/outcome-contract.mjs', import.meta.url));

const d = (digit) => `sha256:${digit.repeat(64)}`;
const sourceCommit = 'a'.repeat(40);
const producerId = 'backend-unit';
const policy = retryPolicyById('correctness-first-attempt');
const taxonomyDigest = digestCanonical([...readOutcomeFailureTaxonomy().values()]);
const theoryIds = ['row:01/value=İstanbul', 'row:02/value=東京'];

function plannedCase(kind, id, index)
{
    const testId = canonicalTestId({ framework: 'xunit', source: 'tests/backend/Unit/OutcomeTests.cs',
        name: ['OutcomeTests', `Case${index}`],
        caseIdentity: kind === 'parameterized' ? { kind, id } : null });
    return { testId, caseBinding: { kind, id }, assertionIds: ['assert:equal'],
        coverageIds: [], artifactIds: [], stateIds: [] };
}

// In-memory independent held-input doubles test the adapter boundary, not native qualification.
function fixture({ failure = false, crash = false, applicability = false, projection = false } = {})
{
    const cases = [plannedCase('parameterized', theoryIds[0], 0), plannedCase('parameterized', theoryIds[1], 1),
        plannedCase('property', 'property:seed-stream', 2), plannedCase('model', 'model:seed-stream', 3),
        plannedCase('fuzz', 'fuzz:seed-stream', 4)];
    if (applicability)
    {
        cases[0].coverageIds = ['coverage:backend'];
        cases[0].artifactIds = ['snapshot:backend'];
        cases[0].stateIds = ['state:backend'];
    }
    const plan = sealReplayPlan({ schema: REPLAY_PLAN_SCHEMA,
        source: { commit: sourceCommit, worktreeFingerprint: d('b') },
        producer: { id: producerId, framework: 'xunit' }, run: { id: 'backend-run', mode: 'qualification' },
        rootSeed: `seed256:${'01'.repeat(32)}`, entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }],
        randomStreams: [], ...planExactShards({ testIds: cases.map((entry) => entry.testId) }),
        workers: { ids: ['worker-a'], assignmentPolicy: 'framework-owned-after-seal' },
        frameworkModes: [{ name: 'retry', value: 'disabled' }],
        schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false },
        schedulerShuffleSeed: 'scheduler-seed-v1',
        command: { executable: 'dotnet', args: ['test'], environmentDigest: d('c') } });
    const identity = { producerId, sourceCommit, worktreeFingerprint: d('b'), schedulerRunId: 'backend-run',
        buildIdentity: d('1'), toolchainDigest: d('2'), executionEnvelopeDigest: d('3'),
        temporalContextDigest: d('4'), replayPlanDigest: plan.planDigest };
    const catalog = { schema: backendCaseCatalogSchema, identity,
        policyDigests: { retryPolicyDigest: digestCanonical(policy), failureTaxonomyDigest: taxonomyDigest,
            projectionPolicyDigest: projection ? d('5') : null }, tests: cases };
    const references = [
        { id: 'framework', path: 'framework.json', digest: d('e') },
        { id: 'assertion', path: 'assertion.json', digest: d('f') }
    ];
    const observations = cases.map((entry, index) =>
    {
        const randomized = ['property', 'model', 'fuzz'].includes(entry.caseBinding.kind);
        const caseId = randomized ? 'seed:17/iteration:2' : entry.caseBinding.id;
        const status = crash && index > 1 ? 'blocked' : (failure || crash) && index === 1 ? 'failed' : 'passed';
        return { testId: entry.testId, caseBinding: entry.caseBinding, status,
            cases: status === 'blocked' ? [] : [{ caseId, inputDigest: randomized ? d('6') : null,
                shrinkSequenceIdentity: randomized ? d('7') : null,
                transitionIds: entry.caseBinding.kind === 'model' ? ['transition:02', 'transition:03'] : [] }],
            assertions: status === 'blocked' ? [] : [{ id: 'assert:equal', caseId,
                status: status === 'failed' ? 'failed' : 'passed', evidenceId: 'assertion',
                failure: status === 'failed' ? {
                    class: 'product', kind: 'product.assertion', identity: { producerId, testId: entry.testId,
                        caseId, assertionId: 'assert:equal' }, diagnosticEvidenceId: 'assertion', semanticArtifactIds: [], stateIds: []
                } : null }], coverageIds: entry.coverageIds, artifactIds: entry.artifactIds,
            stateIds: entry.stateIds, evidenceId: 'framework' };
    });
    const artifactDigests = { 'assertion.json': d('f'), 'framework.json': d('e'), 'stderr.log': d('8'), 'stdout.log': d('9') };
    const attempt = {
        schema: attemptReceiptSchema, producerId, attemptNumber: 1, maxAttempts: 1, sourceCommit,
        worktreeFingerprint: identity.worktreeFingerprint, schedulerRunId: identity.schedulerRunId,
        command: ['dotnet', 'test'], commandDigest: digestCanonical(['dotnet', 'test']),
        executionEnvelopeDigest: identity.executionEnvelopeDigest, replayPlanDigest: plan.planDigest,
        temporalContextDigest: identity.temporalContextDigest,
        authorityReferences: ['execution-envelope', 'replay-plan', 'temporal-context'].map((kind) => ({
            kind, artifactPath: `${kind}.json`,
            artifactDigest: { 'execution-envelope': identity.executionEnvelopeDigest, 'replay-plan': plan.planDigest,
                'temporal-context': identity.temporalContextDigest }[kind],
            verificationReceiptPath: `${kind}.verification.json`, verificationReceiptDigest: d('a') })),
        startedAt: '2026-10-08T00:00:00.000Z', finishedAt: '2026-10-08T00:00:01.000Z', durationMs: 1000,
        exitCode: failure || crash ? 1 : 0, signal: crash ? 'SIGKILL' : null,
        failureClass: crash ? 'infra' : failure ? 'product' : null,
        failureKind: crash ? 'infra.process-signal' : failure ? 'product.assertion' : null,
        executedTestIds: observations.filter((entry) => ['passed', 'failed'].includes(entry.status)).map((entry) => entry.testId).sort(),
        failedTestIds: observations.filter((entry) => entry.status === 'failed').map((entry) => entry.testId).sort(),
        stdoutPath: 'stdout.log', stderrPath: 'stderr.log', artifactPaths: Object.keys(artifactDigests).sort(), artifactDigests,
        firstFailure: failure || crash, retryDecision: failure || crash ? 'policy-denied' : 'not-applicable',
        retryPolicyId: policy.id, status: failure || crash ? 'failed-no-retry' : 'clean-success'
    };
    const aggregateAttempt = { schema: aggregateAttemptReceiptSchema, producerId, schedulerRunId: identity.schedulerRunId,
        sourceCommit, worktreeFingerprint: identity.worktreeFingerprint, retryPolicyId: policy.id,
        attempts: [], firstAttemptStatus: attempt.status, finalAttemptStatus: attempt.status, finalClassification: attempt.status,
        cleanFirstAttempt: !failure && !crash, qualificationEligible: !failure && !crash };
    const report = { schema: backendFrameworkReportSchema, identity, attemptDigest: null, catalogDigest: null,
        frameworkStatus: crash ? 'crashed' : 'completed', tests: observations, evidenceRefs: references,
        artifactSemanticDigests: applicability ? { 'snapshot:backend': d('a') } : {},
        stateSemanticDigests: applicability ? { 'state:backend': d('b') } : {},
        terminalFailure: crash ? { class: 'infra', kind: 'infra.process-signal', identity: { producerId, attemptNumber: 1 },
            diagnosticEvidenceId: 'framework', semanticArtifactIds: [], stateIds: [] } : null };
    const values = { identity, plan, catalog, report, attempt, aggregateAttempt, inputAuthorityRefs: [], projectionReceipt: null };
    if (projection)
    {
        values.projectionReceipt = sealProjectionDocument({ schema: evidenceProjectionReceiptSchema,
            status: 'success', executionMode: 'projection', tierId: 'backend-projection', executionOwner: producerId,
            projectFrom: producerId, sourceState: { commit: sourceCommit, worktreeFingerprint: 'b'.repeat(64) },
            runId: identity.schedulerRunId, buildIdentity: identity.buildIdentity, policyIdentity: d('5'),
            testIds: [...plan.testEnumerationOrder], coverageIds: applicability ? ['coverage:backend'] : [] });
    }
    let heldIdentity;
    let heldRefs;
    let heldArtifacts;
    function refresh()
    {
        values.catalog = structuredClone(sealContentDigest(values.catalog));
        values.attempt = structuredClone(sealContentDigest(values.attempt));
        values.aggregateAttempt = structuredClone(sealContentDigest({ ...values.aggregateAttempt,
            attempts: [{ attemptNumber: 1, path: 'attempt.json', digest: values.attempt.contentDigest }] }));
        values.report = structuredClone(sealContentDigest({ ...values.report, attemptDigest: values.attempt.contentDigest, catalogDigest: values.catalog.contentDigest }));
        const documents = { 'replay-plan': values.plan.planDigest, 'backend-catalog': values.catalog.contentDigest,
            'backend-report': values.report.contentDigest, attempt: values.attempt.contentDigest,
            'aggregate-attempt': values.aggregateAttempt.contentDigest,
            ...(values.projectionReceipt ? { 'evidence-projection': values.projectionReceipt.contentDigest } : {}) };
        values.inputAuthorityRefs = Object.entries(documents).map(([kind, digest]) => ({ kind, path: `${kind}.json`, digest }));
        heldIdentity = structuredClone(values.identity);
        heldRefs = structuredClone(values.inputAuthorityRefs);
        heldArtifacts = structuredClone(values.attempt.artifactDigests);
    }
    refresh();
    values.verifyAuthority = (reference) => ({ verified: true, authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest, identity: heldIdentity });
    values.verifyArtifact = (path, digest) => heldArtifacts[path] === digest;
    values.verifyBackendEvidence = () => ({ verified: true, identity: heldIdentity, inputAuthorityRefs: heldRefs,
        verificationReceipt: { path: 'held-verification.json', digest: d('c') } });
    return { values, refresh, adapt: () => adaptBackendTestSemanticOutcome(values) };
}

function rejectedMutation(mutate, options)
{
    const f = fixture(options);
    mutate(f.values);
    f.refresh();
    assert.throws(f.adapt);
}

test('backend candidate preserves exact xUnit theory unique IDs and sealed planned membership', () =>
{
    const f = fixture();
    const result = f.adapt();
    assert.equal(result.producerAuthorityId, backendTestOutcomeAuthorityId);
    assert.equal(result.schema, 'fsusblog.producer-semantic-outcome-candidate.v1');
    assert.equal(result.outcome.status, 'success');
    assert.deepEqual(result.outcome.membership.plannedTestIds, f.values.plan.testEnumerationOrder);
    assert.deepEqual(result.outcome.membership.executedTestIds, f.values.plan.testEnumerationOrder);
    assert.deepEqual(result.outcome.membership.passedTestIds, f.values.plan.testEnumerationOrder);
    assert.deepEqual(result.outcome.membership.failedTestIds, []);
    assert.deepEqual(result.outcome.membership.skippedTestIds, []);
    assert.deepEqual(result.outcome.membership.blockedTestIds, []);
    for (const id of theoryIds)
    {
        assert.ok(result.outcome.membership.caseIdentities.some((entry) => entry.caseId === id));
    }
    assert.ok(!Object.hasOwn(result, 'outcomeFingerprint'));
    validateProducerSemanticOutcomeCandidate(result);
    verifyBackendTestSemanticOutcomeCandidate(result, f.values);
});

test('display names cannot replace parameterized framework IDs', () =>
{
    rejectedMutation((values) =>
    {
        values.report.tests[0].caseBinding.id = 'Case0(display name)';
    });
    rejectedMutation((values) =>
    {
        values.catalog.tests[0].caseBinding.id = 'Case0(display name)';
        values.report.tests[0].caseBinding.id = 'Case0(display name)';
    });
});

test('property model and fuzz failures preserve exact case input shrink and transition identities', () =>
{
    for (const kind of ['property', 'model', 'fuzz'])
    {
        const f = fixture({ failure: true });
        f.values.report.tests[1].status = 'passed';
        f.values.report.tests[1].assertions[0].status = 'passed';
        f.values.report.tests[1].assertions[0].failure = null;
        const observed = f.values.report.tests.find((entry) => entry.caseBinding.kind === kind);
        observed.status = 'failed';
        observed.assertions[0].status = 'failed';
        observed.assertions[0].failure = { class: 'product', kind: 'product.assertion',
            identity: { producerId, testId: observed.testId, caseId: observed.cases[0].caseId, assertionId: 'assert:equal' },
            diagnosticEvidenceId: 'assertion', semanticArtifactIds: [], stateIds: [] };
        f.values.attempt.failedTestIds = [observed.testId];
        f.refresh();
        const result = f.adapt();
        assert.equal(result.outcome.status, 'failed');
        assert.equal(result.attemptEligibility.qualificationEligible, false);
        const observedCase = result.outcome.membership.caseIdentities.find((entry) => entry.testId === observed.testId);
        assert.equal(observedCase.caseId, 'seed:17/iteration:2');
        assert.equal(observedCase.inputDigest, d('6'));
        assert.equal(observedCase.shrinkSequenceIdentity, d('7'));
        assert.deepEqual(observedCase.transitionIds, kind === 'model' ? ['transition:02', 'transition:03'] : []);
        assert.equal(result.outcome.reasons[0].identity.caseId, observedCase.caseId);
    }
});

test('missing duplicate and extra planned or actual cases fail closed in both directions', () =>
{
    for (const field of ['catalog', 'report'])
    {
        rejectedMutation((v) =>
        {
            v[field].tests.pop();
        });
        rejectedMutation((v) =>
        {
            v[field].tests.push(structuredClone(v[field].tests[0]));
        });
        rejectedMutation((v) =>
        {
            v[field].tests[0].testId = canonicalTestId({ framework: 'xunit', source: 'tests/backend/Other.cs', name: ['Other'] });
        });
    }
    rejectedMutation((v) =>
    {
        const unsigned = Object.fromEntries(Object.entries(v.plan).filter(([key]) =>
            !['planDigest', 'enumerationDigest', 'shardDigest'].includes(key)));
        v.plan = sealReplayPlan({ ...unsigned, ...planExactShards({ testIds: v.plan.testEnumerationOrder.slice(1) }) });
        v.identity.replayPlanDigest = v.plan.planDigest;
        v.attempt.replayPlanDigest = v.plan.planDigest;
        v.attempt.authorityReferences.find((ref) => ref.kind === 'replay-plan').artifactDigest = v.plan.planDigest;
    });
});

test('overlapping terminals and duplicate or extra assertion identities fail closed', () =>
{
    rejectedMutation((v) =>
    {
        v.report.tests[0].failedTestIds = [v.report.tests[0].testId];
    });
    rejectedMutation((v) =>
    {
        v.report.tests[0].assertions.push(structuredClone(v.report.tests[0].assertions[0]));
    });
    rejectedMutation((v) =>
    {
        v.report.tests[0].assertions[0].id = 'assert:orphan';
    });
    rejectedMutation((v) =>
    {
        v.report.tests[0].assertions[0].caseId = 'unknown-case';
    });
    rejectedMutation((v) =>
    {
        v.report.tests[0].status = 'not-run';
    });
});

test('framework crash preserves prior pass failure and remaining blocked topology', () =>
{
    const f = fixture({ crash: true });
    const result = f.adapt();
    const membership = result.outcome.membership;
    assert.deepEqual(membership.passedTestIds, [f.values.report.tests[0].testId]);
    assert.deepEqual(membership.failedTestIds, [f.values.report.tests[1].testId]);
    assert.deepEqual(membership.executedTestIds, f.values.attempt.executedTestIds);
    assert.deepEqual(membership.blockedTestIds, f.values.report.tests.slice(2).map((entry) => entry.testId).sort());
    assert.deepEqual(membership.skippedTestIds, []);
    assert.ok(result.outcome.reasons.some((entry) => entry.kind === 'infra.process-signal'));
    assert.equal(result.attemptEligibility.firstFailure, true);
    assert.equal(result.attemptEligibility.qualificationEligible, false);
});

test('unknown partial and crash without exact terminal proof fail closed', () =>
{
    rejectedMutation((v) =>
    {
        v.report.frameworkStatus = 'crashed';
    });
    rejectedMutation((v) =>
    {
        v.report.frameworkStatus = 'completed';
    }, { crash: true });
    rejectedMutation((v) =>
    {
        v.report.terminalFailure.kind = 'infra.process-launch';
    }, { crash: true });
    rejectedMutation((v) =>
    {
        v.report.terminalFailure.identity.attemptNumber = 2;
    }, { crash: true });
    rejectedMutation((v) =>
    {
        v.report.tests[1].assertions = [];
    }, { crash: true });
});

test('skipped first attempts retain exact terminal membership and never qualify success', () =>
{
    const f = fixture({ failure: true });
    f.values.report.tests[1].status = 'skipped';
    f.values.report.tests[1].cases = [];
    f.values.report.tests[1].assertions = [];
    const skippedId = f.values.report.tests[1].testId;
    f.values.attempt.executedTestIds = f.values.attempt.executedTestIds.filter((id) => id !== skippedId);
    f.values.attempt.failedTestIds = [];
    f.values.attempt.failureClass = 'contract';
    f.values.attempt.failureKind = 'contract.missing-evidence';
    f.refresh();
    const result = f.adapt();
    assert.equal(result.outcome.status, 'failed');
    assert.deepEqual(result.outcome.membership.skippedTestIds, [skippedId]);
    assert.equal(result.attemptEligibility.qualificationEligible, false);
});

test('message changes in independently verified raw diagnostics do not change canonical semantics', () =>
{
    const first = fixture({ failure: true }).adapt();
    const f = fixture({ failure: true });
    f.values.attempt.artifactDigests['assertion.json'] = d('0');
    f.values.report.evidenceRefs[1].digest = d('0');
    f.refresh();
    const changed = f.adapt();
    assert.notEqual(first.contentDigest, changed.contentDigest);
    assert.equal(first.outcome.semanticPayloadDigest, changed.outcome.semanticPayloadDigest);
    assert.deepEqual(first.outcome.reasons, changed.outcome.reasons);
});

test('canonical taxonomy cannot be selected from messages or unknown classes and kinds', () =>
{
    rejectedMutation((v) =>
    {
        v.report.tests[1].assertions[0].failure.kind = 'product.invented';
    }, { failure: true });
    rejectedMutation((v) =>
    {
        v.report.tests[1].assertions[0].failure.class = 'infra';
    }, { failure: true });
    rejectedMutation((v) =>
    {
        v.report.tests[1].assertions[0].failure = { message: 'assertion failed' };
    }, { failure: true });
    rejectedMutation((v) =>
    {
        v.report.tests[1].assertions[0].failure = null;
    }, { failure: true });
    rejectedMutation((v) =>
    {
        v.catalog.policyDigests.failureTaxonomyDigest = d('0');
    });
});

test('missing cross-test cross-case assertion and diagnostic evidence identities fail closed', () =>
{
    rejectedMutation((v) =>
    {
        delete v.report.tests[1].assertions[0].failure.identity.assertionId;
    }, { failure: true });
    rejectedMutation((v) =>
    {
        v.report.tests[1].assertions[0].failure.identity.testId = v.report.tests[0].testId;
    }, { failure: true });
    rejectedMutation((v) =>
    {
        v.report.tests[1].assertions[0].failure.identity.caseId = 'other';
    }, { failure: true });
    rejectedMutation((v) =>
    {
        v.report.tests[1].assertions[0].failure.diagnosticEvidenceId = 'missing';
    }, { failure: true });
    rejectedMutation((v) =>
    {
        v.report.tests[0].assertions = [];
    });
    rejectedMutation((v) =>
    {
        v.report.tests[0].assertions[0].evidenceId = 'missing';
    });
});

test('diagnostic attempts and missing external authority never emit verified candidates', () =>
{
    rejectedMutation((v) =>
    {
        v.attempt.retryPolicyId = 'diagnostic-browser-process-crash';
        v.attempt.maxAttempts = 2;
        v.aggregateAttempt.retryPolicyId = v.attempt.retryPolicyId;
        v.aggregateAttempt.qualificationEligible = false;
        v.catalog.policyDigests.retryPolicyDigest = digestCanonical(retryPolicyById(v.attempt.retryPolicyId));
    });
    const f = fixture();
    assert.throws(() => adaptBackendTestSemanticOutcome({ ...f.values, verifyAuthority: undefined }));
    assert.throws(() => adaptBackendTestSemanticOutcome({ ...f.values, verifyArtifact: undefined }));
    assert.throws(() => adaptBackendTestSemanticOutcome({ ...f.values, verifyBackendEvidence: undefined }));
    assert.throws(() => adaptBackendTestSemanticOutcome({ ...f.values, verifyBackendEvidence: () => ({ verified: true }) }));
    rejectedMutation((v) =>
    {
        v.aggregateAttempt.qualificationEligible = false;
    });
});

test('cross-run source envelope temporal replay build and toolchain identities fail closed', () =>
{
    for (const field of ['schedulerRunId', 'sourceCommit', 'worktreeFingerprint', 'executionEnvelopeDigest',
        'temporalContextDigest', 'replayPlanDigest', 'buildIdentity', 'toolchainDigest'])
    {
        rejectedMutation((v) =>
        {
            v.report.identity = { ...v.identity, [field]: field === 'sourceCommit'
                ? '0'.repeat(40) : field === 'schedulerRunId' ? 'foreign-run' : d('0') };
        });
    }
    const f = fixture();
    f.values.identity = { ...f.values.identity, buildIdentity: d('0') };
    f.values.report.identity = f.values.identity;
    f.values.catalog.identity = f.values.identity;
    f.values.catalog = sealContentDigest(f.values.catalog);
    f.values.report = sealContentDigest({ ...f.values.report, catalogDigest: f.values.catalog.contentDigest });
    assert.throws(f.adapt);
});

test('attempt membership must exactly match semantic execution and failures', () =>
{
    rejectedMutation((v) =>
    {
        v.attempt.executedTestIds.pop();
    });
    rejectedMutation((v) =>
    {
        v.attempt.failedTestIds = [];
    }, { failure: true });
    rejectedMutation((v) =>
    {
        v.report.tests[0].status = 'failed';
    });
});

test('coverage snapshots and state applicability preserve explicit empty values and exact digests', () =>
{
    const empty = fixture().adapt().outcome.membership;
    assert.deepEqual(empty.coverageIds, []);
    assert.deepEqual(empty.artifactSemanticDigests, {});
    assert.deepEqual(empty.stateSemanticDigests, {});
    assert.deepEqual(empty.projectionReceipts, []);
    const applicable = fixture({ applicability: true }).adapt().outcome.membership;
    assert.deepEqual(applicable.coverageIds, ['coverage:backend']);
    assert.deepEqual(applicable.artifactSemanticDigests, { 'snapshot:backend': d('a') });
    assert.deepEqual(applicable.stateSemanticDigests, { 'state:backend': d('b') });
    rejectedMutation((v) =>
    {
        v.report.tests[0].coverageIds = [];
    }, { applicability: true });
    rejectedMutation((v) =>
    {
        v.report.artifactSemanticDigests = {};
    }, { applicability: true });
    rejectedMutation((v) =>
    {
        v.report.stateSemanticDigests.orphan = d('0');
    });
    rejectedMutation((v) =>
    {
        v.report.artifactSemanticDigests['snapshot:backend'] = 'bad';
    }, { applicability: true });
    rejectedMutation((v) =>
    {
        v.report.tests[1].assertions[0].failure.semanticArtifactIds = ['orphan'];
    }, { failure: true });
});

test('evidence reference tamper and held artifact byte drift are rejected', () =>
{
    rejectedMutation((v) =>
    {
        v.report.evidenceRefs[0].digest = d('0');
    });
    rejectedMutation((v) =>
    {
        v.report.evidenceRefs[0].path = '../foreign/framework.json';
    });
    const f = fixture();
    f.values.verifyArtifact = () => false;
    assert.throws(f.adapt);
    f.values.verifyArtifact = () => true;
    f.values.inputAuthorityRefs[0].digest = d('0');
    assert.throws(f.adapt);
});

test('content seals and independently held input references cannot be replaced by resealing', () =>
{
    const f = fixture();
    f.values.report.tests[0].status = 'failed';
    assert.throws(f.adapt);
    const fresh = fixture();
    fresh.values.report = sealContentDigest({ ...fresh.values.report, contentDigest: d('0') });
    fresh.values.inputAuthorityRefs.find((ref) => ref.kind === 'backend-report').path = 'foreign-report.json';
    assert.throws(fresh.adapt);
});

test('sealed candidate tamper including valid reseals is rejected against held inputs', () =>
{
    const f = fixture();
    const candidate = f.adapt();
    const tampered = structuredClone(candidate);
    tampered.outcome.membership.coverageIds = ['forged'];
    assert.throws(() => verifyBackendTestSemanticOutcomeCandidate(tampered, f.values));
    const resealed = sealContentDigest({ ...tampered,
        outcome: { ...tampered.outcome, semanticPayloadDigest: digestCanonical(tampered.outcome.membership) } });
    assert.throws(() => verifyBackendTestSemanticOutcomeCandidate(resealed, f.values));
    const evidence = structuredClone(candidate);
    evidence.inputAuthorityRefs[0].path = 'foreign.json';
    assert.throws(() => verifyBackendTestSemanticOutcomeCandidate(sealContentDigest(evidence), f.values));
});

test('projection references consume sealed source run membership build and policy identities', () =>
{
    const f = fixture({ applicability: true, projection: true });
    const result = f.adapt();
    assert.deepEqual(result.outcome.membership.projectionReceipts, [{ projectionId: 'backend-projection',
        receiptDigest: f.values.projectionReceipt.contentDigest }]);
    for (const field of ['runId', 'executionOwner', 'buildIdentity', 'policyIdentity'])
    {
        rejectedMutation((v) =>
        {
            v.projectionReceipt = sealProjectionDocument({ ...v.projectionReceipt,
                [field]: field.endsWith('Identity') ? d('0') : 'foreign' });
        }, { projection: true });
    }
    rejectedMutation((v) =>
    {
        v.projectionReceipt = sealProjectionDocument({ ...v.projectionReceipt, testIds: [] });
    }, { projection: true });
    rejectedMutation((v) =>
    {
        v.projectionReceipt.contentDigest = d('0');
    }, { projection: true });
});

test('accessors proxies unknown observation fields and absent explicit applicability fail closed', () =>
{
    const f = fixture();
    let invoked = false;
    Object.defineProperty(f.values.report, 'tests', { get()
    {
        invoked = true;
        return [];
    }, enumerable: true });
    assert.throws(f.adapt);
    assert.equal(invoked, false);
    const proxied = fixture();
    proxied.values.report = new Proxy(proxied.values.report, {});
    assert.throws(proxied.adapt);
    rejectedMutation((v) =>
    {
        v.report.message = 'duration=1 PID=42';
    });
    rejectedMutation((v) =>
    {
        delete v.report.tests[0].coverageIds;
    });
});

test('state failures use canonical semantic identities and reject orphan executed cases', () =>
{
    const f = fixture({ failure: true, applicability: true });
    const observed = f.values.report.tests[1];
    f.values.catalog.tests[1].stateIds = ['state:failure'];
    observed.stateIds = ['state:failure'];
    f.values.report.stateSemanticDigests['state:failure'] = d('a');
    observed.assertions[0].failure.kind = 'product.state-mismatch';
    observed.assertions[0].failure.identity.semanticId = 'state:failure';
    observed.assertions[0].failure.stateIds = ['state:failure'];
    f.values.attempt.failureKind = 'product.state-mismatch';
    f.refresh();
    assert.equal(f.adapt().outcome.reasons[0].identity.semanticId, 'state:failure');
    rejectedMutation((v) =>
    {
        v.report.tests[1].cases.push({ caseId: 'orphan', inputDigest: null,
            shrinkSequenceIdentity: null, transitionIds: [] });
    }, { failure: true });
    rejectedMutation((v) =>
    {
        v.attempt.failureKind = 'product.state-mismatch';
    }, { failure: true });
});

test('framework observation order does not change semantic membership', () =>
{
    const first = fixture().adapt();
    const reversed = fixture();
    reversed.values.report.tests.reverse();
    reversed.refresh();
    assert.deepEqual(reversed.adapt().outcome.membership, first.outcome.membership);
    assert.equal(reversed.adapt().outcome.semanticPayloadDigest, first.outcome.semanticPayloadDigest);
});
