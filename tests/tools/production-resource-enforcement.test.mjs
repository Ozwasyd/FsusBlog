import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createProductionResourceEnforcer,
  dockerResourceArguments,
  resolveCgroupLimits,
  resolveProductionCgroupCapabilities
} from '../../tools/test-matrix/production-resource-enforcement.mjs'
import { runDag } from '../../tools/test-matrix/scheduler.mjs'

function fakeCgroup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-cgroup-v2-'))
  const mountRoot = path.join(root, 'cgroup')
  const delegateRoot = path.join(mountRoot, 'delegated')
  fs.mkdirSync(delegateRoot, { recursive: true })
  const prepareDirectory = (directory) => {
    for (const [name, value] of Object.entries({
      'cgroup.controllers': 'cpu memory pids',
      'cgroup.subtree_control': '',
      'cgroup.procs': '',
      'cpu.weight': '100',
      'cpu.max': 'max 100000',
      'cpu.stat': 'usage_usec 10\nnr_periods 2\nnr_throttled 1\nthrottled_usec 3',
      'cpu.pressure': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0',
      'memory.high': 'max',
      'memory.max': 'max',
      'memory.current': '1048576',
      'memory.events': 'low 0\nhigh 2\nmax 0\noom 1\noom_kill 1',
      'memory.pressure': 'some avg10=0.01 avg60=0.00 avg300=0.00 total=5',
      'pids.current': '1',
      'pids.max': 'max',
      'pids.events': 'max 0'
    })) {
      const file = path.join(directory, name)
      if (!fs.existsSync(file)) fs.writeFileSync(file, value)
    }
  }
  prepareDirectory(delegateRoot)
  return { root, mountRoot, delegateRoot, prepareDirectory }
}

test('capability probe distinguishes cgroup v2 delegation from unsupported platforms', () => {
  const fixture = fakeCgroup()
  const available = resolveProductionCgroupCapabilities({
    platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot
  })
  assert.equal(available.status, 'available')
  assert.deepEqual(available.controllers, ['cpu', 'memory', 'pids'])
  fs.writeFileSync(path.join(fixture.delegateRoot, 'cgroup.controllers'), 'cpu memory')
  const missing = resolveProductionCgroupCapabilities({
    platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot
  })
  assert.equal(missing.status, 'unavailable')
  assert.equal(missing.reason, 'controllers-missing:pids')
  assert.equal(resolveProductionCgroupCapabilities({ platform: 'darwin' }).reason, 'non-linux')
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

test('dynamic grants update effective CPU, memory and pids controls without restarting the bundle', () => {
  const fixture = fakeCgroup()
  const enforcer = createProductionResourceEnforcer({
    runId: 'run-1', bundleIds: ['frontend-tests'], mode: 'strict',
    machine: { cpuUnits: 8, memoryGiB: 16 },
    platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot,
    prepareDirectory: fixture.prepareDirectory,
    removeDirectory: (directory) => fs.rmSync(directory, { recursive: true })
  })
  assert.equal(enforcer.mode, 'enforced')
  const first = enforcer.update('frontend-tests', { cpuUnits: 2, memoryGiB: 3 })
  enforcer.attach('frontend-tests', 4242)
  assert.equal(fs.readFileSync(path.join(first.cgroupPath, 'cgroup.procs'), 'utf8'), '4242')
  assert.equal(fs.readFileSync(path.join(first.cgroupPath, 'cpu.max'), 'utf8'), first.cpuMax)
  const expanded = enforcer.update('frontend-tests', { cpuUnits: 5, memoryGiB: 7 })
  assert.notEqual(expanded.cpuMax, first.cpuMax)
  assert.equal(fs.readFileSync(path.join(first.cgroupPath, 'memory.high'), 'utf8'), String(expanded.memoryHighBytes))
  const evidence = enforcer.sample()
  assert.equal(evidence.bundles['frontend-tests'].grants.length, 2)
  assert.equal(evidence.bundles['frontend-tests'].samples.at(-1).cpuStat.nr_throttled, 1)
  assert.equal(evidence.bundles['frontend-tests'].samples.at(-1).memoryEvents.oom_kill, 1)
  assert.match(evidence.bundles['frontend-tests'].samples.at(-1).memoryPressure, /avg10=0\.01/u)
  fs.writeFileSync(path.join(first.cgroupPath, 'cgroup.procs'), '')
  assert.equal(enforcer.cleanup().status, 'removed')
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

test('hard CPU ceiling prevents a sibling from consuming more CPUs than its grant', () => {
  const one = resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16 })
  const four = resolveCgroupLimits({ cpuUnits: 4, memoryGiB: 4 }, { cpuUnits: 8, memoryGiB: 16 })
  const ratio = (limit) => {
    const [quota, period] = limit.cpuMax.split(' ').map(Number)
    return quota / period
  }
  assert.equal(ratio(one), 1)
  assert.equal(ratio(four), 4)
  assert.ok(one.cpuWeight < four.cpuWeight)
  assert.ok(one.memoryMaxBytes > one.memoryHighBytes)
  assert.equal(one.cpuset, null)
  assert.throws(
    () => resolveCgroupLimits({ cpuUnits: 9, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16 }),
    /CPU grant 9 exceeds machine envelope 8/u
  )
  assert.throws(
    () => resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 17 }, { cpuUnits: 8, memoryGiB: 16 }),
    /memory grant 17 GiB exceeds machine envelope 16 GiB/u
  )
})

