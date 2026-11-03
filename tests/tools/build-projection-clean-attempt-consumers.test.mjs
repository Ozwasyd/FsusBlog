import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { heldBuildOutcomeInputs } from './support/build-outcome-held-input-fixture.mjs';

const {admitSemanticOutcomeCleanAttempt, readSemanticOutcomeConsumerInventory, validateSemanticOutcomeConsumerInventory} = await import(new URL('../../tools/release/semantic-outcome-clean-attempt-consumers.mjs', import.meta.url));
const {runProducerAttempts} = await import(new URL('../../tools/test/attempt-runner.mjs', import.meta.url));
const {sha256} = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
const fixtureCommand = path.join(root, 'tests/tools/fixtures/attempt-runner-command.mjs');
const sourceCommit = '1'.repeat(40);
const worktreeFingerprint = `sha256:${'2'.repeat(64)}`;
const toolchainDigest = `sha256:${'6'.repeat(64)}`;
const buildIdentity = `sha256:${'7'.repeat(64)}`;
const authorityReferences = [
    ['execution-envelope', '3'],
    ['replay-plan', '4'],
    ['temporal-context', '5']
].map(([kind, digit]) => ({
    kind,
    artifactPath: `${kind}.json`,
    artifactDigest: `sha256:${digit.repeat(64)}`,
    verificationReceiptPath: `${kind}.verification.json`,
    verificationReceiptDigest: `sha256:${digit.repeat(64)}`
}));

function attemptAuthority(producerId, schedulerRunId)
{
    return (reference) => ({
        verified: true,
        authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId }
    });
}

async function cleanEvidence(directory, {
    producerId = 'semantic-producer',
    schedulerRunId = 'semantic-run',
    scenario = 'success',
    retryPolicyId = 'correctness-first-attempt'
} = {})
{
    const result = await runProducerAttempts({
        evidenceRoot: directory,
        producerId,
        retryPolicyId,
        sourceCommit,
        worktreeFingerprint,
        schedulerRunId,
        command: [process.execPath, fixtureCommand, scenario],
        cwd: root,
        env: { PATH: process.env.PATH },
        authorityReferences,
        verifyAuthority: attemptAuthority(producerId, schedulerRunId),
        expectedTestIds: ['fixture:attempt-runner'],
        timeoutMs: 5_000
    });
    return {
        aggregateReceipt: result.aggregate,
        loadAttempt: (reference) => result.attempts[reference.attemptNumber - 1],
        verifyAuthority: attemptAuthority(producerId, schedulerRunId),
        verifyArtifact: (relative, digest, receipt) =>
        {
            const file = path.join(result.producerRoot, `attempt-${receipt.attemptNumber}`, relative);
            return fs.existsSync(file) && sha256(fs.readFileSync(file)) === digest;
        }
    };
}

function reference(consumer)
{
    return {
        authorityIssue: consumer.candidateAuthorityIssue,
        producerId: consumer.candidateProducerId,
        producerAuthorityId: consumer.candidateProducerAuthorityId,
        schema: 'fsusblog.producer-semantic-outcome-candidate.v1',
        path: `external/${consumer.id}/candidate.json`,
        contentDigest: `sha256:${'8'.repeat(64)}`,
        verificationReceiptPath: `external/${consumer.id}/verification.json`,
        verificationReceiptDigest: `sha256:${'9'.repeat(64)}`
    };
}

function identity(producerId = 'semantic-producer', schedulerRunId = 'semantic-run')
{
    return {
        sourceCommit,
        worktreeFingerprint,
        schedulerRunId,
        producerId,
        toolchainDigest,
        executionEnvelopeDigest: authorityReferences[0].artifactDigest,
        replayPlanDigest: authorityReferences[1].artifactDigest,
        temporalContextDigest: authorityReferences[2].artifactDigest,
        buildIdentity
    };
}

function attemptBinding(attemptEvidence)
{
    const aggregate = attemptEvidence.aggregateReceipt;
    return {
        aggregateDigest: aggregate.contentDigest,
        attemptDigest: aggregate.attempts[0].digest,
        attemptNumber: 1,
        cleanFirstAttempt: aggregate.cleanFirstAttempt,
        firstFailure: false,
        qualificationEligible: aggregate.qualificationEligible
    };
}

