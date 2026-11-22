import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publicationSigner } from './publication-signing-fixture.ts'
import { verifyPublicationHead } from '../../tools/verify-publication-head.mjs'

test('independently verifies the head signature and rejects altered or overexposed head data', () => {
  const { origin, signed, head: makeHead, keyManifest } = publicationSigner()
  const signature = signed('article-transparency-head-v2')
  const head = makeHead('9007199254741001', '7fa4d9ff96c8a5324a9f912e1012a2ef686a92ac0308cee6b089191b54c6ddb3', signature)
  const manifest = keyManifest(head, '2026-11-15T08:00:00.120001Z', '2026-11-15T08:10:00.000002Z', '2026-11-15T08:10:00.000002Z')
  const [key] = manifest.keys
  const verify = (value: typeof head & { articleId?: number }) => verifyPublicationHead(value, manifest, origin)
  assert.deepEqual(verify(head), {
    sequence: head.sequence, entrySha256: head.entrySha256,
  })
  assert.throws(() => verify({ ...head, articleId: 42 }), /Invalid native publication log head/)
  assert.throws(() => verify({ ...head, sequence: '9007199254741000' }), /signature/)
  assert.throws(() => verify({ ...head, entrySha256: '0'.repeat(64) }), /signature/)
  assert.throws(() => verify({ ...head, signature: Buffer.alloc(64).toString('base64url') }), /signature/)
  for (const change of [{ revokedAtUtc: head.attestedAtUtc }, { compromisedAtUtc: head.attestedAtUtc }]) {
    assert.throws(() => verifyPublicationHead(head, { ...manifest, keys: [{ ...key, ...change }] }, origin), /ineligible/)
  }
  assert.throws(() => verifyPublicationHead(head, manifest, 'https://other.example.test'), /Invalid native publication log head/)
})
