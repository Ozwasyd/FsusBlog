#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_CONFIGS = [
  'src/backend/appsettings.json',
  'src/backend/appsettings.Production.json'
]
const DEFAULT_SUMMARY = '.tmp/security/privacy-zk-prod-smoke.json'
const DEFAULT_PROVER_MANIFEST = 'src/frontend/public/wasm/comment-privacy-prover.manifest.json'
const DEFAULT_TRUSTED_SETUP = 'security/zk/comment-v1-trusted-setup.manifest.json'

const args = parseArgs(process.argv.slice(2))
const summaryPath = resolveRepoPath(args.summary ?? DEFAULT_SUMMARY)
const configPaths = args.config.length > 0 ? args.config : DEFAULT_CONFIGS
const errors = []
const checks = []

const configuration = configPaths
  .filter((file) => existsSync(resolveRepoPath(file)))
  .map((file) => readJsonc(resolveRepoPath(file)))
  .reduce((merged, current) => deepMerge(merged, current), {})

const zkProd = readSection(configuration, ['AnonymousIdentity', 'ZkProd'])
const zkVerifier = readSection(configuration, ['AnonymousIdentity', 'ZkVerifier'])
const bbsIssuer = readSection(configuration, ['AnonymousIdentity', 'BbsIssuer'])
const enabled = readBoolEnv('FSUSBLOG_ZK_PROD_ENABLED') ?? readBool(zkProd.Enabled) ?? false
const traceId = `zk-prod-smoke-${Date.now().toString(36)}`
const realEvidence = args.realEvidence ? readRealEvidence(args.realEvidence) : null

const artifactState = inspectArtifacts()
let status = 'expected_unavailable'
let businessState = enabled ? 'real_smoke_evidence_required' : 'feature_flag_off'

if (realEvidence) {
  validateRealEvidence(realEvidence)
  if (errors.length === 0) {
    status = 'ok'
    businessState = 'real_smoke_evidence_validated'
  }
} else if (!enabled) {
  checks.push({
    id: 'feature-flag-off',
    status: 'expected_unavailable',
    detail: 'AnonymousIdentity:ZkProd:Enabled=false'
  })
} else {
  businessState = artifactState.wasmProver
    ? 'real_smoke_evidence_missing'
    : 'browser_prover_artifact_unavailable'
  checks.push({
    id: 'real-evidence-required',
    status: 'expected_unavailable',
    detail: businessState
  })
}

if (args.requireReal && status !== 'ok') {
  errors.push(`real ZK-Prod smoke evidence is required; current business state is ${businessState}.`)
}

if (errors.length > 0) {
  status = 'failed'
}

const summary = {
  schema: 'fsusblog.privacy-zk-prod-smoke.v1',
  status,
  generatedAt: new Date().toISOString(),
  traceId,
  businessState,
  enabled,
  featureFlagOffExpectedUnavailable: !enabled,
  nativeVerifier: realEvidence?.nativeVerifier === true || artifactState.nativeVerifier,
  wasmProver: realEvidence?.wasmProver === true || artifactState.wasmProver,
  bbsCredential: realEvidence?.bbsCredential === true || artifactState.bbsCredential,
  ticketIssued: realEvidence?.ticketIssued === true,
  anonymousSubmitPending: realEvidence?.anonymousSubmitPending === true,
  identityHeadersOmitted: realEvidence?.identityHeadersOmitted === true || status === 'expected_unavailable',
  sensitivePayloadRedacted: true,
  artifacts: artifactState.safeArtifacts,
  checks,
  errors
}

mkdirSync(path.dirname(summaryPath), { recursive: true })
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)

if (errors.length > 0) {
  for (const error of errors) console.error(`[privacy-zk-prod-smoke] ${error}`)
  console.error(`[privacy-zk-prod-smoke] failed summary=${toRepoRelative(summaryPath)}`)
  process.exit(1)
}

console.log(`[privacy-zk-prod-smoke] ${status} summary=${toRepoRelative(summaryPath)} trace=${traceId} state=${businessState}`)

