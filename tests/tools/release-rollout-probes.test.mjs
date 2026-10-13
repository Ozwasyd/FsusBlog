import { createCurrentRolloutFixtureBinding } from './support/release-rollout-evidence-fixture.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  completeRolloutStage,
  createRolloutState,
  startRolloutStage,
  writeRolloutStateAtomic
} from '../../tools/deployment/release-rollout-lib.mjs'
import { boundedSemanticScale } from './support/timing-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const trafficProbe = path.join(root, 'tools/deployment/release-traffic-probe.mjs')
const resourceProbe = path.join(root, 'tools/deployment/release-resource-probe.mjs')
const categories = [
  'home', 'archive', 'article', 'binary', 'search', 'static',
  'login', 'refresh', 'protected-read', 'write', 'upload', 'admin-health'
]
const sourceRelease = '20260710010101-aaaaaaaaaaaa'
const targetRelease = '20260711010101-bbbbbbbbbbbb'

function positiveNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function resolveRolloutMachineTiming({ hostCpu, grantedCpu, load1 }) {
  const pressureScale = Math.max(1, hostCpu / grantedCpu, (load1 + 1) / grantedCpu)
  const wait = milliseconds => Math.ceil(milliseconds * pressureScale)
  const semanticWait = milliseconds => Math.ceil(milliseconds * boundedSemanticScale(pressureScale))
  return {
    requestTimeoutMs: wait(1_000),
    trafficChildTimeoutMs: wait(20_000),
    resourceChildTimeoutMs: wait(10_000),
    baselineLatencyMs: semanticWait(10),
    overlapLatencyMs: semanticWait(250)
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
  return resolveRolloutMachineTiming({ hostCpu, grantedCpu, load1 })
}

test('rollout timing wires shared semantic scale to latency and full pressure to timeouts', () => {
  const timing = resolveRolloutMachineTiming({ hostCpu: 8, grantedCpu: 2, load1: 0 })

  assert.deepEqual(timing, {
    requestTimeoutMs: 4_000,
    trafficChildTimeoutMs: 80_000,
    resourceChildTimeoutMs: 40_000,
    baselineLatencyMs: 14,
    overlapLatencyMs: 344
  })
})

function createFixture(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'rollout-state.json')
  const state = createRolloutState({
    ...createCurrentRolloutFixtureBinding(),
    rolloutId: `deploy-${name}-20260711`,
    manifestPath: path.join(directory, 'release-manifest.json'),
    source: {
      slot: 'blue',
      releaseId: sourceRelease,
      imageDigest: `sha256:${'a'.repeat(64)}`,
      runtimeGeneration: 71
    },
    target: {
      slot: 'green',
      releaseId: targetRelease,
      imageDigest: `sha256:${'b'.repeat(64)}`,
      runtimeGeneration: 72
    },
    createdAtUtc: '2026-07-11T00:00:00.000Z'
  })
  writeRolloutStateAtomic(stateFile, state)
  return { directory, stateFile, state }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function scenario(overrides = {}) {
  return {
    schema: 'fsusblog.release-traffic-scenario.v1',
    requests: categories.map(category => ({
      id: `${category}-request`,
      category,
      path: `/${category}`,
      expectedStatus: [200],
      ...(overrides[category] ?? {})
    }))
  }
}

function moveToOverlap(data) {
  const stages = [
    'manifest-validate',
    'capacity-preflight',
    'backup-restore-gate',
    'current-schema-admission',
    'asset-materialize'
  ]
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]
    startRolloutStage(data.state, stage, `2026-07-11T00:0${index}:00.000Z`)
    completeRolloutStage(data.state, stage, { completedAtUtc: `2026-07-11T00:0${index}:01.000Z` })
  }
  startRolloutStage(data.state, 'candidate-start', '2026-07-11T00:05:00.000Z')
  writeRolloutStateAtomic(data.stateFile, data.state)
}

