import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  FAULT_CASES,
  HOST_INTERRUPTION_STAGES,
  ROLLOUT_STAGES,
  materializeFaultPlan,
  resolveRehearsalPlan
} from '../../tools/deployment/zero-downtime-rehearsal-plan.mjs'
import { boundedSemanticScale } from './support/timing-policy.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const orchestratorSource = path.join(repositoryRoot, 'tools/deployment/zero-downtime-rehearsal.sh');
const planToolSource = path.join(repositoryRoot, 'tools/deployment/zero-downtime-rehearsal-plan.mjs');
const releaseIdToolSource = path.join(repositoryRoot, 'tools/release/release-id.mjs');
const releaseIdContractSource = path.join(repositoryRoot, 'src/shared/Contracts/Validation/release-id-contract.json');
const faultTemplateSource = path.join(repositoryRoot, 'tests/fixtures/deployment/zero-downtime-fault-plan.template.json');
const migrationQualificationTemplateSource = path.join(repositoryRoot, 'tests/fixtures/deployment/release-migration-qualification-scenario.template.json');
const activeRehearsalProcessGroups = new Set();

function killActiveRehearsalProcessGroups() {
  for (const pid of activeRehearsalProcessGroups) {
    try {
      if (process.platform === 'win32') process.kill(pid, 'SIGKILL')
      else process.kill(-pid, 'SIGKILL')
    } catch {}
  }
  activeRehearsalProcessGroups.clear()
}

process.once('exit', killActiveRehearsalProcessGroups)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    killActiveRehearsalProcessGroups()
    process.exit(signal === 'SIGTERM' ? 143 : 130)
  })
}

function positiveNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function resolveRehearsalMachineTiming({ hostCpu, grantedCpu, load1 }) {
  const pressureScale = Math.max(1, hostCpu / grantedCpu, (load1 + 1) / grantedCpu)
  const wait = milliseconds => Math.ceil(milliseconds * pressureScale)
  const semanticWait = milliseconds => Math.ceil(milliseconds * boundedSemanticScale(pressureScale))
  const seconds = value => Math.max(1, Math.ceil(wait(value * 1_000) / 1_000))
  return {
    stageDelayMs: semanticWait(80),
    activeFenceDelayMs: semanticWait(1_500),
    coordinationTimeoutMs: Math.min(900_000, wait(10_000)),
    // Worker qualification starts several process groups and a local observer
    // service. Keep enough base headroom for load that rises after this single
    // startup-time pressure sample; the machine grant still scales the value.
    workerTimeoutSeconds: Math.min(1_800, seconds(30)),
    hostInterruptionTimeoutSeconds: Math.min(300, seconds(10)),
    migrationTimeoutSeconds: Math.min(1_800, seconds(60)),
    rehearsalTimeoutMs: wait(120_000)
  }
}

function machineTiming() {
  const hostCpu = Math.max(1, os.availableParallelism?.() ?? os.cpus().length)
  const grantedCpu = Math.min(
    hostCpu,
    positiveNumber(process.env.FSUSBLOG_STEP_CPU_BUDGET)
      ?? positiveNumber(process.env.FSUSBLOG_BUNDLE_CPU_BUDGET)
      ?? hostCpu
  )
  const load1 = Math.max(0, os.loadavg()[0] ?? 0)
  return resolveRehearsalMachineTiming({ hostCpu, grantedCpu, load1 })
}

const fixtureShard = String(process.env.FSUSBLOG_ZDT_FIXTURE_SHARD ?? '').trim()
const fixtureShardIds = new Set([
  '',
  'base',
  'normal',
  'explicit-rollback',
  'post-switch-rollback',
  'sigkill-resume',
  'all'
])
if (!fixtureShardIds.has(fixtureShard)) {
  throw new Error(`unknown zero-downtime fixture shard: ${fixtureShard}`)
}
const runsFixtureShard = id => !fixtureShard || fixtureShard === id

if (runsFixtureShard('base')) test('rehearsal timing wires shared semantic scale to delays and preserves wait caps', () => {
  const timing = resolveRehearsalMachineTiming({ hostCpu: 8, grantedCpu: 2, load1: 0 })

  assert.deepEqual(timing, {
    stageDelayMs: 110,
    activeFenceDelayMs: 2_063,
    coordinationTimeoutMs: 40_000,
    workerTimeoutSeconds: 120,
    hostInterruptionTimeoutSeconds: 40,
    migrationTimeoutSeconds: 240,
    rehearsalTimeoutMs: 480_000
  })
})

if (runsFixtureShard('base')) test('plan resolution is local-only, private-file-only and materializes exact isolated fault cases', (t) => {
  const fixture = createFixture(t)
  const raw = JSON.parse(fs.readFileSync(fixture.plan, 'utf8'))
    const resolved = resolveRehearsalPlan(raw, { planFile: fixture.plan, repoRoot: fixture.root });
    assert.equal(resolved.environment, 'Test');
    assert.equal(resolved.source.slot, 'blue');
    assert.equal(resolved.source.previousRollbackRelease, '20260709010101-cccccccccccc');
    assert.equal(resolved.target.slot, 'green');
    assert.match(resolved.workRoot, /\.tmp[/\\]rehearsal$/u);
    assert.equal(resolved.workers.observerEnvFile, fs.realpathSync(path.join(fixture.root, 'secrets', 'worker-observer.env')));
  assert.equal(resolved.workers.deploy.observerServicePlan.baseUrl, 'http://127.0.0.1:19031')
  assert.equal(resolved.workers.deploy.normalScenario.baseUrl, resolved.workers.deploy.observerServicePlan.baseUrl)

  const faultRoot = path.join(resolved.workRoot, 'fixture-run', 'faults')
  const faultPlan = materializeFaultPlan(resolved, faultRoot, 'rollback')
  assert.deepEqual(faultPlan.cases.map(item => item.case), FAULT_CASES)
  assert.equal(faultPlan.rolloutId, `rollback-${resolved.source.releaseId}`)
  assert.equal(faultPlan.sourceContainer, 'fsus-app-green')
  assert.equal(faultPlan.targetContainer, 'fsus-app-blue')
  for (const definition of faultPlan.cases) {
    assert.ok(definition.rolloutState.startsWith(path.join(faultRoot, 'cases', definition.case)))
    assert.ok(definition.slotState.startsWith(path.join(faultRoot, 'cases', definition.case)))
    assert.equal(definition.setup[0].id, 'prepare-case')
    assert.equal(definition.rollout.id, 'case-rollout')
    assert.equal(definition.teardown[0].id, 'teardown-case')
    assert.equal(definition.publicUrl, 'http://127.0.0.1:18080/health/ready')
  }
  assert.equal(
    faultPlan.cases.find(item => item.case === 'drain-timeout').inject.url,
    'http://127.0.0.1:8081/fixture/hold')

  const production = structuredClone(raw)
  production.environment = 'Production'
  assert.throws(
    () => resolveRehearsalPlan(production, { planFile: fixture.plan, repoRoot: fixture.root }),
    /non-production.*Test/u)
  fs.chmodSync(path.join(fixture.root, 'secrets', 'admin-header.txt'), 0o644)
  assert.throws(
    () => resolveRehearsalPlan(raw, { planFile: fixture.plan, repoRoot: fixture.root }),
    /mode 0400 or 0600/u)
  fs.chmodSync(path.join(fixture.root, 'secrets', 'admin-header.txt'), 0o600)
  fs.writeFileSync(path.join(fixture.root, 'secrets', 'admin-header.txt'), 'X-Fsus-Admin-Secret: rejected\n', { mode: 0o600 })
  assert.throws(
    () => resolveRehearsalPlan(raw, { planFile: fixture.plan, repoRoot: fixture.root }),
    /Authorization: Bearer or Cookie/u)

  fs.writeFileSync(path.join(fixture.root, 'secrets', 'admin-header.txt'), 'Authorization: Bearer fixture-admin\n', { mode: 0o600 })
  const servicePlanFile = path.join(fixture.root, 'worker-observer-service-plan.json')
  const mismatchedServicePlan = JSON.parse(fs.readFileSync(servicePlanFile, 'utf8'))
  mismatchedServicePlan.listen.port = 19032
  writeJson(servicePlanFile, mismatchedServicePlan)
  assert.throws(
    () => resolveRehearsalPlan(raw, { planFile: fixture.plan, repoRoot: fixture.root }),
    /normalScenario\.baseUrl must equal observer service listen origin/u)
})

