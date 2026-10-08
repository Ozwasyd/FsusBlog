import { beforeAll, describe, expect, it, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import * as commentApi from '@/api/comment'
import {
  BLIND_CREDENTIAL_SCHEME,
  createBlindRsaCredentialSuite
} from '@/privacy/commentPrivacyBlindRsaSuite'
import { createCommentPrivacyCredentialProvider } from '@/privacy/commentPrivacyCredentialProvider'
import type {
  CommentPrivacyCredentialIssueResponse,
  CommentPrivacyCredentialIssuerMetadata,
  CommentPrivacyCredentialSuite
} from '@/privacy/commentPrivacyContracts'

const MODULUS_BYTES = 384
const TEST_PRIVATE_JWK: JsonWebKey = {
  key_ops: ['sign'],
  ext: true,
  alg: 'PS384',
  kty: 'RSA',
  n: 'inprTHscd5CbXloge4g7_dbUyP5_0-upUa0VYwj0F2JImMUAmCaMnILt50oSEIs_Gq_dVWRP94_8WKN32a_h1A-dyGkcoS0BMtSlBcU5O60L8P9h1QQy4wt2mQ70GLA7MK7_F8Gzc_V7TDfjGoeLcsyPqMoFT3yMNF5a0TrfK8AUC0CyqzCbUoHs4UDVZxDVraGJDVZyZqJdQIDULvKhPky-J9MNkeBzBBQR8j-2KrkBHQ057Bm9lF97yVHglWVdOKrQ7Ubp7Kd_qG76NnjlfJ4A60qSvTmWrwnD407D3zxotgBKX8tVFB4Z-zFD4Z0C1It_2_XYiOC6lrEhkoZsRxkaMx5G9MEvpgTYQh0TqyiJKJ_ZLdP2G0PSuLOyA8SAqAiTI_iorMXo5Xq-CMT6mFf8k3IRHuz-5MaHPabIQdMhIoDCPVi-CuUuV1TRRJ70pbDYDKaI8U_sjpLoqB49QgC1bQfJSoIwZvCEQVWrz9i7Vdswu3TfMEtVbmCPYIdv',
  e: 'AQAB',
  d: 'KfuVXjmQ1tr7j65pXKpf7cRc_JbT8E7pJX8BFeZYAmLkuZQ4auh9BtJXCCEXuvZMam3Y_5OK_vYjPkhJBLFjGOSnJGRhrqezTlLTuR0jDemXzjfO1EMSnm0SRrMW5AlB2K-lXPF303cgK2piKt_fMi28fCLLW17aLuJQTFC56kywhvzVbjstS-ViCKScTkP3VE29_FIyGtWsyeqE6brbkcS4feBpo8lVdW4URsp0Ex3FraYd4munYz1TjSSKnyB8oYczRA5IwW35c_dTzgTxIgBJeug8oIKU5r0Lc8n5HAfKSfmC8tVmL1T9xp0IZFqFlh3AMavKSlVuFbGpkuTiAdBWYeqbBV5XG5AZlUnaPKuziv9aHzWHCohEDtzOEb3Rm4_DHx43z5HtMu2aIYkwrOaNwRKlCFxeef0NWC14RoUca8d9ZdyqqgXXnmoYFmskZAXbadEQ7oyQIuNuOuaspSXSrxcHcarWkgdE714J6OIDOUmng_xpybkbTZiKtBGh',
  p: 'wPY1CPMBxD2vtuhpoAymZIqwUyaO2qg8TgWAoFAqMdYqRGc3LfpuGuX_f0xlp3ubOtFRu5LgoHnFbEqwc7N06QB9dhmSbfOAFUa3Q7phSLG9a1DnT4V-UarlYaNleC8GWqD98kQNAET1URJPuuiWc_pNFvLhnV_eAcptB3NL205rIBYGSTsz7HETJRFWoGcMh6ytPcAaTIHxyk0ZaZmwy-ZGjHQUlbP1CDBOerBLFvnSOP3UMs9aTeptef5ZTidf',
  q: 't7ejslD8CsurtpuvbajuE-U_NfPOyq1sPtkSYWVulDl-CAACZttJbTcO9SAwEFJdvFfhkyyBrdVVN5jXmH-Xt73GVrq1_ug4tUe4LJVWrf4_KWjnwoGq0mFtKhyeC30b3iSjurNsdIzYxOhILW0_aFC3Ia62-PVqtaneshza6Fl1dcWk6WhaOAJ4c0TggwMpFAcWG3CsDkUWQZQ48YjlhUMcft2NZl_ppWkweObkMgypZUN_oq_UWnz7F37gCOnx',
  dp: 'cq2gZVou0Zcrp9PGeoUqGpTGKBTBT7guZtwkTqJ2ATpb0l1ZUO0FpNzOFLStsXTnk3Q1U_n9n8HfD_XvmkOsFpHg_mBCQzA1DfACGLFbAd4IShBB-GPI5_Zd7sIyGtQvvYrygZnp9CAHf5AXbGiwierXB-1_Io2IHp5UX9oo2gRn7CDKyZjyyfGFxEDir9-uda-tIgbaWl_b-DQMB1N83CFWCkEuvq290YkMCyRc7CG6y34nL69F5wqM17TPFICX',
  dq: 'ln2DRio4i89SlX7qMPXUL8_1-4f_uN5ecQz3lXi1IA4IQx1e2kp-10vmoL0BIh2WUxXZ3ejzQSYjbCtzT6QU75owwhKnymsHKNfa8gpSuqwtqQoZ7qaw-yx7c6eFfvu4vDtfMyyOhtppJsLvfOakrhqQKLMphr3h73V6yoQAfZvqL9L6x4eHf6HmcOXW0vrfx1wWq9ub1QSaupVkH9Z3zLWwvetWTKn8hlaoMiFQg_8DM8Qa5XUKiiUeuZxggGzB',
  qi: 'G0hMMS6vMaiinufjVAjDMVJvYKlDSgSq2rHKZbhbQeCnINwL_X_aLynukUUZQhYz6kkSyBPmUxv-0ivwpeaUxkE_4iVg_DqCmzKPPp2-XJz2_8UC3iMDVpX9C8vaWUTuJ7M4EK8nZZMwv_AzHIVDp-1mV_3cHPF2S2yRbpt-e8WF7MrhbKlryj-h-jTrwRaPLjSZ9EkQaZCvRd4T5nTBNyBm-XODl_thmwoeM7pZ6gpgJBv5jvxx3L_ZQpwJW4xE'
}
let cryptoKey: CryptoKeyPair
let publicSpki: Uint8Array
let publicHash: string
let privateJwk: JsonWebKey

function deterministicSuiteCrypto(seed: number): Crypto {
  let state = seed >>> 0
  return {
    subtle: crypto.subtle,
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      if (!array) return array
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
      for (let index = 0; index < bytes.byteLength; index += 1) {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        bytes[index] = state & 0xff
      }
      return array
    }
  } as Crypto
}

