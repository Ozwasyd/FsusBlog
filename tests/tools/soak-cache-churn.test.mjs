import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { cacheChurnSteps, readCacheChurnPolicy, runCacheChurnWindow, verifyCacheChurnEvidence }
    = await import(new URL('../../tools/test/lanes/soak-cache-churn.mjs', import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const policy = readCacheChurnPolicy(fs.readFileSync(path.join(root, 'tests/performance/perf-policy.yml'), 'utf8'));

function fixture(overrides = {})
{
    let generation = 10;
    const calls = [];
    let elapsedMs = 0;
    const obligation = (identity) => ({
        ...identity,
        obligationId: `obligation:${generation}`,
        targetGeneration: generation,
        publishedGeneration: generation,
        durable: true,
        deliveryResult: 'accepted',
        queueFull: false,
        state: 'published',
        attemptNumber: 1,
        attempts: ['projector', 'publish', 'revocation-completion', 'completion']
            .map((stage) => ({ attemptNumber: 1, failureKind: 'none', stage }))
    });
    const driver = {
        async readCurrentGeneration(identity, signal)
        {
            signal.throwIfAborted();
            calls.push('current');
            return { ...identity, generation };
        },
        async mutateCanary(identity, signal)
        {
            signal.throwIfAborted();
            calls.push('mutation');
            generation += 1;
            return { ...identity, committed: true };
        },
        async readObligation(identity)
        {
            calls.push('obligation');
            return obligation(identity);
        },
        async readRevocation(identity)
        {
            calls.push('revocation');
            return {
                ...identity, previousGeneration: generation - 1,
                targetGeneration: generation, state: 'observed', oldGenerationIsCurrent: false
            };
        },
        async readPublication(identity)
        {
            calls.push(identity.mutationId.endsWith('/cleanup') ? 'cleanup-publication' : 'publication');
            return {
                ...identity, state: 'published', publishedGeneration: generation,
                oldGenerationIsCurrent: false, obligation: obligation(identity),
                generations: Object.fromEntries(['database', 'redisFrame', 'hotRead', 'aotReceipt']
                    .map((owner) => [owner, generation])),
                payloads: Object.fromEntries(['database', 'redisFrame', 'hotRead', 'aotReceipt']
                    .map((owner) => [owner, {
                        canaryKey: identity.canaryKey,
                        present: !identity.mutationId.endsWith('/cleanup'), value: identity.canaryValue
                    }]))
            };
        },
        async cleanupCanary(identity, signal)
        {
            signal.throwIfAborted();
            calls.push('cleanup');
            generation += 1;
            return { ...identity, committed: true, obligation: obligation(identity) };
        }
    };
    for (const [method, transform] of Object.entries(overrides))
    {
        const original = driver[method];
        driver[method] = async (...args) => transform(await original(...args), args[0], args[1]);
    }
    return {
        driver, calls,
        run: (options = {}) => runCacheChurnWindow({
            driver, policy, runId: 'fixture-run', namespace: 'fixture-namespace', durationMs: 100,
            now: () => elapsedMs,
            observeReads: async () =>
            {
                elapsedMs += 50;
            }, ...options
        })
    };
}

test('complete ordered cycles bind mutation and cleanup generations to the current run', async () =>
{
    const runtime = fixture();
    const result = await runtime.run();
    assert.equal(result.status, 'ok');
    assert.equal(result.cycles.length, 2);
    assert.equal(verifyCacheChurnEvidence(result), true);
    assert.deepEqual(runtime.calls.slice(0, 8), [
        'current', 'mutation', 'obligation', 'revocation', 'publication', 'publication', 'cleanup', 'cleanup-publication'
    ]);
    for (const cycle of result.cycles)
    {
        assert.deepEqual(cycle.steps.map((step) => step.name), cacheChurnSteps);
        assert.ok(cycle.canaryKey.startsWith('soak:fixture-namespace:fixture-run/'));
        assert.ok(cycle.cleanup.publishedGeneration > cycle.publishedGeneration);
        assert.ok(cycle.targetGeneration > cycle.previousGeneration);
    }
    assert.notEqual(result.cycles[0].mutationId, result.cycles[1].mutationId);
});

test('GET-only and cache-clear-only evidence cannot claim cache-churn', async () =>
{
    const valid = await fixture().run();
    const getOnly = { ...valid, cycles: [] };
    assert.throws(() => verifyCacheChurnEvidence(getOnly), /minimum-cycles/);
    const clearOnly = structuredClone(valid);
    clearOnly.cycles[0].steps[1].proof.committed = false;
    assert.throws(() => verifyCacheChurnEvidence(clearOnly), /mutation-not-committed/);
    const inventedSuccess = structuredClone(valid);
    inventedSuccess.cycles[0].steps = [];
    assert.throws(() => verifyCacheChurnEvidence(inventedSuccess), /steps-incomplete/);
});

test('old generation still current fails and cleanup still executes', async () =>
{
    const runtime = fixture({ readRevocation: (proof) => ({ ...proof, oldGenerationIsCurrent: true }) });
    const result = await runtime.run();
    assert.equal(result.status, 'failed');
    assert.match(result.failureKind, /old-generation-current/);
    assert.equal(result.cycles.length, 1);
    assert.equal(result.cycles[0].cleanup.status, 'ok');
    assert.ok(runtime.calls.includes('cleanup'));
});

test('completed rebuild with no canary payload fails', async () =>
{
    const result = await fixture({ readPublication: (proof, identity) =>
    {
        if (!identity.mutationId.endsWith('/cleanup'))
        {
            proof.payloads.hotRead.present = false;
        }
        return proof;
    } }).run();
    assert.equal(result.status, 'failed');
    assert.match(result.failureKind, /stale-payload:hotRead/);
});

test('HotRead/AOT and AOT/taxonomy frame generation mismatches fail independently', async () =>
{
    for (const owner of ['aotReceipt', 'redisFrame', 'database', 'hotRead'])
    {
        const result = await fixture({ readPublication: (proof, identity) =>
        {
            if (!identity.mutationId.endsWith('/cleanup'))
            {
                proof.generations[owner] -= 1;
            }
            return proof;
        } }).run();
        assert.equal(result.status, 'failed', owner);
        assert.match(result.failureKind, new RegExp(`generation-mismatch:${owner}`));
    }
});

test('queue-full with durable marker may complete but keeps admission attempt evidence', async () =>
{
    const persisted = (proof) => ({ ...proof, deliveryResult: 'persisted-dirty', queueFull: true });
    const result = await fixture({
        readObligation: persisted,
        readPublication: (proof) => ({ ...proof, obligation: persisted(proof.obligation) }),
        cleanupCanary: (proof) => ({ ...proof, obligation: persisted(proof.obligation) })
    }).run();
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.cycles[0].deliveryAttempt, { result: 'persisted-dirty', queueFull: true });
    assert.equal(result.cycles[0].steps[5].proof.obligation.attempts.length, 4);
    const missingMarker = await fixture({ readObligation: (proof) => ({ ...proof, queueFull: true }) }).run();
    assert.equal(missingMarker.status, 'failed');
    assert.match(missingMarker.failureKind, /queue-full-without-durable-marker/);
});

test('terminal obligation and recovered worker attempts cannot become clean cycles', async () =>
{
    for (const change of [{ state: 'failed-terminal' }, { state: 'failed-retryable' }, { attemptNumber: 2 }])
    {
        const result = await fixture({ readObligation: (proof) => ({ ...proof, ...change }) }).run();
        assert.equal(result.status, 'failed');
        assert.match(result.failureKind, /obligation-failed|worker-retry/);
        assert.equal(result.cycles[0].cleanup.status, 'ok');
    }
});

test('postcondition waiting re-observes pending state without fixed sleep', async () =>
{
    let pending = true;
    const runtime = fixture({ readPublication: (proof, identity) =>
    {
        if (pending && !identity.mutationId.endsWith('/cleanup'))
        {
            pending = false;
            return { ...proof, state: 'pending' };
        }
        return proof;
    } });
    const result = await runtime.run();
    assert.equal(result.status, 'ok');
    assert.equal(runtime.calls.filter((name) => name === 'publication').length, 5);
    const source = fs.readFileSync(path.join(root, 'tools/test/lanes/soak-cache-churn.mjs'), 'utf8');
    assert.doesNotMatch(source, /\b(?:setTimeout|sleep|delay)\s*\(/u);
    assert.match(source, /waitForPostcondition/u);
    const fixedSleepReceipt = structuredClone(result);
    fixedSleepReceipt.cycles[0].steps[5].name = 'sleep-then-assume-rebuild';
    assert.throws(() => verifyCacheChurnEvidence(fixedSleepReceipt), /steps-incomplete/);
});

test('pending rebuild times out, preserves failed cycle and verifies bounded cleanup', async () =>
{
    const result = await fixture({ readPublication: (proof, identity) => identity.mutationId.endsWith('/cleanup')
        ? proof : { ...proof, state: 'pending' } }).run({ policy: { ...policy, cycleTimeoutMs: 10 } });
    assert.equal(result.status, 'failed');
    assert.match(result.failureKind, /timeout|aborted/iu);
    assert.equal(result.cycles[0].cleanup.status, 'ok');
});

test('unresponsive observation and cleanup calls have explicit deadlines', async () =>
{
    const runtime = fixture();
    runtime.driver.readRevocation = async () => new Promise(() =>
    {});
    const result = await runtime.run({ policy: { ...policy, cycleTimeoutMs: 10 } });
    assert.equal(result.status, 'failed');
    assert.match(result.failureKind, /observation-timeout/);
    assert.equal(result.cycles[0].cleanup.status, 'ok');
    const cleanup = fixture();
    cleanup.driver.cleanupCanary = async () => new Promise(() =>
    {});
    const cleanupResult = await cleanup.run({ policy: { ...policy, cleanupTimeoutMs: 10 } });
    assert.equal(cleanupResult.status, 'failed');
    assert.match(cleanupResult.failureKind, /cleanup:cache-churn-observation-timeout/);
});

test('a later failed cycle fails the entire soak and preserves earlier evidence', async () =>
{
    const result = await fixture({ readObligation: (proof, identity) => identity.cycleId.endsWith('cycle-2')
        ? { ...proof, state: 'failed-terminal' } : proof }).run();
    assert.equal(result.status, 'failed');
    assert.equal(result.cycles.length, 2);
    assert.equal(result.cycles[0].status, 'ok');
    assert.equal(result.cycles[1].status, 'failed');
    assert.equal(result.cycles[1].cleanup.status, 'ok');
});

test('cleanup must publish a new generation and prove absence in every layer', async () =>
{
    for (const owner of ['database', 'redisFrame', 'hotRead', 'aotReceipt'])
    {
        const result = await fixture({ readPublication: (proof, identity) =>
        {
            if (identity.mutationId.endsWith('/cleanup'))
            {
                proof.payloads[owner].present = true;
            }
            return proof;
        } }).run();
        assert.equal(result.status, 'failed', owner);
        assert.equal(result.cycles[0].cleanup.status, 'failed');
        assert.match(result.failureKind, new RegExp(`cleanup:cache-churn-stale-payload:${owner}`));
    }
    const noPublication = await fixture({ cleanupCanary: (proof) => ({ ...proof, committed: false }) }).run();
    assert.equal(noPublication.status, 'failed');
    assert.match(noPublication.failureKind, /cleanup-not-committed/);
});

test('minimum cycles and full window are enforced without shortening duration', async () =>
{
    const insufficient = await fixture().run({ policy: { ...policy, minimumCycles: 3 } });
    assert.equal(insufficient.status, 'failed');
    assert.equal(insufficient.elapsedMs, 100);
    assert.match(insufficient.failureKind, /minimum-cycles/);
    const incomplete = await fixture().run();
    incomplete.elapsedMs = 99;
    assert.throws(() => verifyCacheChurnEvidence(incomplete), /window-incomplete/);
});

test('cross-run evidence, reused IDs and superseded generations fail closed', async () =>
{
    const foreign = await fixture({ readObligation: (proof) => ({ ...proof, runId: 'another-run' }) }).run();
    assert.equal(foreign.status, 'failed');
    assert.match(foreign.failureKind, /identity-mismatch/);
    const reused = await fixture().run();
    reused.cycles[1] = structuredClone(reused.cycles[0]);
    assert.throws(() => verifyCacheChurnEvidence(reused), /identity-reused/);
    const superseded = await fixture({ readPublication: (proof, identity) => identity.mutationId.endsWith('/cleanup')
        ? proof : { ...proof, publishedGeneration: proof.publishedGeneration + 1 } }).run();
    assert.equal(superseded.status, 'failed');
    assert.match(superseded.failureKind, /exact-generation-not-published/);
});

test('cancelled or ambiguous mutation still cleans only its dedicated canary', async () =>
{
    const controller = new AbortController();
    const runtime = fixture({ mutateCanary: () =>
    {
        controller.abort(new Error('fixture-interrupted'));
        throw new Error('fixture-interrupted');
    } });
    const result = await runtime.run({ signal: controller.signal });
    assert.equal(result.status, 'failed');
    assert.match(result.failureKind, /fixture-interrupted/);
    assert.equal(result.cycles[0].cleanup.status, 'ok');
    assert.deepEqual(runtime.calls, ['current', 'mutation', 'cleanup', 'cleanup-publication']);
    const repeated = await fixture().run({ runId: 'next-fixture-run' });
    assert.equal(repeated.status, 'ok');
    assert.notEqual(result.cycles[0].canaryKey, repeated.cycles[0].canaryKey);
});

test('no live observation owner blocks before reads or mutation', async () =>
{
    const runtime = fixture();
    const result = await runtime.run({ driver: null });
    assert.equal(result.status, 'blocked');
    assert.equal(result.failureKind, 'cache-churn-live-observation-owner-unavailable');
    assert.deepEqual(result.cycles, []);
    assert.deepEqual(runtime.calls, []);
});

test('short-soak CLI retains a blocked receipt and cannot declare GET-only churn', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-cache-churn-'));
    try
    {
        const output = path.join(directory, 'summary.json');
        const result = spawnSync(process.execPath, [
            path.join(root, 'tools/test/lanes/runtime-evidence-probe.mjs'), 'soak', 'short', output
        ], {
            cwd: root, encoding: 'utf8', timeout: 10000,
            env: { ...process.env, FSUSBLOG_BASE_URL: 'http://127.0.0.1:1', FSUSBLOG_TEST_NAMESPACE: 'fixture-cli' }
        });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /cache-churn-live-observation-owner-unavailable/);
        const receipt = JSON.parse(fs.readFileSync(output, 'utf8'));
        assert.equal(receipt.status, 'blocked');
        assert.equal(receipt.durationSeconds, 300);
        assert.equal(receipt.countsAsReleaseFinal, false);
        assert.equal(receipt.sampleCount, 0);
        assert.deepEqual(receipt.scenarios, []);
        assert.deepEqual(receipt.probes, []);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('policy cannot omit or zero minimum cycles and deadlines', () =>
{
    assert.throws(() => readCacheChurnPolicy('soakCacheChurn:\n  minimumCycles: 0\n'), /policy-invalid/);
    assert.throws(() => readCacheChurnPolicy(''), /policy-missing/);
    assert.equal(policy.minimumCycles, 2);
});
