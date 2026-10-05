import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {compensateVerifiedContainerCleanup, deriveLocalPublicContentFixtureSecret, derivePendingCommentPrivacyIdentity, removeVerifiedContainerById, retryLocalRuntimeCleanup, retryVerifiedCleanup, resolveDedicatedRuntimeRunId, validateDefaultFixtureProviderState} = await import(new URL('../browser-contract/default-fixture-provider.mjs', import.meta.url));
const {cleanupBrowserContractFixture, createBrowserContractFixtureApi, prepareBrowserContractFixture, providerProcessGroupIsOwned, resolveBrowserContractRunIdentity} = await import(new URL('../browser-contract/fixture-lifecycle.mjs', import.meta.url));
const {fixtureReceiptView, loadBrowserContractFixture} = await import(new URL('../browser-contract/fixture.mjs', import.meta.url));
const {executionServiceImageReference} = await import(new URL('../../tools/test/execution-envelope-services.mjs', import.meta.url));
const { publicShellLocalePublishedArtifactRequest, validatePublicShellLocalePublishedArtifactResponse } = await import(new URL('../browser-contract/default-fixture-provider.mjs', import.meta.url));
const commit = 'a'.repeat(40);
const fingerprint = 'b'.repeat(64);
const buildDigest = `sha256:${'c'.repeat(64)}`;
const postgresImage = executionServiceImageReference('postgres');
const redisImage = executionServiceImageReference('redis');
const darwinSnapshotScript = fileURLToPath(new URL('../../tools/test/darwin-process-snapshot.py', import.meta.url));

test('published artifact local read derives only the verified runtime tuple and canonical route (Node model)', () =>
{
    const request = {
        identity: { namespace: 'bc-aaaaaaaa-bbbbbbbbbb-cccccc' },
        preparation: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
        sourceState: { commit, worktreeFingerprint: fingerprint },
        build: { receiptContentDigest: buildDigest }, path: '/article/101', locale: 'ja-JP'
    };
    const authority = { runtimeRunId: 'owned-runtime', runtime: {
        frontendUrl: 'http://127.0.0.1:39101', backendUrl: 'http://127.0.0.1:39102'
    } };
    const selection = publicShellLocalePublishedArtifactRequest(request, authority);
    assert.equal(selection.url, 'http://127.0.0.1:39102/__local/public-content-fixture/published-artifact');
    assert.deepEqual(selection.body, {
        namespace: request.identity.namespace, runtimeRunId: authority.runtimeRunId,
        sourceCommit: commit, worktreeFingerprint: fingerprint, buildDigest,
        path: request.path, locale: request.locale
    });
    assert.equal(selection.headers['X-Fsus-Test-Run-Id'], authority.runtimeRunId);
    assert.equal(selection.headers['X-Fsus-Test-Namespace'], request.identity.namespace);
    assert.equal(selection.headers['X-Fsus-Local-Public-Content-Fixture-Secret'],
        deriveLocalPublicContentFixtureSecret(request, authority.runtimeRunId));
    for (const route of ['https://example.invalid/', '//example.invalid/', '/article/101?foreign=1', '/article/101#fragment', '/a/../article/101'])
    {
        assert.throws(() => publicShellLocalePublishedArtifactRequest({ ...request, path: route }, authority), /canonical owned runtime/u);
    }
    for (const backendUrl of ['https://127.0.0.1:39102', 'http://localhost:39102', 'http://127.0.0.1:39102/foreign',
        'http://user:password@127.0.0.1:39102', 'http://127.0.0.1:39102?foreign=1'])
    {
        assert.throws(() => publicShellLocalePublishedArtifactRequest(request, {
            ...authority, runtime: { ...authority.runtime, backendUrl }
        }), /canonical owned runtime/u);
    }
});

test('published artifact read checks embedded producer bytes, current owner and original bytes (Node model)', () =>
{
    const selection = { body: {
        namespace: 'owned-namespace', runtimeRunId: 'owned-runtime', sourceCommit: commit,
        worktreeFingerprint: fingerprint, buildDigest, path: '/article/101', locale: 'ja-JP'
    } };
    const scene = { locale: 'ja-JP', route: 'ArticleDetail' };
    const original = Buffer.from('published non-ASCII original 日本語');
    const observation = {
        schema: 'fsusblog.public-content-published-artifact-observation.v1',
        owner: Object.fromEntries(Object.entries(selection.body).filter(([key]) => !['path', 'locale'].includes(key))),
        route: { path: selection.body.path, locale: scene.locale, kind: scene.route },
        publication: { source: 'server-ssr', generation: 7 },
        originals: [{ role: 'published-artifact', encoding: 'base64', bytes: original.length,
            content: original.toString('base64'), sha256: createHash('sha256').update(original).digest('hex') }]
    };
    const encode = (value) =>
    {
        // Preserve the actual producer's embedded representation, including escaped string bytes.
        const embedded = JSON.stringify(value).replaceAll('+', '\\u002B');
        return Buffer.from(`{"observation":${embedded},"contentDigest":"${createHash('sha256').update(embedded).digest('hex')}"}`);
    };
    assert.deepEqual(validatePublicShellLocalePublishedArtifactResponse(encode(observation), selection, scene), observation);
    for (const key of ['namespace', 'runtimeRunId', 'sourceCommit', 'worktreeFingerprint', 'buildDigest'])
    {
        const changed = structuredClone(observation);
        changed.owner[key] = 'foreign';
        assert.throws(() => validatePublicShellLocalePublishedArtifactResponse(encode(changed), selection, scene), /selected current fixture/u);
    }
    for (const [key, value] of [['path', '/article/102'], ['locale', 'de-DE'], ['kind', 'Home']])
    {
        const changed = structuredClone(observation);
        changed.route[key] = value;
        assert.throws(() => validatePublicShellLocalePublishedArtifactResponse(encode(changed), selection, scene), /selected current fixture/u);
    }
    for (const [key, value] of [['role', 'observed-response'], ['encoding', 'utf8'], ['content', 'not base64'],
        ['bytes', original.length + 1], ['sha256', 'f'.repeat(64)]])
    {
        const changed = structuredClone(observation);
        changed.originals[0][key] = value;
        assert.throws(() => validatePublicShellLocalePublishedArtifactResponse(encode(changed), selection, scene), /original/u);
    }
    for (const source of ['aot-bootstrap', 'foreign', null])
    {
        const changed = structuredClone(observation);
        changed.publication.source = source;
        assert.throws(() => validatePublicShellLocalePublishedArtifactResponse(encode(changed), selection, scene), /selected current fixture/u);
    }
    const changedDigest = encode(observation).toString().replace(/,"contentDigest":"[a-f0-9]+"\}$/u, `,"contentDigest":"${'0'.repeat(64)}"}`);
    assert.throws(() => validatePublicShellLocalePublishedArtifactResponse(Buffer.from(changedDigest), selection, scene), /embedded digest/u);
    assert.throws(() => validatePublicShellLocalePublishedArtifactResponse(Buffer.concat([encode(observation), Buffer.from([255])]), selection, scene), /producer encoding/u);
});

test('published artifact fixture RPC forwards the current owner and only the selected scene/path (Node model)', async (context) =>
{
    const harness = await createHarness(context);
    const identity = resolveBrowserContractRunIdentity({ env: harness.env, sourceState: harness.sourceState, repoRoot: harness.root });
    const preparation = { id: '11111111-1111-4111-8111-111111111111', startedAt: '2026-07-18T00:00:00.000Z' };
    const provider = path.join(harness.root, 'published-artifact-provider.mjs');
    const log = path.join(harness.root, 'published-artifact-request.json');
    await writeFile(provider, `
import { writeFile } from 'node:fs/promises';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
await writeFile(${JSON.stringify(log)}, raw, { mode: 0o600 });
process.stdout.write(JSON.stringify({ schema: 'fsusblog.browser-contract-fixture-provider-response.v1',
    operation: request.operation, status: 'ok', entity: {
        sceneId: request.sceneId, matrixDigest: ${JSON.stringify(buildDigest)}, runtimeRunId: 'owned-runtime',
        artifact: { path: 'explicit-node-model.json', digest: ${JSON.stringify(buildDigest)} }
    } }));
`, { mode: 0o600 });
    const api = createBrowserContractFixtureApi({ identity, sourceState: harness.sourceState, build: harness.build, preparation,
        repoRoot: harness.root, env: { ...harness.env, FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER: provider } });
    const result = await api.readPublicShellLocalePublishedArtifact('current-node-model-scene', '/article/101');
    const request = JSON.parse(await readFile(log, 'utf8'));
    assert.equal(request.operation, 'readPublicShellLocalePublishedArtifact');
    assert.equal(request.sceneId, 'current-node-model-scene');
    assert.equal(request.path, '/article/101');
    assert.deepEqual(request.sourceState, harness.sourceState);
    assert.deepEqual(request.build, harness.build);
    assert.deepEqual(request.preparation, preparation);
    assert.equal(request.identity.namespace, identity.namespace);
    assert.deepEqual(Object.keys(request).sort(), ['build', 'identity', 'operation', 'path', 'preparation', 'resources', 'sceneId', 'schema', 'sourceState']);
    assert.deepEqual(result.artifact, { path: 'explicit-node-model.json', digest: buildDigest });
    assert.equal('originals' in result, false);
    assert.equal('qualificationEligible' in result, false);
});

test('dedicated local public-content fixture secret is deterministic and bound to target ingress', () =>
{
    const request = {
        identity: { namespace: 'bc-aaaaaaaa-bbbbbbbbbb-cccccc' },
        preparation: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
        sourceState: { worktreeFingerprint: fingerprint }
    };
    const secret = deriveLocalPublicContentFixtureSecret(request, 'run-42');
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(deriveLocalPublicContentFixtureSecret(request, 'run-42'), secret);
    assert.notEqual(deriveLocalPublicContentFixtureSecret(request, 'run-43'), secret);
    assert.notEqual(deriveLocalPublicContentFixtureSecret({
        ...request,
        preparation: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }
    }, 'run-42'), secret);
});

