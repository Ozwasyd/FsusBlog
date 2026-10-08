import assert from 'node:assert/strict';
import test from 'node:test';

import { heldBuildOutcomeInputs } from './support/build-outcome-held-input-fixture.mjs';

const { adaptReleaseProjectionSemanticOutcome: adaptReleaseProjectionSemanticOutcomeSource } = await import(new URL('../../tools/test-matrix/outcomes/release-projection-adapter.mjs', import.meta.url));
const { adaptImmutableBuildSemanticOutcome: adaptImmutableBuildSemanticOutcomeSource } = await import(new URL('../../tools/test-matrix/outcomes/immutable-build-adapter.mjs', import.meta.url));
const { adaptReleaseFinalizerSemanticOutcome: adaptReleaseFinalizerSemanticOutcomeSource } = await import(new URL('../../tools/test-matrix/outcomes/release-finalizer-adapter.mjs', import.meta.url));
const { validateOutcomeFieldDispositions } = await import(new URL('../../tools/test-matrix/outcomes/outcome-contract.mjs', import.meta.url));
const { analyzeProducerSemanticOutcomeCandidate: analyzeCandidateWithLimits, sealVerifiedProducerSemanticOutcome } = await import(new URL('../../tools/test-matrix/outcomes/producer-outcome-analysis.mjs', import.meta.url));
const { sealContentDigest, digestCanonical } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));


// These detached held-input fixtures exercise the adapter host contract only.
// They are not producer verification receipts or qualification authority.
const adaptReleaseProjectionSemanticOutcome = (input) => adaptReleaseProjectionSemanticOutcomeSource({
    ...input, verifyInputs: heldBuildOutcomeInputs(input)
});
const adaptImmutableBuildSemanticOutcome = (input) => adaptImmutableBuildSemanticOutcomeSource({
    ...input, verifyInputs: heldBuildOutcomeInputs(input)
});
const adaptReleaseFinalizerSemanticOutcome = (input) => adaptReleaseFinalizerSemanticOutcomeSource({
    ...input, verifyInputs: heldBuildOutcomeInputs(input)
});

const digest = (digit) => `sha256:${digit.repeat(64)}`;
const identity = Object.freeze({ buildIdentity: digest('1'), executionEnvelopeDigest: digest('2'),
    producerId: 'release-projection-semantic-outcome', replayPlanDigest: digest('3'),
    schedulerRunId: 'fixture-run', sourceCommit: '4'.repeat(40), temporalContextDigest: digest('5'),
    toolchainDigest: digest('6'), worktreeFingerprint: digest('7') });

const hostExpectedLimits = Object.freeze({ maxDepth: 32, maxNodes: 4096,
    maxStringBytes: 131072, maxArrayItems: 256, maxObjectKeys: 128 });

// The original controls receive an explicit host fixture budget, not payload defaults.
function analyzeProducerSemanticOutcomeCandidate(candidate, options)
{
    return analyzeCandidateWithLimits(candidate, { ...options, hostExpectedLimits });
}

function fixture(ids = ['a', 'b'])
{
    return adaptReleaseProjectionSemanticOutcome({ identity,
        inputAuthorityRefs: [{ kind: 'projection', path: 'fixtures/projection.json', digest: digest('8') }],
        attemptEligibility: { aggregateDigest: digest('9'), attemptDigest: digest('a'),
            attemptNumber: 1, cleanFirstAttempt: true, firstFailure: false, qualificationEligible: true },
        plan: { projectionIds: ids }, evidence: { producedIds: ids, verifiedIds: ids,
            failedIds: [], blockedIds: [], semanticDigests: Object.fromEntries(ids.map((id) => [id, digest('b')])) } });
}

function analyze(candidate = fixture(), metadata = {}, expectedIdentity = identity)
{
    return analyzeProducerSemanticOutcomeCandidate(candidate, { expectedIdentity,
        expectedProducerId: identity.producerId,
        expectedAuthorityId: 'tools/test-matrix/outcomes/release-projection-adapter.mjs', metadata });
}

