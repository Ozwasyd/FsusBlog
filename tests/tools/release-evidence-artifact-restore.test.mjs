import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const restoreScript = path.join(root, 'tools/operations/restore-downloaded-artifacts.sh')

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${value}\n`)
}

test('release evidence restores both stripped-.tmp and mixed-root artifact layouts', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-artifact-restore-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
  const downloadedRoot = path.join(fixtureRoot, 'downloaded')
  const restoredTmpRoot = path.join(fixtureRoot, 'restored-tmp')

  write(path.join(downloadedRoot, 'stripped/frontend/stripped.txt'), 'stripped')
  write(path.join(downloadedRoot, 'mixed/.tmp/frontend/mixed.txt'), 'mixed')
  write(path.join(downloadedRoot, 'stripped/release-evidence/jobs/stripped.json'), 'stripped-job')
  write(path.join(downloadedRoot, 'mixed/.tmp/release-evidence/jobs/mixed.json'), 'mixed-job')
  write(path.join(downloadedRoot, 'legacy/jobs/legacy.json'), 'legacy-job')

  const result = spawnSync('bash', [restoreScript, downloadedRoot, restoredTmpRoot], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readFileSync(path.join(restoredTmpRoot, 'frontend/stripped.txt'), 'utf8').trim(), 'stripped')
  assert.equal(fs.readFileSync(path.join(restoredTmpRoot, 'frontend/mixed.txt'), 'utf8').trim(), 'mixed')
  assert.equal(fs.readFileSync(path.join(restoredTmpRoot, 'release-evidence/jobs/stripped.json'), 'utf8').trim(), 'stripped-job')
  assert.equal(fs.readFileSync(path.join(restoredTmpRoot, 'release-evidence/jobs/mixed.json'), 'utf8').trim(), 'mixed-job')
  assert.equal(fs.readFileSync(path.join(restoredTmpRoot, 'release-evidence/jobs/legacy.json'), 'utf8').trim(), 'legacy-job')
})
