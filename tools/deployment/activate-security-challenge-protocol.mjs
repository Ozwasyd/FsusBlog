#!/usr/bin/env node
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

function fail(message) { throw new Error(message) }
function parse(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) fail(`invalid argument near ${argv[i] ?? '<end>'}`)
    values[argv[i].slice(2)] = argv[i + 1]
  }
  return values
}
function required(values, name) {
  const value = values[name]?.trim()
  if (!value) fail(`--${name} is required`)
  return value
}
async function authorization(file) {
  const metadata = await stat(file)
  if (![0o400, 0o600].includes(metadata.mode & 0o777)) fail('deployment admin header file must have mode 0400 or 0600')
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean)
  const match = /^(Authorization|Cookie): (.+)$/u.exec(lines.length === 1 ? lines[0] : '')
  if (!match) fail('deployment admin header file must contain one Authorization or Cookie header')
  return [match[1], match[2]]
}
async function main() {
  const options = parse(process.argv.slice(2))
  const port = Number(required(options, 'port'))
  const generation = Number(required(options, 'generation'))
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(generation) || generation < 1) fail('port/generation is invalid')
  const auth = await authorization(required(options, 'admin-header-file'))
  const origin = required(options, 'origin')
  const body = { operationId: required(options, 'operation-id'), requestFingerprint: required(options, 'request-fingerprint'), targetFingerprint: required(options, 'target-fingerprint'), releaseId: required(options, 'release-id'), slot: required(options, 'slot'), generation }
  const response = await fetch(`http://127.0.0.1:${port}/api/ops/deployment/fence/challenge-protocol-activate`, {
    method: 'POST',
    headers: { [auth[0]]: auth[1], Origin: origin, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  let result
  try { result = JSON.parse(text) } catch { fail(`protocol activation returned non-JSON HTTP ${response.status}`) }
  const output = path.resolve(required(options, 'receipt'))
  await mkdir(path.dirname(output), { recursive: true })
  const temporary = `${output}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, output)
  if (!response.ok || result?.accepted !== true || result?.status !== 'open') fail(`protocol activation rejected with HTTP ${response.status}`)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
main().catch(error => {
  process.stderr.write(`[challenge-protocol-activation] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
