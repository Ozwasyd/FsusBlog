#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CIRCUIT_ID = 'fsus.anonymous.comment.v5'
const LAYOUT_VERSION = 6
const SAMPLE_SCOPE_COUNT = 100
const FORBIDDEN_STABLE_FIELDS = [
  'credential_commitment',
  'revocation_handle',
  'issuer_audit_id',
  'credential_leaf_index',
  'stable_witness_hash',
  'stable_presentation_key'
]
const EXPECTED_PUBLIC_INPUTS = [
  'action_context',
  'scope',
  'circuit_id',
  'verifying_key_hash',
  'public_input_layout_version',
  'nullifier_hash',
  'credential_root',
  'revocation_root',
  'issuer_public_key_hash',
  'policy_hash',
  'is_eligible',
  'may_comment',
  'rate_class',
  'requires_moderation'
]

const args = parseArgs(process.argv.slice(2))
const manifestPath = resolvePath(process.env.FSUSBLOG_ZK_UNLINKABILITY_MANIFEST, 'security/zk/contracts/comment-v5-circuit.manifest.json')
const sourcePath = resolvePath(process.env.FSUSBLOG_ZK_UNLINKABILITY_SOURCE, 'src/zk/circuits/anonymous-comment-v5/comment_v5.circuit.json')
const outputPath = resolvePath(args.out, '.tmp/security/comment-v5-unlinkability.json')
const failures = []

const manifest = readJson(manifestPath, 'circuit manifest')
const source = readJson(sourcePath, 'circuit source')
checkProtocol(manifest, source)
checkWireSources()
const vector = buildVector()

if (failures.length > 0) {
  for (const failure of failures) console.error(`[zk-comment-unlinkability] ${failure}`)
  process.exit(1)
}

const evidence = {
  schema: 'fsusblog.zk.comment-unlinkability.v1',
  status: 'ok',
  evidence_kind: 'deterministic-wire-contract',
  production_usable: false,
  circuit_id: CIRCUIT_ID,
  public_input_layout_version: LAYOUT_VERSION,
  sampled_scopes: SAMPLE_SCOPE_COUNT,
  complete_wire_transcripts_unique: true,
  same_scope_nullifier_stable: true,
  different_scope_nullifiers_unique: true,
  credential_specific_stable_fields: [],
  legacy_layout_rejected: true,
  public_input_schema_sha256: sha256(JSON.stringify(EXPECTED_PUBLIC_INPUTS)),
  transcript_set_sha256: vector.transcriptSetSha256,
  note: 'Repository-local layout-6 deterministic contract evidence; real Groth16 release evidence remains separately required.'
}
mkdirSync(path.dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`[zk-comment-unlinkability] ok evidence=${relative(outputPath)} scopes=${SAMPLE_SCOPE_COUNT}`)

function checkProtocol(manifestValue, sourceValue) {
  for (const [label, value] of [['manifest', manifestValue], ['source', sourceValue]]) {
    if (value.circuit_id !== CIRCUIT_ID) fail(`${label}.circuit_id must be ${CIRCUIT_ID}`)
    if (Number(value.public_input_layout_version) !== LAYOUT_VERSION) fail(`${label}.public_input_layout_version must be ${LAYOUT_VERSION}`)
    const inputs = label === 'manifest'
      ? array(value.public_inputs).map((entry) => typeof entry === 'string' ? text(entry) : text(entry?.name))
      : array(value.public_inputs).map((entry) => typeof entry === 'string' ? text(entry) : text(entry?.name))
    if (JSON.stringify(inputs) !== JSON.stringify(EXPECTED_PUBLIC_INPUTS)) {
      fail(`${label}.public_inputs must use the exact unlinkable layout 6 order`)
    }
    for (const forbidden of FORBIDDEN_STABLE_FIELDS) {
      if (inputs.includes(forbidden)) fail(`${label}.public_inputs exposes ${forbidden}`)
    }
  }

  const policy = object(manifestValue.transcript_unlinkability)
  if (Number(policy.sample_scope_count) < SAMPLE_SCOPE_COUNT) fail('manifest transcript sample scope count must be at least 100')
  if (policy.complete_wire_transcript_checked !== true) fail('manifest must require complete wire transcript checks')
  if (!Array.isArray(policy.credential_specific_stable_fields_allowed) || policy.credential_specific_stable_fields_allowed.length !== 0) {
    fail('manifest must allow no credential-specific stable public field')
  }
}