function reseal(candidate, membership)
{
    return sealContentDigest({ ...candidate, outcome: { ...candidate.outcome,
        membership, semanticPayloadDigest: digestCanonical(membership) } });
}

test('original adapter candidate produces immutable versioned data-only analysis, not authority', () =>
{
    const analysis = analyze();
    assert.equal(analysis.dataOnly, true);
    assert.equal(analysis.producerVerificationPending, true);
    assert.equal(analysis.version.registryVersion, '2');
    assert.equal(Object.isFrozen(analysis.summary.membership), true);
    assert.throws(() => sealVerifiedProducerSemanticOutcome(analysis), /independent authority bridge/u);
});

test('registered volatile and diagnostic metadata cannot change the semantic fingerprint', () =>
{
    const first = analyze(fixture(), { generatedAt: 'first', durationMs: 1, pid: 2, port: 3,
        path: '/run/one/log', errorText: 'first text', stack: 'line one' });
    const second = analyze(fixture(), { generatedAt: 'second', durationMs: 10, pid: 20, port: 30,
        path: '/run/two/log', errorText: 'second text', stack: 'line two' });
    assert.notDeepEqual(first.metadata, second.metadata);
    assert.equal(first.outcomeFingerprint, second.outcomeFingerprint);
});

test('semantic ID array ordering is normalized without sorting away membership changes', () =>
{
    const original = fixture();
    const membership = { ...original.outcome.membership, requiredProjectionIds: ['b', 'a'],
        producedProjectionIds: ['b', 'a'], verifiedProjectionIds: ['b', 'a'] };
    assert.equal(analyze(original).outcomeFingerprint, analyze(reseal(original, membership)).outcomeFingerprint);
    assert.notEqual(analyze(fixture(['a'])).outcomeFingerprint, analyze(original).outcomeFingerprint);
});

test('nested unknown fields remain rejected even after the complete candidate is resealed', () =>
{
    const original = fixture();
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership, unknownState: 'ignored' })), /unknown field/u);
    assert.throws(() => analyze(original, { newMetadata: 1 }), /unknown field/u);
});

test('duplicate and unplanned IDs fail closed after resealing', () =>
{
    const original = fixture();
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        producedProjectionIds: ['a', 'a', 'b'] })), /duplicate/u);
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        producedProjectionIds: ['a', 'b', 'c'] })), /extra or unplanned/u);
});

test('success cannot launder missing passed membership or overlapping terminal sets', () =>
{
    const original = fixture();
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        verifiedProjectionIds: ['a'], semanticDigests: { a: digest('b') } })), /incomplete/u);
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        failedProjectionIds: ['a'] })), /overlap/u);
});

test('declared artifact digests affect the fingerprint and undeclared map members are rejected', () =>
{
    const original = fixture();
    const changed = reseal(original, { ...original.outcome.membership,
        semanticDigests: { a: digest('c'), b: digest('b') } });
    assert.notEqual(analyze(original).outcomeFingerprint, analyze(changed).outcomeFingerprint);
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        semanticDigests: { a: digest('b'), b: digest('b'), extra: digest('c') } })), /digest map/u);
});

test('candidate and adapter membership digest tamper are independently rejected', () =>
{
    const original = fixture();
    assert.throws(() => analyze({ ...original, contentDigest: digest('c') }), /digest mismatch/u);
    assert.throws(() => analyze(sealContentDigest({ ...original,
        outcome: { ...original.outcome, semanticPayloadDigest: digest('c') } })), /membership digest/u);
});

test('the expected original identity must be supplied independently of the candidate', () =>
{
    assert.throws(() => analyze(fixture(), {}, { ...identity, schedulerRunId: 'other-run' }), /cross-run/u);
    assert.throws(() => analyzeProducerSemanticOutcomeCandidate(fixture(), {}), /external expected/u);
    assert.throws(() => analyzeProducerSemanticOutcomeCandidate(fixture(), { expectedIdentity: identity,
        expectedProducerId: identity.producerId, expectedAuthorityId: 'other-authority' }), /authority/u);
});

