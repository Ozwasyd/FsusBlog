import assert from 'node:assert/strict';
import test from 'node:test';

const { adaptFrontendVitestSemanticOutcome, frontendVitestTestIdentity, frontendVitestSuiteIdentity,
    verifyFrontendVitestSemanticOutcomeCandidate,
    frontendVitestManifestSchema, frontendVitestEvidenceSchema } = await import(new URL('../../tools/test-matrix/outcomes/frontend-vitest-adapter.mjs', import.meta.url));
const { digestCanonical, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { REPLAY_PLAN_SCHEMA, planExactShards, sealReplayPlan } = await import(new URL('../../tools/test/execution-replay-contract.mjs', import.meta.url));
const { validateProducerSemanticOutcomeCandidate } = await import(new URL('../../tools/test-matrix/outcomes/outcome-contract.mjs', import.meta.url));
const d = (digit) => `sha256:${digit.repeat(64)}`;

function fixture()
{
    const suite = { source: 'tests/frontend/unit/example.test.ts', declarationId: 'ExampleSuite', tests: [
        { declarationId: 'acceptsCase', caseId: 'value:alpha', assertionIds: ['assert:alpha'] },
        { declarationId: 'acceptsCase', caseId: 'value:beta', assertionIds: ['assert:beta'] },
        { declarationId: 'emptyInput', caseId: null, assertionIds: ['assert:empty'] }
    ] };
    const testIds = suite.tests.map((item) => frontendVitestTestIdentity(suite, item));
    const replayPlan = sealReplayPlan({ schema: REPLAY_PLAN_SCHEMA,
        source: { commit: 'a'.repeat(40), worktreeFingerprint: d('1') },
        producer: { id: 'frontend-vitest', framework: 'vitest' }, run: { id: 'run-2651', mode: 'qualification' },
        rootSeed: `seed256:${'ab'.repeat(32)}`, entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }],
        randomStreams: [], ...planExactShards({ testIds, shardCount: 1 }),
        workers: { ids: ['worker-1'], assignmentPolicy: 'framework-owned-after-seal' },
        frameworkModes: [{ name: 'retry', value: 'disabled' }],
        schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false }, schedulerShuffleSeed: 'seed-1',
        command: { executable: '/usr/bin/node', args: ['vitest', 'run'], environmentDigest: d('2') } });
    const identity = { buildIdentity: d('3'), executionEnvelopeDigest: d('4'), producerId: 'frontend-vitest',
        replayPlanDigest: replayPlan.planDigest, schedulerRunId: 'run-2651', sourceCommit: 'a'.repeat(40),
        temporalContextDigest: d('5'), toolchainDigest: d('6'), worktreeFingerprint: d('1') };
    const attemptEligibility = { aggregateDigest: d('7'), attemptDigest: d('8'), attemptNumber: 1,
        cleanFirstAttempt: true, firstFailure: false, qualificationEligible: true };
    const manifest = { schema: frontendVitestManifestSchema, identity, configId: 'config:unit', projectId: 'project:frontend',
        policyDigests: { 'policy:outcome': d('9') }, suites: [suite], coverageIds: [], artifactIds: [] };
    const report = { success: true, testResults: [{ name: '/tmp/example.test.ts', assertionResults: testIds.map((id) => ({
        title: 'same display title', ancestorTitles: ['display suite'], fullName: 'display suite same display title',
        status: 'passed', duration: 12, failureMessages: [], location: { line: 12, column: 1 }, diagnosticId: id
    })) }] };
    const evidence = { schema: frontendVitestEvidenceSchema, identity, configId: manifest.configId, projectId: manifest.projectId,
        policyDigests: manifest.policyDigests, attemptEligibility, manifestDigest: d('0'), reportDigest: d('0'), completion: 'complete',
        suiteBindings: [{ suiteId: frontendVitestSuiteIdentity(suite), fileIndex: 0 }],
        tests: testIds.map((testId, index) => ({ testId, status: 'passed', executed: true,
            nativeRef: { fileIndex: 0, assertionIndex: index }, assertions: [
                { id: suite.tests[index].assertionIds[0], status: 'passed', failure: null }
            ] })), coverageIds: [], artifacts: [] };
    return bind({ identity, attemptEligibility, replayPlan, manifest, report, evidence });
}

