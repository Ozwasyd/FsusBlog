import { encodeAedsFrame } from '@/api/binaryFrame'
import {
  encodeAnonymousCredentialIssueRequest,
  getAnonymousCredentialRevocationWitness,
  getAnonymousCredentialCircuitSnapshot,
  getAnonymousCredentialRootSnapshot,
  type AnonymousCredentialIssueRequestDto,
  type AnonymousCredentialIssueResponse,
  type AnonymousCredentialRevocationWitnessRequestDto,
  type AnonymousCredentialRevocationWitnessResponse,
  type AnonymousCredentialRootSnapshot
} from '@/api/comment'
import { requestBinaryOnly } from '@/services/binaryTransport'
import { FrameType } from '@wasm/protocol/frame'
import type { CommentPrivacyCredentialMaterial } from './commentPrivacyTypes'
import { createManagedCircuitNativeCredentialSuite } from './commentPrivacyCircuitNativeSuite'
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
const DEFAULT_REPUTATION_BUCKET = 'unrated'
const REVOCATION_WITNESS_MAGIC = new TextEncoder().encode('fsus-revocation-witness-v1')

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
  reputationBucket: string
  issuerPublicKeyHash: string
  revocationRoot: Uint8Array
}

export type CommentPrivacyCredentialMetadataLoader = (
  request: { signal: AbortSignal }
) => Promise<CommentPrivacyCredentialIssuerMetadata | null>

export type CommentPrivacyCredentialIssuer = (
  request: AnonymousCredentialIssueRequestDto,
  config: { signal: AbortSignal }
) => Promise<AnonymousCredentialIssueResponse>

export type CommentPrivacyRevocationWitnessLoader = (
  request: AnonymousCredentialRevocationWitnessRequestDto,
  config: { signal: AbortSignal }
) => Promise<Uint8Array | null>

export interface CommentPrivacyCredentialIssuePayload {
  credentialRequest: Uint8Array
  credentialOpening: Uint8Array
}

export interface CommentPrivacyCredentialSuite {
  createCredentialRequest(input: {
    credentialSecret: Uint8Array
    clientNonce: Uint8Array
    metadata: CommentPrivacyCredentialIssuerMetadata
    signal: AbortSignal
  }): Promise<CommentPrivacyCredentialIssuePayload | null>
  acceptIssuerResponse(input: {
    credentialSecret: Uint8Array
    clientNonce: Uint8Array
    credentialOpening: Uint8Array
    issuerPublicKeyId: string
    issuerSignature: Uint8Array
    metadata: CommentPrivacyCredentialIssuerMetadata
    response: AnonymousCredentialIssueResponse
    signal: AbortSignal
  }): Promise<CommentPrivacyCredentialMaterial | null>
}

export interface CommentPrivacyCredentialProviderOptions {
  vault?: CommentPrivacyCredentialVault | null
  loadMetadata?: CommentPrivacyCredentialMetadataLoader
  issueCredential?: CommentPrivacyCredentialIssuer
  loadRevocationWitness?: CommentPrivacyRevocationWitnessLoader
  credentialSuite?: CommentPrivacyCredentialSuite | null
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
  const loadRevocationWitness = options.loadRevocationWitness ?? loadAnonymousCredentialRevocationWitness
  const credentialSuite = options.credentialSuite === undefined && cryptoSource
    ? createManagedCircuitNativeCredentialSuite({ crypto: cryptoSource })
    : options.credentialSuite ?? null
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

        if (!credentialSuite) {
          return failClosed(signal)
        }

        const credentialSecret = randomBytes(cryptoSource, credentialSecretBytes)
        const clientNonce = randomBytes(cryptoSource, clientNonceBytes)
        const credentialIssuePayload = await credentialSuite.createCredentialRequest({
          credentialSecret: cloneBytes(credentialSecret),
          clientNonce: cloneBytes(clientNonce),
          metadata,
          signal
        })
        if (signal.aborted) {
          return null
        }
        if (!isUsableCredentialIssuePayload(credentialIssuePayload)) {
          return failClosed(signal)
        }

