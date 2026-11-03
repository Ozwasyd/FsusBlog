import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { runAuthenticatedDast } = await import(new URL('../../tools/security/run-authenticated-dast.mjs', import.meta.url));
const { runLocalRuntimeExposure } = await import(new URL('../../tools/security/check-local-runtime-exposure.mjs', import.meta.url));

// All runtime/network ports are synthetic; every write stays in the owned temp root.
function syntheticInvocation(kind, directory, blockWriter = false)
{
    const outputDirectory = path.join(directory, 'output');
    const outputFile = path.join(outputDirectory, 'summary.json');
    const env = {
        FSUSBLOG_TEST_NAMESPACE: 'outlet-control',
        FSUSBLOG_TEST_RUN_ID: 'outlet-control',
        FSUSBLOG_FIXTURE_ROOT: path.join(directory, 'fixtures'),
        FSUSBLOG_BASE_URL: 'http://127.0.0.1:25001',
        PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:25002',
        FSUSBLOG_RELEASE_PREVIEW_URL: 'http://127.0.0.1:25003',
        FSUSBLOG_POSTGRES_PORT: '25004',
        FSUSBLOG_REDIS_PORT: '25005',
        FSUSBLOG_POSTGRES_CONTAINER_NAME: 'synthetic-pg',
        FSUSBLOG_REDIS_CONTAINER_NAME: 'synthetic-redis'
    };
    const blockOutput = async () =>
    {
        if (blockWriter)
        {
            await writeFile(outputDirectory, 'synthetic writer obstruction');
        }
    };
    if (kind === 'dast')
    {
        return {
            outputFile,
            invoke: (resultOutlet) => runAuthenticatedDast({
                env,
                outputDirectory,
                requestApi: { newContext: () => assert.fail('fixture failure must prevent requests') },
                prepareFixtures: async () =>
                {
                    await blockOutput();
                    throw new Error('fixture-preparation-failed');
                },
                resultOutlet
            })
        };
    }
    const headerValues = {
        'content-security-policy': "default-src 'self'",
        'permissions-policy': 'camera=()',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY'
    };
    return {
        outputFile,
        invoke: async (resultOutlet) =>
        {
            await blockOutput();
            return runLocalRuntimeExposure({
                env,
                outputFile,
                fetchImpl: async () => ({ status: 200, headers: { get: (name) => headerValues[name] } }),
                readListeners: async () => [25001, 25002, 25003]
                    .map((port) => `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:*`).join('\n'),
                inspectBindings: async (container) => container === 'synthetic-pg'
                    ? { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '25004' }] }
                    : { '6379/tcp': [{ HostIp: '127.0.0.1', HostPort: '25005' }] },
                resultOutlet
            });
        }
    };
}

for (const kind of ['dast', 'local-exposure'])
{
    test(`${kind} outlet observes the written original summary and is awaited`, async (t) =>
    {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'security-outlet-'));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const { invoke, outputFile } = syntheticInvocation(kind, directory);
        let observedSummary;
        let callbackCalls = 0;
        let callbackFinished = false;
        const summary = await invoke(async (result) =>
        {
            callbackCalls += 1;
            assert.deepEqual(Object.keys(result).sort(), ['artifactPaths', 'summary']);
            assert.deepEqual(result.artifactPaths, [outputFile]);
            assert.equal(Object.isFrozen(result.artifactPaths), true);
            assert.equal(await readFile(outputFile, 'utf8'), `${JSON.stringify(result.summary, null, 2)}\n`);
            observedSummary = result.summary;
            await Promise.resolve();
            callbackFinished = true;
        });
        assert.equal(callbackCalls, 1);
        assert.equal(callbackFinished, true);
        assert.equal(summary, observedSummary);
        assert.equal(summary.status, kind === 'dast' ? 'failure' : 'ok');
        if (kind === 'dast')
        {
            assert.equal(summary.failureCategory, 'fixture-preparation-failed');
            assert.equal(summary.activeScan.executed, false);
        }
    });

    test(`${kind} outlet rejection propagates after the original artifact is written`, async (t) =>
    {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'security-outlet-'));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const { invoke, outputFile } = syntheticInvocation(kind, directory);
        const outletError = new Error('synthetic outlet failure');
        await assert.rejects(invoke(async () =>
        {
            throw outletError;
        }), (error) => error === outletError);
        const writtenSummary = JSON.parse(await readFile(outputFile, 'utf8'));
        assert.equal(writtenSummary.status, kind === 'dast' ? 'failure' : 'ok');
    });

    test(`${kind} writer failure prevents outlet emission`, async (t) =>
    {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'security-outlet-'));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const { invoke } = syntheticInvocation(kind, directory, true);
        let callbackCalls = 0;
        await assert.rejects(invoke(() =>
        {
            callbackCalls += 1;
        }), { code: 'EEXIST' });
        assert.equal(callbackCalls, 0);
    });
}