// Fixture authority is independent test data, never a production qualification receipt.
function bind(values)
{
    values.manifest = structuredClone(sealContentDigest(values.manifest));
    values.evidence = structuredClone(sealContentDigest({ ...values.evidence, manifestDigest: values.manifest.contentDigest,
        reportDigest: digestCanonical(values.report) }));
    values.expectedInputs = structuredClone({ identity: values.identity, attemptEligibility: values.attemptEligibility,
        replayPlanDigest: values.replayPlan.planDigest, manifestDigest: values.manifest.contentDigest,
        reportDigest: digestCanonical(values.report), evidenceDigest: values.evidence.contentDigest,
        hostExpectedLimits: { maxDepth: 32, maxNodes: 10000, maxStringBytes: 100000 } });
    return values;
}

function failure(values, index, kind = 'product.assertion')
{
    const event = values.evidence.tests[index];
    event.status = 'failed';
    const assertion = event.assertions[0];
    assertion.status = 'failed';
    assertion.failure = { kind, identity: { producerId: 'frontend-vitest', testId: event.testId, assertionId: assertion.id },
        diagnosticRef: { path: 'diagnostics/failure.json', digest: d('b') }, semanticArtifactIds: [] };
    values.report.success = false;
    values.report.testResults[0].assertionResults[index].status = 'failed';
    return values;
}

function aborted(values)
{
    values.evidence.completion = 'aborted';
    values.report.success = false;
    values.report.testResults[0].assertionResults.splice(1);
    for (const index of [1, 2])
    {
        const event = values.evidence.tests[index];
        event.status = 'blocked';
        event.executed = index === 1;
        event.nativeRef = null;
        const assertion = event.assertions[0];
        assertion.status = 'blocked';
        assertion.failure = { kind: 'infra.process-signal', identity: { producerId: 'frontend-vitest',
            testId: event.testId, assertionId: assertion.id, attemptNumber: 1 },
        diagnosticRef: { path: 'diagnostics/signal.json', digest: d('c') }, semanticArtifactIds: [] };
    }
    return bind(values);
}

test('frontend adapter returns the original candidate v1 with exact suite/test/case membership', () =>
{
    const values = fixture();
    const result = adaptFrontendVitestSemanticOutcome(values);
    assert.equal(result.schema, 'fsusblog.producer-semantic-outcome-candidate.v1');
    assert.equal(result.verificationStatus, 'verified');
    assert.equal(result.outcome.status, 'success');
    assert.deepEqual(result.outcome.membership.plannedTestIds, values.replayPlan.testEnumerationOrder);
    assert.deepEqual(result.outcome.membership.executedTestIds, values.replayPlan.testEnumerationOrder);
    assert.deepEqual(result.outcome.membership.passedTestIds, values.replayPlan.testEnumerationOrder);
    assert.equal(result.outcome.membership.plannedSuiteIds.length, 1);
    assert.equal(result.outcome.membership.parameterizedTestIds.length, 2);
    assert.deepEqual(result.outcome.membership.passedSuiteIds, result.outcome.membership.plannedSuiteIds);
    assert.deepEqual(result.outcome.membership.passedParameterizedTestIds, result.outcome.membership.parameterizedTestIds);
    assert.equal(Object.hasOwn(result, 'outcomeFingerprint'), false);
    validateProducerSemanticOutcomeCandidate(result);
});

