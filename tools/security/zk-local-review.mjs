import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const LOCAL_REVIEW_SCHEMA = 'fsusblog.zk.local-cryptographic-review.v1'
export const LOCAL_REVIEW_CIRCUIT_ID = 'fsus.anonymous.comment.v2'
export const LOCAL_REVIEW_LAYOUT_VERSION = 3
export const REQUIRED_LOCAL_REVIEW_SCOPE = Object.freeze([
  'constraint_completeness',
  'trusted_setup_provenance',
  'public_input_ordering',
  'native_mcl_binding',
  'side_channel_review',
  'subgroup_checks',
  'canonical_serialization',
  'domain_separation',
  'root_epoch_binding',
  'independent_implementation_fixture',
  'malformed_proof_fuzz',
  'non_canonical_field_fuzz',
  'concurrency_timeout_fuzz'
])
export const REQUIRED_LOCAL_ARTIFACT_BINDINGS = Object.freeze([
  'circuit_manifest_sha256',
  'circuit_source_sha256',
  'r1cs_sha256',
  'groth16_r1cs_sha256',
  'trusted_setup_manifest_sha256',
  'proving_key_sha256',
  'verifying_key_sha256',
  'native_verifier_sha256',
  'wasm_prover_sha256'
])

export function validateZkLocalReview({
  root,
  manifestPath,
  expectedVerifyingKeyHash = '',
  expectedBindings = {},
  requireComplete = true
}) {
  const errors = []
  const checks = []
  const absoluteManifestPath = resolveWithinRoot(root, manifestPath, errors, 'local review manifest')
  if (!absoluteManifestPath || !existsSync(absoluteManifestPath)) {
    errors.push(`local cryptographic review manifest is missing: ${manifestPath || '<empty>'}`)
    return result(errors, checks, absoluteManifestPath, null)
  }

  const manifest = readJson(absoluteManifestPath, errors, 'local cryptographic review manifest')
  if (!manifest) return result(errors, checks, absoluteManifestPath, null)

  requireEqual(errors, manifest.schema, LOCAL_REVIEW_SCHEMA, 'review manifest schema')
  requireEqual(errors, manifest.circuit_id, LOCAL_REVIEW_CIRCUIT_ID, 'review manifest circuit_id')
  requireEqual(
    errors,
    Number(manifest.public_input_layout_version),
    LOCAL_REVIEW_LAYOUT_VERSION,
    'review manifest public_input_layout_version')
  requireEqual(
    errors,
    manifest.assurance_model,
    'repository-local-reproducible-review',
    'review manifest assurance_model')
  if (manifest.independent_audit_claimed !== false) {
    errors.push('local review must set independent_audit_claimed=false')
  }
  if (manifest.external_evidence_required !== false) {
    errors.push('local review must set external_evidence_required=false')
  }
  if (manifest.production_authorization !== false) {
    errors.push('repository-local review must not claim production authorization')
  }
  if (!Array.isArray(manifest.limitations) ||
      manifest.limitations.length === 0 ||
      manifest.limitations.some((item) => !text(item))) {
    errors.push('local review must document at least one limitation')
  }

  const complete = manifest.status === 'complete' && manifest.review_complete === true
  if (requireComplete && !complete) {
    errors.push('local cryptographic review must have status=complete and review_complete=true')
  }

  const verifyingKeyHash = lower(manifest.verifying_key_hash)
  requireSha256(errors, verifyingKeyHash, 'review manifest verifying_key_hash')
  if (expectedVerifyingKeyHash && verifyingKeyHash !== lower(expectedVerifyingKeyHash)) {
    errors.push('local review verifying_key_hash does not match the selected verifying key')
  }

  requireExactStringSet(
    errors,
    manifest.required_scope,
    REQUIRED_LOCAL_REVIEW_SCOPE,
    'review manifest required_scope')
  validateScopeResults(
    manifest.scope_results,
    root,
    collectBoundEvidencePaths(root, manifest),
    errors)
  validateFindings(manifest.findings, errors)
  validateReport(root, manifest.report, errors)
  validateArtifactBindings(root, manifest.artifact_bindings, expectedBindings, verifyingKeyHash, errors)
  validateTestEvidence(root, manifest.test_evidence, errors)

  checks.push({
    id: 'repository-local-cryptographic-review',
    status: errors.length === 0 ? 'ok' : 'failed',
    assuranceModel: 'repository-local-reproducible-review',
    independentAuditClaimed: false,
    verifyingKeyHash
  })
  return result(errors, checks, absoluteManifestPath, manifest)
}

function validateScopeResults(value, root, boundEvidencePaths, errors) {
  if (!Array.isArray(value)) {
    errors.push('review manifest scope_results must be an array')
    return
  }

  const byId = new Map(value.map((entry) => [text(entry?.id), entry]))
  for (const id of REQUIRED_LOCAL_REVIEW_SCOPE) {
    const entry = byId.get(id)
    if (!entry) {
      errors.push(`local review scope result is missing: ${id}`)
      continue
    }
    if (entry.status !== 'passed') {
      errors.push(`local review scope ${id} must have status=passed`)
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0 || entry.evidence.some((item) => !text(item))) {
      errors.push(`local review scope ${id} must cite non-empty local evidence`)
      continue
    }
    for (const evidencePath of entry.evidence) {
      const absolute = resolveWithinRoot(root, evidencePath, errors, `local review scope ${id} evidence`)
      if (absolute && !boundEvidencePaths.has(absolute)) {
        errors.push(`local review scope ${id} evidence must be hash-bound: ${text(evidencePath)}`)
      }
    }
  }
  if (byId.size !== REQUIRED_LOCAL_REVIEW_SCOPE.length) {
    errors.push('local review scope_results must contain the exact required scope')
  }
}

