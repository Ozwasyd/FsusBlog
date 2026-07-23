import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  cleanupBrowserContractFixture,
  createBrowserContractFixtureApi,
  prepareBrowserContractFixture,
  resolveBrowserContractRunIdentity
} from '../browser-contract/fixture-lifecycle.mjs'
import { fixtureReceiptView, loadBrowserContractFixture } from '../browser-contract/fixture.mjs'
import {
  compensateVerifiedContainerCleanup,
  derivePendingCommentPrivacyIdentity,
  removeVerifiedContainerById,
  validateDefaultFixtureProviderState
} from '../browser-contract/default-fixture-provider.mjs'

const commit = 'a'.repeat(40)
const fingerprint = 'b'.repeat(64)
const buildDigest = `sha256:${'c'.repeat(64)}`

async function createHarness(context, extraEnv = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fsus-browser-contract-fixture-'))
  context.after(async () => { await rm(root, { recursive: true, force: true }) })
  const providerFile = path.join(root, 'provider.mjs')
  const providerLog = path.join(root, 'provider.jsonl')
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
            image: 'postgres:16-alpine'
          },
          redis: {
            name: request.resources.redisInstance,
            id: 'e'.repeat(64),
            image: 'redis:7-alpine'
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
`)
  await chmod(providerFile, 0o700)

  const fixtureBase = path.join(root, 'fixtures')
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
  }
}

async function readProviderRequests(file) {
  const raw = await readFile(file, 'utf8')
  return raw.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
}

async function permissionBits(file) {
  return (await stat(file)).mode & 0o777
}

function assertCleanupResources(cleanup, expectedStatus = 'success') {
  assert.deepEqual(Object.keys(cleanup.resources).sort(), ['database', 'files', 'processes', 'redis'])
  for (const name of ['database', 'redis', 'processes', 'files']) {
    assert.equal(cleanup.resources[name].status, expectedStatus)
    assert.ok(cleanup.resources[name].evidence && typeof cleanup.resources[name].evidence === 'object')
  }
}

async function waitForJson(file, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`timed out waiting for ${file}`)
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

test('default provider removes only the pre-inspected full container id and refuses a same-name replacement', async () => {
  const containerId = 'd'.repeat(64)
  const replacementId = 'e'.repeat(64)
  const name = 'fsusblog-test-postgres-bc-a1b2c3d4-0123456789-abcdef'
  const original = { Id: containerId, Name: `/${name}` }
  const helperInspection = { Id: containerId, Config: { Labels: {} } }
  const replacement = { Id: replacementId, Name: `/${name}` }
  let idRecord = original
  let nameRecord = original
  const removalTargets = []

  const outcome = removeVerifiedContainerById(containerId, {
    name,
    inspected: helperInspection,
    expected: { id: containerId, name },
    inspectById: () => idRecord,
    inspectByName: () => nameRecord,
    removeById: (target) => {
      removalTargets.push(target)
      idRecord = null
      nameRecord = replacement
      return { status: 0 }
    }
  })

  assert.deepEqual(removalTargets, [containerId])
  assert.equal(outcome.removed, false)
  assert.equal(outcome.reason, 'container-name-replaced-after-removal')
  assert.equal(nameRecord.Id, replacementId)

  let mismatchedRemovalCalls = 0
  const mismatched = removeVerifiedContainerById(containerId, {
    name,
    inspected: { Id: replacementId, Config: { Labels: {} } },
    expected: { id: containerId, name },
    inspectById: () => original,
    inspectByName: () => original,
    removeById: () => {
      mismatchedRemovalCalls += 1
      return { status: 0 }
    }
  })
  assert.equal(mismatched.removed, false)
  assert.equal(mismatched.reason, 'container-removal-identity-mismatch')
  assert.equal(mismatchedRemovalCalls, 0)

  let vanishedId = original
  let vanishedName = original
  const failedCommand = removeVerifiedContainerById(containerId, {
    name,
    inspected: helperInspection,
    expected: { id: containerId, name },
    inspectById: () => vanishedId,
    inspectByName: () => vanishedName,
    removeById: () => {
      vanishedId = null
      vanishedName = null
      return { status: 42 }
    }
  })
  assert.deepEqual(failedCommand, {
    removed: false,
    exitCode: 42,
    reason: 'container-remove-command-failed'
  })

  let idempotentRemovalCalls = 0
  const idempotent = removeVerifiedContainerById(containerId, {
    name,
    inspected: helperInspection,
    expected: { id: containerId, name },
    inspectById: () => null,
    inspectByName: () => null,
    removeById: () => {
      idempotentRemovalCalls += 1
      return { status: 0 }
    }
  })
  assert.deepEqual(idempotent, { removed: true, exitCode: 0, reason: null })
  assert.equal(idempotentRemovalCalls, 0)

  const source = await readFile(new URL('../browser-contract/default-fixture-provider.mjs', import.meta.url), 'utf8')
  const cleanupSource = source.match(/async function cleanupOwnedRuntime[\s\S]+?(?=\nasync function bootstrapDedicatedRuntime)/u)?.[0]
  assert.ok(cleanupSource, 'owned runtime cleanup must remain statically inspectable')
  assert.match(cleanupSource, /removeContainer:\s*\(containerId,\s*\{ name, inspected \}/u)
  assert.match(cleanupSource, /removeVerifiedContainerById\(containerId/u)
  assert.match(cleanupSource, /inspectContainerIdOptional\(observed\.id\)/u)
  assert.match(cleanupSource, /inspectContainerOptional\(observed\.name\)/u)
  assert.doesNotMatch(cleanupSource, /\['rm',[^\n]+observed\.name/u)
  const localCleanupIndex = cleanupSource.indexOf('cleanupLocalRuntime({')
  const compensationIndex = cleanupSource.indexOf('compensateVerifiedContainerCleanup(observedBefore.values())')
  assert.ok(localCleanupIndex >= 0 && compensationIndex > localCleanupIndex)
  assert.match(cleanupSource, /compensationFailures\.length === 0/u)
  assert.match(source, /path\.join\(repoRoot, '\.tmp', 'run-once', namespace\)/u)
  assert.match(cleanupSource, /const filePaths = runtimeRecoveryPaths\(request\)[\s\S]*?confirmedAbsent: retainedFilePaths\.length === 0/u)
  assert.match(cleanupSource, /result\.cleanupStatus === 'complete'[\s\S]*?files\.status === 'success'/u)
  assert.match(cleanupSource, /files\s*\n\s*\}/u)
})

function fakeContainerRuntime(initialContainers) {
  const byId = new Map()
  const byName = new Map()
  const removalTargets = []
  for (const container of initialContainers) {
    byId.set(container.Id, container)
    byName.set(container.Name.slice(1), container)
  }
  return {
    byId,
    byName,
    removalTargets,
    inspectById: (id) => byId.get(id) ?? null,
    inspectByName: (name) => byName.get(name) ?? null,
    removeById: (id) => {
      removalTargets.push(id)
      const container = byId.get(id)
      if (container) {
        byId.delete(id)
        byName.delete(container.Name.slice(1))
      }
      return { status: 0 }
    }
  }
}

test('provider compensation removes verified full IDs when the runtime env inventory is missing or partial', () => {
  const postgres = {
    Id: 'd'.repeat(64),
    Name: '/fsusblog-test-postgres-bc-a1b2c3d4-0123456789-abcdef'
  }
  const redis = {
    Id: 'e'.repeat(64),
    Name: '/fsusblog-test-redis-bc-a1b2c3d4-0123456789-abcdef'
  }

  // A missing env file means local-runtime cleanup discovers neither container.
  const missing = fakeContainerRuntime([postgres, redis])
  const missingOutcomes = compensateVerifiedContainerCleanup([postgres, redis], missing)
  assert.deepEqual(missing.removalTargets, [postgres.Id, redis.Id])
  assert.deepEqual(missingOutcomes.map((entry) => entry.removed), [true, true])
  assert.equal(missing.byId.size, 0)
  assert.equal(missing.byName.size, 0)

  // A partially written env file may let local-runtime cleanup remove only one.
  const partial = fakeContainerRuntime([redis])
  const partialOutcomes = compensateVerifiedContainerCleanup([postgres, redis], partial)
  assert.deepEqual(partial.removalTargets, [redis.Id])
  assert.deepEqual(partialOutcomes.map((entry) => entry.removed), [true, true])
  assert.equal(partial.byId.size, 0)
  assert.equal(partial.byName.size, 0)
})

test('provider compensation refuses a same-name replacement and allows a later full-ID retry', () => {
  const original = {
    Id: 'd'.repeat(64),
    Name: '/fsusblog-test-postgres-bc-a1b2c3d4-0123456789-abcdef'
  }
  const replacement = { Id: 'f'.repeat(64), Name: original.Name }
  const replaced = fakeContainerRuntime([replacement])
  const refusal = compensateVerifiedContainerCleanup([original], replaced)
  assert.equal(refusal[0].removed, false)
  assert.equal(refusal[0].reason, 'container-name-replaced-before-removal')
  assert.deepEqual(replaced.removalTargets, [])
  assert.equal(replaced.byId.get(replacement.Id), replacement)

  const retryable = fakeContainerRuntime([original])
  let failFirstRemoval = true
  const removeById = (id) => {
    retryable.removalTargets.push(id)
    if (failFirstRemoval) {
      failFirstRemoval = false
      return { status: 42 }
    }
    const container = retryable.byId.get(id)
    retryable.byId.delete(id)
    retryable.byName.delete(container.Name.slice(1))
    return { status: 0 }
  }
  const first = compensateVerifiedContainerCleanup([original], { ...retryable, removeById })
  assert.equal(first[0].removed, false)
  assert.equal(first[0].exitCode, 42)
  assert.equal(first[0].reason, 'container-id-survived-removal')
  assert.equal(retryable.byId.get(original.Id), original)

  const second = compensateVerifiedContainerCleanup([original], { ...retryable, removeById })
  assert.equal(second[0].removed, true)
  assert.equal(second[0].reason, null)
  assert.deepEqual(retryable.removalTargets, [original.Id, original.Id])
  assert.equal(retryable.byId.size, 0)
  assert.equal(retryable.byName.size, 0)
})

test('pending comment fixture uses deterministic ZK privacy fields and resets every identity linkage on conflict', async () => {
  const namespace = 'bc-a1b2c3d4-0123456789-abcdef'
  const first = derivePendingCommentPrivacyIdentity(namespace, '101')
  const repeated = derivePendingCommentPrivacyIdentity(namespace, '101')
  const otherNamespace = derivePendingCommentPrivacyIdentity('bc-a1b2c3d4-0123456789-fedcba', '101')
  const otherArticle = derivePendingCommentPrivacyIdentity(namespace, '102')
  assert.deepEqual(repeated, first)
  assert.equal(first.nullifierHash, createHash('sha256')
    .update(`browser-contract:nullifier:${namespace}:101`)
    .digest('hex'))
  assert.equal(first.moderationSubjectHash, createHash('sha256')
    .update(`browser-contract:moderation:${namespace}:101`)
    .digest('hex'))
  assert.match(first.nullifierHash, /^[a-f0-9]{64}$/u)
  assert.match(first.moderationSubjectHash, /^[a-f0-9]{64}$/u)
  assert.notEqual(first.nullifierHash, first.moderationSubjectHash)
  assert.notEqual(otherNamespace.nullifierHash, first.nullifierHash)
  assert.notEqual(otherNamespace.moderationSubjectHash, first.moderationSubjectHash)
  assert.notEqual(otherArticle.nullifierHash, first.nullifierHash)
  assert.notEqual(otherArticle.moderationSubjectHash, first.moderationSubjectHash)
  assert.match(first.anonymousHandle, /^bc-[a-f0-9]{16}$/u)
  assert.throws(() => derivePendingCommentPrivacyIdentity(namespace, '0'), /article id/iu)
  assert.throws(() => derivePendingCommentPrivacyIdentity(namespace, '01'), /article id/iu)

  const source = await readFile(new URL('../browser-contract/default-fixture-provider.mjs', import.meta.url), 'utf8')
  const pendingSource = source.match(/async function pendingComment[\s\S]+?(?=\nasync function respond)/u)?.[0]
  assert.ok(pendingSource, 'pending comment provider implementation must remain statically inspectable')
  const valuesIndex = pendingSource.indexOf(') VALUES (')
  const conflictIndex = pendingSource.indexOf(') ON CONFLICT (id) DO UPDATE SET')
  assert.ok(valuesIndex > 0 && conflictIndex > valuesIndex)
  const insertColumns = pendingSource.slice(0, valuesIndex)
  const insertValues = pendingSource.slice(valuesIndex, conflictIndex)
  const conflictUpdate = pendingSource.slice(conflictIndex)

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
  ]) assert.match(insertColumns, new RegExp(`\\b${column}\\b`, 'u'))
  assert.match(insertValues, /NULL, 'zk_anonymous', NULL/iu)
  assert.match(insertValues, /NULL, NULL, NULL, 'common', true/iu)
  assert.match(insertValues, /\$\{privacy\.nullifierHash\}/u)
  assert.match(insertValues, /\$\{privacy\.moderationSubjectHash\}/u)
  assert.doesNotMatch(insertValues, /'basic'\s*,\s*'fixture'\s*,\s*'fixture'/iu)

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
  ]) assert.match(conflictUpdate, new RegExp(`\\b${field}\\s*=`, 'u'))
  assert.match(conflictUpdate, /credential_level\s*=\s*NULL/iu)
  assert.match(conflictUpdate, /reputation_bucket\s*=\s*NULL/iu)
  assert.match(conflictUpdate, /account_age_bucket\s*=\s*NULL/iu)
  assert.match(conflictUpdate, /anonymous_requires_moderation\s*=\s*true/iu)
})

async function waitForProcessExit(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`process ${pid} survived the provider TERM-to-KILL budget`)
}

test('run identity is immutable and fixed at one session/concurrency regardless of live resource hints', async (context) => {
  const harness = await createHarness(context, {
    FSUSBLOG_PLAYWRIGHT_WORKERS: '64',
    FSUSBLOG_SCHEDULER_CPU_GRANT: '64',
    FSUSBLOG_SCHEDULER_MEMORY_GRANT: '128',
    FSUSBLOG_POSTGRES_PID_HEADROOM: '999'
  })
  const identity = resolveBrowserContractRunIdentity({
    env: harness.env,
    sourceState: harness.sourceState,
    repoRoot: harness.root,
    now: new Date('2026-07-18T00:00:00.000Z')
  })

  assert.equal(identity.sessionMode, 'browser-contract')
  assert.equal(identity.sessions, 1)
  assert.equal(identity.concurrency, 1)
  assert.equal(identity.commit, commit)
  assert.equal(identity.runId, 'run-42')
  assert.equal(identity.laneId, 'browser-contract')
  assert.match(identity.namespace, /^[a-z0-9_-]+$/u)
  assert.equal(identity.databaseSchema, 'public')
  assert.equal(identity.databaseInstance, `fsusblog-test-postgres-${identity.namespace}`)
  assert.ok(identity.redisNamespace.includes(identity.namespace))
  assert.equal(identity.redisInstance, `fsusblog-test-redis-${identity.namespace}`)
  assert.ok(path.resolve(identity.fixtureRoot).startsWith(path.resolve(harness.root)))

  const repeated = resolveBrowserContractRunIdentity({
    env: { ...harness.env, FSUSBLOG_PLAYWRIGHT_WORKERS: '1', FSUSBLOG_SCHEDULER_MEMORY_GRANT: '1' },
    sourceState: harness.sourceState,
    repoRoot: harness.root,
    now: new Date('2030-01-01T00:00:00.000Z')
  })
  assert.deepEqual(repeated, identity)
})

test('contract topology and session mode reject widening instead of falling back', async (context) => {
  const harness = await createHarness(context)
  for (const override of [
    { FSUSBLOG_BROWSER_CONTRACT_SESSIONS: '2' },
    { FSUSBLOG_BROWSER_CONTRACT_CONCURRENCY: '2' },
    { FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-diagnostics' }
  ]) {
    assert.throws(() => resolveBrowserContractRunIdentity({
      env: { ...harness.env, ...override },
      sourceState: harness.sourceState,
      repoRoot: harness.root
    }), /browser contract|session|concurrency|mode/iu)
  }
})

test('formal fixture API sends only stable run identity and isolated resources to its provider', async (context) => {
  const harness = await createHarness(context)
  const preparation = Object.freeze({
    id: '11111111-1111-4111-8111-111111111111',
    startedAt: '2026-07-18T00:00:00.000Z'
  })
  const identity = resolveBrowserContractRunIdentity({
    env: harness.env,
    sourceState: harness.sourceState,
    repoRoot: harness.root
  })
  const api = createBrowserContractFixtureApi({
    identity,
    env: harness.env,
    repoRoot: harness.root,
    sourceState: harness.sourceState,
    build: harness.build,
    preparation
  })

  assert.deepEqual(Object.keys(api).sort(), [
    'createAdminSession',
    'createPendingComment',
    'createPublishedArticle',
    'createUserSession',
    'resetContractNamespace'
  ])
  const [article, comment, user, admin] = await Promise.all([
    api.createPublishedArticle(),
    api.createPendingComment(),
    api.createUserSession(),
    api.createAdminSession()
  ])
  assert.deepEqual({ article: article.id, comment: comment.id, user: user.id, admin: admin.id }, {
    article: '101', comment: '202', user: 303, admin: 404
  })

  const requests = await readProviderRequests(harness.providerLog)
  assert.equal(requests.length, 4)
  assert.deepEqual(new Set(requests.map((request) => request.operation)), new Set([
    'createPublishedArticle', 'createPendingComment', 'createUserSession', 'createAdminSession'
  ]))
  for (const request of requests) {
    assert.equal(request.schema, 'fsusblog.browser-contract-fixture-provider-request.v1')
    assert.deepEqual(request.identity, {
      commit,
      runId: identity.runId,
      laneId: identity.laneId,
      namespace: identity.namespace
    })
    assert.deepEqual(request.preparation, preparation)
    assert.deepEqual(Object.keys(request.resources).sort(), [
      'databaseInstance',
      'databaseSchema',
      'fixtureRoot',
      'redisInstance',
      'redisNamespace'
    ])
    assert.equal(request.resources.databaseSchema, identity.databaseSchema)
    assert.equal(request.resources.redisNamespace, identity.redisNamespace)
    assert.equal(request.resources.fixtureRoot, identity.fixtureRoot)
    assert.match(request.resources.databaseInstance, /\S/u)
    assert.match(request.resources.redisInstance, /\S/u)
    assert.equal(request.sourceState.commit, commit)
    assert.equal(request.build.receiptContentDigest, buildDigest)
    assert.equal('workers' in request, false)
    assert.equal('memory' in request, false)
    assert.equal('pidHeadroom' in request, false)
  }
})

test('default provider state is bound to current source, build, namespace, and owned runtime instances', async (context) => {
  const harness = await createHarness(context)
  const preparation = {
    id: '22222222-2222-4222-8222-222222222222',
    startedAt: '2026-07-18T00:00:00.000Z'
  }
  const identity = resolveBrowserContractRunIdentity({
    env: harness.env,
    sourceState: harness.sourceState,
    repoRoot: harness.root
  })
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
  }
  const state = {
    schema: 'fsusblog.browser-contract-default-provider-state.v1',
    phase: 'prepared',
    namespace: identity.namespace,
    preparation,
    runtime: {
      frontendUrl: 'http://127.0.0.1:39101',
      backendUrl: 'http://127.0.0.1:39102',
      isolatedDatabase: true,
      testSessionHeader: false
    },
    containers: {
      postgres: { name: identity.databaseInstance, id: 'd'.repeat(64), image: 'postgres:16-alpine' },
      redis: { name: identity.redisInstance, id: 'e'.repeat(64), image: 'redis:7-alpine' }
    },
    sourceState: harness.sourceState,
    buildIdentity: { receiptContentDigest: buildDigest }
  }
  assert.equal(validateDefaultFixtureProviderState(state, request), state)

  const preparing = structuredClone(state)
  preparing.phase = 'preparing'
  preparing.runtime = null
  preparing.containers.postgres.id = null
  preparing.containers.redis.id = null
  assert.equal(validateDefaultFixtureProviderState(preparing, request), preparing)

  const clone = () => structuredClone(state)
  const staleNamespace = clone()
  staleNamespace.namespace = `${identity.namespace}-stale`
  const stalePreparationId = clone()
  stalePreparationId.preparation.id = '33333333-3333-4333-8333-333333333333'
  const stalePreparationStartedAt = clone()
  stalePreparationStartedAt.preparation.startedAt = '2026-07-17T23:59:59.000Z'
  const wrongSource = clone()
  wrongSource.sourceState.worktreeFingerprint = 'f'.repeat(64)
  const wrongBuild = clone()
  wrongBuild.buildIdentity.receiptContentDigest = `sha256:${'0'.repeat(64)}`
  const wrongDatabase = clone()
  wrongDatabase.containers.postgres.name = 'shared-postgres'
  const wrongRedis = clone()
  wrongRedis.containers.redis.id = 'short-id'
  const sessionHeaderFallback = clone()
  sessionHeaderFallback.runtime.testSessionHeader = true
  for (const candidate of [
    staleNamespace,
    stalePreparationId,
    stalePreparationStartedAt,
    wrongSource,
    wrongBuild,
    wrongDatabase,
    wrongRedis,
    sessionHeaderFallback
  ]) {
    assert.throws(
      () => validateDefaultFixtureProviderState(candidate, request),
      /identity|ownership|state/iu
    )
  }
})

test('prepare seals identity/entities/receipt and provider failure is fail closed', async (context) => {
  const harness = await createHarness(context)
  const prepared = await prepareBrowserContractFixture({
    env: harness.env,
    repoRoot: harness.root,
    sourceState: harness.sourceState,
    build: harness.build
  })
  const manifest = JSON.parse(await readFile(prepared.manifestFile, 'utf8'))
  assert.equal(manifest.schema, 'fsusblog.browser-contract-fixture.v2')
  assert.deepEqual(prepared.manifest, manifest)
  assert.equal(prepared.identity.sessions, 1)
  assert.equal(prepared.identity.concurrency, 1)
  assert.equal(manifest.identity.namespace, prepared.identity.namespace)
  assert.deepEqual(manifest.preparation, prepared.preparation)
  assert.deepEqual(prepared.lifecycle.preparation, prepared.preparation)
  assert.equal(manifest.resources.databaseSchema, prepared.identity.databaseSchema)
  assert.equal(manifest.resources.databaseInstance, prepared.identity.databaseInstance)
  assert.equal(manifest.resources.redisNamespace, prepared.identity.redisNamespace)
  assert.equal(manifest.resources.redisInstance, prepared.identity.redisInstance)
  assert.equal(manifest.sourceState.commit, commit)
  assert.equal(manifest.buildIdentity.receiptContentDigest, buildDigest)
  assert.equal(manifest.entities.publicArticle.id, '101')
  assert.equal(manifest.entities.pendingComment.id, '202')
  assert.equal(manifest.entities.user.id, 303)
  assert.equal(manifest.entities.admin.id, 404)
  assert.equal(prepared.lifecycle.status, 'prepared')
  assert.equal(prepared.lifecycle.cleanup.status, 'pending')
  assert.equal(manifest.baseUrl, 'http://127.0.0.1:39101')
  assert.equal(manifest.backendUrl, 'http://127.0.0.1:39102')
  assert.deepEqual(manifest.transport, { testSessionHeader: false })
  assert.equal((await stat(prepared.manifestFile)).isFile(), true)
  assert.equal(await permissionBits(prepared.root), 0o700)
  assert.equal(await permissionBits(prepared.manifestFile), 0o600)
  assert.equal(await permissionBits(path.join(prepared.root, manifest.entities.user.storageStateFile)), 0o600)
  assert.equal(await permissionBits(path.join(prepared.root, manifest.entities.admin.storageStateFile)), 0o600)

  const fixture = await loadBrowserContractFixture({
    env: { ...harness.env, FSUSBLOG_TEST_SESSION: prepared.identity.namespace },
    repoRoot: harness.root,
    fixtureRoot: prepared.root,
    lifecycle: prepared.lifecycle,
    expectedSourceState: harness.sourceState,
    expectedBuild: harness.build
  })
  const receipt = fixtureReceiptView(fixture, harness.root)
  assert.equal(receipt.manifestSchema, 'fsusblog.browser-contract-fixture.v2')
  assert.deepEqual(receipt.topology, { sessions: 1, concurrency: 1 })
  assert.equal(receipt.databaseSchema, prepared.identity.databaseSchema)
  assert.equal(receipt.redisNamespace, prepared.identity.redisNamespace)
  assert.equal(receipt.publicArticleId, '101')
  assert.equal(receipt.pendingCommentId, '202')
  assert.equal(receipt.userId, 303)
  assert.equal(receipt.adminId, 404)
  assert.equal('cookies' in receipt, false)
  assert.equal(fixture.baseUrl, 'http://127.0.0.1:39101')
  assert.equal(fixture.backendUrl, 'http://127.0.0.1:39102')
  assert.equal(fixture.testSession, null)

  const sharedDatabaseManifest = structuredClone(manifest)
  sharedDatabaseManifest.ownership.containers.postgres.name = 'shared-postgres'
  await writeFile(prepared.manifestFile, `${JSON.stringify(sharedDatabaseManifest, null, 2)}\n`, { mode: 0o600 })
  await assert.rejects(loadBrowserContractFixture({
    env: { ...harness.env, FSUSBLOG_TEST_SESSION: prepared.identity.namespace },
    repoRoot: harness.root,
    fixtureRoot: prepared.root,
    lifecycle: prepared.lifecycle,
    expectedSourceState: harness.sourceState,
    expectedBuild: harness.build
  }), /database ownership|ownership identity/iu)
  await writeFile(prepared.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })

  const failedHarness = await createHarness(context, { FAKE_PROVIDER_FAIL_OPERATION: 'createPendingComment' })
  await assert.rejects(prepareBrowserContractFixture({
    env: failedHarness.env,
    repoRoot: failedHarness.root,
    sourceState: failedHarness.sourceState,
    build: failedHarness.build
  }), /createPendingComment|provider/iu)
  const failedIdentity = resolveBrowserContractRunIdentity({
    env: failedHarness.env,
    sourceState: failedHarness.sourceState,
    repoRoot: failedHarness.root
  })
  await assert.rejects(readFile(path.join(failedIdentity.fixtureRoot, 'contract-fixture.json'), 'utf8'), /ENOENT/u)
})

test('fixture security rejects symlink storage state and redacts provider stderr secrets', async (context) => {
  const symlinkHarness = await createHarness(context)
  const symlinkTarget = path.join(symlinkHarness.root, 'outside-user.storage-state.json')
  symlinkHarness.env.FAKE_PROVIDER_SYMLINK_ROLE = 'user'
  symlinkHarness.env.FAKE_PROVIDER_SYMLINK_TARGET = symlinkTarget
  await assert.rejects(prepareBrowserContractFixture({
    env: symlinkHarness.env,
    repoRoot: symlinkHarness.root,
    sourceState: symlinkHarness.sourceState,
    build: symlinkHarness.build
  }), /symlink|regular file|storage state/iu)
  assert.equal((await stat(symlinkTarget)).isFile(), true)

  const secret = 'provider-password-canary-1149'
  const redactionHarness = await createHarness(context, {
    FAKE_PROVIDER_FAIL_OPERATION: 'createPublishedArticle',
    FAKE_PROVIDER_FAILURE_STDERR: `postgres://fixture:${secret}@127.0.0.1/fsusblog\n`
  })
  let failure
  await assert.rejects(prepareBrowserContractFixture({
    env: redactionHarness.env,
    repoRoot: redactionHarness.root,
    sourceState: redactionHarness.sourceState,
    build: redactionHarness.build
  }), (error) => {
    failure = error
    return /createPublishedArticle|provider/iu.test(error.message)
  })
  const serialized = `${failure.message}\n${JSON.stringify(failure.fixtureLifecycle)}\n${JSON.stringify(failure.cleanup)}`
  assert.doesNotMatch(serialized, new RegExp(secret, 'u'))
  assert.doesNotMatch(serialized, /postgres:\/\/fixture:[^@\s]+@/iu)
})

