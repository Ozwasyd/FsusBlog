import assert from 'node:assert/strict'
import test from 'node:test'

import { parseUxRiskCliTimingLine } from '../../tools/ux/ux-risk-cli-timing.mjs'

const validSummary = {
  schema: 'fsusblog.ux-viewport-risk-timing.v1',
  status: 'passed',
  groupId: 'public-article::light',
  elapsedMs: 812.34,
  phases: {
    'context.open': { calls: 1, totalMs: 320.1 }
  }
}

test('CLI timing parser ignores unrelated Playwright output and accepts reporter prefixes', () => {
  assert.equal(parseUxRiskCliTimingLine('  1 passed (1.2s)'), null)
  assert.deepEqual(
    parseUxRiskCliTimingLine(`\u001b[2mstdout | test\u001b[22m [ux-risk-timing] ${JSON.stringify(validSummary)}`),
    validSummary
  )
})

test('CLI timing parser rejects malformed or incomplete evidence', () => {
  assert.throws(
    () => parseUxRiskCliTimingLine('[ux-risk-timing] {'),
    /invalid UX risk CLI timing JSON/u
  )
  assert.throws(
    () => parseUxRiskCliTimingLine(`[ux-risk-timing] ${JSON.stringify({ ...validSummary, groupId: '' })}`),
    /requires groupId/u
  )
  assert.throws(
    () => parseUxRiskCliTimingLine(`[ux-risk-timing] ${JSON.stringify({ ...validSummary, elapsedMs: -1 })}`),
    /invalid UX risk CLI timing elapsedMs/u
  )
})