function validateFindings(value, errors) {
  const findings = object(value)
  if (findings.critical_open !== 0) errors.push('local review findings.critical_open must be 0')
  if (findings.high_open !== 0) errors.push('local review findings.high_open must be 0')
  if (findings.unresolved !== 0) errors.push('local review findings.unresolved must be 0')
}

function collectBoundEvidencePaths(root, manifest) {
  const rawPaths = [
    manifest.report?.path,
    ...Object.values(object(manifest.artifact_bindings)).map((entry) => entry?.path),
    ...(Array.isArray(manifest.test_evidence) ? manifest.test_evidence.map((entry) => entry?.path) : [])
  ]
  return new Set(rawPaths
    .map((value) => text(value))
    .filter(Boolean)
    .map((value) => path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value)))
}

function validateReport(root, value, errors) {
  const report = object(value)
  const file = readBoundRepoFile(root, report.path, report.sha256, errors, 'local review report')
  if (file && !file.bytes.toString('utf8').includes('Repository-local cryptographic review')) {
    errors.push('local review report must identify itself as a repository-local cryptographic review')
  }
}

function validateArtifactBindings(root, value, expectedBindings, verifyingKeyHash, errors) {
  const bindings = object(value)
  for (const key of REQUIRED_LOCAL_ARTIFACT_BINDINGS) {
    const binding = object(bindings[key])
    const file = readBoundRepoFile(root, binding.path, binding.sha256, errors, `artifact binding ${key}`)
    const actual = file ? sha256(file.bytes) : lower(binding.sha256)
    const expected = lower(expectedBindings[key])
    if (expected && actual !== expected) {
      errors.push(`artifact binding ${key} does not match release evidence`)
    }
    if (key === 'verifying_key_sha256' && actual !== verifyingKeyHash) {
      errors.push('artifact binding verifying_key_sha256 must match review verifying_key_hash')
    }
  }
  if (Object.keys(bindings).length !== REQUIRED_LOCAL_ARTIFACT_BINDINGS.length) {
    errors.push('artifact_bindings must contain the exact required local artifacts')
  }
}

function validateTestEvidence(root, value, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('local review requires test_evidence')
    return
  }

  const covered = new Set()
  for (const entry of value) {
    readBoundRepoFile(root, entry?.path, entry?.sha256, errors, 'local review test evidence')
    if (!text(entry?.command)) errors.push('local review test evidence command is required')
    for (const id of Array.isArray(entry?.covers) ? entry.covers : []) covered.add(text(id))
  }
  for (const id of REQUIRED_LOCAL_REVIEW_SCOPE) {
    if (!covered.has(id)) errors.push(`local review test evidence does not cover ${id}`)
  }
}

function readBoundRepoFile(root, rawPath, rawSha256, errors, label) {
  const absolute = resolveWithinRoot(root, rawPath, errors, label)
  const declaredSha = lower(rawSha256)
  requireSha256(errors, declaredSha, `${label} SHA-256`)
  if (!absolute || !existsSync(absolute)) {
    errors.push(`${label} is missing: ${text(rawPath) || '<empty>'}`)
    return null
  }
  const bytes = readFileSync(absolute)
  if (declaredSha && sha256(bytes) !== declaredSha) {
    errors.push(`${label} SHA-256 does not match the file`)
  }
  return { absolute, bytes }
}

function resolveWithinRoot(root, value, errors, label) {
  const raw = text(value)
  if (!raw) {
    errors.push(`${label} path is required`)
    return ''
  }
  const absoluteRoot = path.resolve(root)
  const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(absoluteRoot, raw)
  const relative = path.relative(absoluteRoot, absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    errors.push(`${label} must stay inside the review root`)
    return ''
  }
  return absolute
}

function readJson(file, errors, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function requireExactStringSet(errors, actual, expected, label) {
  if (!Array.isArray(actual)) {
    errors.push(`${label} must be an array`)
    return
  }
  const actualSet = new Set(actual.filter((entry) => typeof entry === 'string'))
  if (actualSet.size !== expected.length || expected.some((entry) => !actualSet.has(entry))) {
    errors.push(`${label} must contain the exact required local-review scope`)
  }
}

function requireSha256(errors, value, label) {
  if (!/^[a-f0-9]{64}$/u.test(lower(value))) {
    errors.push(`${label} must be a 64-char lowercase SHA-256 digest`)
  }
}

function requireEqual(errors, actual, expected, label) {
  if (actual !== expected) errors.push(`${label} must equal ${String(expected)}`)
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function lower(value) {
  return text(value).toLowerCase()
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function result(errors, checks, manifestPath, manifest) {
  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? 'locally_reviewed' : 'failed',
    errors,
    checks,
    manifestPath,
    manifest
  }
}