test('a stale sealed manifest from the same run identity cannot replace the current preparation', async (context) => {
  const harness = await createHarness(context)
  const first = await prepareBrowserContractFixture({
    env: harness.env,
    repoRoot: harness.root,
    sourceState: harness.sourceState,
    build: harness.build
  })
  const staleManifest = await readFile(first.manifestFile, 'utf8')
  await cleanupBrowserContractFixture(first, { reason: 'completed' })

  await new Promise((resolve) => setTimeout(resolve, 20))
  const current = await prepareBrowserContractFixture({
    env: harness.env,
    repoRoot: harness.root,
    sourceState: harness.sourceState,
    build: harness.build
  })
  await writeFile(current.manifestFile, staleManifest, { mode: 0o600 })
  await assert.rejects(loadBrowserContractFixture({
    env: { ...harness.env, FSUSBLOG_TEST_SESSION: current.identity.namespace },
    repoRoot: harness.root,
    fixtureRoot: current.root,
    lifecycle: current.lifecycle,
    expectedSourceState: harness.sourceState,
    expectedBuild: harness.build
  }), /stale|fresh|generation|digest|current run/iu)
  const cleanup = await cleanupBrowserContractFixture(current, { reason: 'stale-fixture' })
  assert.equal(cleanup.status, 'success')
})

