#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  evidenceReceiptSchema,
  joinBehaviorTestEvidence,
  scanBehaviorTestBindings
} from '../contracts/behavior-test-binding.mjs'
import { root, loadCatalog, catalogRelative } from '../contracts/behavior-contract-catalog.mjs'
import { observationArtifactSchema, validateObservationArtifact } from '../test-observations/validation.mjs'
import { canonicalize } from '../test-observations/source-identity.mjs'
import { forbiddenJoinFields } from '../contracts/behavior-graph-join.mjs'
import { validateJsonSchema } from './schema-validator/validate.mjs'
import {
  isHistoricalRawResultPath,
  loadTestPlan,
  planBoundClosure,
  extraExecutedTestIdsFor,
  produceBehaviorTestEvidenceCommand,
  produceBehaviorTestEvidenceReceiptPath,
  produceBehaviorTestEvidenceReceiptSchema
} from './produce-behavior-test-evidence.mjs'

export const verifyBehaviorTestEvidenceCommand =
  'node tools/test-matrix/verify-behavior-test-evidence.mjs'
export const verifyBehaviorTestEvidenceReceiptSchema = evidenceReceiptSchema

const sha256Prefix = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`

const canonicalBaseKeys = [
  'schema',
  'catalogDigest',
  'worktreeDigest',
  'run',
  'sourceState',
  'sourceClosureDigest',
  'rawResultDigest',
  'bindings',
  'evidence',
  'coverage',
  'errors'
]

function pickBase(value) {
  return Object.fromEntries(canonicalBaseKeys.map((key) => [key, value?.[key]]))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertNoForbiddenFields(value, label, errors) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenFields(entry, `${label}[${index}]`, errors))
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenJoinFields.includes(key)) {
      errors.push(`${label} contains forbidden join field ${key}; default success cannot satisfy behavior evidence`)
    }
    assertNoForbiddenFields(nested, `${label}.${key}`, errors)
  }
}

function loadStaticAdmissionReceipt(filePath, errors) {
  if (!fs.existsSync(filePath)) {
    errors.push(`static admission receipt not found: ${filePath}`)
    return null
  }
  const receipt = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (receipt?.schema !== 'fsusblog.behavior-doc-static-admission-receipt.v1') {
    errors.push('static admission receipt schema mismatch')
    return null
  }
  return receipt
}

/**
 * Independent verifier for behavior-test-evidence receipts.
 *
 * Re-reads the sealed receipt, this-round observation artifacts, source
 * bindings and catalog, then recomputes every identity and the exact join
 * from the canonical authority. Any tamper, cross-run, historical raw result,
 * retry/diagnostic recovery, default success field, or second producer fails
 * closed. Missing evidence reports the canonical producer command without
 * spawning any rerun.
 */
export function verifyBehaviorTestEvidence(options) {
  const errors = []
  const repositoryRoot = options.repositoryRoot ?? root
  const evidenceRoot = options.evidenceRoot ?? repositoryRoot
  const receiptPath = options.receipt ?? path.join(repositoryRoot, produceBehaviorTestEvidenceReceiptPath)

  // 0. Load and validate the explicit current-run test plan receipt.
  const planResult = loadTestPlan(options.plan, { repositoryRoot })
  errors.push(...planResult.errors)
  const plan = planResult.plan
  const testPlanDigest = planResult.testPlanDigest

  // 1. Load and validate the sealed receipt.
  let receipt = null
  if (!fs.existsSync(receiptPath)) {
    errors.push(`receipt not found: ${receiptPath}`)
  } else {
    try {
      receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    } catch (err) {
      errors.push(`receipt is not valid JSON: ${err.message}`)
    }
  }

  if (receipt) {
    if (receipt.schema !== evidenceReceiptSchema) {
      errors.push(`receipt schema mismatch: expected ${evidenceReceiptSchema}, got ${receipt.schema}`)
    }
    const schemaPath = path.join(repositoryRoot, 'config/schemas/behavior-test-evidence.schema.json')
    if (!fs.existsSync(schemaPath)) {
      errors.push(`receipt schema file not found: ${schemaPath}`)
    } else {
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
      errors.push(...validateJsonSchema(receipt, schema).map((item) => `receipt schema: ${item}`))
    }
    assertNoForbiddenFields(receipt, 'receipt', errors)

    const payload = structuredClone(receipt)
    delete payload.contentDigest
    const expectedDigest = sha256Prefix(JSON.stringify(canonicalize(payload)))
    if (receipt.contentDigest !== expectedDigest) {
      errors.push('receipt contentDigest mismatch (tamper or second producer)')
    }
    if (receipt.producer?.command !== produceBehaviorTestEvidenceCommand) {
      errors.push(`receipt producer command is not the canonical producer: ${receipt.producer?.command ?? '<missing>'}`)
    }
    if (receipt.producer?.schema !== produceBehaviorTestEvidenceReceiptSchema) {
      errors.push(`receipt producer schema mismatch: ${receipt.producer?.schema ?? '<missing>'}`)
    }
    if (receipt.runtimeCandidateSpawnCountBeforeReceipt !== 0) {
      errors.push('receipt runtimeCandidateSpawnCountBeforeReceipt must be zero (producer must not spawn candidates)')
    }
    if ((receipt.errors ?? []).length > 0) {
      errors.push('receipt records producer errors; evidence is not clean')
    }
    for (const row of receipt.coverage ?? []) {
      if (row.status !== 'ok' || (row.missingTestKinds ?? []).length > 0) {
        errors.push(`${row.behaviorId} exact coverage incomplete: missing ${(row.missingTestKinds ?? []).join(', ')}`)
      }
    }
    for (const entry of receipt.evidence ?? []) {
      const label = `evidence.${entry.canonicalTestId ?? '<unknown>'}`
      assertNoForbiddenFields(entry, label, errors)
      if (entry.run?.attemptKind === 'retry') {
        errors.push(`${label} retry evidence cannot be clean behavior evidence (#1603)`)
      }
      if (entry.run?.attemptKind === 'diagnostic') {
        errors.push(`${label} diagnostic evidence cannot satisfy behavior requirement`)
      }
      if (!entry.discovered || !entry.executed || entry.outcome !== 'passed') {
        errors.push(`${label} is not discovered+executed+passed this round`)
      }
    }
    if (options.expectedSourceCommit && receipt.sourceState?.commit !== options.expectedSourceCommit) {
      errors.push(`receipt source commit mismatch: expected ${options.expectedSourceCommit}, got ${receipt.sourceState?.commit}`)
    }
    if (options.expectedWorktreeFingerprint && receipt.sourceState?.worktreeFingerprint !== options.expectedWorktreeFingerprint) {
      errors.push(`receipt worktree fingerprint mismatch: expected ${options.expectedWorktreeFingerprint}, got ${receipt.sourceState?.worktreeFingerprint}`)
    }
    if (options.expectedClosureDigest && receipt.sourceClosureDigest !== options.expectedClosureDigest) {
      errors.push(`receipt source closure digest mismatch: expected ${options.expectedClosureDigest}, got ${receipt.sourceClosureDigest}`)
    }
    if (receipt.testPlanDigest !== testPlanDigest) {
      errors.push('receipt testPlanDigest does not match current-run test plan')
    }
    if (receipt.testPlanCommit !== (plan?.commit ?? null)) {
      errors.push(`receipt testPlanCommit does not match current-run test plan: ${receipt.testPlanCommit ?? '<missing>'} vs ${plan?.commit ?? '<missing>'}`)
    }
    if (options.staticAdmissionReceipt) {
      const staticReceipt = loadStaticAdmissionReceipt(options.staticAdmissionReceipt, errors)
      if (staticReceipt) {
        if (receipt.staticAdmissionDigest !== (staticReceipt.contentDigest ?? null)) {
          errors.push('receipt static admission digest mismatch')
        }
        if (receipt.staticAdmissionStatus !== (staticReceipt.status ?? 'missing')) {
          errors.push('receipt static admission status mismatch')
        }
      }
    }
  }

  // 2. Re-read this-round observation artifacts.
  const artifacts = []
  const runIds = new Set()
  for (const observationPath of options.observations) {
    if (isHistoricalRawResultPath(observationPath)) {
      errors.push(`historical raw result path cannot satisfy current-run evidence: ${observationPath}`)
      continue
    }
    if (!fs.existsSync(observationPath)) {
      errors.push(`observation artifact not found: ${observationPath}`)
      continue
    }
    let artifact
    try {
      artifact = JSON.parse(fs.readFileSync(observationPath, 'utf8'))
    } catch (err) {
      errors.push(`observation artifact is not valid JSON: ${observationPath}`)
      continue
    }
    errors.push(...validateObservationArtifact(artifact, {
      evidenceRoot,
      expectedSourceState: options.expectedSourceCommit
        ? { commit: options.expectedSourceCommit, worktreeFingerprint: options.expectedWorktreeFingerprint ?? '' }
        : null,
      expectedClosureDigest: options.expectedClosureDigest ?? null
    }).map((item) => `${observationPath}: ${item}`))
    if (artifact.schema === observationArtifactSchema) {
      artifacts.push(artifact)
      runIds.add(artifact.run?.id)
    }
  }
  if (artifacts.length === 0) {
    errors.push('no valid observation artifacts; cannot verify evidence')
  }
  if (runIds.size > 1) {
    errors.push('observation artifacts span multiple run identities; historical TRX cannot satisfy this round')
  }

  if (plan && artifacts.length > 0 && plan.commit !== artifacts[0].sourceState?.commit) {
    errors.push(`test plan commit does not match current-run observations: plan=${plan.commit}, observations=${artifacts[0].sourceState?.commit}`)
  }

  // 3. Cross-check sealed receipt identity against current-run observations.
  if (receipt && artifacts.length > 0) {
    const first = artifacts[0]
    if (JSON.stringify(receipt.run) !== JSON.stringify(first.run)) {
      errors.push('receipt run identity does not match current-run observations (cross-run)')
    }
    if (JSON.stringify(receipt.sourceState) !== JSON.stringify(first.sourceState)) {
      errors.push('receipt source identity does not match current-run observations')
    }
    if (receipt.sourceClosureDigest !== first.sourceClosureDigest) {
      errors.push('receipt source closure digest does not match current-run observations')
    }
    const rawDigests = artifacts.map((artifact) => artifact.producer.digest).sort()
    const expectedRawResultDigest = sha256Prefix(rawDigests.join('\n'))
    if (receipt.rawResultDigest !== expectedRawResultDigest) {
      errors.push('receipt rawResultDigest does not match current-run observation artifacts')
    }
    const observedDigests = new Set(rawDigests)
    for (const entry of receipt.evidence ?? []) {
      if (!observedDigests.has(entry.rawResultDigest)) {
        errors.push(`${entry.canonicalTestId} raw result ref is not from this round's observation artifacts`)
      }
    }
  }

  // 4. Independent re-join from the canonical authority (same-source identity).
  if (receipt && artifacts.length > 0) {
    const catalog = loadCatalog(path.join(repositoryRoot, catalogRelative))
    const scan = scanBehaviorTestBindings({
      repositoryRoot,
      catalog,
      worktreeDigest: receipt.worktreeDigest
    })
    const joined = joinBehaviorTestEvidence({
      repositoryRoot,
      catalog,
      bindingsScan: scan,
      observations: options.observations.map((observationPath) => path.resolve(observationPath)),
      evidenceRoot,
      worktreeDigest: receipt.worktreeDigest
    })
    for (const error of joined.errors) {
      errors.push(`independent join: ${error}`)
    }
    const joinedBase = pickBase(joined)
    const storedBase = pickBase(receipt)
    if (JSON.stringify(canonicalize(joinedBase)) !== JSON.stringify(canonicalize(storedBase))) {
      errors.push('receipt does not match independent re-join of raw results and bindings (tamper)')
    }

    // 5. Independent exact-match against the plan closure.
    const closure = planBoundClosure(plan, scan)
    const observedTestIds = new Set()
    for (const artifact of artifacts) {
      for (const observation of artifact.observations) observedTestIds.add(observation.testId)
    }
    const extraExecutedTestIds = extraExecutedTestIdsFor(
      [...observedTestIds],
      closure.plannedTestIds,
      closure.plannedFiles
    )
    const expectedPlanned = [...closure.plannedTestIds].sort((a, b) => a.localeCompare(b))
    if (JSON.stringify(canonicalize(receipt.plannedTestIds ?? [])) !== JSON.stringify(canonicalize(expectedPlanned))) {
      errors.push('receipt plannedTestIds do not match plan closure re-derivation')
    }
    if (JSON.stringify(canonicalize(receipt.unplannedBoundTestIds ?? [])) !== JSON.stringify(canonicalize(closure.unplannedBoundTestIds))) {
      errors.push('receipt unplannedBoundTestIds do not match plan closure re-derivation')
    }
    if (JSON.stringify(canonicalize(receipt.extraExecutedTestIds ?? [])) !== JSON.stringify(canonicalize(extraExecutedTestIds))) {
      errors.push('receipt extraExecutedTestIds do not match current-run observations re-derivation')
    }
    if (closure.unplannedBoundTestIds.length > 0) {
      errors.push(`bound test(s) not planned by test plan: ${closure.unplannedBoundTestIds.join(', ')}`)
    }
    if (extraExecutedTestIds.length > 0) {
      errors.push(`extra executed test(s) beyond plan closure: ${extraExecutedTestIds.join(', ')}`)
    }
  }

  return { receipt, errors: [...new Set(errors)].sort((left, right) => left.localeCompare(right)) }
}

