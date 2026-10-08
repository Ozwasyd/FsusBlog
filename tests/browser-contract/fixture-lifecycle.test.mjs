import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createProductionBuildReceipt } = await import(new URL("../../tools/ci/production-build-artifacts.mjs", import.meta.url));
const { defaultTimeoutPolicyDigest, qualificationTemporalContext } = await import(new URL("../../tools/test/temporal-context.mjs", import.meta.url));

import {
    createBrowserContractReceipt,
    finalizeBrowserContractReceipt,
    persistFinalBrowserContractReceipt
} from './contract.mjs';
import {
    browserContractFixtureManifestSchema,
    cleanupBrowserContractFixture,
    providerProcessGroupIsOwned,
    prepareBrowserContractFixture,
    resolveBrowserContractRunIdentity
} from './fixture-lifecycle.mjs';
import { fixtureReceiptView, loadBrowserContractFixture } from './fixture.mjs';
import { cleanupSingleBrowserContractFixture } from './prepare-fixture.mjs';


const commit = 'a'.repeat(40);
const sourceState = { commit, worktreeFingerprint: 'b'.repeat(64) };
const build = { receiptContentDigest: `sha256:${'c'.repeat(64)}`, profile: 'production' };
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const browserTemporalContext = qualificationTemporalContext({
    sourceCommit: commit,
    sourceFingerprint: `sha256:${sourceState.worktreeFingerprint}`,
    producerId: 'comment-moderation',
    schedulerRunId: 'run-42-attempt-1',
    businessEpochUtc: '2024-02-29T23:59:59.000Z',
    locale: 'en-US',
    uiLocale: 'en-US',
    timeoutPolicyDigest: defaultTimeoutPolicyDigest()
});

const providerSource = String.raw`#!/usr/bin/env node
import { access, appendFile, chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
if (process.env.FAKE_PROVIDER_LOG) {
  await appendFile(process.env.FAKE_PROVIDER_LOG, request.operation + ':' + (request.phase ?? '') + '\n')
}
if (process.env.FAKE_HANG_OPERATION === request.operation + ':' + (request.phase ?? '')) {
  if (process.env.FAKE_PROVIDER_PID_FILE) await writeFile(process.env.FAKE_PROVIDER_PID_FILE, String(process.pid))
  process.on('SIGTERM', () => {})
  await new Promise(() => {})
}
if (process.env.FAKE_PROVIDER_FAIL === request.operation
  || (process.env.FAKE_CLEANUP_FAIL === '1' && request.operation === 'resetContractNamespace' && request.phase === 'cleanup')) {
  process.stderr.write('requested fake provider failure ' + (process.env.FAKE_PROVIDER_SECRET ?? '') + '\n')
  process.exit(9)
}
if (process.env.FAKE_CLEANUP_FAIL_ONCE_FILE
  && request.operation === 'resetContractNamespace'
  && request.phase === 'cleanup') {
  const marker = process.env.FAKE_CLEANUP_FAIL_ONCE_FILE
  const alreadyFailed = await access(marker).then(() => true).catch(() => false)
  if (!alreadyFailed) {
    await writeFile(marker, 'failed-once\n')
    process.stderr.write('requested one-time fake cleanup failure\n')
    process.exit(9)
  }
}
const root = request.resources.fixtureRoot
await mkdir(root, { recursive: true })
const storage = JSON.stringify({
  cookies: [{ name: 'AccessToken', value: 'secret-token', url: 'http://127.0.0.1:3000', secure: false }],
  origins: []
})
let entity
if (request.operation === 'createPublishedArticle') {
  entity = { id: '101', title: 'Contract article', url: 'http://127.0.0.1:3000/article/101', category: { id: '7', name: 'Contract category' } }
} else if (request.operation === 'createPendingComment') {
  entity = { id: '202', articleId: '101', url: 'http://127.0.0.1:3000/article/101#comment-202' }
} else if (request.operation === 'createUserSession') {
  if (process.env.FAKE_STORAGE_SYMLINK === '1') {
    const outside = root + '-outside-user.json'
    await writeFile(outside, storage, { mode: 0o600 })
    await symlink(outside, root + '/user.storage-state.json')
  } else {
    const storageMode = Number(process.env.FAKE_STORAGE_MODE ?? 0o600)
    await writeFile(root + '/user.storage-state.json', storage, { mode: storageMode })
    // The permission counterexample must survive a restrictive inherited umask.
    await chmod(root + '/user.storage-state.json', storageMode)
  }
  entity = { id: 303, storageStateFile: 'user.storage-state.json', capabilities: { webAuthnRegistration: true } }
} else if (request.operation === 'createAdminSession') {
  await writeFile(root + '/admin.storage-state.json', storage, { mode: 0o600 })
  if (process.env.FAKE_BROKEN_SCENE_LEDGER === '1') {
    await writeFile(root + '/public-shell-locale-scene-bindings.json', '{"invalid":true}', { mode: 0o600 })
  }
  entity = { id: 404, storageStateFile: 'admin.storage-state.json' }
}
process.stdout.write(JSON.stringify({
  schema: 'fsusblog.browser-contract-fixture-provider-response.v1',
  operation: request.operation,
  status: 'ok',
  ...(request.operation === 'resetContractNamespace' ? (request.phase === 'cleanup' ? {
      cleanup: {
        status: 'success',
        resources: {
          database: { status: 'success', instance: request.resources.databaseInstance, id: request.resources.databaseSchema },
          redis: { status: 'success', instance: request.resources.redisInstance, id: request.resources.redisNamespace },
          processes: { status: 'success', terminatedPids: [], skippedPids: [], retainedRuntimeState: false }
        }
      }
    } : {
      runtime: {
        frontendUrl: 'http://127.0.0.1:3000',
        backendUrl: 'http://127.0.0.1:7568',
        ...(
          process.env.FAKE_TEST_SESSION_HEADER === 'missing'
            ? {}
            : { testSessionHeader: process.env.FAKE_TEST_SESSION_HEADER === 'true' }
        )
      },
      ownership: {
        containers: {
          postgres: { name: request.resources.databaseInstance, id: 'd'.repeat(64) },
          redis: { name: request.resources.redisInstance, id: 'e'.repeat(64) }
        }
      }
    }) : {}),
  ...(entity ? { entity } : {})
}))
`;

