#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))

const paths = {
  circuit: resolveInputPath(
    process.env.FSUSBLOG_ZK_CIRCUIT_MANIFEST,
    'security/zk/comment-v1-circuit.manifest.json'
  ),
  tamper: resolveInputPath(
    process.env.FSUSBLOG_ZK_TAMPER_MANIFEST,
    'security/zk/comment-v1-tamper-cases.manifest.json'
  )
}

const outputPath = resolveOutputPath(
  process.env.FSUSBLOG_ZK_MANIFEST_CHECK_OUT,
  '.tmp/security/zk-comment-v1-manifest.json'
)

const expected = {
  circuitId: 'fsus.anonymous.comment.v1',
  layoutVersion: 2,
  actionContext: 'comment.create',
  proofSystem: 'Groth16',
  credentialScheme: 'BBS+',
  requiredPublicInputs: [
    'public_input_layout_version',
    'circuit_id',
    'action_context',
    'scope',
    'nullifier_hash',
    'credential_root',
    'revocation_root',
    'credential_epoch',
    'credential_level',
    'reputation_bucket',
    'issuer_public_key_hash',
    'policy_hash',
    'verifying_key_hash'
  ],
  requiredPrivateWitness: [
    'credential_secret',
    'bbs_plus_issuer_signature',
    'credential_opening',
    'credential_membership_proof',
    'revocation_non_membership_witness',
    'signed_credential_level',
    'signed_reputation_bucket',
    'policy_comparison_witness'
  ],
  requiredAssertions: [
    'valid_bbs_credential',
    'current_credential_root',
    'revocation_non_membership',
    'qualification_policy',
    'nullifier_prf_binding',
    'credential_bucket_legality',
    'identity_non_disclosure'
  ],
  requiredTamperCases: [
    'tamper-issuer-signature',
    'tamper-credential-root',
    'tamper-revocation-root',
    'tamper-policy-hash',
    'tamper-nullifier-hash',
    'tamper-scope',
    'tamper-action-context',
    'tamper-credential-level',
    'tamper-reputation-bucket',
    'tamper-credential-epoch',
    'tamper-layout-version',
    'tamper-verifying-key-hash',
    'inject-user-id-public-input',
    'inject-username-private-witness'
  ],
  forbiddenIdentityNames: [
    'userid',
    'user_id',
    'username',
    'public_handle',
    'account_id',
    'session_id',
    'client_ip',
    'device_fingerprint',
    'cookie',
    'authorization'
  ]
}

const failures = []

function resolveInputPath(value, fallback) {
  if (value && value.trim().length > 0) {
    return path.isAbsolute(value) ? value : path.join(root, value)
  }

  return path.join(root, fallback)
}

function resolveOutputPath(value, fallback) {
  if (value && value.trim().length > 0) {
    return path.isAbsolute(value) ? value : path.join(root, value)
  }

  return path.join(root, fallback)
}

function fail(message) {
  failures.push(`[zk-comment-v1-manifest] ${message}`)
}

function readJson(file) {
  if (!fs.existsSync(file)) {
    fail(`missing manifest ${relative(file)}`)
    return {}
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`invalid JSON ${relative(file)}: ${error.message}`)
    return {}
  }
}

