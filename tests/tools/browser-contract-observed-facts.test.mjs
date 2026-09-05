import assert from 'node:assert/strict'
import test from 'node:test'

import { browserContractScenarios } from '../browser-contract/contract-core.mjs'
import { deriveBrowserObservedRawFacts } from '../../tools/test-evidence/browser-contract-observed-facts.mjs'

function fixture()
{
  const machine = Object.fromEntries(['overflow', 'overlaps', 'clippedText', 'hitTargets',
    'focusClipping', 'localeCoherence', 'primaryTask'].map((key) => [key, { status: 'pass', findings: [] }]))
  const report = { id: 'observed-view', route: 'Home', viewport: { width: 800, height: 600 },
    theme: 'light', locale: 'zh-CN', zoom: 1, surfaceRole: 'public', machine,
    status: 'pass', reviewer: { classification: 'pass' } }
  return {
    browser: {
      fixture: { capabilities: { webAuthnRegistration: true } },
      scenarios: browserContractScenarios.map(({ id, capability }) => ({ id, capability,
        status: 'success', classification: 'clean', startedAt: '2026-09-04T00:00:00Z',
        finishedAt: '2026-09-04T00:00:01Z', durationMs: 1000, issues: [], artifacts: [], error: null,
        observation: { observedAction: id } })),
      publicPreview: { runtimeAudit: true, layoutAudit: true, sanitizationCheck: true },
      diagnostics: { requestFailureCount: 0, responseErrorCount: 0, consoleIssueCount: 0,
        pageErrorCount: 0, unexpectedIssueCount: 0 }
    },
    preview: { quality: { status: 'pass', screenshots: { observed: report },
      matrix: { status: 'pass', reports: [report] } } }
  }
}

test('pure Browser projection preserves observed interaction and DOM values', () =>
{
  const { browser, preview } = fixture()
  const raw = deriveBrowserObservedRawFacts(browser, preview)
  assert.equal(raw.interaction.length, browserContractScenarios.length)
  assert.equal(raw.interaction[0].observation.observedAction, raw.interaction[0].id)
  assert.equal(raw.dom.reports[0].viewport.width, 800)
  browser.scenarios[0].observation.observedAction = 'changed-observation'
  assert.notDeepEqual(deriveBrowserObservedRawFacts(browser, preview), raw)
})

test('pure Browser projection rejects missing scenarios and incomplete quality observations', () =>
{
  const value = fixture()
  value.browser.scenarios.pop()
  assert.throws(() => deriveBrowserObservedRawFacts(value.browser, value.preview), /scenario IDs/u)
  const quality = fixture()
  quality.preview.quality.matrix.reports[0].machine.hitTargets.status = 'fail'
  assert.throws(() => deriveBrowserObservedRawFacts(quality.browser, quality.preview), /DOM\/a11y evidence/u)
})

test('pure Browser projection retains real diagnostic records without inventing clean evidence', () =>
{
  const { browser, preview } = fixture()
  browser.scenarios[0].issues.push({ kind: 'response', detail: 'observed HTTP 503', expected: false })
  browser.diagnostics.responseErrorCount = 1
  browser.diagnostics.unexpectedIssueCount = 1
  const raw = deriveBrowserObservedRawFacts(browser, preview)
  assert.equal(raw.network.responseErrorCount, 1)
  assert.equal(raw.network.issues[0].detail, 'observed HTTP 503')
  assert.equal(raw.console.unexpectedIssueCount, 1)
})