async function harness(context, overrides = {})
{
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fsus-browser-contract-lifecycle-')));
    context.after(async () =>
    {
        await rm(directory, { recursive: true, force: true });
    });
    const provider = path.join(directory, 'provider.mjs');
    const log = path.join(directory, 'provider.log');
    await writeFile(provider, providerSource, { mode: 0o700 });
    return {
        directory,
        log,
        env: {
            FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-contract',
            FSUSBLOG_BROWSER_CONTRACT_SESSIONS: '1',
            FSUSBLOG_BROWSER_CONTRACT_CONCURRENCY: '1',
            FSUSBLOG_BROWSER_CONTRACT_RUN_ID: 'run-42-attempt-1',
            FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER: provider,
            FSUSBLOG_BROWSER_CONTRACT_FIXTURE_ROOT: path.join(directory, 'fixtures'),
            PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:3000',
            FSUSBLOG_BASE_URL: 'http://127.0.0.1:7568',
            FSUSBLOG_TEMPORAL_CONTEXT_JSON: JSON.stringify(browserTemporalContext),
            FSUSBLOG_TEMPORAL_CONTEXT_FILE: '',
            TZ: 'UTC',
            FAKE_PROVIDER_LOG: log,
            ...overrides
        }
    };
}

async function createRunnerBuildReceipt(directory)
{
    const artifactRoot = path.join(directory, 'immutable-build');
    const domains = [
        ['backend-runtime', 'backend-runtime/server.dll'],
        ['frontend-dist', 'frontend-dist/index.html'],
        ['generated-contracts', 'generated-contracts/contracts.json'],
        ['wasm', 'wasm/aeds.wasm']
    ];
    for (const [, relative] of domains)
    {
        const file = path.join(artifactRoot, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `${relative}\n`);
    }
    createProductionBuildReceipt({
        root: repositoryRoot,
        artifactRoot,
        sourceState,
        producer: { runId: 'browser-contract-cleanup-retry', runAttempt: 1, job: 'fixture-lifecycle-test' },
        inputPaths: ['tests/browser-contract/contract.mjs'],
        toolchain: {
            node: process.version,
            npm: 'test',
            dotnet: 'test',
            vite: 'test',
            vitest: 'test',
            playwright: 'test',
            emsdk: 'test'
        },
        domains: domains.map(([name, relative]) => ({ name, path: relative }))
    });
    return path.join(artifactRoot, 'receipt.json');
}

