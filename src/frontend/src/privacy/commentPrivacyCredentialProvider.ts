import { encodeAedsFrame } from '@/api/binaryFrame'
import {
  encodeBlindCredentialIssueRequest,
  getBlindCredentialIssuerMetadata,
  getAnonymousCredentialRevocationWitness,
  getAnonymousCredentialCircuitSnapshot,
  getAnonymousCredentialRootSnapshot,
  type BlindCredentialIssueRequestDto,
  type BlindCredentialIssueResponse,
  type AnonymousCredentialRevocationWitnessRequestDto,
  type AnonymousCredentialRevocationWitnessResponse,
  type AnonymousCredentialRootSnapshot
} from '@/api/comment'
import { requestBinaryOnly } from '@/services/binaryTransport'
import { FrameType } from '@wasm/protocol/frame'
import type { CommentPrivacyCredentialMaterial } from './commentPrivacyTypes'
import { createBlindRsaCredentialSuite } from './commentPrivacyBlindRsaSuite'
import { encodeCommentPrivacyRevocationWitnessMaterial } from './commentPrivacyRevocationWitness'
import {
  createCommentPrivacyCredentialVault,
  currentCommentPrivacyVaultPartition,
  type CommentPrivacyCredentialVault,
  type CommentPrivacyCredentialVaultPartition
} from './commentPrivacyCredentialVault'
import {
  purgeCommentPrivacyCredentialState,
  type CommentPrivacyCredentialPurgeReason,
  zeroizeCommentPrivacyBytes
} from './commentPrivacyCredentialLifecycle'

export type { CommentPrivacyCredentialVault } from './commentPrivacyCredentialVault'

const DEFAULT_CREDENTIAL_SECRET_BYTES = 32
const DEFAULT_CLIENT_NONCE_BYTES = 32
const DEFAULT_FAILURE_CACHE_TTL_MS = 30_000
const DEFAULT_CREDENTIAL_LEVEL = 'strong_anonymous'
const DEFAULT_REPUTATION_BUCKET = 'unrated'

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
  schemeId: string
  issuerPublicKeyId: string
  modulusBytes: number
  subjectPublicKeyInfo: Uint8Array
  credentialRoot: Uint8Array
  revocationRoot: Uint8Array
}

export type CommentPrivacyCredentialMetadataLoader = (
  request: { signal: AbortSignal }
) => Promise<CommentPrivacyCredentialIssuerMetadata | null>

export type CommentPrivacyCredentialIssuer = (
  request: BlindCredentialIssueRequestDto,
  config: { signal: AbortSignal }
) => Promise<BlindCredentialIssueResponse>

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
    response: BlindCredentialIssueResponse
    signal: AbortSignal
  }): Promise<CommentPrivacyCredentialMaterial | null>
}

export interface CommentPrivacyCredentialProviderOptions {
  vault?: CommentPrivacyCredentialVault | null
  loadMetadata?: CommentPrivacyCredentialMetadataLoader
  issueCredential?: CommentPrivacyCredentialIssuer
  loadRevocationWitness?: CommentPrivacyRevocationWitnessLoader
  credentialSuite?: CommentPrivacyCredentialSuite | null
  crypto?: Pick<Crypto, 'getRandomValues' | 'subtle'> | null
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
    ? createBlindRsaCredentialSuite({ crypto: cryptoSource })
    : options.credentialSuite ?? null
  const now = options.now ?? (() => Date.now())
  const unavailableCacheTtlMs = options.unavailableCacheTtlMs ?? DEFAULT_FAILURE_CACHE_TTL_MS
  const credentialSecretBytes = options.credentialSecretBytes ?? DEFAULT_CREDENTIAL_SECRET_BYTES
  const clientNonceBytes = options.clientNonceBytes ?? DEFAULT_CLIENT_NONCE_BYTES
  let unavailableUntilUnixMs = 0
  let lastMetadata: CommentPrivacyCredentialIssuerMetadata | null = null

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

