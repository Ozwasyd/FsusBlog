#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyProductionBuildReceipt } from '../ci/production-build-artifacts.mjs'
import { validateBrowserContractReceipt } from '../release/test-evidence-receipts.mjs'
import { stable } from '../fact-extractors/lib/canonicalize.mjs'
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
import { validateSemanticFacts } from '../fact-extractors/post-runtime/semantic-contracts.mjs'
import {
  loadPostRuntimeProducerRegistry,
  root,
  validateProducerReceiptAgainstRegistry
} from '../test-matrix/post-runtime-producer-registry.mjs'

const classId = 'aot-spa-hydration'
export const sourceBundleSchema = 'fsusblog.aot-spa-hydration-source-bundle.v1'
const unsafePathPattern = /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const evidenceKeys = Object.freeze([
  'manifest', 'browserContract'
])
const fail = (message) => { throw new Error(`[aot-spa-hydration-raw] ${message}`) }
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

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

function explicitFile(relative, label, repositoryRoot, { json = false } = {})
{
  if (typeof relative !== 'string' || relative.length === 0 || unsafePathPattern.test(relative))
  {
    fail(`${label} requires an explicit current-run path`)
  }
  const resolvedRoot = path.resolve(repositoryRoot)
  const absolute = path.resolve(resolvedRoot, relative)
  if (!absolute.startsWith(`${resolvedRoot}${path.sep}`)) fail(`${label} escapes the repository`)
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute)
  {
    fail(`${label} must be a regular non-symlink file`)
  }
  const bytes = fs.readFileSync(absolute)
  const normalized = path.relative(resolvedRoot, absolute).replaceAll(path.sep, '/')
  let value = null
  if (json)
  {
    if (!normalized.endsWith('.json')) fail(`${label} must be JSON`)
    try { value = JSON.parse(bytes.toString('utf8')) }
    catch { fail(`${label} is not valid JSON`) }
  }
  return { absolute, bytes, value, ref: { path: normalized, fileDigest: sha(bytes) } }
}

function tagAttributes(tag)
{
  return Object.fromEntries([...tag.matchAll(/([a-zA-Z][\w:-]*)\s*=\s*["']([^"']*)["']/gu)]
    .map(([, key, value]) => [key.toLowerCase(), value]))
}

