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
  const planChain = source.indexOf('prepare_evidence_plan_and_check_jobs()')
  const plan = source.indexOf('evidence-plan --out', planChain)
  const jobs = source.indexOf('check_job_summaries', plan)
  const precollect = source.indexOf('run_collect_parallel release-evidence-precollect')
  const collect = source.indexOf('run_collect collect-evidence')
  const postcollect = source.indexOf('run_collect_parallel release-evidence-postcollect')
  const finish = source.indexOf('finish_collect')

  assert.ok(planChain >= 0 && planChain < precollect)
  assert.ok(plan >= 0 && plan < jobs)
  assert.ok(precollect < collect)
  assert.ok(collect < postcollect)
  assert.ok(postcollect < finish)
  for (const token of [
    'plan-and-job-summaries prepare_evidence_plan_and_check_jobs',
    'flaky-evidence check_flaky_evidence',
    'artifact-slimness check_artifact_slimness',
    'evidence-metrics check_evidence_metrics',
    'evidence-manifest check_evidence_manifest'
  ]) assert.ok(source.includes(token), `missing release evidence job: ${token}`)
  assert.doesNotMatch(source, /MAX_(?:ERRORS|FAILURES)|max[_-](?:errors|failures)/iu)
})

test('release evidence lane remains valid shell after its rolling parallel DAG change', () => {
  const result = spawnSync('bash', ['-n', script], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
