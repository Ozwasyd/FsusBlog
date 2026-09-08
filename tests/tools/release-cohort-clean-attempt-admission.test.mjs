import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fileBackedCleanAttemptEvidence } from '../../tools/release/clean-first-attempt-verifier.mjs';
import {
    appendCleanAttemptCohortSlot,
    createCleanAttemptCohort,
    persistCleanAttemptCohortRevision,
    validateCleanAttemptCohort
} from '../../tools/release/release-clean-attempt-cohort.mjs';
import { sealContentDigest, sha256 } from '../../tools/test/attempt-provenance.mjs';
import { runProducerAttempts } from '../../tools/test/attempt-runner.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const commandFixture = path.join(root, 'tests/tools/fixtures/attempt-runner-command.mjs');
const sourceCommit = '1'.repeat(40);
const worktreeFingerprint = `sha256:${'2'.repeat(64)}`;
const buildIdentity = `sha256:${'9'.repeat(64)}`;

function authorityReferences()
{
    return [
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
}

function verification(producerId, schedulerRunId, producerCommit = sourceCommit)
{
    return (reference) => ({
        verified: true,
        authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: { sourceCommit: producerCommit, worktreeFingerprint, schedulerRunId, producerId }
    });
}

async function producer(evidenceRoot, schedulerRunId, {
    producerId = 'release-candidate',
    producerCommit = sourceCommit,
    scenario = 'success',
    retryPolicyId = 'correctness-first-attempt'
} = {})
{
    evidenceRoot = fs.realpathSync(evidenceRoot);
    const result = await runProducerAttempts({
        evidenceRoot,
        producerId,
        retryPolicyId,
        sourceCommit: producerCommit,
        worktreeFingerprint,
        schedulerRunId,
        command: [process.execPath, commandFixture, scenario],
        cwd: root,
        env: { PATH: process.env.PATH },
        authorityReferences: authorityReferences(),
        verifyAuthority: verification(producerId, schedulerRunId, producerCommit),
        expectedTestIds: ['fixture:attempt-runner'],
        timeoutMs: 5_000
    });
    return {
        evidenceRoot,
        aggregateReceipt: result.aggregate,
        verifyAuthority: verification(producerId, schedulerRunId, producerCommit),
        aggregateReference: {
            path: path.relative(evidenceRoot, path.join(result.producerRoot, 'aggregate.json')),
            digest: result.aggregate.contentDigest,
            fileDigest: sha256(fs.readFileSync(path.join(result.producerRoot, 'aggregate.json')))
        }
    };
}

function add(cohort, slot, evidence)
{
    return appendCleanAttemptCohortSlot(cohort, {
        slot,
        ...evidence,
        expectedIdentity: { sourceCommit, worktreeFingerprint }
    });
}

test('file reader supports root-level receipts and hashes artifacts across chunks', (context) =>
{
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-stream-')));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const aggregate = sealContentDigest({ marker: 'root' });
    const raw = JSON.stringify(aggregate);
    fs.writeFileSync(path.join(temporary, 'aggregate.json'), raw);
    fs.mkdirSync(path.join(temporary, 'attempt-1'));
    const bytes = Buffer.alloc(128 * 1024 + 17, 91);
    fs.writeFileSync(path.join(temporary, 'attempt-1/stdout.log'), bytes);
    const reader = fileBackedCleanAttemptEvidence({ evidenceRoot: temporary,
        aggregateReference: { path: 'aggregate.json', digest: aggregate.contentDigest, fileDigest: sha256(raw) } });
    assert.deepEqual(reader.loadAggregate(), aggregate);
    assert.equal(reader.verifyArtifact('stdout.log', sha256(bytes), { attemptNumber: 1 }), true);
    const originalRead = fs.readSync;
    let changed = false;
    context.mock.method(fs, 'readSync', (...args) =>
    {
        const count = originalRead(...args);
        if (!changed)
        {
            changed = true;
            fs.appendFileSync(path.join(temporary, 'attempt-1/stdout.log'), 'changed');
        }
        return count;
    });
    assert.throws(() => reader.verifyArtifact('stdout.log', sha256(bytes), { attemptNumber: 1 }),
        /changed while being read/u);
});

test('receipt size limit is inclusive and descriptors close after parse and size failures', (context) =>
{
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-size-')));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const aggregate = sealContentDigest({ marker: 'size' });
    const raw = JSON.stringify(aggregate).padEnd(16 * 1024 * 1024, ' ');
    const file = path.join(temporary, 'aggregate.json');
    fs.writeFileSync(file, raw);
    const reader = fileBackedCleanAttemptEvidence({ evidenceRoot: temporary,
        aggregateReference: { path: 'aggregate.json', digest: aggregate.contentDigest, fileDigest: sha256(raw) } });
    assert.deepEqual(reader.loadAggregate(), aggregate);
    const opened = [];
    const originalOpen = fs.openSync;
    context.mock.method(fs, 'openSync', (...args) =>
    {
        const descriptor = originalOpen(...args);
        if (args[0] === file && typeof args[1] === 'number') opened.push(descriptor);
        return descriptor;
    });
    fs.appendFileSync(file, ' ');
    assert.throws(() => reader.loadAggregate(), /size limit/u);
    fs.writeFileSync(file, '{malformed');
    assert.throws(() => reader.loadAggregate(), SyntaxError);
    assert.equal(opened.length, 2);
    for (const descriptor of opened)
        assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
});

test('three independent first-attempt clean runs qualify an append-only cohort', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-clean-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    let cohort = createCleanAttemptCohort('candidate-1', buildIdentity);
    for (const slot of [1, 2, 3])
    {
        const evidence = await producer(temporary, `cohort-run-${slot}`);
        cohort = add(cohort, slot, evidence);
        assert.equal(cohort.events.at(-1).status, 'admitted');
    }
    assert.equal(cohort.qualificationEligible, true);
    assert.equal(validateCleanAttemptCohort(cohort), cohort);
    const revision = path.join(temporary, 'cohorts/candidate-1/revision-3.json');
    persistCleanAttemptCohortRevision(revision, cohort);
    assert.equal(fs.statSync(revision).mode & 0o222, 0);
    assert.throws(() => persistCleanAttemptCohortRevision(revision, cohort), /EEXIST/u);
});

