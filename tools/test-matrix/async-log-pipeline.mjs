import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { EventEmitter } from 'node:events'

const streamIdentities = new Set(['stdout', 'stderr'])

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function normalizedBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  return Buffer.from(String(chunk))
}

function relativePath(root, file) {
  if (!root) return file
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function safeError(error) {
  return error instanceof Error ? error : new Error(String(error))
}

function createBoundedConsoleTee({ enabled, sinks, maxBufferedBytes }) {
  const states = new Map([...streamIdentities].map((identity) => [identity, {
    identity,
    sink: sinks?.[identity] ?? null,
    blocked: false,
    queue: [],
    queuedBytes: 0,
    writtenBytes: 0,
    suppressedBytes: 0,
    drainListener: null
  }]))

  const flush = (state) => {
    if (!enabled || !state.sink || state.blocked) return
    while (state.queue.length > 0) {
      const buffer = state.queue.shift()
      state.queuedBytes -= buffer.length
      state.writtenBytes += buffer.length
      if (state.sink.write(buffer) === false) {
        state.blocked = true
        state.drainListener = () => {
          state.blocked = false
          state.drainListener = null
          flush(state)
        }
        state.sink.once?.('drain', state.drainListener)
        break
      }
    }
  }

  const enqueue = (state, buffer) => {
    if (!enabled || !state.sink) {
      state.suppressedBytes += buffer.length
      return
    }
    if (!state.blocked && state.queue.length === 0) {
      state.writtenBytes += buffer.length
      if (state.sink.write(buffer) === false) {
        state.blocked = true
        state.drainListener = () => {
          state.blocked = false
          state.drainListener = null
          flush(state)
        }
        state.sink.once?.('drain', state.drainListener)
      }
      return
    }
    const available = Math.max(0, maxBufferedBytes - state.queuedBytes)
    if (available > 0) {
      const queued = available >= buffer.length ? buffer : buffer.subarray(0, available)
      state.queue.push(queued)
      state.queuedBytes += queued.length
    }
    state.suppressedBytes += Math.max(0, buffer.length - available)
  }

  return {
    write(buffer, identity) {
      enqueue(states.get(identity), buffer)
    },
    close() {
      for (const state of states.values()) {
        if (!state.blocked) flush(state)
        if (state.queuedBytes > 0) {
          state.suppressedBytes += state.queuedBytes
          state.queue = []
          state.queuedBytes = 0
        }
        if (state.drainListener) state.sink?.off?.('drain', state.drainListener)
        state.drainListener = null
      }
    },
    evidence() {
      const stdout = states.get('stdout')
      const stderr = states.get('stderr')
      return {
        enabled,
        maxBufferedBytes,
        bytes: stdout.writtenBytes + stderr.writtenBytes,
        stdoutBytes: stdout.writtenBytes,
        stderrBytes: stderr.writtenBytes,
        suppressedBytes: stdout.suppressedBytes + stderr.suppressedBytes,
        queuedBytes: stdout.queuedBytes + stderr.queuedBytes
      }
    }
  }
}

async function finishWriter(writer) {
  if (writer.closed || writer.destroyed) return
  await new Promise((resolve) => {
    const settle = () => {
      writer.off('finish', settle)
      writer.off('close', settle)
      writer.off('error', settle)
      resolve()
    }
    writer.once('finish', settle)
    writer.once('close', settle)
    writer.once('error', settle)
    writer.end()
  })
}

async function writeJsonAtomic(file, value) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}-${crypto.randomUUID()}`
  await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await fs.promises.rename(temporary, file)
}

/**
 * A run-bound output sink whose raw child bytes are written exactly once.
 * Stream identity and combined ordering live in a compact JSONL byte-range
 * index, so readers can reconstruct stdout, stderr, or their combined view
 * without copying the payload into a second tier log.
 */
export function createAsyncLogPipeline(options) {
  const file = path.resolve(String(options?.file ?? ''))
  if (!String(options?.file ?? '').trim()) throw new Error('async log pipeline file is required')
  const root = options.root ? path.resolve(options.root) : null
  const indexFile = path.resolve(options.indexFile ?? `${file}.index.jsonl`)
  const evidenceFile = path.resolve(options.evidenceFile ?? `${file}.pipeline.json`)
  const highWaterMark = positiveInteger(options.highWaterMark, 64 * 1024, 'highWaterMark')
  const indexHighWaterMark = positiveInteger(options.indexHighWaterMark, 64 * 1024, 'indexHighWaterMark')
  const consoleMaxBufferedBytes = positiveInteger(
    options.consoleMaxBufferedBytes,
    256 * 1024,
    'consoleMaxBufferedBytes'
  )
  const clock = typeof options.clock === 'function' ? options.clock : () => process.hrtime.bigint()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.mkdirSync(path.dirname(indexFile), { recursive: true })

  const rawWriter = fs.createWriteStream(file, { flags: 'w', highWaterMark })
  const indexWriter = fs.createWriteStream(indexFile, { flags: 'w', highWaterMark: indexHighWaterMark })
  const writers = [rawWriter, indexWriter]
  const attached = new Map()
  const blockedWriters = new Set()
  const digest = crypto.createHash('sha256')
  const errorEvents = new EventEmitter()
  const consoleTee = createBoundedConsoleTee({
    enabled: options.teeOutput === true,
    sinks: options.consoleSinks ?? { stdout: process.stdout, stderr: process.stderr },
    maxBufferedBytes: consoleMaxBufferedBytes
  })
  const startedAt = new Date().toISOString()
  const startedAtNs = clock()
  let firstError = null
  let sequence = 0
  let inputBytes = 0
  let stdoutBytes = 0
  let stderrBytes = 0
  let backpressureEvents = 0
  let backpressureStartedNs = null
  let backpressureNs = 0n
  let closing = false
  let closePromise = null

  let resolveFailure
  const failure = new Promise((resolve) => { resolveFailure = resolve })

  const pauseInputs = () => {
    for (const record of attached.values()) {
      if (record.paused) continue
      record.paused = true
      record.readable.pause?.()
    }
  }
  const resumeInputs = () => {
    if (blockedWriters.size > 0 || firstError || closing) return
    for (const record of attached.values()) {
      if (!record.paused) continue
      record.paused = false
      record.readable.resume?.()
    }
  }
  const beginBackpressure = (writer) => {
    if (blockedWriters.has(writer)) return
    blockedWriters.add(writer)
    backpressureEvents += 1
    if (backpressureStartedNs === null) backpressureStartedNs = clock()
    pauseInputs()
  }
  const finishBackpressure = (writer) => {
    blockedWriters.delete(writer)
    if (blockedWriters.size === 0 && backpressureStartedNs !== null) {
      backpressureNs += clock() - backpressureStartedNs
      backpressureStartedNs = null
      resumeInputs()
    }
  }
  const fail = (error) => {
    if (firstError) return
    firstError = safeError(error)
    pauseInputs()
    resolveFailure(firstError)
    errorEvents.emit('failure', firstError)
  }

  for (const writer of writers) {
    writer.on('error', fail)
    writer.on('drain', () => finishBackpressure(writer))
  }

  const header = {
    schema: 'fsusblog.async-log-index.v1',
    type: 'header',
    rawLog: relativePath(root, file),
    startedAt
  }
  if (!indexWriter.write(`${JSON.stringify(header)}\n`)) beginBackpressure(indexWriter)

  const write = (chunk, identity = 'stdout') => {
    if (!streamIdentities.has(identity)) throw new Error(`invalid log stream identity: ${identity}`)
    if (closing) throw new Error('async log pipeline is closing')
    if (firstError) return false
    const buffer = normalizedBuffer(chunk)
    if (buffer.length === 0) return blockedWriters.size === 0
    const receivedAtNs = clock()
    const offset = inputBytes
    const entry = {
      type: 'chunk',
      sequence,
      stream: identity,
      offset,
      length: buffer.length,
      monotonicNs: String(receivedAtNs - startedAtNs)
    }
    sequence += 1
    inputBytes += buffer.length
    if (identity === 'stdout') stdoutBytes += buffer.length
    else stderrBytes += buffer.length
    digest.update(buffer)
    if (!rawWriter.write(buffer)) beginBackpressure(rawWriter)
    if (!indexWriter.write(`${JSON.stringify(entry)}\n`)) beginBackpressure(indexWriter)
    consoleTee.write(buffer, identity)
    return blockedWriters.size === 0
  }

  const attach = (readable, identity) => {
    if (!readable) return () => {}
    if (!streamIdentities.has(identity)) throw new Error(`invalid log stream identity: ${identity}`)
    const onData = (chunk) => write(chunk, identity)
    const onError = (error) => fail(new Error(`${identity} pipe failed: ${safeError(error).message}`, { cause: error }))
    const record = { readable, identity, paused: false, onData, onError }
    attached.set(readable, record)
    readable.on('data', onData)
    readable.on('error', onError)
    if (blockedWriters.size > 0) pauseInputs()
    return () => {
      readable.off('data', onData)
      readable.off('error', onError)
      attached.delete(readable)
    }
  }

  const close = ({ complete = true, truncationReason = null } = {}) => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      closing = true
      for (const record of attached.values()) {
        record.readable.off('data', record.onData)
        record.readable.off('error', record.onError)
      }
      attached.clear()
      if (backpressureStartedNs !== null) {
        backpressureNs += clock() - backpressureStartedNs
        backpressureStartedNs = null
      }
      consoleTee.close()
      const footer = {
        type: 'footer',
        chunks: sequence,
        bytes: inputBytes,
        complete: complete && !firstError,
        truncationReason: truncationReason ?? (firstError ? 'writer-error' : null)
      }
      if (!indexWriter.destroyed) indexWriter.write(`${JSON.stringify(footer)}\n`)
      await Promise.all(writers.map(finishWriter))

      let fileBytes = null
      try { fileBytes = (await fs.promises.stat(file)).size } catch {}
      if (!firstError && fileBytes !== inputBytes) {
        fail(new Error(`authoritative log size mismatch: expected ${inputBytes}, wrote ${fileBytes ?? 'unavailable'}`))
      }
      const consoleEvidence = consoleTee.evidence()
      const evidence = {
        schema: 'fsusblog.async-log-pipeline.v1',
        status: firstError ? 'failure' : (complete ? 'complete' : 'partial'),
        rawLog: relativePath(root, file),
        index: relativePath(root, indexFile),
        evidence: relativePath(root, evidenceFile),
        streams: {
          stdoutBytes,
          stderrBytes
        },
        chunks: sequence,
        inputBytes,
        fileBytes,
        sha256: fileBytes === inputBytes && !firstError ? `sha256:${digest.digest('hex')}` : null,
        backpressure: {
          events: backpressureEvents,
          durationMs: Number(backpressureNs) / 1_000_000,
          highWaterMark,
          indexHighWaterMark
        },
        console: consoleEvidence,
        flush: {
          status: firstError ? 'failed' : 'complete',
          error: firstError?.message ?? null,
          complete: complete && !firstError,
          truncationReason: truncationReason ?? (firstError ? 'writer-error' : null)
        },
        startedAt,
        finishedAt: new Date().toISOString()
      }
      try {
        await writeJsonAtomic(evidenceFile, evidence)
      } catch (error) {
        fail(new Error(`log evidence write failed: ${safeError(error).message}`, { cause: error }))
        evidence.status = 'failure'
        evidence.flush.status = 'failed'
        evidence.flush.error = firstError.message
      }
      return {
        file,
        indexFile,
        evidenceFile,
        evidence,
        error: firstError
      }
    })()
    return closePromise
  }

  return {
    file,
    indexFile,
    evidenceFile,
    failure,
    write,
    attach,
    close,
    onFailure(listener) {
      errorEvents.on('failure', listener)
      return () => errorEvents.off('failure', listener)
    }
  }
}