async function createHarness(context, extraEnv = {})
{
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fsus-browser-contract-fixture-')));
    context.after(async () =>
    {
        await rm(root, { recursive: true, force: true });
    });
    const providerFile = path.join(root, 'provider.mjs');
    const providerLog = path.join(root, 'provider.jsonl');
    await writeFile(providerFile, `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

let raw = ''
for await (const chunk of process.stdin) raw += chunk
const request = JSON.parse(raw)
await appendFile(process.env.FAKE_PROVIDER_LOG, JSON.stringify(request) + '\\n')
if (process.env.FAKE_PROVIDER_STUBBORN_OPERATION === request.operation) {
  const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    stdio: 'ignore'
  })
  await writeFile(process.env.FAKE_PROVIDER_PID_FILE, JSON.stringify({ provider: process.pid, grandchild: grandchild.pid }))
  process.on('SIGTERM', () => {})
  await new Promise(() => {})
}
if (process.env.FAKE_PROVIDER_TERM_EXIT_OPERATION === request.operation) {
  const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    stdio: 'ignore'
  })
  await writeFile(process.env.FAKE_PROVIDER_PID_FILE, JSON.stringify({ provider: process.pid, grandchild: grandchild.pid }))
  process.on('SIGTERM', () => process.exit(143))
  await new Promise(() => {})
}
if (process.env.FAKE_PROVIDER_DELAY_OPERATION === request.operation) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_PROVIDER_DELAY_MS || 10000)))
}
if (process.env.FAKE_PROVIDER_FAIL_OPERATION === request.operation
  || (request.operation === 'resetContractNamespace'
    && process.env.FAKE_PROVIDER_FAIL_RESET_MARKER
    && existsSync(process.env.FAKE_PROVIDER_FAIL_RESET_MARKER))) {
  process.stderr.write(process.env.FAKE_PROVIDER_FAILURE_STDERR || ('injected provider failure for ' + request.operation + '\\n'))
  process.exit(42)
}

const fixtureRoot = request.resources.fixtureRoot
await mkdir(fixtureRoot, { recursive: true })
let entity
switch (request.operation) {
  case 'createPublishedArticle':
    entity = { id: '101', title: 'Sealed contract article', url: 'http://127.0.0.1:3000/article/101', category: { id: '7', name: 'Contract' } }
    break
  case 'createPendingComment':
    entity = { id: '202', articleId: '101', url: 'http://127.0.0.1:3000/article/101#comment-202' }
    break
  case 'createUserSession':
  case 'createAdminSession': {
    const role = request.operation === 'createUserSession' ? 'user' : 'admin'
    const storageStateFile = role + '.storage-state.json'
    const storageState = JSON.stringify({
      cookies: [{ name: 'AccessToken', value: role + '-token', url: 'http://127.0.0.1:3000', secure: false, httpOnly: true, sameSite: 'Lax' }],
      origins: []
    })
    const storageFile = path.join(fixtureRoot, storageStateFile)
    if (process.env.FAKE_PROVIDER_SYMLINK_ROLE === role) {
      await writeFile(process.env.FAKE_PROVIDER_SYMLINK_TARGET, storageState, { mode: 0o600 })
      await symlink(process.env.FAKE_PROVIDER_SYMLINK_TARGET, storageFile)
    } else {
      await writeFile(storageFile, storageState, { mode: Number(process.env.FAKE_PROVIDER_STORAGE_MODE || 0o600) })
    }
    entity = {
      id: role === 'user' ? 303 : 404,
      storageStateFile,
      ...(role === 'user' ? { capabilities: { webAuthnRegistration: false } } : {})
    }
    break
  }
  case 'resetContractNamespace':
    break
  default:
    process.stderr.write('unsupported operation ' + request.operation + '\\n')
    process.exit(43)
}

process.stdout.write(JSON.stringify({
  schema: 'fsusblog.browser-contract-fixture-provider-response.v1',
  operation: request.operation,
  status: 'ok',
  ...(request.operation === 'resetContractNamespace' ? {
    ...(request.phase === 'prepare' ? {
      runtime: {
        frontendUrl: 'http://127.0.0.1:39101',
        backendUrl: 'http://127.0.0.1:39102',
        testSessionHeader: false
      },
      ownership: {
        containers: {
          postgres: {
            name: request.resources.databaseInstance,
            id: 'd'.repeat(64),
            image: ${JSON.stringify(postgresImage)}
          },
          redis: {
            name: request.resources.redisInstance,
            id: 'e'.repeat(64),
            image: ${JSON.stringify(redisImage)}
          }
        }
      }
    } : {
      cleanup: {
        status: 'success',
        resources: {
          database: { status: 'success', instance: request.resources.databaseInstance, id: request.resources.databaseSchema },
          redis: { status: 'success', instance: request.resources.redisInstance, id: request.resources.redisNamespace },
          processes: { status: 'success', terminatedPids: [], skippedPids: [], retainedRuntimeState: false }
        }
      }
    })
  } : {}),
  ...(entity ? { entity } : {})
}) + '\\n')
`);
    await chmod(providerFile, 0o700);

    const fixtureBase = path.join(root, 'fixtures');
    return {
        root,
        providerLog,
        env: {
            ...process.env,
            FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-contract',
            FSUSBLOG_BROWSER_CONTRACT_SESSIONS: '1',
            FSUSBLOG_BROWSER_CONTRACT_CONCURRENCY: '1',
            FSUSBLOG_BROWSER_CONTRACT_RUN_ID: 'run-42',
            MATRIX_JOB: 'release-final',
            FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER: providerFile,
            FSUSBLOG_BROWSER_CONTRACT_FIXTURE_ROOT: fixtureBase,
            FAKE_PROVIDER_LOG: providerLog,
            ...extraEnv
        },
        sourceState: { commit, worktreeFingerprint: fingerprint },
        build: { receiptContentDigest: buildDigest }
    };
}

