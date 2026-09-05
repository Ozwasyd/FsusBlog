#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { selectBrowserContractScenarios } from '../../tests/browser-contract/contract.mjs'
import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import {
  candidatePlanPathForObservation,
  explicitJson,
  observationEnvelopeAuthorityFields,
  observationSourceReceipt,
  observationSourceState,
  observationUpstreamPath,
  seal,
  validateCandidatePlan,
  writeReceipt
} from '../fact-extractors/post-runtime/adapter.mjs'
import {
  productionBuildBinding,
  validateBrowserContractReceipt,
  validatePublicPreviewEvidenceBinding
} from '../release/test-evidence-receipts.mjs'
import {
  loadPostRuntimeProducerRegistry,
  root,
  validateProducerReceiptAgainstRegistry
} from '../test-matrix/post-runtime-producer-registry.mjs'

const classId = 'browser-behavior-contract'
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const fail = (message) => { throw new Error(`[browser-contract-observation-raw] ${message}`) }
const semanticDigest = (value) => `sha256:${digestValue(stable(value))}`
const bytesDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
const normalizedDigest = (value) => String(value ?? '').replace(/^sha256:/u, '')

function options(argv)
{
  const [command, ...args] = argv
  const parsed = { command }
  for (let index = 0; index < args.length; index += 2)
  {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value == null || value.startsWith('--')) fail(`invalid option near ${key ?? '<end>'}`)
    parsed[key.slice(2)] = value
  }
  return parsed
}

function fileReference(relative, repositoryRoot, label)
{
  const input = explicitJson(relative, label, repositoryRoot)
  const absolute = path.resolve(repositoryRoot, input.relative)
  return {
    value: input.value,
    ref: {
      path: input.relative,
      fileDigest: bytesDigest(absolute),
      contentDigest: input.value.contentDigest ?? null
    }
  }
}

function assertReference(reference, repositoryRoot, label)
{
  const current = fileReference(reference?.path, repositoryRoot, label)
  if (!digestPattern.test(String(reference?.fileDigest ?? ''))
    || current.ref.fileDigest !== reference.fileDigest
    || current.ref.contentDigest !== (reference.contentDigest ?? null))
  {
    fail(`${label} digest mismatch: ${reference?.path ?? '<missing>'}`)
  }
  return current
}

function qualityReports(evidence)
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

function dimensionIdentity(reports, field)
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

function exactScenarioFacts(browser)
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

function exactIdentities(plan, browser, buildBinding, repositoryRoot)
{
  const source = browser.sourceState ?? {}
  const run = browser.runIdentity ?? {}
  const lifecycle = browser.fixture?.lifecycle?.identity ?? {}
  const observationSchema = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
  const expectedBrowserId = `${plan.candidate.runId}${observationSchema.properties?.sourceState
    ?.properties?.runtimeId !== undefined ? ':' : '-'}browser-contract`
  if (source.commit !== plan.sourceState.commit
    || normalizedDigest(source.worktreeFingerprint) !== normalizedDigest(plan.sourceState.worktreeFingerprint)
    || buildBinding.receipt !== plan.build.receipt
    || buildBinding.receiptContentDigest !== plan.build.receiptContentDigest
    || browser.buildBinding?.receipt !== plan.build.receipt
    || browser.buildBinding?.receiptContentDigest !== plan.build.receiptContentDigest
    || run.commit !== plan.sourceState.commit || run.runId !== plan.candidate.runId
    || run.attemptId !== plan.candidate.attemptId
    || lifecycle.commit !== plan.sourceState.commit || lifecycle.runId !== plan.candidate.runId
    || lifecycle.attemptId !== plan.candidate.attemptId
    || plan.candidate.browserId !== expectedBrowserId
    )
  {
    fail('candidate, build, fixture, and Browser Contract identities do not exact-match')
  }
  if (browser.topology?.retries !== 0
    || browser.finalization?.state !== 'complete'
    || browser.finalization?.primary?.status !== 'success'
    || browser.finalization?.primary?.classification !== 'clean'
    || browser.finalization?.cleanup?.status === 'failure'
    || !Number.isInteger(browser.finalization?.persistence?.attemptCount)
    || browser.finalization.persistence.attemptCount < 1)
  {
    fail('Browser Contract is diagnostic, recovered, retried, or not terminal')
  }
  return {
    sourceCommit: plan.sourceState.commit,
    worktreeFingerprint: plan.sourceState.worktreeFingerprint,
    buildIdentity: plan.build.receiptContentDigest,
    candidateId: plan.candidate.candidateId,
    fixtureId: plan.candidate.fixtureId,
    profileId: plan.candidate.profileId,
    runtimeId: plan.candidate.runtimeId,
    browserIdentity: plan.candidate.browserId,
    releaseId: plan.candidate.releaseId,
    rolloutId: plan.candidate.rolloutId,
    runId: plan.candidate.runId,
    attemptId: plan.candidate.attemptId,
    producerId: plan.producerId,
    schemaIdentity: loadPostRuntimeProducerRegistry(repositoryRoot).observationClasses[classId].schema,
    sourceReceiptSchemaIdentity: browser.schema,
    browserExecutableIdentity: browser.playwright?.browserIdentity?.actual?.contentDigest,
    fixtureNamespace: browser.fixtureNamespace
  }
}

