import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
    ROLLOUT_STAGES,
    completeRolloutStage,
    createRolloutState,
    markActivationCommitted,
    markDestructiveCutoverStarted,
    markGatewaySwitchCommitted,
    startRolloutStage,
    writeRolloutStateAtomic
} from '../../tools/deployment/release-rollout-lib.mjs'
import { createPublicAotWarmEvidence } from '../../tools/frontend/public-aot-warm-evidence.mjs'
import { createCurrentRolloutFixtureBinding, createCurrentRolloutAdmissionFixtureOutput } from './support/release-rollout-evidence-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceCli = path.join(root, 'tools/deployment/release-rollout-evidence.mjs')
const rolloutId = 'deploy-20260711-release-evidence'
const source = {
  slot: 'blue',
  releaseId: '20260710010101-aaaaaaaaaaaa',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtimeGeneration: 41
}
const target = {
  slot: 'green',
  releaseId: '20260711010101-bbbbbbbbbbbb',
  imageDigest: `sha256:${'b'.repeat(64)}`,
  runtimeGeneration: 42
}
const requiredArtifactNames = [
  'publicTraffic',
  'notificationStream',
  'assetCompatibility',
  'workerReconciliation',
  'resourceBudget',
  'faultInjection'
]
const requiredAuxiliaryNames = [
    'releaseManifest', 'backupRestoreGate', 'currentSchemaAdmission', 'candidateReadiness',
    'assetMaterialization', 'retentionPrepared', 'retainedAssets', 'publicAotWarm',
    'candidateSmoke', 'compatibilityMatrix', 'gatewayTransition', 'activeFenceAcquire',
    'activeFenceSourceRevoke', 'activeFenceVerify', 'challengeKindCutoverReceipt',
    'challengeKindCutoverAcceptance', 'challengeKindCutoverGate', 'perceptionCharacterV3Cutover',
    'publicTrafficCheckpoint',
    'sourceDrainSnapshot', 'sourceDrainGate', 'targetHealth',
    'retentionDrainComplete', 'operatorNote'
];
const faultCases = [
  'manifest-digest-mismatch',
  'capacity-insufficient',
  'current-admission-failure',
  'candidate-readiness',
  'asset-hash-mismatch',
  'gateway-reload-failure',
  'active-fence-failure',
  'public-probe-failure',
  'drain-timeout',
  'source-stop-failure',
  'host-interruption',
  'redis-disconnect',
  'postgres-disconnect'
]
const trafficCategories = [
  'home', 'archive', 'article', 'binary', 'search', 'static',
  'login', 'refresh', 'protected-read', 'write', 'upload', 'admin-health'
]

function fixture(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return {
    directory,
    stateFile: path.join(directory, 'state.json'),
    commandDirectory: path.join(directory, 'commands'),
    artifactDirectory: path.join(directory, 'artifacts')
  }
}