test('run identity derives isolated database and Redis resources from commit run and lane', async (context) =>
{
    const { directory, env } = await harness(context);
    const identity = resolveBrowserContractRunIdentity({ env, sourceState, repoRoot: directory });
    assert.equal(identity.laneId, 'browser-contract');
    assert.match(identity.namespace, /^bc-aaaaaaaa-[a-f0-9]{10}-[a-f0-9]{6}$/u);
    assert.equal(identity.databaseSchema, 'public');
    assert.equal(identity.databaseInstance, `fsusblog-test-postgres-${identity.namespace}`);
    assert.equal(identity.redisNamespace, `FsusBlog_${identity.namespace}_`);
    assert.equal(identity.redisInstance, `fsusblog-test-redis-${identity.namespace}`);
    assert.equal(identity.fixtureRoot, path.join(directory, 'fixtures', identity.namespace));

});

test('fixture source identity is complete, dedicated, and cannot fall back to GITHUB_SHA', async (context) =>
{
    const { directory, env } = await harness(context);
    const githubOnly = {
        ...env,
        GITHUB_SHA: commit,
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint
    };
    assert.throws(
        () => resolveBrowserContractRunIdentity({ env: githubOnly, repoRoot: directory }),
        /requires complete source commit and worktree fingerprint identity/u
    );
    assert.throws(
        () => resolveBrowserContractRunIdentity({
            env: {
                ...env,
                FSUSBLOG_TEST_SOURCE_COMMIT: commit,
                FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint
            },
            sourceState: { commit },
            repoRoot: directory
        }),
        /requires complete source commit and worktree fingerprint identity/u
    );
    await assert.rejects(
        prepareBrowserContractFixture({
            env: githubOnly,
            repoRoot: directory,
            sourceState: null,
            build
        }),
        /requires complete source commit and worktree fingerprint identity/u
    );

    const dedicatedEnv = {
        ...env,
        GITHUB_SHA: 'f'.repeat(40),
        FSUSBLOG_TEST_SOURCE_COMMIT: commit,
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint
    };
    const prepared = await prepareBrowserContractFixture({
        env: dedicatedEnv,
        repoRoot: directory,
        sourceState: null,
        build
    });
    assert.deepEqual(prepared.manifest.sourceState, sourceState);
    assert.equal(prepared.identity.commit, commit);
    assert.equal((await cleanupBrowserContractFixture(prepared)).status, 'success');
});

test('provider process-group ownership is bound to one invocation before delayed KILL', async (context) =>
{
    const procRoot = await mkdtemp(path.join(os.tmpdir(), 'fsus-browser-contract-provider-proc-'));
    context.after(async () =>
    {
        await rm(procRoot, { recursive: true, force: true });
    });
    const processGroupId = 4123;
    const invocationId = '11111111-1111-4111-8111-111111111111';
    const namespace = 'bc-aaaaaaaa-0123456789-abcdef';
    const fixtureRoot = '/repo/.tmp/browser-contract/fixtures/bc-aaaaaaaa-0123456789-abcdef';
    const writeMember = async (pid, memberInvocationId = invocationId) =>
    {
        const memberRoot = path.join(procRoot, String(pid));
        await mkdir(memberRoot, { recursive: true });
        await writeFile(path.join(memberRoot, 'stat'), `${pid} (provider worker) S 1 ${processGroupId} ${processGroupId}\n`);
        await writeFile(path.join(memberRoot, 'environ'), [
            `FSUSBLOG_BROWSER_CONTRACT_PROVIDER_INVOCATION_ID=${memberInvocationId}`,
            'FSUSBLOG_PLAYWRIGHT_SESSION_MODE=browser-contract',
            `FSUSBLOG_TEST_NAMESPACE=${namespace}`,
            `FSUSBLOG_FIXTURE_ROOT=${fixtureRoot}`,
            ''
        ].join('\0'));
    };
    await writeMember(processGroupId);
    assert.equal(providerProcessGroupIsOwned(processGroupId, {
        invocationId,
        namespace,
        fixtureRoot,
        procRoot
    }), true);

    await writeMember(processGroupId + 1, '22222222-2222-4222-8222-222222222222');
    assert.equal(providerProcessGroupIsOwned(processGroupId, {
        invocationId,
        namespace,
        fixtureRoot,
        procRoot
    }), false);
    assert.equal(providerProcessGroupIsOwned(processGroupId + 10, {
        invocationId,
        namespace,
        fixtureRoot,
        procRoot
    }), false);
});

