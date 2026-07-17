import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { fixtureReceiptView, loadBrowserContractFixture } from './fixture.mjs'
import {
  browserContractFixtureManifestSchema,
  browserContractFixedFixtureTopology,
  cleanupBrowserContractFixture,
  providerProcessGroupIsOwned,
  prepareBrowserContractFixture,
  resolveBrowserContractRunIdentity
} from './fixture-lifecycle.mjs'
import { createProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs'

const commit = 'a'.repeat(40)
const sourceState = { commit, worktreeFingerprint: 'b'.repeat(64) }
const build = { receiptContentDigest: `sha256:${'c'.repeat(64)}`, profile: 'production' }
const repositoryRoot = path.resolve(import.meta.dirname, '../..')

const providerSource = String.raw`#!/usr/bin/env node
import { access, appendFile, mkdir, symlink, writeFile } from 'node:fs/promises'
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
    await writeFile(root + '/user.storage-state.json', storage, { mode: Number(process.env.FAKE_STORAGE_MODE ?? 0o600) })
  }
  entity = { id: 303, storageStateFile: 'user.storage-state.json', capabilities: { webAuthnRegistration: true } }
} else if (request.operation === 'createAdminSession') {
  await writeFile(root + '/admin.storage-state.json', storage, { mode: 0o600 })
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
`

async function harness(context, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fsus-browser-contract-lifecycle-'))
  context.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const provider = path.join(directory, 'provider.mjs')
  const log = path.join(directory, 'provider.log')
  await writeFile(provider, providerSource, { mode: 0o700 })
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
      FAKE_PROVIDER_LOG: log,
      ...overrides
    }
  }
}

async function createRunnerBuildReceipt(directory) {
  const artifactRoot = path.join(directory, 'immutable-build')
  const domains = [
    ['backend-runtime', 'backend-runtime/server.dll'],
    ['frontend-dist', 'frontend-dist/index.html'],
    ['generated-contracts', 'generated-contracts/contracts.json'],
    ['wasm', 'wasm/aeds.wasm']
  ]
  for (const [, relative] of domains) {
    const file = path.join(artifactRoot, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `${relative}\n`)
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
  })
  return path.join(artifactRoot, 'receipt.json')
}

test('run identity fixes one session and derives isolated database/Redis resources from commit/run/lane', async (context) => {
  const { directory, env } = await harness(context)
  const identity = resolveBrowserContractRunIdentity({ env, sourceState, repoRoot: directory })
  assert.deepEqual(browserContractFixedFixtureTopology, { sessions: 1, concurrency: 1 })
  assert.equal(identity.sessions, 1)
  assert.equal(identity.concurrency, 1)
  assert.equal(identity.laneId, 'browser-contract')
  assert.match(identity.namespace, /^bc-aaaaaaaa-[a-f0-9]{10}-[a-f0-9]{6}$/u)
  assert.equal(identity.databaseSchema, 'public')
  assert.equal(identity.databaseInstance, `fsusblog-test-postgres-${identity.namespace}`)
  assert.equal(identity.redisNamespace, `FsusBlog_${identity.namespace}_`)
  assert.equal(identity.redisInstance, `fsusblog-test-redis-${identity.namespace}`)
  assert.equal(identity.fixtureRoot, path.join(directory, 'fixtures', identity.namespace))

  for (const invalid of [
    { FSUSBLOG_BROWSER_CONTRACT_SESSIONS: '2' },
    { FSUSBLOG_BROWSER_CONTRACT_CONCURRENCY: '2' },
    { FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-diagnostics' }
  ]) {
    assert.throws(
      () => resolveBrowserContractRunIdentity({ env: { ...env, ...invalid }, sourceState, repoRoot: directory }),
      /fixed at 1 session|requires browser-contract session mode/u
    )
  }
})

test('fixture source identity is complete, dedicated, and cannot fall back to GITHUB_SHA', async (context) => {
  const { directory, env } = await harness(context)
  const githubOnly = {
    ...env,
    GITHUB_SHA: commit,
    FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint
  }
  assert.throws(
    () => resolveBrowserContractRunIdentity({ env: githubOnly, repoRoot: directory }),
    /requires complete source commit and worktree fingerprint identity/u
  )
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
  )
  await assert.rejects(
    prepareBrowserContractFixture({
      env: githubOnly,
      repoRoot: directory,
      sourceState: null,
      build
    }),
    /requires complete source commit and worktree fingerprint identity/u
  )

  const dedicatedEnv = {
    ...env,
    GITHUB_SHA: 'f'.repeat(40),
    FSUSBLOG_TEST_SOURCE_COMMIT: commit,
    FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint
  }
  const prepared = await prepareBrowserContractFixture({
    env: dedicatedEnv,
    repoRoot: directory,
    sourceState: null,
    build
  })
  assert.deepEqual(prepared.manifest.sourceState, sourceState)
  assert.equal(prepared.identity.commit, commit)
  assert.equal((await cleanupBrowserContractFixture(prepared)).status, 'success')
})

