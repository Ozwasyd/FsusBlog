import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {admitBrowserReleaseCleanAttempt} = await import(new URL('../../tools/release/browser-release-clean-attempt-consumers.mjs', import.meta.url));
const {cleanAttemptEvidenceInputSchema, readCleanAttemptEvidenceSource} = await import(new URL('../../tools/release/clean-attempt-evidence-source.mjs', import.meta.url));
const {runProducerAttempts} = await import(new URL('../../tools/test/attempt-runner.mjs', import.meta.url));
const {sha256} = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
const fixtureCommand = path.join(root, 'tests/tools/fixtures/attempt-runner-command.mjs');
const sourceCommit = '1'.repeat(40);
const worktreeFingerprint = `sha256:${'2'.repeat(64)}`;

function digestFile(file)
{
    return sha256(fs.readFileSync(file));
}

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function authoritySet(directory, producerId, schedulerRunId)
{
    const authorityRoot = path.join(directory, 'authorities');
    fs.mkdirSync(authorityRoot, { recursive: true });
    const references = [];
    const verificationReceipts = {};
    for (const [kind, digit] of [
        ['execution-envelope', '3'],
        ['replay-plan', '4'],
        ['temporal-context', '5']
    ])
    {
        const artifactPath = `${kind}.authority.json`;
        const verificationReceiptPath = `${kind}.verification.json`;
        const artifactFile = path.join(authorityRoot, artifactPath);
        const verificationFile = path.join(authorityRoot, verificationReceiptPath);
        fs.writeFileSync(artifactFile, `${kind}: externally-owned authority\n`);
        const artifactDigest = `sha256:${digit.repeat(64)}`;
        const verificationReceiptDigest = `sha256:${String(Number(digit) + 3).repeat(64)}`;
        const verification = {
            schema: 'fsusblog.external-authority-verification.v1',
            kind,
            authorityDigest: artifactDigest,
            verificationReceiptDigest,
            artifactFileDigest: digestFile(artifactFile),
            identity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId },
            verified: true
        };
        writeJson(verificationFile, verification);
        references.push({
            kind,
            artifactPath,
            artifactDigest,
            artifactFileDigest: digestFile(artifactFile),
            verificationReceiptPath,
            verificationReceiptDigest
        });
        verificationReceipts[kind] = {
            path: verificationReceiptPath,
            fileDigest: digestFile(verificationFile)
        };
    }
    return { authorityRoot, references, verificationReceipts };
}

function verifyAuthority(references, producerId, schedulerRunId)
{
    return (reference) =>
    {
        const expected = references.find((candidate) => candidate.kind === reference.kind);
        assert.deepEqual(reference, {
            kind: expected.kind,
            artifactPath: expected.artifactPath,
            artifactDigest: expected.artifactDigest,
            verificationReceiptPath: expected.verificationReceiptPath,
            verificationReceiptDigest: expected.verificationReceiptDigest
        });
        return {
            verified: true,
            authorityDigest: reference.artifactDigest,
            verificationReceiptDigest: reference.verificationReceiptDigest,
            identity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId }
        };
    };
}

test('file-backed authority source drives a real producer aggregate into consumer admission', async () =>
{
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-attempt-source-')));
    try
    {
        const producerId = 'source-backed-producer';
        const schedulerRunId = 'source-backed-run';
        const authorities = authoritySet(directory, producerId, schedulerRunId);
        const result = await runProducerAttempts({
            evidenceRoot: directory,
            producerId,
            retryPolicyId: 'correctness-first-attempt',
            sourceCommit,
            worktreeFingerprint,
            schedulerRunId,
            command: [process.execPath, fixtureCommand, 'success'],
            cwd: root,
            env: { PATH: process.env.PATH },
            authorityReferences: authorities.references.map((reference) => ({
                kind: reference.kind,
                artifactPath: reference.artifactPath,
                artifactDigest: reference.artifactDigest,
                verificationReceiptPath: reference.verificationReceiptPath,
                verificationReceiptDigest: reference.verificationReceiptDigest
            })),
            verifyAuthority: verifyAuthority(authorities.references, producerId, schedulerRunId),
            expectedTestIds: ['fixture:attempt-runner'],
            timeoutMs: 5_000
        });
        const aggregateFile = path.join(result.producerRoot, 'aggregate.json');
        const domainFile = path.join(result.producerRoot, 'attempt-1', 'payload.json');
        const inputFile = path.join(directory, 'clean-attempt-input.json');
        writeJson(inputFile, {
            schema: cleanAttemptEvidenceInputSchema,
            consumerId: 'production-correctness',
            membership: { selectedTierIds: ['source-backed'], testVectors: ['fixture'] },
            expected: { selectedTierIds: ['source-backed'], testVectors: ['fixture'] },
            evidenceRoot: '.',
            authorityRoot: 'authorities',
            authorityReferences: authorities.references,
            authorityVerificationReceipts: authorities.verificationReceipts,
            aggregateReference: {
                path: path.relative(directory, aggregateFile).replaceAll(path.sep, '/'),
                digest: result.aggregate.contentDigest,
                fileDigest: digestFile(aggregateFile)
            },
            domainReceiptReference: {
                path: 'payload.json',
                digest: result.attempts[0].artifactDigests['payload.json'],
                fileDigest: digestFile(domainFile)
            },
            expectedIdentity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId },
            transport: null
        });
        const source = readCleanAttemptEvidenceSource(inputFile, { repositoryRoot: directory });
        const admission = admitBrowserReleaseCleanAttempt({
            consumerId: source.consumerId,
            attemptEvidence: source,
            membership: source.membership,
            expected: source.expected
        });
        assert.equal(admission.eligible, true, JSON.stringify(admission));
        assert.deepEqual(admission.reasons, []);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('source rejects modified external verification receipts before consumer admission', () =>
{
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-attempt-source-invalid-')));
    try
    {
        const authorities = authoritySet(directory, 'source-backed-producer', 'source-backed-run');
        const verification = path.join(authorities.authorityRoot, authorities.verificationReceipts['replay-plan'].path);
        fs.appendFileSync(verification, 'tamper\n');
        const inputFile = path.join(directory, 'clean-attempt-input.json');
        writeJson(inputFile, {
            schema: cleanAttemptEvidenceInputSchema,
            consumerId: 'production-correctness',
            membership: { selectedTierIds: ['source-backed'], testVectors: ['fixture'] },
            expected: { selectedTierIds: ['source-backed'], testVectors: ['fixture'] },
            evidenceRoot: '.',
            authorityRoot: 'authorities',
            authorityReferences: authorities.references,
            authorityVerificationReceipts: authorities.verificationReceipts,
            aggregateReference: { path: 'missing.json', digest: `sha256:${'a'.repeat(64)}`, fileDigest: `sha256:${'b'.repeat(64)}` },
            domainReceiptReference: { path: 'missing.json', digest: `sha256:${'a'.repeat(64)}`, fileDigest: `sha256:${'b'.repeat(64)}` },
            expectedIdentity: {
                sourceCommit,
                worktreeFingerprint,
                schedulerRunId: 'source-backed-run',
                producerId: 'source-backed-producer'
            },
            transport: null
        });
        assert.throws(
            () => readCleanAttemptEvidenceSource(inputFile, { repositoryRoot: directory }),
            /authority verification receipt bytes changed/u
        );
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
