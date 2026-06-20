#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_CONFIGS = [
  'src/backend/appsettings.json',
  'src/backend/appsettings.Production.json'
]
const DEFAULT_TRUSTED_SETUP = 'security/zk/comment-v1-trusted-setup.manifest.json'
const DEFAULT_SMOKE_EVIDENCE = '.tmp/security/privacy-zk-prod-smoke.json'
const DEFAULT_SUMMARY = '.tmp/security/privacy-zk-prod-release.json'

const args = parseArgs(process.argv.slice(2))
const configPaths = args.config.length > 0 ? args.config : DEFAULT_CONFIGS
const summaryPath = resolveRepoPath(args.summary ?? DEFAULT_SUMMARY)
const errors = []
const checks = []

const configuration = configPaths
  .filter((file) => existsSync(resolveRepoPath(file)))
  .map((file) => readJsonc(resolveRepoPath(file)))
  .reduce((merged, current) => deepMerge(merged, current), {})

const zkProd = readSection(configuration, ['AnonymousIdentity', 'ZkProd'])
const zkVerifier = readSection(configuration, ['AnonymousIdentity', 'ZkVerifier'])
const bbsIssuer = readSection(configuration, ['AnonymousIdentity', 'BbsIssuer'])

const enabled = readBoolEnv('FSUSBLOG_ZK_PROD_ENABLED')
  ?? readBool(zkProd.Enabled)
  ?? false
const requireEnabled = Boolean(args.requireEnabled)

if (requireEnabled && !enabled) {
  errors.push('ZkProd must be enabled for this release gate invocation.')
}

checkFalse('AnonymousIdentity:ZkProd:AllowDevVerifier', zkProd.AllowDevVerifier)
checkFalse('AnonymousIdentity:ZkProd:FallbackToLegacyAnonymous', zkProd.FallbackToLegacyAnonymous)
checkRollbackDocument()

if (!enabled && !requireEnabled) {
  checks.push({
    id: 'zk-prod-disabled-safe-baseline',
    status: 'ok',
    detail: 'ZkProd is disabled; production anonymous comment crypto remains fail-closed and legacy comment paths are unchanged.'
  })
} else {
  checkEnabledProductionReadiness()
}

const status = errors.length === 0 ? 'ok' : 'failed'
const summary = {
  schema: 'fsusblog.privacy-zk-prod-release.v1',
  status,
  enabled,
  generatedAt: new Date().toISOString(),
  configs: configPaths,
  checks,
  errors
}
mkdirSync(path.dirname(summaryPath), { recursive: true })
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)

if (errors.length > 0) {
  for (const error of errors) console.error(`[privacy-zk-prod-release] ${error}`)
  console.error(`[privacy-zk-prod-release] failed summary=${toRepoRelative(summaryPath)}`)
  process.exit(1)
}

console.log(`[privacy-zk-prod-release] ok summary=${toRepoRelative(summaryPath)}`)