test('cleanup is idempotent and returns separate failure evidence without replacing the primary failure', async (context) => {
  const harness = await createHarness(context)
  const prepared = await prepareBrowserContractFixture({
    env: harness.env,
    repoRoot: harness.root,
    sourceState: harness.sourceState,
    build: harness.build
  })
  const first = await cleanupBrowserContractFixture(prepared, { reason: 'product-failure' })
  const second = await cleanupBrowserContractFixture(prepared, { reason: 'timeout' })
  assert.equal(first.status, 'success')
  assert.equal(second.status, 'success')
  assertCleanupResources(first)
  assert.equal(second, first)
  assert.equal(second.attempts, 1)
  assert.equal(second.reason, 'product-failure')

  const failResetMarker = path.join(os.tmpdir(), `fsus-browser-contract-fail-reset-${process.pid}-${Date.now()}`)
  context.after(async () => { await rm(failResetMarker, { force: true }) })
  const failingHarness = await createHarness(context, { FAKE_PROVIDER_FAIL_RESET_MARKER: failResetMarker })
  const failingPrepared = await prepareBrowserContractFixture({
    env: failingHarness.env,
    repoRoot: failingHarness.root,
    sourceState: failingHarness.sourceState,
    build: failingHarness.build
  })
  await writeFile(failResetMarker, 'fail cleanup\n')
  const primaryFailure = new Error('original product assertion')
  const cleanup = await cleanupBrowserContractFixture(failingPrepared, { reason: 'product-failure' })
  assert.equal(cleanup.status, 'failure')
  assert.match(cleanup.error.message, /resetContractNamespace|provider/iu)
  assert.equal(cleanup.resources.files.status, 'retained')
  assert.equal(cleanup.resources.files.evidence.retainedForRetry, true)
  assert.ok(['failure', 'unknown'].includes(cleanup.resources.database.status))
  assert.ok(['failure', 'unknown'].includes(cleanup.resources.redis.status))
  assert.equal(cleanup.resources.processes.status, 'failure')
  assert.equal(primaryFailure.message, 'original product assertion')

  await rm(failResetMarker, { force: true })
  const recovered = await cleanupBrowserContractFixture(failingPrepared, { reason: 'cleanup-retry' })
  assert.equal(recovered, cleanup)
  assert.equal(recovered.status, 'success')
  assert.equal(recovered.attempts, 2)
  assert.equal(recovered.resources.files.status, 'success')
  await assert.rejects(stat(failingPrepared.root), /ENOENT/u)
})