function relative(file) {
  const rel = path.relative(root, file)
  return rel.startsWith('..') ? file : rel.replaceAll(path.sep, '/')
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function names(list) {
  return asArray(list).map((entry) => String(entry?.name ?? '').trim()).filter(Boolean)
}

function hasAll(label, actual, required) {
  const actualSet = new Set(actual)
  for (const item of required) {
    if (!actualSet.has(item)) {
      fail(`${label} missing ${item}`)
    }
  }
}

function hasNoForbiddenIdentity(label, actual) {
  for (const item of actual) {
    const normalized = item.toLowerCase()
    if (expected.forbiddenIdentityNames.includes(normalized)) {
      fail(`${label} contains forbidden identity field ${item}`)
    }
  }
}

function equals(label, actual, expectedValue) {
  if (actual !== expectedValue) {
    fail(`${label} expected ${expectedValue}, got ${actual}`)
  }
}

function checkCircuit(circuit) {
  equals('circuit.schema', circuit.schema, 'fsusblog.zk.circuit-manifest.v1')
  equals('circuit.circuit_id', circuit.circuit_id, expected.circuitId)
  equals('circuit.public_input_layout_version', circuit.public_input_layout_version, expected.layoutVersion)
  equals('circuit.proof_system', circuit.proof_system, expected.proofSystem)
  equals('circuit.credential_scheme', circuit.credential_scheme, expected.credentialScheme)
  equals('circuit.action_context', circuit.action_context, expected.actionContext)

  const publicInputs = names(circuit.public_inputs)
  const privateWitness = names(circuit.private_witness)
  const assertionIds = asArray(circuit.security_assertions)
    .map((entry) => String(entry?.id ?? '').trim())
    .filter(Boolean)

  hasAll('circuit.public_inputs', publicInputs, expected.requiredPublicInputs)
  hasAll('circuit.private_witness', privateWitness, expected.requiredPrivateWitness)
  hasAll('circuit.security_assertions', assertionIds, expected.requiredAssertions)
  hasNoForbiddenIdentity('circuit.public_inputs', publicInputs)
  hasNoForbiddenIdentity('circuit.private_witness', privateWitness)

  const forbidden = asArray(circuit.forbidden_identity_fields).map((item) => String(item).trim())
  hasAll('circuit.forbidden_identity_fields', forbidden, [
    'userId',
    'user_id',
    'username',
    'public_handle',
    'account_id',
    'session_id'
  ])

  const prf = circuit.nullifier_prf ?? {}
  equals('circuit.nullifier_prf.algorithm', prf.algorithm, 'poseidon')
  hasAll('circuit.nullifier_prf.binds', asArray(prf.binds), [
    'credential_secret',
    'action_context',
    'scope'
  ])
  if (prf.stable_for_same_secret_and_scope !== true) {
    fail('circuit.nullifier_prf must be stable for the same secret and scope')
  }
  if (prf.unlinkable_across_scope !== true) {
    fail('circuit.nullifier_prf must be unlinkable across scope')
  }

  const budgets = circuit.budgets ?? {}
  if (Number(budgets.proof_bytes_max) > 1024 || Number(budgets.proof_bytes_max) <= 0) {
    fail('circuit.budgets.proof_bytes_max must be in 1..1024')
  }
  if (Number(budgets.wasm_prover_p95_ms_max) > 3000 || Number(budgets.wasm_prover_p95_ms_max) <= 0) {
    fail('circuit.budgets.wasm_prover_p95_ms_max must be in 1..3000')
  }
  if (circuit.production_usable !== false) {
    fail('circuit manifest must stay production_usable=false until real Groth16 artifacts land')
  }
}

function checkTamperManifest(tamper) {
  equals('tamper.schema', tamper.schema, 'fsusblog.zk.tamper-cases.v1')
  equals('tamper.circuit_id', tamper.circuit_id, expected.circuitId)
  equals('tamper.public_input_layout_version', tamper.public_input_layout_version, expected.layoutVersion)

  if (tamper.valid_case?.expected !== 'accept') {
    fail('tamper.valid_case must be an accepting baseline')
  }

  const validCoverage = asArray(tamper.valid_case?.covers)
  hasAll('tamper.valid_case.covers', validCoverage, expected.requiredAssertions)

  const cases = asArray(tamper.tamper_cases)
  const caseIds = cases.map((entry) => String(entry?.id ?? '').trim()).filter(Boolean)
  hasAll('tamper.tamper_cases', caseIds, expected.requiredTamperCases)

  const rejectCoverage = new Set()
  for (const entry of cases) {
    if (entry?.expected !== 'reject') {
      fail(`tamper case ${entry?.id ?? '<missing>'} must reject`)
    }
    if (asArray(entry?.mutates).length === 0) {
      fail(`tamper case ${entry?.id ?? '<missing>'} must declare mutated fields`)
    }
    for (const covered of asArray(entry?.covers)) {
      rejectCoverage.add(String(covered))
    }
  }

  for (const assertion of expected.requiredAssertions) {
    if (!rejectCoverage.has(assertion)) {
      fail(`tamper cases do not reject assertion ${assertion}`)
    }
  }
}

function writeEvidence(status) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify({
      schema: 'fsusblog.zk.comment-v1-manifest-check.v1',
      status,
      circuit_id: expected.circuitId,
      public_input_layout_version: expected.layoutVersion,
      checked_at_utc: new Date().toISOString(),
      host: os.hostname(),
      manifests: {
        circuit: relative(paths.circuit),
        tamper: relative(paths.tamper)
      },
      hashes: {
        circuit_sha256: fs.existsSync(paths.circuit) ? sha256File(paths.circuit) : '',
        tamper_sha256: fs.existsSync(paths.tamper) ? sha256File(paths.tamper) : ''
      }
    }, null, 2)}\n`
  )
}

const circuit = readJson(paths.circuit)
const tamper = readJson(paths.tamper)

checkCircuit(circuit)
checkTamperManifest(tamper)

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exit(1)
}

writeEvidence('ok')
console.log(`[zk-comment-v1-manifest] ok evidence=${relative(outputPath)}`)