test('provider process-group ownership is bound to one invocation before delayed KILL', async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), 'fsus-browser-contract-provider-proc-'))
  context.after(async () => { await rm(procRoot, { recursive: true, force: true }) })
  const processGroupId = 4123
  const invocationId = '11111111-1111-4111-8111-111111111111'
  const namespace = 'bc-aaaaaaaa-0123456789-abcdef'
  const fixtureRoot = '/repo/.tmp/browser-contract/fixtures/bc-aaaaaaaa-0123456789-abcdef'
  const writeMember = async (pid, memberInvocationId = invocationId) => {
    const memberRoot = path.join(procRoot, String(pid))
    await mkdir(memberRoot, { recursive: true })
    await writeFile(path.join(memberRoot, 'stat'), `${pid} (provider worker) S 1 ${processGroupId} ${processGroupId}\n`)
    await writeFile(path.join(memberRoot, 'environ'), [
      `FSUSBLOG_BROWSER_CONTRACT_PROVIDER_INVOCATION_ID=${memberInvocationId}`,
      'FSUSBLOG_PLAYWRIGHT_SESSION_MODE=browser-contract',
      `FSUSBLOG_TEST_NAMESPACE=${namespace}`,
      `FSUSBLOG_FIXTURE_ROOT=${fixtureRoot}`,
      ''
    ].join('\0'))
  }
  await writeMember(processGroupId)
  assert.equal(providerProcessGroupIsOwned(processGroupId, {
    invocationId,
    namespace,
    fixtureRoot,
    procRoot
  }), true)

  await writeMember(processGroupId + 1, '22222222-2222-4222-8222-222222222222')
  assert.equal(providerProcessGroupIsOwned(processGroupId, {
    invocationId,
    namespace,
    fixtureRoot,
    procRoot
  }), false)
  assert.equal(providerProcessGroupIsOwned(processGroupId + 10, {
    invocationId,
    namespace,
    fixtureRoot,
    procRoot
  }), false)
})

test('fixture provider must explicitly disable the test-session header', async (context) => {
  for (const value of ['missing', 'true']) {
    const { directory, env } = await harness(context, { FAKE_TEST_SESSION_HEADER: value })
    let failure
    await assert.rejects(
      prepareBrowserContractFixture({ env, repoRoot: directory, sourceState, build }),
      (error) => {
        failure = error
        return /explicitly disable the test-session header/u.test(error.message)
      }
    )
    assert.equal(failure.cleanup.status, 'success')
  }
})

