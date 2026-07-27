import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  canonicalRepositoryIdentity,
  classifyContainerCandidate,
  classifyProcessCandidate,
  discoverClassifyAndCleanupOrphanRuntimes
} from '../../tools/test-matrix/production-fresh-orphan-runtime-discovery.mjs'

function digest(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-orphan-ownership-'))
  fs.mkdirSync(path.join(root, 'src/backend/bin'), { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function ownedContainer(root, overrides = {}) {
  const runId = overrides.runId ?? 'production-2026-07-27_10-00-00-000-99999'
  return {
    Id: overrides.id ?? 'a'.repeat(64),
    Name: overrides.name ?? '/fsusblog-test-postgres-same-name',
    Created: overrides.createdAt ?? '2026-07-27T01:00:00.000Z',
    State: { Running: true },
    HostConfig: { CgroupParent: '/fsusblog-production' },
    Config: {
      Labels: overrides.labels ?? {
        'io.fsusblog.test.run-id': runId,
        'io.fsusblog.test.bundle-id': 'runtime-browser',
        'io.fsusblog.test.step-id': 'bootstrap',
        'io.fsusblog.test.namespace': `${runId}-fresh-local-production-0`,
        'io.fsusblog.test.repository-root-digest': canonicalRepositoryIdentity(root).repositoryRootDigest
      }
    }
  }
}

function processCandidate(root, platform, containment) {
  const args = ['/usr/bin/dotnet', path.join(root, 'src/backend/bin/FsusBlog.Server.dll')]
  const runId = 'production-2026-07-27_10-00-00-000-99999'
  return {
    pid: 5101,
    parentPid: 1,
    processGroupId: containment?.processGroupId ?? null,
    sessionId: containment?.processGroupId ?? null,
    jobObject: containment?.jobObject ?? null,
    args,
    cwd: root,
    environment: {
      FSUSBLOG_TEST_RUN_ID: runId,
      FSUSBLOG_TEST_NAMESPACE: `${runId}-fresh-local-production-0`,
      FSUSBLOG_REPOSITORY_ROOT_DIGEST: canonicalRepositoryIdentity(root).repositoryRootDigest
    },
    identityStatus: 'verified',
    processStartIdentity: `${platform}:start`,
    executablePath: '/usr/bin/dotnet',
    executableDigest: digest('dotnet'),
    commandDigest: digest(args.join('\0')),
    cgroup: platform === 'linux' ? '0::/fsusblog-production' : null,
    openPorts: []
  }
}

test('same-name container without ownership labels is never removed', (t) => {
  const root = fixtureRoot(t)
  const unlabeled = ownedContainer(root, { labels: {} })
  assert.equal(classifyContainerCandidate(unlabeled, { root }).classification, 'identity-unverifiable')
  let removeCount = 0
  const result = discoverClassifyAndCleanupOrphanRuntimes({
    root,
    currentRunId: 'production-current',
    terminationGraceMs: 100,
    discoverProcesses: () => [],
    listContainers: () => [unlabeled.Id],
    inspectContainer: () => unlabeled,
    removeContainer: () => {
      removeCount += 1
      return { removed: true }
    }
  })
  assert.equal(removeCount, 0)
  assert.equal(result.containerRecords[0].classification, 'identity-unverifiable')
  assert.equal(result.containerRecords[0].action, 'blocked-identity-incomplete')
})

test('fully labeled orphan container is removed by full ID and post-observed by name and ID', (t) => {
  const root = fixtureRoot(t)
  const container = ownedContainer(root)
  let present = true
  const removed = []
  const result = discoverClassifyAndCleanupOrphanRuntimes({
    root,
    currentRunId: 'production-current',
    terminationGraceMs: 100,
    discoverProcesses: () => [],
    activeRunStatus: () => ({ status: 'inactive' }),
    listContainers: () => [container.Id],
    inspectContainer: (identity) => present
      && [container.Id, container.Name.slice(1)].includes(identity)
      ? container
      : null,
    removeContainer: (id) => {
      removed.push(id)
      present = false
      return { removed: true }
    }
  })
  assert.deepEqual(removed, [container.Id])
  assert.equal(result.containerRecords[0].classification, 'owned-orphan')
  assert.equal(result.containerRecords[0].postObservation, 'name-and-id-absent')
})

test('container bound to another canonical repository is retained as external', (t) => {
  const root = fixtureRoot(t)
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-container-other-'))
  t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }))
  const container = ownedContainer(root)
  container.Config.Labels['io.fsusblog.test.repository-root-digest'] =
    canonicalRepositoryIdentity(otherRoot).repositoryRootDigest
  assert.equal(classifyContainerCandidate(container, { root }).classification, 'external-not-owned')
})

