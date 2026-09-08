#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyProductionBuildReceipt } from '../ci/production-build-artifacts.mjs'
import { normalizeAotSpaHydrationFacts, deriveAotSpaHydrationRawFacts } from './aot-spa-hydration-observed-facts.mjs'
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
import { validateSemanticFacts } from '../fact-extractors/post-runtime/semantic-contracts.mjs'
import {
  extractSemanticFactsFromRawReceipt,
  loadPostRuntimeProducerRegistry,
  root,
  validateProducerReceiptAgainstRegistry
} from '../test-matrix/post-runtime-producer-registry.mjs'

const classId = 'aot-spa-hydration'
export const sourceBundleSchema = 'fsusblog.aot-spa-hydration-source-bundle.v1'
const unsafePathPattern = /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu
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
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(absolute) !== absolute)
  {
    fail(`${label} must be a regular non-symlink single-link file`)
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

function readAotArtifactBytes(file)
{
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file)
  {
    fail('SPA artifact must be a regular non-symlink file')
  }
  return fs.readFileSync(file)
}

function normalizedFacts(inputs, plan, buildReceipt)
{
  return normalizeAotSpaHydrationFacts(inputs, plan, buildReceipt, { readBytes: (file) => {
    const assetRoot = path.resolve(String(inputs.manifest.value.assetRoot ?? ''))
    const stat = fs.lstatSync(assetRoot, { throwIfNoEntry: false })
    if (!stat?.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(assetRoot) !== assetRoot)
    {
      fail('SPA manifest descriptor asset root is missing or symbolic')
    }
    return readAotArtifactBytes(file)
  } })
}

function observedRawFacts(inputs)
{
  return deriveAotSpaHydrationRawFacts(inputs, { readBytes: readAotArtifactBytes })
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
  input.ref.schema = plan.schema
  input.ref.role = 'candidate-plan'
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
  const planned = plan.observations.find((entry) => entry.classId === classId)
  if (!planned) fail('candidate plan does not own aot-spa-hydration')
  const inputs = loadInputs(evidence, repositoryRoot)
  normalizedFacts(inputs, plan, verifyBuild(plan, repositoryRoot))
  const producer = loadPostRuntimeProducerRegistry(repositoryRoot).producers
    .find(({ producerId }) => producerId === plan.producerId)
  if (!producer) fail('candidate plan producer is absent from registry')
  return seal({
    schema: sourceBundleSchema,
    producerId: plan.producerId,
    toolVersion: producer.toolVersion,
    sourceState: plan.sourceState,
    rawFacts: observedRawFacts(inputs),
    candidatePlanRef: candidate.ref,
    evidenceRefs: Object.fromEntries(evidenceKeys.map((key) => [key, {
      ...inputs[key].ref,
      contentDigest: inputs[key].value?.contentDigest ?? null,
      schema: inputs[key].value.schema,
      role: key === 'manifest' ? 'spa-manifest' : 'browser-contract'
    }])),
    canonicalRerunCommand: `node tools/test-evidence/aot-spa-hydration-raw.mjs bundle --candidate-plan ${candidate.ref.path} ${evidenceKeys.map((key) => `--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} ${inputs[key].ref.path}`).join(' ')}`,
    independentVerifyCommand: `node tools/test-evidence/aot-spa-hydration-raw.mjs verify --candidate-plan ${candidate.ref.path} --receipt ${planned.receiptPath}`
  })
}

function loadSourceBundle(sourceReceipt, candidatePlanRef, plan, repositoryRoot)
{
  const source = explicitFile(sourceReceipt, 'AOT source bundle', repositoryRoot, { json: true })
  source.ref.contentDigest = source.value.contentDigest
  if (source.value.schema !== sourceBundleSchema
    || seal(Object.fromEntries(Object.entries(source.value).filter(([key]) => key !== 'contentDigest'))).contentDigest !== source.value.contentDigest
    || JSON.stringify(stable(source.value.candidatePlanRef)) !== JSON.stringify(stable(candidatePlanRef))
    || source.value.candidatePlanRef?.contentDigest !== plan.contentDigest)
  {
    fail('AOT source bundle schema, seal, or candidate binding mismatch')
  }
  if (JSON.stringify(Object.keys(source.value.evidenceRefs ?? {}).sort()) !== JSON.stringify([...evidenceKeys].sort()))
  {
    fail('AOT source bundle evidence reference roster mismatch')
  }
  const evidence = Object.fromEntries(evidenceKeys.map((key) => {
    const reference = source.value.evidenceRefs?.[key]
    const current = explicitFile(reference?.path, `${key} evidence`, repositoryRoot, { json: true })
    if (Object.keys(reference ?? {}).sort().join(',') !== 'contentDigest,fileDigest,path,role,schema'
      || reference.schema !== current.value.schema
      || reference.role !== (key === 'manifest' ? 'spa-manifest' : 'browser-contract')
      || current.ref.fileDigest !== reference?.fileDigest
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
  const source = loadSourceBundle(sourceReceipt, candidate.ref, plan, repositoryRoot)
  const inputs = loadInputs(source.evidence, repositoryRoot)
  const legacyFacts = normalizedFacts(inputs, plan, buildReceipt)
  validateSemanticFacts(classId, legacyFacts)
  const rawFacts = observedRawFacts(inputs)
  if (digestValue(stable(source.source.value.rawFacts ?? null)) !== digestValue(stable(rawFacts)))
  {
    fail('AOT raw facts do not replay from retained manifest and Browser Contract observations')
  }
  const sourceState = observationSourceState({ classId, plan, artifactDigest: legacyFacts.manifestDigest, repositoryRoot, legacy: {
    sourceCommit: plan.sourceState.commit,
    worktreeFingerprint: plan.sourceState.worktreeFingerprint,
    buildIdentity: plan.build.receiptContentDigest,
    artifactDigest: legacyFacts.manifestDigest,
    candidateId: plan.candidate.candidateId,
    runId: plan.candidate.runId,
    attemptId: plan.candidate.attemptId,
    browserIdentity: plan.candidate.browserId,
    releaseId: plan.candidate.releaseId,
    rolloutId: plan.candidate.rolloutId
  } })
  const semanticFacts = extractSemanticFactsFromRawReceipt(source.source.value, definition, plan.producerId, classId, sourceState)
  const canonicalRerunCommand = source.source.value.canonicalRerunCommand
  const independentVerifyCommand = `node tools/test-evidence/aot-spa-hydration-raw.mjs verify --candidate-plan ${candidate.ref.path} --receipt ${planned.receiptPath}`
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
  const plan = validateCandidatePlan(explicitJson(planPath, 'candidate plan', repositoryRoot).value, { repositoryRoot })
  const planned = plan.observations.find((entry) => entry.classId === classId)
  if (!planned || input.ref.path !== planned.receiptPath)
  {
    fail('AOT raw receipt path does not exact-match candidate plan')
  }
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