test('active cgroups are retained while cancellation cleanup removes empty owned groups', () => {
  const fixture = fakeCgroup()
  const enforcer = createProductionResourceEnforcer({
    runId: 'cancel-run', bundleIds: ['runtime-browser'], mode: 'strict',
    machine: { cpuUnits: 4, memoryGiB: 8 },
    platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot,
    prepareDirectory: fixture.prepareDirectory,
    removeDirectory: (directory) => fs.rmSync(directory, { recursive: true })
  })
  const limits = enforcer.update('runtime-browser', { cpuUnits: 2, memoryGiB: 2 })
  enforcer.attach('runtime-browser', 99)
  assert.equal(enforcer.cleanup().status, 'retained-active')
  fs.writeFileSync(path.join(limits.cgroupPath, 'cgroup.procs'), '')
  assert.equal(enforcer.cleanup().status, 'removed')
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

test('unexpected scheduler failure still removes its empty enforced hierarchy', async () => {
  const fixture = fakeCgroup()
  await assert.rejects(() => runDag({
    tiers: [{
      id: 'failing-hook',
      command: `${process.execPath} -e "process.exit(0)"`,
      dependsOn: [],
      services: [],
      parallelizable: true,
      exclusiveResources: [],
      phase: 0,
      resourceClass: 'cpu',
      maxParallel: 1,
      cpuUnits: 1,
      memoryGiB: 0.25,
      cacheInputs: ['tools/**'],
      executionKey: 'test/failing-hook',
      executionVariant: 'ordinary',
      coverage: ['ordinary-unit']
    }],
    root: fixture.root,
    runsRoot: path.join(fixture.root, 'runs'),
    runId: 'unexpected-failure',
    maxParallel: 1,
    systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
    snapshotWorktree: async () => ({ fingerprint: 'stable', entries: {} }),
    executeTier: async () => ({ code: 0, signal: null }),
    onTierStart: () => { throw new Error('synthetic scheduler hook failure') },
    resourceEnforcementMode: 'strict',
    resourceEnforcementOptions: {
      platform: 'linux',
      mountRoot: fixture.mountRoot,
      mountType: 'cgroup2fs',
      delegateRoot: fixture.delegateRoot,
      prepareDirectory: fixture.prepareDirectory,
      removeDirectory: (directory) => fs.rmSync(directory, { recursive: true })
    }
  }), /synthetic scheduler hook failure/u)
  assert.equal(fs.existsSync(path.join(
    fixture.delegateRoot,
    'fsusblog-production',
    'unexpected-failure'
  )), false)
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

test('strict mode fails closed while auto and advisory modes expose degradation', () => {
  const options = {
    runId: 'unsupported', bundleIds: ['bundle'], machine: { cpuUnits: 2, memoryGiB: 2 }, platform: 'darwin'
  }
  assert.throws(() => createProductionResourceEnforcer({ ...options, mode: 'strict' }), /strict cgroup enforcement unavailable/u)
  const advisory = createProductionResourceEnforcer({ ...options, mode: 'auto' })
  assert.equal(advisory.mode, 'advisory')
  assert.equal(advisory.evidence().status, 'unsupported')
  assert.equal(advisory.evidence().reason, 'non-linux')
})

test('Docker OCI arguments bind the current run, bundle and step to equivalent limits', () => {
  const args = dockerResourceArguments({
    FSUSBLOG_DOCKER_CPU_UNITS: '2.5',
    FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES: '1000',
    FSUSBLOG_DOCKER_MEMORY_MAX_BYTES: '1200',
    FSUSBLOG_DOCKER_PIDS_MAX: '64',
    FSUSBLOG_TEST_RUN_ID: 'run',
    FSUSBLOG_PHYSICAL_BUNDLE_ID: 'runtime-browser',
    FSUSBLOG_STEP_ID: 'bootstrap'
  })
  assert.deepEqual(args.slice(0, 8), ['--cpus', '2.5', '--memory-reservation', '1000', '--memory', '1200', '--pids-limit', '64'])
  assert.ok(args.includes('io.fsusblog.test.run-id=run'))
  assert.ok(args.includes('io.fsusblog.test.bundle-id=runtime-browser'))
  assert.ok(args.includes('io.fsusblog.test.step-id=bootstrap'))
  assert.ok(args.includes('io.fsusblog.test.cpu-units=2.5'))
  assert.ok(args.includes('io.fsusblog.test.memory-max-bytes=1200'))
  assert.deepEqual(dockerResourceArguments({}), [])
  assert.throws(() => dockerResourceArguments({
    FSUSBLOG_DOCKER_CPU_UNITS: '1'
  }), /requires a complete/u)
  assert.throws(() => dockerResourceArguments({
    FSUSBLOG_DOCKER_CPU_UNITS: '1',
    FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES: '1200',
    FSUSBLOG_DOCKER_MEMORY_MAX_BYTES: '1000',
    FSUSBLOG_DOCKER_PIDS_MAX: '64',
    FSUSBLOG_TEST_RUN_ID: 'run',
    FSUSBLOG_PHYSICAL_BUNDLE_ID: 'bundle',
    FSUSBLOG_STEP_ID: 'step'
  }), /grant is invalid/u)
  assert.throws(() => dockerResourceArguments({
    FSUSBLOG_DOCKER_CPU_UNITS: '1',
    FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES: '1000',
    FSUSBLOG_DOCKER_MEMORY_MAX_BYTES: '1200',
    FSUSBLOG_DOCKER_PIDS_MAX: '64'
  }), /requires run, bundle, and step identity/u)
})

test('production wiring attaches a stopped bundle before resume and propagates OCI limits', () => {
  const scheduler = fs.readFileSync('tools/test-matrix/scheduler.mjs', 'utf8')
  const bundle = fs.readFileSync('tools/test/bundles/run-bundle.mjs', 'utf8')
  const bootstrap = fs.readFileSync('tools/bootstrap-acceptance-env.sh', 'utf8')
  const postgresFixture = fs.readFileSync('tests/backend/Fixtures/PostgresSchemaMigrationFixture.cs', 'utf8')
  const backendShards = fs.readFileSync('tools/test/run-backend-production-shards.mjs', 'utf8')
  assert.match(scheduler, /kill -STOP \$\$; exec \/bin\/bash[\s\S]*?resourceEnforcer\.attach[\s\S]*?execution\.resume/u)
  assert.match(scheduler, /writeActiveResourceGrants[\s\S]*?resourceEnforcer\.update/u)
  assert.match(scheduler, /scheduler interrupted by[\s\S]*?finalizeResourceEnforcer/u)
  assert.match(bundle, /FSUSBLOG_DOCKER_CPU_UNITS[\s\S]*?FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES[\s\S]*?FSUSBLOG_DOCKER_PIDS_MAX/u)
  assert.match(bundle, /docker', \['inspect'[\s\S]*?consistency/u)
  assert.match(bootstrap, /DOCKER_RESOURCE_ARGS=\([\s\S]*?--cpus[\s\S]*?--memory-reservation[\s\S]*?--pids-limit/u)
  assert.match(bootstrap, /bundle_identity="\$\{FSUSBLOG_PHYSICAL_BUNDLE_ID:-standalone\}"/u)
  assert.match(bootstrap, /step_identity="\$\{FSUSBLOG_STEP_ID:-bootstrap\}"/u)
  assert.match(bootstrap, /docker update[\s\S]*?docker run -d/u)
  assert.match(postgresFixture, /BuildDockerResourceArguments[\s\S]*?--cpus[\s\S]*?--memory-reservation[\s\S]*?io\.fsusblog\.test\.step-id/u)
  assert.match(backendShards, /backendPartitionEnvironment[\s\S]*?dockerLimitEnvironment\(processors, memoryGiB, env\)/u)
})