test('a real producer rooted at the evidence directory is admitted with its attempt and logs', async (context) =>
{
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-root-')));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const evidence = await producer(temporary, 'root-producer');
    evidence.evidenceRoot = path.dirname(path.join(temporary, evidence.aggregateReference.path));
    evidence.aggregateReference.path = 'aggregate.json';
    const cohort = add(createCleanAttemptCohort('candidate-root', buildIdentity), 1, evidence);
    assert.equal(cohort.events[0].status, 'admitted');
    assert.equal(cohort.events[0].evidence.attemptNumber, 1);
    assert.ok(cohort.events[0].evidence.logs.stdout.digest);
    assert.equal(validateCleanAttemptCohort(cohort), cohort);
});

test('individually valid runs cannot change source identity across cohort slots', async (context) =>
{
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-source-')));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const first = await producer(temporary, 'first-source');
    const changed = await producer(temporary, 'changed-source', { producerCommit: '7'.repeat(40) });
    const original = add(createCleanAttemptCohort('candidate-source', buildIdentity), 1, first);
    const cohort = appendCleanAttemptCohortSlot(original, { slot: 2, ...changed });
    assert.equal(cohort.events[1].status, 'rejected');
    assert.equal(cohort.events[1].reasons[0].code, 'cohort.source-identity-mismatch');
    assert.equal(cohort.events[1].reasons[0].field, 'sourceCommit');
    assert.deepEqual(cohort.events[0], original.events[0]);
    assert.equal(validateCleanAttemptCohort(cohort), cohort);
    const rewritten = sealContentDigest({ ...cohort.events[1], status: 'admitted', reasons: [] });
    const forged = sealContentDigest({ ...cohort, events: [cohort.events[0], rewritten] });
    assert.throws(() => validateCleanAttemptCohort(forged), /changes source identity/u);
});

test('aggregate reference digest must bind the validated receipt', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-reference-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const evidence = await producer(temporary, 'reference-run');
    evidence.aggregateReference = {
        ...evidence.aggregateReference,
        digest: `sha256:${'8'.repeat(64)}`
    };
    const cohort = add(createCleanAttemptCohort('candidate-reference', buildIdentity), 1, evidence);
    const event = cohort.events[0];
    assert.equal(event.status, 'rejected');
    assert.equal(event.reasons[0].code, 'attempt.content-tamper');
    assert.equal(event.reasons[0].actual.digest, evidence.aggregateReceipt.contentDigest);
    assert.equal(event.reasons[0].expected.digest, evidence.aggregateReference.digest);
    assert.equal(event.reasons[0].ref, evidence.aggregateReference.path);
    assert.equal(cohort.qualificationEligible, false);
    assert.throws(() => add(cohort, 1, evidence), /cohort\.slot-immutable/u);
});