function checkEnabledProductionReadiness() {
  checkTrue('AnonymousIdentity:ZkProd:RequireNativeVerifier', zkProd.RequireNativeVerifier)
  checkTrue('AnonymousIdentity:ZkProd:RequireTrustedSetupVerified', zkProd.RequireTrustedSetupVerified)
  checkTrue('AnonymousIdentity:ZkProd:RequireBbsCredential', zkProd.RequireBbsCredential)
  checkTrue('AnonymousIdentity:ZkProd:TrustedSetupVerified', zkProd.TrustedSetupVerified)
  checkTrue('AnonymousIdentity:ZkProd:BbsCredentialReady', zkProd.BbsCredentialReady)

  const backend = normalizeString(zkProd.VerifierBackend ?? zkVerifier.Backend)
  if (backend !== 'native_groth16') {
    errors.push('AnonymousIdentity:ZkProd:VerifierBackend must be native_groth16 when ZkProd is enabled.')
  } else {
    checks.push({ id: 'native-backend-name', status: 'ok', detail: backend })
  }

  const nativeLibraryPath = normalizeString(
    process.env.FSUSBLOG_ZK_NATIVE_VERIFIER_LIB
      ?? zkVerifier.NativeLibraryPath
      ?? zkProd.NativeVerifierLibraryPath)
  checkExistingFile('native-verifier-library', nativeLibraryPath)

  const trustedSetupPath = normalizeString(
    args.trustedSetupManifest
      ?? process.env.FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST
      ?? zkProd.TrustedSetupManifestPath
      ?? DEFAULT_TRUSTED_SETUP)
  const setup = checkTrustedSetupManifest(trustedSetupPath)

  const expectedVkHash = normalizeString(
    zkProd.VerifyingKeyHash
      ?? zkVerifier.VerifyingKeyHash)
  if (!expectedVkHash) {
    errors.push('AnonymousIdentity:ZkProd:VerifyingKeyHash or AnonymousIdentity:ZkVerifier:VerifyingKeyHash is required.')
  } else if (setup?.verifying_key_hash && setup.verifying_key_hash !== expectedVkHash) {
    errors.push('trusted setup verifying_key_hash does not match production configuration.')
  } else {
    checks.push({ id: 'verifying-key-hash-bound', status: 'ok', detail: expectedVkHash })
  }

  const issuerPublicKeyPath = normalizeString(
    process.env.FSUSBLOG_ZK_BBS_ISSUER_PUBLIC_KEY
      ?? bbsIssuer.PublicKeyPath
      ?? zkProd.BbsIssuerPublicKeyPath)
  checkExistingFile('bbs-issuer-public-key', issuerPublicKeyPath)

  const smokeEvidencePath = normalizeString(
    args.smokeEvidence
      ?? process.env.FSUSBLOG_ZK_PROD_SMOKE_EVIDENCE
      ?? zkProd.SmokeEvidencePath
      ?? DEFAULT_SMOKE_EVIDENCE)
  checkSmokeEvidence(smokeEvidencePath)
}

function checkFalse(key, value) {
  if (readBool(value) === true) {
    errors.push(`${key} must be false for production ZK release.`)
    return
  }

  checks.push({ id: key, status: 'ok', detail: 'false' })
}

function checkTrue(key, value) {
  if (readBool(value) !== true) {
    errors.push(`${key} must be true when ZkProd is enabled.`)
    return
  }

  checks.push({ id: key, status: 'ok', detail: 'true' })
}

function checkExistingFile(id, rawPath) {
  if (!rawPath) {
    errors.push(`${id} path is required when ZkProd is enabled.`)
    return null
  }

  const absolute = resolveRepoPath(rawPath)
  if (!existsSync(absolute)) {
    errors.push(`${id} is missing: ${rawPath}`)
    return null
  }

  checks.push({ id, status: 'ok', path: toRepoRelative(absolute), sha256: sha256File(absolute) })
  return absolute
}

function checkTrustedSetupManifest(rawPath) {
  const absolute = checkExistingFile('trusted-setup-manifest', rawPath)
  if (!absolute) return null

  const manifest = JSON.parse(readFileSync(absolute, 'utf8'))
  if (manifest.circuit_id !== 'fsus.anonymous.comment.v1') {
    errors.push('trusted setup manifest circuit_id must be fsus.anonymous.comment.v1.')
  }
  if (Number(manifest.public_input_layout_version) !== 2) {
    errors.push('trusted setup manifest public_input_layout_version must be 2.')
  }
  if (manifest.production_usable !== true) {
    errors.push('trusted setup manifest must be production_usable=true when ZkProd is enabled.')
  }
  if (!normalizeString(manifest.verifying_key_hash)) {
    errors.push('trusted setup manifest verifying_key_hash is required when ZkProd is enabled.')
  }
  if (['vk-sha256', 'placeholder', 'TODO', 'TBD'].includes(normalizeString(manifest.verifying_key_hash))) {
    errors.push('trusted setup manifest verifying_key_hash must not be a placeholder.')
  }

  checks.push({ id: 'trusted-setup-binding', status: errors.length === 0 ? 'ok' : 'checked' })
  return manifest
}