test('native title, line, duration, path and completion order do not define semantic identities', () =>
{
    const first = adaptFrontendVitestSemanticOutcome(fixture());
    const values = fixture();
    const native = values.report.testResults[0];
    native.name = '/relocated/example.test.ts';
    native.assertionResults.reverse();
    native.assertionResults.forEach((item) => Object.assign(item, { title: 'renamed title', fullName: 'other title', duration: 800,
        location: { line: 99, column: 10 } }));
    values.evidence.tests.forEach((event) =>
    {
        event.nativeRef.assertionIndex = 2 - event.nativeRef.assertionIndex;
    });
    values.evidence.tests.reverse();
    values.manifest.suites[0].tests.reverse();
    const second = adaptFrontendVitestSemanticOutcome(bind(values));
    assert.deepEqual(second.outcome.membership, first.outcome.membership);
    assert.equal(second.outcome.semanticPayloadDigest, first.outcome.semanticPayloadDigest);
});

test('semantic parameter values remain distinct even when native display titles collide', () =>
{
    const values = fixture();
    const suite = values.manifest.suites[0];
    assert.notEqual(frontendVitestTestIdentity(suite, suite.tests[0]), frontendVitestTestIdentity(suite, suite.tests[1]));
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind({ ...values,
        manifest: { ...values.manifest, suites: [{ ...suite, tests: [suite.tests[0], suite.tests[0], suite.tests[2]] }] } })), /duplicate planned test/u);
});

test('native pending is explicitly skipped by runner evidence rather than counted as executed', () =>
{
    const values = fixture();
    const event = values.evidence.tests[1];
    event.status = 'skipped';
    event.executed = false;
    event.assertions[0].status = 'skipped';
    values.report.testResults[0].assertionResults[1].status = 'pending';
    const result = adaptFrontendVitestSemanticOutcome(bind(values));
    assert.equal(result.outcome.status, 'failed');
    const member = result.outcome.membership;
    assert.deepEqual(member.skippedTestIds, [event.testId]);
    assert.deepEqual(member.blockedTestIds, []);
    assert.equal(member.executedTestIds.includes(event.testId), false);
    assert.deepEqual(member.skippedSuiteIds, member.plannedSuiteIds);
    assert.deepEqual(member.skippedParameterizedTestIds, [event.testId]);
});

test('worker abort preserves passed, partially executed blocked and never started blocked topology', () =>
{
    const values = aborted(fixture());
    const result = adaptFrontendVitestSemanticOutcome(values);
    const member = result.outcome.membership;
    assert.equal(result.outcome.status, 'failed');
    assert.deepEqual(member.passedTestIds, [values.evidence.tests[0].testId]);
    assert.deepEqual(member.blockedTestIds, values.evidence.tests.slice(1).map((event) => event.testId).sort());
    assert.deepEqual(member.executedTestIds, values.evidence.tests.slice(0, 2).map((event) => event.testId).sort());
    assert.deepEqual(member.skippedTestIds, []);
    assert.equal(member.failures[0].failureKind, 'infra.process-signal');
    assert.deepEqual(member.blockedSuiteIds, member.plannedSuiteIds);
    assert.deepEqual(member.executedSuiteIds, member.plannedSuiteIds);
    assert.equal(member.blockedParameterizedTestIds.length, 1);
});

test('blocked pending differs from skipped pending and requires canonical runner abort evidence', () =>
{
    const values = aborted(fixture());
    values.report.testResults[0].assertionResults.push({ status: 'pending' });
    values.evidence.tests[1].nativeRef = { fileIndex: 0, assertionIndex: 1 };
    assert.equal(adaptFrontendVitestSemanticOutcome(bind(values)).outcome.membership.blockedTestIds.length, 2);
    values.evidence.completion = 'complete';
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /blocked needs abort/u);
});

test('missing planned, missing actual, extra and duplicate test members fail closed', () =>
{
    let values = fixture();
    values.manifest.suites[0].tests.pop();
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /planned membership/u);
    values = fixture();
    values.evidence.tests.pop();
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /actual test membership/u);
    values = fixture();
    values.evidence.tests.push({ ...values.evidence.tests[0], testId: 'vitest:orphan#test' });
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /actual test membership/u);
    values = fixture();
    values.evidence.tests.push(values.evidence.tests[0]);
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /duplicate IDs/u);
});