test('fixture provider must explicitly disable the test-session header', async (context) =>
{
    for (const value of ['missing', 'true'])
    {
        const { directory, env } = await harness(context, { FAKE_TEST_SESSION_HEADER: value });
        let failure;
        await assert.rejects(
            prepareBrowserContractFixture({ env, repoRoot: directory, sourceState, build }),
            (error) =>
            {
                failure = error;
                return /explicitly disable the test-session header/u.test(error.message);
            }
        );
        assert.equal(failure.cleanup.status, 'success');
    }
});

test('single prepare seals stable entities and cleanup is idempotent without leaking storage secrets', async (context) =>
{
    const { directory, env, log } = await harness(context);
    const prepared = await prepareBrowserContractFixture({ env, repoRoot: directory, sourceState, build });
    assert.equal(prepared.manifest.schema, browserContractFixtureManifestSchema);
    assert.equal(prepared.manifest.sealed, true);
    assert.deepEqual(prepared.manifest.topology, { sessions: 1, concurrency: 1 });
    assert.equal(prepared.manifest.resources.databaseSchema, prepared.identity.databaseSchema);
    assert.equal(prepared.manifest.resources.redisNamespace, prepared.identity.redisNamespace);
    assert.equal(prepared.manifest.entities.publicArticle.id, '101');
    assert.equal(prepared.manifest.entities.pendingComment.id, '202');
    assert.equal(prepared.manifest.entities.user.id, 303);
    assert.equal(prepared.manifest.entities.admin.id, 404);
    assert.equal(prepared.manifest.sourceState.commit, commit);
    assert.equal(prepared.manifest.buildIdentity.receiptContentDigest, build.receiptContentDigest);

    const fixture = await loadBrowserContractFixture({
        env: {
            ...env,
            FSUSBLOG_FIXTURE_ROOT: prepared.root,
            FSUSBLOG_TEST_NAMESPACE: prepared.identity.namespace,
            FSUSBLOG_TEST_SESSION: prepared.identity.namespace
        },
        repoRoot: directory,
        fixtureRoot: prepared.root,
        lifecycle: prepared.lifecycle,
        expectedSourceState: sourceState,
        expectedBuild: build
    });
    const receipt = fixtureReceiptView(fixture, directory);
    assert.equal(receipt.databaseSchema, prepared.identity.databaseSchema);
    assert.equal(receipt.redisNamespace, prepared.identity.redisNamespace);
    assert.equal(receipt.pendingCommentId, '202');
    assert.equal(JSON.stringify(receipt).includes('secret-token'), false);

    const first = await cleanupBrowserContractFixture(prepared, { reason: 'success' });
    const second = await cleanupBrowserContractFixture(prepared, { reason: 'ignored-second-call' });
    assert.equal(first, second);
    assert.equal(first.status, 'success');
    assert.equal(first.attempts, 1);
    const operations = (await readFile(log, 'utf8')).trim().split('\n');
    assert.deepEqual(operations, [
        'resetContractNamespace:prepare',
        'createPublishedArticle:',
        'createPendingComment:',
        'createUserSession:',
        'createAdminSession:',
        'resetContractNamespace:cleanup'
    ]);
});

test('prepare failure fails closed, attempts cleanup, and never leaves a sealed manifest', async (context) =>
{
    const { directory, env, log } = await harness(context, { FAKE_PROVIDER_FAIL: 'createPendingComment' });
    await assert.rejects(
        prepareBrowserContractFixture({ env, repoRoot: directory, sourceState, build }),
        /provider failed during createPendingComment/u
    );
    const operations = (await readFile(log, 'utf8')).trim().split('\n');
    assert.deepEqual(operations, [
        'resetContractNamespace:prepare',
        'createPublishedArticle:',
        'createPendingComment:',
        'resetContractNamespace:cleanup'
    ]);
});

test('storage state must be created with exact 0600 permissions', async (context) =>
{
    const { directory, env } = await harness(context, { FAKE_STORAGE_MODE: String(0o640) });
    await assert.rejects(
        prepareBrowserContractFixture({ env, repoRoot: directory, sourceState, build }),
        /permissions must be 0600/u
    );
});

