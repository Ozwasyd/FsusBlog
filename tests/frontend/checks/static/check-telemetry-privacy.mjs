#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const telemetryPath = resolve(process.cwd(), 'src/services/telemetryService.ts')
const source = readFileSync(telemetryPath, 'utf8')
const auditConsolePath = resolve(process.cwd(), 'src/services/auditConsole.ts')
const auditConsole = readFileSync(auditConsolePath, 'utf8')
const safeConsole = readFileSync(resolve(process.cwd(), 'src/services/safeConsole.ts'), 'utf8')
const binaryTransport = readFileSync(resolve(process.cwd(), 'src/services/binaryTransport.ts'), 'utf8')
const privacy = readFileSync(resolve(process.cwd(), 'src/services/telemetryPrivacy.ts'), 'utf8')

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

assert(source.includes('PerformanceObserver'), 'telemetry must use PerformanceObserver for browser performance signals')
assert(source.includes("emitPerformanceTelemetry('web_vital_lcp'"), 'LCP telemetry must be emitted through the public-page helper')
assert(source.includes("emitPerformanceTelemetry('web_vital_cls'"), 'CLS telemetry must be emitted through the public-page helper')
assert(source.includes("emitPerformanceTelemetry('navigation_timing'"), 'navigation timing telemetry must be emitted through the public-page helper')
assert(source.includes("if (pageType === 'private')"), 'private /user and /admin pages must not emit RUM events')
assert(source.includes("payload.name.startsWith('web_vital_')"), 'web vital telemetry must be classified as performance data')
assert(source.includes("payload.name === 'navigation_timing'"), 'navigation timing telemetry must be classified as performance data')
assert(auditConsole.includes('VITE_FSUSBLOG_AUDIT_CONSOLE_INFO'), 'info telemetry console output must require an explicit diagnostics flag')
assert(auditConsole.includes('return isInfoAuditConsoleEnabled() ? safeConsoleInfo : null'), 'info telemetry must be silent in the console by default')
assert(auditConsole.includes('redactAuditContext(record.context)'), 'audit console must use the shared telemetry redactor')
assert(safeConsole.includes('redactConsoleArguments(data)'), 'safe console must redact in development and production')
assert(safeConsole.includes('original.apply(console, redactConsoleArguments(data))'), 'global console guard must use the same redactor')
assert(!binaryTransport.includes('fsus:binary:failure'), 'binary failure global CustomEvent must stay removed')
assert(!binaryTransport.includes('fsus:binary:error'), 'unused binary error global CustomEvent must stay removed')
assert(binaryTransport.includes('recordBinaryFailureTelemetry({'), 'binary transport must use the private failure recorder')
assert(privacy.includes('BINARY_FAILURE_TELEMETRY_FIELDS'), 'binary failure telemetry must expose a static allowlist')
for (const field of ['operationId', 'routeClass', 'status', 'errorCode', 'category', 'frameType']) {
  assert(privacy.includes(`'${field}'`), `binary failure telemetry allowlist must include ${field}`)
}

const forbidden = [
  'document.cookie',
  'window.location.href',
  'localStorage.getItem(\'token\')',
  'localStorage.getItem("token")',
  'email',
  'username',
  'password'
]

for (const token of forbidden) {
  assert(!source.includes(token), `telemetry must not collect sensitive field: ${token}`)
}

for (const token of ['/api/telemetry/rum', 'application/json', 'response.json', 'JSON.stringify']) {
  assert(!source.includes(token), `telemetry must not retain JSON fallback compatibility: ${token}`)
}

console.log('[check-telemetry-privacy] ok')
