import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL, URL } from 'node:url';

const { observeStaticAtomicAssertion, staticAssertionObservation } = await import(new URL('../../tools/test/static-atomic/assertion-result.mjs', import.meta.url));
const { staticAtomicDeclarations } = await import(new URL('../../tools/test/static-atomic/declarations.mjs', import.meta.url));
const { runProducerAttempts } = await import(new URL('../../tools/test/attempt-runner.mjs', import.meta.url));
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const originalAuthSource = pathToFileURL(path.join(repositoryRoot, 'tests/frontend/checks/runtime/auth-state-coherence.mjs'));

function outputFixture(t)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-static-observed-result-'));
    const previous = process.env.FSUSBLOG_ATTEMPT_RESULT_PATH;
    t.after(() =>
    {
        if (previous === undefined)
        {
            delete process.env.FSUSBLOG_ATTEMPT_RESULT_PATH;
        }
        else
        {
            process.env.FSUSBLOG_ATTEMPT_RESULT_PATH = previous;
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const file = path.join(directory, 'cross-stack-auth-state-coherence', 'attempt-1', 'result.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return { directory, file };
}

test('one completed original assertion produces its own existing identity, independent of expected or replay lists', async t =>
{
    const { file } = outputFixture(t);
    process.env.FSUSBLOG_ATTEMPT_RESULT_PATH = file;
    let calls = 0;
    const result = await observeStaticAtomicAssertion('auth-state', originalAuthSource, () =>
    {
        calls += 1;
        assert.equal(fs.existsSync(file), false);
        return 'original-result';
    });
    const observation = staticAssertionObservation('auth-state', originalAuthSource);
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(calls, 1);
    assert.equal(result, 'original-result');
    assert.equal(observation.sourceTestId, 'command:cross-stack-static:auth-state');
    assert.deepEqual(receipt.executedTestIds, [observation.canonicalTestId]);
    assert.deepEqual(receipt.failedTestIds, []);
    assert.equal(receipt.failureClass, null);
    assert.deepEqual(receipt.artifactPaths, []);
});

test('a failed original assertion records actual failed membership and preserves the thrown object', async t =>
{
    const { file } = outputFixture(t);
    process.env.FSUSBLOG_ATTEMPT_RESULT_PATH = file;
    const original = new Error('original coherence assertion failed');
    await assert.rejects(observeStaticAtomicAssertion('auth-state', originalAuthSource, () =>
    {
        throw original;
    }), error => error === original);
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(receipt.failedTestIds, receipt.executedTestIds);
    assert.equal(receipt.executedTestIds.length, 1);
    assert.equal(receipt.failureClass, 'product');
    assert.equal(receipt.failureKind, 'assertion-mismatch');
});

test('result publication cannot overwrite another observation or replace the first assertion failure', async t =>
{
    const { file } = outputFixture(t);
    process.env.FSUSBLOG_ATTEMPT_RESULT_PATH = file;
    fs.writeFileSync(file, 'retained-original-result');
    const original = Object.freeze(new Error('original coherence assertion failed'));
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    await assert.rejects(observeStaticAtomicAssertion('auth-state', originalAuthSource, () =>
    {
        throw original;
    }), error => error === original);
    assert.equal(errors[0][1].code, 'EEXIST');
    assert.equal(fs.readFileSync(file, 'utf8'), 'retained-original-result');
    await assert.rejects(observeStaticAtomicAssertion('auth-state', originalAuthSource, () => 'checked'), /EEXIST/u);
});

test('foreign assertion sources refuse before execution; no output request preserves the ordinary callback', async t =>
{
    const { file } = outputFixture(t);
    process.env.FSUSBLOG_ATTEMPT_RESULT_PATH = file;
    let calls = 0;
    await assert.rejects(observeStaticAtomicAssertion('auth-state', pathToFileURL(import.meta.filename), () => calls += 1), /original owned source/u);
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(file), false);
    delete process.env.FSUSBLOG_ATTEMPT_RESULT_PATH;
    assert.equal(await observeStaticAtomicAssertion('auth-state', originalAuthSource, () => calls += 1), 1);
    assert.equal(fs.existsSync(file), false);
});

test('the existing matrices owner can read its exact observation encoding without an execution or sidecar', t =>
{
    const { file } = outputFixture(t);
    process.env.FSUSBLOG_ATTEMPT_RESULT_PATH = file;
    const observation = staticAssertionObservation('security-matrix-schema',
        pathToFileURL(path.join(repositoryRoot, 'tools/security/check-security-matrices.mjs')));
    assert.equal(observation.sourceTestId, 'command:security-static:security-matrix-schema');
    assert.equal(observation.source, 'tools/security/check-security-matrices.mjs');
    assert.equal(fs.existsSync(file), false);
});

test('an inherited legacy parent request remains with the parent writer and never gets a child result', async t =>
{
    const { directory } = outputFixture(t);
    const file = path.join(directory, 'cross-stack-static', 'attempt-1', 'result.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'original-parent-result');
    process.env.FSUSBLOG_ATTEMPT_RESULT_PATH = file;
    let calls = 0;
    assert.equal(await observeStaticAtomicAssertion('auth-state', originalAuthSource, () => calls += 1), 1);
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original-parent-result');
});

test('six original coherence commands and PoW parity emit real observed IDs through the original runner output request', async t =>
{
    const { directory } = outputFixture(t);
    const declarations = staticAtomicDeclarations(repositoryRoot);
    const results = [];
    for (const producer of declarations.producers.filter(entry => entry.lane === 'cross-stack-static' || entry.id === 'security-pow-parity'))
    {
        const binding = producer.assertionBindings[0];
        const observed = staticAssertionObservation(binding.id, pathToFileURL(path.join(repositoryRoot, binding.artifactPaths[0])));
        const identity = { sourceCommit: '1'.repeat(40), worktreeFingerprint: `sha256:${'2'.repeat(64)}`,
            schedulerRunId: 'synthetic-observer-contract', producerId: producer.id };
        const authorityReferences = ['execution-envelope', 'replay-plan', 'temporal-context'].map((kind, index) => ({
            kind, artifactPath: `synthetic/${kind}.json`, artifactDigest: `sha256:${String(index + 3).repeat(64)}`,
            verificationReceiptPath: `synthetic/${kind}.verified.json`, verificationReceiptDigest: `sha256:${'6'.repeat(64)}`
        }));
        // Controlled owner proofs exercise real original checker/output behavior, never current-run qualification.
        const result = await runProducerAttempts({ ...identity, evidenceRoot: directory,
            retryPolicyId: 'correctness-first-attempt', command: producer.command,
            cwd: path.resolve(repositoryRoot, producer.cwd), timeoutMs: 10000,
            expectedTestIds: [observed.canonicalTestId], authorityReferences,
            env: { PATH: process.env.PATH, FSUSBLOG_EXPECTED_TEST_IDS: '["unobserved-planned-id"]',
                FSUSBLOG_REPLAY_PLAN_PATH: '/does-not-exist/unread-plan.json' },
            verifyAuthority: reference => ({ verified: true, authorityDigest: reference.artifactDigest,
                verificationReceiptDigest: reference.verificationReceiptDigest, identity }) });
        assert.equal(result.aggregate.cleanFirstAttempt, true);
        assert.equal(result.attempts.length, 1);
        assert.deepEqual(result.attempts[0].command, producer.command);
        assert.deepEqual(result.attempts[0].executedTestIds, [observed.canonicalTestId]);
        assert.deepEqual(result.attempts[0].failedTestIds, []);
        assert.equal(result.attempts[0].maxAttempts, 1);
        const sidecar = JSON.parse(fs.readFileSync(path.join(result.producerRoot, 'attempt-1', 'result.json'), 'utf8'));
        assert.deepEqual(sidecar.executedTestIds, [observed.canonicalTestId]);
        results.push(producer.id);
    }
    assert.equal(results.length, 7);
});