      const temporaryBytes: Uint8Array[] = []
      const track = (bytes: Uint8Array): Uint8Array => {
        temporaryBytes.push(bytes)
        return bytes
      }
      try {
        if (vault.initialize && !await vault.initialize()) {
          await vault.clear()
          lastMetadata = null
          return failClosed(signal)
        }
        await vault.pruneExpired(now())
        const metadata = await loadMetadata({ signal })
        if (signal.aborted) {
          return null
        }
        if (!isUsableMetadata(metadata, now())) {
          if (lastMetadata) {
            await purgeCommentPrivacyCredentialState('feature-disabled')
            await vault.clear()
            lastMetadata = null
          }
          return failClosed(signal)
        }

        if (lastMetadata && metadataBinding(lastMetadata) !== metadataBinding(metadata)) {
          const rotationReason = classifyMetadataRotation(lastMetadata, metadata)
          lastMetadata = cloneMetadata(metadata)
          await purgeCommentPrivacyCredentialState(rotationReason)
          await vault.clear()
          return null
        }
        lastMetadata = cloneMetadata(metadata)
        const partition = metadataPartition(metadata)
        const cached = await vault.get(partition)
        if (cached) {
          const result = cloneCredentialMaterial(cached)
          zeroizeCredentialMaterial(cached)
          return result
        }

        if (!credentialSuite) {
          return failClosed(signal)
        }

        const credentialSecret = track(randomBytes(cryptoSource, credentialSecretBytes))
        const clientNonce = track(randomBytes(cryptoSource, clientNonceBytes))
        const credentialIssuePayload = await credentialSuite.createCredentialRequest({
          credentialSecret: track(cloneBytes(credentialSecret)),
          clientNonce: track(cloneBytes(clientNonce)),
          metadata,
          signal
        })
        if (signal.aborted) {
          return null
        }
        if (!isUsableCredentialIssuePayload(credentialIssuePayload)) {
          return failClosed(signal)
        }
        track(credentialIssuePayload.credentialRequest)
        track(credentialIssuePayload.credentialOpening)

        const issuerResponse = await issueCredential({
          credentialEpoch: metadata.credentialEpoch,
          circuitNumericId: metadata.circuitNumericId,
          publicInputLayoutVersion: metadata.publicInputLayoutVersion,
          circuitId: metadata.circuitId,
          credentialLevel: metadata.credentialLevel,
          schemeId: metadata.schemeId,
          issuerPublicKeyId: metadata.issuerPublicKeyId,
          blindedMessage: track(cloneBytes(credentialIssuePayload.credentialRequest))
        }, { signal })
        if (signal.aborted) {
          return null
        }
        if (!matchesMetadata(issuerResponse, metadata) || issuerResponse.rootExpiresAtUnixMs <= now()) {
          return failClosed(signal)
        }
        track(issuerResponse.blindSignature)

        const material = await credentialSuite.acceptIssuerResponse({
          credentialSecret: track(cloneBytes(credentialSecret)),
          clientNonce: track(cloneBytes(clientNonce)),
          credentialOpening: track(cloneBytes(credentialIssuePayload.credentialOpening)),
          issuerPublicKeyId: issuerResponse.issuerPublicKeyId,
          issuerSignature: track(cloneBytes(issuerResponse.blindSignature)),
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
        trackCredentialMaterial(material, track)

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
          revocationRoot: track(cloneBytes(metadata.revocationRoot)),
          revocationHandleHash: track(cloneBytes(material.revocationHandleHash))
        }, { signal })
        if (signal.aborted) {
          return null
        }
        if (!(revocationWitness instanceof Uint8Array) || revocationWitness.byteLength === 0) {
          return failClosed(signal)
        }
        track(revocationWitness)

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
        trackCredentialMaterial(credential, track)
        const storedCredential = {
          ...partition,
          ...cloneCredentialMaterial(credential),
          expiresAtUnixMs,
          issuerPublicKeyId: issuerResponse.issuerPublicKeyId
        }
        await vault.put(storedCredential)
        zeroizeCredentialMaterial(storedCredential)

        return cloneCredentialMaterial(credential)
      } catch {
        return failClosed(signal)
      } finally {
        for (const bytes of temporaryBytes) {
          zeroizeCommentPrivacyBytes(bytes)
        }
      }
    }
  }
}