test('duplicate suites, assertions and native bindings fail closed', () =>
{
    let values = fixture();
    values.manifest.suites.push(values.manifest.suites[0]);
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /duplicate or empty suite/u);
    values = fixture();
    values.evidence.tests[0].assertions.push(values.evidence.tests[0].assertions[0]);
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /duplicate IDs/u);
    values = fixture();
    values.evidence.tests[1].nativeRef = values.evidence.tests[0].nativeRef;
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /duplicate native result/u);
});

test('extra or missing native results cannot be hidden by native summary totals', () =>
{
    const extra = fixture();
    extra.report.testResults[0].assertionResults.push({ status: 'passed' });
    extra.report.numTotalTests = 3;
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(extra)), /extra native result/u);
    const missing = fixture();
    missing.evidence.tests[0].nativeRef = null;
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(missing)), /native result missing/u);
});

test('empty extra native suites and missing/duplicate/foreign suite bindings fail closed', () =>
{
    const extra = fixture();
    extra.report.testResults.push({ name: '/foreign/empty.test.ts', assertionResults: [] });
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(extra)), /extra native suite/u);
    const missing = fixture();
    missing.evidence.suiteBindings = [];
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(missing)), /actual suite membership/u);
    const duplicate = fixture();
    duplicate.evidence.suiteBindings.push(duplicate.evidence.suiteBindings[0]);
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(duplicate)), /duplicate IDs/u);
    const foreign = fixture();
    foreign.evidence.suiteBindings[0].suiteId = 'vitest:foreign#suite';
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(foreign)), /actual suite membership/u);
});

test('an entirely aborted suite preserves no native file and no executed suite without inventing results', () =>
{
    const values = aborted(fixture());
    values.report.testResults = [];
    values.evidence.suiteBindings[0].fileIndex = null;
    const first = values.evidence.tests[0];
    first.status = 'blocked';
    first.executed = false;
    first.nativeRef = null;
    first.assertions[0] = { ...values.evidence.tests[2].assertions[0], id: first.assertions[0].id,
        failure: { ...values.evidence.tests[2].assertions[0].failure, identity: { producerId: 'frontend-vitest',
            testId: first.testId, assertionId: first.assertions[0].id, attemptNumber: 1 } } };
    values.evidence.tests[1].executed = false;
    const member = adaptFrontendVitestSemanticOutcome(bind(values)).outcome.membership;
    assert.deepEqual(member.executedSuiteIds, []);
    assert.deepEqual(member.executedTestIds, []);
    assert.deepEqual(member.blockedSuiteIds, member.plannedSuiteIds);
    assert.deepEqual(member.blockedParameterizedTestIds, member.plannedParameterizedTestIds);
});

test('passed/failed/skipped/blocked overlap and unknown status evidence are rejected', () =>
{
    const values = fixture();
    values.evidence.tests[0].status = 'skipped';
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /execution\/status overlap/u);
    values.evidence.tests[0].status = 'not-run';
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /unknown test status/u);
    values.evidence.tests[0].status = 'passed';
    values.evidence.tests[0].assertions[0].status = 'failed';
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /assertion status mismatch/u);
});

test('failure binds producer/test/assertion/taxonomy/raw diagnostic and semantic artifacts', () =>
{
    const values = failure(fixture(), 0);
    values.manifest.artifactIds = ['snapshot:alpha'];
    values.evidence.artifacts = [{ id: 'snapshot:alpha', digest: d('d') }];
    values.evidence.tests[0].assertions[0].failure.semanticArtifactIds = ['snapshot:alpha'];
    const result = adaptFrontendVitestSemanticOutcome(bind(values));
    const record = result.outcome.membership.failures[0];
    assert.equal(record.failureClass, 'product');
    assert.equal(record.failureKind, 'product.assertion');
    assert.equal(record.identity.testId, values.evidence.tests[0].testId);
    assert.equal(record.identity.assertionId, 'assert:alpha');
    assert.deepEqual(record.semanticArtifactIds, ['snapshot:alpha']);
    assert.equal(result.inputAuthorityRefs.at(-1).path, 'diagnostics/failure.json');
});