beforeAll(async () => {
  const algorithm = { name: 'RSA-PSS', hash: 'SHA-384' }
  cryptoKey = {
    privateKey: await crypto.subtle.importKey('jwk', TEST_PRIVATE_JWK, algorithm, true, ['sign']),
    publicKey: await crypto.subtle.importKey('jwk', {
      key_ops: ['verify'],
      ext: true,
      alg: TEST_PRIVATE_JWK.alg,
      kty: TEST_PRIVATE_JWK.kty,
      n: TEST_PRIVATE_JWK.n,
      e: TEST_PRIVATE_JWK.e
    }, algorithm, true, ['verify'])
  }
  publicSpki = new Uint8Array(await crypto.subtle.exportKey('spki', cryptoKey.publicKey))
  publicHash = hex(sha256(publicSpki))
  privateJwk = TEST_PRIVATE_JWK
}, 30_000)

describe('RFC 9474 blind anonymous credential suite', () => {
  it('blind-signs, unblinds, and verifies without revealing credential material', async () => {
    const suite = createBlindRsaCredentialSuite({ crypto: deterministicSuiteCrypto(1) })
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
    const suite = createBlindRsaCredentialSuite({ crypto: deterministicSuiteCrypto(2) })
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
    const suite = createBlindRsaCredentialSuite({ crypto: deterministicSuiteCrypto(3) })
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

  it('maps cancellation to the existing fail-closed null result', async () => {
    const suite = createBlindRsaCredentialSuite({ crypto: deterministicSuiteCrypto(4) })
    const controller = new AbortController()
    controller.abort()
    const metadata = issuerMetadata()
    const response = issuerResponse(new Uint8Array(MODULUS_BYTES))

    expect(await suite.createCredentialRequest({
      credentialSecret: new Uint8Array(32),
      clientNonce: new Uint8Array(32),
      metadata,
      signal: controller.signal
    })).toBeNull()
    expect(await suite.acceptIssuerResponse({
      credentialSecret: new Uint8Array(32),
      clientNonce: new Uint8Array(32),
      credentialOpening: new Uint8Array(),
      issuerPublicKeyId: response.issuerPublicKeyId,
      issuerSignature: response.blindSignature,
      metadata,
      response,
      signal: controller.signal
    })).toBeNull()
  })

  it('lets the provider own suite selection and maps suite errors to null', async () => {
    const createCredentialRequest = vi.fn(async () => {
      throw new Error('opaque suite failure')
    })
    const selectedSuite: CommentPrivacyCredentialSuite = {
      createCredentialRequest,
      acceptIssuerResponse: vi.fn()
    }
    const issueCredential = vi.fn()
    const provider = createCommentPrivacyCredentialProvider({
      vault: {
        async get() { return null },
        async put() {},
        async pruneExpired() { return 0 },
        async clear() {}
      },
      loadMetadata: async () => issuerMetadata(),
      issueCredential,
      credentialSuite: selectedSuite,
      crypto,
      unavailableCacheTtlMs: 0
    })

    expect(await provider.prepareCredential({ signal: new AbortController().signal })).toBeNull()
    expect(createCredentialRequest).toHaveBeenCalledOnce()
    expect(issueCredential).not.toHaveBeenCalled()
  })

  it('accepts string distribution paths and rejects JSON values that merely stringify to them', async () => {
    const metadata = issuerMetadata()
    const distribution = metadata.revocationDistribution!
    const root = {
      ...metadata,
      rootGraceExpiresAtUnixMs: metadata.rootExpiresAtUnixMs,
      zkAnonymousEnabled: true,
      verifierConfigured: true,
      verifyingKeyHash: '03'.repeat(32),
      circuitMetadata: new Uint8Array()
    }
    const rootLoader = vi.spyOn(commentApi, 'getAnonymousCredentialRootSnapshot')
    const circuitLoader = vi.spyOn(commentApi, 'getAnonymousCredentialCircuitSnapshot').mockResolvedValue(root)
    const issuerLoader = vi.spyOn(commentApi, 'getBlindCredentialIssuerMetadata').mockResolvedValue({
      ...metadata, expiresAtUnixMs: metadata.rootExpiresAtUnixMs
    })
    try {
      for (const value of [distribution, {
        ...distribution, contentAddress: [distribution.contentAddress]
      }, {
        ...distribution, snapshotPath: [distribution.snapshotPath]
      }, {
        ...distribution, contentAddress: { value: distribution.contentAddress }
      }, {
        ...distribution, snapshotPath: null
      }]) {
        rootLoader.mockResolvedValue({
          ...root,
          circuitMetadata: new TextEncoder().encode(JSON.stringify({ revocationDistribution: value }))
        })
        const createCredentialRequest = vi.fn(async () => null)
        const issueCredential = vi.fn()
        const provider = createCommentPrivacyCredentialProvider({
          vault: null,
          credentialSuite: { createCredentialRequest, acceptIssuerResponse: vi.fn() },
          issueCredential,
          crypto,
          unavailableCacheTtlMs: 0
        })
        expect(await provider.prepareCredential({ signal: new AbortController().signal })).toBeNull()
        expect(createCredentialRequest).toHaveBeenCalledTimes(value === distribution ? 1 : 0)
        expect(issueCredential).not.toHaveBeenCalled()
      }
    } finally {
      rootLoader.mockRestore()
      circuitLoader.mockRestore()
      issuerLoader.mockRestore()
    }
  })

  it('rejects expired and non-finite issuer expiry before accepting or caching material', async () => {
    for (const expiresAtUnixMs of [Date.now() - 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const acceptIssuerResponse = vi.fn()
      const put = vi.fn()
      const temporaryRequest = new Uint8Array([1, 2])
      const temporaryOpening = new Uint8Array([3, 4])
      const provider = createCommentPrivacyCredentialProvider({
        vault: {
          async get() { return null },
          put,
          async pruneExpired() { return 0 },
          async clear() {}
        },
        loadMetadata: async () => issuerMetadata(),
        issueCredential: async () => ({ ...issuerResponse(new Uint8Array(MODULUS_BYTES)), expiresAtUnixMs }),
        credentialSuite: {
          async createCredentialRequest() {
            return { credentialRequest: temporaryRequest, credentialOpening: temporaryOpening }
          },
          acceptIssuerResponse
        },
        crypto,
        unavailableCacheTtlMs: 0
      })
      expect(await provider.prepareCredential({ signal: new AbortController().signal })).toBeNull()
      expect(acceptIssuerResponse).not.toHaveBeenCalled()
      expect(put).not.toHaveBeenCalled()
      expect([...temporaryRequest, ...temporaryOpening]).toEqual([0, 0, 0, 0])
    }
  })

  it('imports an owned SPKI view and clears it after WebCrypto settles', async () => {
    const metadata = issuerMetadata()
    const shared = new Uint8Array(new SharedArrayBuffer(publicSpki.byteLength + 8), 4, publicSpki.byteLength)
    shared.set(publicSpki)
    metadata.subjectPublicKeyInfo = shared
    const importKey = vi.spyOn(crypto.subtle, 'importKey')
    try {
      const suite = createBlindRsaCredentialSuite({ crypto })
      expect(await suite.createCredentialRequest({
        credentialSecret: new Uint8Array(32),
        clientNonce: new Uint8Array(32),
        metadata,
        signal: new AbortController().signal
      })).not.toBeNull()
      const imported = importKey.mock.calls.find(call => call[0] === 'spki')?.[1]
      expect(imported).toBeInstanceOf(Uint8Array)
      if (!(imported instanceof Uint8Array)) throw new Error('missing owned SPKI')
      expect(imported.buffer).toBeInstanceOf(ArrayBuffer)
      expect(imported.byteLength).toBe(publicSpki.byteLength)
      expect(imported.every(byte => byte === 0)).toBe(true)
      expect(shared).toEqual(publicSpki)
    } finally {
      importKey.mockRestore()
    }
  })

  it('rejects SPKI beyond the shared RFC 9474 bound before key import', async () => {
    const metadata = issuerMetadata()
    metadata.subjectPublicKeyInfo = new Uint8Array(513).fill(1)
    metadata.issuerPublicKeyHash = hex(sha256(metadata.subjectPublicKeyInfo))
    const importKey = vi.spyOn(crypto.subtle, 'importKey')
    try {
      const suite = createBlindRsaCredentialSuite({ crypto })
      expect(await suite.createCredentialRequest({
        credentialSecret: new Uint8Array(32),
        clientNonce: new Uint8Array(32),
        metadata,
        signal: new AbortController().signal
      })).toBeNull()
      expect(importKey).not.toHaveBeenCalled()
    } finally {
      importKey.mockRestore()
    }
  })

  it('does not enter provider lifecycle when already cancelled', async () => {
    const loadMetadata = vi.fn()
    const controller = new AbortController()
    controller.abort()
    const provider = createCommentPrivacyCredentialProvider({ loadMetadata })

    expect(await provider.prepareCredential({ signal: controller.signal })).toBeNull()
    expect(loadMetadata).not.toHaveBeenCalled()
  })
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

function issuerResponse(blindSignature: Uint8Array): CommentPrivacyCredentialIssueResponse {
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
