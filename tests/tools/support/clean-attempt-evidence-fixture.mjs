import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { runProducerAttempts } from '../../../tools/test/attempt-runner.mjs';
import { sha256 } from '../../../tools/test/attempt-provenance.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const commandFixture = path.join(
    repositoryRoot,
    'tests/tools/fixtures/attempt-runner-command.mjs'
);

export async function createCleanAttemptEvidenceFixture({
    consumerId,
    membership,
    producerId = `${consumerId}-fixture`,
    schedulerRunId = `${consumerId}-clean-run`
})
{
    const evidenceRoot = fs.realpathSync(fs.mkdtempSync(path.join(
        os.tmpdir(),
        `fsusblog-${consumerId}-attempt-`
    )));
    const sourceCommit = '1'.repeat(40);
    const worktreeFingerprint = `sha256:${'2'.repeat(64)}`;
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
        attemptEvidence: {
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