if (runsFixtureShard('normal')) test('recording subprocess fixture proves normal order, nested probes and qualification binding', async (t) => {
  const fixture = createFixture(t)
  const result = await runRehearsal(fixture, 'normal')
  assert.equal(result.status, 0, result.stderr)
  const records = readRecords(fixture.log)
  assertOrdered(records, [
    'fault-matrix',
    'topology:up',
    'release:qualification',
    'worker-drill',
    'topology:down',
    'topology:up',
    'release:deploy',
    'worker-reconciliation:qualification',
    'topology:down'
  ])
  for (const probe of ['asset', 'notification', 'resource', 'worker-reconciliation-normal']) {
    assert.ok(records.some(item => item.kind === `probe:${probe}`), `missing real child probe ${probe}`)
  }
  assert.ok(records.filter(item => item.kind === 'observer-service').length >= 2,
    'qualification and fresh normal paths must each start the repository observer service')
  const summary = readSummary(fixture, 'normal')
  assert.equal(summary.status, 'pass')
  assert.equal(summary.modes[0].checks.find(item => item.name === 'worker-qualification-deploy').status, 'pass')
})

if (runsFixtureShard('explicit-rollback')) test('explicit rollback is a second real rollout and ends Green to Blue', async (t) => {
  const fixture = createFixture(t)
  const result = await runRehearsal(fixture, 'explicit-rollback')
  assert.equal(result.status, 0, result.stderr)
  const records = readRecords(fixture.log)
  const rollback = records.find(item => item.kind === 'release:rollback')
  assert.ok(rollback)
  assert.ok(rollback.args.includes('--rollback'))
  const runRoot = onlyRunRoot(fixture)
  const slots = readJson(path.join(runRoot, 'modes/explicit-rollback/states/slots.json'))
  assert.equal(slots.activeSlot, 'blue')
  const evidence = readJson(path.join(runRoot, 'modes/explicit-rollback/evidence/rehearsal-mode.json'))
  assert.equal(evidence.status, 'pass')
  assert.equal(evidence.checks.find(item => item.name === 'rollback-rollout').status, 'pass')
  assert.equal(evidence.checks.find(item => item.name === 'worker-qualification-rollback').status, 'pass')
})

if (runsFixtureShard('post-switch-rollback')) test('post-switch mode requires real automatic rollback cases and a fresh success control', async (t) => {
  const fixture = createFixture(t, { delayedSetsidMs: 75 })
  const result = await runRehearsal(fixture, 'post-switch-rollback')
  assert.equal(result.status, 0, result.stderr)
  const runRoot = onlyRunRoot(fixture)
  const fault = readJson(path.join(runRoot, 'modes/post-switch-rollback/evidence/fault-matrix.json'))
  for (const name of ['active-fence-failure', 'public-probe-failure']) {
    const item = fault.cases.find(candidate => candidate.case === name)
    assert.equal(item.after.rolloutState.status, 'rolled_back')
    assert.equal(item.after.rolloutState.recoveries.at(-1).action, 'rollback-gateway-to-source')
  }
  const modeEvidence = readJson(path.join(runRoot, 'modes/post-switch-rollback/evidence/rehearsal-mode.json'))
  assert.equal(modeEvidence.checks.find(item => item.name === 'fault-matrix').status, 'pass')
  assert.equal(modeEvidence.checks.find(item => item.name === 'deploy-rollout').status, 'pass')
})

if (runsFixtureShard('sigkill-resume')) test('SIGKILL mode kills an isolated process group, adopts durable state and invokes --resume', async (t) => {
  const fixture = createFixture(t, { delayedSetsidMs: 75 })
  const result = await runRehearsal(fixture, 'sigkill-resume')
  assert.equal(result.status, 0, result.stderr)
  const records = readRecords(fixture.log)
  const resumes = records.filter(item => item.kind === 'release:resume')
  assert.equal(resumes.length, HOST_INTERRUPTION_STAGES.length)
  assert.ok(resumes.every(item => item.args.includes('--resume')))
  assert.ok(records.filter(item => item.kind === 'observer-service').length >= HOST_INTERRUPTION_STAGES.length,
    'each interruption path must own an observer service lifecycle')
  const runRoot = onlyRunRoot(fixture)
  const signal = readJson(path.join(runRoot, 'modes/sigkill-resume/evidence/sigkill-resume.json'))
  assert.equal(signal.schema, 'fsusblog.zero-downtime-rehearsal-sigkill-matrix.v1')
  assert.deepEqual(signal.stages, [...HOST_INTERRUPTION_STAGES])
  assert.deepEqual(signal.entries.map(item => item.stage), [...HOST_INTERRUPTION_STAGES])
  assert.equal(new Set(signal.entries.map(item => item.rolloutId)).size, HOST_INTERRUPTION_STAGES.length)
  for (const entry of signal.entries) {
    const child = readJson(entry.signalEvidence.path)
    assert.match(child.stageHold.sha256, /^sha256:[0-9a-f]{64}$/u)
    assert.equal(readJson(child.stageHold.path).stage, entry.stage)
  }
  for (const stage of HOST_INTERRUPTION_STAGES) {
    const state = readJson(path.join(runRoot, `modes/sigkill-resume/interruptions/${stage}/states/deploy-rollout.json`))
    assert.equal(state.status, 'completed')
    assert.ok(state.recoveries.some(item => item.status === 'ok'))
  }
  const journal = fs.readFileSync(path.join(runRoot, 'evidence/commands.tsv'), 'utf8')
  for (const stage of HOST_INTERRUPTION_STAGES) {
    assert.match(journal, new RegExp(`sigkill-${stage}-initial-rollout-exit\\t137`, 'u'))
  }
  assert.equal(records.filter(item => item.kind === 'probe:asset').length, 4)
  assert.equal(records.filter(item => item.kind === 'probe:notification').length, 4)
  assert.equal(records.filter(item => item.kind === 'probe:resource').length, 4)
})