test('input reference seals are retained for diagnostics, not raw receipt hashing', () =>
{
    const original = fixture();
    const changed = sealContentDigest({ ...original, inputAuthorityRefs: [
        { kind: 'projection', path: 'fixtures/second.json', digest: digest('c') }] });
    assert.notDeepEqual(analyze(original).inputAuthorityRefs, analyze(changed).inputAuthorityRefs);
    assert.equal(analyze(original).outcomeFingerprint, analyze(changed).outcomeFingerprint);
    assert.throws(() => analyze(sealContentDigest({ ...original, inputAuthorityRefs: [
        { kind: 'projection', path: '../outside.json', digest: digest('8') }] })), /repository-relative/u);
});

test('redacted secret fields cannot self-certify the missing semantic-context authority', () =>
{
    assert.throws(() => analyze(fixture(), { secretContext: 'cleartext' }), /plain object/u);
    assert.throws(() => analyze(fixture(), { secretContext: { present: false, type: 'string', digest: null } }), /semantic-context authority/u);
    assert.throws(() => analyze(fixture(), { secretContext: { present: true, type: 'string', digest: digest('c') } }), /semantic-context authority/u);
    assert.throws(() => analyze(fixture(), { secretContext: { present: false, type: 'string', digest: digest('c') } }), /presence/u);
});

test('canonical failure identity changes the fingerprint while message diagnostics do not', () =>
{
    const original = fixture();
    const failed = (kind, identityField) => sealContentDigest({ ...original,
        outcome: { ...original.outcome, status: 'failed', requiredMembershipVerified: false,
            reasons: [{ kind, producerId: identity.producerId,
                identity: { producerId: identity.producerId, ...identityField } }] } });
    const state = failed('product.state-mismatch', { semanticId: 'a' });
    const assertion = failed('product.assertion', { assertionId: 'a' });
    assert.notEqual(analyze(state).outcomeFingerprint, analyze(assertion).outcomeFingerprint);
    assert.equal(analyze(state, { errorText: 'first message' }).outcomeFingerprint,
        analyze(state, { errorText: 'new message' }).outcomeFingerprint);
});

test('nonfinite diagnostic numbers and unknown nested reason fields are rejected', () =>
{
    assert.throws(() => analyze(fixture(), { durationMs: Infinity }), /finite/u);
    const original = fixture();
    assert.throws(() => analyze(sealContentDigest({ ...original, outcome: { ...original.outcome,
        status: 'failed', requiredMembershipVerified: false,
        reasons: [{ kind: 'product.assertion', producerId: identity.producerId,
            identity: { producerId: identity.producerId, assertionId: 'a', message: 'hidden' } }] } })), /fields/u);
});

test('old or unknown candidate versions and unregistered producer families cannot be analyzed', () =>
{
    assert.throws(() => analyze(sealContentDigest({ ...fixture(), schemaVersion: '2' })), /schema/u);
    assert.throws(() => analyzeProducerSemanticOutcomeCandidate(sealContentDigest({ ...fixture(),
        producerId: 'unregistered', identity: { ...identity, producerId: 'unregistered' } }), {
        expectedIdentity: { ...identity, producerId: 'unregistered' }, expectedProducerId: 'unregistered',
        expectedAuthorityId: 'tools/test-matrix/outcomes/release-projection-adapter.mjs' }), /unregistered/u);
});

test('actual immutable-build adapter retains all four artifact digest dimensions and assertion membership', () =>
{
    const producerId = 'immutable-build-semantic-outcome';
    const input = { ...identity, producerId };
    const base = fixture();
    const candidate = adaptImmutableBuildSemanticOutcome({ identity: input,
        inputAuthorityRefs: base.inputAuthorityRefs, attemptEligibility: base.attemptEligibility,
        plan: { artifactIds: ['build'], verificationAssertionIds: ['assertion'] },
        evidence: { artifacts: [{ id: 'build', verified: true, contentDigest: digest('a'),
            manifestDigest: digest('b'), provenanceDigest: digest('c'), imageDigest: null }],
        verificationAssertions: [{ id: 'assertion', status: 'passed' }] } });
    const result = analyzeProducerSemanticOutcomeCandidate(candidate, { expectedIdentity: input,
        expectedProducerId: producerId, expectedAuthorityId: 'tools/test-matrix/outcomes/immutable-build-adapter.mjs' });
    assert.equal(result.summary.membership.artifactSemanticDigests.build.imageDigest, null);
    assert.deepEqual(result.summary.membership.verificationAssertionIds, ['assertion']);
    assert.equal(result.producerVerificationPending, true);
});