function verifier(candidateReference, expectedIdentity, attemptEligibility, outcome = {
    status: 'success',
    requiredMembershipVerified: true,
    reasons: []
})
{
    return (actual) => ({
        verified: actual === candidateReference,
        authorityIssue: candidateReference.authorityIssue,
        producerId: candidateReference.producerId,
        producerAuthorityId: candidateReference.producerAuthorityId,
        candidateSchema: candidateReference.schema,
        candidateDigest: candidateReference.contentDigest,
        verificationReceiptDigest: candidateReference.verificationReceiptDigest,
        identity: expectedIdentity,
        attemptEligibility,
        outcome
    });
}

function admit(consumer, attemptEvidence, options = {})
{
    const candidateReference = options.candidateReference ?? reference(consumer);
    const expectedIdentity = Object.hasOwn(options, 'expectedIdentity')
        ? options.expectedIdentity
        : identity();
    const verifyCandidate = Object.hasOwn(options, 'verifyCandidate')
        ? options.verifyCandidate
        : verifier(
            candidateReference,
            options.verificationIdentity ?? identity(),
            options.attemptEligibility ?? attemptBinding(attemptEvidence),
            options.outcome
        );
    return admitSemanticOutcomeCleanAttempt({
        consumerId: consumer.id,
        candidateReference,
        verifyCandidate,
        attemptEvidence,
        expectedIdentity,
        rawEvidence: options.rawEvidence ?? null
    });
}

test('inventory binds build, projection and finalizer to external semantic owners only', () =>
{
    const inventory = readSemanticOutcomeConsumerInventory();
    assert.equal(inventory.migrationState, 'migrated');
    assert.equal(inventory.qualificationEligible, true);
    assert.deepEqual(inventory.consumers.map((entry) => [
        entry.id,
        entry.candidateAuthorityIssue,
        entry.rawEvidenceAccess,
        entry.producerInvocation
    ]), [
        ['finalizer', 2656, [], null],
        ['immutable-build', 2654, [], null],
        ['release-projection', 2655, [], null]
    ]);
});

test('verified candidates plus a clean first attempt admit all three consumers', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-semantic-consumers-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const attemptEvidence = await cleanEvidence(directory);
    for (const consumer of readSemanticOutcomeConsumerInventory().consumers)
    {
        const result = admit(consumer, attemptEvidence);
        assert.equal(result.eligible, true, consumer.id);
        assert.deepEqual(result.reasons, []);
    }
});

test('domain failure reasons remain the exact external adapter reason objects', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-semantic-failure-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const attemptEvidence = await cleanEvidence(directory);
    const cases = new Map([
        ['immutable-build', { code: 'artifact.missing', artifactIds: ['server-image'] }],
        ['release-projection', { code: 'projection.blocked', blockedIds: ['release-auth-flow'] }],
        ['finalizer', { code: 'finalizer.upstream-failed', inputIds: ['production-correctness'] }]
    ]);
    for (const consumer of readSemanticOutcomeConsumerInventory().consumers)
    {
        const domainReason = cases.get(consumer.id);
        const result = admit(consumer, attemptEvidence, {
            outcome: { status: 'failed', requiredMembershipVerified: false, reasons: [domainReason] }
        });
        assert.equal(result.eligible, false);
        assert.equal(result.reasons[0], domainReason);
    }
});

test('missing/tampered candidate and cross source, toolchain or authority identity fail closed', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-semantic-tamper-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const attemptEvidence = await cleanEvidence(directory);
    const consumer = readSemanticOutcomeConsumerInventory().consumers[0];
    const candidateReference = reference(consumer);
    const invalid = [
        { verifyCandidate: null },
        { expectedIdentity: null },
        { expectedIdentity: { sourceCommit } },
        {
            verifyCandidate: () => ({
                verified: true,
                authorityIssue: candidateReference.authorityIssue,
                producerId: candidateReference.producerId,
                producerAuthorityId: candidateReference.producerAuthorityId,
                candidateSchema: candidateReference.schema,
                candidateDigest: `sha256:${'0'.repeat(64)}`,
                verificationReceiptDigest: candidateReference.verificationReceiptDigest,
                identity: identity(),
                outcome: { status: 'success', requiredMembershipVerified: true, reasons: [] }
            })
        },
        { expectedIdentity: { ...identity(), toolchainDigest: `sha256:${'0'.repeat(64)}` } },
        { expectedIdentity: { ...identity(), executionEnvelopeDigest: `sha256:${'0'.repeat(64)}` } }
    ];
    for (const options of invalid)
    {
        const result = admit(consumer, attemptEvidence, {
            candidateReference,
            ...options
        });
        assert.equal(result.eligible, false);
    }
});