function newState(directory) {
  const binding = createCurrentRolloutFixtureBinding()
  binding.manifestSha256 = crypto.createHash('sha256').update(`${JSON.stringify(manifestPayload(), null, 2)}\n`).digest('hex')
  return createRolloutState({
    ...binding,
    rolloutId,
    kind: 'deploy',
    manifestPath: path.join(directory, 'release-manifest.json'),
    source,
    target,
    createdAtUtc: '2026-07-11T00:00:00.000Z'
  })
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function stageEvidenceFile(fixture, stage) {
  const file = path.join(fixture.commandDirectory, `${stage}.json`)
  let output
  if (stage === 'current-schema-admission') {
    const stdout = path.join(fixture.commandDirectory, `${stage}.stdout`)
    writeJson(stdout, createCurrentRolloutAdmissionFixtureOutput())
    const bytes = fs.readFileSync(stdout)
    output = { stdout: { path: stdout, bytes: bytes.length,
      sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` } }
  }
  writeJson(file, {
    schema: 'fsusblog.release-rollout-stage-evidence.v2',
    rolloutId,
    stage,
    attempt: 1,
    status: 'ok',
    exitCode: 0,
    ...(output ? { output } : {})
  })
  return file
}

function advanceState(fixture, { includeFinalStage = false, runFinalStage = false } = {}) {
  const state = newState(fixture.directory)
  const end = includeFinalStage ? ROLLOUT_STAGES.length : ROLLOUT_STAGES.length - 1
  for (let index = 0; index < end; index += 1) {
        const stage = ROLLOUT_STAGES[index];
        const minute = String(index).padStart(2, '0');
        startRolloutStage(state, stage, `2026-07-11T00:${minute}:00.000Z`);
        if (stage === 'source-drain') {markDestructiveCutoverStarted(state, `2026-07-11T00:${minute}:00.500Z`)};
        if (stage === 'active-fence') {markActivationCommitted(state, `2026-07-11T00:${minute}:00.500Z`)};
        completeRolloutStage(state, stage, {
            completedAtUtc: `2026-07-11T00:${minute}:01.000Z`,
            evidencePath: stageEvidenceFile(fixture, stage)
    })
    if (stage === 'gateway-switch') {
      markGatewaySwitchCommitted(state, 27, `2026-07-11T00:${minute}:02.000Z`)
    }
  }
  if (!includeFinalStage || runFinalStage) {
    startRolloutStage(state, 'release-evidence', '2026-07-11T00:20:00.000Z')
  }
  writeRolloutStateAtomic(fixture.stateFile, state)
  return state
}

function validArtifactPayloads() {
  return {
    publicTraffic: validPublicTrafficPayload(),
    notificationStream: {
      schema: 'fsusblog.release-notification-stream-evidence.v1',
      contractVersion: 2,
      status: 'pass',
      rolloutId,
      target,
      missingEventCount: 0,
      duplicateAppliedEventCount: 0,
      duplicateBusinessEventCount: 0,
      serviceRestartObserved: true,
      cursorReplayVerified: true,
      replayMissFullResyncVerified: true,
      businessEventsExactlyOnce: true,
      slowClientDidNotBlockDrain: true,
      inputBindings: { resyncScenario: { sha256: `sha256:${'c'.repeat(64)}` } },
      resync: {
        staleGuest: [
          { phase: 'replay-miss', status: 'pass', watermark: 10, contentSha256: `sha256:${'d'.repeat(64)}` },
          { phase: 'final', status: 'pass', watermark: 20, contentSha256: `sha256:${'e'.repeat(64)}` }
        ],
        staleAuth: [
          { phase: 'replay-miss', status: 'pass', watermark: 10, contentSha256: `sha256:${'f'.repeat(64)}` },
          { phase: 'final', status: 'pass', watermark: 20, contentSha256: `sha256:${'1'.repeat(64)}` }
        ]
      }
    },
    assetCompatibility: validAssetCompatibilityPayload(),
    workerReconciliation: {
      schema: 'fsusblog.release-worker-reconciliation-evidence.v2',
      mode: 'normal',
      status: 'pass',
      rolloutId,
      target,
      duplicateEffectCount: 0,
      staleGenerationCommitCount: 0,
      lostAuditCount: 0,
      lostVisitProjectionCount: 0,
      buffersDrained: true,
      durableReplayVerified: true,
      gracefulDrainVerified: true,
      forcedSourceRecoveryRequired: false,
      forcedSourceRecoveryVerified: false,
      checks: {
        rolloutSourceTargetBound: true,
        targetHealthBound: true,
        gracefulDrainVerified: true,
        requiredWorkerKindsCovered: true,
        durableBufferDrainOrReplayVerified: true,
        exactlyOnceVerified: true,
        staleGenerationRejected: true,
        auditReconciled: true,
        visitProjectionReconciled: true
      }
    },
    resourceBudget: {
      schema: 'fsusblog.release-resource-budget-evidence.v1',
      status: 'pass',
      rolloutId,
      target,
      withinBudget: true,
      minimumSupported: { cpuCores: 4, memoryMiB: 6144, freeDiskMiB: 10240 },
      checks: {
        minimumCpuCores: true,
        minimumMemory: true,
        minimumFreeDisk: true,
        overlapSamples: true,
        dualSlotCpu: true,
        dualSlotMemory: true,
        temporaryDisk: true,
        openRestyReload: true,
        drain: true,
        notificationReconnect: true,
        trafficP95Impact: true,
        trafficP99Impact: true
      }
    },
    faultInjection: {
      schema: 'fsusblog.zero-downtime-fault-matrix-evidence.v1',
      status: 'pass',
      rolloutId,
      target,
      cases: faultCases.map(name => ({ case: name, status: 'pass', automated: true }))
    }
  }
}

function validPublicTrafficPayload() {
  const observationDigest = `sha256:${'8'.repeat(64)}`
  const initialHead = sha256Text('fsusblog.release-traffic-observation-chain.v1')
  const chainHead = sha256Text(`${initialHead}\0${observationDigest}`)
  const scenarioSha256 = `sha256:${'9'.repeat(64)}`
  const initialStateSha256 = `sha256:${'a'.repeat(64)}`
  const coverage = Object.fromEntries(
    ['status:planned', ...ROLLOUT_STAGES, 'status:completed']
      .flatMap(stage => trafficCategories.map(category => [`${stage}/${category}`, 1])))
  const unsigned = {
    schema: 'fsusblog.release-traffic-evidence.v1',
    status: 'pass',
    probeMode: 'public-rollout',
    rolloutId,
    target,
    errors: [],
    unexpectedResponseCount: 0,
    deploymentFailureCount: 0,
    connectionErrorCount: 0,
    gatewayErrorCount: 0,
    unhandled5xxCount: 0,
    inFlightAbortedCount: 0,
    inFlightRequestCount: 0,
    totalRequests: 240,
    releaseDistribution: { source: 120, target: 120 },
    requiredCategories: [...trafficCategories],
    releaseIdentityPolicy: {
      required: true,
      scenarioRequired: true,
      mode: 'public-rollout',
      violationCount: 0,
      coverage
    },
    sessionChains: {
      authenticated: { completedCycles: 12, failedCycles: 0 }
    },
    gatewaySwitchHolds: {
      article: {
        required: true,
        attempts: 1,
        passCount: 1,
        failCount: 0,
        observations: [{
          pass: true,
          startedAt: { switchCommitted: false },
          completedAt: { switchCommitted: true },
          releaseRole: 'target',
          bindingSha256: `sha256:${'b'.repeat(64)}`
        }]
      }
    },
    responseObservations: [{
      category: 'binary',
      lastObservation: {
        aeds: {
          checks: Array.from({ length: 7 }, (_, index) => ({ kind: `check-${index}`, pass: true }))
        }
      }
    }],
    observationBinding: {
      schema: 'fsusblog.release-traffic-observation-chain.v1',
      algorithm: 'sha256-chain',
      observationCount: 1,
      observationSha256: [observationDigest],
      chainHeadSha256: chainHead,
      scenarioSha256,
      initialRolloutStateSha256: initialStateSha256
    }
  }
  return {
    ...unsigned,
    finalBinding: {
      schema: 'fsusblog.release-traffic-final-binding.v1',
      algorithm: 'hmac-sha256',
      keyId: `hmac-sha256:${'c'.repeat(64)}`,
      rolloutId,
      scenarioSha256,
      initialRolloutStateSha256: initialStateSha256,
      finalRolloutStateSha256: `sha256:${'d'.repeat(64)}`,
      observationCount: 1,
      observationHashChain: chainHead,
      payloadSha256: sha256Text(canonicalJson(unsigned)),
      signature: `hmac-sha256:${'e'.repeat(64)}`
    }
  }
}

function validAssetCompatibilityPayload() {
  const scenarioSha256 = `sha256:${'1'.repeat(64)}`
  const manifestSha256 = `sha256:${'2'.repeat(64)}`
  const gcEvidenceSha256 = `sha256:${'3'.repeat(64)}`
  const browser = {
    schema: 'fsusblog.release-asset-browser-evidence.v1',
    status: 'pass',
    browser: {
      name: 'chromium',
      version: 'fixture-1',
      executablePath: '/fixture/chromium',
      executableSha256: `sha256:${'4'.repeat(64)}`
    },
    bindings: {
      rolloutId,
      sourceReleaseId: source.releaseId,
      targetReleaseId: target.releaseId,
      scenarioSha256,
      manifestSha256,
      gcEvidenceSha256
    },
    beforeSwitch: { status: 'pass', serviceWorker: { controller: { state: 'activated' } } },
    delayed: {
      resources: ['javascript', 'stylesheet', 'wasm', 'font'].map(kind => ({ kind, hashMatches: true }))
    },
    afterSwitch: { status: 'pass' },
    compatibility: {
      oldFrontendToNewBackend: { status: 'pass' },
      newFrontendToOldBackend: { status: 'pass' }
    },
    afterGc: { status: 'pass', cacheReads: [{ cacheHit: true, hashMatches: true }] },
    console: [],
    pageErrors: [],
    network: { responses: [], failures: [], blockedOldAssetRequests: [] },
    errors: []
  }
  const unsigned = {
    schema: 'fsusblog.release-asset-compatibility-evidence.v1',
    status: 'pass',
    rolloutId,
    sourceReleaseId: source.releaseId,
    targetReleaseId: target.releaseId,
    target,
    errors: [],
    notFoundCount: 0,
    hashMismatchCount: 0,
    connectionErrorCount: 0,
    checkpoint: { manifest: { sha256: manifestSha256 } },
    scenarios: {
      delayedOldAssets: 'pass',
      oldFrontendToNewBackend: 'pass',
      newFrontendToOldBackend: 'pass',
      oldServiceWorkerCache: 'pass',
      retentionWindowAfterGc: 'pass'
    },
    browser
  }
  return {
    ...unsigned,
    browserBinding: {
      schema: 'fsusblog.release-asset-browser-binding.v1',
      algorithm: 'hmac-sha256',
      keyId: `hmac-sha256:${'5'.repeat(64)}`,
      rolloutId,
      sourceReleaseId: source.releaseId,
      targetReleaseId: target.releaseId,
      browserName: browser.browser.name,
      browserVersion: browser.browser.version,
      browserExecutablePath: browser.browser.executablePath,
      browserExecutableSha256: browser.browser.executableSha256,
      scenarioSha256,
      manifestSha256,
      gcEvidenceSha256,
      payloadSha256: sha256Text(canonicalJson(unsigned)),
      signature: `hmac-sha256:${'6'.repeat(64)}`
    }
  }
}

function sha256Text(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function writeArtifacts(fixture, overrides = {}) {
  const payloads = { ...validArtifactPayloads(), ...overrides }
  const files = {}
  for (const [name, payload] of Object.entries(payloads)) {
    const file = path.join(fixture.artifactDirectory, `${name}.json`)
    writeJson(file, payload)
    files[name] = file
  }
  return files
}

function artifactArgs(files) {
  return Object.entries(files).flatMap(([name, file]) => ['--artifact', `${name}=${file}`])
}

function writeAuxiliary(fixture) {
  const files = {}
  for (const name of requiredAuxiliaryNames) {
    const file = name === 'releaseManifest'
      ? path.join(fixture.directory, 'release-manifest.json')
            : path.join(fixture.directory, 'auxiliary', `${name}.json`);
        const payload = name === 'releaseManifest'
            ? manifestPayload()
        : name === 'currentSchemaAdmission'
          ? { status: 'verified-current', candidateSourceRevision: createCurrentRolloutFixtureBinding().candidateSourceRevision,
              artifactSha256: createCurrentRolloutFixtureBinding().currentSchema.receipt.sha256,
              target: createCurrentRolloutFixtureBinding().currentSchema.target,
              database: createCurrentRolloutFixtureBinding().currentSchema.database,
              actualSchemaDigest: createCurrentRolloutFixtureBinding().currentSchema.actualSchemaDigest }
            : name === 'publicAotWarm'
        ? validPublicAotWarmEvidence()
        : name === 'challengeKindCutoverReceipt'
          ? { schemaVersion: 'fsus.security-challenge-kind-cutover-receipt.v1', accepted: true, status: 'applied', dryRun: false, releaseId: target.releaseId, slot: target.slot, generation: target.runtimeGeneration }
        : name === 'challengeKindCutoverAcceptance'
          ? { schemaVersion: 'fsus.security-challenge-kind-cutover-acceptance.v1', accepted: true, releaseId: target.releaseId, slot: target.slot, generation: target.runtimeGeneration }
        : name === 'challengeKindCutoverGate'
          ? { schema: 'fsusblog.release-challenge-kind-cutover-gate.v1', status: 'pass', rolloutId, releaseId: target.releaseId, slot: target.slot, generation: target.runtimeGeneration, lifecycle: { destructiveCutoverStarted: true, activationCommitted: false, stage: 'source-drain' }, bindings: { backendFence: true, frontend: true, staticAssets: true, cutover: true, perceptionCharacterV3: true }, errors: [] }
        : name === 'perceptionCharacterV3Cutover'
          ? { schemaVersion: 'fsus.security.perception-character-v3-cutover-receipt.v1', accepted: true, status: 'activated', dryRun: false, operationId: 'op', releaseId: target.releaseId, slot: target.slot, generation: target.runtimeGeneration }
        : name === 'operatorNote'
        ? {
            schema: 'fsusblog.release-rollout-operator-note.v1',
            rolloutId,
            provided: false,
            author: null,
            note: '',
            createdAtUtc: '2026-07-11T00:20:00.000Z',
            errors: []
          }
        : {
            schema: `fsusblog.fixture.${name}.v1`,
            status: 'pass',
            rolloutId,
            source,
            target,
            errors: []
          }
    writeJson(file, payload)
    files[name] = file
  }
  return files
}

function manifestPayload() {
  const binding = createCurrentRolloutFixtureBinding()
  return { schema: 'fsusblog.release-manifest.v3', releaseId: target.releaseId,
    imageDigest: target.imageDigest, commitSha: binding.candidateSourceRevision, currentSchema: binding.currentSchema }
}

function validPublicAotWarmEvidence() {
  const route = { pageId: 'Home', kind: 'home', routeKey: 'home', path: '/', priority: 0 }
  const settled = {
    status: 200,
    source: 'server-ssr',
    state: 'fresh',
    rendererVersion: 'renderer-release-evidence',
    frontendAssetVersion: 'frontend-release-evidence',
    releaseId: target.releaseId,
    releaseSlot: target.slot,
    canonicalUrl: 'https://blog.example.com/',
    checks: {
      title: true,
      description: true,
      canonical: true,
      robots: true,
      openGraph: true,
      twitter: true,
      jsonLd: true,
      mainContent: true
    }
  }
  return createPublicAotWarmEvidence({
    baseUrl: 'http://127.0.0.1:7568',
    scope: 'all',
    manifest: [route],
    results: [{ ...route, first: settled, settled, ok: true, firstResponseMs: 5, settledMs: 5 }],
    generatedAtUtc: '2026-07-11T00:19:00.000Z',
    expectedPublicOrigin: 'https://blog.example.com'
  })
}

function auxiliaryArgs(files) {
  return Object.entries(files).flatMap(([name, file]) => ['--auxiliary', `${name}=${file}`])
}

function runEvidence(args) {
  return spawnSync(process.execPath, [evidenceCli, ...args], {
    cwd: root,
    encoding: 'utf8'
  })
}

function shellCaptureFixture(t) {
  const data = fixture(t, 'shell-capture')
  const state = newState(data.directory)
  writeJson(state.manifestPath, manifestPayload())
  startRolloutStage(state, 'manifest-validate', '2026-07-11T00:00:00.000Z')
  writeRolloutStateAtomic(data.stateFile, state)
  const preparation = path.join(data.directory, 'shell-preparation.json')
  const result = path.join(data.directory, 'shell-result.json')
  const stdout = path.join(data.directory, 'stdout')
  const stderr = path.join(data.directory, 'stderr')
  fs.writeFileSync(stdout, 'original output\n')
  fs.writeFileSync(stderr, '')
  const prepare = (command = 'StageManifestValidate') => runEvidence([
    'prepare-stage-execution', '--state', data.stateFile, '--stage', 'manifest-validate',
    '--command-id', 'immutable-manifest', '--shell-function', command,
    '--owner', path.join(root, 'tools/deployment/release-rollout.sh'),
    '--started-at', '2026-07-11T00:00:00.000Z', '--out', preparation
  ])
  const finish = (exitCode = '0') => runEvidence([
    'finish-stage-execution', '--state', data.stateFile, '--preparation', preparation,
    '--exit-code', exitCode, '--completed-at', '2026-07-11T00:00:01.000Z',
    '--stdout', stdout, '--stderr', stderr, '--out', result
  ])
  return { ...data, state, preparation, result, stdout, stderr, prepare, finish }
}

test('original shell capture binds real preparation bytes and raw output without granting native authority', (t) => {
  const data = shellCaptureFixture(t)
  assert.equal(data.prepare().status, 0)
  assert.equal(data.finish('23').status, 0)
  const preparation = JSON.parse(fs.readFileSync(data.preparation, 'utf8'))
  const result = JSON.parse(fs.readFileSync(data.result, 'utf8'))
  assert.deepEqual(preparation.argv, ['StageManifestValidate'])
  assert.equal(result.exitCode, 23)
  assert.equal(result.qualification, 'diagnostic-only')
  assert.equal(result.observation, 'shell-command-returned')
  assert.ok(BigInt(result.monotonicCompletedNs) >= BigInt(preparation.monotonicStartedNs))
  assert.equal(result.preparation.sha256, sha256Text(fs.readFileSync(data.preparation)))
  assert.equal(result.output.stdout.sha256, sha256Text(fs.readFileSync(data.stdout)))
  assert.equal(JSON.stringify(result).includes('original output'), false)
  assert.equal('runtimeId' in result, false)
  assert.equal('cleanupVerified' in result, false)
  assert.notEqual(data.finish().status, 0)
})

test('shell capture refuses credentials, missing interruption preparation and unknown protocol fields', (t) => {
  const data = shellCaptureFixture(t)
  assert.notEqual(data.prepare('postgres://credential@example/db').status, 0)
  assert.notEqual(data.finish('130').status, 0)
  assert.equal(fs.existsSync(data.result), false)
  assert.equal(data.prepare().status, 0)
  const preparation = JSON.parse(fs.readFileSync(data.preparation, 'utf8'))
  preparation.cleanupVerified = true
  writeJson(data.preparation, preparation)
  assert.notEqual(data.finish().status, 0)
  assert.equal(fs.existsSync(data.result), false)
})

test('shell capture rejects changed manifest and stale rollout attempt rather than resealing either', (t) => {
  const data = shellCaptureFixture(t)
  assert.equal(data.prepare().status, 0)
  const original = fs.readFileSync(data.state.manifestPath)
  fs.appendFileSync(data.state.manifestPath, '\n')
  assert.notEqual(data.finish().status, 0)
  fs.writeFileSync(data.state.manifestPath, original)
  const state = JSON.parse(fs.readFileSync(data.stateFile, 'utf8'))
  state.rolloutId = 'different-rollout'
  writeJson(data.stateFile, state)
  assert.notEqual(data.finish().status, 0)
  assert.equal(fs.existsSync(data.result), false)
})

test('shell capture rejects nonregular raw output and preserves the old stage schema', (t) => {
  const data = shellCaptureFixture(t)
  assert.equal(data.prepare().status, 0)
  const descriptor = fs.openSync(data.stdout, 'r+')
  try {
    fs.ftruncateSync(descriptor, 64 * 1024 * 1024 + 1)
  } finally {
    fs.closeSync(descriptor)
  }
  assert.notEqual(data.finish().status, 0)
  assert.equal(fs.existsSync(data.result), false)
  fs.unlinkSync(data.stdout)
  fs.symlinkSync(data.stderr, data.stdout)
  assert.notEqual(data.finish().status, 0)
  assert.equal(fs.existsSync(data.result), false)
  const rollout = fs.readFileSync(path.join(root, 'tools/deployment/release-rollout.sh'), 'utf8')
  assert.match(rollout, /prepare-stage-execution/u)
  assert.match(rollout, /finish-stage-execution/u)
  assert.match(rollout, /fsusblog\.release-rollout-stage-evidence\.v2/u)
  assert.match(rollout, /\[\[ "\$exitCode" != "0" \]\] \|\| exitCode=70/u)
})

function parseStdout(result) {
  assert.notEqual(result.stdout.trim(), '', result.stderr)
  return JSON.parse(result.stdout)
}

test('stage evidence is bound to the currently running stage, ordered timestamps and immutable command output hashes', (t) => {
  const data = fixture(t, 'rollout-stage-evidence')
  const state = newState(data.directory)
  startRolloutStage(state, 'manifest-validate', '2026-07-11T00:00:00.000Z')
  writeRolloutStateAtomic(data.stateFile, state)
  const stdout = path.join(data.directory, 'stdout.log')
  const stderr = path.join(data.directory, 'stderr.log')
  const output = path.join(data.commandDirectory, 'manifest-validate.json')
  fs.writeFileSync(stdout, 'manifest ok\n')
  fs.writeFileSync(stderr, '')

  const result = runEvidence([
    'stage', '--state', data.stateFile, '--stage', 'manifest-validate', '--status', 'ok', '--exit-code', '0',
    '--command-id', 'manifest.check', '--started-at', '2026-07-11T00:00:00.000Z',
    '--completed-at', '2026-07-11T00:00:01.000Z', '--stdout', stdout, '--stderr', stderr, '--out', output
  ])
  assert.equal(result.status, 0, result.stderr)
  const report = parseStdout(result)
  assert.equal(report.stage, 'manifest-validate')
  assert.equal(report.attempt, 1)
  assert.equal(report.durationMs, 1_000)
  assert.match(report.output.stdout.sha256, /^sha256:[0-9a-f]{64}$/u)
  assert.match(report.output.stderr.sha256, /^sha256:[0-9a-f]{64}$/u)

  const wrongStage = runEvidence([
    'stage', '--state', data.stateFile, '--stage', 'capacity-preflight', '--status', 'ok', '--exit-code', '0',
    '--command-id', 'capacity.check', '--started-at', '2026-07-11T00:00:00.000Z',
    '--completed-at', '2026-07-11T00:00:01.000Z', '--stdout', stdout, '--stderr', stderr,
    '--out', path.join(data.commandDirectory, 'wrong-stage.json')
  ])
  assert.notEqual(wrongStage.status, 0)
  assert.match(wrongStage.stderr, /not executing capacity-preflight/u)

  const mutableOverwrite = runEvidence([
    'stage', '--state', data.stateFile, '--stage', 'manifest-validate', '--status', 'ok', '--exit-code', '0',
    '--command-id', 'manifest.check', '--started-at', '2026-07-11T00:00:00.000Z',
    '--completed-at', '2026-07-11T00:00:01.000Z', '--stdout', stdout, '--stderr', stderr, '--out', output
  ])
  assert.notEqual(mutableOverwrite.status, 0)
  assert.match(mutableOverwrite.stderr, /EEXIST|file already exists/u)
})

test('current admission stage captures only complete matching Server output rather than status or exit alone', (t) => {
  const data = fixture(t, 'current-stage-output')
  const state = newState(data.directory)
  for (const [index, stage] of ROLLOUT_STAGES.slice(0, 3).entries()) {
    startRolloutStage(state, stage, `2026-07-11T00:0${index}:00.000Z`)
    completeRolloutStage(state, stage, { completedAtUtc: `2026-07-11T00:0${index}:01.000Z` })
  }
  startRolloutStage(state, 'current-schema-admission', '2026-07-11T00:03:00.000Z')
  writeRolloutStateAtomic(data.stateFile, state)
  const stdout = path.join(data.directory, 'current.stdout')
  const stderr = path.join(data.directory, 'current.stderr')
  fs.writeFileSync(stderr, '')
  const valid = createCurrentRolloutAdmissionFixtureOutput()
  const cases = [null, { status: 'verified-current' }, { ...valid, status: 'pass' },
    { ...valid, candidateSourceRevision: 'a'.repeat(40) }, { ...valid, artifactSha256: 'a'.repeat(64) },
    { ...valid, database: { ...valid.database, instanceId: 'other' } },
    { ...valid, target: { ...valid.target, sourceDigest: 'a'.repeat(64) } },
    { ...valid, actualSchemaDigest: valid.target.contentDigest }, valid]
  for (const [index, value] of cases.entries()) {
    fs.writeFileSync(stdout, JSON.stringify(value))
    const out = path.join(data.commandDirectory, `current-${index}.json`)
    const result = runEvidence(['stage', '--state', data.stateFile, '--stage', 'current-schema-admission',
      '--status', 'ok', '--exit-code', '0', '--command-id', 'current-schema-readonly',
      '--started-at', '2026-07-11T00:03:00.000Z', '--completed-at', '2026-07-11T00:03:01.000Z',
      '--stdout', stdout, '--stderr', stderr, '--out', out])
    if (index === cases.length - 1) {
      assert.equal(result.status, 0, result.stderr)
      assert.equal(parseStdout(result).output.stdout.sha256, `sha256:${crypto.createHash('sha256').update(fs.readFileSync(stdout)).digest('hex')}`)
    } else {
      assert.notEqual(result.status, 0)
      assert.equal(fs.existsSync(out), false)
      assert.match(result.stderr, /current-schema-admission/u)
    }
  }
})

test('preseal rejects current auxiliary binding drift while all original six artifacts remain valid', (t) => {
  const data = fixture(t, 'current-preseal-binding')
  advanceState(data)
  const artifacts = writeArtifacts(data)
  const auxiliary = writeAuxiliary(data)
  const original = JSON.parse(fs.readFileSync(auxiliary.currentSchemaAdmission, 'utf8'))
  for (const [index, value] of [{ ...original, candidateSourceRevision: 'a'.repeat(40) },
    { ...original, database: { ...original.database, databaseId: 'other' } },
    { ...original, target: { ...original.target, contentDigest: 'a'.repeat(64) } }, original].entries()) {
    writeJson(auxiliary.currentSchemaAdmission, value)
    const result = runEvidence(['preseal', '--state', data.stateFile, '--out', path.join(data.directory, `preseal-${index}.json`),
      ...artifactArgs(artifacts), ...auxiliaryArgs(auxiliary)])
    if (index === 3) assert.equal(result.status, 0, result.stderr || result.stdout)
    else {
      assert.notEqual(result.status, 0)
      assert.match(parseStdout(result).errors.join('\n'), /currentSchemaAdmission/u)
    }
  }
})

test('preseal is stage-ordered and reports every missing and semantic artifact error in one run', (t) => {
  const data = fixture(t, 'rollout-preseal-errors')
  const earlyState = newState(data.directory)
  startRolloutStage(earlyState, 'manifest-validate', '2026-07-11T00:00:00.000Z')
  writeRolloutStateAtomic(data.stateFile, earlyState)
  const out = path.join(data.directory, 'preseal.json')
  const early = runEvidence(['preseal', '--state', data.stateFile, '--out', out])
  assert.notEqual(early.status, 0)
  assert.match(early.stderr, /only while the final release-evidence stage is running/u)

  advanceState(data)
  const auxiliary = writeAuxiliary(data)
  const broken = writeArtifacts(data, {
    publicTraffic: {
      schema: 'fsusblog.release-traffic-evidence.v1',
      status: 'fail',
      rolloutId,
      deploymentFailureCount: 3,
      connectionErrorCount: 2,
      unhandled5xxCount: 1,
      inFlightAbortedCount: 4,
      totalRequests: 0,
      releaseDistribution: { target: 0 }
    },
    resourceBudget: {
      schema: 'fsusblog.release-resource-budget-evidence.v1',
      status: 'fail',
      rolloutId,
      withinBudget: false,
      minimumSupported: {},
      checks: { dualSlotCpu: false, drain: false }
    }
  })
  for (const name of ['notificationStream', 'assetCompatibility', 'workerReconciliation', 'faultInjection']) {
    fs.rmSync(broken[name])
    delete broken[name]
  }
  const failed = runEvidence([
    'preseal', '--state', data.stateFile, '--out', out, '--replace',
    ...artifactArgs(broken), ...auxiliaryArgs(auxiliary)
  ])
  assert.notEqual(failed.status, 0)
  const report = parseStdout(failed)
  assert.equal(report.status, 'fail')
  for (const name of ['notificationStream', 'assetCompatibility', 'workerReconciliation', 'faultInjection']) {
    assert.ok(report.errors.includes(`required artifact is missing: ${name}`), name)
  }
  for (const message of [
    'publicTraffic: status is not successful',
    'publicTraffic: deploymentFailureCount must be zero',
    'publicTraffic: connectionErrorCount must be zero',
    'publicTraffic: unhandled5xxCount must be zero',
    'publicTraffic: inFlightAbortedCount must be zero',
    'publicTraffic: totalRequests must be positive',
    'publicTraffic: target release was not observed',
    'resourceBudget: status is not successful',
    'resourceBudget: rollout exceeded resource budget',
    'resourceBudget: minimum supported hardware is missing',
    'resourceBudget: one or more resource checks did not pass'
  ]) assert.ok(report.errors.includes(message), message)
  assert.ok(report.errors.length >= 15)
})

test('finalize seals stages, six semantic artifacts and the exact auxiliary evidence set; verify rejects every post-seal drift', (t) => {
  const data = fixture(t, 'rollout-final-evidence')
  advanceState(data, { includeFinalStage: true })
  const artifacts = writeArtifacts(data)
  const auxiliary = writeAuxiliary(data)
  const finalFile = path.join(data.directory, 'release-rollout.json')

  const finalized = runEvidence([
    'finalize', '--state', data.stateFile, '--out', finalFile,
    ...artifactArgs(artifacts), ...auxiliaryArgs(auxiliary)
  ])
  assert.equal(finalized.status, 0, finalized.stderr)
  const report = parseStdout(finalized)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.stages.map(item => item.stage), ROLLOUT_STAGES)
  assert.deepEqual(Object.keys(report.artifacts), requiredArtifactNames)
  assert.deepEqual(Object.keys(report.auxiliary), requiredAuxiliaryNames)
  assert.equal(report.stages.every(item => /^sha256:[0-9a-f]{64}$/u.test(item.evidence.sha256)), true)
  assert.equal(Object.values(report.artifacts).every(item => /^sha256:[0-9a-f]{64}$/u.test(item.sha256)), true)
  assert.equal(Object.values(report.auxiliary).every(item => /^sha256:[0-9a-f]{64}$/u.test(item.sha256)), true)
  assert.deepEqual(report.errors, [])

  const verified = runEvidence(['verify', '--evidence', finalFile])
  assert.equal(verified.status, 0, verified.stderr)
  assert.equal(parseStdout(verified).status, 'pass')

  const reseal = runEvidence([
    'finalize', '--state', data.stateFile, '--out', finalFile,
    ...artifactArgs(artifacts), ...auxiliaryArgs(auxiliary)
  ])
  assert.notEqual(reseal.status, 0)
  assert.match(reseal.stderr, /EEXIST|file already exists/u)

  const stageFile = report.stages[0].evidence.path
  const originalStage = fs.readFileSync(stageFile)
  fs.appendFileSync(stageFile, 'tampered\n')
  const stageDrift = runEvidence(['verify', '--evidence', finalFile])
  assert.notEqual(stageDrift.status, 0)
  assert.match(parseStdout(stageDrift).errors.join('\n'), /stage|changed after seal|manifest-validate/u)
  fs.writeFileSync(stageFile, originalStage)

  const originalArtifact = fs.readFileSync(artifacts.publicTraffic)
  fs.appendFileSync(artifacts.publicTraffic, 'tampered\n')
  const artifactDrift = runEvidence(['verify', '--evidence', finalFile])
  assert.notEqual(artifactDrift.status, 0)
  assert.match(parseStdout(artifactDrift).errors.join('\n'), /artifact changed after seal: publicTraffic/u)

  fs.writeFileSync(artifacts.publicTraffic, originalArtifact)
  fs.appendFileSync(auxiliary.operatorNote, 'tampered\n')
  const auxiliaryDrift = runEvidence(['verify', '--evidence', finalFile])
  assert.notEqual(auxiliaryDrift.status, 0)
  assert.match(parseStdout(auxiliaryDrift).errors.join('\n'), /auxiliary evidence changed after seal: operatorNote/u)
})
