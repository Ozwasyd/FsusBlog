import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { verifyPublicationHead } from '../../tools/verify-publication-head.mjs'

test('independently verifies the head signature and rejects altered or overexposed head data', () => {
  const origin = 'https://proof.example.test'
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const fingerprint = createHash('sha256').update(spki).digest('hex')
  const transcript = readFileSync(new URL('./fixtures/article-transparency-head-v2.txt', import.meta.url), 'utf8')
    .replace(/^keySha256:h:[a-f0-9]{64}$/m, `keySha256:h:${fingerprint}`)
  const signature = sign('sha256', Buffer.from(transcript), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  const head = {
    origin, headVersion: 2, kind: 'native-publication-log-head', algorithm: 'ECDSA_P256_SHA256',
    sequence: '9007199254741001', entrySha256: '7fa4d9ff96c8a5324a9f912e1012a2ef686a92ac0308cee6b089191b54c6ddb3',
    keyId: 'rotate-1', keyVersion: 7, keySha256: fingerprint, attestedAtUtc: '2026-11-15T08:10:00.000001Z', signature,
  }
  const key = {
    keyId: head.keyId, keyVersion: head.keyVersion, keySha256: fingerprint, publicKey: spki.toString('base64url'),
    notBeforeUtc: '2026-11-15T08:00:00.120001Z', notAfterUtc: '2026-11-15T08:10:00.000002Z',
    revokedAtUtc: '2026-11-15T08:10:00.000002Z', compromisedAtUtc: null,
  }
  const manifest = { manifestVersion: 2, kind: 'native-publication-proof-keys', algorithm: head.algorithm, keys: [key] }
  assert.deepEqual(verifyPublicationHead(head, manifest, origin), {
    sequence: head.sequence, entrySha256: head.entrySha256,
  })
  assert.throws(() => verifyPublicationHead({ ...head, articleId: 42 }, manifest, origin), /Invalid native publication log head/)
  assert.throws(() => verifyPublicationHead({ ...head, sequence: '9007199254741000' }, manifest, origin), /signature/)
  assert.throws(() => verifyPublicationHead({ ...head, entrySha256: '0'.repeat(64) }, manifest, origin), /signature/)
  assert.throws(() => verifyPublicationHead({ ...head, signature: Buffer.alloc(64).toString('base64url') }, manifest, origin), /signature/)
  assert.throws(() => verifyPublicationHead(head, { ...manifest, keys: [{ ...key, revokedAtUtc: head.attestedAtUtc }] }, origin), /ineligible/)
  assert.throws(() => verifyPublicationHead(head, { ...manifest, keys: [{ ...key, compromisedAtUtc: head.attestedAtUtc }] }, origin), /ineligible/)
  assert.throws(() => verifyPublicationHead(head, manifest, 'https://other.example.test'), /Invalid native publication log head/)
})
