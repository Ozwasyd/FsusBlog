import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  dotnetBuildServerInventory,
  managedOrphanDotnetBuildServer,
  selectOrphanDotnetBuildServers,
  terminateOrphanDotnetBuildServers
} from '../../tools/test-matrix/dotnet-build-server-cleanup.mjs'

const root = '/workspace/FsusBlog'
const currentRunId = 'production-2026-07-12_12-07-56-517-700'
const currentNamespace = `${currentRunId}-fresh-local-production-0`

function msbuildRecord(overrides = {}) {
  return {
    pid: 100,
    ppid: 1,
    startTimeTicks: '123456',
    cwd: root,
    args: [
      '/usr/lib/dotnet/dotnet',
      '/usr/lib/dotnet/sdk/10.0.108/MSBuild.dll',
      '/noautoresponse',
      '/nologo',
      '/nodemode:1',
      '/nodeReuse:true',
      '/low:false'
    ],
    env: {
      FSUSBLOG_TEST_RUN_ID: currentRunId,
      FSUSBLOG_TEST_NAMESPACE: currentNamespace,
      FSUSBLOG_PRODUCTION_BUILD_ROOT: `${root}/.tmp/build/${currentRunId}`
    },
    ...overrides
  }
}

test('managed dotnet build-server shape requires run binding, orphan PPID, start identity, and exact command', () => {
  assert.equal(managedOrphanDotnetBuildServer(msbuildRecord(), { root }), true)
  assert.equal(managedOrphanDotnetBuildServer(msbuildRecord({ ppid: 42 }), { root }), false)
  assert.equal(managedOrphanDotnetBuildServer(msbuildRecord({ startTimeTicks: '' }), { root }), false)
  assert.equal(managedOrphanDotnetBuildServer(msbuildRecord({ cwd: '/usr/lib/dotnet/sdk/10.0.108' }), { root }), true)
  assert.equal(managedOrphanDotnetBuildServer(msbuildRecord({ env: {} }), { root }), false)
  assert.equal(managedOrphanDotnetBuildServer(msbuildRecord({
    args: [...msbuildRecord().args, '/m']
  }), { root }), false)
  assert.equal(managedOrphanDotnetBuildServer(msbuildRecord({
    args: ['/usr/lib/dotnet/dotnet', '/tmp/MSBuild.dll', '/nodemode:1']
  }), { root }), false)
})

test('managed VBCSCompiler shape is exact and rejects a developer compiler command', () => {
  const compiler = msbuildRecord({
    args: [
      '/usr/lib/dotnet/dotnet',
      'exec',
      '/usr/lib/dotnet/sdk/10.0.108/Roslyn/bincore/VBCSCompiler.dll',
      '-pipename:compiler-server-123'
    ]
  })
  assert.equal(managedOrphanDotnetBuildServer(compiler, { root }), true)
  assert.equal(managedOrphanDotnetBuildServer({
    ...compiler,
    args: ['/usr/lib/dotnet/dotnet', 'build', 'src/backend/FsusBlog.Server.csproj']
  }, { root }), false)
})

test('selection cleans only the exact current binding', () => {
  const staleRunId = 'production-2026-07-12_11-00-00-000-600'
  const stale = msbuildRecord({
    pid: 101,
    env: {
      FSUSBLOG_TEST_RUN_ID: staleRunId,
      FSUSBLOG_TEST_NAMESPACE: `${staleRunId}-fresh-local-production-0`,
      FSUSBLOG_PRODUCTION_BUILD_ROOT: `${root}/.tmp/build/${staleRunId}`
    }
  })
  const activeRunId = 'production-2026-07-12_11-30-00-000-650'
  const active = msbuildRecord({
    pid: 102,
    env: {
      FSUSBLOG_TEST_RUN_ID: activeRunId,
      FSUSBLOG_TEST_NAMESPACE: `${activeRunId}-fresh-local-production-0`,
      FSUSBLOG_PRODUCTION_BUILD_ROOT: `${root}/.tmp/build/${activeRunId}`
    }
  })
  const manual = msbuildRecord({
    pid: 103,
    env: {
      FSUSBLOG_TEST_RUN_ID: 'developer-build',
      FSUSBLOG_TEST_NAMESPACE: 'developer-build'
    }
  })
  const selected = selectOrphanDotnetBuildServers([
    msbuildRecord(), stale, active, manual, msbuildRecord({ pid: 104, ppid: 900 })
  ], {
    root,
    currentRunId,
    currentNamespace,
    includeCurrentBinding: true,
    isRunActive: (runId) => runId === activeRunId
  })
  assert.deepEqual(selected.map(({ pid }) => pid), [100])
})

