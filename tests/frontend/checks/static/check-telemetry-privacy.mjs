#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const telemetryPath = resolve(process.cwd(), 'src/services/telemetryService.ts')
const source = readFileSync(telemetryPath, 'utf8')
const auditConsolePath = resolve(process.cwd(), 'src/services/auditConsole.ts')
const auditConsole = readFileSync(auditConsolePath, 'utf8')

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
