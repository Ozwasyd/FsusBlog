#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_TRUSTED_SETUP = 'security/zk/provenance/comment-v2-trusted-setup.manifest.json'
const DEFAULT_VERIFYING_KEY = 'config/zk/anonymous-comment-v2-verifying-key.manifest.json'
const DEFAULT_EVIDENCE = '.tmp/security/anonymous-credential-root-bootstrap.json'
const EXPECTED_CIRCUIT_ID = 'fsus.anonymous.comment.v3'
const EXPECTED_LAYOUT_VERSION = 4
const SENSITIVE_KEYS = /(?:issuerPrivateKey|issuer_private_key|privateKey|private_key|credentialSecret|credential_secret|proofWitness|proof_witness|witness|issuerSignature|issuer_signature|credentialOpening|credential_opening)/u
const PLACEHOLDER_HASHES = ['vk-sha256', 'placeholder', 'todo', 'tbd']
const ALLOWED_INPUT_KEYS = new Set([
  'schema',
  'epoch',
  'credentialRootHash',
  'revocationRootHash',
  'issuerPublicKeyHash',
  'circuitId',
  'circuitNumericId',
  'publicInputLayoutVersion',
  'verifyingKeyHash',
  'expiresAt',
  'graceExpiresAt',
  'operatorId',
  'reason'
])

const args = parseArgs(process.argv.slice(2))
const errors = []

try {
  const inputPath = requirePath(args.input, '--input')
  const trustedSetupPath = resolveRepoPath(args.trustedSetupManifest ?? DEFAULT_TRUSTED_SETUP)
  const verifyingKeyPath = resolveRepoPath(args.verifyingKeyManifest ?? DEFAULT_VERIFYING_KEY)
  const evidencePath = resolveRepoPath(args.evidence ?? DEFAULT_EVIDENCE)

  const input = readJson(inputPath, 'bootstrap input')
  const trustedSetup = readJson(trustedSetupPath, 'trusted setup manifest')
  const verifyingKey = readJson(verifyingKeyPath, 'verifying key manifest')

  failOnSensitiveFields(input, 'input')
  rejectUnknownInputFields(input)
  const normalized = validateInput(input)
  validateTrustedSetup(trustedSetup, normalized.verifyingKeyHash)
  validateVerifyingKeyManifest(verifyingKey, normalized.verifyingKeyHash, trustedSetup)

  if (errors.length > 0) {
    exitFailed()
  }

  const evidence = buildEvidence({
    input: normalized,
    trustedSetupPath,
    verifyingKeyPath,
    evidencePath
  })
  mkdirSync(path.dirname(evidencePath), { recursive: true })
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`[anonymous-credential-root-bootstrap] ok evidence=${toRepoRelative(evidencePath)}`)
} catch (error) {
  errors.push(error.message)
  exitFailed()
}

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    errors.push('bootstrap input must be a JSON object.')
    return
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      errors.push(`unknown bootstrap input field: ${key}`)
    }
  }
}

function validateInput(input) {
  const normalized = {
    epoch: readPositiveInteger(input.epoch, 'epoch'),
    credentialRootHash: readSha256Hex(input.credentialRootHash, 'credentialRootHash'),
    revocationRootHash: readSha256Hex(input.revocationRootHash, 'revocationRootHash'),
    issuerPublicKeyHash: readSha256Hex(input.issuerPublicKeyHash, 'issuerPublicKeyHash'),
    circuitId: normalizeString(input.circuitId),
    circuitNumericId: readPositiveInteger(input.circuitNumericId, 'circuitNumericId'),
    publicInputLayoutVersion: readPositiveInteger(input.publicInputLayoutVersion, 'publicInputLayoutVersion'),
    verifyingKeyHash: readSha256Hex(input.verifyingKeyHash, 'verifyingKeyHash'),
    expiresAt: readIsoUtc(input.expiresAt, 'expiresAt'),
    graceExpiresAt: readIsoUtc(input.graceExpiresAt, 'graceExpiresAt'),
    operatorId: normalizeString(input.operatorId),
    reason: normalizeString(input.reason)
  }

  if (normalized.circuitId !== EXPECTED_CIRCUIT_ID) {
    errors.push(`circuit_id must be ${EXPECTED_CIRCUIT_ID}.`)
  }
  if (normalized.publicInputLayoutVersion !== EXPECTED_LAYOUT_VERSION) {
    errors.push(`public_input_layout_version must be ${EXPECTED_LAYOUT_VERSION}.`)
  }
  if (!normalized.operatorId) {
    errors.push('operatorId is required for offline authorization evidence.')
  }
  if (!normalized.reason) {
    errors.push('reason is required for high-value audit correlation.')
  }
  if (normalized.expiresAt && normalized.graceExpiresAt && normalized.expiresAt >= normalized.graceExpiresAt) {
    errors.push('expiresAt must be earlier than graceExpiresAt.')
  }

  return normalized
}

