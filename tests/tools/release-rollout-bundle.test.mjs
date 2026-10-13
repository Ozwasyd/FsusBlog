import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ROLLOUT_STAGES } from '../../tools/deployment/release-rollout-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const collector = path.join(root, 'tools/operations/collect-release-rollout-bundle.mjs')
const artifactNames = [
  'publicTraffic',
  'notificationStream',
  'assetCompatibility',
  'workerReconciliation',
  'resourceBudget',
  'faultInjection'
];
const auxiliaryNames = [
    'releaseManifest', 'backupRestoreGate', 'currentSchemaAdmission', 'candidateReadiness',
    'assetMaterialization', 'retentionPrepared', 'retainedAssets', 'publicAotWarm', 'candidateSmoke',
    'compatibilityMatrix', 'gatewayTransition', 'activeFenceAcquire',
    'activeFenceSourceRevoke', 'activeFenceVerify', 'challengeKindCutoverReceipt',
    'challengeKindCutoverAcceptance', 'challengeKindCutoverGate', 'perceptionCharacterV3Cutover',
    'publicTrafficCheckpoint',
    'sourceDrainSnapshot', 'sourceDrainGate', 'targetHealth',
    'retentionDrainComplete', 'operatorNote'
];

function sha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
}

function metadata(file) {
  const stat = fs.statSync(file)
  return { path: path.resolve(file), bytes: stat.size, sha256: sha256(file) }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function createBundleFixture(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const evidenceRoot = path.join(directory, 'evidence')
  const stageDirectory = path.join(evidenceRoot, 'commands')
  const recoveryDirectory = path.join(evidenceRoot, 'recoveries')
  const artifactDirectory = path.join(evidenceRoot, 'artifacts')
  const stages = ROLLOUT_STAGES.map((stage, index) => {
    const file = path.join(stageDirectory, `${String(index).padStart(2, '0')}-${stage}.json`)
    writeJson(file, {
      schema: 'fsusblog.release-rollout-stage-evidence.v2',
      rolloutId: 'deploy-20260711-bundle',
      stage,
      status: 'ok'
    })
    return { stage, attempts: 1, evidence: metadata(file) }
  })
  const recoveryFile = path.join(recoveryDirectory, 'candidate-cleanup.json')
  writeJson(recoveryFile, {
    schema: 'fsusblog.release-rollout-recovery-evidence.v1',
    rolloutId: 'deploy-20260711-bundle',
    action: 'preserve-source-stop-candidate',
    status: 'ok'
  })
  const recoveries = [{
    action: 'preserve-source-stop-candidate',
    failedStage: 'candidate-start',
    status: 'ok',
    evidencePath: recoveryFile,
    evidence: metadata(recoveryFile)
  }]
  const artifacts = {}
  for (const name of artifactNames) {
    const file = path.join(artifactDirectory, `${name}.json`)
    writeJson(file, {
      schema: `fsusblog.fixture.${name}.v1`,
      rolloutId: 'deploy-20260711-bundle',
      status: 'pass'
    })
    artifacts[name] = metadata(file)
  }
  const auxiliary = {}
  for (const name of auxiliaryNames) {
    const file = path.join(evidenceRoot, 'auxiliary-source', `${name}.json`)
    writeJson(file, name === 'operatorNote'
      ? {
          schema: 'fsusblog.release-rollout-operator-note.v1',
          rolloutId: 'deploy-20260711-bundle',
          provided: false,
          note: '',
          errors: []
        }
      : {
          schema: `fsusblog.fixture.${name}.v1`,
          rolloutId: 'deploy-20260711-bundle',
          status: 'pass',
          errors: []
        })
    auxiliary[name] = metadata(file)
  }
  const finalFile = path.join(evidenceRoot, 'release-rollout.json')
  const final = {
    schema: 'fsusblog.release-rollout-evidence.v2',
    status: 'pass',
    rolloutId: 'deploy-20260711-bundle',
    stages,
    recoveries,
    artifacts,
    auxiliary,
    errors: []
  }
  writeJson(finalFile, final)
  const unrelated = path.join(evidenceRoot, 'operator-notes.txt')
  fs.writeFileSync(unrelated, 'must not enter the immutable release bundle\n')
  return { directory, evidenceRoot, finalFile, final, stages, recoveries, artifacts, auxiliary, unrelated }
}

function persistFinal(data) {
  writeJson(data.finalFile, data.final)
}

function runCollector(data, suffix) {
  const output = path.join(data.directory, `bundle-${suffix}`)
  const result = spawnSync(process.execPath, [
    collector, '--input', data.finalFile, '--output', output
  ], { cwd: root, encoding: 'utf8' })
  return { result, output }
}

function allFiles(directory) {
  const files = []
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) visit(target)
      else files.push(path.relative(directory, target))
    }
  }
  visit(directory)
  return files.sort()
}

