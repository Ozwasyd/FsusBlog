import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const summaryScript = path.join(root, 'tools/ci/summarize-quality-gate.mjs')
const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
const buildReceiptDigest = `sha256:${'c'.repeat(64)}`

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

test('production summary emits the explicit browserless correctness tier and reproduction command', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-issue-1150-summary-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))

  const fixtureScript = path.join(fixtureRoot, 'tools/ci/summarize-quality-gate.mjs')
  fs.mkdirSync(path.dirname(fixtureScript), { recursive: true })
  fs.copyFileSync(summaryScript, fixtureScript)
  write(path.join(fixtureRoot, '.github/workflows/quality-gate.yml'), `jobs:\n  frontend-static-governance:\n    runs-on: ubuntu-latest\n`)
  write(path.join(fixtureRoot, 'tools/operations/check-release-evidence-manifest.mjs'), `process.exit(0)\n`)
  write(path.join(fixtureRoot, 'tools/release/test-evidence-receipts-cli.mjs'), `
import fs from 'node:fs'
import path from 'node:path'
const output = path.resolve('.tmp/release-evidence/browserless-correctness-receipt.json')
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, '{}\\n')
`)
  const plan = {
    schema: 'fsusblog.pr-smart-gate.v1',
    generatedAt: '2026-07-18T00:00:00.000Z',
    sourceState,
    runId: '42',
    runAttempt: '1',
    selectedTierIds: ['production-correctness'],
    skippedTierIds: [],
    selectedJobIds: ['frontend-static-governance'],
    skippedJobIds: [],
    summaryAuthorityJobIds: ['frontend-static-governance'],
    contentDigest: null
  }
  const { contentDigest: _ignored, ...planContent } = plan
  plan.contentDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(planContent))).digest('hex')}`
  write(path.join(fixtureRoot, '.tmp/pr-plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
  write(path.join(fixtureRoot, '.tmp/release-evidence/manifest.json'), `${JSON.stringify({
    status: 'collected-ok',
    evidenceSummary: {
      externalExposure: {
        blockers: [],
        request: { blockerSources: [] }
      }
    }
  })}\n`)

  const result = spawnSync(process.execPath, [fixtureScript], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      QUALITY_GATE_NEEDS_JSON: JSON.stringify({ 'frontend-static-governance': { result: 'success' } }),
      GITHUB_STEP_SUMMARY: path.join(fixtureRoot, '.tmp/step-summary.md'),
      GITHUB_SHA: sourceState.commit,
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1',
      FSUSBLOG_CI_PR_PLAN_DIGEST: plan.contentDigest,
      FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
      FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: buildReceiptDigest
    }
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const summary = JSON.parse(fs.readFileSync(
    path.join(fixtureRoot, '.tmp/release-evidence/jobs/production-summary.json'),
    'utf8'
  ))
  assert.deepEqual(summary.tierIds, ['production-correctness'])
  assert.equal(summary.localReproduction, './tools/test.sh production-correctness --plan-only')
  assert.match(summary.contentDigest, /^sha256:[a-f0-9]{64}$/u)
  assert.doesNotMatch(summary.localReproduction, /ci-production/u)
})
