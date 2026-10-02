import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const { runProducerAttempts } = await import(new URL('../../../tools/test/attempt-runner.mjs', import.meta.url));
const { sha256 } = await import(new URL('../../../tools/test/attempt-provenance.mjs', import.meta.url));

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const commandFixture = path.join(
    repositoryRoot,
    'tests/tools/fixtures/attempt-runner-command.mjs'
);

export async function createCleanAttemptEvidenceFixture({
    consumerId,
    membership,
    producerId = `${consumerId}-fixture`,
    schedulerRunId = `${consumerId}-clean-run`,
    sourceCommit = '1'.repeat(40),
    worktreeFingerprint = `sha256:${'2'.repeat(64)}`,
    buildIdentity = `sha256:${'9'.repeat(64)}`
})
{
    const evidenceRoot = fs.realpathSync(fs.mkdtempSync(path.join(
        os.tmpdir(),
        `fsusblog-${consumerId}-attempt-`
    )));
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
    const verifyAuthority = (reference) => ({
        verified: true,
        authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId }
    });
    const result = await runProducerAttempts({
        evidenceRoot,
        producerId,
        retryPolicyId: 'correctness-first-attempt',
        sourceCommit,
        worktreeFingerprint,
        schedulerRunId,
        command: [process.execPath, commandFixture, 'success'],
        cwd: repositoryRoot,
        env: { PATH: process.env.PATH },
        authorityReferences,
        verifyAuthority,
        expectedTestIds: ['fixture:attempt-runner'],
        timeoutMs: 5_000
    });
    return {
        expectedCandidate: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId, buildIdentity,
            executionEnvelopeDigest: `sha256:${'3'.repeat(64)}`, replayPlanDigest: `sha256:${'4'.repeat(64)}`,
            temporalContextDigest: `sha256:${'5'.repeat(64)}`, membership: structuredClone(membership),
            domainReceiptReference: { path: 'payload.json', digest: result.attempts[0].artifactDigests['payload.json'] } },
        attemptEvidence: {
            buildIdentity,
            consumerId,
            evidenceRoot,
            aggregateReference: {
                path: path.relative(
                    evidenceRoot,
                    path.join(result.producerRoot, 'aggregate.json')
                ),
                digest: result.aggregate.contentDigest,
                fileDigest: sha256(fs.readFileSync(path.join(
                    result.producerRoot,
                    'aggregate.json'
                )))
            },
            domainReceiptReference: {
                path: 'payload.json',
                digest: result.attempts[0].artifactDigests['payload.json']
            },
            expectedIdentity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId },
            verifyAuthority,
            membership,
            expected: membership
        },
        cleanup()
        {
            fs.rmSync(evidenceRoot, { recursive: true, force: true });
        }
    };
}

export function writeCleanAttemptEvidenceFixtureSource(fixture, file)
{
    const evidence = fixture.attemptEvidence;
    const authorityRoot = path.join(path.dirname(file), 'authorities');
    fs.mkdirSync(authorityRoot, { recursive: true });
    const authorityVerificationReceipts = {};
    const authorityReferences = ['execution-envelope', 'replay-plan', 'temporal-context'].map((kind, index) =>
    {
        const digest = `sha256:${String(index + 3).repeat(64)}`;
        const artifactPath = `${kind}.json`;
        const verificationReceiptPath = `${kind}.verification.json`;
        fs.writeFileSync(path.join(authorityRoot, artifactPath), `${kind}\n`);
        const artifactFileDigest = sha256(fs.readFileSync(path.join(authorityRoot, artifactPath)));
        fs.writeFileSync(path.join(authorityRoot, verificationReceiptPath), JSON.stringify({
            schema: 'fsusblog.external-authority-verification.v1', kind, authorityDigest: digest,
            verificationReceiptDigest: digest, artifactFileDigest, identity: evidence.expectedIdentity, verified: true
        }));
        authorityVerificationReceipts[kind] = { path: verificationReceiptPath,
            fileDigest: sha256(fs.readFileSync(path.join(authorityRoot, verificationReceiptPath))) };
        return { kind, artifactPath, artifactDigest: digest, artifactFileDigest, verificationReceiptPath,
            verificationReceiptDigest: digest };
    });
    const document = { schema: 'fsusblog.clean-attempt-evidence-input.v1', consumerId: evidence.consumerId,
        membership: evidence.membership, expected: evidence.expected, buildIdentity: evidence.buildIdentity,
        evidenceRoot: evidence.evidenceRoot, authorityRoot, authorityReferences, authorityVerificationReceipts,
        aggregateReference: evidence.aggregateReference,
        domainReceiptReference: { ...evidence.domainReceiptReference, fileDigest: evidence.domainReceiptReference.digest },
        expectedIdentity: evidence.expectedIdentity, transport: null };
    fs.writeFileSync(file, JSON.stringify(document));
    return { path: file, fileDigest: sha256(fs.readFileSync(file)) };
}
