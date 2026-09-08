import { stable } from '../fact-extractors/lib/canonicalize.mjs'
import { selectBrowserContractScenarios } from '../../tests/browser-contract/contract-core.mjs'

const fail = (message) => { throw new Error(`[browser-contract-observation-raw] ${message}`) }

export function qualityReports(evidence)
{
  const quality = evidence?.quality
  const screenshots = Object.values(quality?.screenshots ?? {})
  const matrix = quality?.matrix?.reports ?? []
  if (quality?.status !== 'pass' || quality?.matrix?.status !== 'pass'
    || screenshots.length === 0 || matrix.length === 0
    || [...screenshots, ...matrix].some((report) => report?.status !== 'pass'))
  {
    fail('public-preview quality evidence is missing, partial, or non-passing')
  }
  const reports = [...screenshots, ...matrix]
  const requiredMachineFacts = [
    'overflow', 'overlaps', 'clippedText', 'hitTargets',
    'focusClipping', 'localeCoherence', 'primaryTask'
  ]
  for (const report of reports)
  {
    if (typeof report?.id !== 'string' || !report.id
      || report?.reviewer?.classification !== 'pass'
      || requiredMachineFacts.some((field) => report?.machine?.[field]?.status !== 'pass'))
    {
      fail(`public-preview DOM/a11y evidence is incomplete for ${report?.id ?? '<missing>'}`)
    }
  }
  return reports
}

export function dimensionIdentity(reports, field)
{
  const values = reports.map((report) => {
    if (field === 'viewport')
    {
      const width = report?.viewport?.width
      const height = report?.viewport?.height
      const zoom = report?.zoom ?? 1
      if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0
        || !Number.isFinite(zoom) || zoom <= 0)
      {
        fail('public-preview viewport evidence is incomplete')
      }
      return `${width}x${height}@${zoom}`
    }
    const value = String(report?.[field] ?? '').trim()
    if (!value) fail(`public-preview ${field} evidence is incomplete`)
    return value
  })
  return `${field}:${[...new Set(values)].sort().join('+')}`
}

export function exactScenarioFacts(browser)
{
  const expected = selectBrowserContractScenarios(browser.fixture?.capabilities)
  const expectedIds = expected.map(({ id }) => id).sort()
  const actualIds = (browser.scenarios ?? []).map(({ id }) => id).sort()
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds))
  {
    fail('Browser Contract scenario IDs do not exact-match the required test closure')
  }
  const authorities = new Map(expected.map((scenario) => [scenario.id, scenario]))
  for (const scenario of browser.scenarios)
  {
    const authority = authorities.get(scenario.id)
    if (scenario.capability !== authority.capability
      || scenario.status !== 'success' || scenario.classification !== 'clean'
      || typeof scenario.startedAt !== 'string' || typeof scenario.finishedAt !== 'string'
      || !Number.isFinite(scenario.durationMs) || scenario.durationMs < 0
      || !Array.isArray(scenario.issues) || !Array.isArray(scenario.artifacts)
      || scenario.error !== null)
    {
      fail(`Browser Contract scenario ${scenario.id} is missing clean executed facts`)
    }
    if (scenario.issues.some((issue) => typeof issue?.kind !== 'string'
      || typeof issue?.detail !== 'string' || typeof issue?.expected !== 'boolean'))
    {
      fail(`Browser Contract scenario ${scenario.id} has incomplete console/network facts`)
    }
  }
  return {
    requiredTestIds: expectedIds.map((id) => `browser-contract:${id}`),
    scenarios: browser.scenarios.map(({ id, capability, status, classification, issues }) => ({
      id, capability, status, classification, issues
    })).sort((left, right) => left.id.localeCompare(right.id))
  }
}

export function deriveBrowserObservedRawFacts(browser, publicPreviewEvidence)
{
  const scenarios = exactScenarioFacts(browser)
  const reports = qualityReports(publicPreviewEvidence)
  const issues = scenarios.scenarios.flatMap(({ id, issues: observed }) =>
    observed.map(({ kind, detail, expected }) => ({ scenarioId: id, kind, detail, expected })))
  return stable({
    contractTestId: scenarios.requiredTestIds.join('+'),
    viewport: dimensionIdentity(reports, 'viewport'),
    theme: dimensionIdentity(reports, 'theme'),
    state: scenarios.scenarios.map(({ id, status, classification }) => ({ id, status, classification })),
    interaction: scenarios.scenarios.map((scenario) => ({
      ...scenario,
      observation: browser.scenarios.find(({ id }) => id === scenario.id)?.observation ?? null
    })),
    dom: {
      runtimeAudit: browser.publicPreview.runtimeAudit,
      layoutAudit: browser.publicPreview.layoutAudit,
      sanitizationCheck: browser.publicPreview.sanitizationCheck,
      reports: reports.map(({ id, route, viewport, theme, locale, zoom, surfaceRole, machine, reviewer, status }) =>
        ({ id, route, viewport, theme, locale, zoom, surfaceRole, machine, reviewer, status }))
    },
    a11y: reports.map(({ id, machine, status }) => ({ id, status,
      hitTargets: machine?.hitTargets, focusClipping: machine?.focusClipping,
      localeCoherence: machine?.localeCoherence, primaryTask: machine?.primaryTask })),
    network: {
      requestFailureCount: browser.diagnostics.requestFailureCount,
      responseErrorCount: browser.diagnostics.responseErrorCount,
      issues: issues.filter(({ kind }) => kind === 'request-failed' || kind === 'response')
    },
    console: {
      consoleIssueCount: browser.diagnostics.consoleIssueCount,
      pageErrorCount: browser.diagnostics.pageErrorCount,
      unexpectedIssueCount: browser.diagnostics.unexpectedIssueCount,
      issues: issues.filter(({ kind }) => kind.startsWith('console-') || kind === 'page-error')
    }
  })
}
