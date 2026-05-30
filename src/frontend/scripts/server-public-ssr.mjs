#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { createServer, normalizePath } from 'vite'

function logError(message) {
  console.error(`[server-public-ssr] ${message}`)
}

function installSsrDomGlobals() {
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

async function createRuntime() {
  installSsrDomGlobals()

  const server = await createServer({
    root: process.cwd(),
    server: {
      middlewareMode: true,
      hmr: false,
      ws: false,
      watch: null
    },
    appType: 'custom',
    configFile: normalizePath(`${process.cwd()}/vite.config.ts`)
  })

  const payloadModule = await server.ssrLoadModule(normalizePath('/src/bootstrap/publicAotBinaryPayload.ts'))
  const rendererModule = await server.ssrLoadModule(normalizePath('/src/public-renderers/renderPublicPage.ts'))

  return {
    server,
    decode: payloadModule.decodePublicAotPayload,
    encode: payloadModule.encodePublicAotPayload,
    buildEntry: rendererModule.buildPublicEntry
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
      return { ok: true }
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

async function main() {
  const runtime = await createRuntime()
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
    await runtime.server.close()
  }
}

main().catch((error) => {
  logError(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