test('changed error messages and diagnostic bytes do not change canonical failure or semantic payload', () =>
{
    const values = failure(fixture(), 0);
    const first = adaptFrontendVitestSemanticOutcome(bind(values));
    values.report.testResults[0].assertionResults[0].failureMessages = ['network crashed assertion clock'];
    values.evidence.tests[0].assertions[0].failure.diagnosticRef = { path: '/other/failure.json', digest: d('e') };
    const second = adaptFrontendVitestSemanticOutcome(bind(values));
    assert.deepEqual(second.outcome.membership.failures, first.outcome.membership.failures);
    assert.equal(second.outcome.semanticPayloadDigest, first.outcome.semanticPayloadDigest);
    assert.notEqual(second.contentDigest, first.contentDigest);
});

test('message-only classification, unknown kinds and missing/crossed failure identities fail closed', () =>
{
    let values = failure(fixture(), 0, 'product.message-grep');
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /unknown canonical failure/u);
    values = failure(fixture(), 0);
    values.evidence.tests[0].assertions[0].failure = null;
    values.report.testResults[0].assertionResults[0].failureMessages = ['AssertionError'];
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /failure fields mismatch/u);
    values = failure(fixture(), 0);
    values.evidence.tests[0].assertions[0].failure.identity.testId = values.evidence.tests[1].testId;
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /failure identity mismatch/u);
    values = aborted(fixture());
    values.evidence.tests[1].assertions[0].failure.identity.attemptNumber = 2;
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /failure attemptNumber mismatch/u);
});

test('unqualified, retried, recovered or independently mismatched attempts fail closed', () =>
{
    const values = fixture();
    values.attemptEligibility.qualificationEligible = false;
    values.evidence.attemptEligibility = values.attemptEligibility;
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /unqualified attempt/u);
    values.attemptEligibility.qualificationEligible = true;
    values.attemptEligibility.attemptNumber = 2;
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /unqualified attempt/u);
    const crossed = fixture();
    crossed.evidence.attemptEligibility.attemptDigest = d('f');
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(crossed)), /held attempt mismatch|runner attempt mismatch/u);
});

test('cross-run/source/envelope/temporal and config/project/policy evidence fail closed', () =>
{
    const run = fixture();
    run.evidence.identity = { ...run.identity, schedulerRunId: 'another-run' };
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(run)), /bound identity/u);
    const source = fixture();
    source.manifest.identity = { ...source.identity, sourceCommit: 'b'.repeat(40) };
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(source)), /bound identity/u);
    const envelope = fixture();
    envelope.evidence.identity = { ...envelope.identity, executionEnvelopeDigest: d('b'), temporalContextDigest: d('c') };
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(envelope)), /bound identity/u);
    const config = fixture();
    config.evidence.configId = 'config:integration';
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(config)), /bound configId/u);
    config.evidence.configId = config.manifest.configId;
    config.evidence.projectId = 'project:foreign';
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(config)), /bound projectId/u);
    config.evidence.projectId = config.manifest.projectId;
    config.evidence.policyDigests = { 'policy:outcome': d('f') };
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(config)), /bound policyDigests/u);
});

test('held replay plan and command manifest cannot be replaced by resealed current inputs', () =>
{
    const values = fixture();
    values.identity = { ...values.identity, replayPlanDigest: d('f') };
    bind(values);
    assert.throws(() => adaptFrontendVitestSemanticOutcome(values), /identity replay plan/u);
    const held = fixture();
    held.manifest = sealContentDigest({ ...held.manifest, configId: 'config:other' });
    assert.throws(() => adaptFrontendVitestSemanticOutcome(held), /external manifest digest/u);
    const drift = fixture();
    drift.replayPlan.command.args.push('--retry=1');
    assert.throws(() => adaptFrontendVitestSemanticOutcome(drift), /replay.*tamper/u);
});