test('cancelled preparation and timeout cleanup both release the isolated fixture root', async (context) => {
  const cancelledHarness = await createHarness(context, {
    FAKE_PROVIDER_DELAY_OPERATION: 'createPublishedArticle',
    FAKE_PROVIDER_DELAY_MS: '10000'
  })
  const controller = new AbortController()
  const cancellation = prepareBrowserContractFixture({
    env: cancelledHarness.env,
    repoRoot: cancelledHarness.root,
    sourceState: cancelledHarness.sourceState,
    build: cancelledHarness.build,
    signal: controller.signal
  })
  setTimeout(() => controller.abort(new Error('injected cancellation')), 100).unref()
  let cancelled
  await assert.rejects(cancellation, (error) => {
    cancelled = error
    return /cancel/iu.test(error.message)
  })
  assert.equal(cancelled.fixtureLifecycle.error.failureClass, 'infra')
  assert.equal(cancelled.cleanup.status, 'success')
  assertCleanupResources(cancelled.cleanup)
  await assert.rejects(
    stat(path.resolve(cancelledHarness.root, cancelled.fixtureLifecycle.resources.fixtureRoot)),
    /ENOENT/u
  )

  const timeoutHarness = await createHarness(context)
  const timedOut = await prepareBrowserContractFixture({
    env: timeoutHarness.env,
    repoRoot: timeoutHarness.root,
    sourceState: timeoutHarness.sourceState,
    build: timeoutHarness.build
  })
  const cleanup = await cleanupBrowserContractFixture(timedOut, { reason: 'timeout' })
  assert.equal(cleanup.status, 'success')
  assert.equal(cleanup.reason, 'timeout')
  assertCleanupResources(cleanup)
  await assert.rejects(stat(timedOut.root), /ENOENT/u)
})