function htmlProjection(bytes)
{
  const html = bytes.toString('utf8')
  const htmlTag = html.match(/<html\b[^>]*>/iu)?.[0] ?? ''
  const shellTags = [...html.matchAll(/<[^>]+\bid=["']fsus-aot-shell["'][^>]*>/giu)].map(([tag]) => tag)
  const appCount = [...html.matchAll(/\bid=["']app["']/giu)].length
  const canonicalTags = [...html.matchAll(/<link\b[^>]*>/giu)]
    .map(([tag]) => tagAttributes(tag))
    .filter((attributes) => String(attributes.rel ?? '').split(/\s+/u).includes('canonical'))
  const seoMarkerCount = [...html.matchAll(/<script\b[^>]*data-fsus-seo-head-model(?:\s|=|>)[^>]*>/giu)].length
  const shell = shellTags.length === 1 ? tagAttributes(shellTags[0]) : {}
  let canonicalPath = null
  try
  {
    const canonical = canonicalTags[0]?.href
    const parsed = canonical ? new URL(canonical, 'https://fsusblog.invalid') : null
    canonicalPath = parsed ? `${parsed.pathname}${parsed.search}` : null
  }
  catch { canonicalPath = null }
  return stable({
    digest: sha(bytes),
    byteLength: bytes.byteLength,
    locale: tagAttributes(htmlTag).lang ?? null,
    canonicalPath,
    hydrationKind: shell['data-public-hydration-kind'] ?? null,
    appCount,
    shellCount: shellTags.length,
    seoMarkerCount
  })
}

function normalizedFacts(inputs, plan, buildReceipt)
{
  const manifest = inputs.manifest.value
  if (manifest.schema !== 'fsusblog.spa-manifest-descriptor.v1') fail('manifest evidence is not a SPA manifest descriptor')
  const descriptor = { ...manifest }
  const descriptorDigest = descriptor.contentDigest
  delete descriptor.contentDigest
  if (!digestPattern.test(String(descriptorDigest ?? '')) || seal(descriptor).contentDigest !== descriptorDigest)
  {
    fail('SPA manifest descriptor content digest mismatch')
  }
  if (manifest.sourceCommit !== plan.sourceState.commit
    || String(manifest.worktreeFingerprint).replace(/^sha256:/u, '')
      !== plan.sourceState.worktreeFingerprint.replace(/^sha256:/u, '')
    || manifest.buildReceiptDigest !== plan.build.receiptContentDigest
    || !digestPattern.test(String(manifest.manifestDigest ?? '')))
  {
    fail('SPA manifest descriptor does not exact-match the candidate build')
  }
  const frontendManifest = (buildReceipt.artifacts ?? [])
    .filter(({ path: artifactPath }) => artifactPath.endsWith('frontend-dist/.vite/manifest.json'))
  if (frontendManifest.length !== 1 || frontendManifest[0].sha256 !== manifest.manifestDigest)
  {
    fail('SPA manifest descriptor does not match the immutable build manifest artifact')
  }

  const browser = inputs.browserContract.value
  const browserErrors = validateBrowserContractReceipt(browser, {
    expectedCommit: plan.sourceState.commit,
    expectedFingerprint: plan.sourceState.worktreeFingerprint,
    expectedBuildReceiptDigest: plan.build.receiptContentDigest,
    requireSuccess: true
  })
  if (browserErrors.length > 0) fail(`Browser Contract authority is non-qualifying: ${browserErrors.join('; ')}`)
  const scenario = (browser.scenarios ?? []).find(({ id }) => id === 'public-hydration-history-reload')
  const observation = scenario?.observation
  if (scenario?.status !== 'success' || scenario.classification !== 'clean'
    || observation?.schema !== 'fsusblog.browser-contract-public-aot-observation.v1')
  {
    fail('canonical Browser Contract public hydration observation is missing')
  }
  const source = browser.sourceState ?? {}
  const lifecycle = browser.fixture?.lifecycle?.identity ?? {}
  if (source.commit !== plan.sourceState.commit
    || String(source.worktreeFingerprint ?? '').replace(/^sha256:/u, '')
      !== plan.sourceState.worktreeFingerprint.replace(/^sha256:/u, '')
    || browser.buildBinding?.receiptContentDigest !== plan.build.receiptContentDigest
    || browser.runIdentity?.runId !== plan.candidate.runId
    || lifecycle.runId !== plan.candidate.runId)
  {
    fail('Browser Contract source/build/run/fixture identity does not match the candidate')
  }
  const htmlBytes = Buffer.from(String(observation.response?.serverHtml ?? ''), 'utf8')
  const serverHtml = htmlProjection(htmlBytes)
  const direct = observation.direct ?? {}
  const fixture = observation.fixture ?? {}
  const stableIdentity = (value) => value?.captured === true && value.appSame === true
    && value.shellSame === true && value.firstChildSame === true
    && value.childElementCountSame === true && value.hydrated === true
    && value.appCount === 1 && value.shellCount === 1
    && Array.isArray(value.violations) && value.violations.length === 0
  const resourceUrls = direct.resourceUrls ?? []
  let responseOrigin = null
  try { responseOrigin = new URL(observation.response?.url).origin } catch { responseOrigin = null }
  const resourcesCoherent = responseOrigin !== null && Array.isArray(resourceUrls) && resourceUrls.length > 0
    && resourceUrls.every((url) => {
      try { return new URL(url).origin === responseOrigin } catch { return false }
    })
  const coherent = observation.response?.status === 200
    && String(observation.response?.headers?.['content-type'] ?? '').toLowerCase().startsWith('text/html')
    && observation.response?.headers?.['x-fsus-release-id'] === plan.candidate.releaseId
    && fixture.articlePath === direct.route && fixture.articlePath === direct.canonicalPath
    && fixture.articlePath === serverHtml.canonicalPath
    && String(fixture.articleId) === fixture.articlePath.split('/').at(-1)
    && direct.title === fixture.articleTitle && direct.locale === serverHtml.locale
    && direct.hydrationKind === serverHtml.hydrationKind
    && direct.appCount === 1 && direct.shellCount === 1 && direct.hydrated === true
    && serverHtml.appCount === 1 && serverHtml.shellCount === 1 && serverHtml.seoMarkerCount === 1
    && String(direct.bootstrapText ?? '').length > 0
    && stableIdentity(observation.spa) && stableIdentity(observation.history) && stableIdentity(observation.reload)
    && resourcesCoherent && browser.diagnostics?.unexpectedIssueCount === 0
  if (!coherent)
  {
    fail('canonical server HTML and Browser Contract hydration outputs are not coherent')
  }

  return {
    buildDigest: plan.build.receiptContentDigest,
    manifestDigest: manifest.manifestDigest,
    publicationDigest: sha(Buffer.from(JSON.stringify(stable({
      url: observation.response.url,
      status: observation.response.status,
      headers: observation.response.headers
    })), 'utf8')),
    localeCanaryDigest: sha(Buffer.from(String(direct.locale), 'utf8')),
    dataCanaryDigest: sha(Buffer.from(String(direct.bootstrapText), 'utf8')),
    serverHtmlDigest: sha(htmlBytes),
    hydratedDomDigest: sha(Buffer.from(JSON.stringify(stable(direct)), 'utf8')),
    clientStateDigest: sha(Buffer.from(JSON.stringify(stable({
      spa: observation.spa,
      history: observation.history,
      reload: observation.reload
    })), 'utf8')),
    networkResourceDigest: sha(Buffer.from(JSON.stringify(resourceUrls), 'utf8')),
    coherent: true
  }
}

function typedFacts(inputs, legacyFacts)
{
  const scenario = inputs.browserContract.value.scenarios
    .find(({ id }) => id === 'public-hydration-history-reload')
  return {
    manifestDigest: legacyFacts.manifestDigest,
    publicationDigest: legacyFacts.publicationDigest,
    locale: scenario.observation.direct.locale,
    dataCanaryDigest: legacyFacts.dataCanaryDigest,
    serverHtmlDigest: legacyFacts.serverHtmlDigest,
    hydratedDomDigest: legacyFacts.hydratedDomDigest,
    clientStateDigest: legacyFacts.clientStateDigest,
    networkResourceDigest: legacyFacts.networkResourceDigest
  }
}

function loadInputs(evidence, repositoryRoot)
{
  if (!evidence || JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify([...evidenceKeys].sort()))
  {
    fail('evidence paths must contain the exact AOT evidence set')
  }
  return Object.fromEntries(evidenceKeys.map((key) => [key,
    explicitFile(evidence[key], `${key} evidence`, repositoryRoot, { json: true })]))
}

function planInput(candidatePlan, repositoryRoot)
{
  const input = explicitFile(candidatePlan, 'candidate plan', repositoryRoot, { json: true })
  const plan = validateCandidatePlan(input.value, { repositoryRoot })
  input.ref.contentDigest = plan.contentDigest
  return { input, plan }
}

function verifyBuild(plan, repositoryRoot)
{
  const buildPath = path.resolve(repositoryRoot, plan.build.receipt)
  const result = verifyProductionBuildReceipt({
    artifactRoot: path.dirname(buildPath),
    receiptFile: path.basename(buildPath),
    expectedSourceState: plan.sourceState,
    expectedReceiptDigest: plan.build.receiptContentDigest,
    repairReadOnlySeal: false
  })
  return result.receipt
}

export function produceAotSpaHydrationSourceBundle({ candidatePlan, evidence, repositoryRoot = root })
{
  const { input: candidate, plan } = planInput(candidatePlan, repositoryRoot)
  const inputs = loadInputs(evidence, repositoryRoot)
  return seal({
    schema: sourceBundleSchema,
    sourceState: plan.sourceState,
    candidatePlanRef: candidate.ref,
    evidenceRefs: Object.fromEntries(evidenceKeys.map((key) => [key, {
      ...inputs[key].ref,
      contentDigest: inputs[key].value?.contentDigest ?? null
    }])),
    canonicalRerunCommand: `node tools/test-evidence/aot-spa-hydration-raw.mjs bundle --candidate-plan ${candidate.ref.path} ${evidenceKeys.map((key) => `--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} ${inputs[key].ref.path}`).join(' ')}`
  })
}

function loadSourceBundle(sourceReceipt, plan, repositoryRoot)
{
  const source = explicitFile(sourceReceipt, 'AOT source bundle', repositoryRoot, { json: true })
  source.ref.contentDigest = source.value.contentDigest
  if (source.value.schema !== sourceBundleSchema
    || seal(Object.fromEntries(Object.entries(source.value).filter(([key]) => key !== 'contentDigest'))).contentDigest !== source.value.contentDigest
    || source.value.candidatePlanRef?.contentDigest !== plan.contentDigest)
  {
    fail('AOT source bundle schema, seal, or candidate binding mismatch')
  }
  const evidence = Object.fromEntries(evidenceKeys.map((key) => {
    const reference = source.value.evidenceRefs?.[key]
    const current = explicitFile(reference?.path, `${key} evidence`, repositoryRoot, { json: true })
    if (current.ref.fileDigest !== reference?.fileDigest
      || (reference?.contentDigest ?? null) !== (current.value?.contentDigest ?? null))
    {
      fail(`${key} evidence bytes changed after source bundling`)
    }
    return [key, reference.path]
  }))
  return { source, evidence }
}

export function projectAotSpaHydrationRaw({ candidatePlan, sourceReceipt, repositoryRoot = root })
{
  const { input: candidate, plan } = planInput(candidatePlan, repositoryRoot)
  const planned = plan.observations.find((entry) => entry.classId === classId)
  if (!planned) fail('candidate plan does not own aot-spa-hydration')
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  const definition = registry.observationClasses[classId]
  const producer = registry.producers.find(({ producerId }) => producerId === plan.producerId)
  if (!producer) fail('candidate plan producer is absent from registry')
  const buildReceipt = verifyBuild(plan, repositoryRoot)
  const source = loadSourceBundle(sourceReceipt, plan, repositoryRoot)
  const inputs = loadInputs(source.evidence, repositoryRoot)
  const legacyFacts = normalizedFacts(inputs, plan, buildReceipt)
  validateSemanticFacts(classId, legacyFacts)
  const semanticFacts = Array.isArray(definition.requiredSemanticFactFields)
    ? typedFacts(inputs, legacyFacts)
    : legacyFacts
  const sourceState = observationSourceState({ plan, artifactDigest: semanticFacts.manifestDigest, repositoryRoot, legacy: {
    sourceCommit: plan.sourceState.commit,
    worktreeFingerprint: plan.sourceState.worktreeFingerprint,
    buildIdentity: plan.build.receiptContentDigest,
    artifactDigest: semanticFacts.manifestDigest,
    candidateId: plan.candidate.candidateId,
    runId: plan.candidate.runId,
    attemptId: plan.candidate.attemptId,
    browserIdentity: plan.candidate.browserId,
    releaseId: plan.candidate.releaseId,
    rolloutId: plan.candidate.rolloutId
  } })
  const canonicalRerunCommand = `node tools/test-evidence/aot-spa-hydration-raw.mjs project --candidate-plan ${candidate.ref.path} --source ${source.source.ref.path} --out ${planned.receiptPath}`
  const independentVerifyCommand = `node tools/test-evidence/aot-spa-hydration-raw.mjs verify --receipt ${planned.receiptPath}`
  return seal({
    schema: definition.schema,
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
    ...observationEnvelopeAuthorityFields({ plan, candidatePlanRef: candidate.ref, repositoryRoot }),
    sourceReceiptRef: observationSourceReceipt({
      classId, plan, sourceState, upstreamRef: source.source.ref,
      upstreamSchema: source.source.value.schema,
      canonicalRerunCommand, independentVerifyCommand, repositoryRoot
    }),
    canonicalRerunCommand,
    independentVerifyCommand
  })
}

export function verifyAotSpaHydrationRaw(receiptPath, repositoryRoot = root, candidatePlan = null)
{
  const input = explicitFile(receiptPath, 'AOT raw receipt', repositoryRoot, { json: true })
  const receipt = input.value
  const definition = loadPostRuntimeProducerRegistry(repositoryRoot).observationClasses[classId]
  if (receipt.schema !== definition.schema || seal(Object.fromEntries(Object.entries(receipt)
    .filter(([key]) => key !== 'contentDigest'))).contentDigest !== receipt.contentDigest)
  {
    fail('raw receipt schema or content digest mismatch')
  }
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  validateProducerReceiptAgainstRegistry({
    registry, producerId: receipt.producerId, receipt, classId, repositoryRoot
  })
  const planPath = candidatePlanPathForObservation(receipt, candidatePlan)
  const replay = projectAotSpaHydrationRaw({
    candidatePlan: planPath,
    sourceReceipt: observationUpstreamPath(receipt, repositoryRoot),
    repositoryRoot
  })
  if (replay.contentDigest !== receipt.contentDigest) fail('AOT raw receipt replay mismatch')
  return receipt
}

function main()
{
  const parsed = options(process.argv.slice(2))
  if (parsed.command === 'bundle')
  {
    const evidence = Object.fromEntries(evidenceKeys.map((key) => [key, parsed[key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)]]))
    const receipt = produceAotSpaHydrationSourceBundle({ candidatePlan: parsed['candidate-plan'], evidence })
    if (!parsed.out) fail('source bundle requires --out')
    writeReceipt(parsed.out, receipt, root)
    process.stdout.write(`[aot-spa-hydration-raw] bundled path=${parsed.out} digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command === 'project')
  {
    const receipt = projectAotSpaHydrationRaw({ candidatePlan: parsed['candidate-plan'], sourceReceipt: parsed.source })
    const plan = explicitJson(parsed['candidate-plan'], 'candidate plan', root).value
    const planned = plan.observations.find((entry) => entry.classId === classId)
    if (!parsed.out || parsed.out !== planned?.receiptPath) fail('raw output path must exact-match the candidate plan')
    writeReceipt(parsed.out, receipt, root)
    verifyAotSpaHydrationRaw(parsed.out, root, parsed['candidate-plan'])
    process.stdout.write(`[aot-spa-hydration-raw] projected path=${parsed.out} digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command === 'verify')
  {
    const receipt = verifyAotSpaHydrationRaw(parsed.receipt, root, parsed['candidate-plan'])
    process.stdout.write(`[aot-spa-hydration-raw] verified digest=${receipt.contentDigest}\n`)
    return
  }
  fail('usage: bundle --candidate-plan <path> --manifest <json> --browser-contract <json> --out <source-bundle> or project --candidate-plan <path> --source <source-bundle> --out <planned-path> or verify --receipt <path>')
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
