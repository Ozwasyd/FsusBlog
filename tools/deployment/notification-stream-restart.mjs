#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isValidReleaseId } from '../release/release-id.mjs';

const DEFAULT_OUTPUT = '.tmp/deployment/notification-stream-restart.json';

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const action = argv.shift()
  if (action !== 'restart' && action !== 'status') {
    fail('usage: notification-stream-restart.mjs <restart|status> [options]')
  }
  const options = {
    action,
    port: undefined,
    releaseId: undefined,
    slot: undefined,
    generation: undefined,
    reason: 'deployment_drain',
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
    const value = argv.shift()
    if (value === undefined) fail(`${flag} requires a value`)
    switch (flag) {
      case '--port': options.port = Number(value); break
      case '--release': options.releaseId = value; break
      case '--slot': options.slot = value; break
      case '--generation': options.generation = Number(value); break
      case '--reason': options.reason = value; break
      case '--admin-header-file': options.adminHeaderFile = value; break
      case '--origin': options.origin = value; break
      case '--out': options.output = value; break
      default: fail(`unknown argument: ${flag}`)
    }
  }
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
        fail('--port must be between 1 and 65535');
    }
    if (action === 'restart')
{
        if (!isValidReleaseId(options.releaseId)) {fail('--release is invalid')};
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(options.slot ?? '')) {fail('--slot is invalid')};
        if (!Number.isSafeInteger(options.generation) || options.generation < 1) {fail('--generation is required')};
    }
  if (!options.adminHeaderFile) fail('--admin-header-file is required')
  if (!isAllowedOrigin(options.origin)) fail('--origin must be an explicit HTTPS origin')
  return options
}

function isAllowedOrigin(origin) {
  if (typeof origin !== 'string') return false
  if (/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(origin)) return true
  return process.env.FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE === '1'
    && /^http:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(origin)
}

async function authorizationHeader(file) {
  const metadata = await stat(file)
  const mode = metadata.mode & 0o777
  if (mode !== 0o400 && mode !== 0o600) fail('admin header file must have mode 0400 or 0600')
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean)
  if (lines.length !== 1) fail('admin header file must contain exactly one line')
  const match = /^(Authorization|Cookie): (.+)$/.exec(lines[0])
  if (!match || (match[1] === 'Authorization' && !match[2].startsWith('Bearer '))) {
    fail('admin header must be Authorization Bearer or Cookie')
  }
  return [match[1], match[2]]
}

async function invoke(options, authorization) {
  const endpoint = `http://127.0.0.1:${options.port}/api/ops/deployment/notification-stream/restart`
  const method = options.action === 'restart' ? 'POST' : 'GET'
  const url = options.action === 'restart' ? endpoint : `${endpoint}/status`
  const body = options.action === 'restart'
    ? {
        releaseId: options.releaseId,
        slot: options.slot,
        generation: options.generation,
        reason: options.reason,
        dryRun: options.dryRun
      }
    : undefined
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        [authorization[0]]: authorization[1],
        Origin: options.origin,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })
    const result = await response.json()
    return { endpoint: url, method, body, httpStatus: response.status, result }
  } finally {
    clearTimeout(timeout)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const authorization = await authorizationHeader(options.adminHeaderFile)
  const invocation = await invoke(options, authorization)
  const evidence = {
    schemaVersion: 'fsus.notification-stream-restart-evidence.v1',
    issue: 1030,
    observedAtUtc: new Date().toISOString(),
    operation: options.action,
    dryRun: options.dryRun,
    trustedLoopback: true,
    authenticatedAdminHeaderPresent: true,
    request: {
      endpoint: invocation.endpoint,
      method: invocation.method,
      body: invocation.body
    },
    httpStatus: invocation.httpStatus,
    result: invocation.result
  }
  const output = path.resolve(options.output)
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  if (invocation.result?.accepted !== true) process.exitCode = 2
}

main().catch(error => {
  process.stderr.write(`[notification-stream-restart] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