test('provider timeout terminates the complete stubborn process group within the TERM-to-KILL budget', async (context) => {
  const harness = await createHarness(context)
  const pidFile = path.join(harness.root, 'stubborn-provider-pids.json')
  harness.env.FAKE_PROVIDER_STUBBORN_OPERATION = 'createPublishedArticle'
  harness.env.FAKE_PROVIDER_PID_FILE = pidFile
  harness.env.FSUSBLOG_BROWSER_CONTRACT_PROVIDER_TIMEOUT_MS = '150'
  const startedAt = Date.now()
  const preparation = prepareBrowserContractFixture({
    env: harness.env,
    repoRoot: harness.root,
    sourceState: harness.sourceState,
    build: harness.build
  })
  const pids = await waitForJson(pidFile)
  let failure
  await assert.rejects(preparation, (error) => {
    failure = error
    return /timed out/iu.test(error.message)
  })
  assert.equal(failure.fixtureLifecycle.error.failureClass, 'infra')
  assert.ok(Date.now() - startedAt < 3_000, 'provider timeout exceeded the bounded TERM-to-KILL budget')
  await Promise.all([
    waitForProcessExit(pids.provider),
    waitForProcessExit(pids.grandchild)
  ])
  assert.equal(failure.cleanup.status, 'success')
  assertCleanupResources(failure.cleanup)
})

test('delayed provider KILL reaps an owned grandchild after its parent exits on TERM', async (context) => {
  const harness = await createHarness(context)
  const pidFile = path.join(harness.root, 'term-exit-provider-pids.json')
  harness.env.FAKE_PROVIDER_TERM_EXIT_OPERATION = 'createPublishedArticle'
  harness.env.FAKE_PROVIDER_PID_FILE = pidFile
  harness.env.FSUSBLOG_BROWSER_CONTRACT_PROVIDER_TIMEOUT_MS = '150'
  const preparation = prepareBrowserContractFixture({
    env: harness.env,
    repoRoot: harness.root,
    sourceState: harness.sourceState,
    build: harness.build
  })
  const pids = await waitForJson(pidFile)
  let failure
  await assert.rejects(preparation, (error) => {
    failure = error
    return /timed out/iu.test(error.message)
  })
  await Promise.all([
    waitForProcessExit(pids.provider),
    waitForProcessExit(pids.grandchild)
  ])
  assert.equal(failure.fixtureLifecycle.error.failureClass, 'infra')
  assert.equal(failure.cleanup.status, 'success')
  assertCleanupResources(failure.cleanup)
})
