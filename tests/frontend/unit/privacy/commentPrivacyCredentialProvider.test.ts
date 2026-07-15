import { beforeAll, describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  BLIND_CREDENTIAL_SCHEME,
  createBlindRsaCredentialSuite
} from '@/privacy/commentPrivacyBlindRsaSuite'
import type { CommentPrivacyCredentialIssuerMetadata } from '@/privacy/commentPrivacyCredentialProvider'
import type { BlindCredentialIssueResponse } from '@/api/comment'

const MODULUS_BYTES = 384
let cryptoKey: CryptoKeyPair
let publicSpki: Uint8Array
let publicHash: string
let privateJwk: JsonWebKey

beforeAll(async () => {
  cryptoKey = await crypto.subtle.generateKey(
    {
      name: 'RSA-PSS',
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-384'
    },
    true,
    ['sign', 'verify'])
  publicSpki = new Uint8Array(await crypto.subtle.exportKey('spki', cryptoKey.publicKey))
  publicHash = hex(sha256(publicSpki))
  privateJwk = await crypto.subtle.exportKey('jwk', cryptoKey.privateKey)
}, 30_000)

describe('RFC 9474 blind anonymous credential suite', () => {
  it('blind-signs, unblinds, and verifies without revealing credential material', async () => {
    const suite = createBlindRsaCredentialSuite({ crypto })
    const metadata = issuerMetadata()
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const nonce = crypto.getRandomValues(new Uint8Array(32))
    const signal = new AbortController().signal

    const request = await suite.createCredentialRequest({
      credentialSecret: secret,
      clientNonce: nonce,
      metadata,
      signal
    })
    expect(request?.credentialRequest).toHaveLength(MODULUS_BYTES)
    expect(request?.credentialOpening.byteLength).toBeGreaterThan(MODULUS_BYTES)
    expect(contains(request!.credentialRequest, secret)).toBe(false)
    expect(contains(request!.credentialRequest, nonce)).toBe(false)

    const blindSignature = blindSign(request!.credentialRequest)
    const response = issuerResponse(blindSignature)
    const credential = await suite.acceptIssuerResponse({
      credentialSecret: secret,
      clientNonce: nonce,
      credentialOpening: request!.credentialOpening,
      issuerPublicKeyId: response.issuerPublicKeyId,
      issuerSignature: response.blindSignature,
      metadata,
      response,
      signal
    })

    expect(credential).not.toBeNull()
    expect(credential?.issuerSignature).toHaveLength(MODULUS_BYTES)
    expect(credential?.credentialCommitment).toHaveLength(32)
    expect(credential?.revocationHandleHash).toHaveLength(32)
    expect(await crypto.subtle.verify(
      { name: 'RSA-PSS', saltLength: 48 },
      cryptoKey.publicKey,
      credential!.issuerSignature,
      readPreparedMessage(request!.credentialOpening))).toBe(true)
  }, 30_000)

  it('gives an issuer with both transcripts no deterministic two-client attribution', async () => {
    const suite = createBlindRsaCredentialSuite({ crypto })
    const metadata = issuerMetadata()
    const signal = new AbortController().signal
    const requests = await Promise.all([0, 1].map(async () => {
      const credentialSecret = crypto.getRandomValues(new Uint8Array(32))
      const clientNonce = crypto.getRandomValues(new Uint8Array(32))
      const request = (await suite.createCredentialRequest({
        credentialSecret,
        clientNonce,
        metadata,
        signal
      }))!
      const response = issuerResponse(blindSign(request.credentialRequest))
      const credential = (await suite.acceptIssuerResponse({
        credentialSecret,
        clientNonce,
        credentialOpening: request.credentialOpening,
        issuerPublicKeyId: response.issuerPublicKeyId,
        issuerSignature: response.blindSignature,
        metadata,
        response,
        signal
      }))!
      return { request, response, credential }
    }))

    const modulus = fromBase64Url(privateJwk.n!)
    const exponent = fromBase64Url(privateJwk.e!)
    const privateExponent = fromBase64Url(privateJwk.d!)
    const compatibility = requests.map(issuance =>
      requests.map(finalized => {
        const blinded = os2ip(issuance.request.credentialRequest)
        const blindSignature = os2ip(issuance.response.blindSignature)
        const signature = os2ip(finalized.credential.issuerSignature)
        const encodedMessage = modPow(signature, exponent, modulus)
        const blindToExponent = mod(blinded * modInverse(encodedMessage, modulus), modulus)
        const candidateBlind = modPow(blindToExponent, privateExponent, modulus)
        return mod(blindSignature * modInverse(candidateBlind, modulus), modulus) === signature
      }))

    expect(compatibility).toEqual([[true, true], [true, true]])
    expect(requests[0].credential.credentialCommitment)
      .not.toEqual(requests[1].credential.credentialCommitment)
  }, 30_000)

  it('fails closed on tamper, malformed opening, and issuer key rotation', async () => {
    const suite = createBlindRsaCredentialSuite({ crypto })
    const metadata = issuerMetadata()
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const nonce = crypto.getRandomValues(new Uint8Array(32))
    const signal = new AbortController().signal
    const request = (await suite.createCredentialRequest({
      credentialSecret: secret,
      clientNonce: nonce,
      metadata,
      signal
    }))!
    const signature = blindSign(request.credentialRequest)
    signature[0] ^= 0x80
    const response = issuerResponse(signature)

    expect(await suite.acceptIssuerResponse({
      credentialSecret: secret,
      clientNonce: nonce,
      credentialOpening: request.credentialOpening,
      issuerPublicKeyId: response.issuerPublicKeyId,
      issuerSignature: response.blindSignature,
      metadata,
      response,
      signal
    })).toBeNull()

    expect(await suite.createCredentialRequest({
      credentialSecret: secret,
      clientNonce: nonce,
      metadata: { ...metadata, issuerPublicKeyHash: '0'.repeat(64) },
      signal
    })).toBeNull()

    const validSignature = blindSign(request.credentialRequest)
    const validResponse = issuerResponse(validSignature)
    expect(await suite.acceptIssuerResponse({
      credentialSecret: secret,
      clientNonce: nonce,
      credentialOpening: request.credentialOpening,
      issuerPublicKeyId: validResponse.issuerPublicKeyId,
      issuerSignature: validResponse.blindSignature,
      metadata: { ...metadata, issuerPublicKeyHash: '0'.repeat(64) },
      response: validResponse,
      signal
    })).toBeNull()

    expect(await suite.createCredentialRequest({
      credentialSecret: secret,
      clientNonce: nonce,
      metadata: { ...metadata, credentialEpoch: Number.MAX_SAFE_INTEGER + 1 },
      signal
    })).toBeNull()
  }, 30_000)
})

