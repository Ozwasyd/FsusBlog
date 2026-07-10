import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const collector = path.join(repoRoot, 'tools/coverage/collect-backend-coverage.sh')
const lanes = [
  'ordinary',
  'special-api-integration',
  'special-auth-state-machine',
  'special-concurrency',
  'special-property',
  'special-golden'
]

async function writeReportPair(directory) {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'coverage.cobertura.xml'), '<coverage />\n')
  await writeFile(path.join(directory, 'coverage.json'), '{}\n')
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-backend-coverage-layout-'))
  const coverageRoot = path.join(root, 'coverage')
  for (const lane of lanes) {
    await writeReportPair(path.join(coverageRoot, 'backend', lane, 'collector-primary'))
  }

  const fakeNode = path.join(root, 'fake-node.sh')
  await writeFile(fakeNode, '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'{"schema":"fixture"}\\n\' > "$3"\n')
  await chmod(fakeNode, 0o755)

  return {
    root,
    coverageRoot,
    run() {
      return spawnSync('bash', [collector], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          FSUSBLOG_COVERAGE_ROOT: coverageRoot,
          FSUSBLOG_BACKEND_TRX_DIR: path.join(root, 'trx'),
          FSUSBLOG_COVERAGE_SKIP_TESTS: '1',
          FSUSBLOG_NODE: fakeNode
        }
      })
    }
  }
}

test('collector discards VSTest serialized attachment copies before exact lane validation', async (t) => {
  const subject = await fixture()
  t.after(() => rm(subject.root, { recursive: true, force: true }))
  const serializedCopy = path.join(
    subject.coverageRoot,
    'backend',
    'ordinary',
    '_ser012345_2026-07-10_21_33_46',
    'In',
    'ser012345'
  )
  await writeReportPair(serializedCopy)

  const result = subject.run()

  assert.equal(result.status, 0, result.stderr || result.stdout)
  await assert.rejects(stat(path.dirname(path.dirname(serializedCopy))), { code: 'ENOENT' })
})

test('collector still rejects two independent collector result directories', async (t) => {
  const subject = await fixture()
  t.after(() => rm(subject.root, { recursive: true, force: true }))
  await writeReportPair(path.join(subject.coverageRoot, 'backend', 'ordinary', 'collector-secondary'))

  const result = subject.run()

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ordinary must contain exactly one Cobertura and one Coverlet JSON report \(got cobertura=2 json=2\)/u)
})
