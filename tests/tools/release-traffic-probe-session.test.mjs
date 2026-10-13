import { createCurrentRolloutFixtureBinding } from './support/release-rollout-evidence-fixture.mjs'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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
  markGatewaySwitchCommitted,
  readRolloutState,
  startRolloutStage,
  writeRolloutStateAtomic
} from '../../tools/deployment/release-rollout-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const probe = path.join(root, 'tools/deployment/release-traffic-probe.mjs')
const verifier = path.join(root, 'tools/deployment/release-traffic-evidence-verify.mjs')
const scenario = path.join(root, 'tests/fixtures/deployment/release-traffic-session-scenario.json')
const source = {
  slot: 'blue',
  releaseId: '20260711010101-aaaaaaaaaaaa',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtimeGeneration: 71
}
const target = {
  slot: 'green',
  releaseId: '20260711020202-bbbbbbbbbbbb',
  imageDigest: `sha256:${'b'.repeat(64)}`,
  runtimeGeneration: 72
}

test('traffic probe carries a real cookie session, validates response/AEDS bytes, observes an in-flight gateway switch, and HMAC-seals final evidence', async t => {
  const fixture = createFixture(t, 'pass')
  const server = await loopbackServer(t, fixture, { mode: 'pass' })
  const result = await runProbe(fixture, server.baseUrl)

  assert.equal(result.status, 0, result.stderr)
  const report = result.report
  assert.equal(report.status, 'pass')
  assert.equal(report.releaseIdentityPolicy.required, true)
  assert.equal(report.releaseIdentityPolicy.violationCount, 0)
  assert.ok(report.releaseIdentityPolicy.coverage['gateway-switch/article'] >= 1)
  assert.ok(report.releaseDistribution.source >= 1)
  assert.ok(report.releaseDistribution.target >= 1)

  const session = report.sessionChains['authenticated-session']
  assert.ok(session.completedCycles >= 1)
  assert.equal(session.failedCycles, 0)
  assert.ok(session.cookieJar.some(cookie => cookie.name === 'fsus_session'))
  assert.match(session.cookieJar.find(cookie => cookie.name === 'fsus_session').valueSha256, /^sha256:[0-9a-f]{64}$/u)
  const refresh = findObservation(report, 'refresh-request')
  assert.ok(refresh.lastObservation.cookies.request.some(cookie => cookie.name === 'fsus_session'))
  assert.ok(refresh.lastObservation.cookies.response.some(cookie => cookie.name === 'fsus_session'))

  const binary = findObservation(report, 'binary-request').lastObservation
  assert.equal(binary.aeds.frameType, 1)
  assert.equal(binary.aeds.version, 2)
  assert.equal(binary.aeds.headerLength, 16)
  assert.equal(binary.aeds.flags, 0)
  assert.equal(binary.aeds.payloadBytes, 0)
  assert.equal(binary.aeds.payloadCrc16, 0xffff)
  assert.equal(binary.aeds.computedPayloadCrc16, 0xffff)
  assert.ok(binary.aeds.checks.every(item => item.pass))
  const staticResponse = findObservation(report, 'static-request').lastObservation
  assert.equal(staticResponse.body.sha256, 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.ok(staticResponse.body.checks.every(item => item.pass))

  const hold = report.gatewaySwitchHolds['gateway-hold-request']
  assert.ok(hold.attempts >= 1)
  assert.ok(hold.passCount >= 1)
  const passingHold = hold.observations.find(item => item.pass)
  assert.equal(passingHold.startedAt.switchCommitted, false)
  assert.equal(passingHold.completedAt.switchCommitted, true)
  assert.match(passingHold.startedAt.stateSha256, /^sha256:[0-9a-f]{64}$/u)
  assert.match(passingHold.completedAt.stateSha256, /^sha256:[0-9a-f]{64}$/u)
  assert.notEqual(passingHold.startedAt.stateSha256, passingHold.completedAt.stateSha256)
  assert.equal(passingHold.releaseRole, 'target')
  assert.match(passingHold.bindingSha256, /^sha256:[0-9a-f]{64}$/u)
  assert.ok(report.maxInFlightRequestCount >= 1)
  assert.equal(report.inFlightRequestCount, 0)

  assert.equal(
    report.observationBinding.observationCount,
    report.responseObservations.reduce((sum, item) => sum + item.count, 0))
  assert.equal(report.observationBinding.observationSha256.length, report.observationBinding.observationCount)
  let observationChain = sha256('fsusblog.release-traffic-observation-chain.v1')
  for (const digest of report.observationBinding.observationSha256) observationChain = sha256(`${observationChain}\0${digest}`)
  assert.equal(observationChain, report.observationBinding.chainHeadSha256)
  assert.match(report.observationBinding.chainHeadSha256, /^sha256:[0-9a-f]{64}$/u)
  verifyFinalBinding(report, fixture.bindingKey)
  assert.equal(JSON.stringify(report).includes('session-token-'), false)

  const verification = await runVerifier(fixture)
  assert.equal(verification.status, 0, verification.stderr)
  assert.equal(JSON.parse(verification.stdout).status, 'pass')

  const original = fs.readFileSync(fixture.output)
  fs.writeFileSync(fixture.output, `${JSON.stringify({ ...report, totalRequests: report.totalRequests + 1 })}\n`)
  const tampered = await runVerifier(fixture)
  assert.notEqual(tampered.status, 0)
  assert.match(tampered.stdout, /final binding payload hash mismatch/u)
  fs.writeFileSync(fixture.output, original)
})

test('traffic probe reports cookie, AEDS, release-identity and gateway-hold failures together while still sealing the failed artifact', async t => {
  const fixture = createFixture(t, 'fail')
  const server = await loopbackServer(t, fixture, { mode: 'fail' })
  const result = await runProbe(fixture, server.baseUrl)

  assert.notEqual(result.status, 0)
  const report = result.report
  assert.equal(report.status, 'fail')
  assert.ok(report.releaseIdentityPolicy.violationCount >= 12)
  assert.equal(report.gatewaySwitchHolds['gateway-hold-request'].passCount, 0)
  assert.ok(report.gatewaySwitchHolds['gateway-hold-request'].failCount >= 1)
  const codes = report.errors.map(item => item.code)
  assert.ok(codes.includes('release_identity_unknown_or_mismatched'))
  assert.ok(codes.includes('aeds_payloadcrc16'))
  assert.ok(codes.includes('cookie_response_set_missing_fsus_session'))
  assert.ok(codes.includes('cookie_request_missing_fsus_session'))
  assert.ok(codes.includes('gateway_hold_did_not_complete_after_commit'))
  assert.ok(codes.includes('gateway_hold_response_not_from_target'))
  assert.ok(report.errors.length >= 18)
  verifyFinalBinding(report, fixture.bindingKey)
})

function createFixture(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-traffic-session-${name}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'rollout-state.json')
  const state = createRolloutState({
    ...createCurrentRolloutFixtureBinding(),
    rolloutId: `traffic-session-${name}-20260711`,
    kind: 'deploy',
    manifestPath: path.join(directory, 'release-manifest.json'),
    source,
    target,
    createdAtUtc: '2026-07-11T00:00:00.000Z'
  })
  const gatewayIndex = state.completedStages.length
  const stages = [
    'manifest-validate',
    'capacity-preflight',
    'backup-restore-gate',
    'current-schema-admission',
    'asset-materialize',
    'candidate-start',
    'candidate-readiness',
    'candidate-smoke',
    'compatibility-smoke'
  ]
  for (let index = gatewayIndex; index < stages.length; index += 1) {
    startRolloutStage(state, stages[index], `2026-07-11T00:${String(index).padStart(2, '0')}:00.000Z`)
    completeRolloutStage(state, stages[index], { completedAtUtc: `2026-07-11T00:${String(index).padStart(2, '0')}:01.000Z` })
  }
  startRolloutStage(state, 'gateway-switch', '2026-07-11T00:10:00.000Z')
  writeRolloutStateAtomic(stateFile, state)
  const bindingKey = Buffer.alloc(32, name === 'pass' ? 0x31 : 0x32)
  const bindingKeyFile = path.join(directory, 'traffic-binding.key')
  fs.writeFileSync(bindingKeyFile, bindingKey, { mode: 0o600 })
  return {
    directory,
    state,
    stateFile,
    bindingKey,
    bindingKeyFile,
    snapshot: path.join(directory, 'traffic.snapshot.json'),
    output: path.join(directory, 'traffic.final.json'),
    stopFile: path.join(directory, 'traffic.stop')
  }
}

