import { encodeAedsFrame } from '@/api/binaryFrame'
import {
  encodeAnonymousCredentialIssueRequest,
  getAnonymousCredentialCircuitSnapshot,
  getAnonymousCredentialRootSnapshot,
  type AnonymousCredentialIssueRequestDto,
  type AnonymousCredentialIssueResponse,
  type AnonymousCredentialRootSnapshot
} from '@/api/comment'
import { requestBinaryOnly } from '@/services/binaryTransport'
import { FrameType } from '@wasm/protocol/frame'
import type { CommentPrivacyCredentialMaterial } from './commentPrivacyTypes'
import {
  createCommentPrivacyCredentialVault,
  type CommentPrivacyCredentialVault,
  type CommentPrivacyCredentialVaultPartition
} from './commentPrivacyCredentialVault'

export type { CommentPrivacyCredentialVault } from './commentPrivacyCredentialVault'

const DEFAULT_CREDENTIAL_SECRET_BYTES = 32
const DEFAULT_CLIENT_NONCE_BYTES = 32
const DEFAULT_FAILURE_CACHE_TTL_MS = 30_000
const DEFAULT_CREDENTIAL_LEVEL = 'strong_anonymous'

export interface CommentPrivacyCredentialProvider {
  prepareCredential(request: { signal: AbortSignal }): Promise<CommentPrivacyCredentialMaterial | null>
}

export interface CommentPrivacyCredentialIssuerMetadata {
  credentialEpoch: number
  rootExpiresAtUnixMs: number
  circuitNumericId: number
  publicInputLayoutVersion: number
  circuitId: string
  credentialLevel: string
  issuerPublicKeyHash: string
}

export type CommentPrivacyCredentialMetadataLoader = (
  request: { signal: AbortSignal }
) => Promise<CommentPrivacyCredentialIssuerMetadata | null>

export type CommentPrivacyCredentialIssuer = (
  request: AnonymousCredentialIssueRequestDto,
  config: { signal: AbortSignal }
) => Promise<AnonymousCredentialIssueResponse>

export interface CommentPrivacyBlindIssuanceRequest {
  blindedRequest: Uint8Array
  blindOpening: Uint8Array
}

export interface CommentPrivacyBlindCredentialSuite {
  createBlindIssuanceRequest(input: {
    credentialSecret: Uint8Array
    clientNonce: Uint8Array
    metadata: CommentPrivacyCredentialIssuerMetadata
    signal: AbortSignal
  }): Promise<CommentPrivacyBlindIssuanceRequest | null>
  unblindIssuerResponse(input: {
    credentialSecret: Uint8Array
    clientNonce: Uint8Array
    blindOpening: Uint8Array
    issuerResponse: Uint8Array
    credentialCommitment: Uint8Array
    metadata: CommentPrivacyCredentialIssuerMetadata
    response: AnonymousCredentialIssueResponse
    signal: AbortSignal
  }): Promise<CommentPrivacyCredentialMaterial | null>
}

export interface CommentPrivacyCredentialProviderOptions {
  vault?: CommentPrivacyCredentialVault | null
  loadMetadata?: CommentPrivacyCredentialMetadataLoader
  issueCredential?: CommentPrivacyCredentialIssuer
  blindCredentialSuite?: CommentPrivacyBlindCredentialSuite | null
  crypto?: Pick<Crypto, 'getRandomValues'> | null
  now?: () => number
  unavailableCacheTtlMs?: number
  credentialSecretBytes?: number
  clientNonceBytes?: number
}