test('Linux and macOS require process-group identity; Windows requires Job Object identity', (t) => {
  const root = fixtureRoot(t)
  for (const platform of ['linux', 'darwin']) {
    const owned = processCandidate(root, platform, { processGroupId: 5101 })
    assert.equal(classifyProcessCandidate(owned, {
      root,
      platform,
      activeRunStatus: () => ({ status: 'inactive' })
    }).classification, 'owned-orphan')
    assert.equal(classifyProcessCandidate({ ...owned, processGroupId: null }, {
      root,
      platform,
      activeRunStatus: () => ({ status: 'inactive' })
    }).classification, 'identity-unverifiable')
  }

  const jobObject = {
    kind: 'windows-job-object',
    jobName: 'Local\\FsusBlog-production-runtime',
    authorityId: digest('job-authority')
  }
  const windows = processCandidate(root, 'win32', { jobObject })
  assert.equal(classifyProcessCandidate(windows, {
    root,
    platform: 'win32',
    activeRunStatus: () => ({ status: 'inactive' })
  }).classification, 'owned-orphan')
  assert.equal(classifyProcessCandidate({ ...windows, jobObject: null }, {
    root,
    platform: 'win32',
    activeRunStatus: () => ({ status: 'inactive' })
  }).classification, 'identity-unverifiable')
})

test('Windows owned orphan delegates exactly once to Job-aware termination adapter', (t) => {
  const root = fixtureRoot(t)
  const windows = processCandidate(root, 'win32', {
    jobObject: {
      kind: 'windows-job-object',
      jobName: 'Local\\FsusBlog-production-runtime',
      authorityId: digest('job-authority')
    }
  })
  let alive = true
  let calls = 0
  const result = discoverClassifyAndCleanupOrphanRuntimes({
    root,
    platform: 'win32',
    currentRunId: 'production-current',
    terminationGraceMs: 100,
    discoverProcesses: () => alive ? [windows] : [],
    activeRunStatus: () => ({ status: 'inactive' }),
    terminateProcess: (candidate, options) => {
      calls += 1
      assert.equal(candidate.observation.jobObject.kind, 'windows-job-object')
      assert.equal(options.platform, 'win32')
      alive = false
      return { terminated: true, postObservation: 'leader-and-group-absent' }
    },
    listContainers: () => []
  })
  assert.equal(calls, 1)
  assert.equal(result.processRecords[0].action, 'terminated')
})

test('macOS owned orphan delegates to process-group termination and post-observation', (t) => {
  const root = fixtureRoot(t)
  const mac = processCandidate(root, 'darwin', { processGroupId: 5101 })
  let alive = true
  let calls = 0
  const result = discoverClassifyAndCleanupOrphanRuntimes({
    root,
    platform: 'darwin',
    currentRunId: 'production-current',
    terminationGraceMs: 100,
    discoverProcesses: () => alive ? [mac] : [],
    activeRunStatus: () => ({ status: 'inactive' }),
    terminateProcess: (candidate, options) => {
      calls += 1
      assert.equal(candidate.observation.processGroupId, 5101)
      assert.equal(options.platform, 'darwin')
      alive = false
      return { terminated: true, postObservation: 'leader-and-group-absent' }
    },
    listContainers: () => []
  })
  assert.equal(calls, 1)
  assert.equal(result.processRecords[0].postObservation, 'leader-and-group-absent')
})

test('default adapters retain repository and containment boundaries without name-wide kill fallbacks', () => {
  const source = fs.readFileSync(
    'tools/test-matrix/production-fresh-orphan-runtime-discovery.mjs',
    'utf8'
  )
  assert.doesNotMatch(source, /\bpkill\b|\bkillall\b/u)
  assert.match(source, /canonicalRepositoryIdentity\(root\)/u)
  assert.match(source, /process\.kill\(-groupId, signal\)/u)
  assert.match(source, /jobObject\?\.kind === 'windows-job-object'/u)
  assert.match(source, /classification !== 'owned-orphan'/u)
  assert.match(source, /\['owned-orphan', 'identity-unverifiable'\]/u)
})

test('runtime and schema-container producers emit canonical repository ownership labels', () => {
  const bootstrap = fs.readFileSync('tools/bootstrap-acceptance-env.sh', 'utf8')
  const schemaFixture = fs.readFileSync(
    'tests/backend/Fixtures/PostgresSchemaMigrationFixture.cs',
    'utf8'
  )
  for (const source of [bootstrap, schemaFixture]) {
    assert.match(source, /io\.fsusblog\.test\.repository-root-digest/u)
    assert.match(source, /io\.fsusblog\.test\.run-id/u)
    assert.match(source, /io\.fsusblog\.test\.namespace/u)
    assert.match(source, /io\.fsusblog\.test\.bundle-id/u)
    assert.match(source, /io\.fsusblog\.test\.step-id/u)
  }
})
