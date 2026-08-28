import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptReleaseFinalizerSemanticOutcome } from '../../tools/test-matrix/outcomes/release-finalizer-adapter.mjs';

const d = (digit) => `sha256:${digit.repeat(64)}`;
const identity = { buildIdentity: d('1'), executionEnvelopeDigest: d('2'), producerId: 'release-finalizer-semantic-outcome', replayPlanDigest: d('3'), schedulerRunId: 'finalizer-run', sourceCommit: '4'.repeat(40), temporalContextDigest: d('5'), toolchainDigest: d('6'), worktreeFingerprint: d('7') };
const inputAuthorityRefs = [{ kind: 'finalizer-contract', path: 'contract.json', digest: d('8') }];
const attemptEligibility = { aggregateDigest: d('9'), attemptDigest: d('a'), attemptNumber: 1, cleanFirstAttempt: true, firstFailure: false, qualificationEligible: true };
const plan = { inputIds: ['browser', 'production'], outputIds: ['release-binding'] };
const evidence = { consumedIds: ['browser', 'production'], verifiedIds: ['browser', 'production'], failedIds: [], blockedIds: [], producedOutputIds: ['release-binding'], outputDigests: { 'release-binding': d('b') }, finalExitCode: 0, summary: { status: 'success' } };
const adapt = (overrides = {}) => adaptReleaseFinalizerSemanticOutcome({ identity, inputAuthorityRefs, attemptEligibility, plan, evidence, ...overrides });

test('finalizer adapter requires exact verified input and output membership', () =>
{
    assert.equal(adapt().outcome.status, 'success');
    assert.equal(adapt({ evidence: { ...evidence, consumedIds: ['browser'] } }).outcome.status, 'failed');
    assert.equal(adapt({ evidence: { ...evidence, producedOutputIds: [] } }).outcome.status, 'failed');
    assert.equal(adapt({ evidence: { ...evidence, producedOutputIds: ['release-binding', 'orphan'] } }).outcome.status, 'failed');
});

test('upstream failure remains failed even when finalizer exit and summary say success', () =>
{
    const result = adapt({ evidence: { ...evidence, verifiedIds: ['browser'], failedIds: ['production'], finalExitCode: 0, summary: { status: 'success' } } });
    assert.equal(result.outcome.status, 'failed');
    assert.equal(result.outcome.reasons[0].kind, 'product.state-mismatch');
});

test('finalizer metadata is excluded but semantic output digest and clean attempt remain binding', () =>
{
    const first = adapt();
    const metadata = adapt({ evidence: { ...evidence, finalExitCode: 9, summary: { status: 'failed' }, path: '/other', mtimeMs: 9 } });
    assert.equal(first.outcome.semanticPayloadDigest, metadata.outcome.semanticPayloadDigest);
    const changed = adapt({ evidence: { ...evidence, outputDigests: { 'release-binding': d('0') } } });
    assert.notEqual(first.outcome.semanticPayloadDigest, changed.outcome.semanticPayloadDigest);
    assert.equal(adapt({ attemptEligibility: { ...attemptEligibility, cleanFirstAttempt: false, qualificationEligible: false, firstFailure: true } }).outcome.status, 'failed');
});