function issuerMetadata(): CommentPrivacyCredentialIssuerMetadata {
  return {
    credentialEpoch: 42,
    rootExpiresAtUnixMs: Date.now() + 60_000,
    circuitNumericId: 4,
    publicInputLayoutVersion: 6,
    circuitId: 'fsus.anonymous.comment.v5',
    credentialLevel: 'basic',
    reputationBucket: 'unrated',
    issuerPublicKeyHash: publicHash,
    schemeId: BLIND_CREDENTIAL_SCHEME,
    issuerPublicKeyId: 'blind-rsa:test',
    modulusBytes: MODULUS_BYTES,
    subjectPublicKeyInfo: publicSpki,
    credentialRoot: new Uint8Array(32).fill(1),
    revocationRoot: new Uint8Array(32).fill(2),
    revocationDistribution: {
      protocol: 'public-snapshot-delta.v1',
      epoch: 42,
      version: 0,
      contentAddress: '02'.repeat(32),
      snapshotPath: `/api/binary/anonymous-credential/revocation/42/0/${'02'.repeat(32)}/full.aeds`,
      deltaPath: null,
      entryBytes: 32,
      maxArtifactBytes: 4 * 1024 * 1024
    }
  }
}

function issuerResponse(blindSignature: Uint8Array): BlindCredentialIssueResponse {
  return {
    credentialEpoch: 42,
    expiresAtUnixMs: Date.now() + 60_000,
    circuitNumericId: 4,
    publicInputLayoutVersion: 6,
    circuitId: 'fsus.anonymous.comment.v5',
    credentialLevel: 'basic',
    schemeId: BLIND_CREDENTIAL_SCHEME,
    issuerPublicKeyId: 'blind-rsa:test',
    blindSignature
  }
}

function blindSign(blindedMessage: Uint8Array): Uint8Array {
  const modulus = fromBase64Url(privateJwk.n!)
  const privateExponent = fromBase64Url(privateJwk.d!)
  return i2osp(modPow(os2ip(blindedMessage), privateExponent, modulus), MODULUS_BYTES)
}

function readPreparedMessage(opening: Uint8Array): Uint8Array {
  const magicLength = new TextEncoder().encode('FSUS-RFC9474-OPENING-V1').byteLength
  const length = (opening[magicLength] << 8) | opening[magicLength + 1]
  return opening.slice(magicLength + 2, magicLength + 2 + length)
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) {
        continue outer
      }
    }
    return true
  }
  return false
}

function fromBase64Url(value: string): bigint {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const bytes = Uint8Array.from(
    atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')),
    character => character.charCodeAt(0))
  return os2ip(bytes)
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let value = mod(base, modulus)
  let power = exponent
  while (power > 0n) {
    if ((power & 1n) === 1n) result = mod(result * value, modulus)
    value = mod(value * value, modulus)
    power >>= 1n
  }
  return result
}

function modInverse(value: bigint, modulus: bigint): bigint {
  let [oldR, r] = [value, modulus]
  let [oldS, s] = [1n, 0n]
  while (r !== 0n) {
    const quotient = oldR / r
    ;[oldR, r] = [r, oldR - quotient * r]
    ;[oldS, s] = [s, oldS - quotient * s]
  }
  return mod(oldS, modulus)
}

function os2ip(bytes: Uint8Array): bigint {
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n)
}

function i2osp(value: bigint, length: number): Uint8Array {
  const output = new Uint8Array(length)
  let current = value
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = Number(current & 0xffn)
    current >>= 8n
  }
  return output
}

function mod(value: bigint, modulus: bigint): bigint {
  const result = value % modulus
  return result >= 0n ? result : result + modulus
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
