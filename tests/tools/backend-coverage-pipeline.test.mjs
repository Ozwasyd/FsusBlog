import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  mergeCoverageUniverse,
  normalizeCoverageSourcePath,
  prepareCoverageShard,
  writeCoverageUniverse
} from '../../tools/coverage/backend-coverage-pipeline.mjs'

const binding = {
  runId: 'coverage-test-run',
  sourceCommit: '0123456789abcdef',
  sourceFingerprint: 'fingerprint-0123456789abcdef'
}

function rawCoverage({
  module = 'Example.dll',
  source = '/agent/_work/FsusBlog/FsusBlog/src/backend/Example.cs',
  firstHits = 0,
  secondHits = 0,
  firstBranchHits = [0, 0],
  secondBranchHits = [0, 0]
} = {}) {
  const branches = (line, values) => values.map((hits, index) => ({
    Line: line,
    Offset: line * 10,
    EndOffset: line * 10 + 5,
    Path: index,
    Ordinal: (line - 1) * 2 + index,
    Hits: hits
  }))
  return {
    [module]: {
      [source]: {
        'Example.Subject': {
          'System.Void Example.Subject::Run()': {
            Lines: { 10: firstHits, 20: secondHits },
            Branches: [
              ...branches(10, firstBranchHits),
              ...branches(20, secondBranchHits)
            ]
          }
        }
      }
    }
  }
}

async function writeRaw(directory, payload) {
  const result = path.join(directory, 'collector-primary')
  await mkdir(result, { recursive: true })
  await writeFile(path.join(result, 'coverage.json'), `${JSON.stringify(payload, null, 2)}\n`)
  return result
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-backend-coverage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const shards = path.join(root, 'shards')
  const coverageRoot = path.join(root, 'coverage')
  const output = path.join(coverageRoot, 'backend-merged')
  const universe = path.join(root, 'universe.json')
  await mkdir(shards)
  return { root, shards, coverageRoot, output, universe }
}

async function preparedShard(subject, id, payload, shardBinding = binding) {
  const directory = path.join(subject.shards, id)
  await writeRaw(directory, payload)
  prepareCoverageShard({ directory, shardId: id, binding: shardBinding })
  return { id, directory }
}

test('Coverlet JSON normalization preserves repository-relative source identity', () => {
  assert.equal(
    normalizeCoverageSourcePath('C:\\agent\\_work\\FsusBlog\\FsusBlog\\src\\backend\\Example.cs'),
    'src/backend/Example.cs'
  )
})

