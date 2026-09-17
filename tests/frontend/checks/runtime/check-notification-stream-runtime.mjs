#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectExecution, reportDirectFailure } from '../../support/direct-execution.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const clientRoot = join(repoRoot, 'src', 'frontend')
const clientSrcRoot = join(clientRoot, 'src')
const serverRoot = join(repoRoot, 'src', 'backend')
const notificationRuntimePath = join(clientSrcRoot, 'services', 'notificationStreamRuntime.ts')
const notificationComposablePath = join(clientSrcRoot, 'composables', 'useNotification.ts')
const securityRequestEncoderPath = join(clientSrcRoot, 'codecs', 'binary', 'securityRequestEncoder.ts')

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

export function runNotificationStreamContract() {
violations.length = 0
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
const securityRequestEncoderSource = readFileSync(securityRequestEncoderPath, 'utf8')

for (const required of [
  "'X-Fsus-Challenge-Proof'",
  "'X-Fsus-Challenge-Id'",
  "'X-Fsus-Challenge-Kind'",
  'SecurityChallengeProofLease',
  'markInFlight()',
  'settleCurrentChallengeLease'
]) {
  if (!notificationRuntimeSource.includes(required)) {
    report(notificationRuntimePath, `notification stream runtime must propagate RiskControl proof field ${required}`)
  }
}

for (const forbidden of ["searchParams.set('challengeProof'", "searchParams.set('challengeId'", "searchParams.set('challengeKind'"]) {
  if (notificationRuntimeSource.includes(forbidden)) {
    report(notificationRuntimePath, `notification stream runtime must not place RiskControl proof material in URL: ${forbidden}`)
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

if (!securityRequestEncoderSource.includes('view.setInt32(headerBytes, blobBytes, true)')) {
  report(securityRequestEncoderPath, 'security challenge request encoder must include BinaryPodWriter.WriteBytes length prefix')
}

for (const line of violations) {
  console.error(`[notification-stream-runtime] ${line}`)
}

if (violations.length > 0) {
  throw new Error(`notification stream runtime contract has ${violations.length} violation(s)`)
}

console.log('[notification-stream-runtime] ok')
return { violationCount: 0 }
}

if (isDirectExecution(import.meta.url)) {
  Promise.resolve()
    .then(() => runNotificationStreamContract())
    .catch((error) => reportDirectFailure('notification-stream-runtime', error))
}
