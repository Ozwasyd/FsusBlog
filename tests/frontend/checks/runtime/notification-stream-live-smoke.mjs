#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { decodeAedsFrame, readAedsResponse } from '../../support/aeds-envelope.mjs'
import { baseUrl, buildPowHeaders, fetchChallenge, requestTimeoutMs } from '../../support/auth-helpers.mjs'
import { fetchWithTimeout, probeReachable } from '../../support/http.mjs'

const streamPath = '/api/notifications/stream'
const wsProtocol = 'fsus-aeds.v2'
const frameNotificationHeartbeat = 70
const execFileAsync = promisify(execFile)
const resetSecurityTestState = process.env.FSUSBLOG_RESET_SECURITY_TEST_STATE !== '0'
const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER || process.env.FSUSBLOG_REDIS_CONTAINER_NAME || 'fsusblog-redis'
const maxDeterministicPowDifficulty = Number.parseInt(process.env.FSUSBLOG_ACCEPTANCE_POW_MAX_DIFFICULTY ?? '20', 10) || 20

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function resetLocalPowRiskState() {
  if (!resetSecurityTestState) {
    return
  }

  try {
    await execFileAsync('docker', [
      'exec',
      redisContainer,
      'sh',
      '-c',
      "redis-cli --scan --pattern '*fsus:sec:pow-risk:*' | xargs -r redis-cli DEL"
    ], { timeout: 5000 })
  } catch {
    // Non-local environments may not use the developer docker container.
  }
}

async function waitForDeterministicPow(label) {
  let lastDifficulty = 'unknown'
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const challenge = await fetchChallenge(5000)
      const difficulty = Number(challenge.difficulty ?? challenge.Difficulty ?? 999)
      lastDifficulty = Number.isFinite(difficulty) ? String(difficulty) : 'unknown'
      if (difficulty <= maxDeterministicPowDifficulty) {
        return
      }
    } catch {
      lastDifficulty = 'unreachable'
    }

    await delay(1000)
  }

  throw new Error(`${label} pow difficulty did not settle below ${maxDeterministicPowDifficulty}; last=${lastDifficulty}`)
}

async function resetAndWaitForPow(label) {
  await resetLocalPowRiskState()
  await waitForDeterministicPow(label)
}

function toWsUrl(path, params = {}) {
  const url = new URL(path, baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

async function expectHttpHandshakeFailure(name, expectedStatus, expectedMessage) {
  const response = await fetchWithTimeout(`${baseUrl}${streamPath}`, {
    headers: {
      Accept: 'application/octet-stream'
    }
  }, requestTimeoutMs)

  const payload = await readAedsResponse(response).catch(() => null)
  assert(response.status === expectedStatus, `[${name}] expected status ${expectedStatus}, got ${response.status}`)
  assert(response.headers.get('content-type')?.includes('application/octet-stream'), `[${name}] expected octet-stream error response`)
  assert(payload?.message === expectedMessage, `[${name}] expected message ${expectedMessage}, got ${payload?.message ?? 'none'}`)
  console.log(`[notification-stream-live-smoke] ok: ${name}`)
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

async function expectLiveWebSocket(name, extraParams = {}) {
  const powHeaders = await buildPowHeaders(`notification-stream-live-${name}`, requestTimeoutMs)
  const url = toWsUrl(streamPath, {
    pow: powHeaders['X-Fsus-Pow-Proof'],
    ...extraParams
  })

  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, wsProtocol)
    socket.binaryType = 'arraybuffer'
    const timer = setTimeout(() => {
      socket.close(1000, 'timeout')
      reject(new Error(`[${name}] timeout waiting for binary websocket frame`))
    }, requestTimeoutMs)

    socket.addEventListener('open', () => {
      assert(socket.protocol === wsProtocol, `[${name}] expected websocket protocol ${wsProtocol}, got ${socket.protocol || 'none'}`)
    })

    socket.addEventListener('message', async (event) => {
      try {
        const frame = decodeAedsFrame(await readMessageData(event.data))
        assert(frame.frameType === frameNotificationHeartbeat, `[${name}] expected heartbeat frame ${frameNotificationHeartbeat}, got ${frame.frameType}`)
        clearTimeout(timer)
        socket.close(1000, 'done')
        console.log(`[notification-stream-live-smoke] ok: ${name}`)
        resolve()
      } catch (error) {
        clearTimeout(timer)
        socket.close(1002, 'invalid')
        reject(error)
      }
    })

    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`[${name}] websocket error`))
    })
  })
}

async function main() {
  await probeReachable(`${baseUrl}/api/binary/article/list/home/1/1.aeds`, '[notification-stream-live-smoke backend]', requestTimeoutMs)

  await expectHttpHandshakeFailure('http-upgrade-required', 426, 'websocket_required')
  await resetAndWaitForPow('notification stream live websocket')
  await expectLiveWebSocket('anonymous-initial')
  await expectLiveWebSocket('anonymous-reconnect', { cursor: '0' })

  console.log('[notification-stream-live-smoke] all checks passed')
  process.exit(0)
}

main().catch((error) => {
  console.error('[notification-stream-live-smoke] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