export async function issueAnonymousCredential(
  request: BlindCredentialIssueRequestDto,
  config: { signal: AbortSignal }
): Promise<BlindCredentialIssueResponse> {
  const payload = encodeBlindCredentialIssueRequest(request)
  return await requestBinaryOnly<BlindCredentialIssueResponse>({
    binaryUrl: '/api/binary/anonymous-credential/blind-issue',
    frameType: FrameType.BlindCredentialIssueResponse,
    signal: config.signal,
    requestOptions: {
      method: 'POST',
      credentials: 'include',
      body: encodeAedsFrame(FrameType.BlindCredentialIssueRequest, payload)
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
  const [root, circuit, blindIssuer] = await Promise.all([
    getAnonymousCredentialRootSnapshot({ signal: request.signal, credentials: 'omit' }),
    getAnonymousCredentialCircuitSnapshot({ signal: request.signal, credentials: 'omit' }),
    getBlindCredentialIssuerMetadata({ signal: request.signal, credentials: 'omit' })
  ])
  const issuerPublicKeyHash = readIssuerPublicKeyHash(root)
  const circuitId = root.circuitId || circuit.circuitId
  if (!root.zkAnonymousEnabled ||
    !root.verifierConfigured ||
    !issuerPublicKeyHash ||
    !circuitId ||
    blindIssuer.issuerPublicKeyHash.trim().toLowerCase() !== issuerPublicKeyHash.trim().toLowerCase() ||
    blindIssuer.credentialEpoch !== root.credentialEpoch ||
    blindIssuer.circuitId !== circuitId ||
    blindIssuer.publicInputLayoutVersion !== root.publicInputLayoutVersion) {
    return null
  }

  return {
    credentialEpoch: root.credentialEpoch,
    rootExpiresAtUnixMs: root.rootExpiresAtUnixMs,
    circuitNumericId: root.circuitNumericId,
    publicInputLayoutVersion: root.publicInputLayoutVersion,
    circuitId,
    credentialLevel: blindIssuer.credentialLevel || DEFAULT_CREDENTIAL_LEVEL,
    reputationBucket: DEFAULT_REPUTATION_BUCKET,
    issuerPublicKeyHash,
    schemeId: blindIssuer.schemeId,
    issuerPublicKeyId: blindIssuer.issuerPublicKeyId,
    modulusBytes: blindIssuer.modulusBytes,
    subjectPublicKeyInfo: cloneBytes(blindIssuer.subjectPublicKeyInfo),
    credentialRoot: cloneBytes(root.credentialRoot),
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

  return Number.isSafeInteger(metadata.credentialEpoch) &&
    metadata.credentialEpoch > 0 &&
    Number.isFinite(metadata.rootExpiresAtUnixMs) &&
    metadata.rootExpiresAtUnixMs > nowUnixMs &&
    Number.isSafeInteger(metadata.circuitNumericId) &&
    metadata.circuitNumericId > 0 &&
    Number.isSafeInteger(metadata.publicInputLayoutVersion) &&
    metadata.publicInputLayoutVersion > 0 &&
    Boolean(metadata.circuitId) &&
    Boolean(metadata.credentialLevel) &&
    Boolean(metadata.reputationBucket) &&
    Boolean(metadata.issuerPublicKeyHash) &&
    Boolean(metadata.schemeId) &&
    Boolean(metadata.issuerPublicKeyId) &&
    metadata.modulusBytes === 384 &&
    metadata.subjectPublicKeyInfo instanceof Uint8Array &&
    metadata.subjectPublicKeyInfo.byteLength > 0 &&
    metadata.credentialRoot instanceof Uint8Array &&
    metadata.credentialRoot.byteLength > 0 &&
    metadata.revocationRoot instanceof Uint8Array &&
    metadata.revocationRoot.byteLength > 0
}

function metadataPartition(
  metadata: CommentPrivacyCredentialIssuerMetadata
): CommentPrivacyCredentialVaultPartition {
  return currentCommentPrivacyVaultPartition({
    credentialEpoch: metadata.credentialEpoch,
    circuitId: metadata.circuitId,
    issuerPublicKeyHash: metadata.issuerPublicKeyHash
  })
}

function metadataBinding(metadata: CommentPrivacyCredentialIssuerMetadata): string {
  return [
    metadata.credentialEpoch,
    metadata.circuitNumericId,
    metadata.publicInputLayoutVersion,
    metadata.circuitId,
    metadata.issuerPublicKeyHash.trim().toLowerCase(),
    metadata.schemeId,
    metadata.issuerPublicKeyId,
    bytesToHex(metadata.credentialRoot),
    bytesToHex(metadata.revocationRoot)
  ].join(':')
}

function classifyMetadataRotation(
  previous: CommentPrivacyCredentialIssuerMetadata,
  current: CommentPrivacyCredentialIssuerMetadata
): CommentPrivacyCredentialPurgeReason {
  if (previous.credentialEpoch !== current.credentialEpoch) {
    return 'epoch-changed'
  }
  if (previous.issuerPublicKeyHash.trim().toLowerCase() !== current.issuerPublicKeyHash.trim().toLowerCase()) {
    return 'issuer-key-rotation'
  }
  return 'root-retired'
}

function cloneMetadata(metadata: CommentPrivacyCredentialIssuerMetadata): CommentPrivacyCredentialIssuerMetadata {
  return {
    ...metadata,
    subjectPublicKeyInfo: cloneBytes(metadata.subjectPublicKeyInfo),
    credentialRoot: cloneBytes(metadata.credentialRoot),
    revocationRoot: cloneBytes(metadata.revocationRoot)
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
  response: BlindCredentialIssueResponse,
  metadata: CommentPrivacyCredentialIssuerMetadata
): boolean {
  return response.credentialEpoch === metadata.credentialEpoch &&
    response.circuitNumericId === metadata.circuitNumericId &&
    response.publicInputLayoutVersion === metadata.publicInputLayoutVersion &&
    response.circuitId === metadata.circuitId &&
    response.schemeId === metadata.schemeId &&
    response.issuerPublicKeyId === metadata.issuerPublicKeyId &&
    typeof response.issuerPublicKeyId === 'string' &&
    response.issuerPublicKeyId.trim().length > 0 &&
    response.blindSignature instanceof Uint8Array &&
    response.blindSignature.byteLength === metadata.modulusBytes
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

function trackCredentialMaterial(
  material: CommentPrivacyCredentialMaterial,
  track: (bytes: Uint8Array) => Uint8Array
): void {
  track(material.credentialSecret)
  track(material.credentialCommitment)
  track(material.issuerSignature)
  track(material.revocationWitness)
  if (material.revocationHandleHash) {
    track(material.revocationHandleHash)
  }
}

function zeroizeCredentialMaterial(material: CommentPrivacyCredentialMaterial): void {
  zeroizeCommentPrivacyBytes(material.credentialSecret)
  zeroizeCommentPrivacyBytes(material.credentialCommitment)
  zeroizeCommentPrivacyBytes(material.issuerSignature)
  zeroizeCommentPrivacyBytes(material.revocationWitness)
  zeroizeCommentPrivacyBytes(material.revocationHandleHash)
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
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
  return encodeCommentPrivacyRevocationWitnessMaterial(response)
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

function getGlobalCrypto(): Pick<Crypto, 'getRandomValues' | 'subtle'> | null {
  return typeof globalThis.crypto === 'undefined'
    ? null
    : globalThis.crypto
}
