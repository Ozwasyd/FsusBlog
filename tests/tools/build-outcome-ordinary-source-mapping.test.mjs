import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { runProducerAttempts } = await import(new URL('../../tools/test/attempt-runner.mjs', import.meta.url));
const { verifyFileDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { adaptImmutableBuildSemanticOutcome, mapImmutableBuildNativeAttemptOutcome, immutableBuildOutcomeProducerId } = await import(new URL('../../tools/test-matrix/outcomes/immutable-build-adapter.mjs', import.meta.url));
const { adaptReleaseProjectionSemanticOutcome, mapReleaseProjectionNativeAttemptOutcome } = await import(new URL('../../tools/test-matrix/outcomes/release-projection-adapter.mjs', import.meta.url));
const { adaptReleaseFinalizerSemanticOutcome, mapVerifiedReleaseFinalizerConsumedInputs, mapReleaseFinalizerNativeAttemptOutcome } = await import(new URL('../../tools/test-matrix/outcomes/release-finalizer-adapter.mjs', import.meta.url));
const { NativeOutcomeSourceError, nativeSourceError } = await import(new URL('../../tools/test-matrix/outcomes/adapter-support.mjs', import.meta.url));
const { parseMatrix } = await import(new URL('../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
const digest = (value) => `sha256:${value.repeat(64)}`;
const identity = { sourceCommit: 'a'.repeat(40), worktreeFingerprint: digest('b'),
    schedulerRunId: 'ordinary-source-control', executionEnvelopeDigest: digest('c'),
    replayPlanDigest: digest('d'), temporalContextDigest: digest('e') };

async function ordinaryAttempt(context, scenario)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ordinary-outcome-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const producerId = 'ordinary-build-producer';
    // Controlled external authorities are fixtures, not native custody proof.
    const references = [['execution-envelope', 'c'], ['replay-plan', 'd'], ['temporal-context', 'e']]
        .map(([kind, value]) => ({ kind, artifactPath: `${kind}.json`, artifactDigest: digest(value),
            verificationReceiptPath: `${kind}.verified.json`, verificationReceiptDigest: digest(value) }));
    const verifyAuthority = (reference) => ({ verified: true, authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: { sourceCommit: identity.sourceCommit, worktreeFingerprint: identity.worktreeFingerprint,
            schedulerRunId: identity.schedulerRunId, producerId } });
    const source = `const fs = require('node:fs');
const scenario = process.argv[1];
fs.writeFileSync(process.env.FSUSBLOG_ATTEMPT_RESULT_PATH, JSON.stringify({
    schema: 'fsusblog.test-attempt-result.v1',
    failureClass: scenario === 'product' ? 'product' : null,
    failureKind: scenario === 'product' ? 'assertion-mismatch' : null,
    failedTestIds: scenario === 'product' ? ['ordinary:build-assertion'] : [],
    executedTestIds: ['ordinary:build-assertion'], artifactPaths: []
}));
if (scenario === 'product') process.exitCode = 1;
if (scenario === 'signal') process.kill(process.pid, 'SIGTERM');
if (scenario === 'timeout') setInterval(() => {}, 1000);
`;
    const result = await runProducerAttempts({ evidenceRoot: directory, producerId,
        retryPolicyId: 'correctness-first-attempt', sourceCommit: identity.sourceCommit,
        worktreeFingerprint: identity.worktreeFingerprint, schedulerRunId: identity.schedulerRunId,
        command: scenario === 'launch' ? [path.join(directory, 'unavailable-executable')]
            : [process.execPath, '-e', source, scenario], cwd: root, env: {},
        authorityReferences: references, verifyAuthority, expectedTestIds: ['ordinary:build-assertion'],
        timeoutMs: scenario === 'timeout' ? 200 : 5000 });
    const [attempt] = result.attempts;
    return { attempt, expectedAttemptDigest: attempt.contentDigest,
        expectedNativeProducerId: producerId, expectedIdentity: identity, verifyAuthority,
        verifyArtifact: (relative, expected) => verifyFileDigest(path.join(result.producerRoot, 'attempt-1'), relative, expected) };
}

test('ordinary executed product failure maps its original assertion IDs for all three adapters', async (context) =>
{
    const observed = await ordinaryAttempt(context, 'product');
    for (const map of [mapImmutableBuildNativeAttemptOutcome, mapReleaseProjectionNativeAttemptOutcome,
        mapReleaseFinalizerNativeAttemptOutcome])
    {
        const outcome = map(observed);
        assert.equal(outcome.nativeProducerId, observed.attempt.producerId);
        assert.equal(outcome.nativeAttemptDigest, observed.attempt.contentDigest);
        assert.equal(outcome.nativeStatus, 'failed-no-retry');
        assert.equal(outcome.reasons[0].kind, 'product.assertion');
        assert.equal(outcome.reasons[0].identity.assertionId, 'ordinary:build-assertion');
    }
});

test('ordinary executed process signal maps the runner structured kind', async (context) =>
{
    const observed = await ordinaryAttempt(context, 'signal');
    assert.equal(observed.attempt.failureKind, 'command-signal');
    const outcome = mapImmutableBuildNativeAttemptOutcome(observed);
    assert.equal(outcome.reasons[0].kind, 'infra.process-signal');
    assert.equal(outcome.reasons[0].identity.attemptNumber, 1);
});

test('ordinary unavailable executable maps the original launch failure observation', async (context) =>
{
    const observed = await ordinaryAttempt(context, 'launch');
    assert.equal(observed.attempt.failureKind, 'command-spawn-error');
    const outcome = mapImmutableBuildNativeAttemptOutcome(observed);
    assert.equal(outcome.reasons[0].kind, 'infra.process-launch');
    assert.equal(outcome.reasons[0].identity.attemptNumber, 1);
});

test('ordinary clean process mapping is only an observation with no qualification verdict', async (context) =>
{
    const outcome = mapImmutableBuildNativeAttemptOutcome(await ordinaryAttempt(context, 'success'));
    assert.equal(outcome.nativeStatus, 'clean-success');
    assert.deepEqual(outcome.reasons, []);
    assert.equal(Object.hasOwn(outcome, 'qualificationEligible'), false);
});

test('ordinary timeout retains the explicit missing canonical taxonomy mapping', async (context) =>
{
    const observed = await ordinaryAttempt(context, 'timeout');
    assert.equal(observed.attempt.failureKind, 'runner-timeout');
    const outcome = mapReleaseFinalizerNativeAttemptOutcome(observed);
    assert.equal(outcome.reasons[0].kind, 'contract.missing-evidence');
    assert.equal(outcome.reasons[0].identity.evidenceId, 'typed-native-failure');
});

test('ordinary original owner failure codes map independently of diagnostic error text', () =>
{
    const source = Object.assign(new Error('original owner diagnostic'), { reasonCode: 'PLAN_IDENTITY_MISMATCH' });
    const mapped = nativeSourceError(immutableBuildOutcomeProducerId, 'native-plan', source);
    assert.ok(mapped instanceof NativeOutcomeSourceError);
    assert.equal(mapped.nativeReasonCode, source.reasonCode);
    assert.equal(mapped.cause, source);
    assert.equal(mapped.reasons[0].kind, 'contract.identity');
    assert.equal(mapped.reasons[0].identity.identityField, 'nativePlanIdentity');
});

test('ordinary consumed binding shape maps actual catalog tier associations and preserves unpublished status', async () =>
{
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/required-evidence-authority-ledger.json'), 'utf8'));
    const canonical = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/test-matrix/release-final-evidence-inputs.json'), 'utf8'));
    // This is a compatibility fixture for the supplied #2061 API result shape.
    // It exercises no native verifier, receipt publication or scheduler authority.
    const binding = { schema: 'fsusblog.release-final-test-evidence-binding.v2',
        status: 'verified-bindings-unpublished', qualificationEligible: false, reasonCodes: [],
        publicationRequired: 'canonical-scheduler-CAS', context: identity, contentDigest: digest('1'),
        authorities: catalog.entries.map((entry) => ({ authorityId: entry.authorityId,
            producerId: entry.canonicalOwner, outputBindingKey: entry.outputBindingKey,
            verifiedBinding: { receipt: { schema: entry.receiptSchema,
                ref: `controlled/${entry.authorityId}.json`, contentDigest: digest('2') } } })) };
    const verificationOptions = { testPlan: { requiredEvidenceDependencies: { dependencies: catalog.entries } } };
    let calls = 0;
    const mapped = await mapVerifiedReleaseFinalizerConsumedInputs({ matrix, binding, verificationOptions,
        expectedIdentity: identity, verifyBindings: async (observed, options) =>
        {
            calls++;
            assert.deepEqual(observed, binding);
            assert.deepEqual(options, verificationOptions);
            return structuredClone(binding);
        } });
    assert.equal(calls, 1);
    assert.deepEqual(mapped.plan.inputIds, canonical.inputs);
    assert.deepEqual(mapped.evidence.consumedIds, canonical.inputs);
    assert.deepEqual(mapped.evidence.verifiedIds, canonical.inputs);
    assert.equal(mapped.evidence.consumedInputReceipts.length, 22);
    assert.equal(mapped.inputAuthorityRefs.length, 22);
    assert.deepEqual(mapped.evidence.producedOutputIds, []);
    assert.deepEqual(mapped.evidence.outputDigests, {});
    assert.equal(mapped.nativeObservation.qualificationEligible, false);
    assert.equal(mapped.nativeObservation.status, 'verified-bindings-unpublished');
});

test('ordinary missing original finalizer inputs expose canonical source failure without a produced output', async () =>
{
    await assert.rejects(mapVerifiedReleaseFinalizerConsumedInputs({
        matrix: {}, binding: {}, verificationOptions: {}, expectedIdentity: identity,
        verifyBindings: async () =>
        {
            throw Object.assign(new Error('inputs unavailable'), { reasonCode: 'MISSING_BINDINGS' });
        }
    }), (error) => error instanceof NativeOutcomeSourceError
        && error.nativeReasonCode === 'MISSING_BINDINGS'
        && error.reasons[0].kind === 'contract.missing-evidence');
});


test('ordinary adapter composition preserves mapped native product failures', async (context) =>
{
    const observed = await ordinaryAttempt(context, 'product');
    for (const [producerId, adapt, map, plan, evidence] of [
        ['immutable-build-semantic-outcome', adaptImmutableBuildSemanticOutcome,
            mapImmutableBuildNativeAttemptOutcome, { artifactIds: [], verificationAssertionIds: [] }, {}],
        ['release-projection-semantic-outcome', adaptReleaseProjectionSemanticOutcome,
            mapReleaseProjectionNativeAttemptOutcome, { projectionIds: [] }, {}],
        ['release-finalizer-semantic-outcome', adaptReleaseFinalizerSemanticOutcome,
            mapReleaseFinalizerNativeAttemptOutcome, { inputIds: [], outputIds: [] }, {}]
    ])
    {
        const native = map(observed);
        const result = adapt({ identity: { ...identity, producerId, buildIdentity: digest('3'),
            toolchainDigest: digest('4') },
        inputAuthorityRefs: [{ kind: 'controlled-source', path: 'controlled.json', digest: digest('5') }],
        attemptEligibility: { aggregateDigest: digest('6'), attemptDigest: observed.attempt.contentDigest,
            attemptNumber: 1, cleanFirstAttempt: false, firstFailure: true, qualificationEligible: false },
        plan, evidence: { ...evidence, nativeFailures: native.reasons } });
        assert.equal(result.outcome.status, 'failed');
        assert.ok(result.outcome.reasons.some((failure) => failure.kind === 'product.assertion'
            && failure.identity.assertionId === 'ordinary:build-assertion'));
    }
});