test('actual finalizer adapter cannot omit a verified required input under a resealed success', () =>
{
    const producerId = 'release-finalizer-semantic-outcome';
    const input = { ...identity, producerId };
    const base = fixture();
    const candidate = adaptReleaseFinalizerSemanticOutcome({ identity: input,
        inputAuthorityRefs: base.inputAuthorityRefs, attemptEligibility: base.attemptEligibility,
        plan: { inputIds: ['input'], outputIds: ['output'] },
        evidence: { consumedIds: ['input'], verifiedIds: ['input'], failedIds: [], blockedIds: [],
            producedOutputIds: ['output'], outputDigests: { output: digest('c') } } });
    const options = { expectedIdentity: input, expectedProducerId: producerId,
        expectedAuthorityId: 'tools/test-matrix/outcomes/release-finalizer-adapter.mjs' };
    assert.equal(analyzeProducerSemanticOutcomeCandidate(candidate, options).dataOnly, true);
    assert.throws(() => analyzeProducerSemanticOutcomeCandidate(reseal(candidate, {
        ...candidate.outcome.membership, verifiedInputIds: [] }), options), /incomplete/u);
});

test('accessors, sparse arrays and enumerable extra array fields are not canonical JSON input', () =>
{
    const metadata = {};
    Object.defineProperty(metadata, 'errorText', { get() { throw new Error('must not be invoked'); }, enumerable: true });
    assert.throws(() => analyze(fixture(), metadata), /JSON data fields/u);
    const original = fixture();
    const sparse = ['a', 'b'];
    delete sparse[0];
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        producedProjectionIds: sparse })), /dense JSON/u);
    const extra = ['a', 'b'];
    extra.extra = 'unregistered';
    assert.throws(() => analyze(reseal(original, { ...original.outcome.membership,
        producedProjectionIds: extra })), /dense JSON/u);
});

test('distinct same-kind authority refs preserve the original source-input closure without ambiguity', () =>
{
    const original = fixture();
    const references = [{ kind: 'repository-authority', path: 'fixtures/one.json', digest: digest('a') },
        { kind: 'repository-authority', path: 'fixtures/two.json', digest: digest('b') }];
    const first = sealContentDigest({ ...original, inputAuthorityRefs: references });
    const second = sealContentDigest({ ...original, inputAuthorityRefs: [...references].reverse() });
    assert.equal(analyze(first).outcomeFingerprint, analyze(second).outcomeFingerprint);
    assert.throws(() => analyze(sealContentDigest({ ...original,
        inputAuthorityRefs: [references[0], references[0]] })), /duplicate or ambiguous/u);
});

test('the single registry migrates explicitly and refuses old version, unknown nested policy and duplicate disposition', () =>
{
    const original = validateOutcomeFieldDispositions();
    assert.equal(original.entries.length, 10);
    assert.throws(() => validateOutcomeFieldDispositions({ ...original,
        schema: 'fsusblog.outcome-field-dispositions.v1', schemaVersion: '1' }), /registry is invalid/u);
    assert.throws(() => validateOutcomeFieldDispositions({ ...original,
        canonicalization: { ...original.canonicalization, unknown: true } }), /fields/u);
    const duplicate = structuredClone(original);
    duplicate.canonicalization.nestedFields.push(duplicate.canonicalization.nestedFields[0]);
    assert.throws(() => validateOutcomeFieldDispositions(duplicate), /duplicate/u);
    const unowned = structuredClone(original);
    unowned.canonicalization.profiles[0].fields[0].owner = '';
    assert.throws(() => validateOutcomeFieldDispositions(unowned), /unowned/u);
});