export function createCommentPrivacyCredentialProvider(
  options: CommentPrivacyCredentialProviderOptions = {}
): CommentPrivacyCredentialProvider {
  const vault = options.vault === undefined
    ? createCommentPrivacyCredentialVault()
    : options.vault
  const cryptoSource = options.crypto === undefined
    ? getGlobalCrypto()
    : options.crypto
  const loadMetadata = options.loadMetadata ?? loadDefaultCredentialMetadata
  const issueCredential = options.issueCredential ?? issueAnonymousCredential
  const blindCredentialSuite = options.blindCredentialSuite ?? null
  const now = options.now ?? (() => Date.now())
  const unavailableCacheTtlMs = options.unavailableCacheTtlMs ?? DEFAULT_FAILURE_CACHE_TTL_MS
  const credentialSecretBytes = options.credentialSecretBytes ?? DEFAULT_CREDENTIAL_SECRET_BYTES
  const clientNonceBytes = options.clientNonceBytes ?? DEFAULT_CLIENT_NONCE_BYTES
  let unavailableUntilUnixMs = 0

  const failClosed = (signal: AbortSignal): null => {
    if (!signal.aborted) {
      unavailableUntilUnixMs = now() + unavailableCacheTtlMs
    }
    return null
  }

  return {
    async prepareCredential({ signal }) {
      if (signal.aborted || now() < unavailableUntilUnixMs) {
        return null
      }
      if (!vault || !cryptoSource || typeof cryptoSource.getRandomValues !== 'function') {
        return failClosed(signal)
      }

      try {
        await vault.pruneExpired(now())
        const metadata = await loadMetadata({ signal })
        if (signal.aborted) {
          return null
        }
        if (!isUsableMetadata(metadata, now())) {
          return failClosed(signal)
        }

        const partition = metadataPartition(metadata)
        const cached = await vault.get(partition)
        if (cached) {
          return cloneCredentialMaterial(cached)
        }

        if (!blindCredentialSuite) {
          return failClosed(signal)
        }

        const credentialSecret = randomBytes(cryptoSource, credentialSecretBytes)
        const clientNonce = randomBytes(cryptoSource, clientNonceBytes)
        const blindRequest = await blindCredentialSuite.createBlindIssuanceRequest({
          credentialSecret: cloneBytes(credentialSecret),
          clientNonce: cloneBytes(clientNonce),
          metadata,
          signal
        })
        if (signal.aborted) {
          return null
        }
        if (!isUsableBlindRequest(blindRequest)) {
          return failClosed(signal)
        }

        const issuerResponse = await issueCredential({
          credentialEpoch: metadata.credentialEpoch,
          circuitNumericId: metadata.circuitNumericId,
          publicInputLayoutVersion: metadata.publicInputLayoutVersion,
          circuitId: metadata.circuitId,
          credentialLevel: metadata.credentialLevel,
          blindedRequest: cloneBytes(blindRequest.blindedRequest),
          clientNonce: cloneBytes(clientNonce)
        }, { signal })
        if (signal.aborted) {
          return null
        }
        if (!matchesMetadata(issuerResponse, metadata) || issuerResponse.rootExpiresAtUnixMs <= now()) {
          return failClosed(signal)
        }

        const material = await blindCredentialSuite.unblindIssuerResponse({
          credentialSecret: cloneBytes(credentialSecret),
          clientNonce: cloneBytes(clientNonce),
          blindOpening: cloneBytes(blindRequest.blindOpening),
          issuerResponse: cloneBytes(issuerResponse.issuerResponse),
          credentialCommitment: cloneBytes(issuerResponse.credentialCommitment),
          metadata,
          response: issuerResponse,
          signal
        })
        if (signal.aborted) {
          return null
        }
        if (!isUsableCredentialMaterial(material)) {
          return failClosed(signal)
        }

        const expiresAtUnixMs = Math.min(metadata.rootExpiresAtUnixMs, issuerResponse.rootExpiresAtUnixMs)
        if (expiresAtUnixMs <= now()) {
          return failClosed(signal)
        }

        const credential = cloneCredentialMaterial(material)
        await vault.put({
          ...partition,
          ...credential,
          expiresAtUnixMs,
          credentialLevel: issuerResponse.credentialLevel,
          credentialCommitment: cloneBytes(issuerResponse.credentialCommitment)
        })

        return cloneCredentialMaterial(credential)
      } catch {
        return failClosed(signal)
      }
    }
  }
}

export async function issueAnonymousCredential(
  request: AnonymousCredentialIssueRequestDto,
  config: { signal: AbortSignal }
): Promise<AnonymousCredentialIssueResponse> {
  const payload = encodeAnonymousCredentialIssueRequest(request)
  return await requestBinaryOnly<AnonymousCredentialIssueResponse>({
    binaryUrl: '/api/binary/anonymous-credential/issue',
    frameType: FrameType.AnonymousCredentialIssueResponse,
    signal: config.signal,
    requestOptions: {
      method: 'POST',
      credentials: 'include',
      body: encodeAedsFrame(FrameType.AnonymousCredentialIssueRequest, payload)
    }
  })
}

