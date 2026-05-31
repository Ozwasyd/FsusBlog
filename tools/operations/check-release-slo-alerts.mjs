#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const defaultReport = path.join(rootDir, '.tmp', 'operations', 'slo-alert-fixture.json')

function fail(message) {
  console.error(`[release-slo-alerts] ${message}`)
  process.exit(1)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function criticalFiringAlerts(report) {
  return (Array.isArray(report.alerts) ? report.alerts : [])
    .filter((alert) => alert?.severity === 'critical' && (alert.status ?? 'firing') === 'firing')
}

function validateReport(report, options = {}) {
  const errors = []
  if (report.status !== 'ok') {
    errors.push(`SLO alert report status must be ok, got ${String(report.status)}`)
  }

  const criticalAlerts = criticalFiringAlerts(report)
  if (criticalAlerts.length > 0 && !options.allowCritical) {
    errors.push(`critical alerts are firing: ${criticalAlerts.map((alert) => alert.id ?? 'unknown').join(', ')}`)
  }

  if (!report.generatedAt) {
    errors.push('generatedAt is required')
  }

  return {
    ok: errors.length === 0,
    errors,
    criticalAlerts
  }
}

function runSelfTest() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-slo-alerts-'))
  try {
    const okReport = {
      status: 'ok',
      generatedAt: '2026-05-30T00:00:00Z',
      alertCount: 1,
      alerts: [
        { id: 'redis_latency_high', status: 'resolved', severity: 'warning' }
      ]
    }
    const okPath = path.join(tmpDir, 'ok.json')
    fs.writeFileSync(okPath, `${JSON.stringify(okReport, null, 2)}\n`)
    const ok = validateReport(readJson(okPath))
    if (!ok.ok) {
      fail(`self-test expected ok report to pass: ${ok.errors.join('; ')}`)
    }

    const blockedReport = {
      status: 'ok',
      generatedAt: '2026-05-30T00:00:00Z',
      alertCount: 1,
      alerts: [
        { id: 'ready_degraded', status: 'firing', severity: 'critical' }
      ]
    }
    const blocked = validateReport(blockedReport)
    if (blocked.ok || !blocked.errors.some((error) => error.includes('critical alerts'))) {
      fail('self-test expected firing critical alert to fail release closeout')
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log('[release-slo-alerts] self-test ok')
}

const args = process.argv.slice(2)
if (args.includes('--self-test')) {
  runSelfTest()
  process.exit(0)
}

const allowCritical = args.includes('--allow-critical')
const reportArg = args.find((arg) => !arg.startsWith('--'))
const reportPath = reportArg ? path.resolve(reportArg) : defaultReport
if (!fs.existsSync(reportPath)) {
  fail(`SLO alert report not found: ${reportPath}`)
}

const report = readJson(reportPath)
const result = validateReport(report, { allowCritical })
if (!result.ok) {
  for (const error of result.errors) {
    console.error(`[release-slo-alerts] violation: ${error}`)
  }
  process.exit(1)
}

console.log(`[release-slo-alerts] ok | critical=${result.criticalAlerts.length} file=${reportPath}`)