function directOptions(extra = {})
{
    return { expectedIdentity: identity, expectedProducerId: identity.producerId,
        expectedAuthorityId: 'tools/test-matrix/outcomes/release-projection-adapter.mjs',
        hostExpectedLimits, ...extra };
}

test('public entry refuses candidate and expected getters before any legacy validator or digest', () =>
{
    let calls = 0;
    for (const key of ['schema', 'identity', 'outcome'])
    {
        const candidate = { ...fixture() };
        Object.defineProperty(candidate, key, { get() { calls++; throw new Error('getter invoked'); }, enumerable: true });
        assert.throws(() => analyzeCandidateWithLimits(candidate, directOptions()), /JSON data fields/u);
    }
    const candidate = structuredClone(fixture());
    Object.defineProperty(candidate.outcome, 'membership', { get() { calls++; throw new Error('membership invoked'); }, enumerable: true });
    assert.throws(() => analyzeCandidateWithLimits(candidate, directOptions()), /JSON data fields/u);
    const expected = { ...identity };
    Object.defineProperty(expected, 'sourceCommit', { get() { calls++; throw new Error('expected invoked'); }, enumerable: true });
    assert.throws(() => analyzeCandidateWithLimits(fixture(), directOptions({ expectedIdentity: expected })), /JSON data fields/u);
    const options = directOptions();
    Object.defineProperty(options, 'expectedIdentity', { get() { calls++; throw new Error('option invoked'); }, enumerable: true });
    assert.throws(() => analyzeCandidateWithLimits(fixture(), options), /JSON data fields/u);
    assert.equal(calls, 0);
});

test('public entry refuses toJSON, cycles, nonplain objects and proxies before hashing or cloning', () =>
{
    let calls = 0;
    const candidate = { ...fixture(), toJSON() { calls++; return fixture(); } };
    assert.throws(() => analyzeCandidateWithLimits(candidate, directOptions()), /plain JSON/u);
    const cyclic = structuredClone(fixture());
    cyclic.outcome.membership.loop = cyclic;
    assert.throws(() => analyzeCandidateWithLimits(cyclic, directOptions()), /cyclic JSON/u);
    assert.throws(() => analyzeCandidateWithLimits(fixture(), directOptions({ metadata: { generatedAt: new Date(0) } })), /plain object/u);
    const proxy = new Proxy(fixture(), { getPrototypeOf() { calls++; return Object.prototype; }, ownKeys() { calls++; return []; } });
    assert.throws(() => analyzeCandidateWithLimits(proxy, directOptions()), /plain JSON/u);
    const limits = { ...hostExpectedLimits };
    Object.defineProperty(limits, 'maxDepth', { get() { calls++; return 32; }, enumerable: true });
    assert.throws(() => analyzeCandidateWithLimits(fixture(), directOptions({ hostExpectedLimits: limits })), /JSON data fields/u);
    assert.equal(calls, 0);
});

test('public entry requires external finite host limits and enforces each bound before legacy validation', () =>
{
    const withoutLimits = directOptions();
    delete withoutLimits.hostExpectedLimits;
    assert.throws(() => analyzeCandidateWithLimits(fixture(), withoutLimits), /host budgets/u);
    for (const key of Object.keys(hostExpectedLimits))
    {
        for (const invalid of [0, -1, Infinity, NaN, '32'])
        {
            assert.throws(() => analyzeCandidateWithLimits(fixture(), directOptions({
                hostExpectedLimits: { ...hostExpectedLimits, [key]: invalid } })), /finite positive/u);
        }
        assert.throws(() => analyzeCandidateWithLimits(fixture(), directOptions({
            hostExpectedLimits: { ...hostExpectedLimits, [key]: 1 } })), /budget exceeded/u);
    }
    assert.equal(analyzeCandidateWithLimits(fixture(), directOptions()).dataOnly, true);
    assert.throws(() => analyzeCandidateWithLimits(fixture(), directOptions({
        metadata: { errorText: '😀'.repeat(2048) },
        hostExpectedLimits: { ...hostExpectedLimits, maxStringBytes: 4096 } })), /string byte budget/u);
});