test('coverage and artifact membership are exact and nonapplicable fields are explicit empty', () =>
{
    const values = fixture();
    const empty = adaptFrontendVitestSemanticOutcome(values).outcome.membership;
    assert.deepEqual(empty.coverageIds, []);
    assert.deepEqual(empty.artifactSemanticDigests, {});
    assert.deepEqual(empty.stateSemanticDigests, {});
    assert.deepEqual(empty.scenarioIds, []);
    assert.deepEqual(empty.projectionReceipts, []);
    assert.deepEqual(empty.redactedSecrets, []);
    values.manifest.coverageIds = ['coverage:branches'];
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /coverage membership/u);
    values.evidence.coverageIds = ['coverage:branches'];
    values.manifest.artifactIds = ['coverage:json'];
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /artifact membership/u);
    values.evidence.artifacts = [{ id: 'coverage:json', digest: d('d') }];
    assert.deepEqual(adaptFrontendVitestSemanticOutcome(bind(values)).outcome.membership.artifactSemanticDigests, { 'coverage:json': d('d') });
});

test('report, runner evidence and candidate outcome tamper fail closed', () =>
{
    const report = fixture();
    report.report.testResults[0].assertionResults[0].status = 'failed';
    assert.throws(() => adaptFrontendVitestSemanticOutcome(report), /native report digest/u);
    const evidence = fixture();
    evidence.evidence.tests[0].status = 'blocked';
    assert.throws(() => adaptFrontendVitestSemanticOutcome(evidence), /evidence content digest/u);
    const result = structuredClone(adaptFrontendVitestSemanticOutcome(fixture()));
    result.outcome.membership.passedTestIds.pop();
    assert.throws(() => validateProducerSemanticOutcomeCandidate(result), /candidate content digest mismatch/u);
});

test('resealed candidate missing/extra/overlapping terminal membership is rejected by held-input verification', () =>
{
    const values = fixture();
    const candidate = adaptFrontendVitestSemanticOutcome(values);
    assert.equal(verifyFrontendVitestSemanticOutcomeCandidate(candidate, values), candidate);
    const mutated = structuredClone(candidate);
    mutated.outcome.membership.blockedTestIds.push(mutated.outcome.membership.passedTestIds[0]);
    mutated.outcome.semanticPayloadDigest = digestCanonical(mutated.outcome.membership);
    assert.throws(() => verifyFrontendVitestSemanticOutcomeCandidate(sealContentDigest(mutated), values), /candidate exact bound outcome/u);
});

test('native process failures, partial evidence and native status disagreements cannot produce success', () =>
{
    const values = fixture();
    values.report.numRuntimeErrorTestSuites = 1;
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(values)), /native process failure/u);
    const partial = fixture();
    partial.evidence.completion = 'aborted';
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(partial)), /abort topology incomplete/u);
    const mismatch = fixture();
    mismatch.report.testResults[0].assertionResults[0].status = 'failed';
    assert.throws(() => adaptFrontendVitestSemanticOutcome(bind(mismatch)), /native\/runner status mismatch/u);
});

test('missing independent held inputs, unsafe JSON and host budget expansion are rejected', () =>
{
    const missing = fixture();
    delete missing.expectedInputs;
    assert.throws(() => adaptFrontendVitestSemanticOutcome(missing), /independent expected inputs/u);
    const unsafe = fixture();
    let invoked = false;
    Object.defineProperty(unsafe.report, 'extra', { enumerable: true, get()
    {
        invoked = true;
        return 'bad';
    } });
    assert.throws(() => adaptFrontendVitestSemanticOutcome(unsafe), /accessor input/u);
    assert.equal(invoked, false);
    const budget = fixture();
    budget.expectedInputs.hostExpectedLimits.maxNodes = 10;
    assert.throws(() => adaptFrontendVitestSemanticOutcome(budget), /budget exceeded/u);
});