test('cleanup failure is separate, retains recovery state, and remains retryable', async (context) =>
{
    const { directory, env } = await harness(context, { FAKE_CLEANUP_FAIL: '1' });
    const prepared = await prepareBrowserContractFixture({ env, repoRoot: directory, sourceState, build });
    const cleanup = await cleanupBrowserContractFixture(prepared, { reason: 'product-failure' });
    assert.equal(cleanup.status, 'failure');
    assert.equal(cleanup.reason, 'product-failure');
    assert.equal(cleanup.attempts, 1);
    assert.match(cleanup.error.message, /provider failed during resetContractNamespace/u);
    assert.equal(cleanup.resources.files.status, 'retained');
    assert.equal(cleanup.resources.files.evidence.retainedForRetry, true);
    const retried = await cleanupBrowserContractFixture(prepared);
    assert.equal(retried, cleanup);
    assert.equal(retried.attempts, 2);
    assert.equal(retried.status, 'failure');
});

test('prepare failure retains its handle and a failed cleanup retries cleanly without replacing the primary error', async (context) =>
{
    const marker = path.join(os.tmpdir(), `fsus-browser-contract-cleanup-once-${process.pid}-${Date.now()}`);
    await rm(marker, { force: true });
    context.after(async () =>
    {
        await rm(marker, { force: true });
    });
    const { directory, env, log } = await harness(context, {
        FAKE_PROVIDER_FAIL: 'createPendingComment',
        FAKE_CLEANUP_FAIL_ONCE_FILE: marker
    });
    let failure;
    try
    {
        await prepareBrowserContractFixture({ env, repoRoot: directory, sourceState, build });
    }
    catch (error)
    {
        failure = error;
    }

    assert.ok(failure instanceof Error);
    assert.match(failure.message, /provider failed during createPendingComment/u);
    assert.ok(failure.preparedFixture);
    assert.equal(failure.fixtureLifecycle.error.message, failure.message);
    assert.equal(failure.cleanup.status, 'failure');
    assert.equal(failure.cleanup.attempts, 1);
    assert.equal(failure.cleanup.resources.files.status, 'retained');
    assert.equal(failure.cleanup.resources.files.evidence.retainedForRetry, true);
    await access(failure.preparedFixture.root);

    for (const resource of Object.values(failure.cleanup.resources))
    {
        resource.evidence.retainedForRetry = true;
        resource.evidence.staleAttempt = 1;
    }
    const retried = await cleanupBrowserContractFixture(failure.preparedFixture, {
        reason: 'startup-failure-retry'
    });

    assert.equal(retried, failure.cleanup);
    assert.equal(retried.status, 'success');
    assert.equal(retried.reason, 'startup-failure-retry');
    assert.equal(retried.attempts, 2);
    assert.equal(retried.error, null);
    for (const resource of Object.values(retried.resources))
    {
        assert.equal('retainedForRetry' in resource.evidence, false);
        assert.equal('staleAttempt' in resource.evidence, false);
    }
    assert.equal(retried.resources.database.status, 'success');
    assert.equal(retried.resources.redis.status, 'success');
    assert.equal(retried.resources.processes.status, 'success');
    assert.equal(retried.resources.files.status, 'success');
    await assert.rejects(access(failure.preparedFixture.root), { code: 'ENOENT' });
    assert.match(failure.message, /provider failed during createPendingComment/u);
    assert.equal(failure.fixtureLifecycle.error.message, failure.message);

    const operations = (await readFile(log, 'utf8')).trim().split('\n');
    assert.deepEqual(operations, [
        'resetContractNamespace:prepare',
        'createPublishedArticle:',
        'createPendingComment:',
        'resetContractNamespace:cleanup',
        'resetContractNamespace:cleanup'
    ]);
});