test('resealed failed projection must classify every required member, not merely carry a valid failure reason', () =>
{
    const original = fixture();
    const partial = { ...original.outcome.membership, verifiedProjectionIds: ['a'],
        failedProjectionIds: [], blockedProjectionIds: [], semanticDigests: { a: digest('b') } };
    const candidate = sealContentDigest({ ...original, outcome: { ...original.outcome,
        status: 'failed', requiredMembershipVerified: false, membership: partial,
        semanticPayloadDigest: digestCanonical(partial),
        reasons: [{ kind: 'product.assertion', producerId: identity.producerId,
            identity: { producerId: identity.producerId, assertionId: 'otherwise-valid' } }] } });
    assert.throws(() => analyzeCandidateWithLimits(candidate, directOptions()), /classification is incomplete/u);
});

test('actual failed and blocked projection classifications remain analyzable without laundering status', () =>
{
    for (const blocked of [false, true])
    {
        const base = fixture();
        const candidate = adaptReleaseProjectionSemanticOutcome({ identity,
            inputAuthorityRefs: base.inputAuthorityRefs, attemptEligibility: base.attemptEligibility,
            plan: { projectionIds: ['a', 'b'] }, evidence: {
                producedIds: blocked ? ['a'] : ['a', 'b'], verifiedIds: ['a'],
                failedIds: blocked ? [] : ['b'], blockedIds: blocked ? ['b'] : [],
                semanticDigests: { a: digest('b') } } });
        const result = analyzeCandidateWithLimits(candidate, directOptions());
        assert.equal(result.summary.status, 'failed');
        assert.equal(result.producerVerificationPending, true);
        assert.deepEqual(result.summary.membership[blocked ? 'blockedProjectionIds' : 'failedProjectionIds'], ['b']);
    }
});

test('failed finalizer input membership must also cover the complete original required set', () =>
{
    const producerId = 'release-finalizer-semantic-outcome';
    const input = { ...identity, producerId };
    const base = fixture();
    const candidate = adaptReleaseFinalizerSemanticOutcome({ identity: input,
        inputAuthorityRefs: base.inputAuthorityRefs, attemptEligibility: base.attemptEligibility,
        plan: { inputIds: ['a', 'b'], outputIds: ['output'] }, evidence: {
            consumedIds: ['a', 'b'], verifiedIds: ['a'], failedIds: ['b'], blockedIds: [],
            producedOutputIds: ['output'], outputDigests: { output: digest('c') } } });
    const options = directOptions({ expectedIdentity: input, expectedProducerId: producerId,
        expectedAuthorityId: 'tools/test-matrix/outcomes/release-finalizer-adapter.mjs' });
    assert.equal(analyzeCandidateWithLimits(candidate, options).summary.status, 'failed');
    assert.throws(() => analyzeCandidateWithLimits(reseal(candidate, {
        ...candidate.outcome.membership, failedInputIds: [] }), options), /classification is incomplete/u);
});

test('actual build failures require their original per-artifact failure classification', () =>
{
    const producerId = 'immutable-build-semantic-outcome';
    const input = { ...identity, producerId };
    const base = fixture();
    const candidate = adaptImmutableBuildSemanticOutcome({ identity: input,
        inputAuthorityRefs: base.inputAuthorityRefs, attemptEligibility: base.attemptEligibility,
        plan: { artifactIds: ['missing'], verificationAssertionIds: ['assertion'] },
        evidence: { artifacts: [], verificationAssertions: [{ id: 'assertion', status: 'passed' }] } });
    const options = directOptions({ expectedIdentity: input, expectedProducerId: producerId,
        expectedAuthorityId: 'tools/test-matrix/outcomes/immutable-build-adapter.mjs' });
    assert.equal(analyzeCandidateWithLimits(candidate, options).summary.status, 'failed');
    const unrelated = sealContentDigest({ ...candidate, outcome: { ...candidate.outcome,
        reasons: [{ kind: 'product.assertion', producerId,
            identity: { producerId, assertionId: 'assertion' } }] } });
    assert.throws(() => analyzeCandidateWithLimits(unrelated, options), /failure classification is incomplete/u);
});

