import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { fixtureText } from './fixture-source.ts'

// Each caller gets independent test keys, never keys or serialization from the verifier.
export function publicationSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const fingerprint = createHash('sha256').update(spki).digest('hex')
  const signed = (file: string, project = (input: string) => input) => {
    const transcript = project(fixtureText(`${file}.txt`))
      .replace(/^keySha256:h:[a-f0-9]{64}$/m, `keySha256:h:${fingerprint}`)
    return sign('sha256', Buffer.from(transcript), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  }
  const origin = 'https://proof.example.test'
  function head(sequence: string, entrySha256: string, signature: string) {
    return {
      origin, headVersion: 2, kind: 'native-publication-log-head', algorithm: 'ECDSA_P256_SHA256',
      sequence, entrySha256, keyId: 'rotate-1', keyVersion: 7, keySha256: fingerprint,
      attestedAtUtc: '2026-11-15T08:10:00.000001Z', signature,
    }
  }
  function keyManifest(witness: ReturnType<typeof head>, notBeforeUtc: string, notAfterUtc: string, revokedAtUtc: string) {
    const key = {
      keyId: witness.keyId, keyVersion: witness.keyVersion, keySha256: fingerprint, publicKey: spki.toString('base64url'),
      notBeforeUtc, notAfterUtc, revokedAtUtc, compromisedAtUtc: null,
    }
    return { manifestVersion: 2, kind: 'native-publication-proof-keys', algorithm: witness.algorithm, keys: [key] }
  }
  return { origin, spki, fingerprint, signed, head, keyManifest }
}