        const issuerResponse = await issueCredential({
          credentialEpoch: metadata.credentialEpoch,
          circuitNumericId: metadata.circuitNumericId,
          publicInputLayoutVersion: metadata.publicInputLayoutVersion,
          circuitId: metadata.circuitId,
          credentialLevel: metadata.credentialLevel,
          credentialRequest: cloneBytes(credentialIssuePayload.credentialRequest),
          clientNonce: cloneBytes(clientNonce)
        }, { signal })
        if (signal.aborted) {
          return null
        }
        if (!matchesMetadata(issuerResponse, metadata) || issuerResponse.rootExpiresAtUnixMs <= now()) {
          return failClosed(signal)
        }

        const material = await credentialSuite.acceptIssuerResponse({
          credentialSecret: cloneBytes(credentialSecret),
          clientNonce: cloneBytes(clientNonce),
          credentialOpening: cloneBytes(credentialIssuePayload.credentialOpening),
          issuerPublicKeyId: issuerResponse.issuerPublicKeyId,
          issuerSignature: cloneBytes(issuerResponse.issuerSignature),
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

        if (!(material.revocationHandleHash instanceof Uint8Array) ||
          material.revocationHandleHash.byteLength === 0 ||
          metadata.revocationRoot.byteLength === 0) {
          return failClosed(signal)
        }

        const revocationWitness = await loadRevocationWitness({
          credentialEpoch: metadata.credentialEpoch,
          circuitNumericId: metadata.circuitNumericId,
          publicInputLayoutVersion: metadata.publicInputLayoutVersion,
          circuitId: metadata.circuitId,
          issuerPublicKeyHash: metadata.issuerPublicKeyHash,
          revocationRoot: cloneBytes(metadata.revocationRoot),
          revocationHandleHash: cloneBytes(material.revocationHandleHash)
        }, { signal })
        if (signal.aborted) {
          return null
        }
        if (!(revocationWitness instanceof Uint8Array) || revocationWitness.byteLength === 0) {
          return failClosed(signal)
        }

        const expiresAtUnixMs = Math.min(metadata.rootExpiresAtUnixMs, issuerResponse.rootExpiresAtUnixMs)
        if (expiresAtUnixMs <= now()) {
          return failClosed(signal)
        }

        const credential = cloneCredentialMaterial({
          ...material,
          revocationWitness: cloneBytes(revocationWitness),
          credentialLevel: issuerResponse.credentialLevel || material.credentialLevel || metadata.credentialLevel,
          reputationBucket: material.reputationBucket || metadata.reputationBucket || DEFAULT_REPUTATION_BUCKET
        })
        await vault.put({
          ...partition,
          ...credential,
          expiresAtUnixMs,
          issuerPublicKeyId: issuerResponse.issuerPublicKeyId
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

export async function loadAnonymousCredentialRevocationWitness(
  request: AnonymousCredentialRevocationWitnessRequestDto,
  config: { signal: AbortSignal }
): Promise<Uint8Array | null> {
  const response = await getAnonymousCredentialRevocationWitness(request, { signal: config.signal })
  if (!matchesRevocationWitness(response, request)) {
    return null
  }

  return encodeRevocationWitnessMaterial(response)
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
    reputationBucket: DEFAULT_REPUTATION_BUCKET,
    issuerPublicKeyHash,
    revocationRoot: cloneBytes(root.revocationRoot)
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
    Boolean(metadata.reputationBucket) &&
    Boolean(metadata.issuerPublicKeyHash) &&
    metadata.revocationRoot instanceof Uint8Array &&
    metadata.revocationRoot.byteLength > 0
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

function isUsableCredentialIssuePayload(
  request: CommentPrivacyCredentialIssuePayload | null
): request is CommentPrivacyCredentialIssuePayload {
  return Boolean(request) &&
    request?.credentialRequest instanceof Uint8Array &&
    request.credentialRequest.byteLength > 0 &&
    request.credentialOpening instanceof Uint8Array &&
    request.credentialOpening.byteLength > 0
}

function matchesMetadata(
  response: AnonymousCredentialIssueResponse,
  metadata: CommentPrivacyCredentialIssuerMetadata
): boolean {
  return response.credentialEpoch === metadata.credentialEpoch &&
    response.circuitNumericId === metadata.circuitNumericId &&
    response.publicInputLayoutVersion === metadata.publicInputLayoutVersion &&
    response.circuitId === metadata.circuitId &&
    typeof response.issuerPublicKeyId === 'string' &&
    response.issuerPublicKeyId.trim().length > 0 &&
    response.issuerSignature instanceof Uint8Array &&
    response.issuerSignature.byteLength > 0
}

function isUsableCredentialMaterial(
  material: CommentPrivacyCredentialMaterial | null
): material is CommentPrivacyCredentialMaterial {
  return Boolean(material) &&
    material?.credentialSecret instanceof Uint8Array &&
    material.credentialSecret.byteLength > 0 &&
    material.credentialCommitment instanceof Uint8Array &&
    material.credentialCommitment.byteLength > 0 &&
    material.issuerSignature instanceof Uint8Array &&
    material.issuerSignature.byteLength > 0 &&
    material.revocationWitness instanceof Uint8Array &&
    material.revocationWitness.byteLength > 0 &&
    typeof material.credentialLevel === 'string' &&
    material.credentialLevel.length > 0 &&
    typeof material.reputationBucket === 'string' &&
    material.reputationBucket.length > 0
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
  const cloned: CommentPrivacyCredentialMaterial = {
    credentialSecret: cloneBytes(material.credentialSecret),
    credentialCommitment: cloneBytes(material.credentialCommitment),
    issuerSignature: cloneBytes(material.issuerSignature),
    revocationWitness: cloneBytes(material.revocationWitness),
    credentialLevel: material.credentialLevel,
    reputationBucket: material.reputationBucket
  }
  if (material.revocationHandleHash instanceof Uint8Array && material.revocationHandleHash.byteLength > 0) {
    cloned.revocationHandleHash = cloneBytes(material.revocationHandleHash)
  }
  return cloned
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

function matchesRevocationWitness(
  response: AnonymousCredentialRevocationWitnessResponse,
  request: AnonymousCredentialRevocationWitnessRequestDto
): boolean {
  return response.credentialEpoch === request.credentialEpoch &&
    response.algorithmId === 'circuit-friendly-non-membership.v1' &&
    response.pathDepth > 0 &&
    response.siblingHashes instanceof Uint8Array &&
    response.siblingHashes.byteLength === response.pathDepth * 32 &&
    response.issuerPublicKeyHash.trim().toLowerCase() === request.issuerPublicKeyHash.trim().toLowerCase() &&
    bytesEqual(response.revocationRoot, bytesFrom(request.revocationRoot)) &&
    bytesEqual(response.revocationHandleHash, bytesFrom(request.revocationHandleHash)) &&
    response.leafKey instanceof Uint8Array &&
    response.leafKey.byteLength > 0 &&
    response.witnessHash instanceof Uint8Array &&
    response.witnessHash.byteLength > 0
}

function encodeRevocationWitnessMaterial(response: AnonymousCredentialRevocationWitnessResponse): Uint8Array {
  const algorithm = new TextEncoder().encode(response.algorithmId)
  const issuer = new TextEncoder().encode(response.issuerPublicKeyHash)
  return concatBytes(
    REVOCATION_WITNESS_MAGIC,
    numberToUint64Bytes(BigInt(response.credentialEpoch)),
    numberToUint16Bytes(response.pathDepth),
    lengthPrefixed(algorithm),
    lengthPrefixed(issuer),
    lengthPrefixed(response.revocationRoot),
    lengthPrefixed(response.revocationHandleHash),
    lengthPrefixed(response.leafKey),
    lengthPrefixed(response.witnessHash),
    lengthPrefixed(response.siblingHashes)
  )
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const prefix = new Uint8Array(4)
  new DataView(prefix.buffer).setUint32(0, bytes.byteLength, true)
  return concatBytes(prefix, bytes)
}

function numberToUint16Bytes(value: number): Uint8Array {
  const bytes = new Uint8Array(2)
  new DataView(bytes.buffer).setUint16(0, value, true)
  return bytes
}

function numberToUint64Bytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value, true)
  return bytes
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function bytesFrom(value: Uint8Array | number[] | null | undefined): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value ?? [])
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false
  }

  let diff = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    diff |= left[index] ^ right[index]
  }
  return diff === 0
}

function getGlobalCrypto(): Pick<Crypto, 'getRandomValues'> | null {
  return typeof globalThis.crypto === 'undefined'
    ? null
    : globalThis.crypto
}