test('persisted cohort validates slot and disposition independently of content digests', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-schema-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const evidence = await producer(temporary, 'schema-run');
    const original = add(createCleanAttemptCohort('candidate-schema', buildIdentity), 1, evidence);
    for (const change of [
        { slot: 0 },
        { slot: 4 },
        { slot: 1.5 },
        { schema: 'unknown' },
        { status: 'success' },
        { reasons: [{ code: 'failed', message: 'must not be admitted' }] },
        { status: 'rejected', reasons: [] },
        { status: 'rejected', reasons: [{ code: '', message: '' }] }
    ])
    {
        const event = sealContentDigest({ ...original.events[0], ...change });
        const malformed = sealContentDigest({ ...original, events: [event] });
        assert.throws(() => validateCleanAttemptCohort(malformed), /cohort event 1/u);
    }
});

test('a failed slot is retained and cannot be replaced by a later clean run', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-failed-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const failed = await producer(temporary, 'failed-run', { scenario: 'product-failure' });
    const cohort = add(createCleanAttemptCohort('candidate-2', buildIdentity), 1, failed);
    assert.equal(cohort.events[0].status, 'rejected');
    assert.equal(cohort.events[0].reasons[0].code, 'attempt.not-clean-first');
    const laterClean = await producer(temporary, 'later-clean-run');
    assert.throws(() => add(cohort, 1, laterClean), /cohort\.slot-immutable/u);
});

test('recovered diagnostic or restore attempts cannot occupy a clean cohort slot', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-recovered-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    for (const [producerId, retryPolicyId, scenario] of [
        ['browser-diagnostics', 'diagnostic-browser-process-crash', 'browser-crash-once'],
        ['dependency-restore', 'dependency-transfer-observed-recovery', 'restore-timeout-once']
    ])
    {
        const evidence = await producer(temporary, `${producerId}-run`, {
            producerId,
            retryPolicyId,
            scenario
        });
        const cohort = add(createCleanAttemptCohort(`candidate-${producerId}`, buildIdentity), 1, evidence);
        assert.equal(cohort.events[0].status, 'rejected');
        assert.equal(cohort.events[0].reasons[0].code, 'attempt.not-clean-first');
    }
});

test('missing attempts, status-only evidence, cross identity and artifact tamper fail closed', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-invalid-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    for (const kind of ['summary', 'missing-attempts', 'cross-identity', 'log-tamper'])
    {
        const evidence = await producer(temporary, `invalid-${kind}`);
        const aggregateFile = path.join(temporary, evidence.aggregateReference.path);
        if (kind === 'summary' || kind === 'missing-attempts')
        {
            const changed = kind === 'summary'
                ? { status: 'ok', exitCode: 0, contentDigest: evidence.aggregateReceipt.contentDigest }
                : { ...evidence.aggregateReceipt, attempts: [] };
            fs.chmodSync(aggregateFile, 0o600);
            fs.writeFileSync(aggregateFile, JSON.stringify(changed));
            evidence.aggregateReference.fileDigest = sha256(fs.readFileSync(aggregateFile));
        }
        if (kind === 'log-tamper')
        {
            const attemptFile = path.join(path.dirname(aggregateFile), evidence.aggregateReceipt.attempts[0].path);
            const attempt = JSON.parse(fs.readFileSync(attemptFile, 'utf8'));
            const log = path.join(path.dirname(attemptFile), attempt.stdoutPath);
            fs.chmodSync(log, 0o600);
            fs.appendFileSync(log, 'changed');
        }
        const cohort = appendCleanAttemptCohortSlot(
            createCleanAttemptCohort(`candidate-invalid-${kind}`, buildIdentity),
            { slot: 1, ...evidence, expectedIdentity: {
                sourceCommit: kind === 'cross-identity' ? 'a'.repeat(40) : sourceCommit,
                worktreeFingerprint
            } }
        );
        assert.equal(cohort.qualificationEligible, false);
        assert.equal(cohort.events[0].status, 'rejected');
        assert.ok(cohort.events[0].reasons[0].code.startsWith('attempt.'));
    }
});

test('cohort slots reject reused run and aggregate roots with specific reasons', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-reused-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const evidence = await producer(temporary, 'shared-run');
    let cohort = add(createCleanAttemptCohort('candidate-reused', buildIdentity), 1, evidence);
    cohort = add(cohort, 2, evidence);
    assert.equal(cohort.events[1].status, 'rejected');
    assert.deepEqual(cohort.events[1].reasons.map((item) => item.code), [
        'cohort.run-not-independent',
        'cohort.attempt-root-not-independent'
    ]);
});

