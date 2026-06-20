// Portions adapted from the CFRG Blind BBS draft fixtures and algorithms
// (Apache-2.0), cfrg/draft-irtf-cfrg-bbs-blind-signatures commit
// cf6ad94041e16cf29c2b45b08241085f4d837d60.
// Curve arithmetic is provided by @noble/curves (MIT).
// Modifications: converted the draft commitment-with-proof path to an ES2022
// browser credential-request suite for FsusBlog anonymous comments.

import { bls12_381 } from '@noble/curves/bls12-381.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type {
  CommentPrivacyBlindCredentialSuite,
  CommentPrivacyBlindIssuanceRequest,
  CommentPrivacyCredentialIssuerMetadata
} from './commentPrivacyCredentialProvider'
import type { CommentPrivacyCredentialMaterial } from './commentPrivacyTypes'

type G1Point = ReturnType<typeof G1.fromHex>

const G1 = bls12_381.shortSignatures.Signature

const API_ID = 'BBS_BLS12381G1_XMD:SHA-256_SSWU_RO_BLIND_H2G_HM2S_'
const HASH_TO_SCALAR_SUFFIX = 'H2S_'
const MAP_MESSAGE_TO_SCALAR_SUFFIX = 'MAP_MSG_TO_SCALAR_AS_HASH_'
const SCALAR_ORDER = BigInt('0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001')
const SCALAR_BYTES = 32
const POINT_BYTES = 48
const COMMITTED_MESSAGE_COUNT = 1
const COMMITMENT_WITH_PROOF_BYTES = POINT_BYTES + 3 * SCALAR_BYTES
const OPENING_MAGIC = new TextEncoder().encode('fsus-bbs-blind-opening-v1')
const WITNESS_MAGIC = new TextEncoder().encode('fsus-bbs-credential-witness-v1')

const BLIND_Q1 = G1.fromHex('a347532dc0ba9b83e4f15f3eeb7dffd934f5fa4668d927fbcb68096d5a26f6e59f66681201be1c263af1a25b6749759c')
const BLIND_MESSAGE_GENERATORS = [
  G1.fromHex('af590ba56aa0e526a0763ae6926347dce988ffb9cc1a0b4510ada06fe08816f5c36a6c7007cc8558e5793f9a2cbae462')
]

export interface ManagedBbsBlindCredentialSuiteOptions {
  crypto: Pick<Crypto, 'getRandomValues'>
}

export function createManagedBbsBlindCredentialSuite(
  options: ManagedBbsBlindCredentialSuiteOptions
): CommentPrivacyBlindCredentialSuite {
  const cryptoSource = options.crypto

  return {
    async createBlindIssuanceRequest(input): Promise<CommentPrivacyBlindIssuanceRequest | null> {
      if (input.signal.aborted || typeof cryptoSource.getRandomValues !== 'function') {
        return null
      }

      const committedMessage = mapCredentialSecretToScalar(input.credentialSecret)
      const proverBlind = randomScalar(cryptoSource)
      const blindTilde = randomScalar(cryptoSource)
      const messageTilde = randomScalar(cryptoSource)
      const generators = blindGenerators(COMMITTED_MESSAGE_COUNT)

      const commitment = generators[0]
        .multiply(proverBlind)
        .add(generators[1].multiply(committedMessage))
      const cbar = generators[0]
        .multiply(blindTilde)
        .add(generators[1].multiply(messageTilde))
      const challenge = calculateBlindChallenge(commitment, cbar, generators)
      const blindCommitment = scalarAdd(blindTilde, scalarMul(proverBlind, challenge))
      const messageCommitment = scalarAdd(messageTilde, scalarMul(committedMessage, challenge))

      return {
        blindedRequest: concatBytes(
          pointToBytes(commitment),
          scalarToBytes(blindCommitment),
          scalarToBytes(messageCommitment),
          scalarToBytes(challenge)
        ),
        blindOpening: buildBlindOpening(committedMessage, proverBlind)
      }
    },
    async unblindIssuerResponse(input): Promise<CommentPrivacyCredentialMaterial | null> {
      if (input.signal.aborted ||
        input.bbsSignature.byteLength === 0 ||
        !input.issuerPublicKeyId.trim()) {
        return null
      }

      const opening = parseBlindOpening(input.blindOpening)
      if (!opening) {
        return null
      }

      return {
        credentialSecret: scalarToBytes(opening.committedMessage),
        issuerSignature: new Uint8Array(input.bbsSignature),
        revocationWitness: buildCredentialWitnessEnvelope({
          metadata: input.metadata,
          issuerPublicKeyId: input.issuerPublicKeyId,
          bbsSignature: input.bbsSignature,
          committedMessage: opening.committedMessage,
          proverBlind: opening.proverBlind
        })
      }
    }
  }
}