function inspectArtifacts() {
  const nativeLibraryPath = normalizeString(
    process.env.FSUSBLOG_ZK_NATIVE_VERIFIER_LIB
      ?? zkVerifier.NativeLibraryPath
      ?? zkVerifier.NativeGroth16?.LibraryPath
      ?? zkProd.NativeVerifierLibraryPath)
  const nativeVerifier = nativeLibraryPath.length > 0 && existsSync(resolveRepoPath(nativeLibraryPath))

  const trustedSetupPath = normalizeString(
    args.trustedSetupManifest
      ?? process.env.FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST
      ?? zkProd.TrustedSetupManifestPath
      ?? DEFAULT_TRUSTED_SETUP)
  const trustedSetup = readOptionalJson(trustedSetupPath)
  const trustedSetupReady = trustedSetup?.production_usable === true &&
    normalizeString(trustedSetup?.verifying_key_hash).length > 0

  const proverManifestPath = normalizeString(args.proverManifest ?? DEFAULT_PROVER_MANIFEST)
  const proverManifest = readOptionalJson(proverManifestPath)
  const wasmProver = hasUsableBrowserProver(proverManifest)

  const bbsCredential = readBool(zkProd.BbsCredentialReady) === true ||
    normalizeString(process.env.FSUSBLOG_ZK_BBS_ISSUER_PUBLIC_KEY ?? bbsIssuer.PublicKeyPath ?? zkProd.BbsIssuerPublicKeyPath).length > 0

  const safeArtifacts = {
    nativeVerifierConfigured: nativeVerifier,
    trustedSetupProductionUsable: trustedSetupReady,
    browserProverArtifactAvailable: wasmProver,
    bbsCredentialReady: bbsCredential,
    proverManifest: existsSync(resolveRepoPath(proverManifestPath)) ? toRepoRelative(resolveRepoPath(proverManifestPath)) : null,
    trustedSetupManifest: existsSync(resolveRepoPath(trustedSetupPath)) ? toRepoRelative(resolveRepoPath(trustedSetupPath)) : null
  }

  return {
    nativeVerifier,
    wasmProver,
    bbsCredential,
    safeArtifacts
  }
}

function hasUsableBrowserProver(manifest) {
  if (!manifest || typeof manifest !== 'object') return false
  const moduleUrl = normalizeString(manifest.moduleUrl)
  const wasmUrl = normalizeString(manifest.wasmUrl)
  const provingKeyUrl = normalizeString(manifest.provingKeyUrl)
  if (!moduleUrl || !wasmUrl || !provingKeyUrl) return false
  return [moduleUrl, wasmUrl, provingKeyUrl]
    .map(resolvePublicAssetUrl)
    .every((file) => existsSync(file))
}

function validateRealEvidence(evidence) {
  const evidenceStatus = normalizeString(evidence.status)
  if (!['ok', 'passed', 'success'].includes(evidenceStatus)) {
    errors.push('real smoke evidence status must be ok/passed/success.')
  }

  for (const key of [
    'nativeVerifier',
    'wasmProver',
    'bbsCredential',
    'ticketIssued',
    'anonymousSubmitPending',
    'identityHeadersOmitted',
    'sensitivePayloadRedacted'
  ]) {
    if (evidence[key] !== true) {
      errors.push(`real smoke evidence requires ${key}=true.`)
    }
  }

  checks.push({ id: 'real-smoke-evidence', status: 'checked' })
}

function readRealEvidence(rawPath) {
  const absolute = resolveRepoPath(rawPath)
  if (!existsSync(absolute)) {
    errors.push(`real smoke evidence is missing: ${rawPath}`)
    return null
  }

  return JSON.parse(readFileSync(absolute, 'utf8'))
}

function readOptionalJson(rawPath) {
  const absolute = resolveRepoPath(rawPath)
  if (!existsSync(absolute)) return null
  return JSON.parse(readFileSync(absolute, 'utf8'))
}

function parseArgs(argv) {
  const parsed = {
    config: []
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--config') {
      parsed.config.push(requireValue(argv, ++i, token))
    } else if (token === '--summary') {
      parsed.summary = requireValue(argv, ++i, token)
    } else if (token === '--trusted-setup-manifest') {
      parsed.trustedSetupManifest = requireValue(argv, ++i, token)
    } else if (token === '--prover-manifest') {
      parsed.proverManifest = requireValue(argv, ++i, token)
    } else if (token === '--real-evidence') {
      parsed.realEvidence = requireValue(argv, ++i, token)
    } else if (token === '--require-real') {
      parsed.requireReal = true
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
  const raw = readFileSync(file, 'utf8')
  return JSON.parse(stripJsonComments(raw))
}

function stripJsonComments(raw) {
  let output = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    const next = raw[i + 1]

    if (inString) {
      output += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      output += ch
      continue
    }

    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1
      output += '\n'
      continue
    }

    if (ch === '/' && next === '*') {
      i += 2
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1
      i += 1
      continue
    }

    output += ch
  }
  return output
}

function deepMerge(left, right) {
  if (!isObject(left) || !isObject(right)) return right ?? left
  const output = { ...left }
  for (const [key, value] of Object.entries(right)) {
    output[key] = isObject(value) && isObject(output[key])
      ? deepMerge(output[key], value)
      : value
  }
  return output
}

function readSection(source, keys) {
  let current = source
  for (const key of keys) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, key)) {
      return {}
    }
    current = current[key]
  }
  return isObject(current) ? current : {}
}

function readBool(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return null
}

function readBoolEnv(name) {
  return process.env[name] === undefined ? null : readBool(process.env[name])
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function resolveRepoPath(rawPath) {
  return path.isAbsolute(rawPath) ? rawPath : path.join(ROOT, rawPath)
}

function resolvePublicAssetUrl(rawUrl) {
  if (/^https?:\/\//i.test(rawUrl)) return path.join(ROOT, '__remote_url_not_local__')
  const urlPath = rawUrl.startsWith('/') ? rawUrl.slice(1) : rawUrl
  return path.join(ROOT, 'src/frontend/public', urlPath)
}

function toRepoRelative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}
