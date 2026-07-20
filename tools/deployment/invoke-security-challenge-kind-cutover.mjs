#!/usr/bin/env node

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

function fail(message) { throw new Error(message) }

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined) fail(`invalid argument near ${flag ?? '<end>'}`)
    options[flag.slice(2)] = value
  }
  return options
}

function required(options, name) {
  const value = options[name]?.trim()
  if (!value) fail(`--${name} is required`)
  return value
}

function positiveInteger(value, name) {
  if (!/^\d+$/u.test(value) || Number(value) < 1) fail(`--${name} must be a positive integer`)
  return Number(value)
}

async function adminHeader(file) {
  const metadata = await stat(file)
  const mode = metadata.mode & 0o777
  if (mode !== 0o400 && mode !== 0o600) fail('deployment admin header file must have mode 0400 or 0600')
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean)
  const match = /^(Authorization|Cookie): (.+)$/u.exec(lines.length === 1 ? lines[0] : '')
  if (!match || /[\x00-\x1f\x7f]/u.test(match[2])) fail('deployment admin header file must contain one safe Authorization or Cookie header')
  if (match[1] === 'Authorization' && !match[2].startsWith('Bearer ')) fail('deployment Authorization header must use Bearer')
  return [match[1], match[2]]
}

async function atomicJson(file, value) {
  const output = path.resolve(file)
  await mkdir(path.dirname(output), { recursive: true })
  const temporary = `${output}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, output)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const port = positiveInteger(required(options, 'port'), 'port')
  if (port > 65535) fail('--port must be at most 65535')
  const generation = positiveInteger(required(options, 'generation'), 'generation')
  const targets = JSON.parse(await readFile(required(options, 'targets'), 'utf8'))
  if (!Array.isArray(targets)) fail('target map must be a JSON array')
  const authorization = await adminHeader(required(options, 'admin-header-file'))
  const origin = required(options, 'origin')
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/u.test(origin)
      && !(process.env.FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE === '1' && /^http:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/u.test(origin))) {
    fail('--origin must be an explicit HTTPS origin')
  }
  const request = {
    operationId: required(options, 'operation-id'),
    releaseId: required(options, 'release-id'),
    slot: required(options, 'slot'),
    generation,
    targets,
    dryRun: false
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  let response
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/ops/deployment/fence/challenge-kind-cutover`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        [authorization[0]]: authorization[1],
        Origin: origin,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request)
    })
  } finally {
    clearTimeout(timeout)
  }
  const body = await response.text()
  let receipt
  try { receipt = JSON.parse(body) } catch { fail(`cutover endpoint returned non-JSON HTTP ${response.status}`) }
  await atomicJson(required(options, 'receipt'), receipt)
  if (!response.ok || receipt?.accepted !== true || receipt?.status !== 'applied') {
    fail(`cutover endpoint rejected the activation with HTTP ${response.status}`)
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

main().catch((error) => {
  process.stderr.write(`[challenge-kind-cutover] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