function parseArgs(argv) {
  const options = {
    observations: [],
    plan: null,
    receipt: null,
    out: null,
    evidenceRoot: null,
    expectedSourceCommit: null,
    expectedWorktreeFingerprint: null,
    expectedClosureDigest: null,
    staticAdmissionReceipt: null,
    repositoryRoot: root,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--observations') {
      options.observations.push(argv[++index] ?? '')
    } else if (argument === '--plan') {
      options.plan = argv[++index] ?? null
    } else if (argument === '--receipt') {
      options.receipt = argv[++index] ?? options.receipt
    } else if (argument === '--out') {
      options.out = argv[++index] ?? options.out
    } else if (argument === '--evidence-root') {
      options.evidenceRoot = argv[++index] ?? null
    } else if (argument === '--source-commit') {
      options.expectedSourceCommit = argv[++index] ?? null
    } else if (argument === '--worktree-fingerprint') {
      options.expectedWorktreeFingerprint = argv[++index] ?? null
    } else if (argument === '--closure-digest') {
      options.expectedClosureDigest = argv[++index] ?? null
    } else if (argument === '--static-admission-receipt') {
      options.staticAdmissionReceipt = argv[++index] ?? null
    } else if (argument === '--repository-root') {
      options.repositoryRoot = argv[++index] ?? root
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  return options
}

function printHelp() {
  console.log(`Usage: node tools/test-matrix/verify-behavior-test-evidence.mjs [options]

Independently verifies a behavior-test-evidence receipt against the same
current-run observation artifacts, bindings, catalog, and identity inputs used
by the producer. Rejects tamper, cross-run, historical raw results, retry or
diagnostic recovery evidence, default success fields, and second producers.

Options:
  --observations <path>        Observation artifact file (repeatable; required)
  --plan <path>                Current-run test plan receipt (release-evidence test-plan v1; required)
  --receipt <path>             Receipt to verify (default: .tmp/behavior-test-evidence/receipt.json)
  --out <path>                 Optional verification report output path
  --evidence-root <path>       Root for producer report digest verification
  --source-commit <sha>        Expected Git commit SHA (40 hex chars)
  --worktree-fingerprint <fp>  Expected worktree fingerprint
  --closure-digest <digest>    Expected source closure digest
  --static-admission-receipt <path>  Path to #1752 static admission receipt
  --repository-root <path>     Repository root for fixture/testing
`)
}

// CLI entry point — only runs when invoked directly, not when imported.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      printHelp()
      process.exit(0)
    }
    if (options.observations.length === 0) {
      console.error('[verify-behavior-test-evidence] --observations is required (at least one observation artifact)')
      process.exit(2)
    }
    if (!options.plan) {
      console.error('[verify-behavior-test-evidence] --plan is required (release-evidence test-plan v1); a missing plan must fail closed, never silently skip exact-match')
      process.exit(2)
    }

    const { receipt, errors } = verifyBehaviorTestEvidence(options)

    if (options.out) {
      fs.mkdirSync(path.dirname(options.out), { recursive: true })
      fs.writeFileSync(options.out, `${JSON.stringify({
        schema: 'fsusblog.behavior-test-evidence-verification.v1',
        receiptPath: options.receipt ?? path.join(options.repositoryRoot ?? root, produceBehaviorTestEvidenceReceiptPath),
        status: errors.length === 0 ? 'ok' : 'failed',
        errors,
        verifiedAt: new Date().toISOString()
      }, null, 2)}\n`)
    }

    if (errors.length > 0) {
      console.error('[verify-behavior-test-evidence] FAILED')
      for (const error of errors) {
        console.error(`  ${error}`)
      }
      const canonical = `${produceBehaviorTestEvidenceCommand}${options.observations.map((item) => ` --observations ${item}`).join('')}${options.plan ? ` --plan ${options.plan}` : ''}`
      console.error(`  canonical producer command: ${canonical}`)
      process.exitCode = 1
    } else {
      console.log(`[verify-behavior-test-evidence] ok behaviors=${receipt?.coverage?.length ?? 0} evidence=${receipt?.evidence?.length ?? 0}`)
    }
  } catch (error) {
    console.error(`[verify-behavior-test-evidence] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