test('original missing-evidence failures remain explicit classifications rather than invented terminal IDs', () =>
{
    const base = fixture();
    const candidate = adaptReleaseProjectionSemanticOutcome({ identity,
        inputAuthorityRefs: base.inputAuthorityRefs, attemptEligibility: base.attemptEligibility,
        plan: { projectionIds: ['a', 'b'] }, evidence: {
            producedIds: ['a'], verifiedIds: ['a'], failedIds: [], blockedIds: [],
            semanticDigests: { a: digest('b') } } });
    const result = analyzeCandidateWithLimits(candidate, directOptions());
    assert.equal(result.summary.status, 'failed');
    assert.deepEqual(result.summary.membership.requiredProjectionIds, ['a', 'b']);
    assert.deepEqual(result.summary.membership.verifiedProjectionIds, ['a']);
    assert.deepEqual(result.summary.membership.failedProjectionIds, []);
    assert.deepEqual(result.summary.reasons.map((reason) => reason.identity.evidenceId).sort(), ['b', 'b:terminal']);
    const omitted = sealContentDigest({ ...candidate, outcome: { ...candidate.outcome,
        reasons: candidate.outcome.reasons.filter((reason) => reason.identity.evidenceId !== 'b:terminal') } });
    assert.throws(() => analyzeCandidateWithLimits(omitted, directOptions()), /classification is incomplete/u);
});

test('finalizer missing output keeps its original exact missing-evidence classification', () =>
{
    const producerId = 'release-finalizer-semantic-outcome';
    const input = { ...identity, producerId };
    const base = fixture();
    const candidate = adaptReleaseFinalizerSemanticOutcome({ identity: input,
        inputAuthorityRefs: base.inputAuthorityRefs, attemptEligibility: base.attemptEligibility,
        plan: { inputIds: ['a'], outputIds: ['output'] }, evidence: {
            consumedIds: ['a'], verifiedIds: ['a'], failedIds: [], blockedIds: [],
            producedOutputIds: [], outputDigests: {} } });
    const options = directOptions({ expectedIdentity: input, expectedProducerId: producerId,
        expectedAuthorityId: 'tools/test-matrix/outcomes/release-finalizer-adapter.mjs' });
    const result = analyzeCandidateWithLimits(candidate, options);
    assert.equal(result.summary.status, 'failed');
    assert.deepEqual(result.summary.membership.requiredOutputIds, ['output']);
    assert.deepEqual(result.summary.membership.producedOutputIds, []);
    assert.deepEqual(result.summary.reasons.map((reason) => reason.identity.evidenceId), ['output']);
    assert.equal(result.producerVerificationPending, true);
    const unrelated = sealContentDigest({ ...candidate, outcome: { ...candidate.outcome,
        reasons: [{ kind: 'product.assertion', producerId,
            identity: { producerId, assertionId: 'a' } }] } });
    assert.throws(() => analyzeCandidateWithLimits(unrelated, options), /output failure classification is incomplete/u);
});

test('contained policy v2 registers both actual strong schemas without replacing candidate v1', () =>
{
    const registry = validateOutcomeFieldDispositions(undefined, hostExpectedLimits);
    assert.equal(registry.schema, 'fsusblog.outcome-field-dispositions.v2');
    assert.equal(registry.schemaVersion, '2');
    assert.equal(registry.fingerprintAlgorithmVersion, 'registry-canonical-json-sha256-v2');
    assert.equal(registry.canonicalization.schema, 'fsusblog.outcome-canonicalization-policy.v2');
    assert.deepEqual(registry.canonicalization.schemas.map((item) => item.schema), [
        'fsusblog.aggregate-run-outcome.v1', 'fsusblog.producer-semantic-outcome.v1']);
    assert.deepEqual(registry.canonicalization.schemas.map((item) => item.fields.length), [73, 105]);
    const candidate = fixture();
    assert.equal(candidate.schemaVersion, '1');
    assert.equal(analyze(candidate).producerVerificationPending, true);
    const oldPolicy = structuredClone(registry);
    oldPolicy.canonicalization.schema = 'fsusblog.outcome-canonicalization-policy.v1';
    assert.throws(() => validateOutcomeFieldDispositions(oldPolicy), /policy is invalid/u);
});