if (runsFixtureShard('all')) test('all mode aggregates a failure and continues into later isolated modes', async (t) => {
  // The dedicated mode shards own the full timing/lifecycle fixtures. This
  // fresh fixture replaces only their mode bodies while retaining the real
  // all-mode selection, continuation loop and summary aggregation entry point.
  const fixture = createFixture(t, { continuationOnly: true })
  const result = await runRehearsal(fixture, 'all', { FSUSBLOG_FIXTURE_FAIL_NORMAL: '1' })
  assert.notEqual(result.status, 0)
  const records = readRecords(fixture.log)
  assert.ok(records.some(item => item.kind === 'release:rollback'), 'explicit rollback mode did not continue')
  assert.ok(records.some(item => item.kind === 'release:resume'), 'SIGKILL resume mode did not continue')
  const runRoot = onlyRunRoot(fixture)
  const summary = readJson(path.join(runRoot, 'evidence/rehearsal-summary.json'))
  assert.equal(summary.status, 'fail')
  assert.ok(summary.errors.length > 0)
  assert.equal(new Set(summary.modes.map(item => item.mode)).size, 4)
})

function createFixture(t, { continuationOnly = false, delayedSetsidMs = 0 } = {})
{
  const timing = machineTiming()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-zdt-rehearsal-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const deployment = path.join(root, 'tools/deployment')
  const fixtureDirectory = path.join(root, 'tests/fixtures/deployment')
  const secrets = path.join(root, 'secrets')
  fs.mkdirSync(deployment, { recursive: true })
  fs.mkdirSync(fixtureDirectory, { recursive: true })
    fs.mkdirSync(secrets, { recursive: true });
    fs.mkdirSync(path.join(root, 'deploy'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tools/db'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tools/release'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/shared/Contracts/Validation'), { recursive: true });
    fs.mkdirSync(path.join(root, '.tmp/docker-failure-bin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tmp/docker-failure-bin/docker'), '#!/usr/bin/env bash\nexit 73\n', { mode: 0o755 });
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin/docker'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
    if (delayedSetsidMs > 0)
    {
        const setsid = spawnSync('sh', ['-c', 'command -v setsid'], { encoding: 'utf8' }).stdout.trim();
        assert.ok(path.isAbsolute(setsid), 'system setsid path is unavailable');
        fs.writeFileSync(
            path.join(root, 'bin/setsid'),
            `#!/usr/bin/env bash\nsleep ${delayedSetsidMs / 1_000}\nexec ${JSON.stringify(setsid)} "$@"\n`,
            { mode: 0o755 });
    }
    fs.copyFileSync(orchestratorSource, path.join(deployment, 'zero-downtime-rehearsal.sh'));
    if (continuationOnly) {installContinuationModeFixture(path.join(deployment, 'zero-downtime-rehearsal.sh'))};
    fs.copyFileSync(planToolSource, path.join(deployment, 'zero-downtime-rehearsal-plan.mjs'));
    fs.copyFileSync(releaseIdToolSource, path.join(root, 'tools/release/release-id.mjs'));
    fs.copyFileSync(releaseIdContractSource, path.join(root, 'src/shared/Contracts/Validation/release-id-contract.json'));
    fs.copyFileSync(faultTemplateSource, path.join(fixtureDirectory, 'zero-downtime-fault-plan.template.json'));
    fs.copyFileSync(migrationQualificationTemplateSource, path.join(fixtureDirectory, 'release-migration-qualification-scenario.template.json'));
    fs.writeFileSync(path.join(root, 'fixture-runner.mjs'), fixtureRunnerSource());
  fs.writeFileSync(path.join(deployment, 'rehearsal-schema-qualification-probe.mjs'), 'export {}\n', { mode: 0o600 })
  fs.writeFileSync(path.join(root, 'tools/db/run-online-migrations.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 })

  for (const [name, action] of [
    ['zero-downtime-topology.sh', 'topology'],
    ['release-rollout.sh', 'release'],
    ['rollout-state.mjs', 'rollout-state'],
    ['release-worker-drill.mjs', 'worker-drill'],
    ['release-worker-observer-service.mjs', 'observer-service'],
    ['release-worker-reconciliation.mjs', 'worker-reconciliation'],
    ['release-migration-qualification.mjs', 'migration-qualification'],
    ['release-worker-normal-observer.mjs', 'normal-worker-ledger'],
    ['zero-downtime-fault-matrix.mjs', 'fault-matrix'],
    ['release-asset-compatibility-probe.mjs', 'probe-asset'],
    ['release-notification-probe.mjs', 'probe-notification'],
    ['release-resource-probe.mjs', 'probe-resource']
  ]) writeRunner(deployment, name, action)
  for (const name of ['rehearsal-openresty.sh', 'fault-wrapper.sh', 'failing-openresty.sh']) {
    fs.writeFileSync(path.join(deployment, name), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  }

    const blueManifest = path.join(root, 'blue-manifest.json');
    const greenManifest = path.join(root, 'green-manifest.json');
    writeJson(blueManifest, releaseManifest('20260710010101-aaaaaaaaaaaa', '1'));
    writeJson(greenManifest, releaseManifest('20260711010101-bbbbbbbbbbbb', '2'));
    const deployAsset = path.join(root, 'asset-blue-green.json');
    const rollbackAsset = path.join(root, 'asset-green-blue.json');
    writeJson(deployAsset, assetScenario('20260710010101-aaaaaaaaaaaa', '20260711010101-bbbbbbbbbbbb'));
    writeJson(rollbackAsset, assetScenario('20260711010101-bbbbbbbbbbbb', '20260710010101-aaaaaaaaaaaa'));
    const workerPlan = path.join(root, 'worker-plan.json');
    writeJson(workerPlan, {
        schema: 'fsusblog.release-worker-drill-plan.v1',
    security: { allowedHttpOrigins: ['http://127.0.0.1:19031'] },
    coordination: {
      mode: 'file-handshake',
      armedFile: 'signals/armed.json',
      authorizeFile: 'signals/authorize.json',
      terminatedFile: 'signals/terminated.json',
      timeoutMs: timing.coordinationTimeoutMs,
      pollMs: 10
    },
    sourceTermination: { type: 'process-signal', signal: 'SIGKILL', pidFile: 'source.pid', commandContains: 'fixture-source-worker' }
  })
  const normalWorkerPlan = path.join(root, 'normal-worker-plan.json')
  writeJson(normalWorkerPlan, {
    schema: 'fsusblog.release-worker-normal-observer-plan.v1',
    baseUrl: 'http://127.0.0.1:19031',
    startPath: '/fixture/normal/start',
    statusPath: '/fixture/normal/status',
    finalizePath: '/fixture/normal/finalize',
    requiredKinds: ['scheduled-publish','article-mutation-outbox','audit-writer','visit-view-projection','public-hot-aot','upload-cleanup','active-singleton-control','multi-consumer-safe-control'],
    timeoutMs: timing.coordinationTimeoutMs,
    pollMs: 50
  })
  const observerServicePlan = path.join(root, 'worker-observer-service-plan.json')
  writeJson(observerServicePlan, {
    schema: 'fsusblog.release-worker-observer-service-plan.v1',
    nonProductionOnly: true,
    acknowledgement: 'OBSERVE_ISOLATED_TEST_WORKERS_ONLY',
    listen: { host: '127.0.0.1', port: 19031 }
  })
  const envFile = path.join(secrets, 'rehearsal.env')
  fs.writeFileSync(envFile, [
    'ASPNETCORE_ENVIRONMENT=Test',
    'SITE_BASEURL=http://127.0.0.1:18080',
    'EXTERNAL_DB_HOST=global-postgres',
    'EXTERNAL_REDIS_HOST=global-redis',
    'DB_NAME=fsusblog_rehearsal_test',
    `FSUSBLOG_REHEARSAL_POSTGRES_IMAGE=postgres@sha256:${'a'.repeat(64)}`,
    `FSUSBLOG_REHEARSAL_REDIS_IMAGE=redis@sha256:${'b'.repeat(64)}`,
    `FSUSBLOG_REHEARSAL_OPENRESTY_IMAGE=openresty@sha256:${'c'.repeat(64)}`,
    'FSUSBLOG_REHEARSAL_POSTGRES_VOLUME=fsusblog-zdt-postgres-fixture',
    'FSUSBLOG_REHEARSAL_REDIS_VOLUME=fsusblog-zdt-redis-fixture',
    'FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME=fsusblog-zdt-public-assets-fixture',
    'FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME=fsusblog-zdt-data-protection-fixture',
    ''
  ].join('\n'), { mode: 0o600 })
  const observerEnvFile = path.join(secrets, 'worker-observer.env')
  fs.writeFileSync(observerEnvFile, [
    'FSUSBLOG_WORKER_OBSERVER_PGHOST=127.0.0.1',
    'FSUSBLOG_WORKER_OBSERVER_PGPORT=5432',
    'FSUSBLOG_WORKER_OBSERVER_PGDATABASE=fsusblog_rehearsal_test',
    'FSUSBLOG_WORKER_OBSERVER_PGUSER=fsusblog',
    'FSUSBLOG_WORKER_OBSERVER_PGPASSWORD=fixture-only-password',
    'FSUSBLOG_WORKER_OBSERVER_REDIS_HOST=127.0.0.1',
    'FSUSBLOG_WORKER_OBSERVER_REDIS_PORT=6379',
    'FSUSBLOG_WORKER_OBSERVER_REDIS_DATABASE=0',
    ''
  ].join('\n'), { mode: 0o600 })
  fs.writeFileSync(path.join(secrets, 'admin-header.txt'), 'Authorization: Bearer fixture-only-token\n', { mode: 0o600 })
  writeJson(path.join(secrets, 'auth-state.json'), { cookies: [], origins: [] }, 0o600)
  fs.writeFileSync(path.join(secrets, 'traffic-binding.key'), Buffer.alloc(32, 0x41), { mode: 0o600 })
  fs.writeFileSync(path.join(secrets, 'asset-browser-binding.key'), Buffer.alloc(32, 0x42), { mode: 0o600 })
  for (const name of ['backup.json', 'traffic.json', 'server.dll', 'retained.js', 'corrupt.js']) {
    fs.writeFileSync(path.join(root, name), name, { mode: 0o600 })
  }
  writeJson(path.join(root, 'notification-resync.json'), {
    schema: 'fsusblog.release-notification-resync-scenario.v1'
  })
  writeJson(path.join(root, 'config/deployment/zero-downtime-resource-policy.json'), {
    schema: 'fsusblog.zero-downtime-resource-policy.v1',
    minimumSupported: { cpuCores: 4, memoryMiB: 6144, freeDiskMiB: 10240 },
    budgets: { dualSlotCpuPercent: 300 },
    sampling: { intervalMs: 250 }
  })

  const plan = path.join(root, 'rehearsal-plan.json')
  writeJson(plan, {
    schema: 'fsusblog.zero-downtime-rehearsal-plan.v1',
    rehearsalId: 'fixture-zdt',
    nonProductionOnly: true,
    environment: 'Test',
    acknowledgement: 'DESTROY_ISOLATED_LOCAL_REHEARSAL_ONLY',
    workRoot: '.tmp/rehearsal',
    publicUrl: 'http://127.0.0.1:18080/health/ready',
    controlOrigin: 'http://127.0.0.1:18080',
    publicPort: 18080,
    envFile,
    adminHeaderFile: path.join(secrets, 'admin-header.txt'),
    notificationAuthStorageState: path.join(secrets, 'auth-state.json'),
        source: {
            slot: 'blue',
            manifest: blueManifest,
            previousRollbackRelease: '20260709010101-cccccccccccc'
        },
        target: { slot: 'green', manifest: greenManifest, migrationServerDll: path.join(root, 'server.dll') },
        evidenceInputs: {
      backupRestore: path.join(root, 'backup.json'),
      trafficScenario: path.join(root, 'traffic.json'),
      trafficBindingKey: path.join(secrets, 'traffic-binding.key'),
      assetBrowserBindingKey: path.join(secrets, 'asset-browser-binding.key'),
      notificationResyncScenario: path.join(root, 'notification-resync.json')
    },
    migrationQualification: {
      scenarioTemplate: path.join(fixtureDirectory, 'release-migration-qualification-scenario.template.json'),
      timeoutSeconds: timing.migrationTimeoutSeconds,
      expandMigrationId: '20260711-pre-account-subject-hash-expand',
      backfillMigrationId: '20260711-post-account-subject-hash-backfill',
      contractMigrationId: '20260629-post-audit-chain-tail-index'
    },
    assets: {
      deployScenario: deployAsset,
      rollbackScenario: rollbackAsset,
      store: '.tmp/rehearsal/assets',
      retentionState: '.tmp/rehearsal/assets/retention-state.json'
    },
    workers: {
      timeoutSeconds: timing.workerTimeoutSeconds,
      observerEnvFile,
      deploy: { scenario: workerPlan, normalScenario: normalWorkerPlan, observerServicePlan, startStage: 'candidate-start' },
      rollback: { scenario: workerPlan, normalScenario: normalWorkerPlan, observerServicePlan, startStage: 'candidate-start' },
      resume: { scenario: workerPlan, normalScenario: normalWorkerPlan, observerServicePlan, startStage: 'candidate-start' }
    },
    faults: {
      planTemplate: path.join(fixtureDirectory, 'zero-downtime-fault-plan.template.json'),
      tokens: {
        failingOpenRestyWrapper: path.join(deployment, 'failing-openresty.sh'),
        dockerFailureBinPath: path.join(root, '.tmp/docker-failure-bin'),
        retainedAsset: path.join(root, 'retained.js'),
        corruptAsset: path.join(root, 'corrupt.js'),
        longRequestPath: '/fixture/hold'
      }
    },
    hostInterruption: {
      stages: ['source-drain', 'source-stop', 'release-evidence'],
      timeoutSeconds: timing.hostInterruptionTimeoutSeconds
    }
  })
  return { root, plan, log: path.join(root, 'records.jsonl'), bin: path.join(root, 'bin') }
}

function installContinuationModeFixture(orchestrator) {
  const marker = 'Log "run=$RUN_ID modes=${REQUESTED_MODES[*]} root=$RUN_ROOT"'
  const source = fs.readFileSync(orchestrator, 'utf8')
  assert.ok(source.includes(marker), 'zero-downtime all-mode dispatch marker is missing')
  const fixtureFunctions = [
    'FixtureWriteContinuationMode() {',
    '  local mode="$1" status="$2" report="$RUN_ROOT/modes/$1/evidence/rehearsal-mode.json"',
    '  mkdir -p "$(dirname "$report")"',
    "  jq -n --arg mode \"$mode\" --arg status \"$status\" '{schema:\"fsusblog.zero-downtime-rehearsal-mode.v1\",mode:$mode,status:$status,checks:[],errors:(if $status == \"pass\" then [] else [\"fixture mode failure\"] end)}' >\"$report\"",
    '}',
    'FixtureRecordContinuation() {',
    '  printf \'{"kind":"%s"}\\n\' "$1" >>"$FSUSBLOG_FIXTURE_LOG"',
    '}',
    'RunNormalLikeMode() {',
    '  if [[ "$1" == "normal" && "${FSUSBLOG_FIXTURE_FAIL_NORMAL:-}" == "1" ]]; then',
    '    FixtureWriteContinuationMode "$1" fail',
    '    return 17',
    '  fi',
    '  FixtureWriteContinuationMode "$1" pass',
    '}',
    'RunExplicitRollbackMode() {',
    '  FixtureRecordContinuation release:rollback',
    '  FixtureWriteContinuationMode explicit-rollback pass',
    '}',
    'RunSigkillResumeMode() {',
    '  FixtureRecordContinuation release:resume',
    '  FixtureWriteContinuationMode sigkill-resume pass',
    '}',
    ''
  ].join('\n')
  fs.writeFileSync(orchestrator, source.replace(marker, `${fixtureFunctions}${marker}`), { mode: 0o755 })
}

async function runRehearsal(fixture, mode, overrides = {}) {
  const timing = machineTiming()
  const child = spawn('bash', [
    path.join(fixture.root, 'tools/deployment/zero-downtime-rehearsal.sh'),
    '--plan', fixture.plan,
    '--mode', mode,
    '--run-id', `fixture-${mode.replaceAll('-', '')}`
  ], {
    cwd: fixture.root,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
      FSUSBLOG_FIXTURE_LOG: fixture.log,
      FSUSBLOG_FIXTURE_STAGE_DELAY_MS: String(timing.stageDelayMs),
      FSUSBLOG_FIXTURE_ACTIVE_FENCE_DELAY_MS: String(timing.activeFenceDelayMs),
      FSUSBLOG_FIXTURE_POLL_TIMEOUT_MS: String(timing.coordinationTimeoutMs),
      ...overrides
    }
  })
  activeRehearsalProcessGroups.add(child.pid)
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return await new Promise((resolve) => {
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, timing.rehearsalTimeoutMs)
    child.once('error', error => {
      clearTimeout(deadline)
      activeRehearsalProcessGroups.delete(child.pid)
      resolve({ status: 1, signal: null, stdout, stderr: `${stderr}${error.message}\n`, error })
    })
    child.once('close', (code, signal) => {
      clearTimeout(deadline)
      activeRehearsalProcessGroups.delete(child.pid)
      resolve({
        status: timedOut ? 124 : (code ?? 1),
        signal,
        stdout,
        stderr: timedOut ? `${stderr}rehearsal fixture exceeded ${timing.rehearsalTimeoutMs}ms\n` : stderr
      })
    })
  })
}

function fixtureRunnerSource() {
  return String.raw`
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const action = process.argv[2]
const argv = process.argv.slice(3)
const root = path.dirname(new URL(import.meta.url).pathname)
const log = process.env.FSUSBLOG_FIXTURE_LOG
const stages = ${JSON.stringify(ROLLOUT_STAGES)}
const faultCases = ${JSON.stringify(FAULT_CASES)}
const fixtureStageDelayMs = Math.max(1, Number.parseInt(process.env.FSUSBLOG_FIXTURE_STAGE_DELAY_MS ?? '', 10) || 80)
const fixtureActiveFenceDelayMs = Math.max(1, Number.parseInt(process.env.FSUSBLOG_FIXTURE_ACTIVE_FENCE_DELAY_MS ?? '', 10) || 1500)
const fixturePollTimeoutMs = Math.max(1, Number.parseInt(process.env.FSUSBLOG_FIXTURE_POLL_TIMEOUT_MS ?? '', 10) || 10_000)

record(action, argv)
if (action === 'topology') await topology(argv)
else if (action === 'release') await release(argv)
else if (action === 'rollout-state') rolloutState(argv)
else if (action === 'worker-drill') await workerDrill(argv)
else if (action === 'observer-service') {
  process.stdout.write(JSON.stringify({
    schema: 'fsusblog.release-worker-observer-service-response.v1',
    status: 'listening',
    address: { host: '127.0.0.1', port: 19031 }
  }) + '\n')
  await delay(60_000)
}
else if (action === 'worker-reconciliation') workerReconciliation(argv)
else if (action === 'migration-qualification') migrationQualification(argv)
else if (action === 'fault-matrix') faultMatrix(argv)
else if (action === 'normal-worker-ledger') await normalWorkerLedger(argv)
else if (action.startsWith('probe-')) probe(action, argv)

function record(kind, args) {
  fs.appendFileSync(log, JSON.stringify({ kind: normalizeKind(kind, args), args, at: Date.now() }) + '\n')
}

function normalizeKind(kind, args) {
  if (kind === 'topology') return 'topology:' + args[0]
  if (kind === 'release') {
    const state = value(args, '--rollout-state-file')
    if (state.includes('/qualification/')) return 'release:qualification'
    if (args.includes('--resume')) return 'release:resume'
    if (args.includes('--rollback')) return 'release:rollback'
    return 'release:deploy'
  }
  if (kind === 'worker-reconciliation') return 'worker-reconciliation:' + value(args, '--mode')
  if (kind.startsWith('probe-')) return 'probe:' + kind.slice('probe-'.length)
  return kind
}

async function topology(args) {
  const command = args[0]
  const workDir = value(args, '--work-dir')
  const stateFile = value(args, '--state-file')
  if (command === 'down') {
    fs.rmSync(workDir, { recursive: true, force: true })
    return
  }
  if (command === 'status') return
  const slot = value(args, '--source-slot')
  const manifest = read(value(args, '--source-manifest'))
  fs.mkdirSync(path.join(workDir, 'gateway-evidence'), { recursive: true })
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  write(stateFile, slotState(slot, manifest))
}

async function release(args) {
  const stateFile = value(args, '--rollout-state-file')
  const slotFile = value(args, '--slot-state-file')
  const manifest = read(value(args, '--release-manifest'))
  const slotStateValue = read(slotFile)
  const sourceSlot = slotStateValue.activeSlot
  const targetSlot = sourceSlot === 'blue' ? 'green' : 'blue'
  const sourceRecord = slotStateValue.slots[sourceSlot]
  const kind = args.includes('--rollback') ? 'rollback' : 'deploy'
  const rolloutId = value(args, '--rollout-id', false) ?? (kind + '-' + manifest.releaseId)
  const qualification = stateFile.includes('/qualification/')
  const migrationQualificationRun = stateFile.includes('/migration-qualification/')
  const interruptStage = stateFile.match(/\/interruptions\/(source-drain|source-stop|release-evidence)\//)?.[1] ?? null
  const sigkill = interruptStage !== null
  const resume = args.includes('--resume')
  let state = fs.existsSync(stateFile) ? read(stateFile) : rolloutStateValue({
    rolloutId, kind, manifest: value(args, '--release-manifest'), sourceSlot, sourceRecord,
    targetSlot, targetManifest: manifest
  })
  if (migrationQualificationRun) {
    state.currentStage = 'candidate-readiness'
    state.status = 'running'
    write(stateFile, state)
    const holdReady = process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE
    if (!holdReady || process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE !== 'candidate-readiness') {
      throw new Error('fixture migration qualification stage hold is missing')
    }
    write(holdReady, {
      schema: 'fsusblog.release-rollout-rehearsal-stage-hold.v1', status: 'ready',
      rolloutId, stage: 'candidate-readiness', readyAtUtc: new Date().toISOString(), errors: []
    })
    await delay(60_000)
    return
  }
  if (qualification) {
    for (const stage of ['asset-materialize', 'candidate-start', 'candidate-readiness', 'candidate-smoke', 'compatibility-smoke', 'gateway-switch', 'source-drain', 'active-fence']) {
      state.currentStage = stage
      state.status = 'running'
      write(stateFile, state)
      if (stage === 'active-fence' && process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE === stage) {
        const holdReady = process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE
        if (!holdReady || !process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_RELEASE_FILE) {
          throw new Error('fixture worker qualification stage hold is missing')
        }
        write(holdReady, {
          schema: 'fsusblog.release-rollout-rehearsal-stage-hold.v1', status: 'ready',
          rolloutId, stage, readyAtUtc: new Date().toISOString(), errors: []
        })
        await delay(60_000)
        return
      }
      await delay(stage === 'active-fence' ? fixtureActiveFenceDelayMs : fixtureStageDelayMs)
    }
    await delay(60_000)
    return
  }
  if (sigkill && !resume) {
    if (!interruptStage) throw new Error('fixture SIGKILL stage is missing')
    state.currentStage = 'candidate-start'
    state.status = 'running'
    write(stateFile, state)
    if (interruptStage !== 'source-drain') {
      await finalizeSourceDrain(args, state, rolloutId, sourceRecord, manifest)
    }
    const interruptIndex = stages.indexOf(interruptStage)
    state.completedStages = stages.slice(0, interruptIndex)
    state.currentStage = interruptStage
    state.status = 'running'
    write(stateFile, state)
    const holdReady = process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE
    if (!holdReady || process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE !== interruptStage) {
      throw new Error('fixture deterministic stage hold is missing')
    }
    write(holdReady, {
      schema: 'fsusblog.release-rollout-rehearsal-stage-hold.v1', status: 'ready',
      rolloutId, stage: interruptStage, readyAtUtc: new Date().toISOString(), errors: []
    })
    await delay(60_000)
    return
  }
  state.currentStage = 'candidate-start'
  state.status = 'running'
  write(stateFile, state)
  if (process.env.FSUSBLOG_FIXTURE_FAIL_NORMAL === '1' && stateFile.includes('/modes/normal/')) {
    process.exitCode = 17
    return
  }
  if (resume) {
    state = read(stateFile)
    const recovery = state.recovery
    state.recoveries ??= []
    if (recovery) state.recoveries.push({ action: recovery.action, failedStage: recovery.failedStage, status: 'ok' })
    state.recovery = null
  }
  if (!state.completedStages?.includes('source-drain')) {
    await finalizeSourceDrain(args, state, rolloutId, sourceRecord, manifest)
  }
  const evidenceDirectory = path.dirname(value(args, '--notification-evidence'))
  const workerFile = value(args, '--worker-reconciliation-evidence')
  const faultFile = value(args, '--fault-injection-evidence')
  const artifactFiles = {
    publicTraffic: path.join(evidenceDirectory, 'public-traffic.json'),
    notificationStream: value(args, '--notification-evidence'),
    assetCompatibility: value(args, '--asset-compatibility-evidence'),
    workerReconciliation: workerFile,
    resourceBudget: value(args, '--resource-budget-evidence'),
    faultInjection: faultFile
  }
  const evidenceRoot = value(args, '--evidence-root')
  const finalEvidence = path.join(evidenceRoot, rolloutId, 'evidence', 'release-rollout.json')
  const artifacts = Object.fromEntries(Object.entries(artifactFiles).map(([name, file]) => [name, metadata(file)]))
  write(finalEvidence, {
    schema: 'fsusblog.release-rollout-evidence.v1', status: 'pass', rolloutId, kind,
    stages: stages.map(stage => ({ stage })), artifacts, errors: []
  })
  state.status = 'completed'
  state.outcome = 'succeeded'
  state.currentStage = null
  state.completedStages = [...stages]
  state.switchCommitted = true
  state.gatewayGeneration = 1
  state.finalEvidencePath = finalEvidence
  state.recoveries ??= []
  write(stateFile, state)
  slotStateValue.previousSlot = sourceSlot
  slotStateValue.previousReleaseId = sourceRecord.releaseId
  slotStateValue.previousImageDigest = sourceRecord.imageDigest
  slotStateValue.activeSlot = targetSlot
  slotStateValue.activeReleaseId = manifest.releaseId
  slotStateValue.activeImageDigest = manifest.imageDigest
  slotStateValue.slots[targetSlot] = {
    releaseId: manifest.releaseId, imageDigest: manifest.imageDigest,
    deploymentGeneration: state.target.runtimeGeneration, status: 'running'
  }
  slotStateValue.status = 'stable'
  write(slotFile, slotStateValue)
}

async function finalizeSourceDrain(args, state, rolloutId, sourceRecord, manifest) {
  await invokeProbe('asset')
  await invokeProbe('notification')
  await invokeProbe('resource')
  const evidenceDirectory = path.dirname(value(args, '--notification-evidence'))
  write(path.join(evidenceDirectory, 'source-drain-gate.json'), {
    schema: 'fsusblog.release-rollout-gate.v1', gate: 'source-drain', status: 'pass',
    observations: { blockers: [] }, errors: [], observedAtUtc: new Date().toISOString()
  })
  const normalLedger = value(args, '--worker-ledger')
  const ledgerDeadline = Date.now() + fixturePollTimeoutMs
  while (!fs.existsSync(normalLedger) && Date.now() < ledgerDeadline) await delay(10)
  if (!fs.existsSync(normalLedger)) throw new Error('fixture normal worker ledger missing')
  write(process.env.FSUSBLOG_ROLLOUT_NORMAL_WORKER_TARGET_HEALTH, {
    schema: 'fsusblog.release-rollout-gate.v1', gate: 'target-health', status: 'pass',
    observations: { rolloutId: state.rolloutId, releaseId: state.target.releaseId }, errors: []
  })
  await invokeNormalWorker(value(args, '--worker-reconciliation-evidence'), state)
  for (const [name, flag, schema] of [
    ['publicTraffic', '--traffic-scenario', 'fsusblog.release-traffic-evidence.v1'],
    ['notificationStream', '--notification-evidence', 'fsusblog.release-notification-stream-evidence.v1'],
    ['assetCompatibility', '--asset-compatibility-evidence', 'fsusblog.release-asset-compatibility-evidence.v1'],
    ['resourceBudget', '--resource-budget-evidence', 'fsusblog.release-resource-budget-evidence.v1']
  ]) {
    const file = name === 'publicTraffic'
      ? path.join(path.dirname(value(args, '--notification-evidence')), 'public-traffic.json')
      : value(args, flag)
    write(file, {
      schema,
      ...(name === 'notificationStream' ? { contractVersion: 2 } : {}),
      status: 'pass', rolloutId,
      sourceReleaseId: sourceRecord.releaseId, targetReleaseId: manifest.releaseId, errors: []
    })
  }
}

function rolloutState(args) {
  if (args[0] !== 'fail-stage') return
  const file = value(args, '--state')
  const state = read(file)
  const stage = value(args, '--stage')
  state.currentStage = null
  state.status = 'recovery_required'
  state.recovery = { action: 'preserve-source-stop-candidate', failedStage: stage, automatic: true }
  state.stages.push({ stage, status: 'failed' })
  write(file, state)
}

async function workerDrill(args) {
  const plan = read(value(args, '--plan'))
  const state = read(value(args, '--rollout-state'))
  const workDir = value(args, '--work-dir')
  const runId = value(args, '--run-id')
  const ledgerFile = path.join(workDir, value(args, '--out'))
  const armed = path.join(workDir, plan.coordination.armedFile)
  const authorize = path.join(workDir, plan.coordination.authorizeFile)
  const terminated = path.join(workDir, plan.coordination.terminatedFile)
  write(armed, signal(state.rolloutId, runId, 'armed'))
  const deadline = Date.now() + fixturePollTimeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(authorize)) {
      const auth = read(authorize)
      if (auth.rolloutId === state.rolloutId && auth.runId === runId && auth.stage === 'terminate-source') break
    }
    await delay(10)
  }
  if (!fs.existsSync(authorize)) throw new Error('fixture authorization missing')
  const completedAtUtc = new Date().toISOString()
  const kinds = ['scheduled-publish','article-mutation-outbox','audit-writer','visit-view-projection','public-hot-aot','upload-cleanup','active-singleton-control','multi-consumer-safe-control','forced-source-recovery']
  const events = kinds.map((kind, index) => ({
    logicalEventId: 'fixture-event-' + String(index).padStart(2, '0'), kind, attemptCount: 2,
    finalEffectCount: 1, finalEffectKey: 'fixture-effect-' + String(index).padStart(2, '0'),
    finalReleaseId: state.target.releaseId, finalGeneration: state.target.runtimeGeneration,
    staleGenerationCommitCount: 0, pendingCountAtDrain: 1, durableReplaySource: 'postgres-outbox',
    expectedAuditCount: kind === 'audit-writer' ? 1 : 0, actualAuditCount: kind === 'audit-writer' ? 1 : 0,
    expectedProjectionCount: kind === 'visit-view-projection' ? 1 : 0, actualProjectionCount: kind === 'visit-view-projection' ? 1 : 0,
    observationBindings: { finalGeneration: { observedAtUtc: completedAtUtc } }, errors: []
  }))
  const coordination = { status: 'pass', mode: 'file-handshake' }
  const sourceTermination = { status: 'pass', forced: true, completedAtUtc, observation: { signal: 'SIGKILL' } }
  write(ledgerFile, {
    schema: 'fsusblog.release-worker-event-ledger.v1', status: 'pass', rolloutId: state.rolloutId,
    source: { releaseId: state.source.releaseId, slot: state.source.slot, generation: state.source.runtimeGeneration },
    target: { releaseId: state.target.releaseId, slot: state.target.slot, generation: state.target.runtimeGeneration },
    drill: {
      runId, coordination, sourceTermination, terminationBoundary: { status: 'pass' },
      targetReadiness: { status: 'pass' }, targetTakeover: { status: 'pass', completedAtUtc }
    },
    events, errors: []
  })
  write(terminated, { ...signal(state.rolloutId, runId, 'source-terminated'), forced: true })
}

function workerReconciliation(args) {
  const mode = value(args, '--mode')
  const state = read(value(args, '--rollout-state'))
  const normalStateFile = value(args, '--normal-rollout-state', false)
  const normalState = normalStateFile ? read(normalStateFile) : null
  write(value(args, '--out'), {
    schema: 'fsusblog.release-worker-reconciliation-evidence.v2', mode, status: 'pass',
    rolloutId: state.rolloutId, source: state.source, target: state.target,
    checks: { normalRolloutSeparationVerified: mode === 'qualification' },
    qualification: mode === 'qualification' ? {
      freshNormalRolloutRequired: true, normalRolloutReuseForbidden: true,
      expectedNormalRolloutId: normalState?.rolloutId ?? null
    } : null,
    inputs: {
      normalRolloutState: normalStateFile ? metadata(normalStateFile) : null
    },
    errors: []
  })
}

function migrationQualification(args) {
  const state = read(value(args, '--rollout-state'))
  const caseIds = [
    'expand-with-old-active','blue-green-concurrent-read-write','backfill-checkpoint-resume',
    'missing-expand-candidate-not-ready','contract-rollback-window-rejected',
    'contract-applied-non-rollback-compatible','advisory-lock-timeout','database-disconnect',
    'partial-failure-recovery','history-integrity-rejected'
  ]
  write(value(args, '--out'), {
    schema: 'fsusblog.release-migration-qualification-evidence.v1', contractVersion: 1,
    status: 'pass', runId: value(args, '--run-id'), rolloutId: state.rolloutId,
    source: state.source, target: state.target,
    cases: caseIds.map(id => ({ id, status: 'pass', actions: [], errors: [] })),
    errors: [], evidenceSha256: 'sha256:' + 'a'.repeat(64)
  })
}

async function normalWorkerLedger(args) {
  const stateFile = value(args, '--rollout-state')
  const drainFile = value(args, '--source-drain')
  const out = value(args, '--out')
  const deadline = Date.now() + fixturePollTimeoutMs
  while ((!fs.existsSync(stateFile) || !fs.existsSync(drainFile)) && Date.now() < deadline) await delay(10)
  if (!fs.existsSync(stateFile) || !fs.existsSync(drainFile)) throw new Error('fixture rollout/drain evidence missing')
  const state = read(stateFile)
  const kinds = ['scheduled-publish','article-mutation-outbox','audit-writer','visit-view-projection','public-hot-aot','upload-cleanup','active-singleton-control','multi-consumer-safe-control']
  const observedAtUtc = new Date().toISOString()
  write(out, {
    schema: 'fsusblog.release-worker-event-ledger.v1', mode: 'normal', status: 'pass', rolloutId: state.rolloutId,
    source: { releaseId: state.source.releaseId, slot: state.source.slot, generation: state.source.runtimeGeneration },
    target: { releaseId: state.target.releaseId, slot: state.target.slot, generation: state.target.runtimeGeneration },
    drill: { schema: 'fsusblog.release-worker-normal-observation.v1', runId: value(args, '--run-id'), destructive: false },
    events: kinds.map((kind, index) => ({
      logicalEventId: 'normal-event-' + String(index).padStart(2, '0'), kind, attemptCount: 1,
      finalEffectCount: 1, finalEffectKey: 'normal-effect-' + String(index).padStart(2, '0'),
      finalReleaseId: state.target.releaseId, finalGeneration: state.target.runtimeGeneration,
      staleGenerationCommitCount: 0, pendingCountAtDrain: 0, durableReplaySource: 'postgres-outbox',
      expectedAuditCount: kind === 'audit-writer' ? 1 : 0, actualAuditCount: kind === 'audit-writer' ? 1 : 0,
      expectedProjectionCount: kind === 'visit-view-projection' ? 1 : 0, actualProjectionCount: kind === 'visit-view-projection' ? 1 : 0,
      observationSource: 'postgres',
      observationBindings: Object.fromEntries(['finalEffectCount','finalEffectKey','finalReleaseId','finalGeneration','staleGenerationCommitCount'].map(field => [field, { observedAtUtc }]))
    })),
    errors: []
  })
}

function faultMatrix(args) {
  const plan = read(value(args, '--plan'))
  const cases = faultCases.map(name => ({
    case: name, status: 'pass', automated: true, actionStatus: 'executed', errors: [],
    after: ['active-fence-failure', 'public-probe-failure'].includes(name)
      ? { rolloutState: { status: 'rolled_back', recoveries: [{ action: 'rollback-gateway-to-source', status: 'ok' }] } }
      : { rolloutState: { status: 'recovery_required', recoveries: [] } }
  }))
  write(value(args, '--out'), {
    schema: 'fsusblog.zero-downtime-fault-matrix.v1', status: 'pass', rolloutId: plan.rolloutId,
    target: plan.target, caseCount: cases.length, cases, errors: []
  })
}

function probe(action, args) {
  const out = value(args, '--out', false)
  if (out) write(out, { schema: 'fixture-probe.v1', status: 'pass', errors: [] })
}

async function invokeProbe(name) {
  spawnSync(process.execPath, [path.join(root, 'tools/deployment/release-' + name + (name === 'asset' ? '-compatibility' : '') + '-probe.mjs')], {
    env: process.env, stdio: 'ignore'
  })
}

async function invokeNormalWorker(out, state) {
  record('probe-worker-reconciliation-normal', [])
  write(out, {
    schema: 'fsusblog.release-worker-reconciliation-evidence.v2', mode: 'normal', status: 'pass',
    rolloutId: state.rolloutId, source: state.source, target: state.target,
    kinds: ['scheduled-publish','article-mutation-outbox','audit-writer','visit-view-projection','public-hot-aot','upload-cleanup','active-singleton-control','multi-consumer-safe-control'],
    forcedSourceRecoveryRequired: false,
    checks: {
      rolloutSourceTargetBound: true, targetHealthBound: true, gracefulDrainVerified: true,
      requiredWorkerKindsCovered: true, durableBufferDrainOrReplayVerified: true,
      exactlyOnceVerified: true, staleGenerationRejected: true, auditReconciled: true, visitProjectionReconciled: true
    },
    errors: []
  })
}

function rolloutStateValue(input) {
  const targetGeneration = Number(input.sourceRecord.deploymentGeneration ?? 1) + 1
  return {
    schema: 'fsusblog.release-rollout-state.v1', rolloutId: input.rolloutId, kind: input.kind,
    status: 'planned', outcome: null, manifestPath: input.manifest,
    source: { slot: input.sourceSlot, releaseId: input.sourceRecord.releaseId, imageDigest: input.sourceRecord.imageDigest, runtimeGeneration: input.sourceRecord.deploymentGeneration ?? 1 },
    target: { slot: input.targetSlot, releaseId: input.targetManifest.releaseId, imageDigest: input.targetManifest.imageDigest, runtimeGeneration: targetGeneration },
    currentStage: null, completedStages: [], stages: [], switchCommitted: false, gatewayGeneration: null,
    contractMigrationApplied: false, rollbackAllowed: true, candidateOnly: false, recovery: null, recoveries: [], finalEvidencePath: null
  }
}

function slotState(slot, manifest) {
  return {
    schema: 'fsusblog.deployment-slots.v1', status: 'stable', activeSlot: slot,
    activeReleaseId: manifest.releaseId, activeImageDigest: manifest.imageDigest,
    previousSlot: null, previousReleaseId: null, previousImageDigest: null,
    runtimeGeneration: 1,
    slots: {
      blue: slot === 'blue' ? { releaseId: manifest.releaseId, imageDigest: manifest.imageDigest, deploymentGeneration: 1, status: 'running' } : null,
      green: slot === 'green' ? { releaseId: manifest.releaseId, imageDigest: manifest.imageDigest, deploymentGeneration: 1, status: 'running' } : null
    }
  }
}

function metadata(file) {
  const buffer = fs.readFileSync(file)
  const parsed = JSON.parse(buffer.toString('utf8'))
  return { path: file, bytes: buffer.length, sha256: 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex'), schema: parsed.schema, status: parsed.status }
}

function signal(rolloutId, runId, stage) {
  return { schema: 'fsusblog.release-worker-drill-signal.v1', rolloutId, runId, stage, observedAtUtc: new Date().toISOString() }
}

function value(args, name, required = true) {
  const index = args.indexOf(name)
  if (index >= 0 && args[index + 1] !== undefined) return args[index + 1]
  if (required) throw new Error('missing fixture argument ' + name)
  return null
}

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')) }
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n') }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
`
}

function writeRunner(deployment, name, action) {
  const runner = path.resolve(deployment, '../../fixture-runner.mjs')
  if (name.endsWith('.sh')) {
    fs.writeFileSync(path.join(deployment, name), `#!/usr/bin/env bash\nexec node "${runner}" ${action} "$@"\n`, { mode: 0o755 })
  } else {
    fs.writeFileSync(path.join(deployment, name), [
      '#!/usr/bin/env node',
      "import process from 'node:process'",
      "import { spawnSync } from 'node:child_process'",
      `const result = spawnSync(process.execPath, [${JSON.stringify(runner)}, ${JSON.stringify(action)}, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })`,
      'process.exitCode = result.status ?? 1',
      ''
    ].join('\n'), { mode: 0o755 })
  }
}

function releaseManifest(releaseId, digit) {
  return { schema: 'fsusblog.release-manifest.v1', releaseId, imageDigest: `sha256:${digit.repeat(64)}` }
}

function assetScenario(oldReleaseId, newReleaseId) {
  return {
    schema: 'fsusblog.release-asset-compatibility-scenario.v1',
    oldReleaseId,
    newReleaseId,
    browser: { required: true }
  }
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode })
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readRecords(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
}

function assertOrdered(records, kinds) {
  let offset = -1
  for (const kind of kinds) {
    const next = records.findIndex((item, index) => index > offset && item.kind === kind)
    assert.ok(next > offset, `${kind} was not observed after index ${offset}`)
    offset = next
  }
}

function onlyRunRoot(fixture) {
  const base = path.join(fixture.root, '.tmp/rehearsal/fixture-zdt')
  const entries = fs.readdirSync(base)
  assert.equal(entries.length, 1)
  return path.join(base, entries[0])
}

function readSummary(fixture, mode) {
  const summary = readJson(path.join(onlyRunRoot(fixture), 'evidence/rehearsal-summary.json'))
  assert.equal(summary.modes[0].mode, mode)
  return summary
}