test('runner records failed and successful startup cleanup attempts while retaining the primary contract failure', async (context) =>
{
    const marker = path.join(os.tmpdir(), `fsus-browser-contract-runner-cleanup-once-${process.pid}-${Date.now()}`);
    await rm(marker, { force: true });
    context.after(async () =>
    {
        await rm(marker, { force: true });
    });
    const { directory, env } = await harness(context, {
        FAKE_PROVIDER_FAIL: 'createPendingComment',
        FAKE_CLEANUP_FAIL_ONCE_FILE: marker
    });
    const buildReceipt = await createRunnerBuildReceipt(directory);
    const outputRoot = path.join(
        repositoryRoot,
        '.tmp/browser-contract',
        `startup-cleanup-retry-${process.pid}-${Date.now()}`
    );
    context.after(async () =>
    {
        await rm(outputRoot, { recursive: true, force: true });
    });

    const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'tests/browser-contract/run.mjs')], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            ...env,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
            FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT: buildReceipt,
            FSUSBLOG_BROWSER_CONTRACT_OUTPUT: outputRoot,
            FSUSBLOG_BROWSER_CONTRACT_RECEIPT: path.join(outputRoot, 'receipt.json')
        }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /provider failed during createPendingComment/u);
    assert.doesNotMatch(result.stderr, /cleanup failure:/u);
    const receipt = JSON.parse(await readFile(path.join(outputRoot, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'failure');
    assert.equal(receipt.classification, 'contract');
    assert.match(receipt.error.message, /provider failed during createPendingComment/u);
    assert.equal(receipt.fixture.cleanup.status, 'success');
    assert.equal(receipt.fixture.cleanup.attempts, 2);
    assert.deepEqual(receipt.fixture.cleanupAttempts.map((attempt) => attempt.status), ['failure', 'success']);
    assert.equal(receipt.fixture.cleanupAttempts[0].attempts, 1);
    assert.equal(receipt.fixture.cleanupAttempts[0].resources.files.evidence.retainedForRetry, true);
    assert.equal(receipt.fixture.cleanupAttempts[1].attempts, 2);
    assert.equal('retainedForRetry' in receipt.fixture.cleanupAttempts[1].resources.files.evidence, false);
    assert.match(receipt.fixture.lifecycle.error.message, /provider failed during createPendingComment/u);
});

test('runner retains primary failure when every startup cleanup attempt fails', async (context) =>
{
    const { directory, env } = await harness(context, {
        FAKE_PROVIDER_FAIL: 'createPendingComment',
        FAKE_CLEANUP_FAIL: '1'
    });
    const buildReceipt = await createRunnerBuildReceipt(directory);
    const outputRoot = path.join(
        repositoryRoot,
        '.tmp/browser-contract',
        `startup-cleanup-failure-${process.pid}-${Date.now()}`
    );
    context.after(async () =>
    {
        await rm(outputRoot, { recursive: true, force: true });
    });

    const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'tests/browser-contract/run.mjs')], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            ...env,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
            FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT: buildReceipt,
            FSUSBLOG_BROWSER_CONTRACT_OUTPUT: outputRoot,
            FSUSBLOG_BROWSER_CONTRACT_RECEIPT: path.join(outputRoot, 'receipt.json')
        }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /provider failed during createPendingComment/u);
    const receipt = JSON.parse(await readFile(path.join(outputRoot, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'failure');
    assert.equal(receipt.classification, 'contract');
    assert.match(receipt.error.message, /provider failed during createPendingComment/u);
    assert.equal(receipt.fixture.cleanup.status, 'failure');
    assert.deepEqual(receipt.fixture.cleanupAttempts.map((attempt) => attempt.status), ['failure', 'failure']);
    assert.equal(receipt.finalization.primary.status, 'failure');
    assert.equal(receipt.finalization.cleanup.status, 'failure');
    await context.test('prelaunch failure survives rejected startup cleanup and retains the original ledger', async (child) =>
    {
        const owned = await harness(child, { FAKE_BROKEN_SCENE_LEDGER: '1' });
        const ownedBuildReceipt = await createRunnerBuildReceipt(owned.directory);
        const ownedOutputRoot = path.join(repositoryRoot, '.tmp/browser-contract',
            `startup-cleanup-rejected-${process.pid}-${Date.now()}`);
        child.after(() => rm(ownedOutputRoot, { recursive: true, force: true }));
        const execution = spawnSync(process.execPath, [path.join(repositoryRoot, 'tests/browser-contract/run.mjs')], {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                ...owned.env,
                FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
                FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
                FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT: ownedBuildReceipt,
                FSUSBLOG_BROWSER_CONTRACT_OUTPUT: ownedOutputRoot,
                FSUSBLOG_BROWSER_CONTRACT_RECEIPT: path.join(ownedOutputRoot, 'receipt.json')
            }
        });
        assert.notEqual(execution.status, 0);
        const terminal = JSON.parse(await readFile(path.join(ownedOutputRoot, 'receipt.json'), 'utf8'));
        assert.equal(terminal.status, 'failure');
        assert.equal(terminal.topology.browserLaunchCount, 0);
        assert.equal(terminal.finalization.primary.error.message, terminal.error.message);
        assert.doesNotMatch(terminal.error.message, /binding schema is invalid/u);
        assert.equal(terminal.fixture.cleanup.status, 'failure');
        assert.match(terminal.fixture.cleanup.error.message, /binding schema is invalid/u);
        assert.deepEqual(terminal.fixture.cleanupAttempts.map((attempt) => attempt.status), ['failure', 'failure']);
        assert.deepEqual(terminal.fixture.cleanupAttempts.map((attempt) => attempt.attempts), [0, 0]);
        assert.equal(terminal.finalization.cleanup.status, 'failure');
        const identity = resolveBrowserContractRunIdentity({ env: owned.env, sourceState, repoRoot: repositoryRoot });
        assert.equal(await readFile(path.join(identity.fixtureRoot, 'public-shell-locale-scene-bindings.json'), 'utf8'),
            '{"invalid":true}');
        const operations = (await readFile(owned.log, 'utf8')).trim().split('\n');
        assert.equal(operations.filter((operation) => operation === 'resetContractNamespace:cleanup').length, 0);
    });
});