test('collector copies final, ordered stages, recoveries, six artifacts and exact hash-bound auxiliary evidence', (t) => {
  const data = createBundleFixture(t, 'rollout-bundle')
  const { result, output } = runCollector(data, 'ok')
  assert.equal(result.status, 0, result.stderr)
  const index = JSON.parse(result.stdout)
  assert.equal(index.schema, 'fsusblog.release-rollout-collected-bundle.v1')
  assert.equal(index.status, 'ok')
  assert.equal(index.rolloutId, data.final.rolloutId)
  assert.equal(index.fileCount, 1 + ROLLOUT_STAGES.length + 1 + artifactNames.length + auxiliaryNames.length)
  assert.match(index.sourceEvidenceSha256, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(index.files.every(file => /^sha256:[0-9a-f]{64}$/u.test(file.sha256)), true)
  assert.equal(index.files.every(file => fs.statSync(path.join(output, file.path)).isFile()), true)

  const files = allFiles(output)
  assert.ok(files.includes('release-rollout.json'))
  assert.ok(files.includes('bundle-index.json'))
  for (const stage of ROLLOUT_STAGES) {
    assert.equal(files.some(file => file.startsWith('commands/') && file.endsWith(`-${stage}.json`)), true, stage)
  }
  for (const name of artifactNames) {
    assert.equal(files.includes(`artifacts/${name}/${name}.json`), true, name)
  }
  for (const name of auxiliaryNames) {
    assert.equal(files.includes(`auxiliary/${name}/${name}.json`), true, name)
  }
  assert.equal(files.some(file => file.includes('operator-notes')), false)
  assert.equal(files.length, index.fileCount + 1)
})

test('collector rejects stage symlinks, path escape and hash drift instead of following mutable evidence', async (t) => {
  await t.test('symlink', (subtest) => {
    const data = createBundleFixture(subtest, 'rollout-bundle-symlink')
    const stage = data.final.stages[0]
    const original = `${stage.evidence.path}.original`
    fs.renameSync(stage.evidence.path, original)
    fs.symlinkSync(original, stage.evidence.path)
    const { result } = runCollector(data, 'symlink')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /regular non-symlink file/u)
  })

  await t.test('path escape', (subtest) => {
    const data = createBundleFixture(subtest, 'rollout-bundle-escape')
    const outside = path.join(data.directory, 'outside-stage.json')
    writeJson(outside, { status: 'ok' })
    data.final.stages[0].evidence = metadata(outside)
    persistFinal(data)
    const { result } = runCollector(data, 'escape')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /escapes rollout evidence root/u)
  })

  await t.test('hash drift', (subtest) => {
    const data = createBundleFixture(subtest, 'rollout-bundle-stage-drift')
    fs.appendFileSync(data.final.stages[0].evidence.path, 'post-seal mutation\n')
    const { result } = runCollector(data, 'stage-drift')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /hash\/size changed after seal/u)
  })
})

test('collector rejects artifact symlinks and drift even when the artifact path is externally supplied', async (t) => {
  await t.test('artifact symlink', (subtest) => {
    const data = createBundleFixture(subtest, 'rollout-bundle-artifact-symlink')
    const artifact = data.final.artifacts.publicTraffic
    const original = `${artifact.path}.original`
    fs.renameSync(artifact.path, original)
    fs.symlinkSync(original, artifact.path)
    const { result } = runCollector(data, 'artifact-symlink')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /regular non-symlink file/u)
  })

  await t.test('artifact drift', (subtest) => {
    const data = createBundleFixture(subtest, 'rollout-bundle-artifact-drift')
    fs.appendFileSync(data.final.artifacts.publicTraffic.path, 'post-seal mutation\n')
    const { result } = runCollector(data, 'artifact-drift')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /hash\/size changed after seal/u)
  })

  await t.test('auxiliary drift', (subtest) => {
    const data = createBundleFixture(subtest, 'rollout-bundle-auxiliary-drift')
    fs.appendFileSync(data.final.auxiliary.operatorNote.path, 'post-seal mutation\n')
    const { result } = runCollector(data, 'auxiliary-drift')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /auxiliary operatorNote hash\/size changed after seal/u)
  })
})

test('collector rejects recovery drift and unrecognized artifact names rather than copying unsealed extras', async (t) => {
  await t.test('recovery drift', (subtest) => {
    const data = createBundleFixture(subtest, 'rollout-bundle-recovery-drift')
    fs.appendFileSync(data.final.recoveries[0].evidencePath, 'post-seal mutation\n')
    const { result } = runCollector(data, 'recovery-drift')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /recovery.*hash\/size changed after seal|recovery.*changed after seal/u)
  })

  await t.test('extra artifact', (subtest) => {
    const data = createBundleFixture(subtest, 'rollout-bundle-extra')
    const extra = path.join(data.evidenceRoot, 'operator-extra.json')
    writeJson(extra, { status: 'ok' })
    data.final.artifacts.operatorNotes = metadata(extra)
    persistFinal(data)
    const { result, output } = runCollector(data, 'extra')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unrecognized|unexpected|exactly six|exact artifact set|operatorNotes/u)
    if (fs.existsSync(output)) {
      assert.equal(allFiles(output).some(file => file.includes('operatorNotes')), false)
    }
  })
})