async function loopbackServer(t, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

function collectChild(child, timeoutMs) {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ status: code, signal, stdout, stderr, timedOut })
    })
  })
}

async function runTraffic(data, baseUrl, scenarioValue, options = {}) {
  const timing = machineTiming()
  const scenarioFile = path.join(data.directory, `scenario-${options.name ?? 'default'}.json`)
  const snapshot = path.join(data.directory, `traffic-${options.name ?? 'default'}.snapshot.json`)
  const output = path.join(data.directory, `traffic-${options.name ?? 'default'}.json`)
  const stopFile = path.join(data.directory, `traffic-${options.name ?? 'default'}.stop`)
  writeJson(scenarioFile, scenarioValue)
  const child = spawn(process.execPath, [
    trafficProbe,
    '--base-url', baseUrl,
    '--scenario', scenarioFile,
    '--rollout-state', data.stateFile,
    '--snapshot', snapshot,
    '--out', output,
    '--stop-file', stopFile,
    '--concurrency', String(options.concurrency ?? 1),
    '--rounds', String(options.rounds ?? 1),
    '--interval-ms', '0',
    '--timeout-ms', String(options.timeoutMs ?? timing.requestTimeoutMs),
    '--snapshot-interval-ms', '100',
    '--expect-releases', options.expectReleases ?? 'both'
  ], {
    cwd: root,
    env: { ...process.env, FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const result = await collectChild(child, options.childTimeoutMs ?? timing.trafficChildTimeoutMs)
  assert.equal(result.timedOut, false, result.stderr)
  assert.equal(fs.existsSync(output), true, result.stderr)
  return { result, report: JSON.parse(fs.readFileSync(output, 'utf8')) }
}

function releaseHeaders(requestNumber) {
  const source = requestNumber % 2 === 1
  return {
    'x-fsus-release-id': source ? sourceRelease : targetRelease,
    'x-fsus-release-slot': source ? 'blue' : 'green'
  }
}

function observedLatencySummary(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = quantile => sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  )] ?? null
  return {
    samples: sorted.length,
    p50: percentile(0.50),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null
  }
}

function observedLatencyImpactPercent(baseline, overlap) {
  if (!Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(overlap) || overlap < 0) return null
  return Math.max(0, ((overlap - baseline) / baseline) * 100)
}

test('traffic probe covers all 12 categories, explicitly classifies business 5xx, and measures source/target baseline-overlap impact', async (t) => {
  const data = createFixture(t, 'traffic-pass')
  const timing = machineTiming()
  let requests = 0
  const injectedDelayMs = { baseline: [], overlap: [] }
  const { baseUrl } = await loopbackServer(t, (request, response) => {
    requests += 1
    const baseline = requests <= categories.length
    if (requests === categories.length) moveToOverlap(data)
    const headers = releaseHeaders(requests)
    const phase = baseline ? 'baseline' : 'overlap'
    const delayMs = baseline ? timing.baselineLatencyMs : timing.overlapLatencyMs
    injectedDelayMs[phase].push(delayMs)
    setTimeout(() => {
      if (request.url === '/write') {
        response.writeHead(500, {
          ...headers,
          'content-type': 'application/json',
          'x-fsus-error-class': 'business'
        })
        response.end(JSON.stringify({ code: 'WRITE_CONFLICT' }))
      } else {
        response.writeHead(200, headers)
        response.end('ok')
      }
    }, delayMs)
  })
  const passingScenario = scenario({
    write: { expectedStatus: [500], allowedBusinessErrorCodes: ['WRITE_CONFLICT'] }
  })
  const { result, report } = await runTraffic(data, baseUrl, passingScenario, {
    name: 'pass',
    rounds: 2,
    timeoutMs: timing.requestTimeoutMs + (timing.overlapLatencyMs * 2),
    childTimeoutMs: timing.trafficChildTimeoutMs + (categories.length * timing.overlapLatencyMs * 2)
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.requiredCategories, categories)
  assert.deepEqual(Object.keys(report.categoryCounts).sort(), [...categories].sort())
  assert.equal(categories.every(category => report.categoryCounts[category] === 2), true)
  assert.equal(report.totalRequests, 24)
  assert.equal(report.business5xxCount, 2)
  assert.equal(report.deploymentFailureCount, 0)
  assert.equal(report.unhandled5xxCount, 0)
  assert.equal(report.inFlightAbortedCount, 0)
  assert.equal(report.inFlightRequestCount, 0)
  assert.ok(report.releaseDistribution.source > 0)
  assert.ok(report.releaseDistribution.target > 0)
  assert.equal(report.phaseLatencyMs.baseline.samples, 12)
  assert.equal(report.phaseLatencyMs.overlap.samples, 12)
  assert.equal(injectedDelayMs.baseline.length, 12)
  assert.equal(injectedDelayMs.overlap.length, 12)
  assert.ok(Math.min(...injectedDelayMs.overlap) > Math.max(...injectedDelayMs.baseline))

  // Production runs deliberately saturate the host. A baseline request can be
  // descheduled after the server responds while an overlap request is not, so
  // real wall-clock percentiles are not guaranteed to preserve the fixture's
  // delay ordering. Verify the semantic injection separately, then prove that
  // the report derives both phase summaries and impacts from its observations.
  const baselineLatencies = report.responseObservations
    .filter(observation => observation.stage === 'status:planned')
    .map(observation => observation.lastObservation.latencyMs)
  const overlapLatencies = report.responseObservations
    .filter(observation => observation.stage === 'candidate-start')
    .map(observation => observation.lastObservation.latencyMs)
  const expectedBaseline = observedLatencySummary(baselineLatencies)
  const expectedOverlap = observedLatencySummary(overlapLatencies)
  assert.deepEqual(report.phaseLatencyMs.baseline, expectedBaseline)
  assert.deepEqual(report.phaseLatencyMs.overlap, expectedOverlap)
  assert.equal(
    report.impactPercent.p95,
    observedLatencyImpactPercent(expectedBaseline.p95, expectedOverlap.p95)
  )
  assert.equal(
    report.impactPercent.p99,
    observedLatencyImpactPercent(expectedBaseline.p99, expectedOverlap.p99)
  )
})

test('traffic probe fail-closes gateway 5xx, unmarked 5xx, connection timeout and aborted in-flight work separately', async (t) => {
  const data = createFixture(t, 'traffic-failures')
  let requests = 0
  const { baseUrl } = await loopbackServer(t, (request, response) => {
    requests += 1
    const headers = releaseHeaders(requests)
    if (request.url === '/home') {
      response.writeHead(503, headers)
      response.end('gateway unavailable')
    } else if (request.url === '/archive') {
      response.writeHead(500, { ...headers, 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 'ARCHIVE_FAILURE' }))
    } else if (request.url === '/article') {
      return
    } else {
      response.writeHead(200, headers)
      response.end('ok')
    }
  })
  const failureScenario = scenario({ article: { timeoutMs: 100 } })
  const { result, report } = await runTraffic(data, baseUrl, failureScenario, {
    name: 'failures', rounds: 1
  })

  assert.notEqual(result.status, 0)
  assert.equal(report.status, 'fail')
  assert.equal(report.gatewayErrorCount, 1)
  assert.equal(report.unhandled5xxCount, 1)
  assert.equal(report.connectionErrorCount, 1)
  assert.equal(report.inFlightAbortedCount, 1)
  assert.equal(report.inFlightRequestCount, 0)
  assert.equal(report.deploymentFailureCount, 3)
  assert.equal(report.business5xxCount, 0)
  assert.equal(report.categoryCounts.article, 1)
  assert.match(report.errors.map(error => error.code).join('\n'), /http_503/u)
  assert.match(report.errors.map(error => error.code).join('\n'), /http_500/u)
  assert.equal(report.errors.some(error => error.requestId === 'article-request'), true)
})

test('traffic probe returns every deployment error without a maximum-error cap or tail truncation', async (t) => {
  const data = createFixture(t, 'traffic-all-errors')
  let requests = 0
  const { baseUrl } = await loopbackServer(t, (_request, response) => {
    requests += 1
    response.writeHead(503, releaseHeaders(requests))
    response.end('gateway unavailable')
  })
  const { result, report } = await runTraffic(data, baseUrl, scenario(), {
    name: 'all-errors', rounds: 10
  })

  assert.notEqual(result.status, 0)
  assert.equal(report.totalRequests, categories.length * 10)
  assert.equal(report.gatewayErrorCount, categories.length * 10)
  assert.equal(report.deploymentFailureCount, categories.length * 10)
  assert.equal(Object.values(report.stageFailures).reduce((sum, value) => sum + value, 0), categories.length * 10)
  assert.equal(report.errors.length, categories.length * 10)
})

function createFakeExecutables(directory) {
  const bin = path.join(directory, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const docker = path.join(bin, 'docker')
  fs.writeFileSync(docker, `#!/usr/bin/env node
const high = process.env.FAKE_DOCKER_HIGH === '1'
process.stdout.write(JSON.stringify({
  CPUPerc: high ? '90.0%' : '10.0%',
  MemUsage: high ? '900MiB / 4GiB' : '100MiB / 4GiB',
  MemPerc: high ? '22.0%' : '2.5%',
  PIDs: high ? '80' : '8'
}) + '\\n')
`)
  const df = path.join(bin, 'df')
  fs.writeFileSync(df, `#!/bin/sh
if [ "\${FAKE_DF_FAIL:-0}" = "1" ]; then
  echo "injected df failure" >&2
  exit 9
fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
printf 'fixture 200000 1000 100000 1%% /fixture\\n'
`)
  fs.chmodSync(docker, 0o755)
  fs.chmodSync(df, 0o755)
  return bin
}

function resourcePolicy(overrides = {}) {
  return {
    schema: 'fsusblog.zero-downtime-resource-policy.v1',
    minimumSupported: { cpuCores: 1, memoryMiB: 1, freeDiskMiB: 1 },
    budgets: {
      dualSlotCpuPercent: 300,
      dualSlotMemoryMiB: 10_000,
      temporaryDiskMiB: 1_000,
      activeTrafficP95ImpactPercent: 100,
      activeTrafficP99ImpactPercent: 100,
      openRestyReloadMs: 1_000,
      drainMs: 1_000,
      notificationReconnectMs: 1_000
    },
    sampling: { intervalMs: 250, minimumOverlapSamples: 1 },
    ...overrides
  }
}

async function runResource(data, policyValue, options = {}) {
  const timing = machineTiming()
  const policyFile = path.join(data.directory, `resource-policy-${options.name ?? 'default'}.json`)
  const snapshot = path.join(data.directory, `resource-${options.name ?? 'default'}.snapshot.json`)
  const output = path.join(data.directory, `resource-${options.name ?? 'default'}.json`)
  const stopFile = path.join(data.directory, `resource-${options.name ?? 'default'}.stop`)
  writeJson(policyFile, policyValue)
  const args = [
    resourceProbe,
    '--rollout-state', data.stateFile,
    '--source-container', 'fsusblog-blue',
    '--target-container', 'fsusblog-green',
    '--policy', policyFile,
    '--snapshot', snapshot,
    '--out', output,
    '--stop-file', stopFile,
    '--disk-path', data.directory
  ]
  for (const [option, file] of Object.entries(options.evidence ?? {})) args.push(`--${option}`, file)
  const fakeBin = createFakeExecutables(data.directory)
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_DOCKER_HIGH: options.highUsage ? '1' : '0',
      FAKE_DF_FAIL: options.dfFailure ? '1' : '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const stopTimer = setInterval(() => {
    if (fs.existsSync(snapshot)) {
      fs.writeFileSync(stopFile, 'stop\n')
      clearInterval(stopTimer)
    }
  }, 25)
  const result = await collectChild(child, timing.resourceChildTimeoutMs)
  clearInterval(stopTimer)
  assert.equal(result.timedOut, false, result.stderr)
  assert.equal(fs.existsSync(output), true, result.stderr)
  return { result, report: JSON.parse(fs.readFileSync(output, 'utf8')) }
}