function primaryFailure(message = 'primary contract failure', classification = 'contract')
{
    return {
        status: 'failure',
        classification,
        error: {
            name: 'BrowserContractFailure',
            message,
            failureClass: classification,
            details: { source: 'scenario' },
            stack: null
        }
    };
}

function cleanupOutcome(status, attempts = 1)
{
    return {
        status,
        attempts,
        error: status === 'failure' ? { message: 'cleanup provider failed', classification: 'fixture-provider' } : null,
        resources: {
            database: { status },
            redis: { status },
            processes: { status },
            files: { status }
        }
    };
}

test('terminal state keeps primary and cleanup outcomes independent across failure combinations', async (context) =>
{
    await context.test('rejected scene cleanup retains private state and still finalizes the first failure', async (child) =>
    {
        const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fsus-scene-cleanup-rejected-')));
        child.after(() => rm(directory, { recursive: true, force: true }));
        const ledgerFile = path.join(directory, 'public-shell-locale-scene-bindings.json');
        const raw = JSON.stringify({ schema: 'invalid-scene-ledger' });
        await writeFile(ledgerFile, raw, { mode: 0o600 });
        const prepared = {
            root: directory,
            repoRoot: directory,
            lifecycle: { cleanup: { status: 'pending', attempts: 0, resources: {} } }
        };
        const before = structuredClone(prepared.lifecycle);
        await assert.rejects(cleanupSingleBrowserContractFixture(prepared), /binding schema is invalid/u);
        const cleanup = await cleanupSingleBrowserContractFixture(prepared, {
            reason: 'failure', retainRejection: true
        });
        assert.equal(cleanup.status, 'failure');
        assert.equal(cleanup.attempts, 0);
        assert.equal(cleanup.resources.files.status, 'retained');
        assert.equal(cleanup.resources.files.evidence.retainedForRetry, true);
        assert.deepEqual(prepared.lifecycle, before);
        assert.equal(await readFile(ledgerFile, 'utf8'), raw);
        for (const primary of [
            primaryFailure('first product failure', 'product'),
            primaryFailure('locale scene closure is incomplete', 'contract')
        ])
        {
            const receipt = createBrowserContractReceipt();
            finalizeBrowserContractReceipt(receipt, { primary, cleanup });
            let writes = 0;
            await persistFinalBrowserContractReceipt(receipt, async (terminal) =>
            {
                assert.equal(terminal.error.message, primary.error.message);
                assert.equal(terminal.classification, primary.classification);
                assert.match(terminal.fixture.cleanup.error.message, /binding schema is invalid/u);
                writes += 1;
            });
            assert.equal(writes, 1);
        }
    });
    await context.test('primary failure remains authoritative when every cleanup attempt fails', () =>
    {
        const receipt = createBrowserContractReceipt();
        const firstCleanup = cleanupOutcome('failure', 1);
        const secondCleanup = cleanupOutcome('failure', 2);
        finalizeBrowserContractReceipt(receipt, {
            primary: primaryFailure(),
            cleanup: secondCleanup,
            cleanupAttempts: [firstCleanup, secondCleanup],
            finishedAt: '2026-07-22T00:00:00.000Z',
            wallClockMs: 25
        });

        assert.equal(receipt.status, 'failure');
        assert.equal(receipt.classification, 'contract');
        assert.equal(receipt.error.message, 'primary contract failure');
        assert.equal(receipt.fixture.cleanup.status, 'failure');
        assert.deepEqual(receipt.fixture.cleanupAttempts.map((attempt) => attempt.status), ['failure', 'failure']);
        assert.equal(receipt.finalization.cleanup.error.message, 'cleanup provider failed');
    });

    await context.test('cleanup failure turns a successful primary run into a structured contract failure', () =>
    {
        const receipt = createBrowserContractReceipt();
        finalizeBrowserContractReceipt(receipt, {
            primary: { status: 'success', classification: 'clean', error: null },
            cleanup: cleanupOutcome('failure'),
            finishedAt: '2026-07-22T00:00:00.000Z',
            wallClockMs: 30
        });

        assert.equal(receipt.status, 'failure');
        assert.equal(receipt.classification, 'contract');
        assert.equal(receipt.error.message, 'browser contract fixture cleanup failed');
        assert.equal(receipt.error.details.message, 'cleanup provider failed');
        assert.equal(receipt.finalization.primary.status, 'success');
        assert.equal(receipt.finalization.cleanup.status, 'failure');
    });

    await context.test('runtime product failure remains authoritative after successful cleanup', () =>
    {
        const receipt = createBrowserContractReceipt();
        finalizeBrowserContractReceipt(receipt, {
            primary: primaryFailure('runtime scenario failed', 'product'),
            cleanup: cleanupOutcome('success'),
            finishedAt: '2026-07-22T00:00:00.000Z',
            wallClockMs: 35
        });

        assert.equal(receipt.status, 'failure');
        assert.equal(receipt.classification, 'product');
        assert.equal(receipt.error.message, 'runtime scenario failed');
        assert.equal(receipt.finalization.cleanup.status, 'success');
    });
});

