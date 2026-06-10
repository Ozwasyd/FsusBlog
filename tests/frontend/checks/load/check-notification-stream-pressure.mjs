#!/usr/bin/env node

import { decodeAedsFrame } from '../../support/aeds-envelope.mjs'
import { baseUrl, buildPowHeaders, requestTimeoutMs } from '../../support/auth-helpers.mjs'
import { probeReachable } from '../../support/http.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readNotificationPressurePolicy } from './loadPolicy.mjs'

const streamPath = '/api/notifications/stream'
const wsProtocol = 'fsus-aeds.v2'
const frameNotificationHeartbeat = 70
const notificationPolicy = readNotificationPressurePolicy()
const connections = readPositiveInt(process.env.FSUSBLOG_NOTIFICATION_STREAM_CONNECTIONS, notificationPolicy.connections ?? 50)
const durationMs = readPositiveInt(process.env.FSUSBLOG_NOTIFICATION_STREAM_DURATION_MS, notificationPolicy.durationMs ?? 30000)
const connectBatchSize = readPositiveInt(process.env.FSUSBLOG_NOTIFICATION_STREAM_CONNECT_BATCH_SIZE, notificationPolicy.connectBatchSize ?? 10)
const powAttempts = readPositiveInt(process.env.FSUSBLOG_NOTIFICATION_STREAM_POW_ATTEMPTS, notificationPolicy.powAttempts ?? 30)
const testSessionId = process.env.FSUSBLOG_TEST_SESSION_ID || ''
const evidenceDir = process.env.FSUSBLOG_PERF_EVIDENCE_DIR || resolve(process.cwd(), '..', '..', '.tmp/perf')

function readPositiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toWsUrl(powProof, index) {
  const url = new URL(streamPath, baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('pow', powProof)
  url.searchParams.set('client', `pressure-${index}`)
  if (testSessionId.length > 0) {
    url.searchParams.set('testSession', testSessionId)
  }
  return url
}

async function readMessageData(data) {
  if (data instanceof ArrayBuffer) {
    return data
  }
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return await data.arrayBuffer()
  }
  throw new Error(`unexpected websocket message type: ${Object.prototype.toString.call(data)}`)
}

async function buildPressurePowProof() {
  const fingerprint = `notification-stream-pressure-${process.pid}-${Date.now()}`
  let lastError = null
  for (let attempt = 1; attempt <= powAttempts; attempt += 1) {
    try {
      const powHeaders = await buildPowHeaders(fingerprint, requestTimeoutMs)
      return powHeaders['X-Fsus-Pow-Proof']
    } catch (error) {
      lastError = error
      if (attempt === powAttempts) {
        break
      }
      await sleep(Math.min(2000, 250 * attempt))
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function openPressureSocket(index, stats, powProof) {
  const url = toWsUrl(powProof, index)

  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, wsProtocol)
    socket.binaryType = 'arraybuffer'
    let sawHeartbeat = false

    const timer = setTimeout(() => {
      try {
        socket.close(1000, 'connect-timeout')
      } catch {
      }
      reject(new Error(`[connection ${index}] timeout waiting for first heartbeat`))
    }, requestTimeoutMs)

    socket.addEventListener('open', () => {
      stats.opened += 1
      assert(socket.protocol === wsProtocol, `[connection ${index}] expected protocol ${wsProtocol}, got ${socket.protocol || 'none'}`)
    })

    socket.addEventListener('message', async (event) => {
      try {
        const frame = decodeAedsFrame(await readMessageData(event.data))
        if (frame.frameType === frameNotificationHeartbeat) {
          stats.heartbeats += 1
          sawHeartbeat = true
          clearTimeout(timer)
          resolve(socket)
          return
        }

        stats.nonHeartbeatFrames += 1
      } catch (error) {
        clearTimeout(timer)
        reject(error)
      }
    })

    socket.addEventListener('close', () => {
      stats.closed += 1
      if (!sawHeartbeat) {
        clearTimeout(timer)
      }
    })

    socket.addEventListener('error', () => {
      stats.errors += 1
      clearTimeout(timer)
      reject(new Error(`[connection ${index}] websocket error`))
    })
  })
}

async function openSockets(stats) {
  const sockets = []
  for (let index = 0; index < connections; index += connectBatchSize) {
    const batch = []
    const end = Math.min(index + connectBatchSize, connections)
    for (let current = index; current < end; current += 1) {
      const powProof = await buildPressurePowProof()
      batch.push(openPressureSocket(current, stats, powProof))
    }

    sockets.push(...await Promise.all(batch))
  }

  return sockets
}

async function main() {
  await probeReachable(`${baseUrl}/api/binary/article/list/home/1/1.aeds`, '[notification-stream-pressure backend]', requestTimeoutMs)

  const stats = {
    targetConnections: connections,
    opened: 0,
    closed: 0,
    heartbeats: 0,
    nonHeartbeatFrames: 0,
    errors: 0,
    durationMs,
    baseUrl,
    policy: {
      source: 'tests/perf/perf-policy.yml',
      profile: 'notificationPressure'
    }
  }

  const startedAt = performance.now()
  const sockets = await openSockets(stats)
  assert(sockets.length === connections, `opened socket drift: ${sockets.length}/${connections}`)
  await sleep(durationMs)

  await Promise.allSettled(sockets.map((socket) => {
    try {
      socket.close(1000, 'pressure-complete')
    } catch {
    }
    return sleep(0)
  }))

  stats.elapsedMs = Math.round(performance.now() - startedAt)
  assert(stats.opened === connections, `open count drift: ${stats.opened}/${connections}`)
  assert(stats.heartbeats >= connections, `heartbeat count drift: ${stats.heartbeats}/${connections}`)
  assert(stats.errors === 0, `websocket errors: ${stats.errors}`)

  await mkdir(evidenceDir, { recursive: true })
  await writeFile(resolve(evidenceDir, 'notification-stream-pressure.json'), `${JSON.stringify({
    status: 'ok',
    generatedAt: new Date().toISOString(),
    ...stats
  }, null, 2)}\n`)

  console.log(`[notification-stream-pressure] ok ${JSON.stringify(stats)}`)
  process.exit(0)
}

main().catch((error) => {
  console.error('[notification-stream-pressure] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
