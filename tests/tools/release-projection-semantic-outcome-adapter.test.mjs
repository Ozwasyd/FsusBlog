import assert from 'node:assert/strict';
import test from 'node:test';

import { heldBuildOutcomeInputs } from './support/build-outcome-held-input-fixture.mjs';

const { adaptReleaseProjectionSemanticOutcome } = await import(new URL('../../tools/test-matrix/outcomes/release-projection-adapter.mjs', import.meta.url));
const d = (digit) => `sha256:${digit.repeat(64)}`;
const identity = { buildIdentity: d('1'), executionEnvelopeDigest: d('2'), producerId: 'release-projection-semantic-outcome', replayPlanDigest: d('3'), schedulerRunId: 'projection-run', sourceCommit: '4'.repeat(40), temporalContextDigest: d('5'), toolchainDigest: d('6'), worktreeFingerprint: d('7') };
const inputAuthorityRefs = [{ kind: 'projection-plan', path: 'plan.json', digest: d('8') }];
const attemptEligibility = { aggregateDigest: d('9'), attemptDigest: d('a'), attemptNumber: 1, cleanFirstAttempt: true, firstFailure: false, qualificationEligible: true };
const plan = { projectionIds: ['auth', 'authoring'] };
const evidence = { producedIds: ['auth', 'authoring'], verifiedIds: ['auth', 'authoring'], failedIds: [], blockedIds: [], semanticDigests: { auth: d('b'), authoring: d('c') }, path: '/tmp/latest', mtimeMs: 1, jobStatus: 'success' };
const adapt = (overrides = {}) =>
{
    const inputs = { identity, inputAuthorityRefs, attemptEligibility, plan, evidence, ...overrides };
    return adaptReleaseProjectionSemanticOutcome({ ...inputs, verifyInputs: heldBuildOutcomeInputs(inputs), ...overrides });
};

test('projection adapter requires exact produced, verified and terminal membership', () =>
{
    assert.equal(adapt().outcome.status, 'success');
    assert.equal(adapt({ evidence: { ...evidence, producedIds: ['auth'], verifiedIds: ['auth'] } }).outcome.status, 'failed');
    assert.equal(adapt({ evidence: { ...evidence, producedIds: [...evidence.producedIds, 'orphan'] } }).outcome.status, 'failed');
    assert.equal(adapt({ evidence: { ...evidence, verifiedIds: ['auth'], blockedIds: ['authoring'] } }).outcome.status, 'failed');
    assert.throws(() => adapt({ evidence: { ...evidence, producedIds: ['auth', 'auth'] } }), /duplicate/u);
});

test('projection semantic changes are visible while path, mtime, job and log are excluded', () =>
{
    const first = adapt();
    const metadata = adapt({ evidence: { ...evidence, path: '/other', mtimeMs: 9, jobStatus: 'failed', log: 'different' } });
    assert.equal(first.outcome.semanticPayloadDigest, metadata.outcome.semanticPayloadDigest);
    const changed = adapt({ evidence: { ...evidence, semanticDigests: { ...evidence.semanticDigests, auth: d('0') } } });
    assert.notEqual(first.outcome.semanticPayloadDigest, changed.outcome.semanticPayloadDigest);
});

test('unqualified attempts and missing semantic digests cannot become projection success', () =>
{
    assert.equal(adapt({ attemptEligibility: { ...attemptEligibility, cleanFirstAttempt: false, qualificationEligible: false, firstFailure: true } }).outcome.status, 'failed');
    assert.equal(adapt({ evidence: { ...evidence, semanticDigests: {} } }).outcome.status, 'failed');
});

test('orphan terminal projection IDs and semantic digests fail closed', () =>
{
    assert.equal(adapt({ evidence: { ...evidence,
        verifiedIds: [...evidence.verifiedIds, 'orphan'],
        semanticDigests: { ...evidence.semanticDigests, orphan: d('d') } } }).outcome.status, 'failed');
    assert.equal(adapt({ evidence: { ...evidence,
        semanticDigests: { ...evidence.semanticDigests, orphan: d('d') } } }).outcome.status, 'failed');
});

test('projection terminal states must be disjoint and refer to produced IDs', () =>
{
    const overlap = adapt({ evidence: { ...evidence, failedIds: ['auth'] } });
    assert.equal(overlap.outcome.status, 'failed');
    assert.ok(overlap.outcome.reasons.some((item) => item.kind === 'contract.ambiguous-evidence'));
    assert.equal(adapt({ evidence: { ...evidence, producedIds: ['auth'] } }).outcome.status, 'failed');
});