function blindGenerators(count: number): G1Point[] {
  return [BLIND_Q1, ...BLIND_MESSAGE_GENERATORS.slice(0, count)]
}

function calculateBlindChallenge(
  commitment: G1Point,
  cbar: G1Point,
  generators: readonly G1Point[]
): bigint {
  const count = numberToUint64Bytes(BigInt(generators.length - 1))
  return hashToScalar(concatBytes(
    count,
    ...generators.map(pointToBytes),
    pointToBytes(commitment),
    pointToBytes(cbar)
  ), API_ID + HASH_TO_SCALAR_SUFFIX)
}

function mapCredentialSecretToScalar(credentialSecret: Uint8Array): bigint {
  return parseScalar(credentialSecret) ?? hashToScalar(credentialSecret, API_ID + MAP_MESSAGE_TO_SCALAR_SUFFIX)
}

function hashToScalar(message: Uint8Array, dst: string): bigint {
  const uniform = expandMessageXmdSha256(message, asciiBytes(dst), 48)
  return mod(bytesToNumberBE(uniform), SCALAR_ORDER)
}

function expandMessageXmdSha256(message: Uint8Array, dst: Uint8Array, length: number): Uint8Array {
  if (dst.byteLength > 255) {
    throw new Error('comment_privacy_credential_unavailable')
  }

  const ell = Math.ceil(length / 32)
  if (ell <= 0 || ell > 255) {
    throw new Error('comment_privacy_credential_unavailable')
  }

  const dstPrime = concatBytes(dst, new Uint8Array([dst.byteLength]))
  const msgPrime = concatBytes(
    new Uint8Array(64),
    message,
    numberToUint16Bytes(length),
    new Uint8Array([0]),
    dstPrime
  )
  const b0 = sha256(msgPrime)
  let b = sha256(concatBytes(b0, new Uint8Array([1]), dstPrime))
  const output = new Uint8Array(ell * 32)
  output.set(b, 0)
  for (let i = 2; i <= ell; i += 1) {
    const xored = new Uint8Array(32)
    for (let index = 0; index < xored.byteLength; index += 1) {
      xored[index] = b0[index] ^ b[index]
    }
    b = sha256(concatBytes(xored, new Uint8Array([i]), dstPrime))
    output.set(b, (i - 1) * 32)
  }

  return output.subarray(0, length)
}

function randomScalar(cryptoSource: Pick<Crypto, 'getRandomValues'>): bigint {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const bytes = new Uint8Array(SCALAR_BYTES)
    cryptoSource.getRandomValues(bytes)
    const scalar = bytesToNumberBE(bytes)
    if (scalar > 0n && scalar < SCALAR_ORDER) {
      return scalar
    }
  }

  const seed = new Uint8Array(SCALAR_BYTES + 1)
  cryptoSource.getRandomValues(seed.subarray(0, SCALAR_BYTES))
  seed[SCALAR_BYTES] = 1
  return hashToScalar(seed, API_ID + HASH_TO_SCALAR_SUFFIX)
}

