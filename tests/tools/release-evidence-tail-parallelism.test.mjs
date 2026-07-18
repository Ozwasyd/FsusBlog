import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const relativeScript = 'tools/test/lanes/release-evidence.sh'
const script = path.join(root, relativeScript)

test('release evidence tail preserves dependencies while parallelizing independent checks', () => {
  const source = fs.readFileSync(script, 'utf8')
  const planChain = source.indexOf('PrepareEvidencePlanAndCheckJobs()')
  const plan = source.indexOf('run-matrix-governance-once.sh" release-evidence-plan', planChain)
  const jobs = source.indexOf('CheckJobSummaries', plan)
  const precollect = source.indexOf('RunCollectParallel release-evidence-precollect')
  const collect = source.indexOf('RunCollect collect-evidence')
  const postcollect = source.indexOf('RunCollectParallel release-evidence-postcollect')
  const finish = source.indexOf('FinishCollect')

  assert.ok(planChain >= 0 && planChain < precollect)
  assert.ok(plan >= 0 && plan < jobs)
  assert.ok(precollect < collect)
  assert.ok(collect < postcollect)
  assert.ok(postcollect < finish)
  assert.doesNotMatch(source, /run-test-matrix\.mjs[\s\S]{0,200}evidence-plan --out/u)
  for (const token of [
    'plan-and-job-summaries PrepareEvidencePlanAndCheckJobs',
    'flaky-evidence CheckFlakyEvidence',
    'artifact-slimness CheckArtifactSlimness',
    'evidence-metrics CheckEvidenceMetrics',
    'evidence-manifest CheckEvidenceManifest'
  ]) assert.ok(source.includes(token), `missing release evidence job: ${token}`)
  assert.doesNotMatch(source, /MAX_(?:ERRORS|FAILURES)|max[_-](?:errors|failures)/iu)
})

test('release evidence lane remains valid shell after its rolling parallel DAG change', () => {
  const result = spawnSync('bash', ['-n', script], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
