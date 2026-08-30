#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyProductionBuildReceipt } from '../ci/production-build-artifacts.mjs'
import { stable } from '../fact-extractors/lib/canonicalize.mjs'
import {
  explicitJson,
  seal,
  validateCandidatePlan,
  writeReceipt
} from '../fact-extractors/post-runtime/adapter.mjs'
import { validateSemanticFacts } from '../fact-extractors/post-runtime/semantic-contracts.mjs'
import {
  loadPostRuntimeProducerRegistry,
  root
} from '../test-matrix/post-runtime-producer-registry.mjs'

const classId = 'aot-spa-hydration'
const unsafePathPattern = /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const evidenceKeys = Object.freeze([
  'manifest', 'publication', 'locale', 'data', 'serverHtml',
  'hydratedDom', 'client', 'network'
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

function exactKeys(value, expected, label)
{
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
  {
    fail(`${label} fields do not exact-match the AOT evidence contract`)
  }
}

function identityOf(value)
{
  const source = value?.sourceState ?? value?.sourceIdentity ?? {}
  return {
    sourceCommit: source.sourceCommit ?? source.commit,
    worktreeFingerprint: String(source.worktreeFingerprint ?? '').replace(/^sha256:/u, ''),
    buildIdentity: source.buildIdentity,
    runId: source.runId,
    attemptId: source.attemptId
  }
}

function verifyEvidenceEnvelope(key, input, plan)
{
  const value = input.value
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.schema !== 'string' || !/^fsusblog\.[a-z0-9.-]+\.v\d+$/u.test(value.schema))
  {
    fail(`${key} evidence schema is missing or unversioned`)
  }
  if (!['ok', 'passed', 'success', 'verified'].includes(value.status)) fail(`${key} evidence is not successful`)
  const identity = identityOf(value)
  if (identity.sourceCommit !== plan.sourceState.commit
    || identity.worktreeFingerprint !== plan.sourceState.worktreeFingerprint.replace(/^sha256:/u, '')
    || identity.buildIdentity !== plan.build.receiptContentDigest
    || identity.runId !== plan.candidate.runId
    || identity.attemptId !== plan.candidate.attemptId)
  {
    fail(`${key} evidence does not exact-match the candidate identity`)
  }
  if (!value.facts || typeof value.facts !== 'object' || Array.isArray(value.facts)) fail(`${key} evidence facts are missing`)
  return value.facts
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

  const publication = verifyEvidenceEnvelope('publication', inputs.publication, plan)
  const locale = verifyEvidenceEnvelope('locale', inputs.locale, plan)
  const data = verifyEvidenceEnvelope('data', inputs.data, plan)
  const hydratedDom = verifyEvidenceEnvelope('hydratedDom', inputs.hydratedDom, plan)
  const client = verifyEvidenceEnvelope('client', inputs.client, plan)
  const network = verifyEvidenceEnvelope('network', inputs.network, plan)
  exactKeys(publication, ['route', 'statusCode', 'contentType', 'published', 'releaseId'], 'publication facts')
  exactKeys(locale, ['expectedLocale', 'serverLocale', 'clientLocale', 'matches'], 'locale facts')
  exactKeys(data, ['route', 'hydrationKind', 'serverDigest', 'clientDigest', 'matches'], 'data facts')
  exactKeys(hydratedDom, [
    'route', 'hydrationKind', 'appCount', 'shellCount', 'hydrated', 'identityPreserved'
  ], 'hydrated DOM facts')
  exactKeys(client, ['route', 'ready', 'historyCoherent', 'hydrationMetricsPresent'], 'client facts')
  exactKeys(network, ['documentStatus', 'failedRequests', 'manifestResourcesMatched'], 'network facts')

  const serverHtml = htmlProjection(inputs.serverHtml.bytes)
  const sameRoute = publication.route === data.route
    && data.route === hydratedDom.route && hydratedDom.route === client.route
    && client.route === serverHtml.canonicalPath
  const sameKind = data.hydrationKind === hydratedDom.hydrationKind
    && hydratedDom.hydrationKind === serverHtml.hydrationKind
  const localeCoherent = locale.matches === true && locale.expectedLocale === locale.serverLocale
    && locale.serverLocale === locale.clientLocale && locale.serverLocale === serverHtml.locale
  const dataCoherent = data.matches === true && digestPattern.test(String(data.serverDigest ?? ''))
    && data.serverDigest === data.clientDigest
  const domCoherent = hydratedDom.appCount === 1 && hydratedDom.shellCount === 1
    && hydratedDom.hydrated === true && hydratedDom.identityPreserved === true
    && serverHtml.appCount === 1 && serverHtml.shellCount === 1 && serverHtml.seoMarkerCount === 1
  const publicationCoherent = publication.statusCode === 200 && publication.contentType.startsWith('text/html')
    && publication.published === true && publication.releaseId === plan.candidate.releaseId
  const clientCoherent = client.ready === true && client.historyCoherent === true
    && client.hydrationMetricsPresent === true
  const networkCoherent = network.documentStatus === 200 && Array.isArray(network.failedRequests)
    && network.failedRequests.length === 0 && network.manifestResourcesMatched === true
  if (!(sameRoute && sameKind && localeCoherent && dataCoherent && domCoherent
    && publicationCoherent && clientCoherent && networkCoherent))
  {
    fail('server HTML, hydrated DOM, client, network, locale, data, and publication identities are not coherent')
  }

  return {
    buildDigest: plan.build.receiptContentDigest,
    manifestDigest: manifest.manifestDigest,
    publicationDigest: inputs.publication.ref.fileDigest,
    localeCanaryDigest: inputs.locale.ref.fileDigest,
    dataCanaryDigest: inputs.data.ref.fileDigest,
    serverHtmlDigest: inputs.serverHtml.ref.fileDigest,
    hydratedDomDigest: inputs.hydratedDom.ref.fileDigest,
    clientStateDigest: inputs.client.ref.fileDigest,
    networkResourceDigest: inputs.network.ref.fileDigest,
    coherent: true
  }
}

function loadInputs(evidence, repositoryRoot)
{
  if (!evidence || JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify([...evidenceKeys].sort()))
  {
    fail('evidence paths must contain the exact AOT evidence set')
  }
  return Object.fromEntries(evidenceKeys.map((key) => [key,
    explicitFile(evidence[key], `${key} evidence`, repositoryRoot, { json: key !== 'serverHtml' })]))
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

export function projectAotSpaHydrationRaw({ candidatePlan, evidence, repositoryRoot = root })
{
  const { input: candidate, plan } = planInput(candidatePlan, repositoryRoot)
  const planned = plan.observations.find((entry) => entry.classId === classId)
  if (!planned) fail('candidate plan does not own aot-spa-hydration')
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  const definition = registry.observationClasses[classId]
  const buildReceipt = verifyBuild(plan, repositoryRoot)
  const inputs = loadInputs(evidence, repositoryRoot)
  const semanticFacts = normalizedFacts(inputs, plan, buildReceipt)
  validateSemanticFacts(classId, semanticFacts)
  return seal({
    schema: definition.schema,
    producerId: plan.producerId,
    sourceState: {
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
    },
    executionClass: 'correctness',
    evidenceClass: 'correctness',
    qualificationEligible: true,
    planned: true,
    executed: true,
    outcome: 'passed',
    recovered: false,
    modes: planned.requiredModes,
    semanticFacts,
    candidatePlanRef: candidate.ref,
    evidenceRefs: Object.fromEntries(evidenceKeys.map((key) => [key, inputs[key].ref])),
    independentVerifyCommand: `node tools/test-evidence/aot-spa-hydration-raw.mjs verify --receipt ${planned.receiptPath}`
  })
}

export function verifyAotSpaHydrationRaw(receiptPath, repositoryRoot = root)
{
  const input = explicitFile(receiptPath, 'AOT raw receipt', repositoryRoot, { json: true })
  const receipt = input.value
  const definition = loadPostRuntimeProducerRegistry(repositoryRoot).observationClasses[classId]
  if (receipt.schema !== definition.schema || seal(Object.fromEntries(Object.entries(receipt)
    .filter(([key]) => key !== 'contentDigest'))).contentDigest !== receipt.contentDigest)
  {
    fail('raw receipt schema or content digest mismatch')
  }
  const evidence = Object.fromEntries(evidenceKeys.map((key) => {
    const reference = receipt.evidenceRefs?.[key]
    const current = explicitFile(reference?.path, `${key} evidence`, repositoryRoot, { json: key !== 'serverHtml' })
    if (!digestPattern.test(String(reference?.fileDigest ?? '')) || current.ref.fileDigest !== reference.fileDigest)
    {
      fail(`${key} evidence bytes changed after projection`)
    }
    return [key, reference.path]
  }))
  const candidate = explicitFile(receipt.candidatePlanRef?.path, 'candidate plan', repositoryRoot, { json: true })
  if (candidate.ref.fileDigest !== receipt.candidatePlanRef?.fileDigest
    || candidate.value.contentDigest !== receipt.candidatePlanRef?.contentDigest)
  {
    fail('candidate plan bytes or content digest changed after projection')
  }
  const replay = projectAotSpaHydrationRaw({
    candidatePlan: receipt.candidatePlanRef.path,
    evidence,
    repositoryRoot
  })
  if (replay.contentDigest !== receipt.contentDigest) fail('AOT raw receipt replay mismatch')
  return receipt
}

function main()
{
  const parsed = options(process.argv.slice(2))
  if (parsed.command === 'project')
  {
    const evidence = Object.fromEntries(evidenceKeys.map((key) => [key, parsed[key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)]]))
    const receipt = projectAotSpaHydrationRaw({ candidatePlan: parsed['candidate-plan'], evidence })
    const plan = explicitJson(parsed['candidate-plan'], 'candidate plan', root).value
    const planned = plan.observations.find((entry) => entry.classId === classId)
    if (!parsed.out || parsed.out !== planned?.receiptPath) fail('raw output path must exact-match the candidate plan')
    writeReceipt(parsed.out, receipt, root)
    verifyAotSpaHydrationRaw(parsed.out, root)
    process.stdout.write(`[aot-spa-hydration-raw] projected path=${parsed.out} digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command === 'verify')
  {
    const receipt = verifyAotSpaHydrationRaw(parsed.receipt, root)
    process.stdout.write(`[aot-spa-hydration-raw] verified digest=${receipt.contentDigest}\n`)
    return
  }
  fail('usage: project --candidate-plan <path> --manifest <json> --publication <json> --locale <json> --data <json> --server-html <html> --hydrated-dom <json> --client <json> --network <json> --out <planned-path> or verify --receipt <path>')
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