test('single prepare seals stable entities and cleanup is idempotent without leaking storage secrets', async (context) => {
  const { directory, env, log } = await harness(context)
  const prepared = await prepareBrowserContractFixture({ env, repoRoot: directory, sourceState, build })
  assert.equal(prepared.manifest.schema, browserContractFixtureManifestSchema)
  assert.equal(prepared.manifest.sealed, true)
  assert.deepEqual(prepared.manifest.topology, { sessions: 1, concurrency: 1 })
  assert.equal(prepared.manifest.resources.databaseSchema, prepared.identity.databaseSchema)
  assert.equal(prepared.manifest.resources.redisNamespace, prepared.identity.redisNamespace)
  assert.equal(prepared.manifest.entities.publicArticle.id, '101')
  assert.equal(prepared.manifest.entities.pendingComment.id, '202')
  assert.equal(prepared.manifest.entities.user.id, 303)
  assert.equal(prepared.manifest.entities.admin.id, 404)
  assert.equal(prepared.manifest.sourceState.commit, commit)
  assert.equal(prepared.manifest.buildIdentity.receiptContentDigest, build.receiptContentDigest)

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
  })
  const receipt = fixtureReceiptView(fixture, directory)
  assert.equal(receipt.databaseSchema, prepared.identity.databaseSchema)
  assert.equal(receipt.redisNamespace, prepared.identity.redisNamespace)
  assert.equal(receipt.pendingCommentId, '202')
  assert.equal(JSON.stringify(receipt).includes('secret-token'), false)

  const first = await cleanupBrowserContractFixture(prepared, { reason: 'success' })
  const second = await cleanupBrowserContractFixture(prepared, { reason: 'ignored-second-call' })
  assert.equal(first, second)
  assert.equal(first.status, 'success')
  assert.equal(first.attempts, 1)
  const operations = (await readFile(log, 'utf8')).trim().split('\n')
  assert.deepEqual(operations, [
    'resetContractNamespace:prepare',
    'createPublishedArticle:',
    'createPendingComment:',
    'createUserSession:',
    'createAdminSession:',
    'resetContractNamespace:cleanup'
  ])
})

test('prepare failure fails closed, attempts cleanup, and never leaves a sealed manifest', async (context) => {
  const { directory, env, log } = await harness(context, { FAKE_PROVIDER_FAIL: 'createPendingComment' })
  await assert.rejects(
    prepareBrowserContractFixture({ env, repoRoot: directory, sourceState, build }),
    /provider failed during createPendingComment/u
  )
  const operations = (await readFile(log, 'utf8')).trim().split('\n')
  assert.deepEqual(operations, [
    'resetContractNamespace:prepare',
    'createPublishedArticle:',
    'createPendingComment:',
    'resetContractNamespace:cleanup'
  ])
})

test('storage state must be created with exact 0600 permissions', async (context) => {
  const { directory, env } = await harness(context, { FAKE_STORAGE_MODE: String(0o640) })
  await assert.rejects(
    prepareBrowserContractFixture({ env, repoRoot: directory, sourceState, build }),
    /permissions must be 0600/u
  )
})

test('cleanup failure is separate, retains recovery state, and remains retryable', async (context) => {
  const { directory, env } = await harness(context, { FAKE_CLEANUP_FAIL: '1' })
  const prepared = await prepareBrowserContractFixture({ env, repoRoot: directory, sourceState, build })
  const cleanup = await cleanupBrowserContractFixture(prepared, { reason: 'product-failure' })
  assert.equal(cleanup.status, 'failure')
  assert.equal(cleanup.reason, 'product-failure')
  assert.equal(cleanup.attempts, 1)
  assert.match(cleanup.error.message, /provider failed during resetContractNamespace/u)
  assert.equal(cleanup.resources.files.status, 'retained')
  assert.equal(cleanup.resources.files.evidence.retainedForRetry, true)
  const retried = await cleanupBrowserContractFixture(prepared)
  assert.equal(retried, cleanup)
  assert.equal(retried.attempts, 2)
  assert.equal(retried.status, 'failure')
})

