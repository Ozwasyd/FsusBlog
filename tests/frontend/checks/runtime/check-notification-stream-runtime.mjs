#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const clientRoot = process.cwd()
const repoRoot = resolve(clientRoot, '..', '..')
const clientSrcRoot = join(clientRoot, 'src')
const serverRoot = join(repoRoot, 'src', 'backend')
const notificationRuntimePath = join(clientSrcRoot, 'services', 'notificationStreamRuntime.ts')
const notificationComposablePath = join(clientSrcRoot, 'composables', 'useNotification.ts')
const securityAdapterPath = join(clientSrcRoot, 'adapters', 'binary', 'securityAdapter.ts')

const violations = []

function walkFiles(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'bin' || entry === 'obj') {
      continue
    }

    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)

    if (stats.isDirectory()) {
      walkFiles(fullPath, output)
      continue
    }

    output.push(fullPath)
  }

  return output
}

function report(filePath, message) {
  violations.push(`${relative(repoRoot, filePath).replaceAll('\\', '/')}: ${message}`)
}

for (const filePath of walkFiles(clientSrcRoot)) {
  if (!/\.(ts|tsx|vue|js|mjs)$/.test(filePath)) {
    continue
  }

  const source = readFileSync(filePath, 'utf8')
  if (source.includes('signalr:')) {
    report(filePath, 'legacy signalr window event bus residue detected')
  }

  if (source.includes("window.dispatchEvent(new CustomEvent('signalr:")
    || source.includes('window.dispatchEvent(new CustomEvent("signalr:')) {
    report(filePath, 'legacy signalr dispatchEvent residue detected')
  }
}

for (const filePath of walkFiles(serverRoot)) {
  if (!filePath.endsWith('.cs')) {
    continue
  }

  const source = readFileSync(filePath, 'utf8')
  if (source.includes('Response.Body.FlushAsync(')) {
    report(filePath, 'direct Response.Body.FlushAsync detected in server stream path')
  }
}

const notificationRuntimeSource = readFileSync(notificationRuntimePath, 'utf8')
const notificationComposableSource = readFileSync(notificationComposablePath, 'utf8')
const securityAdapterSource = readFileSync(securityAdapterPath, 'utf8')

for (const required of [
  "'X-Fsus-Challenge-Proof'",
  "'X-Fsus-Challenge-Id'",
  "'X-Fsus-Challenge-Kind'",
  "'challengeProof'",
  "'challengeId'",
  "'challengeKind'"
]) {
  if (!notificationRuntimeSource.includes(required)) {
    report(notificationRuntimePath, `notification stream runtime must propagate RiskControl proof field ${required}`)
  }
}

if (!notificationComposableSource.includes('RiskChallengeRequired')) {
  report(notificationComposablePath, 'notification stream composable must recover from RiskChallengeRequired handshakes')
}

if (!notificationComposableSource.includes('createSecurityChallengeClient')) {
  report(notificationComposablePath, 'notification stream composable must use the shared security challenge client')
}

if (!/const\s+pow\s*=\s*await\s+getOrRefreshPow\(\)\s*[\s\S]{0,180}notificationStreamRuntime\.start\(pow,\s*notificationStreamStore\.runtime\.cursor,\s*'guest'\)/.test(notificationComposableSource)) {
  report(notificationComposablePath, 'guest notification stream initialization must send legacy PoW on the first preflight')
}

if (!securityAdapterSource.includes('view.setInt32(headerBytes, blobBytes, true)')) {
  report(securityAdapterPath, 'security challenge request encoder must include BinaryPodWriter.WriteBytes length prefix')
}

for (const line of violations) {
  console.error(`[notification-stream-runtime] ${line}`)
}

if (violations.length > 0) {
  process.exit(1)
}

console.log('[notification-stream-runtime] ok')