function validateTrustedSetup(manifest, expectedVkHash) {
  if (manifest.schema !== 'fsusblog.zk.trusted-setup-manifest.v1') {
    errors.push('trusted setup manifest schema is invalid.')
  }
  if (manifest.circuit_id !== EXPECTED_CIRCUIT_ID) {
    errors.push(`trusted setup manifest circuit_id must be ${EXPECTED_CIRCUIT_ID}.`)
  }
  if (Number(manifest.public_input_layout_version) !== EXPECTED_LAYOUT_VERSION) {
    errors.push(`trusted setup manifest public_input_layout_version must be ${EXPECTED_LAYOUT_VERSION}.`)
  }
  if (manifest.production_usable !== true) {
    errors.push('trusted setup manifest production_usable must be true for root bootstrap.')
  }
  if (manifest.ceremony_status !== 'verified') {
    errors.push('trusted setup manifest ceremony_status must be verified for root bootstrap.')
  }

  const manifestVkHash = normalizeHash(manifest.verifying_key_hash)
  if (!manifestVkHash) {
    errors.push('trusted setup manifest verifying_key_hash is required.')
  } else if (!isSha256Hex(manifestVkHash)) {
    errors.push('trusted setup manifest verifying_key_hash must be a 64-char hex SHA-256 digest.')
  } else if (isPlaceholderHash(manifestVkHash)) {
    errors.push('trusted setup manifest verifying_key_hash must not be a placeholder.')
  } else if (manifestVkHash !== expectedVkHash) {
    errors.push('input verifying_key_hash does not match trusted setup manifest.')
  }
}

function validateVerifyingKeyManifest(manifest, expectedVkHash, trustedSetup) {
  if (manifest.schema !== 'fsusblog.zk.verifying-key-config.v1') {
    errors.push('verifying key manifest schema is invalid.')
  }
  if (manifest.circuit_id !== EXPECTED_CIRCUIT_ID) {
    errors.push(`verifying key manifest circuit_id must be ${EXPECTED_CIRCUIT_ID}.`)
  }
  if (Number(manifest.public_input_layout_version) !== EXPECTED_LAYOUT_VERSION) {
    errors.push(`verifying key manifest public_input_layout_version must be ${EXPECTED_LAYOUT_VERSION}.`)
  }
  if (manifest.production_usable !== true) {
    errors.push('verifying key manifest production_usable must be true for root bootstrap.')
  }

  const manifestVkHash = normalizeHash(manifest.verifying_key_hash)
  const trustedVkHash = normalizeHash(trustedSetup.verifying_key_hash)
  if (!manifestVkHash) {
    errors.push('verifying key manifest verifying_key_hash is required.')
  } else if (!isSha256Hex(manifestVkHash)) {
    errors.push('verifying key manifest verifying_key_hash must be a 64-char hex SHA-256 digest.')
  } else if (isPlaceholderHash(manifestVkHash)) {
    errors.push('verifying key manifest verifying_key_hash must not be a placeholder.')
  } else if (manifestVkHash !== expectedVkHash) {
    errors.push('input verifying_key_hash does not match verifying key manifest.')
  }

  if (trustedVkHash && manifestVkHash && trustedVkHash !== manifestVkHash) {
    errors.push('trusted setup manifest verifying_key_hash does not match verifying key manifest.')
  }
}