function buildBlindOpening(committedMessage: bigint, proverBlind: bigint): Uint8Array {
  return concatBytes(OPENING_MAGIC, scalarToBytes(committedMessage), scalarToBytes(proverBlind))
}

function parseBlindOpening(bytes: Uint8Array): { committedMessage: bigint; proverBlind: bigint } | null {
  if (bytes.byteLength !== OPENING_MAGIC.byteLength + 2 * SCALAR_BYTES ||
    !bytesEqual(bytes.subarray(0, OPENING_MAGIC.byteLength), OPENING_MAGIC)) {
    return null
  }

  const committedMessage = parseScalar(bytes.subarray(OPENING_MAGIC.byteLength, OPENING_MAGIC.byteLength + SCALAR_BYTES))
  const proverBlind = parseScalar(bytes.subarray(OPENING_MAGIC.byteLength + SCALAR_BYTES))
  return committedMessage && proverBlind
    ? { committedMessage, proverBlind }
    : null
}

function buildCredentialWitnessEnvelope(input: {
  metadata: CommentPrivacyCredentialIssuerMetadata
  issuerPublicKeyId: string
  bbsSignature: Uint8Array
  committedMessage: bigint
  proverBlind: bigint
}): Uint8Array {
  const issuerPublicKeyId = utf8Bytes(input.issuerPublicKeyId)
  const metadataDigest = sha256(utf8Bytes([
    String(input.metadata.credentialEpoch),
    String(input.metadata.circuitNumericId),
    String(input.metadata.publicInputLayoutVersion),
    input.metadata.circuitId,
    input.metadata.credentialLevel,
    input.metadata.issuerPublicKeyHash
  ].join('\n')))
  return concatBytes(
    WITNESS_MAGIC,
    numberToUint16Bytes(issuerPublicKeyId.byteLength),
    issuerPublicKeyId,
    metadataDigest,
    sha256(input.bbsSignature),
    scalarToBytes(input.committedMessage),
    scalarToBytes(input.proverBlind)
  )
}

function parseScalar(bytes: Uint8Array): bigint | null {
  if (bytes.byteLength !== SCALAR_BYTES) {
    return null
  }

  const scalar = bytesToNumberBE(bytes)
  return scalar > 0n && scalar < SCALAR_ORDER ? scalar : null
}

function scalarAdd(left: bigint, right: bigint): bigint {
  return mod(left + right, SCALAR_ORDER)
}

function scalarMul(left: bigint, right: bigint): bigint {
  return mod(left * right, SCALAR_ORDER)
}

function mod(value: bigint, modulus: bigint): bigint {
  const result = value % modulus
  return result >= 0n ? result : result + modulus
}

function pointToBytes(point: G1Point): Uint8Array {
  return new Uint8Array(G1.toBytes(point))
}

function scalarToBytes(value: bigint): Uint8Array {
  return numberToBytesBE(mod(value, SCALAR_ORDER), SCALAR_BYTES)
}

function bytesToNumberBE(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte)
  }
  return value
}

function numberToBytesBE(value: bigint, length: number): Uint8Array {
  const output = new Uint8Array(length)
  let cursor = value
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = Number(cursor & 0xffn)
    cursor >>= 8n
  }
  return output
}

function numberToUint16Bytes(value: number): Uint8Array {
  const output = new Uint8Array(2)
  output[0] = (value >>> 8) & 0xff
  output[1] = value & 0xff
  return output
}

function numberToUint64Bytes(value: bigint): Uint8Array {
  return numberToBytesBE(value, 8)
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

function asciiBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export const managedBbsBlindCredentialSuiteContract = {
  commitmentWithProofBytes: COMMITMENT_WITH_PROOF_BYTES,
  scalarBytes: SCALAR_BYTES,
  pointBytes: POINT_BYTES
} as const
