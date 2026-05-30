#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const telemetryPath = resolve(process.cwd(), 'src/services/telemetryService.ts')
const source = readFileSync(telemetryPath, 'utf8')

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

console.log('[check-telemetry-privacy] ok')
