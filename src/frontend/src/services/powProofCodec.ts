import type { PowParams } from '@/services/notificationStreamTypes'
import { AppErrorCode, createAppError } from '@/utils/appError'

type PowProofLayout = readonly string[]

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const MAGIC = [0x46, 0x50, 0x4f, 0x57] as const
const VERSION = 1

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function fromBase64(raw: string): Uint8Array {
  const binary = atob(raw)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function encodePowEnvelope(difficulty: number, timestamp: number, values: PowProofLayout): string {
  const parts = values.map((value) => encoder.encode(value))
  const totalLength = 4 + 1 + 4 + 8 + parts.reduce((sum, part) => sum + 2 + part.byteLength, 0)
  const bytes = new Uint8Array(totalLength)
  const view = new DataView(bytes.buffer)
  bytes.set(MAGIC, 0)
  bytes[4] = VERSION
  view.setInt32(5, difficulty, true)
  view.setBigInt64(9, BigInt(timestamp), true)

  let offset = 17
  for (const part of parts) {
    if (part.byteLength > 0xffff) {
      throw createAppError(AppErrorCode.Validation, 'POW_PROOF_FIELD_TOO_LARGE')
    }

    view.setUint16(offset, part.byteLength, true)
    offset += 2
    bytes.set(part, offset)
    offset += part.byteLength
  }

  return toBase64(bytes)
}

function decodePowEnvelope(raw: string, expectedParts: number): { difficulty: number; timestamp: number; parts: string[] } {
  const bytes = fromBase64(raw)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    bytes.byteLength < 17
    || bytes[0] !== MAGIC[0]
    || bytes[1] !== MAGIC[1]
    || bytes[2] !== MAGIC[2]
    || bytes[3] !== MAGIC[3]
    || bytes[4] !== VERSION
  ) {
    invalidPowEnvelope()
  }

  let offset = 17
  const parts: string[] = []
  while (offset < bytes.byteLength && parts.length < expectedParts) {
    if (offset + 2 > bytes.byteLength) {
      invalidPowEnvelope()
    }

    const length = view.getUint16(offset, true)
    offset += 2
    if (offset + length > bytes.byteLength) {
      invalidPowEnvelope()
    }

    parts.push(decoder.decode(bytes.subarray(offset, offset + length)))
    offset += length
  }

  if (parts.length !== expectedParts || offset !== bytes.byteLength) {
    invalidPowEnvelope()
  }

  return {
    difficulty: view.getInt32(5, true),
    timestamp: Number(view.getBigInt64(9, true)),
    parts
  }
}

export function encodeBinaryPowProofHeader(proof: {
  salt: string
  nonce: string
  timestamp: number
  difficulty: number
  signature: string
  browserFp: string
}): string {
  return encodePowEnvelope(proof.difficulty, proof.timestamp, [
    proof.salt,
    proof.nonce,
    proof.signature,
    proof.browserFp
  ])
}

export function encodeNotificationStreamPowProof(pow: PowParams): string {
  return encodePowEnvelope(pow.difficulty, pow.timestamp, [pow.salt, pow.nonce, pow.signature, pow.fp])
}

export function encodePowCache(pow: PowParams): string {
  return encodePowEnvelope(pow.difficulty, pow.timestamp, [pow.nonce, pow.salt, pow.fp, pow.signature])
}

function invalidPowEnvelope(): never {
  throw createAppError(AppErrorCode.ProtocolFailure, 'invalid_pow_envelope')
}

export function decodePowCache(raw: string): PowParams {
  const decoded = decodePowEnvelope(raw, 4)
  const [nonce, salt, fp, signature] = decoded.parts
  return {
    difficulty: decoded.difficulty,
    timestamp: decoded.timestamp,
    nonce,
    salt,
    fp,
    signature
  }
}
