import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { createAsyncLogPipeline } from '../../tools/test-matrix/async-log-pipeline.mjs'
import { runDag } from '../../tools/test-matrix/scheduler.mjs'

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`))
}

function indexEntries(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

function reconstruct(raw, entries, identity = null) {
  return Buffer.concat(entries
    .filter((entry) => entry.type === 'chunk' && (identity === null || entry.stream === identity))
    .map((entry) => raw.subarray(entry.offset, entry.offset + entry.length)))
}

test('async log pipeline preserves raw bytes and indexes stdout/stderr ranges in monotonic order', async () => {
  const root = temporaryDirectory('async-log-bytes')
  const file = path.join(root, 'child.log')
  const pipeline = createAsyncLogPipeline({ root, file, teeOutput: false })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  pipeline.attach(stdout, 'stdout')
  pipeline.attach(stderr, 'stderr')

  const stdoutBytes = Buffer.from([0x61, 0xf0, 0x9f, 0x92, 0xa9, 0xc3])
  const stderrBytes = Buffer.from([0xff, 0x62, 0x0a])
  stdout.write(stdoutBytes.subarray(0, 3))
  stderr.write(stderrBytes)
  stdout.end(stdoutBytes.subarray(3))
  stderr.end()
  await Promise.all([once(stdout, 'end'), once(stderr, 'end')])

  const finalized = await pipeline.close()
  assert.equal(finalized.error, null)
  assert.equal(finalized.evidence.status, 'complete')
  assert.equal(finalized.evidence.inputBytes, stdoutBytes.length + stderrBytes.length)
  assert.equal(finalized.evidence.fileBytes, finalized.evidence.inputBytes)
  assert.match(finalized.evidence.sha256, /^sha256:[0-9a-f]{64}$/u)

  const raw = fs.readFileSync(file)
  const entries = indexEntries(finalized.indexFile)
  const chunks = entries.filter((entry) => entry.type === 'chunk')
  assert.deepEqual(chunks.map((entry) => entry.sequence), chunks.map((_, index) => index))
  assert.deepEqual(reconstruct(raw, entries, 'stdout'), stdoutBytes)
  assert.deepEqual(reconstruct(raw, entries, 'stderr'), stderrBytes)
  assert.deepEqual(reconstruct(raw, entries), raw)
  assert.equal(entries.at(-1).type, 'footer')
  assert.equal(entries.at(-1).complete, true)
})

test('async log pipeline applies file backpressure to attached inputs and flushes every byte', async () => {
  const root = temporaryDirectory('async-log-backpressure')
  const file = path.join(root, 'burst.log')
  const pipeline = createAsyncLogPipeline({
    root,
    file,
    highWaterMark: 16,
    indexHighWaterMark: 16,
    teeOutput: false
  })
  const input = new PassThrough()
  pipeline.attach(input, 'stdout')
  const chunks = Array.from({ length: 64 }, (_, index) => Buffer.alloc(1024, index))
  for (const chunk of chunks) input.write(chunk)
  input.end()
  await once(input, 'end')

  const finalized = await pipeline.close()
  assert.equal(finalized.error, null)
  assert.ok(finalized.evidence.backpressure.events > 0)
  assert.equal(finalized.evidence.inputBytes, chunks.length * chunks[0].length)
  assert.equal(finalized.evidence.fileBytes, finalized.evidence.inputBytes)
  assert.deepEqual(fs.readFileSync(file), Buffer.concat(chunks))
})

test('slow console tee is bounded and degrades without dropping authoritative bytes', async () => {
  class SlowSink extends EventEmitter {
    write() { return false }
  }
  const root = temporaryDirectory('async-log-console')
  const file = path.join(root, 'console.log')
  const sink = new SlowSink()
  const pipeline = createAsyncLogPipeline({
    root,
    file,
    teeOutput: true,
    consoleSinks: { stdout: sink, stderr: sink },
    consoleMaxBufferedBytes: 32
  })
  const chunks = Array.from({ length: 20 }, () => Buffer.alloc(16, 0x78))
  for (const chunk of chunks) pipeline.write(chunk, 'stdout')

  const finalized = await pipeline.close()
  assert.equal(finalized.error, null)
  assert.equal(finalized.evidence.fileBytes, chunks.length * chunks[0].length)
  assert.ok(finalized.evidence.console.suppressedBytes > 0)
  assert.equal(finalized.evidence.console.queuedBytes, 0)
  assert.equal(finalized.evidence.console.maxBufferedBytes, 32)
})

test('writer failure is observable and final evidence fails closed', async () => {
  const root = temporaryDirectory('async-log-error')
  const invalidLogFile = path.join(root, 'directory-as-log')
  fs.mkdirSync(invalidLogFile)
  const pipeline = createAsyncLogPipeline({ root, file: invalidLogFile })
  pipeline.write('will fail', 'stderr')
  const error = await pipeline.failure
  assert.match(error.message, /EISDIR|illegal operation on a directory/u)
  const finalized = await pipeline.close({ complete: false, truncationReason: 'writer-error-test' })
  assert.equal(finalized.error, error)
  assert.equal(finalized.evidence.status, 'failure')
  assert.equal(finalized.evidence.flush.status, 'failed')
  assert.equal(finalized.evidence.flush.complete, false)
})

test('forced close flushes accepted bytes but marks the stream partial', async () => {
  const root = temporaryDirectory('async-log-partial')
  const file = path.join(root, 'partial.log')
  const pipeline = createAsyncLogPipeline({ root, file })
  pipeline.write('accepted-before-kill\n', 'stderr')
  const finalized = await pipeline.close({
    complete: false,
    truncationReason: 'forced-pipe-close-after-sigkill'
  })
  assert.equal(finalized.error, null)
  assert.equal(finalized.evidence.status, 'partial')
  assert.equal(finalized.evidence.flush.status, 'complete')
  assert.equal(finalized.evidence.flush.complete, false)
  assert.equal(finalized.evidence.flush.truncationReason, 'forced-pipe-close-after-sigkill')
  assert.equal(fs.readFileSync(file, 'utf8'), 'accepted-before-kill\n')
  assert.equal(indexEntries(finalized.indexFile).at(-1).complete, false)
})

test('scheduler checkpoint references one authoritative log with stream index and flush evidence', async () => {
  const root = temporaryDirectory('async-log-scheduler')
  const result = await runDag({
    tiers: [{
      id: 'logged-tier',
      command: 'custom',
      dependsOn: [],
      services: [],
      parallelizable: true,
      exclusiveResources: [],
      phase: 0,
      resourceClass: 'cpu',
      maxParallel: 1,
      cpuUnits: 1,
      memoryGiB: 0.1,
      cacheInputs: [],
      executionKey: 'test/logged-tier',
      executionVariant: 'ordinary',
      coverage: ['ordinary-unit']
    }],
    root,
    runsRoot: path.join(root, 'runs'),
    runId: 'async-log',
    maxParallel: 1,
    systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
    snapshotWorktree: async () => ({ fingerprint: 'stable', entries: {} }),
    executeTier: async (_tier, context) => {
      context.writeOutput(Buffer.from([0x6f, 0x75, 0x74]), false)
      context.writeOutput(Buffer.from([0x65, 0x72, 0x72]), true)
      return { code: 0, signal: null }
    }
  })

  assert.equal(result.status, 'success')
  const logged = result.checkpoint.tiers['logged-tier']
  assert.equal(logged.log.status, 'complete')
  assert.equal(logged.log.streams.stdoutBytes, 3)
  assert.equal(logged.log.streams.stderrBytes, 3)
  assert.equal(logged.log.fileBytes, 6)
  assert.equal(fs.readFileSync(path.join(root, logged.log.rawLog), 'utf8'), 'outerr')
  assert.equal(fs.existsSync(path.join(root, logged.log.index)), true)
  assert.equal(fs.existsSync(path.join(root, logged.log.evidence)), true)
})

test('production output hot paths contain no synchronous per-chunk append', () => {
  for (const relative of [
    'tools/test-matrix/async-log-pipeline.mjs',
    'tools/test-matrix/scheduler.mjs',
    'tools/test/bundles/run-bundle.mjs'
  ]) {
    const source = fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /appendFileSync/u, relative)
  }
  const bundleSource = fs.readFileSync(
    new URL('../../tools/test/bundles/run-bundle.mjs', import.meta.url),
    'utf8'
  )
  assert.match(
    bundleSource,
    /teeOutput: process\.env\.FSUSBLOG_PRODUCTION_CHILD_CONSOLE_TEE === '1'/u
  )
  assert.match(
    bundleSource,
    /result\.logFile,[\s\S]*?result\.logIndexFile,[\s\S]*?result\.logEvidenceFile/u
  )
  assert.match(bundleSource, /resourceAndLogEvidence = \{[\s\S]*?log: logFinalization\.evidence/u)
})
