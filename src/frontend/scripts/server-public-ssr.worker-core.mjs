#!/usr/bin/env node

import { createInterface } from 'node:readline'

export function installSsrDomGlobals() {
  if (typeof globalThis.Element === 'undefined') {
    globalThis.Element = class Element {}
  }
  if (typeof globalThis.HTMLElement === 'undefined') {
    globalThis.HTMLElement = class HTMLElement extends globalThis.Element {}
  }
  if (typeof globalThis.SVGElement === 'undefined') {
    globalThis.SVGElement = class SVGElement extends globalThis.Element {}
  }
  if (typeof globalThis.ShadowRoot === 'undefined') {
    globalThis.ShadowRoot = class ShadowRoot extends globalThis.Element {}
  }
}

export function logWorkerError(message) {
  console.error(`[server-public-ssr] ${message}`)
}

function splitRequestLine(line) {
  const first = line.indexOf('\t')
  const second = first >= 0 ? line.indexOf('\t', first + 1) : -1
  if (first <= 0 || second <= first) {
    throw new Error('invalid line protocol request')
  }

  return {
    requestId: line.slice(0, first),
    command: line.slice(first + 1, second),
    payload: line.slice(second + 1)
  }
}

function assertRuntime(runtime) {
  if (typeof runtime?.decode !== 'function') {
    throw new Error('public_aot_worker_decode_export_missing')
  }
  if (typeof runtime?.encode !== 'function') {
    throw new Error('public_aot_worker_encode_export_missing')
  }
  if (typeof runtime?.buildEntry !== 'function') {
    throw new Error('public_aot_worker_build_public_entry_export_missing')
  }
  if (typeof runtime?.rendererVersion !== 'string' || runtime.rendererVersion.length === 0) {
    throw new Error('public_aot_worker_renderer_version_missing')
  }
}

function decodeRequestPayload(runtime, payload) {
  const decoded = runtime.decode(payload)
  if (!decoded || typeof decoded !== 'object') {
    throw new Error('invalid request payload')
  }
  return decoded
}

async function handleCommand(runtime, command, payloadText) {
  const payload = decodeRequestPayload(runtime, payloadText)

  switch (command) {
    case 'buildEntry': {
      const pageKind = typeof payload.pageKind === 'string' ? payload.pageKind : ''
      const options = payload.options && typeof payload.options === 'object' ? payload.options : {}
      if (!pageKind) {
        throw new Error('pageKind is required')
      }
      const result = await runtime.buildEntry(pageKind, options)
      return { ok: true, entry: result.entry }
    }
    case 'validateBundle':
    case 'health':
      return { ok: true, rendererVersion: runtime.rendererVersion }
    case 'shutdown':
      return { ok: true, shutdown: true }
    default:
      throw new Error(`unsupported command: ${command}`)
  }
}

async function writeResponse(runtime, requestId, response) {
  process.stdout.write(`${requestId}\t${runtime.encode(response)}\n`)
}

async function processLine(runtime, line) {
  if (!line.trim()) {
    return false
  }

  let requestId = 'unknown'
  try {
    const request = splitRequestLine(line)
    requestId = request.requestId
    const response = await handleCommand(runtime, request.command, request.payload)
    await writeResponse(runtime, requestId, response)
    return Boolean(response.shutdown)
  } catch (error) {
    await writeResponse(runtime, requestId, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

export async function runPublicSsrWorker(createRuntime) {
  const runtime = await createRuntime()
  assertRuntime(runtime)
  const isWorker = process.argv.includes('--worker')

  try {
    const reader = createInterface({
      input: process.stdin,
      crlfDelay: Infinity
    })

    for await (const line of reader) {
      const shouldExit = await processLine(runtime, line)
      if (shouldExit) {
        break
      }
      if (!isWorker) {
        break
      }
    }
  } finally {
    if (typeof runtime.dispose === 'function') {
      await runtime.dispose()
    }
  }
}
