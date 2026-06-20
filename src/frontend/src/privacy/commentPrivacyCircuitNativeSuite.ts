import { sha256 } from '@noble/hashes/sha2.js'
import type {
  CommentPrivacyCredentialIssuePayload,
  CommentPrivacyCredentialIssuerMetadata,
  CommentPrivacyCredentialSuite
} from './commentPrivacyCredentialProvider'
import type { CommentPrivacyCredentialMaterial } from './commentPrivacyTypes'

const REQUEST_MAGIC = new TextEncoder().encode('fsus-circuit-native-request-v2')
const OPENING_MAGIC = new TextEncoder().encode('fsus-circuit-native-opening-v2')
const WITNESS_MAGIC = new TextEncoder().encode('fsus-circuit-native-witness-v2')
const REVOCATION_HANDLE_DOMAIN = 'fsus.anonymous.revocation.handle.v2'
const DEFAULT_REPUTATION_BUCKET = 'unrated'

export interface ManagedCircuitNativeCredentialSuiteOptions {
  crypto: Pick<Crypto, 'getRandomValues'>
}

export function createManagedCircuitNativeCredentialSuite(
  options: ManagedCircuitNativeCredentialSuiteOptions
): CommentPrivacyCredentialSuite {
  const cryptoSource = options.crypto

  return {
    async createCredentialRequest(input): Promise<CommentPrivacyCredentialIssuePayload | null> {
      if (input.signal.aborted || typeof cryptoSource.getRandomValues !== 'function') {
        return null
      }

      const requestNonce = new Uint8Array(32)
      cryptoSource.getRandomValues(requestNonce)
      const metadataDigest = digestMetadata(input.metadata)
      const secretDigest = sha256(input.credentialSecret)
      const clientNonceDigest = sha256(input.clientNonce)

      return {
        credentialRequest: concatBytes(
          REQUEST_MAGIC,
          metadataDigest,
          secretDigest,
          clientNonceDigest,
          requestNonce
        ),
        credentialOpening: concatBytes(
          OPENING_MAGIC,
          secretDigest,
          clientNonceDigest,
          requestNonce
        )
      }
    },
    async acceptIssuerResponse(input): Promise<CommentPrivacyCredentialMaterial | null> {
      if (input.signal.aborted ||
        input.issuerSignature.byteLength === 0 ||
        !input.issuerPublicKeyId.trim() ||
        !isValidOpening(input.credentialOpening)) {
        return null
      }

      const witness = buildCredentialWitnessEnvelope({
        metadata: input.metadata,
        issuerPublicKeyId: input.issuerPublicKeyId,
        issuerSignature: input.issuerSignature,
        credentialOpening: input.credentialOpening
      })
      const credentialCommitment = sha256(witness)

      return {
        credentialSecret: new Uint8Array(input.credentialSecret),
        credentialCommitment,
        issuerSignature: new Uint8Array(input.issuerSignature),
        revocationWitness: witness,
        revocationHandleHash: deriveRevocationHandleHash(
          input.metadata.issuerPublicKeyHash,
          bytesToHex(credentialCommitment)),
        credentialLevel: input.response.credentialLevel || input.metadata.credentialLevel,
        reputationBucket: input.metadata.reputationBucket || DEFAULT_REPUTATION_BUCKET
      }
    }
  }
}

function isValidOpening(bytes: Uint8Array): boolean {
  return bytes.byteLength === OPENING_MAGIC.byteLength + 96 &&
    bytesEqual(bytes.subarray(0, OPENING_MAGIC.byteLength), OPENING_MAGIC)
}

function buildCredentialWitnessEnvelope(input: {
  metadata: CommentPrivacyCredentialIssuerMetadata
  issuerPublicKeyId: string
  issuerSignature: Uint8Array
  credentialOpening: Uint8Array
}): Uint8Array {
  const issuerPublicKeyId = utf8Bytes(input.issuerPublicKeyId)
  return concatBytes(
    WITNESS_MAGIC,
    numberToUint16Bytes(issuerPublicKeyId.byteLength),
    issuerPublicKeyId,
    digestMetadata(input.metadata),
    sha256(input.issuerSignature),
    sha256(input.credentialOpening)
  )
}

function digestMetadata(metadata: CommentPrivacyCredentialIssuerMetadata): Uint8Array {
  return sha256(utf8Bytes([
    String(metadata.credentialEpoch),
    String(metadata.circuitNumericId),
    String(metadata.publicInputLayoutVersion),
    metadata.circuitId,
    metadata.credentialLevel,
    metadata.reputationBucket,
    metadata.issuerPublicKeyHash
  ].join('\n')))
}

function deriveRevocationHandleHash(issuerPublicKeyHash: string, credentialBinding: string): Uint8Array {
  const issuer = normalizeToken(issuerPublicKeyHash, 128).toLowerCase()
  const binding = normalizeToken(credentialBinding, 256)
  return sha256(utf8Bytes([REVOCATION_HANDLE_DOMAIN, issuer, binding].join('\0')))
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

function numberToUint16Bytes(value: number): Uint8Array {
  const output = new Uint8Array(2)
  output[0] = (value >>> 8) & 0xff
  output[1] = value & 0xff
  return output
}

function normalizeToken(value: string, maxLength: number): string {
  const normalized = value.trim()
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export const managedCircuitNativeCredentialSuiteContract = {
  credentialRequestBytes: REQUEST_MAGIC.byteLength + 32 + 32 + 32 + 32,
  credentialOpeningBytes: OPENING_MAGIC.byteLength + 32 + 32 + 32
} as const