test('candidate owner must return a closed and self-consistent semantic outcome', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-semantic-outcome-shape-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const attemptEvidence = await cleanEvidence(directory);
    const consumer = readSemanticOutcomeConsumerInventory().consumers[0];
    for (const outcome of [
        { status: 'success', requiredMembershipVerified: true, reasons: [{ code: 'unexpected' }] },
        { status: 'failed', requiredMembershipVerified: false, reasons: [] },
        { status: 'unknown', requiredMembershipVerified: false, reasons: [{ code: 'unknown' }] }
    ])
    {
        const result = admit(consumer, attemptEvidence, { outcome });
        assert.equal(result.eligible, false);
        assert.equal(result.reasons[0].code, 'candidate.external-authority-unverified');
    }
});

test('recovered attempt and final-exit/status/path/summary raw fallback cannot qualify', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-semantic-fallback-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const recovered = await cleanEvidence(directory, {
        producerId: 'dependency-restore',
        schedulerRunId: 'restore-run',
        scenario: 'restore-timeout-once',
        retryPolicyId: 'dependency-transfer-observed-recovery'
    });
    const consumer = readSemanticOutcomeConsumerInventory().consumers[0];
    assert.equal(admit(consumer, recovered, {
        expectedIdentity: identity('dependency-restore', 'restore-run')
    }).eligible, false);

    const clean = await cleanEvidence(directory, {
        producerId: 'clean-finalizer',
        schedulerRunId: 'clean-finalizer-run'
    });
    const expectedIdentity = identity('clean-finalizer', 'clean-finalizer-run');
    const result = admit(consumer, clean, {
        expectedIdentity,
        rawEvidence: {
            finalExitCode: 0,
            status: 'success',
            latest: true,
            mtimeMs: Date.now(),
            pathExists: true,
            summary: { status: 'ok' }
        }
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reasons[0].code, 'candidate.raw-evidence-conflict');
});

test('consumer source neither invokes producers nor imports raw semantic parsers', () =>
{
    const source = fs.readFileSync(
        path.join(root, 'tools/release/semantic-outcome-clean-attempt-consumers.mjs'),
        'utf8'
    );
    assert.doesNotMatch(source, /child_process|spawnSync|execFile|from\s+['"][^'"]*(?:immutable-build|release-projection|release-finalizer)-adapter/u);
    assert.doesNotMatch(source, /readdirSync|statSync|mtimeMs|finalExitCode/u);
});


test('consumer inventory rejects duplicate owners instead of omitting a domain', () =>
{
    const inventory = structuredClone(readSemanticOutcomeConsumerInventory());
    inventory.consumers[1] = structuredClone(inventory.consumers[0]);
    assert.throws(() => validateSemanticOutcomeConsumerInventory(inventory), /duplicate/u);
});

test('actual verified attempt authority digests must match candidate expected identity', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-semantic-authority-drift-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const attemptEvidence = await cleanEvidence(directory);
    for (const consumer of readSemanticOutcomeConsumerInventory().consumers)
    {
        for (const field of ['executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest'])
        {
            const drifted = { ...identity(), [field]: `sha256:${'0'.repeat(64)}` };
            const result = admit(consumer, attemptEvidence, {
                expectedIdentity: drifted,
                verificationIdentity: drifted
            });
            assert.equal(result.eligible, false, `${consumer.id}/${field}`);
            assert.equal(result.reasons[0].code, 'attempt.consumer-identity-mismatch');
            assert.equal(result.reasons[0].field, field);
        }
    }
});

test('owner candidate must bind the exact verified aggregate and attempt receipts', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-semantic-attempt-binding-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const attemptEvidence = await cleanEvidence(directory);
    const original = attemptBinding(attemptEvidence);
    for (const consumer of readSemanticOutcomeConsumerInventory().consumers)
    {
        for (const [field, value] of [
            ['aggregateDigest', `sha256:${'0'.repeat(64)}`],
            ['attemptDigest', `sha256:${'0'.repeat(64)}`],
            ['attemptNumber', 2],
            ['cleanFirstAttempt', false],
            ['qualificationEligible', false],
            ['firstFailure', true]
        ])
        {
            const result = admit(consumer, attemptEvidence, {
                attemptEligibility: { ...original, [field]: value }
            });
            assert.equal(result.eligible, false, `${consumer.id}/${field}`);
            assert.equal(result.reasons[0].code, 'candidate.attempt-binding-mismatch');
            assert.equal(result.reasons[0].field, field);
        }
        const candidateReference = reference(consumer);
        const result = admit(consumer, attemptEvidence, {
            candidateReference,
            verifyCandidate: (actual) =>
            {
                const verified = verifier(candidateReference, identity(), original)(actual);
                delete verified.attemptEligibility;
                return verified;
            }
        });
        assert.equal(result.eligible, false);
        assert.equal(result.reasons[0].code, 'candidate.external-authority-unverified');
    }
});


