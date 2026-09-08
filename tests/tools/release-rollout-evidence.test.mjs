import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { ROLLOUT_STAGES, startRolloutStage, writeRolloutStateAtomic } from '../../tools/deployment/release-rollout-lib.mjs'
import { verifyReleaseRolloutEvidence } from '../../tools/deployment/release-rollout-evidence-receipt-contract.mjs'
import { createReleaseRolloutEvidenceFixture } from './support/release-rollout-evidence-fixture.mjs'

const { fixture, newState, writeJson, advanceState, writeArtifacts, writeAuxiliary, artifactArgs, auxiliaryArgs, runEvidence, parseStdout, requiredArtifactNames, requiredAuxiliaryNames, rolloutId, source, target } = createReleaseRolloutEvidenceFixture()

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

  const snapshots = new Map()
  const capture = (file) => {
    const bytes = fs.readFileSync(file)
    snapshots.set(file, bytes)
    return bytes
  }
  const verificationOptions = { evidencePath: finalFile, now: Date.now(), readBytes: capture }
  assert.deepEqual(verifyReleaseRolloutEvidence(report, verificationOptions), parseStdout(verified))
  const pureVerify = (candidate, files = snapshots) => verifyReleaseRolloutEvidence(candidate, {
    ...verificationOptions,
    readBytes: (file) => {
      assert.ok(files.has(file), `unprovided explicit receipt bytes: ${file}`)
      return files.get(file)
    }
  })
  assert.deepEqual(pureVerify(report), parseStdout(verified))
  const mutateBoundArtifact = (name, mutate) => {
    const candidate = structuredClone(report)
    const metadata = candidate.artifacts[name]
    const value = JSON.parse(snapshots.get(metadata.path))
    mutate(value)
    const bytes = Buffer.from(JSON.stringify(value))
    metadata.bytes = bytes.length
    metadata.sha256 = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
    const files = new Map(snapshots).set(metadata.path, bytes)
    const result = pureVerify(candidate, files)
    assert.equal(result.status, 'fail')
    return result.errors.join('\n')
  }
  assert.match(mutateBoundArtifact('publicTraffic', value => { value.totalRequests = 0 }), /totalRequests must be positive/u)
  assert.match(mutateBoundArtifact('assetCompatibility', value => { value.browser.afterSwitch.status = 'fail' }), /cross-switch compatibility/u)
  assert.match(mutateBoundArtifact('notificationStream', value => { value.cursorReplayVerified = false }), /restart\/replay\/full-resync/u)
  assert.match(mutateBoundArtifact('workerReconciliation', value => { value.mode = 'forced' }), /normal-mode/u)
  assert.match(mutateBoundArtifact('resourceBudget', value => { value.withinBudget = false }), /exceeded resource budget/u)
  assert.match(mutateBoundArtifact('faultInjection', value => { value.cases = [] }), /automated case missing/u)
  const missing = new Map(snapshots)
  missing.delete(report.stages[0].evidence.path)
  assert.equal(pureVerify(report, missing).status, 'fail')

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