async function loopbackServer(t, fixture, options) {
  let sessionSequence = 0
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/hold') {
      setTimeout(() => {
        if (options.mode === 'pass' && !fixture.state.switchCommitted) commitGatewaySwitch(fixture)
        respond(response, fixture, options, 200, Buffer.from('held-through-switch'), 'text/plain')
      }, 20)
      return
    }
    if (url.pathname === '/binary') {
      respond(response, fixture, options, 200, aedsFrame(options.mode === 'fail'), 'application/octet-stream', {
        'x-fsus-frame-encoding': 'aeds-v2'
      })
      return
    }
    if (url.pathname === '/static') {
      respond(response, fixture, options, 200, Buffer.alloc(0), 'application/octet-stream')
      return
    }
    if (url.pathname === '/session/login') {
      sessionSequence += 1
      respondJson(response, fixture, options, 200, { ok: true }, options.mode === 'pass'
        ? { 'set-cookie': `fsus_session=session-token-${sessionSequence}; Path=/session; HttpOnly; SameSite=Lax` }
        : {})
      return
    }
    if (url.pathname === '/session/refresh') {
      const authorized = /(?:^|;\s*)fsus_session=session-token-/u.test(request.headers.cookie ?? '')
      if (!authorized) {
        respondJson(response, fixture, options, 401, { refreshed: false })
        return
      }
      sessionSequence += 1
      respondJson(response, fixture, options, 200, { refreshed: true }, {
        'set-cookie': `fsus_session=session-token-${sessionSequence}; Path=/session; HttpOnly; SameSite=Lax`
      })
      return
    }
    if (url.pathname === '/session/protected') {
      const authorized = /(?:^|;\s*)fsus_session=session-token-/u.test(request.headers.cookie ?? '')
      respondJson(response, fixture, options, authorized ? 200 : 401, { authorized })
      return
    }
    const body = url.pathname === '/home' ? Buffer.from('home-ok') : Buffer.from(`${url.pathname.slice(1)}-ok`)
    respond(response, fixture, options, 200, body, 'text/plain')
  })
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
  return { baseUrl: `http://127.0.0.1:${address.port}` }
}