function checkWireSources() {
  const backendCodec = readText('src/backend/Services/Security/NativeGroth16ZkProofBackend.cs')
  const backendEncode = between(backendCodec, 'internal static class NativeGroth16PublicInputCodec', 'internal sealed class')
  if (backendEncode.includes('CredentialCommitment')) fail('native verifier public-input codec still serializes CredentialCommitment')
  if (!backendEncode.includes('fsus.anonymous.comment.v5.public-inputs')) fail('native verifier transcript domain is not upgraded')

  const podSource = readText('src/shared/Contracts/Models/CommentPods.cs')
  const ticketPod = between(podSource, 'public readonly struct AnonymousCommentTicketRequestPod', 'public readonly struct AnonymousCommentTicketResponsePod')
  if (ticketPod.includes('CredentialCommitment')) fail('ticket request POD still exposes CredentialCommitment')

  const frontendApi = readText('src/frontend/src/api/comment.ts')
  const ticketEncoder = between(frontendApi, 'export function encodeAnonymousCommentTicketRequest', 'export function encodeAnonymousCommentCreateRequest')
  if (ticketEncoder.includes('credentialCommitment')) fail('browser ticket encoder still sends credentialCommitment')

  const prover = readText('src/frontend/src/privacy/commentPrivacyWasmProver.ts')
  const publicEncoder = between(prover, 'function encodeNativeGroth16PublicInputs', 'function writeString')
  if (publicEncoder.includes('credentialCommitment')) fail('browser public-input codec still serializes credentialCommitment')
  if (!prover.includes('fsus.anonymous.comment.v5.public-inputs')) fail('browser transcript domain is not upgraded')
}

function buildVector() {
  const credentialSecret = Buffer.from('1135-unlinkability-credential-secret')
  const shared = {
    credentialRoot: sha256('credential-root'),
    revocationRoot: sha256('revocation-root'),
    issuerPublicKeyHash: sha256('issuer-public-key'),
    policyHash: sha256('policy'),
    verifyingKeyHash: sha256('new-v5-verifying-key')
  }
  const nullifiers = new Set()
  const transcripts = new Set()
  const transcriptDigests = []

  for (let index = 1; index <= SAMPLE_SCOPE_COUNT; index += 1) {
    const scope = `article:${index}`
    const nullifier = scopedNullifier(credentialSecret, scope)
    const repeated = scopedNullifier(credentialSecret, scope)
    if (nullifier !== repeated) fail(`same-scope nullifier is unstable for ${scope}`)
    if (nullifiers.has(nullifier)) fail(`different scopes produced the same nullifier at ${scope}`)
    nullifiers.add(nullifier)

    const publicInputs = encodeCanonicalPublicInputs({ scope, nullifier, ...shared })
    const presentationNonce = sha256(`presentation-nonce:${scope}`)
    const proof = sha256(Buffer.concat([credentialSecret, Buffer.from(scope), Buffer.from(presentationNonce)]))
    const ticketRequest = encodeTicketTranscript({ scope, publicInputs, proof, nullifier, ...shared })
    const transcriptDigest = sha256(ticketRequest)
    if (transcripts.has(transcriptDigest)) fail(`complete wire transcript repeats at ${scope}`)
    transcripts.add(transcriptDigest)
    transcriptDigests.push(transcriptDigest)
  }

  if (nullifiers.size !== SAMPLE_SCOPE_COUNT) fail('nullifier set does not cover 100 scopes')
  if (transcripts.size !== SAMPLE_SCOPE_COUNT) fail('wire transcript set does not cover 100 scopes')
  return { transcriptSetSha256: sha256(transcriptDigests.join('\n')) }
}

function scopedNullifier(secret, scope) {
  return sha256(Buffer.concat([
    Buffer.from('fsus.anonymous.comment.v5:nullifier:v1\0comment.create\0'),
    Buffer.from(scope),
    Buffer.from([0]),
    secret
  ]))
}

function encodeCanonicalPublicInputs({ scope, nullifier, credentialRoot, revocationRoot, issuerPublicKeyHash, policyHash, verifyingKeyHash }) {
  return Buffer.from(JSON.stringify({
    domain: 'fsus.anonymous.comment.v5.public-inputs',
    circuitId: CIRCUIT_ID,
    layoutVersion: LAYOUT_VERSION,
    actionContext: 'comment.create',
    scope,
    nullifierHash: nullifier,
    credentialRoot,
    revocationRoot,
    issuerPublicKeyHash,
    policyHash,
    verifyingKeyHash,
    isEligible: true,
    mayComment: true,
    rateClass: 'common',
    requiresModeration: false
  }))
}

function encodeTicketTranscript({ scope, publicInputs, proof, nullifier, credentialRoot, revocationRoot, verifyingKeyHash }) {
  return Buffer.concat([
    Buffer.from(JSON.stringify({
      articleId: Number(scope.slice('article:'.length)),
      circuitId: CIRCUIT_ID,
      layoutVersion: LAYOUT_VERSION,
      scope,
      nullifierHash: nullifier,
      credentialRoot,
      revocationRoot,
      verifyingKeyHash
    })),
    publicInputs,
    Buffer.from(proof, 'hex')
  ])
}

function readJson(file, label) {
  if (!existsSync(file)) {
    fail(`${label} missing: ${relative(file)}`)
    return {}
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function readText(file) {
  const absolute = resolvePath(null, file)
  if (!existsSync(absolute)) {
    fail(`source missing: ${file}`)
    return ''
  }
  return readFileSync(absolute, 'utf8')
}

function between(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  if (startIndex < 0 || endIndex < 0) return source
  return source.slice(startIndex, endIndex)
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') parsed.out = argv[++index]
    else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  return parsed
}

function resolvePath(value, fallback) {
  const selected = text(value) || fallback
  return path.isAbsolute(selected) ? selected : path.join(ROOT, selected)
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fail(message) {
  failures.push(message)
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}