function writeResourceInputs(data) {
  const files = {
    'gateway-evidence': path.join(data.directory, 'gateway.json'),
    'drain-evidence': path.join(data.directory, 'drain.json'),
    'notification-evidence': path.join(data.directory, 'notification.json'),
    'traffic-evidence': path.join(data.directory, 'traffic.json')
  }
  writeJson(files['gateway-evidence'], { durationMs: 10 })
  writeJson(files['drain-evidence'], { durationMs: 20 })
  writeJson(files['notification-evidence'], { reconnectDurationMs: 30 })
  writeJson(files['traffic-evidence'], { impactPercent: { p95: 15, p99: 20 } })
  return files
}

test('resource probe proves minimum hardware, overlap, disk and operational impact budgets with fake host executables', async (t) => {
  const data = createFixture(t, 'resource-pass')
  const evidence = writeResourceInputs(data)
  const { result, report } = await runResource(data, resourcePolicy(), {
    name: 'pass', evidence
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(report.status, 'pass')
  assert.equal(report.withinBudget, true)
  assert.equal(Object.values(report.checks).every(Boolean), true)
  assert.ok(report.measurements.overlapSampleCount >= 1)
  assert.equal(report.measurements.dualSlotCpuPeakPercent, 20)
  assert.equal(report.measurements.dualSlotMemoryPeakMiB, 200)
  assert.equal(report.measurements.temporaryDiskPeakMiB, 0)
  assert.equal(report.measurements.openRestyReloadMs, 10)
  assert.equal(report.measurements.drainMs, 20)
  assert.equal(report.measurements.notificationReconnectMs, 30)
  assert.equal(report.measurements.activeTrafficP95ImpactPercent, 15)
  assert.equal(report.measurements.activeTrafficP99ImpactPercent, 20)
  assert.deepEqual(report.errors, [])
})

test('resource probe aggregates every missing or exceeded hardware, dual-slot, disk, reload, drain, reconnect and traffic budget', async (t) => {
  const data = createFixture(t, 'resource-fail-closed')
  const impossible = Number.MAX_SAFE_INTEGER
  const policy = resourcePolicy({
    minimumSupported: { cpuCores: impossible, memoryMiB: impossible, freeDiskMiB: impossible },
    budgets: {
      dualSlotCpuPercent: 1,
      dualSlotMemoryMiB: 1,
      temporaryDiskMiB: 1,
      activeTrafficP95ImpactPercent: 1,
      activeTrafficP99ImpactPercent: 1,
      openRestyReloadMs: 1,
      drainMs: 1,
      notificationReconnectMs: 1
    },
    sampling: { intervalMs: 250, minimumOverlapSamples: 1 }
  })
  const { result, report } = await runResource(data, policy, {
    name: 'fail-closed', highUsage: true, dfFailure: true
  })

  assert.notEqual(result.status, 0)
  assert.equal(report.status, 'fail')
  assert.equal(report.withinBudget, false)
  const expectedFailures = [
    'minimumCpuCores', 'minimumMemory', 'minimumFreeDisk',
    'dualSlotCpu', 'dualSlotMemory', 'temporaryDisk',
    'openRestyReload', 'drain', 'notificationReconnect',
    'trafficP95Impact', 'trafficP99Impact'
  ]
  for (const check of expectedFailures) assert.equal(report.checks[check], false, check)
  assert.equal(report.checks.overlapSamples, true)
  const errorComponents = new Set(report.errors.map(error => error.component))
  assert.ok(errorComponents.has('disk'))
  for (const check of expectedFailures) assert.ok(errorComponents.has(check), check)
})