test('canonical raw shards merge line, branch, method, module, and file identity before one exchange conversion', async (t) => {
  const subject = await fixture(t)
  const shards = [
    await preparedShard(subject, 'ordinary', rawCoverage({
      firstHits: 1,
      firstBranchHits: [1, 0]
    })),
    await preparedShard(subject, 'special-api', rawCoverage({
      secondHits: 1,
      firstBranchHits: [0, 1],
      secondBranchHits: [1, 1]
    }))
  ]
  writeCoverageUniverse({ file: subject.universe, shards, binding })

  const { summary, evidence } = mergeCoverageUniverse({
    universeFile: subject.universe,
    outDirectory: subject.output
  })

  assert.deepEqual(summary.totals, {
    lines: { covered: 2, total: 2 },
    branches: { covered: 4, total: 4 },
    methods: { covered: 1, total: 1 }
  })
  assert.deepEqual(summary.summary, {
    linecoverage: 100,
    branchcoverage: 100,
    methodcoverage: 100,
    assemblies: 1,
    classes: 1,
    files: 1
  })
  assert.equal(summary.files[0].path, 'src/backend/Example.cs')
  assert.equal(summary.source, 'backend-coverlet-json-authoritative-merge')
  assert.equal(evidence.after.formatsPerShard.length, 1)
  assert.equal(evidence.after.exchangeFormatConversions, 1)
  assert.equal(evidence.before.coverageAttachments, 4)
  assert.equal(evidence.after.coverageAttachments, 2)
  assert.equal(evidence.before.parseCount, 4)
  assert.equal(evidence.after.parseCount, 2)
  assert.ok(evidence.before.coverageBytesWritten > evidence.after.coverageBytesWritten - evidence.after.identitySidecarBytesWritten)
  const exchange = await readFile(path.join(subject.output, 'coverage.cobertura.xml'), 'utf8')
  assert.match(exchange, /lines-covered="2" lines-valid="2"/u)
  assert.match(exchange, /branches-covered="4" branches-valid="4"/u)
  assert.match(exchange, /<method name="System\.Void Example\.Subject::Run\(\)"/u)
  assert.equal((exchange.match(/<coverage\b/gu) ?? []).length, 1)
  const exchangeSummaryFile = path.join(subject.root, 'exchange-summary.json')
  const exchangeSummaryResult = spawnSync(process.execPath, [
    path.resolve(import.meta.dirname, '../../tools/coverage/summarize-cobertura.mjs'),
    path.join(subject.output, 'coverage.cobertura.xml'),
    exchangeSummaryFile,
    'backend-cobertura-exchange'
  ], { encoding: 'utf8' })
  assert.equal(exchangeSummaryResult.status, 0, exchangeSummaryResult.stderr || exchangeSummaryResult.stdout)
  const exchangeSummary = JSON.parse(await readFile(exchangeSummaryFile, 'utf8'))
  assert.deepEqual(exchangeSummary.totals, summary.totals)
  assert.deepEqual(exchangeSummary.summary, summary.summary)

  const threshold = spawnSync('bash', [
    path.resolve(import.meta.dirname, '../../tools/coverage/check-threshold.sh')
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FSUSBLOG_COVERAGE_SUMMARY_FILE: path.join(subject.output, 'Summary.json'),
      FSUSBLOG_COVERAGE_LINE_THRESHOLD: '100',
      FSUSBLOG_COVERAGE_BRANCH_THRESHOLD: '100',
      FSUSBLOG_COVERAGE_METHOD_THRESHOLD: '100'
    }
  })
  assert.equal(threshold.status, 0, threshold.stderr || threshold.stdout)

  const frontendDirectory = path.join(subject.coverageRoot, 'frontend')
  await mkdir(frontendDirectory, { recursive: true })
  await writeFile(path.join(frontendDirectory, 'Summary.json'), `${JSON.stringify({
    summary: { assemblies: 0, classes: 0, files: 0 },
    totals: {
      lines: { covered: 0, total: 0 },
      branches: { covered: 0, total: 0 },
      methods: { covered: 0, total: 0 }
    },
    files: [],
    reportPaths: []
  })}\n`)
  const merged = spawnSync('bash', [
    path.resolve(import.meta.dirname, '../../tools/coverage/merge-coverage.sh')
  ], {
    encoding: 'utf8',
    env: { ...process.env, FSUSBLOG_COVERAGE_ROOT: subject.coverageRoot }
  })
  assert.equal(merged.status, 0, merged.stderr || merged.stdout)
  const changed = spawnSync(process.execPath, [
    path.resolve(import.meta.dirname, '../../tools/coverage/write-changed-code-coverage.mjs')
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FSUSBLOG_COVERAGE_ROOT: subject.coverageRoot,
      FSUSBLOG_CHANGED_FILES: 'src/backend/Example.cs'
    }
  })
  assert.equal(changed.status, 0, changed.stderr || changed.stdout)
  const changedSummary = JSON.parse(await readFile(
    path.join(subject.coverageRoot, 'changed-code/Summary.json'),
    'utf8'
  ))
  assert.equal(changedSummary.status, 'ok')
  assert.equal(changedSummary.summary.linecoverage, 100)
})

test('serialized VSTest copies are removed only when byte-identical to the canonical raw report', async (t) => {
  const subject = await fixture(t)
  const directory = path.join(subject.shards, 'ordinary')
  const primary = await writeRaw(directory, rawCoverage())
  const serialized = path.join(directory, '_ser123', 'In', 'transport')
  await mkdir(serialized, { recursive: true })
  await writeFile(
    path.join(serialized, 'coverage.json'),
    await readFile(path.join(primary, 'coverage.json'))
  )

  const prepared = prepareCoverageShard({ directory, shardId: 'ordinary', binding })

  assert.equal(prepared.sidecar.transport.serializedCopiesPruned, 1)
  await assert.rejects(stat(path.join(directory, '_ser123')), { code: 'ENOENT' })
})

test('current VSTest host timestamp attachment layout is recognized structurally', async (t) => {
  const subject = await fixture(t)
  const directory = path.join(subject.shards, 'ordinary')
  const primary = await writeRaw(directory, rawCoverage())
  const serialized = path.join(directory, '_build-agent_2026-08-27_00_00_00', 'In', 'build-agent')
  await mkdir(serialized, { recursive: true })
  await writeFile(
    path.join(serialized, 'coverage.json'),
    await readFile(path.join(primary, 'coverage.json'))
  )

  const prepared = prepareCoverageShard({ directory, shardId: 'ordinary', binding })

  assert.equal(prepared.sidecar.transport.serializedCopiesPruned, 1)
  await assert.rejects(stat(path.join(directory, '_build-agent_2026-08-27_00_00_00')), { code: 'ENOENT' })
})