function browserSemanticFacts(browser, publicPreviewEvidence)
{
  const scenarioFacts = exactScenarioFacts(browser)
  const reports = qualityReports(publicPreviewEvidence)
  const issueRecords = scenarioFacts.scenarios.flatMap(({ id, issues }) =>
    issues.map((issue) => ({ scenarioId: id, kind: issue.kind, detail: issue.detail, expected: issue.expected })))
  const domRecords = reports.map(({ id, route, viewport, theme, locale, zoom, surfaceRole, machine, reviewer, status }) => ({
    id, route, viewport, theme, locale, zoom, surfaceRole, machine, reviewer, status
  }))
  const a11yRecords = reports.map(({ id, machine, status }) => ({
    id,
    status,
    hitTargets: machine?.hitTargets,
    focusClipping: machine?.focusClipping,
    localeCoherence: machine?.localeCoherence,
    primaryTask: machine?.primaryTask
  }))
  return {
    requiredTestIds: scenarioFacts.requiredTestIds,
    viewportId: dimensionIdentity(reports, 'viewport'),
    themeId: dimensionIdentity(reports, 'theme'),
    stateId: `clean-success:${semanticDigest(scenarioFacts.scenarios.map(({ id, status, classification }) => ({ id, status, classification })))}`,
    interactionDigest: semanticDigest(scenarioFacts.scenarios),
    domDigest: semanticDigest({
      runtimeAudit: browser.publicPreview.runtimeAudit,
      layoutAudit: browser.publicPreview.layoutAudit,
      sanitizationCheck: browser.publicPreview.sanitizationCheck,
      reports: domRecords
    }),
    a11yDigest: semanticDigest(a11yRecords),
    networkDigest: semanticDigest({
      requestFailureCount: browser.diagnostics.requestFailureCount,
      responseErrorCount: browser.diagnostics.responseErrorCount,
      issues: issueRecords.filter(({ kind }) => kind === 'request-failed' || kind === 'response')
    }),
    consoleDigest: semanticDigest({
      consoleIssueCount: browser.diagnostics.consoleIssueCount,
      pageErrorCount: browser.diagnostics.pageErrorCount,
      unexpectedIssueCount: browser.diagnostics.unexpectedIssueCount,
      issues: issueRecords.filter(({ kind }) => kind?.startsWith('console-') || kind === 'page-error')
    }),
    contractSatisfied: true,
    consoleClean: browser.diagnostics.unexpectedIssueCount === 0,
    screenshotOnly: false
  }
}

function typedBrowserSemanticFacts(legacyFacts)
{
  return {
    contractTestId: legacyFacts.requiredTestIds.join('+'),
    viewport: legacyFacts.viewportId,
    theme: legacyFacts.themeId,
    stateDigest: semanticDigest(legacyFacts.stateId),
    interactionDigest: legacyFacts.interactionDigest,
    domDigest: legacyFacts.domDigest,
    a11yDigest: legacyFacts.a11yDigest,
    networkDigest: legacyFacts.networkDigest,
    consoleDigest: legacyFacts.consoleDigest
  }
}