function buildEvidence({ input, trustedSetupPath, verifyingKeyPath }) {
  return {
    schema: 'fsusblog.anonymous-credential-root-bootstrap-evidence.v1',
    status: 'validated_offline',
    generatedAtUtc: new Date().toISOString(),
    mode: 'offline-validated-evidence',
    stagingDbRotateSatisfied: false,
    rotateContract: {
      dotnetService: 'AnonymousCredentialRootLifecycleService.RotateAsync',
      requestType: 'AnonymousCredentialRootRotationRequest',
      highValueAuditAction: 'security.anonymous_credential.root_rotated',
      requiresAdminStepUpOrOfflineOpsAuthorization: true
    },
    rootSnapshot: {
      epoch: input.epoch,
      credentialRootHash: input.credentialRootHash,
      revocationRootHash: input.revocationRootHash,
      issuerPublicKeyHash: input.issuerPublicKeyHash,
      circuitId: input.circuitId,
      circuitNumericId: input.circuitNumericId,
      publicInputLayoutVersion: input.publicInputLayoutVersion,
      verifyingKeyHash: input.verifyingKeyHash,
      expiresAtUtc: input.expiresAt.toISOString(),
      graceExpiresAtUtc: input.graceExpiresAt.toISOString()
    },
    operator: {
      id: input.operatorId,
      reason: input.reason
    },
    manifests: {
      trustedSetup: {
        path: toRepoRelative(trustedSetupPath),
        sha256: sha256File(trustedSetupPath)
      },
      verifyingKey: {
        path: toRepoRelative(verifyingKeyPath),
        sha256: sha256File(verifyingKeyPath)
      }
    },
    checks: [
      'hash-format-valid',
      'circuit-id-fsus.anonymous.comment.v3',
      'public-input-layout-version-4',
      'verifying-key-hash-bound-to-trusted-setup',
      'verifying-key-hash-bound-to-config-manifest',
      'sensitive-input-fields-rejected',
      'evidence-contains-no-private-key-credential-secret-proof-witness'
    ]
  }
}

function failOnSensitiveFields(value, location) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => failOnSensitiveFields(item, `${location}.${index}`))
    return
  }
  if (!value || typeof value !== 'object') return

  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`
    if (SENSITIVE_KEYS.test(key)) {
      errors.push(`sensitive bootstrap input field is forbidden: ${childLocation}`)
    }
    failOnSensitiveFields(child, childLocation)
  }
}

function readPositiveInteger(value, label) {
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    errors.push(`${label} must be a positive integer.`)
    return 0
  }
  return numeric
}

function readSha256Hex(value, label) {
  const normalized = normalizeHash(value)
  if (!isSha256Hex(normalized)) {
    errors.push(`${label} must be a 64-char hex SHA-256 digest.`)
    return normalized
  }
  if (isPlaceholderHash(normalized)) {
    errors.push(`${label} must not be a placeholder hash.`)
  }
  return normalized
}

function readIsoUtc(value, label) {
  const text = normalizeString(value)
  const parsed = new Date(text)
  if (!text || !text.endsWith('Z') || Number.isNaN(parsed.getTime())) {
    errors.push(`${label} must be an ISO-8601 UTC timestamp with Z suffix.`)
    return null
  }
  return parsed
}

function normalizeHash(value) {
  return normalizeString(value)
    .replace(/^0x/iu, '')
    .toLowerCase()
}

function isSha256Hex(value) {
  return /^[0-9a-f]{64}$/u.test(value)
}

function isPlaceholderHash(value) {
  const normalized = normalizeString(value).toLowerCase()
  return PLACEHOLDER_HASHES.some((token) => normalized.includes(token))
}

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--input') {
      parsed.input = requireValue(argv, ++i, token)
    } else if (token === '--trusted-setup-manifest') {
      parsed.trustedSetupManifest = requireValue(argv, ++i, token)
    } else if (token === '--verifying-key-manifest') {
      parsed.verifyingKeyManifest = requireValue(argv, ++i, token)
    } else if (token === '--evidence') {
      parsed.evidence = requireValue(argv, ++i, token)
    } else {
      throw new Error(`Unknown argument: ${token}`)
    }
  }
  return parsed
}

function requireValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function requirePath(value, flag) {
  if (!value) {
    throw new Error(`${flag} is required`)
  }
  return resolveRepoPath(value)
}

function readJson(file, label) {
  if (!existsSync(file)) {
    throw new Error(`${label} is missing: ${toRepoRelative(file)}`)
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function resolveRepoPath(candidate) {
  return path.isAbsolute(candidate) ? candidate : path.resolve(ROOT, candidate)
}

function toRepoRelative(candidate) {
  const relative = path.relative(ROOT, candidate)
  return relative.startsWith('..') ? candidate : relative.replaceAll(path.sep, '/')
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function exitFailed() {
  for (const error of errors) {
    console.error(`[anonymous-credential-root-bootstrap] ${error}`)
  }
  process.exit(1)
}