test('methods without sequence points preserve historical Cobertura method coverage semantics', async (t) => {
  const subject = await fixture(t)
  const payload = rawCoverage()
  payload['Example.dll']['/agent/_work/FsusBlog/FsusBlog/src/backend/Example.cs']['Example.Subject']['System.Void Example.Subject::Empty()'] = {
    Lines: {},
    Branches: []
  }
  payload['Example.dll']['/agent/_work/FsusBlog/FsusBlog/src/backend/Example.cs']['Example.Subject']['System.Void Example.Subject::LineOnly()'] = {
    Lines: { 30: 0 },
    Branches: []
  }
  const shard = await preparedShard(subject, 'ordinary', payload)
  writeCoverageUniverse({ file: subject.universe, shards: [shard], binding })

  const { summary } = mergeCoverageUniverse({
    universeFile: subject.universe,
    outDirectory: subject.output
  })
  assert.deepEqual(summary.totals.methods, { covered: 2, total: 3 })

  const exchangeSummaryFile = path.join(subject.root, 'empty-method-exchange-summary.json')
  const exchangeSummaryResult = spawnSync(process.execPath, [
    path.resolve(import.meta.dirname, '../../tools/coverage/summarize-cobertura.mjs'),
    path.join(subject.output, 'coverage.cobertura.xml'),
    exchangeSummaryFile,
    'backend-cobertura-exchange'
  ], { encoding: 'utf8' })
  assert.equal(exchangeSummaryResult.status, 0, exchangeSummaryResult.stderr || exchangeSummaryResult.stdout)
  const exchangeSummary = JSON.parse(await readFile(exchangeSummaryFile, 'utf8'))
  assert.deepEqual(exchangeSummary.totals.methods, summary.totals.methods)
  assert.equal(exchangeSummary.summary.methodcoverage, summary.summary.methodcoverage)
})

test('duplicate canonical raw inputs fail closed', async (t) => {
  const subject = await fixture(t)
  const directory = path.join(subject.shards, 'ordinary')
  await writeRaw(directory, rawCoverage())
  const duplicate = path.join(directory, 'collector-secondary')
  await mkdir(duplicate, { recursive: true })
  await writeFile(path.join(duplicate, 'coverage.json'), `${JSON.stringify(rawCoverage())}\n`)

  assert.throws(
    () => prepareCoverageShard({ directory, shardId: 'ordinary', binding }),
    /must contain exactly one canonical coverage\.json; found 2/u
  )
})

test('missing shard input and duplicate shard universe fail closed', async (t) => {
  const subject = await fixture(t)
  const shard = await preparedShard(subject, 'ordinary', rawCoverage())
  assert.throws(
    () => writeCoverageUniverse({ file: subject.universe, shards: [shard, shard], binding }),
    /repeats shard ordinary/u
  )

  writeCoverageUniverse({
    file: subject.universe,
    shards: [shard, { id: 'missing', directory: path.join(subject.shards, 'missing') }],
    binding
  })
  assert.throws(
    () => mergeCoverageUniverse({ universeFile: subject.universe, outDirectory: subject.output }),
    /coverage universe is missing shard missing/u
  )
})

test('corrupt or modified canonical raw coverage fails its sidecar digest binding', async (t) => {
  const subject = await fixture(t)
  const shard = await preparedShard(subject, 'ordinary', rawCoverage())
  writeCoverageUniverse({ file: subject.universe, shards: [shard], binding })
  const rawFile = path.join(shard.directory, 'collector-primary', 'coverage.json')
  await writeFile(rawFile, '{broken')

  assert.throws(
    () => mergeCoverageUniverse({ universeFile: subject.universe, outDirectory: subject.output }),
    /raw coverage digest or byte count mismatch/u
  )
})

test('wrong source or module identity across shards fails closed even with valid sidecars', async (t) => {
  const subject = await fixture(t)
  const ordinary = await preparedShard(subject, 'ordinary', rawCoverage())
  const wrongSource = await preparedShard(subject, 'wrong-source', rawCoverage({
    source: '/agent/_work/FsusBlog/FsusBlog/src/backend/Other.cs'
  }))
  writeCoverageUniverse({ file: subject.universe, shards: [ordinary, wrongSource], binding })
  assert.throws(
    () => mergeCoverageUniverse({ universeFile: subject.universe, outDirectory: subject.output }),
    /module\/source universe mismatch/u
  )

  const wrongModule = await preparedShard(subject, 'wrong-module', rawCoverage({
    module: 'Foreign.dll'
  }))
  writeCoverageUniverse({ file: subject.universe, shards: [ordinary, wrongModule], binding })
  assert.throws(
    () => mergeCoverageUniverse({ universeFile: subject.universe, outDirectory: subject.output }),
    /module\/source universe mismatch/u
  )
})

test('source commit, fingerprint, and run binding mismatches fail closed', async (t) => {
  const subject = await fixture(t)
  const shard = await preparedShard(subject, 'ordinary', rawCoverage(), {
    ...binding,
    runId: 'foreign-run'
  })
  writeCoverageUniverse({ file: subject.universe, shards: [shard], binding })

  assert.throws(
    () => mergeCoverageUniverse({ universeFile: subject.universe, outDirectory: subject.output }),
    /runId binding mismatch/u
  )
})