export function projectBrowserContractRaw({ candidatePlan, browserContractReceipt, repositoryRoot = root })
{
  const planInput = fileReference(candidatePlan, repositoryRoot, 'candidate plan')
  const plan = validateCandidatePlan(planInput.value, { repositoryRoot })
  const planned = plan.observations.find((entry) => entry.classId === classId)
  if (!planned) fail('candidate plan does not own browser-behavior-contract')
  const browserInput = fileReference(browserContractReceipt, repositoryRoot, 'Browser Contract receipt')
  if (browserInput.ref.path === planned.receiptPath) fail('Browser Contract source and raw output paths must be distinct')
  const buildInput = fileReference(plan.build.receipt, repositoryRoot, 'production build receipt')
  const buildBinding = productionBuildBinding(buildInput.value, buildInput.ref.path)
  const browserErrors = validateBrowserContractReceipt(browserInput.value, {
    expectedCommit: plan.sourceState.commit,
    expectedFingerprint: plan.sourceState.worktreeFingerprint,
    expectedBuildReceiptDigest: plan.build.receiptContentDigest,
    requireSuccess: true
  })
  if (browserErrors.length > 0) fail(`Browser Contract is non-qualifying: ${browserErrors.join('; ')}`)
  const evidencePath = browserInput.value.publicPreview?.evidencePath
  const publicPreviewInput = fileReference(evidencePath, repositoryRoot, 'public-preview evidence')
  const evidenceErrors = validatePublicPreviewEvidenceBinding(browserInput.value.publicPreview, publicPreviewInput.value, {
    expectedCommit: plan.sourceState.commit,
    evidenceFileDigest: publicPreviewInput.ref.fileDigest
  })
  if (evidenceErrors.length > 0) fail(`public-preview evidence is non-qualifying: ${evidenceErrors.join('; ')}`)
  const legacySourceState = exactIdentities(plan, browserInput.value, buildBinding, repositoryRoot)
  const legacyFacts = browserSemanticFacts(browserInput.value, publicPreviewInput.value)
  if (legacyFacts.consoleClean !== true) fail('Browser Contract console/network audit is not clean')
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  const definition = registry.observationClasses[classId]
  const semanticFacts = Array.isArray(definition.requiredSemanticFactFields)
    ? typedBrowserSemanticFacts(legacyFacts)
    : legacyFacts
  const producer = registry.producers.find(({ producerId }) => producerId === plan.producerId)
  if (!producer) fail('candidate plan producer is absent from registry')
  const sourceState = observationSourceState({
    plan,
    artifactDigest: browserInput.ref.fileDigest,
    repositoryRoot,
    legacy: legacySourceState
  })
  const canonicalRerunCommand = `node tools/test-evidence/browser-contract-observation-raw.mjs project --candidate-plan ${planInput.ref.path} --browser-contract ${browserInput.ref.path} --out ${planned.receiptPath}`
  const independentVerifyCommand = `node tools/test-evidence/browser-contract-observation-raw.mjs verify --candidate-plan ${planInput.ref.path} --receipt ${planned.receiptPath}`
  return seal({
    schema: planned.schema,
    producerId: plan.producerId,
    toolVersion: producer.toolVersion,
    sourceState,
    executionClass: 'correctness',
    evidenceClass: 'correctness',
    qualificationEligible: true,
    planned: true,
    executed: true,
    outcome: 'passed',
    recovered: false,
    modes: planned.requiredModes,
    terminal: { timeout: false, cancelled: false, processTreeTerminated: false, priorAttemptDigest: null },
    semanticFacts,
    ...observationEnvelopeAuthorityFields({ plan, candidatePlanRef: planInput.ref, repositoryRoot }),
    sourceReceiptRef: observationSourceReceipt({
      classId, plan, sourceState, upstreamRef: browserInput.ref,
      upstreamSchema: browserInput.value.schema,
      canonicalRerunCommand, independentVerifyCommand, repositoryRoot
    }),
    canonicalRerunCommand,
    independentVerifyCommand
  })
}

export function verifyBrowserContractRaw(receiptPath, repositoryRoot = root, candidatePlan = null)
{
  const input = fileReference(receiptPath, repositoryRoot, 'browser raw receipt')
  const receipt = input.value
  assertReference(receipt.sourceReceiptRef, repositoryRoot, 'Browser Contract dependency')
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  validateProducerReceiptAgainstRegistry({
    registry, producerId: receipt.producerId, receipt, classId, repositoryRoot
  })
  const planPath = candidatePlanPathForObservation(receipt, candidatePlan)
  const plan = validateCandidatePlan(explicitJson(planPath, 'candidate plan', repositoryRoot).value, { repositoryRoot })
  const planned = plan.observations.find((entry) => entry.classId === classId)
  if (!planned || input.ref.path !== planned.receiptPath) fail('browser raw receipt path does not exact-match candidate plan')
  const replay = projectBrowserContractRaw({
    candidatePlan: planPath,
    browserContractReceipt: observationUpstreamPath(receipt, repositoryRoot),
    repositoryRoot
  })
  if (replay.contentDigest !== receipt.contentDigest) fail('browser raw replay mismatch')
  return receipt
}

function main()
{
  const parsed = options(process.argv.slice(2))
  if (parsed.command === 'project')
  {
    const receipt = projectBrowserContractRaw({
      candidatePlan: parsed['candidate-plan'],
      browserContractReceipt: parsed['browser-contract'],
      repositoryRoot: root
    })
    const plan = explicitJson(parsed['candidate-plan'], 'candidate plan', root).value
    const planned = plan.observations.find((entry) => entry.classId === classId)
    const output = parsed.out ?? planned?.receiptPath
    if (!output || output !== planned?.receiptPath) fail('raw output path must exact-match the candidate plan')
    writeReceipt(output, receipt, root)
    verifyBrowserContractRaw(output, root, parsed['candidate-plan'])
    process.stdout.write(`[browser-contract-observation-raw] projected path=${output} digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command === 'verify')
  {
    const receipt = verifyBrowserContractRaw(parsed.receipt, root, parsed['candidate-plan'])
    process.stdout.write(`[browser-contract-observation-raw] verified digest=${receipt.contentDigest}\n`)
    return
  }
  fail('usage: project --candidate-plan <path> --browser-contract <path> --out <planned-path> or verify --receipt <path>')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  try { main() }
  catch (error)
  {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  }
}