function commitGatewaySwitch(fixture) {
  completeRolloutStage(fixture.state, 'gateway-switch', { completedAtUtc: '2026-07-11T00:10:01.000Z' })
  markGatewaySwitchCommitted(fixture.state, 73, '2026-07-11T00:10:01.100Z')
  startRolloutStage(fixture.state, 'source-drain', '2026-07-11T00:10:02.000Z')
  writeRolloutStateAtomic(fixture.stateFile, fixture.state)
  assert.equal(readRolloutState(fixture.stateFile).switchCommitted, true)
}

function respondJson(response, fixture, options, status, value, headers = {}) {
  respond(response, fixture, options, status, Buffer.from(JSON.stringify(value)), 'application/json', headers)
}

function respond(response, fixture, options, status, body, contentType, headers = {}) {
  const identity = fixture.state.switchCommitted ? target : source
  response.writeHead(status, {
    'content-type': contentType,
    'x-fsus-release-id': options.mode === 'fail' ? 'forged-release-identity' : identity.releaseId,
    'x-fsus-release-slot': options.mode === 'fail' ? 'forged-slot' : identity.slot,
    ...headers
  })
  response.end(body)
}

function aedsFrame(corrupt) {
  const bytes = Buffer.alloc(16)
  bytes.writeUInt32LE(0x53444541, 0)
  bytes.writeUInt8(2, 4)
  bytes.writeUInt8(16, 5)
  bytes.writeUInt16LE(0, 6)
  bytes.writeUInt16LE(1, 8)
  bytes.writeUInt32LE(0, 10)
  bytes.writeUInt16LE(corrupt ? 0 : 0xffff, 14)
  return bytes
}

async function runProbe(fixture, baseUrl) {
  const child = spawn(process.execPath, [
    probe,
    '--base-url', baseUrl,
    '--scenario', scenario,
    '--rollout-state', fixture.stateFile,
    '--snapshot', fixture.snapshot,
    '--out', fixture.output,
    '--stop-file', fixture.stopFile,
    '--binding-key-file', fixture.bindingKeyFile,
    '--concurrency', '1',
    '--rounds', '1',
    '--interval-ms', '1',
    '--timeout-ms', '1000',
    '--snapshot-interval-ms', '100',
    '--expect-releases', 'both'
  ], {
    cwd: root,
    env: { ...process.env, FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const result = await collectChild(child)
  assert.equal(result.timedOut, false, result.stderr)
  assert.equal(fs.existsSync(fixture.output), true, result.stderr)
  return { ...result, report: JSON.parse(fs.readFileSync(fixture.output, 'utf8')) }
}

async function runVerifier(fixture) {
  const child = spawn(process.execPath, [
    verifier,
    '--evidence', fixture.output,
    '--scenario', scenario,
    '--binding-key-file', fixture.bindingKeyFile,
    '--rollout-id', fixture.state.rolloutId
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return collectChild(child)
}

function collectChild(child, timeoutMs = 15_000) {
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
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr, timedOut })
    })
  })
}

function findObservation(report, requestId) {
  const observations = report.responseObservations.filter(item => item.requestId === requestId)
  assert.ok(observations.length >= 1, requestId)
  return observations.at(-1)
}

function verifyFinalBinding(report, key) {
  const { finalBinding, ...unsignedReport } = report
  assert.equal(finalBinding.schema, 'fsusblog.release-traffic-final-binding.v1')
  assert.equal(finalBinding.algorithm, 'hmac-sha256')
  assert.equal(finalBinding.payloadSha256, sha256(canonicalJson(unsignedReport)))
  const { signature, ...unsignedBinding } = finalBinding
  assert.equal(signature, hmacSha256(key, canonicalJson(unsignedBinding)))
  assert.equal(finalBinding.observationCount, report.observationBinding.observationCount)
  assert.equal(finalBinding.observationHashChain, report.observationBinding.chainHeadSha256)
}

function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function hmacSha256(key, value) {
  return `hmac-sha256:${crypto.createHmac('sha256', key).update(value).digest('hex')}`
}
