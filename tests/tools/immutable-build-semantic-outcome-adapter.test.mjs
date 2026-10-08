import assert from 'node:assert/strict';
import test from 'node:test';

const { adaptImmutableBuildSemanticOutcome } = await import(new URL('../../tools/test-matrix/outcomes/immutable-build-adapter.mjs', import.meta.url));
const d = (digit) => `sha256:${digit.repeat(64)}`;
const identity = { buildIdentity: d('1'), executionEnvelopeDigest: d('2'), producerId: 'immutable-build-semantic-outcome',
    replayPlanDigest: d('3'), schedulerRunId: 'build-run', sourceCommit: '4'.repeat(40), temporalContextDigest: d('5'),
    toolchainDigest: d('6'), worktreeFingerprint: d('7') };
const inputAuthorityRefs = [{ kind: 'build-plan', path: 'plan.json', digest: d('8') }];
const attemptEligibility = { aggregateDigest: d('9'), attemptDigest: d('a'), attemptNumber: 1,
    cleanFirstAttempt: true, firstFailure: false, qualificationEligible: true };
const plan = { artifactIds: ['frontend-static', 'server-image'], verificationAssertionIds: ['manifest'] };
const artifact = (id, digit) => ({ id, contentDigest: d(digit), manifestDigest: d('b'),
    provenanceDigest: d('c'), imageDigest: id === 'server-image' ? d('d') : null, verified: true,
    path: `/tmp/${id}`, mtimeMs: 1 });
const evidence = { artifacts: [artifact('frontend-static', 'e'), artifact('server-image', 'f')],
    verificationAssertions: [{ id: 'manifest', status: 'passed' }] };
const adapt = (overrides = {}) => adaptImmutableBuildSemanticOutcome({
    identity, inputAuthorityRefs, attemptEligibility, plan, evidence, ...overrides
});

test('immutable build adapter verifies exact planned artifacts and semantic digests', () =>
{
    const result = adapt();
    assert.equal(result.outcome.status, 'success');
    assert.deepEqual(result.outcome.membership.verifiedArtifactIds, plan.artifactIds);
});

test('missing, extra, duplicate, digest mismatch and recovered build fail closed', () =>
{
    assert.equal(adapt({ evidence: { ...evidence, artifacts: evidence.artifacts.slice(1) } }).outcome.status, 'failed');
    assert.equal(adapt({ evidence: { ...evidence, artifacts: [...evidence.artifacts, artifact('orphan', '0')] } }).outcome.status, 'failed');
    assert.equal(adapt({ evidence: { ...evidence, artifacts: [...evidence.artifacts, evidence.artifacts[0]] } }).outcome.status, 'failed');
    assert.equal(adapt({ evidence: { ...evidence, artifacts: [{ ...evidence.artifacts[0], contentDigest: 'bad' }, evidence.artifacts[1]] } }).outcome.status, 'failed');
    assert.equal(adapt({ attemptEligibility: { ...attemptEligibility, cleanFirstAttempt: false,
        qualificationEligible: false, firstFailure: true } }).outcome.status, 'failed');
});

test('path and mtime are diagnostic while semantic content changes remain visible', () =>
{
    const first = adapt();
    const relocated = adapt({ evidence: { ...evidence, artifacts: evidence.artifacts.map((item) => ({
        ...item, path: `/other/${item.id}`, mtimeMs: 999
    })) } });
    assert.equal(first.outcome.semanticPayloadDigest, relocated.outcome.semanticPayloadDigest);
    const changed = adapt({ evidence: { ...evidence, artifacts: [{ ...evidence.artifacts[0], contentDigest: d('0') }, evidence.artifacts[1]] } });
    assert.notEqual(first.outcome.semanticPayloadDigest, changed.outcome.semanticPayloadDigest);
});

test('exit status and file existence cannot replace verification assertions', () =>
{
    const result = adapt({ evidence: { artifacts: evidence.artifacts, verificationAssertions: [], exitCode: 0, fileExists: true } });
    assert.equal(result.outcome.status, 'failed');
    assert.deepEqual(result.outcome.membership.verificationAssertionIds, []);
});

test('duplicate verification assertions cannot satisfy exact build membership', () =>
{
    const result = adapt({ evidence: { ...evidence,
        verificationAssertions: [...evidence.verificationAssertions, evidence.verificationAssertions[0]] } });
    assert.equal(result.outcome.status, 'failed');
    assert.equal(result.outcome.reasons[0].kind, 'contract.ambiguous-evidence');
});
