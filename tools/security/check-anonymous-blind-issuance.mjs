#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
const fail = message => {
  throw new Error(message)
}
const requireText = (value, needle, label) => {
  if (!value.includes(needle)) fail(`${label} missing ${needle}`)
}
const rejectText = (value, needle, label) => {
  if (value.includes(needle)) fail(`${label} contains forbidden ${needle}`)
}

const protocol = JSON.parse(read('src/shared/Contracts/Validation/aeds-protocol.json'))
const frames = new Map(protocol.frameTypes.map(frame => [frame.name, frame.value]))
for (const [name, value] of [
  ['BlindCredentialIssuerMetadata', 193],
  ['BlindCredentialIssueRequest', 194],
  ['BlindCredentialIssueResponse', 195]
]) {
  if (frames.get(name) !== value) fail(`${name} frame mismatch`)
}

const endpoint = read('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AnonymousCredential.cs')
requireText(endpoint, 'anonymous_credential_legacy_issuance_rejected', 'endpoint')
requireText(endpoint, 'StatusCodes.Status410Gone', 'endpoint')
requireText(endpoint, 'ResolveBlindCredentialIssueAccountAsync', 'endpoint')
rejectText(
  endpoint,
  'group.MapPost("/anonymous-credential/issue", HandleAnonymousCredentialIssueAsync',
  'endpoint')

const blindHandlerStart = endpoint.indexOf('internal static async Task<BinaryFrameResult> HandleBlindCredentialIssueAsync')
const blindHandlerEnd = endpoint.indexOf('internal static async Task<BinaryFrameResult> HandleAnonymousCredentialRevocationArtifactAsync')
const blindHandler = endpoint.slice(blindHandlerStart, blindHandlerEnd)
rejectText(blindHandler, 'IAuditEventService', 'blind handler')
rejectText(blindHandler, 'TraceIdentifier', 'blind handler')
rejectText(blindHandler, 'RecordHighValueAsync', 'blind handler')

const signer = read('src/backend/Services/Security/Rfc9474BlindCredentialSigner.cs')
requireText(signer, 'ImportPkcs8PrivateKey', 'signer')
requireText(signer, 'RsaBlindedEngine', 'signer')
requireText(signer, 'FixedTimeEquals', 'signer')
requireText(signer, 'CryptographicOperations.ZeroMemory', 'signer')
rejectText(signer, 'ReadAllText', 'signer')
rejectText(signer, 'ImportFromPem', 'signer')

const issuanceService = read('src/backend/Services/Security/BlindCredentialIssuanceService.cs')
requireText(issuanceService, 'IAnonymousCredentialRootService roots', 'issuance service')
requireText(issuanceService, 'request.CredentialEpoch == root.CredentialEpoch', 'issuance service')
requireText(issuanceService, 'signer.PublicKeyHash, root.IssuerPublicKeyHash', 'issuance service')
requireText(issuanceService, 'root.VerifierConfigured', 'issuance service')

const suite = read('src/frontend/src/privacy/commentPrivacyBlindRsaSuite.ts')
for (const needle of [
  "exponentBytes) !== 65537n",
  'modulusBytes.byteLength !== MODULUS_BYTES',
  'sha256(metadata.subjectPublicKeyInfo)',
  "name: 'RSA-PSS'",
  'Number.isSafeInteger(metadata.credentialEpoch)'
]) requireText(suite, needle, 'browser suite')

const auditEntity = read('src/backend/Entities/AnonymousCredentialIssuanceAudit.cs')
rejectText(auditEntity, 'TraceId', 'issuance audit entity')
const migration = read('src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.AnonymousPrivacy.cs')
requireText(migration, 'SET trace_id = NULL', 'privacy migration')
requireText(migration, "date_trunc('hour'", 'privacy migration')

const evidence = JSON.parse(read('release-evidence/anonymous-credential-blind-issuance.json'))
if (evidence.issuanceImplementationStatus !== 'verified' ||
  evidence.presentationCircuitStatus !== 'not-run' ||
  evidence.productionUsable !== false ||
  evidence.noHostedService !== true) {
  fail('release evidence status is not fail-closed')
}
if (evidence.scenarioCoverage.length !== 5 ||
  evidence.scenarioCoverage.some(item => item.status !== 'covered')) {
  fail('five-scenario coverage is incomplete')
}

console.log('[anonymous-blind-issuance] contract and fail-closed evidence OK')
