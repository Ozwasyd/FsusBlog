import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { digestPath, computeConsumedInputDigests } from '../identity.mjs'
import { digestValue, isPlainObject, stable } from '../lib/canonicalize.mjs'
import { buildReceipt, validateReceipt } from '../receipt.mjs'
import { getExtractor, loadRegistry, root as defaultRoot, validateRegistry } from '../registry.mjs'
import { assertPreRuntimeQualified } from '../../test-matrix/behavior-evidence-pre-runtime.mjs'

const digestPattern = /^(?:sha256:)?[a-f0-9]{64}$/u
const commitPattern = /^[a-f0-9]{40}$/u
const unsafeReferencePattern = /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)|(?:^|[/\\])docs[/\\].*\.md$/iu
const shellMetacharacterPattern = /[;&|`$<>\n\r]/u
const behaviorDocExactnessSchema = 'fsusblog.behavior-doc-exactness-receipt.v1'

const fail = (message) => { throw new Error(`[post-runtime-observation] ${message}`) }
const normalizeDigest = (value) => typeof value === 'string' && value.startsWith('sha256:') ? value.slice(7) : value

function loadExplicitJson(input, label, repositoryRoot)
{
  if (isPlainObject(input)) return { value: structuredClone(input), path: null }
  if (typeof input !== 'string' || input.length === 0) fail(`${label} must be an explicit JSON path or object`)
  const absolute = path.resolve(repositoryRoot, input)
  const rootResolved = path.resolve(repositoryRoot)
  if (absolute !== rootResolved && !absolute.startsWith(`${rootResolved}${path.sep}`)) fail(`${label} path escapes repository`)
  const relative = path.relative(rootResolved, absolute).replaceAll(path.sep, '/')
  if (!relative.endsWith('.json') || unsafeReferencePattern.test(relative)) fail(`${label} must use an explicit current-run JSON path`)
  if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`${label} file is missing`)
  let value
  try { value = JSON.parse(readFileSync(absolute, 'utf8')) }
  catch (error) { fail(`${label} JSON parse failed: ${error instanceof Error ? error.message : String(error)}`) }
  return { value, path: relative }
}

function exactKeys(value, keys, label)
{
  if (!isPlainObject(value)) fail(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const required = [...keys].sort()
  if (actual.join('\0') !== required.join('\0')) fail(`${label} has unsupported or missing fields`)
}

function requireString(value, label)
{
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
  return value
}

function requireDigest(value, label)
{
  if (!digestPattern.test(String(value ?? ''))) fail(`${label} must be a sha256 digest`)
  return normalizeDigest(value)
}

function verifySealed(value, label, { nullDigestField = false } = {})
{
  requireDigest(value?.contentDigest, `${label}.contentDigest`)
  const clone = structuredClone(value)
  if (nullDigestField) clone.contentDigest = null
  else delete clone.contentDigest
  if (normalizeDigest(value.contentDigest) !== digestValue(clone)) fail(`${label} contentDigest mismatch`)
}

function uniqueStrings(value, label, { allowEmpty = false } = {})
{
  if (!Array.isArray(value)
    || (!allowEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== 'string' || entry.length === 0)
    || new Set(value).size !== value.length)
  {
    fail(`${label} must be a unique${allowEmpty ? '' : ' non-empty'} string list`)
  }
  return value
}

function sameSet(left, right)
{
  return [...left].sort().join('\0') === [...right].sort().join('\0')
}

function validateBuildIdentity(buildIdentity)
{
  exactKeys(buildIdentity, ['artifactId', 'receiptDigest', 'artifactDigest'], 'candidatePlan.buildIdentity')
  requireString(buildIdentity.artifactId, 'candidatePlan.buildIdentity.artifactId')
  requireDigest(buildIdentity.receiptDigest, 'candidatePlan.buildIdentity.receiptDigest')
  requireDigest(buildIdentity.artifactDigest, 'candidatePlan.buildIdentity.artifactDigest')
}

function validatePlan(plan, extractor)
{
  exactKeys(plan, [
    'planId', 'producerId', 'sourceCommit', 'worktreeFingerprint', 'buildIdentity',
    'identities', 'plannedObservationClasses', 'requiredOutcomes',
    'claimReceiptDigests', 'preRuntimeReceiptDigest', 'contentDigest'
  ], 'candidatePlan')
  verifySealed(plan, 'candidatePlan')
  requireString(plan.planId, 'candidatePlan.planId')
  if (plan.producerId !== extractor.id) fail('candidatePlan producerId does not match registry producer')
  if (!commitPattern.test(plan.sourceCommit)) fail('candidatePlan sourceCommit must be a full lowercase SHA')
  requireDigest(plan.worktreeFingerprint, 'candidatePlan.worktreeFingerprint')
  validateBuildIdentity(plan.buildIdentity)
  if (!sameSet(uniqueStrings(plan.plannedObservationClasses, 'candidatePlan.plannedObservationClasses'), extractor.runtimeContract.observationClasses))
  {
    fail('candidatePlan observation classes do not exact-match the registry contract')
  }
  if (!sameSet(uniqueStrings(plan.requiredOutcomes, 'candidatePlan.requiredOutcomes'), extractor.runtimeContract.requiredOutcomes))
  {
    fail('candidatePlan required outcomes do not exact-match the registry contract')
  }
  if (!isPlainObject(plan.claimReceiptDigests)) fail('candidatePlan.claimReceiptDigests must be an object')
  if (!sameSet(Object.keys(plan.claimReceiptDigests), extractor.runtimeContract.acceptedClaimIds))
  {
    fail('candidatePlan claim IDs do not exact-match the registry contract')
  }
  for (const [claimId, digest] of Object.entries(plan.claimReceiptDigests)) requireDigest(digest, `candidatePlan claim ${claimId}`)
  requireDigest(plan.preRuntimeReceiptDigest, 'candidatePlan.preRuntimeReceiptDigest')
  return plan
}

function validateIdentities(identities, requiredIdentities, plan)
{
  const keys = [
    'artifactId', 'artifactDigest', 'buildId', 'buildReceiptDigest', 'candidateId',
    'fixtureId', 'profileId', 'runId', 'attemptId', 'runtimeId', 'toolchainDigest'
  ]
  if (requiredIdentities.includes('browser')) keys.push('browserId')
  if (requiredIdentities.includes('release')) keys.push('releaseId')
  if (requiredIdentities.includes('deployment')) keys.push('deploymentId')
  exactKeys(identities, keys, 'identities')
  for (const key of keys) requireString(identities[key], `identities.${key}`)
  for (const key of ['artifactDigest', 'buildReceiptDigest', 'toolchainDigest']) requireDigest(identities[key], `identities.${key}`)
  if (identities.artifactId !== plan.buildIdentity.artifactId
    || normalizeDigest(identities.artifactDigest) !== normalizeDigest(plan.buildIdentity.artifactDigest)
    || normalizeDigest(identities.buildReceiptDigest) !== normalizeDigest(plan.buildIdentity.receiptDigest))
  {
    fail('candidate identities do not match buildIdentity')
  }
}

function validatePreRuntime(preRuntimeReceipt, plan)
{
  assertPreRuntimeQualified(preRuntimeReceipt)
  if (normalizeDigest(preRuntimeReceipt.contentDigest) !== normalizeDigest(plan.preRuntimeReceiptDigest))
  {
    fail('pre-runtime receipt digest does not match candidatePlan')
  }
  if (preRuntimeReceipt.sourceIdentity?.commit !== plan.sourceCommit
    || normalizeDigest(preRuntimeReceipt.sourceIdentity?.worktreeFingerprint) !== normalizeDigest(plan.worktreeFingerprint))
  {
    fail('pre-runtime receipt source identity does not match candidatePlan')
  }
}

function validateClaimReceipts(claimReceipts, plan, extractor)
{
  if (!Array.isArray(claimReceipts) || claimReceipts.length === 0) fail('verified claim receipts are required')
  const found = new Map()
  for (const [index, receipt] of claimReceipts.entries())
  {
    if (receipt?.schema !== behaviorDocExactnessSchema) fail(`claim receipt ${index} has unsupported schema`)
    verifySealed(receipt, `claim receipt ${index}`, { nullDigestField: true })
    if (receipt.status !== 'ok' || !Array.isArray(receipt.failureReasons) || receipt.failureReasons.length !== 0
      || receipt.counts?.warnings !== 0)
    {
      fail(`claim receipt ${index} is not verified exactness evidence`)
    }
    if (receipt.source?.commit !== plan.sourceCommit
      || normalizeDigest(receipt.source?.worktreeFingerprint) !== normalizeDigest(plan.worktreeFingerprint))
    {
      fail(`claim receipt ${index} source identity does not match candidatePlan`)
    }
    for (const row of receipt.rows ?? [])
    {
      if (!extractor.runtimeContract.acceptedClaimIds.includes(row.claimId)) continue
      if (found.has(row.claimId)) fail(`claim ${row.claimId} has duplicate verified receipts`)
      found.set(row.claimId, normalizeDigest(receipt.contentDigest))
    }
  }
  if (!sameSet(found.keys(), extractor.runtimeContract.acceptedClaimIds)) fail('verified claim set does not exact-match the registry contract')
  for (const [claimId, digest] of found)
  {
    if (digest !== normalizeDigest(plan.claimReceiptDigests[claimId])) fail(`claim ${claimId} digest does not match candidatePlan`)
  }
  return Object.fromEntries([...found].sort(([left], [right]) => left.localeCompare(right)))
}

function validateRawReceipt(raw, index, plan, extractor, validateFacts, repositoryRoot, sourcePath = null)
{
  exactKeys(raw, [
    'producerId', 'observationClass', 'executionClass', 'evidenceClass',
    'qualificationEligible', 'identity', 'planned', 'executed', 'outcome',
    'coveredOutcomes', 'attemptKind', 'recovered', 'facts', 'rawRef',
    'rerunCommand', 'contentDigest'
  ], `rawReceipts[${index}]`)
  verifySealed(raw, `rawReceipts[${index}]`)
  if (raw.producerId !== extractor.id) fail(`rawReceipts[${index}] producer mismatch`)
  if (!extractor.runtimeContract.observationClasses.includes(raw.observationClass)) fail(`rawReceipts[${index}] has unknown observation class`)
  if (raw.executionClass !== extractor.runtimeContract.executionClass || raw.evidenceClass !== 'correctness')
  {
    fail(`rawReceipts[${index}] execution/evidence class cannot qualify`)
  }
  if (raw.qualificationEligible !== true || raw.planned !== true || raw.executed !== true || raw.outcome !== 'passed')
  {
    fail(`rawReceipts[${index}] was not planned, executed, and passed as correctness evidence`)
  }
  if (raw.attemptKind !== 'qualification' || raw.recovered !== false)
  {
    fail(`rawReceipts[${index}] diagnostic/recovered evidence cannot qualify`)
  }
  uniqueStrings(raw.coveredOutcomes, `rawReceipts[${index}].coveredOutcomes`)
  validateIdentities(raw.identity, extractor.runtimeContract.requiredIdentities, plan)
  if (digestValue(raw.identity) !== digestValue(plan.identities)) fail(`rawReceipts[${index}] identity does not match candidatePlan`)
  requireString(raw.rawRef, `rawReceipts[${index}].rawRef`)
  if (unsafeReferencePattern.test(raw.rawRef)) fail(`rawReceipts[${index}] rawRef uses historical/latest/docs fallback`)
  if (!raw.rawRef.endsWith('.json')) fail(`rawReceipts[${index}] rawRef must identify a sealed JSON receipt`)
  if (sourcePath != null && raw.rawRef !== sourcePath) fail(`rawReceipts[${index}] rawRef does not match its explicit input path`)
  requireString(raw.rerunCommand, `rawReceipts[${index}].rerunCommand`)
  if ((!raw.rerunCommand.startsWith('node ') && !raw.rerunCommand.startsWith('./tools/test.sh '))
    || shellMetacharacterPattern.test(raw.rerunCommand))
  {
    fail(`rawReceipts[${index}] rerunCommand is not a canonical single producer command`)
  }
  const commandTokens = raw.rerunCommand.trim().split(/\s+/u)
  const entrypoint = commandTokens[0] === 'node' ? commandTokens[1] : commandTokens[0].replace(/^\.\//u, '')
  const commandPath = path.resolve(repositoryRoot, entrypoint ?? '')
  const rootResolved = path.resolve(repositoryRoot)
  if (!entrypoint || !commandPath.startsWith(`${rootResolved}${path.sep}`)
    || !existsSync(commandPath) || !statSync(commandPath).isFile())
  {
    fail(`rawReceipts[${index}] rerunCommand entrypoint is not a repository producer`)
  }
  validateFacts(raw.observationClass, raw.facts)
  return raw
}

function buildObservations({ extractor, plan, rawReceipts, claimRefs, status })
{
  const byClass = Object.fromEntries(rawReceipts
    .sort((left, right) => left.observationClass.localeCompare(right.observationClass))
    .map((raw) => [raw.observationClass, raw]))
  const coveredOutcomes = [...new Set(rawReceipts.flatMap((raw) => raw.coveredOutcomes))].sort()
  const observations = {
    behaviorId: extractor.ownedBehaviorIds[0],
    evidenceStage: 'post-runtime',
    producerId: extractor.id,
    executionClass: extractor.runtimeContract.executionClass,
    evidenceClass: extractor.runtimeContract.evidenceClass,
    qualificationStatus: status === 'ok' ? 'qualified' : 'failed',
    requiredObservationClasses: [...extractor.runtimeContract.observationClasses].sort(),
    requiredOutcomes: [...extractor.runtimeContract.requiredOutcomes].sort(),
    candidatePlanDigest: normalizeDigest(plan.contentDigest),
    preRuntimeReceiptDigest: normalizeDigest(plan.preRuntimeReceiptDigest),
    identities: stable(plan.identities),
    claimRefs: stable(claimRefs)
  }
  if (rawReceipts.length > 0)
  {
    observations.observedObservationClasses = Object.keys(byClass).sort()
    observations.observedOutcomes = coveredOutcomes
    observations.rawRefs = Object.fromEntries(Object.entries(byClass).map(([key, raw]) => [key, raw.rawRef]))
    observations.rawReceiptDigests = Object.fromEntries(Object.entries(byClass).map(([key, raw]) => [key, normalizeDigest(raw.contentDigest)]))
    observations.rerunCommands = Object.fromEntries(Object.entries(byClass).map(([key, raw]) => [key, raw.rerunCommand]))
    observations.candidateFacts = Object.fromEntries(Object.entries(byClass).map(([key, raw]) => [key, stable(raw.facts)]))
  }
  return observations
}

export function producePostRuntimeObservation({
  producerId,
  candidatePlan,
  rawReceipts,
  preRuntimeReceipt,
  claimReceipts,
  validateFacts,
  repositoryRoot = defaultRoot,
  registry = loadRegistry()
})
{
  const { digest: registryDigest } = validateRegistry(registry, repositoryRoot)
  const extractor = getExtractor(registry, producerId)
  if (extractor.kind !== 'runtime-receipt-adapter') fail(`${producerId} is not a runtime receipt adapter`)
  const planInput = loadExplicitJson(candidatePlan, 'candidatePlan', repositoryRoot)
  const plan = planInput.value
  const preRuntimeInput = loadExplicitJson(preRuntimeReceipt, 'preRuntimeReceipt', repositoryRoot)
  if (!Array.isArray(claimReceipts)) fail('claimReceipts must be an explicit array')
  const claimInputs = claimReceipts.map((receipt, index) => loadExplicitJson(receipt, `claimReceipts[${index}]`, repositoryRoot))
  validatePlan(plan, extractor)
  validateIdentities(plan.identities, extractor.runtimeContract.requiredIdentities, plan)
  validatePreRuntime(preRuntimeInput.value, plan)
  const claimRefs = validateClaimReceipts(claimInputs.map((input) => input.value), plan, extractor)
  if (!Array.isArray(rawReceipts)) fail('rawReceipts must be an explicit array')
  const rawInputs = rawReceipts.map((receipt, index) => loadExplicitJson(receipt, `rawReceipts[${index}]`, repositoryRoot))

  const accepted = []
  const errors = []
  for (const [index, input] of rawInputs.entries())
  {
    try { accepted.push(validateRawReceipt(input.value, index, plan, extractor, validateFacts, repositoryRoot, input.path)) }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  }
  const classCounts = new Map()
  for (const raw of accepted) classCounts.set(raw.observationClass, (classCounts.get(raw.observationClass) ?? 0) + 1)
  for (const observationClass of extractor.runtimeContract.observationClasses)
  {
    const count = classCounts.get(observationClass) ?? 0
    if (count !== 1) errors.push(`${observationClass} requires exact-one current-run raw result; observed ${count}`)
  }
  const unknownClasses = [...classCounts.keys()].filter((value) => !extractor.runtimeContract.observationClasses.includes(value))
  if (unknownClasses.length > 0) errors.push(`unknown observation classes: ${unknownClasses.join(', ')}`)
  const observedOutcomes = new Set(accepted.flatMap((raw) => raw.coveredOutcomes))
  if (!sameSet(observedOutcomes, extractor.runtimeContract.requiredOutcomes)) errors.push('observed outcome closure does not exact-match the registry contract')

  const status = errors.length === 0 ? 'ok' : 'failed'
  const consumedInputDigests = computeConsumedInputDigests(repositoryRoot, extractor.consumedInputs)
  consumedInputDigests.push(
    { path: planInput.path ?? `candidate-plan:${plan.planId}`, digest: normalizeDigest(plan.contentDigest) },
    { path: preRuntimeInput.path ?? 'pre-runtime-receipt', digest: normalizeDigest(preRuntimeInput.value.contentDigest) },
    ...Object.entries(claimRefs).map(([claimId, digest]) => ({ path: `claim-receipt:${claimId}`, digest })),
    ...accepted.map((raw) => ({ path: `raw-receipt:${raw.rawRef}`, digest: normalizeDigest(raw.contentDigest) }))
  )
  const observations = buildObservations({ extractor, plan, rawReceipts: accepted, claimRefs, status })
  return buildReceipt({
    extractorId: extractor.id,
    behaviorIds: extractor.ownedBehaviorIds,
    sourceCommit: plan.sourceCommit,
    worktreeFingerprint: normalizeDigest(plan.worktreeFingerprint),
    buildIdentity: {
      artifactId: plan.buildIdentity.artifactId,
      receiptDigest: normalizeDigest(plan.buildIdentity.receiptDigest),
      artifactDigest: normalizeDigest(plan.buildIdentity.artifactDigest)
    },
    extractorDigest: digestPath(repositoryRoot, extractor.entrypoint),
    registryDigest,
    consumedInputDigests,
    observations,
    status,
    failureReasons: [...new Set(errors)].sort()
  })
}

export function verifyPostRuntimeObservation({ receipt, produce, ...inputs })
{
  const loadedReceipt = loadExplicitJson(receipt, 'receipt', inputs.repositoryRoot ?? defaultRoot).value
  const loadedPlan = loadExplicitJson(inputs.candidatePlan, 'candidatePlan', inputs.repositoryRoot ?? defaultRoot).value
  validateReceipt(loadedReceipt, {
    repositoryRoot: inputs.repositoryRoot,
    expectedSourceCommit: loadedPlan.sourceCommit,
    expectedWorktreeFingerprint: normalizeDigest(loadedPlan.worktreeFingerprint)
  })
  const replay = produce(inputs)
  if (loadedReceipt.contentDigest !== replay.contentDigest) fail('observation receipt does not exact-match independent raw-result replay')
  if (loadedReceipt.status !== 'ok') fail(`observation receipt is not qualified: ${loadedReceipt.failureReasons.join('; ')}`)
  return loadedReceipt
}

export function sealCurrentRunInput(value)
{
  const sealed = { ...structuredClone(value) }
  delete sealed.contentDigest
  sealed.contentDigest = digestValue(sealed)
  return sealed
}

function parseCliArguments(argv)
{
  const command = argv[0]
  if (!['produce', 'verify'].includes(command)) fail('command must be produce or verify')
  const options = { rawReceipts: [], claimReceipts: [] }
  for (let index = 1; index < argv.length; index += 1)
  {
    const argument = argv[index]
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`${argument} requires a value`)
    if (argument === '--candidate-plan') options.candidatePlan = value
    else if (argument === '--pre-runtime') options.preRuntimeReceipt = value
    else if (argument === '--claim') options.claimReceipts.push(value)
    else if (argument === '--raw') options.rawReceipts.push(value)
    else if (argument === '--receipt') options.receipt = value
    else if (argument === '--out') options.out = value
    else fail(`unknown argument ${argument}`)
    index += 1
  }
  for (const [field, value] of [
    ['--candidate-plan', options.candidatePlan],
    ['--pre-runtime', options.preRuntimeReceipt]
  ])
  {
    if (!value) fail(`${field} is required`)
  }
  if (options.claimReceipts.length === 0) fail('at least one explicit --claim receipt is required')
  if (options.rawReceipts.length === 0) fail('at least one explicit --raw receipt is required')
  if (command === 'verify' && !options.receipt) fail('--receipt is required for verify')
  return { command, options }
}

function resolveOutput(repositoryRoot, output)
{
  requireString(output, 'output path')
  const rootResolved = path.resolve(repositoryRoot)
  const absolute = path.resolve(rootResolved, output)
  if (!absolute.startsWith(`${rootResolved}${path.sep}`)) fail('output path escapes repository')
  const relative = path.relative(rootResolved, absolute).replaceAll(path.sep, '/')
  if (!relative.endsWith('.json') || unsafeReferencePattern.test(relative))
  {
    fail('output must be an explicit current-run JSON path')
  }
  return { absolute, relative }
}

export function runPostRuntimeObservationCli({
  argv,
  producerId,
  produce,
  verify,
  defaultOutput,
  repositoryRoot = defaultRoot
})
{
  const { command, options } = parseCliArguments(argv)
  const inputs = {
    repositoryRoot,
    candidatePlan: options.candidatePlan,
    preRuntimeReceipt: options.preRuntimeReceipt,
    claimReceipts: options.claimReceipts,
    rawReceipts: options.rawReceipts
  }
  if (command === 'verify')
  {
    const receipt = verify({ ...inputs, receipt: options.receipt })
    console.log(`[post-runtime-observation] verified producer=${producerId} receipt=${options.receipt}`)
    return receipt
  }

  const output = resolveOutput(repositoryRoot, options.out ?? defaultOutput)
  const receipt = produce(inputs)
  if (receipt.status !== 'ok') fail(`${producerId} failed: ${receipt.failureReasons.join('; ')}`)
  mkdirSync(path.dirname(output.absolute), { recursive: true })
  writeFileSync(output.absolute, `${JSON.stringify(receipt, null, 2)}\n`)
  verify({ ...inputs, receipt: output.relative })
  console.log(`[post-runtime-observation] produced producer=${producerId} receipt=${output.relative}`)
  return receipt
}