function checkSmokeEvidence(rawPath) {
  const absolute = checkExistingFile('zk-prod-smoke-evidence', rawPath)
  if (!absolute) return

  const evidence = JSON.parse(readFileSync(absolute, 'utf8'))
  const evidenceStatus = normalizeString(evidence.status)
  if (!['ok', 'passed', 'success'].includes(evidenceStatus)) {
    errors.push('ZK-Prod smoke evidence status must be ok/passed/success.')
  }

  for (const key of [
    'nativeVerifier',
    'wasmProver',
    'bbsCredential',
    'credentialRootActive',
    'ticketIssued',
    'anonymousSubmitPending',
    'identityHeadersOmitted',
    'sensitivePayloadRedacted'
  ]) {
    if (evidence[key] !== true) {
      errors.push(`ZK-Prod smoke evidence requires ${key}=true.`)
    }
  }

  checkNoSensitiveEvidence(evidence)
  checks.push({ id: 'zk-prod-smoke-evidence', status: 'checked', path: toRepoRelative(absolute) })
}

function checkNoSensitiveEvidence(value, pathSegments = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkNoSensitiveEvidence(item, [...pathSegments, String(index)]))
    return
  }

  if (!value || typeof value !== 'object') return

  for (const [key, child] of Object.entries(value)) {
    const fullPath = [...pathSegments, key].join('.')
    if (isSensitiveEvidenceKey(key)) {
      errors.push(`ZK-Prod smoke evidence must not include sensitive field: ${fullPath}`)
    }

    checkNoSensitiveEvidence(child, [...pathSegments, key])
  }
}

function isSensitiveEvidenceKey(key) {
  return /(?:credentialSecret|credential_secret|issuerSignature|issuer_signature|blindOpening|blind_opening|revocationWitness|revocation_witness|proofBytes|proof_bytes|rawProof|raw_proof|nullifierSecret|nullifier_secret)/u.test(key)
}

function checkRollbackDocument() {
  const candidates = [
    'docs/security.md',
    'docs/anonymous-identity-smoke-flow.md'
  ]
  const content = candidates
    .filter((file) => existsSync(resolveRepoPath(file)))
    .map((file) => readFileSync(resolveRepoPath(file), 'utf8'))
    .join('\n')
  const hasRollback = content.includes('check:privacy-zk-prod-release') &&
    content.includes('AnonymousIdentity:ZkProd:Enabled=false') &&
    content.includes('不删除已写入的匿名评论')
  if (!hasRollback) {
    errors.push('ZK-Prod rollback documentation must include the release gate command, disable flag, and data-preserving rollback note.')
    return
  }

  checks.push({ id: 'zk-prod-rollback-doc', status: 'ok' })
}

function parseArgs(argv) {
  const parsed = {
    config: []
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--config') {
      parsed.config.push(requireValue(argv, ++i, token))
    } else if (token === '--trusted-setup-manifest') {
      parsed.trustedSetupManifest = requireValue(argv, ++i, token)
    } else if (token === '--smoke-evidence') {
      parsed.smokeEvidence = requireValue(argv, ++i, token)
    } else if (token === '--summary') {
      parsed.summary = requireValue(argv, ++i, token)
    } else if (token === '--require-enabled') {
      parsed.requireEnabled = true
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

function readJsonc(file) {
  return JSON.parse(stripJsonComments(readFileSync(file, 'utf8')))
}

function stripJsonComments(source) {
  let output = ''
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (lineComment) {
      if (ch === '\n') {
        lineComment = false
        output += ch
      }
      continue
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false
        i += 1
      }
      continue
    }
    if (!inString && ch === '/' && next === '/') {
      lineComment = true
      i += 1
      continue
    }
    if (!inString && ch === '/' && next === '*') {
      blockComment = true
      i += 1
      continue
    }
    output += ch
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
    } else if (ch === '"') {
      inString = true
    }
  }
  return output
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return target
  }
  const result = { ...target }
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepMerge(result[key] ?? {}, value)
    } else {
      result[key] = value
    }
  }
  return result
}

function readSection(source, segments) {
  let current = source
  for (const segment of segments) {
    if (!current || typeof current !== 'object') return {}
    current = current[segment]
  }
  return current && typeof current === 'object' ? current : {}
}

function readBool(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'enabled'].includes(normalized)) return true
    if (['false', '0', 'no', 'disabled', ''].includes(normalized)) return false
  }
  return null
}

function readBoolEnv(key) {
  return Object.hasOwn(process.env, key) ? readBool(process.env[key]) : null
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function resolveRepoPath(candidate) {
  return path.isAbsolute(candidate) ? candidate : path.resolve(ROOT, candidate)
}

function toRepoRelative(candidate) {
  return path.relative(ROOT, candidate).replaceAll(path.sep, '/')
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}
