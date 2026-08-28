import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
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

const fixtureCoverage = {
  'Example.dll': {
    '/workspace/FsusBlog/src/backend/Example.cs': {
      'Example.Subject': {
        'System.Void Example.Subject::Run()': {
          Lines: { 1: 1 },
          Branches: [{ Line: 1, Offset: 0, EndOffset: 1, Path: 0, Ordinal: 0, Hits: 1 }]
        }
      }
    }
  }
}

async function writeReport(directory) {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'coverage.json'), `${JSON.stringify(fixtureCoverage)}\n`)
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-backend-coverage-layout-'))
  const coverageRoot = path.join(root, 'coverage')
  for (const lane of lanes) {
    const laneDirectory = path.join(coverageRoot, 'backend', lane)
    await writeReport(path.join(laneDirectory, 'collector-primary'))
    const prepared = spawnSync(process.execPath, [
      path.join(repoRoot, 'tools/coverage/backend-coverage-pipeline.mjs'),
      'prepare',
      '--dir', laneDirectory,
      '--shard', lane
    ], { cwd: repoRoot, encoding: 'utf8' })
    assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout)
  }

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
          FSUSBLOG_COVERAGE_SKIP_TESTS: '1'
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
  await writeReport(serializedCopy)

  const result = subject.run()

  assert.equal(result.status, 0, result.stderr || result.stdout)
  await assert.rejects(stat(path.dirname(path.dirname(serializedCopy))), { code: 'ENOENT' })
})

test('collector discards the current host timestamp VSTest attachment layout', async (t) => {
  const subject = await fixture()
  t.after(() => rm(subject.root, { recursive: true, force: true }))
  const serializedCopy = path.join(
    subject.coverageRoot,
    'backend',
    'ordinary',
    '_build-agent_2026-08-27_00_00_00',
    'In',
    'build-agent'
  )
  await writeReport(serializedCopy)

  const result = subject.run()

  assert.equal(result.status, 0, result.stderr || result.stdout)
  await assert.rejects(stat(path.dirname(path.dirname(serializedCopy))), { code: 'ENOENT' })
})

test('collector still rejects two independent collector result directories', async (t) => {
  const subject = await fixture()
  t.after(() => rm(subject.root, { recursive: true, force: true }))
  await writeReport(path.join(subject.coverageRoot, 'backend', 'ordinary', 'collector-secondary'))

  const result = subject.run()

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ordinary must contain exactly one canonical coverage\.json; found 2/u)
})
