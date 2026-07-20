#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isValidReleaseId } from '../release/release-id.mjs'

const SCHEMA_VERSION = 'fsus.active-release-fence-evidence.v1'
const DEFAULT_OUTPUT = '.tmp/deployment/active-release-fence.json'
const VALID_ACTIONS = new Set(['acquire', 'revoke', 'status'])

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const action = argv.shift()
  if (!VALID_ACTIONS.has(action)) {
    fail('usage: active-release-fence.mjs <acquire|revoke|status> [options]')
  }

  const options = {
    action,
    port: undefined,
    releaseId: undefined,
    slot: undefined,
    generation: undefined,
    imageDigest: undefined,
    expectedReleaseId: undefined,
    expectedSlot: undefined,
    expectedGeneration: undefined,
    requireActive: true,
    dryRun: false,
    adminHeaderFile: process.env.FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE,
    origin: process.env.FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN,
    output: DEFAULT_OUTPUT
  }

  while (argv.length > 0) {
    const flag = argv.shift()
    if (flag === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (flag === '--allow-inactive') {
      options.requireActive = false
      continue
    }

    const value = argv.shift()
    if (value === undefined) fail(`${flag} requires a value`)
    switch (flag) {
      case '--port': options.port = value; break
      case '--release': options.releaseId = value; break
      case '--slot': options.slot = value; break
      case '--generation': options.generation = positiveInteger(value, flag); break
      case '--digest': options.imageDigest = value; break
      case '--expected-release': options.expectedReleaseId = value; break
      case '--expected-slot': options.expectedSlot = value; break
      case '--expected-generation': options.expectedGeneration = positiveInteger(value, flag); break
      case '--admin-header-file': options.adminHeaderFile = value; break
      case '--origin': options.origin = value; break
      case '--out': options.output = value; break
      default: fail(`unknown argument: ${flag}`)
    }
  }

  const port = Number(options.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail('--port must be between 1 and 65535')
  }
  options.port = port

  if (options.action !== 'status') {
    requireIdentity(options)
  }
  if (options.action === 'acquire') {
    if (!/^sha256:[0-9a-f]{64}$/.test(options.imageDigest ?? '')) {
      fail('--digest must be an immutable sha256 digest')
    }
    const expected = [options.expectedReleaseId, options.expectedSlot, options.expectedGeneration]
    if (expected.some(value => value !== undefined) && expected.some(value => value === undefined)) {
      fail('expected release, slot and generation must be supplied together')
    }
  }
  if (!options.adminHeaderFile) fail('--admin-header-file is required')
  if (!isAllowedOrigin(options.origin)) fail('--origin must be an explicit HTTPS origin')
  if (!options.output?.trim()) fail('--out must not be empty')
  return options
}

function positiveInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${flag} must be a positive integer`)
  return parsed
}

function requireIdentity(options) {
  if (!isValidReleaseId(options.releaseId)) {
    fail('--release is invalid')
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(options.slot ?? '')) {
    fail('--slot is invalid')
  }
  if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
    fail('--generation is required')
  }
}

function isAllowedOrigin(origin) {
  if (typeof origin !== 'string') return false
  if (/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(origin)) return true
  return process.env.FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE === '1'
    && /^http:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(origin)
}

async function readAdminHeader(file) {
  const metadata = await stat(file)
  const mode = metadata.mode & 0o777
  if (mode !== 0o400 && mode !== 0o600) {
    fail('deployment admin header file must have mode 0400 or 0600')
  }
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean)
  if (lines.length !== 1) fail('deployment admin header file must contain exactly one header line')
  const match = /^(Authorization|Cookie): (.+)$/.exec(lines[0])
  if (!match || /[\x00-\x1f\x7f]/.test(match[2])) {
    fail('deployment admin header must be Authorization Bearer or Cookie')
  }
  if (match[1] === 'Authorization' && !match[2].startsWith('Bearer ')) {
    fail('deployment Authorization header must use Bearer')
  }
  return [match[1], match[2]]
}

function createRequest(options) {
  const base = `http://127.0.0.1:${options.port}/api/ops/deployment/fence`
  if (options.action === 'status') {
    const url = new URL(`${base}/status`)
    if (options.releaseId) url.searchParams.set('releaseId', options.releaseId)
    if (options.slot) url.searchParams.set('slot', options.slot)
    if (options.generation) url.searchParams.set('generation', String(options.generation))
    url.searchParams.set('requireActive', String(options.requireActive))
    return { method: 'GET', url, body: undefined }
  }

  if (options.action === 'revoke') {
    return {
      method: 'POST',
      url: new URL(`${base}/revoke`),
      body: {
        releaseId: options.releaseId,
        slot: options.slot,
        generation: options.generation,
        dryRun: options.dryRun
      }
    }
  }

  return {
    method: 'POST',
    url: new URL(`${base}/acquire`),
    body: {
      releaseId: options.releaseId,
      slot: options.slot,
      generation: options.generation,
      imageDigest: options.imageDigest,
      expectedReleaseId: options.expectedReleaseId ?? null,
      expectedSlot: options.expectedSlot ?? null,
      expectedGeneration: options.expectedGeneration ?? null,
      dryRun: options.dryRun
    }
  }
}

async function invoke(options, authorization) {
  const request = createRequest(options)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(request.url, {
      method: request.method,
      signal: controller.signal,
      headers: {
        [authorization[0]]: authorization[1],
        Origin: options.origin,
        Accept: 'application/json',
        ...(request.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: request.body ? JSON.stringify(request.body) : undefined
    })
    const text = await response.text()
    let result
    try {
      result = JSON.parse(text)
    } catch {
      fail(`active release fence returned non-JSON HTTP ${response.status}`)
    }
    return { request, httpStatus: response.status, result }
  } finally {
    clearTimeout(timeout)
  }
}

function sanitizeRequest(request) {
  return {
    method: request.method,
    endpoint: request.url.toString(),
    body: request.body
  }
}

async function writeEvidence(options, invocation) {
  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    issue: 1030,
    observedAtUtc: new Date().toISOString(),
    operation: options.action,
    dryRun: options.dryRun,
    trustedLoopback: true,
    authenticatedAdminHeaderPresent: true,
    request: sanitizeRequest(invocation.request),
    httpStatus: invocation.httpStatus,
    result: invocation.result
  }
  const output = path.resolve(options.output)
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  if (invocation.result?.accepted !== true) process.exitCode = 2
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const authorization = await readAdminHeader(options.adminHeaderFile)
  const invocation = await invoke(options, authorization)
  await writeEvidence(options, invocation)
}

main().catch(error => {
  process.stderr.write(`[active-release-fence] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