test('original domain adapters and owner verifiers compose with actual controlled attempt receipts', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-domain-attempt-composition-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const modules = {
        'immutable-build': await import(new URL('../../tools/test-matrix/outcomes/immutable-build-adapter.mjs', import.meta.url)),
        'release-projection': await import(new URL('../../tools/test-matrix/outcomes/release-projection-adapter.mjs', import.meta.url)),
        finalizer: await import(new URL('../../tools/test-matrix/outcomes/release-finalizer-adapter.mjs', import.meta.url))
    };
    const plans = {
        'immutable-build': { artifactIds: ['image'], verificationAssertionIds: ['manifest'] },
        'release-projection': { projectionIds: ['projection'] },
        finalizer: { inputIds: ['upstream'], outputIds: ['binding'] }
    };
    const d = (digit) => `sha256:${digit.repeat(64)}`;
    const evidence = {
        'immutable-build': { artifacts: [{ id: 'image', contentDigest: d('a'), manifestDigest: d('b'),
            provenanceDigest: d('c'), imageDigest: d('d'), verified: true }],
        verificationAssertions: [{ id: 'manifest', status: 'passed' }] },
        'release-projection': { producedIds: ['projection'], verifiedIds: ['projection'],
            failedIds: [], blockedIds: [], semanticDigests: { projection: d('a') } },
        finalizer: { consumedIds: ['upstream'], verifiedIds: ['upstream'], failedIds: [], blockedIds: [],
            producedOutputIds: ['binding'], outputDigests: { binding: d('a') } }
    };
    for (const consumer of readSemanticOutcomeConsumerInventory().consumers)
    {
        const producerId = consumer.candidateProducerId;
        const schedulerRunId = `${consumer.id}-composition-run`;
        const attemptEvidence = await cleanEvidence(directory, { producerId, schedulerRunId });
        const expectedIdentity = identity(producerId, schedulerRunId);
        const inputs = { identity: expectedIdentity, attemptEligibility: attemptBinding(attemptEvidence),
            inputAuthorityRefs: [{ kind: 'controlled-plan', path: 'plan.json', digest: d('e') }],
            plan: plans[consumer.id], evidence: evidence[consumer.id] };
        const module = modules[consumer.id];
        const adapt = module.adaptImmutableBuildSemanticOutcome ?? module.adaptReleaseProjectionSemanticOutcome
            ?? module.adaptReleaseFinalizerSemanticOutcome;
        const verify = module.verifyImmutableBuildSemanticOutcomeCandidate
            ?? module.verifyReleaseProjectionSemanticOutcomeCandidate ?? module.verifyReleaseFinalizerSemanticOutcomeCandidate;
        const candidate = adapt({ ...inputs, verifyInputs: heldBuildOutcomeInputs(inputs) });
        const candidateReference = { ...reference(consumer), contentDigest: candidate.contentDigest };
        const result = admit(consumer, attemptEvidence, {
            candidateReference,
            expectedIdentity,
            verifyCandidate: () => verify(candidate, {
                expectedIdentity, expectedCandidateDigest: candidateReference.contentDigest,
                verificationReceiptDigest: candidateReference.verificationReceiptDigest
            })
        });
        assert.equal(result.eligible, true, consumer.id);
        assert.equal(result.attemptVerdict.attempt.contentDigest, candidate.attemptEligibility.attemptDigest);
    }
});
