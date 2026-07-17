import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const summaryScript = path.join(root, 'tools/ci/summarize-quality-gate.mjs')

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

test('production summary emits the explicit browserless correctness tier and reproduction command', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-issue-1150-summary-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))

  const fixtureScript = path.join(fixtureRoot, 'tools/ci/summarize-quality-gate.mjs')
  fs.mkdirSync(path.dirname(fixtureScript), { recursive: true })
  fs.copyFileSync(summaryScript, fixtureScript)
  write(path.join(fixtureRoot, '.github/workflows/quality-gate.yml'), `jobs:\n  frontend-static-governance:\n    runs-on: ubuntu-latest\n`)
  write(path.join(fixtureRoot, 'tools/operations/check-release-evidence-manifest.mjs'), `process.exit(0)\n`)
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
      QUALITY_GATE_NEEDS_JSON: '{}',
      GITHUB_STEP_SUMMARY: path.join(fixtureRoot, '.tmp/step-summary.md')
    }
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const summary = JSON.parse(fs.readFileSync(
    path.join(fixtureRoot, '.tmp/release-evidence/jobs/production-summary.json'),
    'utf8'
  ))
  assert.deepEqual(summary.tierIds, ['production-correctness'])
  assert.equal(summary.localReproduction, './tools/test.sh production-correctness --plan-only')
  assert.doesNotMatch(summary.localReproduction, /ci-production/u)
})