test('cohort admission reads files and rejects missing, replaced and aliased evidence', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-files-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    for (const kind of [
        'missing-root', 'missing-aggregate', 'missing-attempt', 'missing-log',
        'aggregate-symlink', 'attempt-symlink', 'log-symlink',
        'aggregate-bytes', 'attempt-content', 'missing-file-digest'
    ])
    {
        const evidence = await producer(temporary, `file-${kind}`);
        const aggregateFile = path.join(temporary, evidence.aggregateReference.path);
        const attemptFile = path.join(path.dirname(aggregateFile), evidence.aggregateReceipt.attempts[0].path);
        const attempt = JSON.parse(fs.readFileSync(attemptFile, 'utf8'));
        const logFile = path.join(path.dirname(attemptFile), attempt.stdoutPath);
        const target = kind.includes('aggregate') ? aggregateFile
            : kind.includes('attempt') ? attemptFile : logFile;
        if (kind === 'missing-root') evidence.evidenceRoot = undefined;
        else if (kind === 'missing-file-digest') delete evidence.aggregateReference.fileDigest;
        else if (kind.startsWith('missing-')) fs.unlinkSync(target);
        else if (kind.endsWith('-symlink'))
        {
            fs.renameSync(target, `${target}.original`);
            fs.symlinkSync(`${target}.original`, target);
        }
        else
        {
            fs.chmodSync(target, 0o600);
            fs.writeFileSync(target, kind === 'aggregate-bytes'
                ? `${fs.readFileSync(target, 'utf8')} `
                : JSON.stringify({ ...attempt, status: 'cancelled' }));
        }
        const cohort = add(createCleanAttemptCohort(`candidate-${kind}`, buildIdentity), 1, {
            ...evidence,
            // In-memory substitutes cannot override the mandatory file reader.
            loadAttempt: () => attempt,
            verifyArtifact: () => true
        });
        assert.equal(cohort.events[0].status, 'rejected', kind);
        assert.ok(cohort.events[0].reasons[0].code.startsWith('attempt.'), kind);
        assert.equal(cohort.qualificationEligible, false, kind);
    }
});

test('different aggregate filenames in one attempt root are not independent runs', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-root-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const first = await producer(temporary, 'root-run-one');
    const second = await producer(temporary, 'root-run-two');
    let cohort = add(createCleanAttemptCohort('candidate-root', buildIdentity), 1, first);
    assert.equal(cohort.events[0].status, 'admitted');
    const firstRoot = path.dirname(path.join(temporary, first.aggregateReference.path));
    const secondRoot = path.dirname(path.join(temporary, second.aggregateReference.path));
    // Simulate a new run replacing the first run's files in the same owned root.
    fs.rmSync(path.join(firstRoot, 'attempt-1'), { recursive: true, force: true });
    fs.cpSync(path.join(secondRoot, 'attempt-1'), path.join(firstRoot, 'attempt-1'), { recursive: true });
    fs.copyFileSync(path.join(secondRoot, 'aggregate.json'), path.join(firstRoot, 'second.json'));
    second.aggregateReference = {
        ...second.aggregateReference,
        path: path.relative(temporary, path.join(firstRoot, 'second.json'))
    };
    cohort = add(cohort, 2, second);
    assert.equal(cohort.events[1].status, 'rejected');
    assert.equal(cohort.events[1].reasons[0].code, 'cohort.attempt-root-not-independent');
    for (const referencePath of [
        'shared/../shared/first.json', './shared/first.json', '/shared/first.json',
        'shared//first.json', 'shared\\first.json', 'C:/shared/first.json'
    ])
    {
        const rejected = add(createCleanAttemptCohort('candidate-path', buildIdentity), 1, {
            ...first,
            aggregateReference: { ...first.aggregateReference, path: referencePath }
        });
        assert.equal(rejected.events[0].status, 'rejected');
        assert.equal(validateCleanAttemptCohort(rejected), rejected);
        assert.throws(() => add(rejected, 1, first), /slot-immutable/u);
    }
});

test('malformed attempt references preserve an immutable rejected slot', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-malformed-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const evidence = await producer(temporary, 'malformed-reference');
    const aggregateFile = path.join(temporary, evidence.aggregateReference.path);
    const malformed = sealContentDigest({
        ...evidence.aggregateReceipt, attempts: [{ attemptNumber: 1, path: null, digest: null }]
    });
    fs.chmodSync(aggregateFile, 0o600);
    fs.writeFileSync(aggregateFile, JSON.stringify(malformed));
    evidence.aggregateReference.digest = malformed.contentDigest;
    evidence.aggregateReference.fileDigest = sha256(fs.readFileSync(aggregateFile));
    for (const input of [evidence, { ...evidence, aggregateReference: null }])
    {
        const cohort = add(createCleanAttemptCohort('candidate-malformed', buildIdentity), 1, input);
        assert.equal(cohort.events[0].status, 'rejected');
        assert.equal(cohort.events[0].evidence.attemptReceipt, null);
        assert.equal(validateCleanAttemptCohort(cohort), cohort);
        assert.throws(() => add(cohort, 1, evidence), /slot-immutable/u);
    }
});