test('termination never signals sibling, IDE, external, or unknown server records', () => {
  const siblingRunId = 'production-2026-07-12_12-07-56-517-701'
  const records = [
    msbuildRecord({ pid: 100 }),
    msbuildRecord({ pid: 101, env: {
      FSUSBLOG_TEST_RUN_ID: siblingRunId,
      FSUSBLOG_TEST_NAMESPACE: `${siblingRunId}-fresh-local-production-0`,
      FSUSBLOG_PRODUCTION_BUILD_ROOT: `${root}/.tmp/build/${siblingRunId}`
    } }),
    msbuildRecord({ pid: 102, env: {} }),
    msbuildRecord({ pid: 103, env: {
      FSUSBLOG_TEST_RUN_ID: currentRunId,
      FSUSBLOG_TEST_NAMESPACE: currentNamespace,
      FSUSBLOG_PRODUCTION_BUILD_ROOT: '/unknown/build-root'
    } })
  ]
  const signals = []
  const terminated = terminateOrphanDotnetBuildServers(records, {
    root,
    currentRunId,
    currentNamespace,
    includeCurrentBinding: true,
    readProcess: (pid) => records.find((record) => record.pid === pid) ?? null,
    signalProcess: (pid, signal) => signals.push([pid, signal]),
    processExists: () => false,
    terminationGraceMs: 1
  })
  assert.deepEqual(terminated, [100])
  assert.deepEqual(signals, [[100, 'SIGTERM']])
})

test('build-root replacement after selection is not signalled', () => {
  const selected = msbuildRecord()
  const signals = []
  const terminated = terminateOrphanDotnetBuildServers([selected], {
    root,
    currentRunId,
    currentNamespace,
    includeCurrentBinding: true,
    readProcess: () => ({
      ...selected,
      env: { ...selected.env, FSUSBLOG_PRODUCTION_BUILD_ROOT: '/replacement/build-root' }
    }),
    signalProcess: (pid, signal) => signals.push([pid, signal]),
    processExists: () => false,
    terminationGraceMs: 1
  })
  assert.deepEqual(terminated, [])
  assert.deepEqual(signals, [])
})

test('inventory proves exact run and build-root ownership without classifying sibling, IDE, or unknown servers as current', () => {
  const siblingRunId = 'production-2026-07-12_12-07-56-517-701'
  const inventory = dotnetBuildServerInventory([
    msbuildRecord(),
    msbuildRecord({ pid: 101, env: {
      FSUSBLOG_TEST_RUN_ID: siblingRunId,
      FSUSBLOG_TEST_NAMESPACE: `${siblingRunId}-fresh-local-production-0`,
      FSUSBLOG_PRODUCTION_BUILD_ROOT: `${root}/.tmp/build/${siblingRunId}`
    } }),
    msbuildRecord({ pid: 102, env: {
      FSUSBLOG_TEST_RUN_ID: currentRunId,
      FSUSBLOG_TEST_NAMESPACE: currentNamespace,
      FSUSBLOG_PRODUCTION_BUILD_ROOT: '/unverifiable/build-root'
    } }),
    msbuildRecord({ pid: 103, env: {} }),
    msbuildRecord({ pid: 104, args: ['/usr/lib/dotnet/dotnet', 'build', 'other.csproj'] })
  ], {
    root,
    currentRunId,
    currentNamespace,
    isRunActive: (runId) => runId === siblingRunId
  })
  assert.equal(inventory.length, 4)
  assert.deepEqual(inventory.map((entry) => entry.startedByCurrentRun), [true, false, false, false])
  assert.deepEqual(inventory.map((entry) => entry.sharedWithOtherRun), [false, true, true, true])
  assert.equal(inventory[3].ownerState, 'external-unknown')
  assert.equal(inventory[0].serverKind, 'msbuild-node')
  assert.equal(inventory[0].buildRoot, `${root}/.tmp/build/${currentRunId}`)
  assert.equal(inventory[0].processIdentity.startTimeTicks, '123456')
})

test('termination revalidates PID start time, PPID, cwd, args, run id, and namespace before signaling', () => {
  const source = fs.readFileSync('tools/test-matrix/dotnet-build-server-cleanup.mjs', 'utf8')
  for (const contract of [
    'observed.ppid === expected.ppid',
    'observed.startTimeTicks === expected.startTimeTicks',
    'observed.cwd === expected.cwd',
    "observed.args.join('\\0') === expected.args.join('\\0')",
    'observed.env.FSUSBLOG_TEST_RUN_ID === expected.env.FSUSBLOG_TEST_RUN_ID',
    'observed.env.FSUSBLOG_TEST_NAMESPACE === expected.env.FSUSBLOG_TEST_NAMESPACE',
    'observed.env.FSUSBLOG_PRODUCTION_BUILD_ROOT === expected.env.FSUSBLOG_PRODUCTION_BUILD_ROOT'
  ]) assert.ok(source.includes(contract), `missing identity revalidation: ${contract}`)
})