test('prepare failure retains its handle and a failed cleanup retries cleanly without replacing the primary error', async (context) => {
  const marker = path.join(os.tmpdir(), `fsus-browser-contract-cleanup-once-${process.pid}-${Date.now()}`)
  await rm(marker, { force: true })
  context.after(async () => { await rm(marker, { force: true }) })
  const { directory, env, log } = await harness(context, {
    FAKE_PROVIDER_FAIL: 'createPendingComment',
    FAKE_CLEANUP_FAIL_ONCE_FILE: marker
  })
  let failure
  try {
    await prepareBrowserContractFixture({ env, repoRoot: directory, sourceState, build })
  } catch (error) {
    failure = error
  }

  assert.ok(failure instanceof Error)
  assert.match(failure.message, /provider failed during createPendingComment/u)
  assert.ok(failure.preparedFixture)
  assert.equal(failure.fixtureLifecycle.error.message, failure.message)
  assert.equal(failure.cleanup.status, 'failure')
  assert.equal(failure.cleanup.attempts, 1)
  assert.equal(failure.cleanup.resources.files.status, 'retained')
  assert.equal(failure.cleanup.resources.files.evidence.retainedForRetry, true)
  await access(failure.preparedFixture.root)

  for (const resource of Object.values(failure.cleanup.resources)) {
    resource.evidence.retainedForRetry = true
    resource.evidence.staleAttempt = 1
  }
  const retried = await cleanupBrowserContractFixture(failure.preparedFixture, {
    reason: 'startup-failure-retry'
  })

  assert.equal(retried, failure.cleanup)
  assert.equal(retried.status, 'success')
  assert.equal(retried.reason, 'startup-failure-retry')
  assert.equal(retried.attempts, 2)
  assert.equal(retried.error, null)
  for (const resource of Object.values(retried.resources)) {
    assert.equal('retainedForRetry' in resource.evidence, false)
    assert.equal('staleAttempt' in resource.evidence, false)
  }
  assert.equal(retried.resources.database.status, 'success')
  assert.equal(retried.resources.redis.status, 'success')
  assert.equal(retried.resources.processes.status, 'success')
  assert.equal(retried.resources.files.status, 'success')
  await assert.rejects(access(failure.preparedFixture.root), { code: 'ENOENT' })
  assert.match(failure.message, /provider failed during createPendingComment/u)
  assert.equal(failure.fixtureLifecycle.error.message, failure.message)

  const operations = (await readFile(log, 'utf8')).trim().split('\n')
  assert.deepEqual(operations, [
    'resetContractNamespace:prepare',
    'createPublishedArticle:',
    'createPendingComment:',
    'resetContractNamespace:cleanup',
    'resetContractNamespace:cleanup'
  ])
})

test('runner records failed and successful startup cleanup attempts while retaining the primary contract failure', async (context) => {
  const marker = path.join(os.tmpdir(), `fsus-browser-contract-runner-cleanup-once-${process.pid}-${Date.now()}`)
  await rm(marker, { force: true })
  context.after(async () => { await rm(marker, { force: true }) })
  const { directory, env } = await harness(context, {
    FAKE_PROVIDER_FAIL: 'createPendingComment',
    FAKE_CLEANUP_FAIL_ONCE_FILE: marker
  })
  const buildReceipt = await createRunnerBuildReceipt(directory)
  const outputRoot = path.join(
    repositoryRoot,
    '.tmp/browser-contract',
    `startup-cleanup-retry-${process.pid}-${Date.now()}`
  )
  context.after(async () => { await rm(outputRoot, { recursive: true, force: true }) })

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
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /provider failed during createPendingComment/u)
  assert.doesNotMatch(result.stderr, /cleanup failure:/u)
  const receipt = JSON.parse(await readFile(path.join(outputRoot, 'receipt.json'), 'utf8'))
  assert.equal(receipt.status, 'failure')
  assert.equal(receipt.classification, 'contract')
  assert.match(receipt.error.message, /provider failed during createPendingComment/u)
  assert.equal(receipt.fixture.cleanup.status, 'success')
  assert.equal(receipt.fixture.cleanup.attempts, 2)
  assert.deepEqual(receipt.fixture.cleanupAttempts.map((attempt) => attempt.status), ['failure', 'success'])
  assert.equal(receipt.fixture.cleanupAttempts[0].attempts, 1)
  assert.equal(receipt.fixture.cleanupAttempts[0].resources.files.evidence.retainedForRetry, true)
  assert.equal(receipt.fixture.cleanupAttempts[1].attempts, 2)
  assert.equal('retainedForRetry' in receipt.fixture.cleanupAttempts[1].resources.files.evidence, false)
  assert.match(receipt.fixture.lifecycle.error.message, /provider failed during createPendingComment/u)
})