async function readProviderRequests(file)
{
    const raw = await readFile(file, 'utf8');
    return raw.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

async function permissionBits(file)
{
    return (await stat(file)).mode & 0o777;
}

function assertCleanupResources(cleanup, expectedStatus = 'success')
{
    assert.deepEqual(Object.keys(cleanup.resources).sort(), ['database', 'files', 'processes', 'redis']);
    for (const name of ['database', 'redis', 'processes', 'files'])
    {
        assert.equal(cleanup.resources[name].status, expectedStatus);
        assert.ok(cleanup.resources[name].evidence && typeof cleanup.resources[name].evidence === 'object');
    }
}

async function waitForJson(file, timeoutMs = 3_000)
{
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline)
    {
        try
        {
            return JSON.parse(await readFile(file, 'utf8'));
        }
        catch
        {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
    throw new Error(`timed out waiting for ${file}`);
}

function processIsAlive(pid)
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch (error)
    {
        if (error?.code === 'ESRCH')
        {
            return false;
        }
        throw error;
    }
}

test('dedicated runtime discards inherited CORS origins before binding its own ports', async () =>
{
    const source = await readFile(
        new URL('../browser-contract/default-fixture-provider.mjs', import.meta.url),
        'utf8');
    const bootstrap = source.match(
        /async function bootstrapDedicatedRuntime[\s\S]+?(?=\nexport async function)/u)?.[0] ?? source;

    assert.match(
        bootstrap,
        /'FSUSBLOG_RELEASE_PREVIEW_URL',\s*\n\s*'CORS_ALLOWED_HOSTS',/u);
    assert.match(
        bootstrap,
        /await run\('bash', \[path\.join\(repoRoot, 'tools', 'bootstrap-acceptance-env\.sh'\)\], \{ env \}\)/u);
});

test('default provider removes only the pre-inspected full container id and refuses a same-name replacement', async () =>
{
    const containerId = 'd'.repeat(64);
    const replacementId = 'e'.repeat(64);
    const name = 'fsusblog-test-postgres-bc-a1b2c3d4-0123456789-abcdef';
    const original = { Id: containerId, Name: `/${name}` };
    const helperInspection = { Id: containerId, Config: { Labels: {} } };
    const replacement = { Id: replacementId, Name: `/${name}` };
    let idRecord = original;
    let nameRecord = original;
    const removalTargets = [];

    const outcome = removeVerifiedContainerById(containerId, {
        name,
        inspected: helperInspection,
        expected: { id: containerId, name },
        inspectById: () => idRecord,
        inspectByName: () => nameRecord,
        removeById: (target) =>
        {
            removalTargets.push(target);
            idRecord = null;
            nameRecord = replacement;
            return { status: 0 };
        }
    });

    assert.deepEqual(removalTargets, [containerId]);
    assert.equal(outcome.removed, false);
    assert.equal(outcome.reason, 'container-name-replaced-after-removal');
    assert.equal(nameRecord.Id, replacementId);

    let mismatchedRemovalCalls = 0;
    const mismatched = removeVerifiedContainerById(containerId, {
        name,
        inspected: { Id: replacementId, Config: { Labels: {} } },
        expected: { id: containerId, name },
        inspectById: () => original,
        inspectByName: () => original,
        removeById: () =>
        {
            mismatchedRemovalCalls += 1;
            return { status: 0 };
        }
    });
    assert.equal(mismatched.removed, false);
    assert.equal(mismatched.reason, 'container-removal-identity-mismatch');
    assert.equal(mismatchedRemovalCalls, 0);

    let vanishedId = original;
    let vanishedName = original;
    const failedCommand = removeVerifiedContainerById(containerId, {
        name,
        inspected: helperInspection,
        expected: { id: containerId, name },
        inspectById: () => vanishedId,
        inspectByName: () => vanishedName,
        removeById: () =>
        {
            vanishedId = null;
            vanishedName = null;
            return { status: 42 };
        }
    });
    assert.deepEqual(failedCommand, {
        removed: false,
        exitCode: 42,
        reason: 'container-remove-command-failed'
    });

    let idempotentRemovalCalls = 0;
    const idempotent = removeVerifiedContainerById(containerId, {
        name,
        inspected: helperInspection,
        expected: { id: containerId, name },
        inspectById: () => null,
        inspectByName: () => null,
        removeById: () =>
        {
            idempotentRemovalCalls += 1;
            return { status: 0 };
        }
    });
    assert.deepEqual(idempotent, { removed: true, exitCode: 0, reason: null });
    assert.equal(idempotentRemovalCalls, 0);

    const source = await readFile(new URL('../browser-contract/default-fixture-provider.mjs', import.meta.url), 'utf8');
    const cleanupSource = source.match(/async function cleanupOwnedRuntime[\s\S]+?(?=\nasync function bootstrapDedicatedRuntime)/u)?.[0];
    assert.ok(cleanupSource, 'owned runtime cleanup must remain statically inspectable');
    assert.match(cleanupSource, /removeContainer:\s*\(containerId,\s*\{ name, inspected \}/u);
    assert.match(cleanupSource, /removeVerifiedContainerById\(containerId/u);
    assert.match(cleanupSource, /inspectContainerIdOptional\(observed\.id\)/u);
    assert.match(cleanupSource, /inspectContainerOptional\(observed\.name\)/u);
    assert.doesNotMatch(cleanupSource, /\['rm',[^\n]+observed\.name/u);
    const localCleanupIndex = cleanupSource.indexOf('cleanupLocalRuntime({');
    const compensationIndex = cleanupSource.indexOf('compensateVerifiedContainerCleanup(observedBefore.values())');
    assert.ok(localCleanupIndex >= 0 && compensationIndex > localCleanupIndex);
    assert.match(
        cleanupSource,
        /result\.retainedRuntimeState[\s\S]*?result\.containerCleanupFailures\.length > 0[\s\S]*?compensationFailures\.length > 0[\s\S]*?retryLocalRuntimeCleanup\(cleanupRuntime\)/u
    );
    assert.match(
        cleanupSource,
        /for \(let attempt = 0; attempt < 4; attempt \+= 1\)[\s\S]*?setTimeout\(resolve, 50 \* \(attempt \+ 1\)\)/u
    );
    assert.match(source, /path\.join\(repoRoot, '\.tmp', 'run-once', namespace\)/u);
    assert.match(cleanupSource, /const filePaths = runtimeRecoveryPaths\(request\)[\s\S]*?confirmedAbsent: retainedFilePaths\.length === 0/u);
    assert.match(cleanupSource, /result\.cleanupStatus === 'complete'[\s\S]*?files\.status === 'success'/u);
    assert.match(cleanupSource, /files,\s*\n\s*buildConsumer\s*\n\s*\}/u);
});

function fakeContainerRuntime(initialContainers)
{
    const byId = new Map();
    const byName = new Map();
    const removalTargets = [];
    for (const container of initialContainers)
    {
        byId.set(container.Id, container);
        byName.set(container.Name.slice(1), container);
    }
    return {
        byId,
        byName,
        removalTargets,
        inspectById: (id) => byId.get(id) ?? null,
        inspectByName: (name) => byName.get(name) ?? null,
        removeById: (id) =>
        {
            removalTargets.push(id);
            const container = byId.get(id);
            if (container)
            {
                byId.delete(id);
                byName.delete(container.Name.slice(1));
            }
            return { status: 0 };
        }
    };
}

test('provider compensation removes verified full IDs when the runtime env inventory is missing or partial', () =>
{
    const postgres = {
        Id: 'd'.repeat(64),
        Name: '/fsusblog-test-postgres-bc-a1b2c3d4-0123456789-abcdef'
    };
    const redis = {
        Id: 'e'.repeat(64),
        Name: '/fsusblog-test-redis-bc-a1b2c3d4-0123456789-abcdef'
    };

    // A missing env file means local-runtime cleanup discovers neither container.
    const missing = fakeContainerRuntime([postgres, redis]);
    const missingOutcomes = compensateVerifiedContainerCleanup([postgres, redis], missing);
    assert.deepEqual(missing.removalTargets, [postgres.Id, redis.Id]);
    assert.deepEqual(missingOutcomes.map((entry) => entry.removed), [true, true]);
    assert.equal(missing.byId.size, 0);
    assert.equal(missing.byName.size, 0);

    // A partially written env file may let local-runtime cleanup remove only one.
    const partial = fakeContainerRuntime([redis]);
    const partialOutcomes = compensateVerifiedContainerCleanup([postgres, redis], partial);
    assert.deepEqual(partial.removalTargets, [redis.Id]);
    assert.deepEqual(partialOutcomes.map((entry) => entry.removed), [true, true]);
    assert.equal(partial.byId.size, 0);
    assert.equal(partial.byName.size, 0);
});

test('provider compensation refuses a same-name replacement and allows a later full-ID retry', () =>
{
    const original = {
        Id: 'd'.repeat(64),
        Name: '/fsusblog-test-postgres-bc-a1b2c3d4-0123456789-abcdef'
    };
    const replacement = { Id: 'f'.repeat(64), Name: original.Name };
    const replaced = fakeContainerRuntime([replacement]);
    const refusal = compensateVerifiedContainerCleanup([original], replaced);
    assert.equal(refusal[0].removed, false);
    assert.equal(refusal[0].reason, 'container-name-replaced-before-removal');
    assert.deepEqual(replaced.removalTargets, []);
    assert.equal(replaced.byId.get(replacement.Id), replacement);

    const retryable = fakeContainerRuntime([original]);
    let failFirstRemoval = true;
    const removeById = (id) =>
    {
        retryable.removalTargets.push(id);
        if (failFirstRemoval)
        {
            failFirstRemoval = false;
            return { status: 42 };
        }
        const container = retryable.byId.get(id);
        retryable.byId.delete(id);
        retryable.byName.delete(container.Name.slice(1));
        return { status: 0 };
    };
    const first = compensateVerifiedContainerCleanup([original], { ...retryable, removeById });
    assert.equal(first[0].removed, false);
    assert.equal(first[0].exitCode, 42);
    assert.equal(first[0].reason, 'container-id-survived-removal');
    assert.equal(retryable.byId.get(original.Id), original);

    const second = compensateVerifiedContainerCleanup([original], { ...retryable, removeById });
    assert.equal(second[0].removed, true);
    assert.equal(second[0].reason, null);
    assert.deepEqual(retryable.removalTargets, [original.Id, original.Id]);
    assert.equal(retryable.byId.size, 0);
    assert.equal(retryable.byName.size, 0);
});

test('verified runtime cleanup retries transient provider failures with bounded backoff', async () =>
{
    let attempts = 0;
    const delays = [];
    const result = await retryVerifiedCleanup(async () =>
    {
        attempts += 1;
        if (attempts < 3)
        {
            throw new Error('transient cleanup race');
        }
        return { status: 'success' };
    }, {
        delay: async (milliseconds) =>
        {
            delays.push(milliseconds);
        }
    });
    assert.deepEqual(result, { status: 'success' });
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [100, 200]);

    attempts = 0;
    await assert.rejects(
        retryVerifiedCleanup(async () =>
        {
            attempts += 1;
            throw new Error('persistent cleanup failure');
        }, { attempts: 2, delay: async () =>
        {} }),
        /persistent cleanup failure/u
    );
    assert.equal(attempts, 2);
});

test('local runtime cleanup retries only transient filesystem races', async () =>
{
    let attempts = 0;
    const delays = [];
    const result = await retryLocalRuntimeCleanup(() =>
    {
        attempts += 1;
        if (attempts < 3)
        {
            const error = new Error('runtime directory is still draining');
            error.code = 'ENOTEMPTY';
            throw error;
        }
        return { cleanupStatus: 'complete' };
    }, {
        delay: async (milliseconds) =>
        {
            delays.push(milliseconds);
        }
    });
    assert.deepEqual(result, { cleanupStatus: 'complete' });
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [50, 100]);

    attempts = 0;
    await assert.rejects(
        retryLocalRuntimeCleanup(() =>
        {
            attempts += 1;
            const error = new Error('ownership mismatch');
            error.code = 'EPERM';
            throw error;
        }, { delay: async () =>
        {} }),
        /ownership mismatch/u
    );
    assert.equal(attempts, 1);
});

test('pending comment fixture uses deterministic ZK privacy fields and resets every identity linkage on conflict', async () =>
{
    const namespace = 'bc-a1b2c3d4-0123456789-abcdef';
    const first = derivePendingCommentPrivacyIdentity(namespace, '101');
    const repeated = derivePendingCommentPrivacyIdentity(namespace, '101');
    const otherNamespace = derivePendingCommentPrivacyIdentity('bc-a1b2c3d4-0123456789-fedcba', '101');
    const otherArticle = derivePendingCommentPrivacyIdentity(namespace, '102');
    assert.deepEqual(repeated, first);
    assert.equal(first.nullifierHash, createHash('sha256')
        .update(`browser-contract:nullifier:${namespace}:101`)
        .digest('hex'));
    assert.equal(first.moderationSubjectHash, createHash('sha256')
        .update(`browser-contract:moderation:${namespace}:101`)
        .digest('hex'));
    assert.match(first.nullifierHash, /^[a-f0-9]{64}$/u);
    assert.match(first.moderationSubjectHash, /^[a-f0-9]{64}$/u);
    assert.notEqual(first.nullifierHash, first.moderationSubjectHash);
    assert.notEqual(otherNamespace.nullifierHash, first.nullifierHash);
    assert.notEqual(otherNamespace.moderationSubjectHash, first.moderationSubjectHash);
    assert.notEqual(otherArticle.nullifierHash, first.nullifierHash);
    assert.notEqual(otherArticle.moderationSubjectHash, first.moderationSubjectHash);
    assert.match(first.anonymousHandle, /^bc-[a-f0-9]{16}$/u);
    assert.throws(() => derivePendingCommentPrivacyIdentity(namespace, '0'), /article id/iu);
    assert.throws(() => derivePendingCommentPrivacyIdentity(namespace, '01'), /article id/iu);

    const source = await readFile(new URL('../browser-contract/default-fixture-provider.mjs', import.meta.url), 'utf8');
    const pendingSource = source.match(/async function pendingComment[\s\S]+?(?=\nasync function respond)/u)?.[0];
    assert.ok(pendingSource, 'pending comment provider implementation must remain statically inspectable');
    const valuesIndex = pendingSource.indexOf(') VALUES (');
    const conflictIndex = pendingSource.indexOf(') ON CONFLICT (id) DO UPDATE SET');
    assert.ok(valuesIndex > 0 && conflictIndex > valuesIndex);
    const insertColumns = pendingSource.slice(0, valuesIndex);
    const insertValues = pendingSource.slice(valuesIndex, conflictIndex);
    const conflictUpdate = pendingSource.slice(conflictIndex);

    for (const column of [
        'user_id',
        'author_mode',
        'public_handle',
        'credential_level',
        'reputation_bucket',
        'account_age_bucket',
        'anonymous_rate_class',
        'anonymous_requires_moderation',
        'parent_id',
        'root_id',
        'reply_to_user_id',
        'reply_to_comment_id',
        'delete_reason',
        'delete_time',
        'moderated_by_admin_principal_id',
        'moderated_at'
    ])
    {
        assert.match(insertColumns, new RegExp(`\\b${column}\\b`, 'u'));
    }
    assert.match(insertValues, /NULL, 'zk_anonymous', NULL/iu);
    assert.match(insertValues, /NULL, NULL, NULL, 'common', true/iu);
    assert.match(insertValues, /\$\{privacy\.nullifierHash\}/u);
    assert.match(insertValues, /\$\{privacy\.moderationSubjectHash\}/u);
    assert.doesNotMatch(insertValues, /'basic'\s*,\s*'fixture'\s*,\s*'fixture'/iu);

    for (const field of [
        'user_id',
        'author_mode',
        'public_handle',
        'anonymous_handle',
        'anonymous_display_name',
        'anonymous_display_language',
        'anonymous_nullifier_hash',
        'anonymous_scope',
        'moderation_subject_hash',
        'credential_level',
        'reputation_bucket',
        'account_age_bucket',
        'anonymous_rate_class',
        'anonymous_requires_moderation',
        'parent_id',
        'root_id',
        'reply_to_user_id',
        'reply_to_comment_id',
        'depth',
        'is_deleted',
        'delete_reason',
        'delete_time',
        'moderation_status',
        'moderation_reason',
        'moderated_by_admin_principal_id',
        'moderated_at'
    ])
    {
        assert.match(conflictUpdate, new RegExp(`\\b${field}\\s*=`, 'u'));
    }
    assert.match(conflictUpdate, /credential_level\s*=\s*NULL/iu);
    assert.match(conflictUpdate, /reputation_bucket\s*=\s*NULL/iu);
    assert.match(conflictUpdate, /account_age_bucket\s*=\s*NULL/iu);
    assert.match(conflictUpdate, /anonymous_requires_moderation\s*=\s*true/iu);
});

async function waitForProcessExit(pid, timeoutMs = 3_000)
{
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline)
    {
        if (!processIsAlive(pid))
        {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`process ${pid} survived the provider TERM-to-KILL budget`);
}

function darwinRawEnvironment(entries, providerBindings = true, sizeOverride = null, asSnapshot = false)
{
    const script = `
import base64, ctypes, importlib.util, json, struct, sys, types
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("snapshot", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
entries = [base64.b64decode(value) for value in json.loads(sys.stdin.read())]
raw = struct.pack("=i", 1) + b"/owned/python\\0\\0python\\0" + b"\\0".join(entries) + b"\\0"
size_override = json.loads(sys.argv[3])
def sysctl(mib, count, buffer, size, replacement, replacement_size):
    ctypes.cast(size, ctypes.POINTER(ctypes.c_size_t))[0] = len(raw) if size_override is None else size_override
    if buffer is not None:
        ctypes.memmove(buffer, raw, len(raw))
    return 0
module.ctypes.CDLL = lambda *args, **kwargs: types.SimpleNamespace(sysctl=sysctl)
provider_bindings = sys.argv[2] == "true"
if sys.argv[4] == "true":
    module.os.getpgid = lambda pid: 1080
    module.os.getsid = lambda pid: 1080
    module.process_start_identity = lambda pid: "1080000001"
    module.sys.argv = [sys.argv[1], "1080"] + (["--provider-bindings"] if provider_bindings else [])
    module.main()
else:
    print(json.dumps(module.process_environment(1080, provider_bindings=provider_bindings)))
`;
    return JSON.parse(execFileSync('/usr/bin/python3', ['-c', script, darwinSnapshotScript,
        String(providerBindings), JSON.stringify(sizeOverride), String(asSnapshot)], {
        input: JSON.stringify(entries.map((entry) => Buffer.from(entry).toString('base64'))),
        encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']
    }));
}

function macProviderOwnershipModel()
{
    const groupId = 1080;
    const invocationId = '11111111-1111-4111-8111-111111111111';
    const namespace = 'bc-aaaaaaaa-0123456789-abcdef';
    const fixtureRoot = '/owned fixture/root';
    const members = new Map([groupId, groupId + 1].map((pid) => [pid, {
        start: `${pid}:000001`,
        command: `${process.execPath} provider-${pid}`,
        environment: [
            `FSUSBLOG_BROWSER_CONTRACT_PROVIDER_INVOCATION_ID=${invocationId}`,
            'FSUSBLOG_PLAYWRIGHT_SESSION_MODE=browser-contract',
            `FSUSBLOG_TEST_NAMESPACE=${namespace}`,
            `FSUSBLOG_FIXTURE_ROOT=${fixtureRoot}`,
            'UNRELATED=opaque'
        ]
    }]));
    const state = { members, exitLeader: false, changeOnEnvironment: null, queryFailure: false, snapshotOverride: {} };
    const execute = (file, args) =>
    {
        if (file === 'ps' && args[0] === '-axo')
        {
            return [...members.keys()].filter((pid) => !state.exitLeader || pid !== groupId)
                .map((pid) => `${pid} ${groupId}`).join('\n');
        }
        const snapshotRequest = file === '/usr/bin/python3' && args[0] === darwinSnapshotScript;
        const pid = Number(snapshotRequest ? args[1] : (file === 'ps' ? args[args.indexOf('-p') + 1] : args.at(-1)));
        const member = members.get(pid);
        if (!member || (state.exitLeader && pid === groupId))
        {
            throw Object.assign(new Error('model process exited'), { code: 'ESRCH' });
        }
        if (snapshotRequest)
        {
            assert.equal(args[2], '--provider-bindings');
            if (state.queryFailure)
            {
                throw new Error('model environment unavailable');
            }
            if (state.changeOnEnvironment === pid)
            {
                member.start = `${pid}:000002`;
            }
            return JSON.stringify({ processGroupId: groupId, sessionId: groupId,
                startTimeTicks: String(BigInt(member.start.replace(':', ''))),
                environment: darwinRawEnvironment(member.environment), ...state.snapshotOverride });
        }
        if (file === '/usr/bin/python3')
        {
            return args[1].includes('proc_pidpath') ? process.execPath : member.start;
        }
        assert.equal(file, 'ps');
        assert.equal(args[0], '-ww');
        return `${member.command}\n`;
    };
    const options = {
        invocationId, namespace, fixtureRoot, execute,
        processGroupIdentity: {
            schema: 'fsusblog.process-group-or-job-identity.v1', platform: 'darwin', kind: 'process-group',
            groupId, leaderPid: groupId, leaderProcessStartIdentity: `darwin:${groupId}:000001`
        }
    };
    assert.equal(providerProcessGroupIsOwned(groupId, options), true, 'initial native model must prove ownership');
    return { groupId, options, state, owned: () => providerProcessGroupIsOwned(groupId, options) };
}

test('Mac provider ownership verifies native members and retains authority after leader exit (Node model)', () =>
{
    const model = macProviderOwnershipModel();
    assert.equal(model.owned(), true);
    model.state.exitLeader = true;
    assert.equal(model.owned(), true);
    const originalStartIdentity = model.options.processGroupIdentity.leaderProcessStartIdentity;
    delete model.options.processGroupIdentity.leaderProcessStartIdentity;
    assert.equal(model.owned(), false);
    model.options.processGroupIdentity.leaderProcessStartIdentity = originalStartIdentity;
    model.state.members.delete(model.groupId + 1);
    assert.equal(model.owned(), false);
});

test('Mac provider ownership rejects every foreign or missing task label (Node model)', () =>
{
    for (const key of ['FSUSBLOG_BROWSER_CONTRACT_PROVIDER_INVOCATION_ID', 'FSUSBLOG_PLAYWRIGHT_SESSION_MODE',
        'FSUSBLOG_TEST_NAMESPACE', 'FSUSBLOG_FIXTURE_ROOT'])
    {
        for (const replacement of [`${key}=foreign`, ''])
        {
            const model = macProviderOwnershipModel();
            const member = model.state.members.get(model.groupId + 1);
            member.environment = member.environment.map((entry) => entry.startsWith(`${key}=`) ? replacement : entry);
            assert.equal(model.owned(), false, `${key}: ${replacement || 'missing'}`);
        }
    }
});

test('Mac provider ownership rejects argv label spoofing and duplicate environment labels (Node model)', () =>
{
    const model = macProviderOwnershipModel();
    const member = model.state.members.get(model.groupId + 1);
    member.command += ` ${member.environment.join(' ')}`;
    member.environment = ['UNRELATED=opaque'];
    assert.equal(model.owned(), false);
    const duplicate = macProviderOwnershipModel();
    duplicate.state.members.get(duplicate.groupId + 1).environment.push(`FSUSBLOG_TEST_NAMESPACE=${duplicate.options.namespace}`);
    assert.equal(duplicate.owned(), false);
});

test('Mac provider ownership rejects expected labels embedded inside one unrelated NOTE environment value (Node model)', () =>
{
    const model = macProviderOwnershipModel();
    const member = model.state.members.get(model.groupId + 1);
    // The real NUL-delimited environment has only NOTE; ps eww loses that value boundary.
    member.environment = [`NOTE=unrelated ${member.environment.join(' ')}`];
    assert.equal(model.owned(), false, 'labels inside NOTE are not four actual environment entries');
});

test('Mac provider ownership rejects reused native identities and unknown environment reads (Node model)', () =>
{
    const reusedLeader = macProviderOwnershipModel();
    reusedLeader.state.members.get(reusedLeader.groupId).start = `${reusedLeader.groupId}:000002`;
    assert.equal(reusedLeader.owned(), false);
    const changedMember = macProviderOwnershipModel();
    changedMember.state.changeOnEnvironment = changedMember.groupId + 1;
    assert.equal(changedMember.owned(), false);
    const unknown = macProviderOwnershipModel();
    unknown.state.queryFailure = true;
    assert.equal(unknown.owned(), false);
    assert.equal(providerProcessGroupIsOwned(unknown.groupId + 1, unknown.options), false);
    for (const [key, value] of [['processGroupId', 999], ['sessionId', 999], ['startTimeTicks', '999']])
    {
        const foreignMetadata = macProviderOwnershipModel();
        foreignMetadata.state.snapshotOverride[key] = value;
        assert.equal(foreignMetadata.owned(), false, key);
    }
});

test('Darwin canonical NUL provider mode rejects duplicates, invalid UTF8, controls and over-budget allocation (Node model)', () =>
{
    const model = macProviderOwnershipModel();
    const entries = model.state.members.get(model.groupId).environment;
    const selected = darwinRawEnvironment([...entries, 'FSUSBLOG_PRIVATE_TEST_SECRET=opaque']);
    assert.deepEqual(Object.keys(selected).sort(), entries.slice(0, 4).map((entry) => entry.slice(0, entry.indexOf('='))).sort());
    for (const invalid of [
        [...entries, entries[0]],
        [...entries.slice(0, 3), Buffer.concat([Buffer.from('FSUSBLOG_FIXTURE_ROOT=/owned'), Buffer.from([255])])],
        [...entries.slice(0, 3), 'FSUSBLOG_FIXTURE_ROOT=/owned\nforeign'],
        [...entries, Buffer.from([255])]
    ])
    {
        assert.throws(() => darwinRawEnvironment(invalid));
    }
    assert.throws(() => darwinRawEnvironment(entries, true, 1024 * 1024 + 1), /bounded snapshot size/u);
    assert.throws(() => darwinRawEnvironment(entries, true, 0), /bounded snapshot size/u);
    assert.throws(() => darwinRawEnvironment([
        ...entries.slice(0, 3), `FSUSBLOG_FIXTURE_ROOT=/${'\u2028'.repeat(180_000)}`
    ], true, null, true), (error) =>
    {
        assert.match(String(error.stderr), /provider snapshot output exceeds the bounded size/u);
        assert.equal(error.stdout, '');
        return true;
    });
    const defaultEnvironment = darwinRawEnvironment([...entries, `${entries[0].split('=')[0]}=last`, 'FSUSBLOG_PRIVATE_TEST_SECRET=opaque'], false);
    assert.equal(defaultEnvironment.FSUSBLOG_BROWSER_CONTRACT_PROVIDER_INVOCATION_ID, 'last');
    assert.equal(defaultEnvironment.FSUSBLOG_PRIVATE_TEST_SECRET, 'opaque');
    const defaultInvalidUtf8 = darwinRawEnvironment([
        ...entries.slice(0, 3), Buffer.concat([Buffer.from('FSUSBLOG_FIXTURE_ROOT=/owned'), Buffer.from([255])])
    ], false);
    assert.equal(defaultInvalidUtf8.FSUSBLOG_FIXTURE_ROOT, `/owned${String.fromCharCode(0xDCFF)}`);
});

function nativeDarwinSnapshot(entries, { providerBindings = true, spoofArgv = false, extraArguments = [] } = {})
{
    // execve preserves duplicate/invalid-byte env entries in the actual kernel NUL snapshot.
    const target = 'import os,runpy,sys;sys.dont_write_bytecode=True;'
        + `sys.argv=[${JSON.stringify(darwinSnapshotScript)},str(os.getpid())]`
        + (providerBindings ? '+["--provider-bindings"]' : '')
        + `+${JSON.stringify(extraArguments)};runpy.run_path(${JSON.stringify(darwinSnapshotScript)},run_name="__main__")`;
    const bootstrap = `
import base64, ctypes, json, os, sys
arguments = [b"/usr/bin/python3", b"-c", sys.argv[1].encode("utf-8")]
if sys.argv[3] == "true":
    arguments.extend(base64.b64decode(value) for value in json.loads(sys.argv[2]))
environment = [base64.b64decode(value) for value in json.loads(sys.argv[2])]
argv = (ctypes.c_char_p * (len(arguments) + 1))(*arguments, None)
envp = (ctypes.c_char_p * (len(environment) + 1))(*environment, None)
libc = ctypes.CDLL("/usr/lib/libc.dylib", use_errno=True)
libc.execve.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_char_p), ctypes.POINTER(ctypes.c_char_p)]
libc.execve.restype = ctypes.c_int
if libc.execve(arguments[0], argv, envp) != 0:
    raise OSError(ctypes.get_errno(), "owned snapshot execve failed")
`;
    return spawnSync('/usr/bin/python3', ['-c', bootstrap, target,
        JSON.stringify(entries.map((entry) => Buffer.from(entry).toString('base64'))), String(spoofArgv)], {
        encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe']
    });
}

// Only Darwin has KERN_PROCARGS2; raw-NUL fixture coverage above never loads Darwin libraries.
if (process.platform === 'darwin')
{
    test('Darwin provider snapshot reads actual kernel NUL boundaries and rejects NOTE, duplicate, invalid and argv bindings', () =>
    {
        const entries = macProviderOwnershipModel().state.members.get(1080).environment;
        const positive = nativeDarwinSnapshot([...entries, 'FSUSBLOG_PRIVATE_TEST_SECRET=opaque']);
        assert.equal(positive.status, 0, positive.stderr);
        const snapshot = JSON.parse(positive.stdout);
        assert.ok(Number.isInteger(snapshot.processGroupId));
        assert.ok(Number.isInteger(snapshot.sessionId));
        assert.match(snapshot.startTimeTicks, /^\d+$/u);
        assert.deepEqual(snapshot.environment, darwinRawEnvironment(entries));
        assert.equal('FSUSBLOG_PRIVATE_TEST_SECRET' in snapshot.environment, false);
        const negatives = [
            { entries: [`NOTE=unrelated ${entries.join(' ')}`] },
            { entries: [...entries, entries[0]] },
            { entries: [...entries.slice(0, 3), Buffer.concat([Buffer.from('FSUSBLOG_FIXTURE_ROOT=/owned'), Buffer.from([255])])] },
            { entries: [...entries.slice(0, 3), 'FSUSBLOG_FIXTURE_ROOT=/owned\nforeign'] },
            { entries: [`NOTE=unrelated ${entries.join(' ')}`], options: { spoofArgv: true } },
            { entries, options: { extraArguments: ['--unknown'] } },
            { entries, options: { extraArguments: ['--provider-bindings'] } }
        ];
        for (const negative of negatives)
        {
            const result = nativeDarwinSnapshot(negative.entries, negative.options);
            assert.equal(result.error, undefined);
            assert.equal(result.status, 1, result.stderr);
            assert.equal(result.stdout, '');
        }
        const defaultResult = nativeDarwinSnapshot([...entries, `${entries[0].split('=')[0]}=last`, 'FSUSBLOG_PRIVATE_TEST_SECRET=opaque'], {
            providerBindings: false
        });
        assert.equal(defaultResult.status, 0, defaultResult.stderr);
        const defaultSnapshot = JSON.parse(defaultResult.stdout);
        assert.equal(defaultSnapshot.environment.FSUSBLOG_BROWSER_CONTRACT_PROVIDER_INVOCATION_ID, 'last');
        assert.equal(defaultSnapshot.environment.FSUSBLOG_PRIVATE_TEST_SECRET, 'opaque');
    });
}

test('run identity is immutable and fixed at one session/concurrency regardless of live resource hints', async (context) =>
{
    const harness = await createHarness(context, {
        FSUSBLOG_PLAYWRIGHT_WORKERS: '64',
        FSUSBLOG_SCHEDULER_CPU_GRANT: '64',
        FSUSBLOG_SCHEDULER_MEMORY_GRANT: '128',
        FSUSBLOG_POSTGRES_PID_HEADROOM: '999'
    });
    const identity = resolveBrowserContractRunIdentity({
        env: harness.env,
        sourceState: harness.sourceState,
        repoRoot: harness.root,
        now: new Date('2026-07-18T00:00:00.000Z')
    });

    assert.equal(identity.sessionMode, 'browser-contract');
    assert.equal(identity.sessions, 1);
    assert.equal(identity.concurrency, 1);
    assert.equal(identity.commit, commit);
    assert.equal(identity.runId, 'run-42');
    assert.equal(identity.laneId, 'browser-contract');
    assert.match(identity.namespace, /^[a-z0-9_-]+$/u);
    assert.equal(identity.databaseSchema, 'public');
    assert.equal(identity.databaseInstance, `fsusblog-test-postgres-${identity.namespace}`);
    assert.ok(identity.redisNamespace.includes(identity.namespace));
    assert.equal(identity.redisInstance, `fsusblog-test-redis-${identity.namespace}`);
    assert.ok(path.resolve(identity.fixtureRoot).startsWith(path.resolve(harness.root)));

    const repeated = resolveBrowserContractRunIdentity({
        env: { ...harness.env, FSUSBLOG_PLAYWRIGHT_WORKERS: '1', FSUSBLOG_SCHEDULER_MEMORY_GRANT: '1' },
        sourceState: harness.sourceState,
        repoRoot: harness.root,
        now: new Date('2030-01-01T00:00:00.000Z')
    });
    assert.deepEqual(repeated, identity);
});

test('contract topology and session mode reject widening instead of falling back', async (context) =>
{
    const harness = await createHarness(context);
    for (const override of [
        { FSUSBLOG_BROWSER_CONTRACT_SESSIONS: '2' },
        { FSUSBLOG_BROWSER_CONTRACT_CONCURRENCY: '2' },
        { FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-diagnostics' }
    ])
    {
        assert.throws(() => resolveBrowserContractRunIdentity({
            env: { ...harness.env, ...override },
            sourceState: harness.sourceState,
            repoRoot: harness.root
        }), /browser contract|session|concurrency|mode/iu);
    }
});

test('formal fixture API sends only stable run identity and isolated resources to its provider', async (context) =>
{
    const harness = await createHarness(context);
    const preparation = Object.freeze({
        id: '11111111-1111-4111-8111-111111111111',
        startedAt: '2026-07-18T00:00:00.000Z'
    });
    const identity = resolveBrowserContractRunIdentity({
        env: harness.env,
        sourceState: harness.sourceState,
        repoRoot: harness.root
    });
    const api = createBrowserContractFixtureApi({
        identity,
        env: harness.env,
        repoRoot: harness.root,
        sourceState: harness.sourceState,
        build: harness.build,
        preparation
    });

    assert.deepEqual(Object.keys(api).sort(), [
        'createAdminSession',
        'createPendingComment',
        'createPublishedArticle',
        'createUserSession',
        'preparePublicShellLocaleScene',
        'readPublicShellLocaleAuthority',
        'readPublicShellLocalePublishedArtifact',
        'resetContractNamespace',
        'transitionPublicShellLocaleScene'
    ]);
    const [article, comment, user, admin] = await Promise.all([
        api.createPublishedArticle(),
        api.createPendingComment(),
        api.createUserSession(),
        api.createAdminSession()
    ]);
    assert.deepEqual({ article: article.id, comment: comment.id, user: user.id, admin: admin.id }, {
        article: '101', comment: '202', user: 303, admin: 404
    });

    const requests = await readProviderRequests(harness.providerLog);
    assert.equal(requests.length, 4);
    assert.deepEqual(new Set(requests.map((request) => request.operation)), new Set([
        'createPublishedArticle', 'createPendingComment', 'createUserSession', 'createAdminSession'
    ]));
    for (const request of requests)
    {
        assert.equal(request.schema, 'fsusblog.browser-contract-fixture-provider-request.v1');
        assert.deepEqual(request.identity, {
            commit,
            runId: identity.runId,
            laneId: identity.laneId,
            namespace: identity.namespace
        });
        assert.deepEqual(request.preparation, preparation);
        assert.deepEqual(Object.keys(request.resources).sort(), [
            'databaseInstance',
            'databaseSchema',
            'fixtureRoot',
            'redisInstance',
            'redisNamespace'
        ]);
        assert.equal(request.resources.databaseSchema, identity.databaseSchema);
        assert.equal(request.resources.redisNamespace, identity.redisNamespace);
        assert.equal(request.resources.fixtureRoot, identity.fixtureRoot);
        assert.match(request.resources.databaseInstance, /\S/u);
        assert.match(request.resources.redisInstance, /\S/u);
        assert.equal(request.sourceState.commit, commit);
        assert.equal(request.build.receiptContentDigest, buildDigest);
        assert.equal('workers' in request, false);
        assert.equal('memory' in request, false);
        assert.equal('pidHeadroom' in request, false);
    }

    // Explicit RPC boundary model: real scene binding owner, no host or browser credentials.
    const sceneId = 'formal-api-node-model-scene';
    const sceneProvider = path.join(harness.root, 'scene-provider.mjs');
    const sceneLog = path.join(harness.root, 'scene-provider.jsonl');
    await chmod(identity.fixtureRoot, 0o700);
    const { realpath } = await import('node:fs/promises');
    const sceneIdentity = { ...identity, fixtureRoot: await realpath(identity.fixtureRoot) };
    await writeFile(sceneProvider, `
import { appendFile } from 'node:fs/promises';
import { preparePublicShellLocaleSceneBinding, transitionPublicShellLocaleSceneBinding } from ${JSON.stringify(new URL('../browser-contract/fixture-lifecycle.mjs', import.meta.url).href)};
const chunks = [];
for await (const chunk of process.stdin) { chunks.push(chunk); }
const request = JSON.parse(Buffer.concat(chunks));
await appendFile(${JSON.stringify(sceneLog)}, JSON.stringify(request) + '\\n');
const mode = process.env.FAKE_SCENE_RESPONSE_MODE;
const authority = {
    matrixDigest: ${JSON.stringify(buildDigest)},
    runtime: { frontendUrl: 'http://127.0.0.1:39101', backendUrl: 'http://127.0.0.1:39102' },
    rawRefs: [{ path: 'explicit-node-model', digest: ${JSON.stringify(buildDigest)} }]
};
let entity = {};
if (!mode) {
    entity = request.operation === 'preparePublicShellLocaleScene'
        ? await preparePublicShellLocaleSceneBinding(request, { id: ${JSON.stringify(sceneId)}, authActionContext: 'anonymous' }, authority)
        : await transitionPublicShellLocaleSceneBinding(request, authority);
}
const response = { schema: 'fsusblog.browser-contract-fixture-provider-response.v1', operation: request.operation, status: 'ok', entity };
if (mode === 'schema') response.schema = 'foreign-schema';
if (mode === 'operation') response.operation = 'createUserSession';
if (mode === 'status') response.status = 'failed';
if (mode === 'missing-entity') delete response.entity;
if (mode === 'array-entity') response.entity = [];
if (mode === 'scalar-entity') response.entity = 'not-an-entity';
process.stdout.write(mode === 'invalid-json' ? '{invalid' : JSON.stringify(response));
`, { mode: 0o600 });
    const sceneApi = (overrides = {}, responseMode = '') => createBrowserContractFixtureApi({
        identity: sceneIdentity,
        env: {
            ...harness.env,
            FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER: sceneProvider,
            FAKE_SCENE_RESPONSE_MODE: responseMode
        },
        repoRoot: harness.root,
        sourceState: harness.sourceState,
        build: harness.build,
        preparation,
        ...overrides
    });
    const sceneBoundary = sceneApi();
    const lease = await sceneBoundary.preparePublicShellLocaleScene(sceneId);
    assert.equal(lease.sceneId, sceneId);
    assert.equal(lease.status, 'prepared');
    for (const invalidSceneId of [undefined, '', { sceneId }, 'foreign-scene'])
    {
        await assert.rejects(() => sceneBoundary.preparePublicShellLocaleScene(invalidSceneId), /provider failed during preparePublicShellLocaleScene/u);
    }
    const beforeMissingLease = await readProviderRequests(sceneLog);
    await assert.rejects(() => sceneBoundary.transitionPublicShellLocaleScene(null, 'reserved'), TypeError);
    assert.deepEqual(await readProviderRequests(sceneLog), beforeMissingLease);
    for (const [field, value] of Object.entries({
        leaseId: '22222222-2222-4222-8222-222222222222',
        actorId: '33333333-3333-4333-8333-333333333333',
        contextId: '44444444-4444-4444-8444-444444444444',
        sceneId: 'foreign-scene',
        role: 'admin',
        owner: { ...lease.owner, fixtureRoot: harness.root },
        authority: { ...lease.authority, matrixDigest: `sha256:${'d'.repeat(64)}` }
    }))
    {
        await assert.rejects(() => sceneBoundary.transitionPublicShellLocaleScene({ ...lease, [field]: value }, 'reserved'), /provider failed during transitionPublicShellLocaleScene/u);
    }
    for (const phase of ['unknown-phase', 'entered'])
    {
        await assert.rejects(() => sceneBoundary.transitionPublicShellLocaleScene(lease, phase), /provider failed during transitionPublicShellLocaleScene/u);
    }
    for (const override of [
        { identity: { ...sceneIdentity, runId: 'foreign-run' } },
        { identity: { ...sceneIdentity, databaseInstance: 'foreign-database' } },
        { sourceState: { ...harness.sourceState, commit: 'd'.repeat(40) } },
        { build: { receiptContentDigest: `sha256:${'d'.repeat(64)}` } },
        { preparation: { ...preparation, id: '55555555-5555-4555-8555-555555555555' } }
    ])
    {
        await assert.rejects(() => sceneApi(override).transitionPublicShellLocaleScene(lease, 'reserved'), /provider failed during transitionPublicShellLocaleScene/u);
    }
    const reserved = await sceneBoundary.transitionPublicShellLocaleScene(lease, 'reserved');
    const entered = await sceneBoundary.transitionPublicShellLocaleScene(reserved, 'entered');
    const failure = new Error('original scene model failure');
    const finished = await sceneBoundary.transitionPublicShellLocaleScene(entered, 'finished', failure);
    assert.equal(finished.status, 'finished');
    assert.equal(finished.entered, 1);
    assert.equal(finished.ended, 1);
    assert.deepEqual(finished.firstFailure, { name: 'Error', message: failure.message, failureClass: 'contract' });

    const sceneRequests = await readProviderRequests(sceneLog);
    const validRequests = [sceneRequests[0], ...sceneRequests.slice(-3)];
    assert.deepEqual(validRequests.map((request) => request.operation), [
        'preparePublicShellLocaleScene', 'transitionPublicShellLocaleScene',
        'transitionPublicShellLocaleScene', 'transitionPublicShellLocaleScene'
    ]);
    for (const request of validRequests)
    {
        assert.equal(request.schema, 'fsusblog.browser-contract-fixture-provider-request.v1');
        assert.deepEqual(request.identity, { commit, runId: identity.runId, laneId: identity.laneId, namespace: identity.namespace });
        assert.deepEqual(request.preparation, preparation);
        assert.deepEqual(request.sourceState, harness.sourceState);
        assert.deepEqual(request.build, harness.build);
        assert.deepEqual(request.resources, { ...requests[0].resources, fixtureRoot: sceneIdentity.fixtureRoot });
        assert.equal(request.sceneId, sceneId);
        assert.deepEqual(Object.keys(request).sort(), request.operation === 'preparePublicShellLocaleScene'
            ? ['build', 'identity', 'operation', 'preparation', 'resources', 'sceneId', 'schema', 'sourceState']
            : ['build', 'failure', 'identity', 'lease', 'operation', 'phase', 'preparation', 'resources', 'sceneId', 'schema', 'sourceState']);
    }
    assert.deepEqual(validRequests.slice(1).map((request) => request.phase), ['reserved', 'entered', 'finished']);
    assert.deepEqual(validRequests.slice(1).map((request) => request.lease), [lease, reserved, entered]);
    assert.deepEqual(validRequests.slice(1).map((request) => request.failure), [null, null, { name: 'Error', message: failure.message, failureClass: 'contract' }]);

    for (const mode of ['schema', 'operation', 'status', 'missing-entity', 'array-entity', 'scalar-entity', 'invalid-json'])
    {
        const malformed = sceneApi({}, mode);
        await assert.rejects(() => malformed.preparePublicShellLocaleScene(sceneId), /response is invalid|omitted preparePublicShellLocaleScene entity|returned invalid JSON/u);
        await assert.rejects(() => malformed.transitionPublicShellLocaleScene(entered, 'finished'), /response is invalid|omitted transitionPublicShellLocaleScene entity|returned invalid JSON/u);
    }
});

test('default provider state is bound to current source, build, namespace, and owned runtime instances', async (context) =>
{
    const harness = await createHarness(context);
    const preparation = {
        id: '22222222-2222-4222-8222-222222222222',
        startedAt: '2026-07-18T00:00:00.000Z'
    };
    const identity = resolveBrowserContractRunIdentity({
        env: harness.env,
        sourceState: harness.sourceState,
        repoRoot: harness.root
    });
    const request = {
        identity: {
            commit: identity.commit,
            runId: identity.runId,
            laneId: identity.laneId,
            namespace: identity.namespace
        },
        preparation,
        resources: {
            databaseSchema: identity.databaseSchema,
            databaseInstance: identity.databaseInstance,
            redisNamespace: identity.redisNamespace,
            redisInstance: identity.redisInstance,
            fixtureRoot: identity.fixtureRoot
        },
        sourceState: harness.sourceState,
        build: harness.build
    };
    const state = {
        schema: 'fsusblog.browser-contract-default-provider-state.v1',
        phase: 'prepared',
        namespace: identity.namespace,
        preparation,
        runtimeRunId: 'browser-contract-scheduler-run',
        runtime: {
            frontendUrl: 'http://127.0.0.1:39101',
            backendUrl: 'http://127.0.0.1:39102',
            isolatedDatabase: true,
            testSessionHeader: false
        },
        containers: {
            postgres: { name: identity.databaseInstance, id: 'd'.repeat(64), image: postgresImage },
            redis: { name: identity.redisInstance, id: 'e'.repeat(64), image: redisImage }
        },
        sourceState: harness.sourceState,
        buildIdentity: { receiptContentDigest: buildDigest }
    };
    assert.equal(validateDefaultFixtureProviderState(state, request), state);

    const preparing = structuredClone(state);
    preparing.phase = 'preparing';
    preparing.runtime = null;
    preparing.containers.postgres.id = null;
    preparing.containers.redis.id = null;
    assert.equal(validateDefaultFixtureProviderState(preparing, request), preparing);

    const clone = () => structuredClone(state);
    const staleNamespace = clone();
    staleNamespace.namespace = `${identity.namespace}-stale`;
    const stalePreparationId = clone();
    stalePreparationId.preparation.id = '33333333-3333-4333-8333-333333333333';
    const stalePreparationStartedAt = clone();
    stalePreparationStartedAt.preparation.startedAt = '2026-07-17T23:59:59.000Z';
    const wrongSource = clone();
    wrongSource.sourceState.worktreeFingerprint = 'f'.repeat(64);
    const wrongRuntimeRun = clone();
    wrongRuntimeRun.runtimeRunId = '';
    const wrongBuild = clone();
    wrongBuild.buildIdentity.receiptContentDigest = `sha256:${'0'.repeat(64)}`;
    const wrongDatabase = clone();
    wrongDatabase.containers.postgres.name = 'shared-postgres';
    const wrongRedis = clone();
    wrongRedis.containers.redis.id = 'short-id';
    const sessionHeaderFallback = clone();
    sessionHeaderFallback.runtime.testSessionHeader = true;
    for (const candidate of [
        staleNamespace,
        stalePreparationId,
        stalePreparationStartedAt,
        wrongSource,
        wrongRuntimeRun,
        wrongBuild,
        wrongDatabase,
        wrongRedis,
        sessionHeaderFallback
    ])
    {
        assert.throws(
            () => validateDefaultFixtureProviderState(candidate, request),
            /identity|ownership|state/iu
        );
    }
});

test('default provider preserves the temporal scheduler run for its target runtime', () =>
{
    const context = { schedulerRunId: 'browser-contract-scheduler-run' };
    assert.equal(
        resolveDedicatedRuntimeRunId(context, { FSUSBLOG_TEST_RUN_ID: 'browser-contract-scheduler-run' }),
        'browser-contract-scheduler-run'
    );
    assert.throws(
        () => resolveDedicatedRuntimeRunId(context, { FSUSBLOG_TEST_RUN_ID: 'mutated-target-run' }),
        /run ingress.*temporal context/iu
    );
    assert.throws(
        () => resolveDedicatedRuntimeRunId({}, { FSUSBLOG_TEST_RUN_ID: 'browser-contract-scheduler-run' }),
        /run ingress.*temporal context/iu
    );
});

test('prepare seals identity/entities/receipt and provider failure is fail closed', async (context) =>
{
    const harness = await createHarness(context);
    const prepared = await prepareBrowserContractFixture({
        env: harness.env,
        repoRoot: harness.root,
        sourceState: harness.sourceState,
        build: harness.build
    });
    const manifest = JSON.parse(await readFile(prepared.manifestFile, 'utf8'));
    assert.equal(manifest.schema, 'fsusblog.browser-contract-fixture.v2');
    assert.deepEqual(prepared.manifest, manifest);
    assert.equal(prepared.identity.sessions, 1);
    assert.equal(prepared.identity.concurrency, 1);
    assert.equal(manifest.identity.namespace, prepared.identity.namespace);
    assert.deepEqual(manifest.preparation, prepared.preparation);
    assert.deepEqual(prepared.lifecycle.preparation, prepared.preparation);
    assert.equal(manifest.resources.databaseSchema, prepared.identity.databaseSchema);
    assert.equal(manifest.resources.databaseInstance, prepared.identity.databaseInstance);
    assert.equal(manifest.resources.redisNamespace, prepared.identity.redisNamespace);
    assert.equal(manifest.resources.redisInstance, prepared.identity.redisInstance);
    assert.equal(manifest.sourceState.commit, commit);
    assert.equal(manifest.buildIdentity.receiptContentDigest, buildDigest);
    assert.equal(manifest.entities.publicArticle.id, '101');
    assert.equal(manifest.entities.pendingComment.id, '202');
    assert.equal(manifest.entities.user.id, 303);
    assert.equal(manifest.entities.admin.id, 404);
    assert.equal(prepared.lifecycle.status, 'prepared');
    assert.equal(prepared.lifecycle.cleanup.status, 'pending');
    assert.equal(manifest.baseUrl, 'http://127.0.0.1:39101');
    assert.equal(manifest.backendUrl, 'http://127.0.0.1:39102');
    assert.deepEqual(manifest.transport, { testSessionHeader: false });
    assert.equal((await stat(prepared.manifestFile)).isFile(), true);
    assert.equal(await permissionBits(prepared.root), 0o700);
    assert.equal(await permissionBits(prepared.manifestFile), 0o600);
    assert.equal(await permissionBits(path.join(prepared.root, manifest.entities.user.storageStateFile)), 0o600);
    assert.equal(await permissionBits(path.join(prepared.root, manifest.entities.admin.storageStateFile)), 0o600);

    const fixture = await loadBrowserContractFixture({
        env: { ...harness.env, FSUSBLOG_TEST_SESSION: prepared.identity.namespace },
        repoRoot: harness.root,
        fixtureRoot: prepared.root,
        lifecycle: prepared.lifecycle,
        expectedSourceState: harness.sourceState,
        expectedBuild: harness.build
    });
    const receipt = fixtureReceiptView(fixture, harness.root);
    assert.equal(receipt.manifestSchema, 'fsusblog.browser-contract-fixture.v2');
    assert.deepEqual(receipt.topology, { sessions: 1, concurrency: 1 });
    assert.equal(receipt.databaseSchema, prepared.identity.databaseSchema);
    assert.equal(receipt.redisNamespace, prepared.identity.redisNamespace);
    assert.equal(receipt.publicArticleId, '101');
    assert.equal(receipt.pendingCommentId, '202');
    assert.equal(receipt.userId, 303);
    assert.equal(receipt.adminId, 404);
    assert.equal('cookies' in receipt, false);
    assert.equal(fixture.baseUrl, 'http://127.0.0.1:39101');
    assert.equal(fixture.backendUrl, 'http://127.0.0.1:39102');
    assert.equal(fixture.testSession, null);

    const sharedDatabaseManifest = structuredClone(manifest);
    sharedDatabaseManifest.ownership.containers.postgres.name = 'shared-postgres';
    await writeFile(prepared.manifestFile, `${JSON.stringify(sharedDatabaseManifest, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(loadBrowserContractFixture({
        env: { ...harness.env, FSUSBLOG_TEST_SESSION: prepared.identity.namespace },
        repoRoot: harness.root,
        fixtureRoot: prepared.root,
        lifecycle: prepared.lifecycle,
        expectedSourceState: harness.sourceState,
        expectedBuild: harness.build
    }), /database ownership|ownership identity/iu);
    await writeFile(prepared.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const failedHarness = await createHarness(context, { FAKE_PROVIDER_FAIL_OPERATION: 'createPendingComment' });
    await assert.rejects(prepareBrowserContractFixture({
        env: failedHarness.env,
        repoRoot: failedHarness.root,
        sourceState: failedHarness.sourceState,
        build: failedHarness.build
    }), /createPendingComment|provider/iu);
    const failedIdentity = resolveBrowserContractRunIdentity({
        env: failedHarness.env,
        sourceState: failedHarness.sourceState,
        repoRoot: failedHarness.root
    });
    await assert.rejects(readFile(path.join(failedIdentity.fixtureRoot, 'contract-fixture.json'), 'utf8'), /ENOENT/u);
});

test('fixture security rejects symlink storage state and redacts provider stderr secrets', async (context) =>
{
    const symlinkHarness = await createHarness(context);
    const symlinkTarget = path.join(symlinkHarness.root, 'outside-user.storage-state.json');
    symlinkHarness.env.FAKE_PROVIDER_SYMLINK_ROLE = 'user';
    symlinkHarness.env.FAKE_PROVIDER_SYMLINK_TARGET = symlinkTarget;
    await assert.rejects(prepareBrowserContractFixture({
        env: symlinkHarness.env,
        repoRoot: symlinkHarness.root,
        sourceState: symlinkHarness.sourceState,
        build: symlinkHarness.build
    }), /symlink|regular file|storage state/iu);
    assert.equal((await stat(symlinkTarget)).isFile(), true);

    const secret = 'provider-password-canary-1149';
    const redactionHarness = await createHarness(context, {
        FAKE_PROVIDER_FAIL_OPERATION: 'createPublishedArticle',
        FAKE_PROVIDER_FAILURE_STDERR: `postgres://fixture:${secret}@127.0.0.1/fsusblog\n`
    });
    let failure;
    await assert.rejects(prepareBrowserContractFixture({
        env: redactionHarness.env,
        repoRoot: redactionHarness.root,
        sourceState: redactionHarness.sourceState,
        build: redactionHarness.build
    }), (error) =>
    {
        failure = error;
        return /createPublishedArticle|provider/iu.test(error.message);
    });
    const serialized = `${failure.message}\n${JSON.stringify(failure.fixtureLifecycle)}\n${JSON.stringify(failure.cleanup)}`;
    assert.doesNotMatch(serialized, new RegExp(secret, 'u'));
    assert.doesNotMatch(serialized, /postgres:\/\/fixture:[^@\s]+@/iu);
});

test('a stale sealed manifest from the same run identity cannot replace the current preparation', async (context) =>
{
    const harness = await createHarness(context);
    const first = await prepareBrowserContractFixture({
        env: harness.env,
        repoRoot: harness.root,
        sourceState: harness.sourceState,
        build: harness.build
    });
    const staleManifest = await readFile(first.manifestFile, 'utf8');
    await cleanupBrowserContractFixture(first, { reason: 'completed' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const current = await prepareBrowserContractFixture({
        env: harness.env,
        repoRoot: harness.root,
        sourceState: harness.sourceState,
        build: harness.build
    });
    await writeFile(current.manifestFile, staleManifest, { mode: 0o600 });
    await assert.rejects(loadBrowserContractFixture({
        env: { ...harness.env, FSUSBLOG_TEST_SESSION: current.identity.namespace },
        repoRoot: harness.root,
        fixtureRoot: current.root,
        lifecycle: current.lifecycle,
        expectedSourceState: harness.sourceState,
        expectedBuild: harness.build
    }), /stale|fresh|generation|digest|current run/iu);
    const cleanup = await cleanupBrowserContractFixture(current, { reason: 'stale-fixture' });
    assert.equal(cleanup.status, 'success');
});

test('cleanup is idempotent and returns separate failure evidence without replacing the primary failure', async (context) =>
{
    const harness = await createHarness(context);
    const prepared = await prepareBrowserContractFixture({
        env: harness.env,
        repoRoot: harness.root,
        sourceState: harness.sourceState,
        build: harness.build
    });
    const first = await cleanupBrowserContractFixture(prepared, { reason: 'product-failure' });
    const second = await cleanupBrowserContractFixture(prepared, { reason: 'timeout' });
    assert.equal(first.status, 'success');
    assert.equal(second.status, 'success');
    assertCleanupResources(first);
    assert.equal(second, first);
    assert.equal(second.attempts, 1);
    assert.equal(second.reason, 'product-failure');

    const failResetMarker = path.join(os.tmpdir(), `fsus-browser-contract-fail-reset-${process.pid}-${Date.now()}`);
    context.after(async () =>
    {
        await rm(failResetMarker, { force: true });
    });
    const failingHarness = await createHarness(context, { FAKE_PROVIDER_FAIL_RESET_MARKER: failResetMarker });
    const failingPrepared = await prepareBrowserContractFixture({
        env: failingHarness.env,
        repoRoot: failingHarness.root,
        sourceState: failingHarness.sourceState,
        build: failingHarness.build
    });
    await writeFile(failResetMarker, 'fail cleanup\n');
    const primaryFailure = new Error('original product assertion');
    const cleanup = await cleanupBrowserContractFixture(failingPrepared, { reason: 'product-failure' });
    assert.equal(cleanup.status, 'failure');
    assert.match(cleanup.error.message, /resetContractNamespace|provider/iu);
    assert.equal(cleanup.resources.files.status, 'retained');
    assert.equal(cleanup.resources.files.evidence.retainedForRetry, true);
    assert.ok(['failure', 'unknown'].includes(cleanup.resources.database.status));
    assert.ok(['failure', 'unknown'].includes(cleanup.resources.redis.status));
    assert.equal(cleanup.resources.processes.status, 'failure');
    assert.equal(primaryFailure.message, 'original product assertion');

    await rm(failResetMarker, { force: true });
    const recovered = await cleanupBrowserContractFixture(failingPrepared, { reason: 'cleanup-retry' });
    assert.equal(recovered, cleanup);
    assert.equal(recovered.status, 'success');
    assert.equal(recovered.attempts, 2);
    assert.equal(recovered.resources.files.status, 'success');
    await assert.rejects(stat(failingPrepared.root), /ENOENT/u);
});

test('cancelled preparation and timeout cleanup both release the isolated fixture root', async (context) =>
{
    const cancelledHarness = await createHarness(context, {
        FAKE_PROVIDER_DELAY_OPERATION: 'createPublishedArticle',
        FAKE_PROVIDER_DELAY_MS: '10000'
    });
    const controller = new AbortController();
    const cancellation = prepareBrowserContractFixture({
        env: cancelledHarness.env,
        repoRoot: cancelledHarness.root,
        sourceState: cancelledHarness.sourceState,
        build: cancelledHarness.build,
        signal: controller.signal
    });
    setTimeout(() => controller.abort(new Error('injected cancellation')), 100).unref();
    let cancelled;
    await assert.rejects(cancellation, (error) =>
    {
        cancelled = error;
        return /cancel/iu.test(error.message);
    });
    assert.equal(cancelled.fixtureLifecycle.error.failureClass, 'infra');
    assert.equal(cancelled.cleanup.status, 'success');
    assertCleanupResources(cancelled.cleanup);
    await assert.rejects(
        stat(path.resolve(cancelledHarness.root, cancelled.fixtureLifecycle.resources.fixtureRoot)),
        /ENOENT/u
    );

    const timeoutHarness = await createHarness(context);
    const timedOut = await prepareBrowserContractFixture({
        env: timeoutHarness.env,
        repoRoot: timeoutHarness.root,
        sourceState: timeoutHarness.sourceState,
        build: timeoutHarness.build
    });
    const cleanup = await cleanupBrowserContractFixture(timedOut, { reason: 'timeout' });
    assert.equal(cleanup.status, 'success');
    assert.equal(cleanup.reason, 'timeout');
    assertCleanupResources(cleanup);
    await assert.rejects(stat(timedOut.root), /ENOENT/u);
});

test('provider timeout terminates the complete stubborn process group within the TERM-to-KILL budget', async (context) =>
{
    const harness = await createHarness(context);
    const pidFile = path.join(harness.root, 'stubborn-provider-pids.json');
    harness.env.FAKE_PROVIDER_STUBBORN_OPERATION = 'createPublishedArticle';
    harness.env.FAKE_PROVIDER_PID_FILE = pidFile;
    harness.env.FSUSBLOG_BROWSER_CONTRACT_PROVIDER_TIMEOUT_MS = '150';
    const startedAt = Date.now();
    const preparation = prepareBrowserContractFixture({
        env: harness.env,
        repoRoot: harness.root,
        sourceState: harness.sourceState,
        build: harness.build
    });
    const pids = await waitForJson(pidFile);
    let failure;
    await assert.rejects(preparation, (error) =>
    {
        failure = error;
        return /timed out/iu.test(error.message);
    });
    assert.equal(failure.fixtureLifecycle.error.failureClass, 'infra');
    assert.ok(Date.now() - startedAt < 3_000, 'provider timeout exceeded the bounded TERM-to-KILL budget');
    await Promise.all([
        waitForProcessExit(pids.provider),
        waitForProcessExit(pids.grandchild)
    ]);
    assert.equal(failure.cleanup.status, 'success');
    assertCleanupResources(failure.cleanup);
});

test('delayed provider KILL reaps an owned grandchild after its parent exits on TERM', async (context) =>
{
    const harness = await createHarness(context);
    const pidFile = path.join(harness.root, 'term-exit-provider-pids.json');
    harness.env.FAKE_PROVIDER_TERM_EXIT_OPERATION = 'createPublishedArticle';
    harness.env.FAKE_PROVIDER_PID_FILE = pidFile;
    harness.env.FSUSBLOG_BROWSER_CONTRACT_PROVIDER_TIMEOUT_MS = '150';
    const preparation = prepareBrowserContractFixture({
        env: harness.env,
        repoRoot: harness.root,
        sourceState: harness.sourceState,
        build: harness.build
    });
    const pids = await waitForJson(pidFile);
    let failure;
    await assert.rejects(preparation, (error) =>
    {
        failure = error;
        return /timed out/iu.test(error.message);
    });
    await Promise.all([
        waitForProcessExit(pids.provider),
        waitForProcessExit(pids.grandchild)
    ]);
    assert.equal(failure.fixtureLifecycle.error.failureClass, 'infra');
    assert.equal(failure.cleanup.status, 'success');
    assertCleanupResources(failure.cleanup);
});