test('strong disposition declarations have exact identities and six closed owned fields', () =>
{
    const original = validateOutcomeFieldDispositions();
    for (const mutate of [
        (value) => { value.canonicalization.schemas[0].schema = 'unknown.schema.v1'; },
        (value) => { value.canonicalization.schemas.push(value.canonicalization.schemas[0]); },
        (value) => { value.canonicalization.schemas[0].extra = true; },
        (value) => { value.canonicalization.schemas[0].fields[0].required = true; },
        (value) => { value.canonicalization.schemas[0].fields[0].owner = ''; },
        (value) => { value.canonicalization.schemas[0].fields[0].normalizationRule = 'unregistered-rule'; },
        (value) => { value.canonicalization.schemas[0].fields.push(value.canonicalization.schemas[0].fields[0]); }
    ])
    {
        const value = structuredClone(original);
        mutate(value);
        assert.throws(() => validateOutcomeFieldDispositions(value));
    }
});

test('full coverage cannot silently downgrade to legacy metadata-only declaration validation', () =>
{
    const incomplete = structuredClone(validateOutcomeFieldDispositions());
    const producer = incomplete.canonicalization.schemas.find((item) => item.schema === 'fsusblog.producer-semantic-outcome.v1');
    producer.fields = producer.fields.filter((item) => item.schemaPath !== '$.redactedSecrets[].contextDigest');
    // This legacy entry validates declarations only, not producer/full-schema authority.
    assert.equal(validateOutcomeFieldDispositions(incomplete), incomplete);
    assert.throws(() => validateOutcomeFieldDispositions(incomplete, hostExpectedLimits), /coverage/u);
    const extra = structuredClone(validateOutcomeFieldDispositions());
    extra.canonicalization.schemas[0].fields.push({
        ...extra.canonicalization.schemas[0].fields[0], schemaPath: '$.unregisteredNestedField' });
    assert.throws(() => validateOutcomeFieldDispositions(extra, hostExpectedLimits), /coverage/u);
});

test('fixed-schema coverage has no caller-supplied budget default or getter bypass', () =>
{
    let calls = 0;
    const limits = { ...hostExpectedLimits };
    Object.defineProperty(limits, 'maxStringBytes', { enumerable: true, get() { calls++; return 131072; } });
    assert.throws(() => validateOutcomeFieldDispositions(undefined, limits), /byte budget/u);
    assert.equal(calls, 0);
    assert.throws(() => validateOutcomeFieldDispositions(undefined, { ...hostExpectedLimits, maxStringBytes: 1 }), /byte budget/u);
    assert.throws(() => validateOutcomeFieldDispositions(undefined, { ...hostExpectedLimits, maxNodes: 1 }), /budget/u);
    assert.equal(validateOutcomeFieldDispositions(undefined, hostExpectedLimits).entries.length, 10);
});

test('secret context and semantic references remain explicitly registered instead of erased as diagnostics', () =>
{
    const registry = validateOutcomeFieldDispositions(undefined, hostExpectedLimits);
    const producer = registry.canonicalization.schemas.find((item) => item.schema === 'fsusblog.producer-semantic-outcome.v1');
    const find = (schemaPath) => producer.fields.find((item) => item.schemaPath === schemaPath);
    for (const name of ['semanticId', 'present', 'type', 'contextDigest'])
    {
        assert.equal(find(`$.redactedSecrets[].${name}`).category, 'secret-redacted');
    }
    assert.equal(find('$.redactedSecrets[].contextDigest').normalizationRule, 'digest');
    assert.equal(find('$.projectionReceipts[].semanticPayloadDigest').category, 'semantic-outcome');
    assert.equal(find('$.projectionReceipts[].contentDigest').category, 'evidence-location');
    assert.throws(() => sealVerifiedProducerSemanticOutcome(registry), /independent authority bridge/u);
});