async function loadDefaultCredentialMetadata(
  request: { signal: AbortSignal }
): Promise<CommentPrivacyCredentialIssuerMetadata | null> {
  const [root, circuit] = await Promise.all([
    getAnonymousCredentialRootSnapshot({ signal: request.signal, credentials: 'omit' }),
    getAnonymousCredentialCircuitSnapshot({ signal: request.signal, credentials: 'omit' })
  ])
  const issuerPublicKeyHash = readIssuerPublicKeyHash(root)
  const circuitId = root.circuitId || circuit.circuitId
  if (!root.zkAnonymousEnabled ||
    !root.verifierConfigured ||
    !issuerPublicKeyHash ||
    !circuitId) {
    return null
  }

  return {
    credentialEpoch: root.credentialEpoch,
    rootExpiresAtUnixMs: root.rootExpiresAtUnixMs,
    circuitNumericId: root.circuitNumericId,
    publicInputLayoutVersion: root.publicInputLayoutVersion,
    circuitId,
    credentialLevel: DEFAULT_CREDENTIAL_LEVEL,
    issuerPublicKeyHash
  }
}

function readIssuerPublicKeyHash(root: AnonymousCredentialRootSnapshot): string {
  const issuerPublicKeyHash = (root as AnonymousCredentialRootSnapshot & {
    issuerPublicKeyHash?: unknown
  }).issuerPublicKeyHash
  return typeof issuerPublicKeyHash === 'string' && issuerPublicKeyHash.trim()
    ? issuerPublicKeyHash.trim()
    : ''
}

function isUsableMetadata(
  metadata: CommentPrivacyCredentialIssuerMetadata | null,
  nowUnixMs: number
): metadata is CommentPrivacyCredentialIssuerMetadata {
  if (!metadata) {
    return false
  }

  return Number.isFinite(metadata.credentialEpoch) &&
    metadata.credentialEpoch > 0 &&
    Number.isFinite(metadata.rootExpiresAtUnixMs) &&
    metadata.rootExpiresAtUnixMs > nowUnixMs &&
    Number.isFinite(metadata.circuitNumericId) &&
    Number.isFinite(metadata.publicInputLayoutVersion) &&
    Boolean(metadata.circuitId) &&
    Boolean(metadata.credentialLevel) &&
    Boolean(metadata.issuerPublicKeyHash)
}

function metadataPartition(
  metadata: CommentPrivacyCredentialIssuerMetadata
): CommentPrivacyCredentialVaultPartition {
  return {
    credentialEpoch: metadata.credentialEpoch,
    circuitId: metadata.circuitId,
    issuerPublicKeyHash: metadata.issuerPublicKeyHash
  }
}

function isUsableBlindRequest(
  request: CommentPrivacyBlindIssuanceRequest | null
): request is CommentPrivacyBlindIssuanceRequest {
  return Boolean(request) &&
    request?.blindedRequest instanceof Uint8Array &&
    request.blindedRequest.byteLength > 0 &&
    request.blindOpening instanceof Uint8Array &&
    request.blindOpening.byteLength > 0
}

function matchesMetadata(
  response: AnonymousCredentialIssueResponse,
  metadata: CommentPrivacyCredentialIssuerMetadata
): boolean {
  return response.credentialEpoch === metadata.credentialEpoch &&
    response.circuitNumericId === metadata.circuitNumericId &&
    response.publicInputLayoutVersion === metadata.publicInputLayoutVersion &&
    response.circuitId === metadata.circuitId &&
    response.issuerResponse instanceof Uint8Array &&
    response.issuerResponse.byteLength > 0 &&
    response.credentialCommitment instanceof Uint8Array &&
    response.credentialCommitment.byteLength > 0
}

function isUsableCredentialMaterial(
  material: CommentPrivacyCredentialMaterial | null
): material is CommentPrivacyCredentialMaterial {
  return Boolean(material) &&
    material?.credentialSecret instanceof Uint8Array &&
    material.credentialSecret.byteLength > 0 &&
    material.issuerSignature instanceof Uint8Array &&
    material.issuerSignature.byteLength > 0 &&
    material.revocationWitness instanceof Uint8Array &&
    material.revocationWitness.byteLength > 0
}

function randomBytes(
  cryptoSource: Pick<Crypto, 'getRandomValues'>,
  byteLength: number
): Uint8Array {
  const bytes = new Uint8Array(byteLength)
  cryptoSource.getRandomValues(bytes)
  return bytes
}

function cloneCredentialMaterial(material: CommentPrivacyCredentialMaterial): CommentPrivacyCredentialMaterial {
  return {
    credentialSecret: cloneBytes(material.credentialSecret),
    issuerSignature: cloneBytes(material.issuerSignature),
    revocationWitness: cloneBytes(material.revocationWitness)
  }
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

function getGlobalCrypto(): Pick<Crypto, 'getRandomValues'> | null {
  return typeof globalThis.crypto === 'undefined'
    ? null
    : globalThis.crypto
}
