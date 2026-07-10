#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  UX_VIEWPORT_MODEL_ROUTE_IDS,
  buildUxViewportPlan
} from '../../tests/frontend/support/playwright/uxViewportPlan.mjs'
import { writeUxViewportSummary } from '../../tests/frontend/checks/ux/write-ux-viewport-summary.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const frontend = path.join(root, 'src/frontend')
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'tests/frontend/fixtures/ux-viewport-matrix.json'), 'utf8'))
const routes = UX_VIEWPORT_MODEL_ROUTE_IDS.map((id) => ({
  id,
  storage: id.startsWith('public-') ? 'anonymous' : id.startsWith('user-') ? 'user' : 'admin'
}))
const fullPlan = buildUxViewportPlan({ matrix, routes, mode: 'boundaries' })
const riskPlan = buildUxViewportPlan({ matrix, routes, mode: 'boundaries', filters: { riskMatrix: true } })

if (fullPlan.counts.cases !== 6468) throw new Error(`full UX model must contain 6468 cases, got ${fullPlan.counts.cases}`)
if (riskPlan.counts.navigations > 48) throw new Error(`risk UX runtime exceeds 48 navigations: ${riskPlan.counts.navigations}`)

const cli = path.join(frontend, 'node_modules/@playwright/test/cli.js')
const args = [cli, 'test', '--workers=2', 'ux/viewport-boundaries.spec.ts']
const runId = `local-production-risk-${Date.now()}`
const child = spawn(process.execPath, args, {
  cwd: frontend,
  env: {
    ...process.env,
    FSUSBLOG_UX_VIEWPORT_MODE: 'boundaries',
    FSUSBLOG_UX_VIEWPORT_RISK_MATRIX: '1',
    FSUSBLOG_UX_VIEWPORT_SCREENSHOTS: '1',
    FSUSBLOG_UX_VIEWPORT_WORKERS: '2',
    FSUSBLOG_UX_VIEWPORT_RESUME: '0',
    FSUSBLOG_UX_VIEWPORT_RUN_ID: runId,
    FSUSBLOG_UX_VIEWPORT_RUN_TOKEN: `${runId}-token`,
    PLAYWRIGHT_OUTPUT_DIR: 'test-results/playwright/local-production-risk'
  },
  stdio: 'inherit'
})
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', (code) => resolve(code ?? 1))
})
if (exitCode !== 0) throw new Error(`risk Playwright batch exited ${exitCode}`)

const { summary } = await writeUxViewportSummary({ root, mode: 'boundaries' })
if (summary.status !== 'ok' || summary.plannedNavigationCount !== riskPlan.counts.navigations) {
  throw new Error(`risk UX summary is incomplete: status=${summary.status} navigations=${summary.plannedNavigationCount}`)
}
const evidence = {
  schema: 'fsusblog.local-production.ux-risk.v1',
  status: 'success',
  executionSource: 'fresh',
  fullModel: fullPlan.counts,
  runtimeRisk: riskPlan.counts,
  selection: riskPlan.selection,
  runtimeSummary: summary,
  generatedAt: new Date().toISOString()
}
const outFile = path.join(root, '.tmp/release-evidence/local-production-ux-risk.json')
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`[local-production:ux-risk] model=${fullPlan.counts.cases} navigations=${riskPlan.counts.navigations}`)