test('terminal finalization is idempotent, rejects conflicts, and persists once after a writer retry', async () =>
{
    const receipt = createBrowserContractReceipt();
    const decision = {
        primary: primaryFailure('stable primary failure'),
        cleanup: cleanupOutcome('success', 2),
        cleanupAttempts: [cleanupOutcome('failure', 1), cleanupOutcome('success', 2)],
        signal: null,
        finishedAt: '2026-07-22T00:00:00.000Z',
        wallClockMs: 40
    };
    assert.equal(finalizeBrowserContractReceipt(receipt, decision), receipt);
    assert.equal(finalizeBrowserContractReceipt(receipt, decision), receipt);
    assert.throws(
        () => finalizeBrowserContractReceipt(receipt, { ...decision, primary: primaryFailure('conflicting failure') }),
        /finalization conflicts/u
    );

    const writes = [];
    await persistFinalBrowserContractReceipt(receipt, async (candidate) =>
    {
        writes.push(JSON.parse(JSON.stringify(candidate.finalization.persistence)));
        if (writes.length === 1)
        {
            throw new Error('simulated first receipt write failure');
        }
    });
    await persistFinalBrowserContractReceipt(receipt, async () =>
    {
        throw new Error('idempotent persistence must not write twice');
    });

    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], { attemptCount: 1, priorFailures: [] });
    assert.equal(writes[1].attemptCount, 2);
    assert.equal(writes[1].priorFailures.length, 1);
    assert.match(writes[1].priorFailures[0].message, /simulated first receipt write failure/u);
});

test('signal finalization after a primary error preserves interruption phase and primary classification', async (context) =>
{
    await context.test('signal before cleanup records the primary infra failure', () =>
    {
        const receipt = createBrowserContractReceipt();
        finalizeBrowserContractReceipt(receipt, {
            primary: primaryFailure('terminated before cleanup', 'infra'),
            cleanup: null,
            signal: 'SIGTERM',
            finishedAt: '2026-07-22T00:00:00.000Z',
            wallClockMs: 10
        });
        assert.equal(receipt.status, 'failure');
        assert.equal(receipt.classification, 'infra');
        assert.equal(receipt.error.message, 'terminated before cleanup');
        assert.equal(receipt.finalization.signal, 'SIGTERM');
        assert.equal(receipt.finalization.cleanup.status, 'not-required');
    });

    await context.test('signal during cleanup retains both primary and cleanup failures', () =>
    {
        const receipt = createBrowserContractReceipt();
        finalizeBrowserContractReceipt(receipt, {
            primary: primaryFailure('terminated during cleanup', 'infra'),
            cleanup: cleanupOutcome('failure'),
            signal: 'SIGINT',
            finishedAt: '2026-07-22T00:00:00.000Z',
            wallClockMs: 15
        });
        assert.equal(receipt.status, 'failure');
        assert.equal(receipt.classification, 'infra');
        assert.equal(receipt.error.message, 'terminated during cleanup');
        assert.equal(receipt.finalization.cleanup.status, 'failure');
        assert.equal(receipt.finalization.cleanup.error.message, 'cleanup provider failed');
    });
});
