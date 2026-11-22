import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publicationSigner } from './publication-signing-fixture.ts'
import { verifyPublicationCheckpoint } from '../../tools/verify-publication-checkpoint.mjs'

test('verifies opaque daily checkpoint coverage and ordered inclusion against an independently retained head', () => {
  const day = '2026-11-14'
  const { origin, fingerprint, signed, head: makeHead, keyManifest } = publicationSigner()
  const head = makeHead('6', '66'.repeat(32), '')
  const signedHead = (value: typeof head) => ({ ...value, signature: signed('article-transparency-head-v2', input => input
    .replace(/^sequence:i:.+$/m, `sequence:i:${value.sequence}`).replace(/^entrySha256:h:.+$/m, `entrySha256:h:${value.entrySha256}`)
    .replace(/^attestedAt:t:.+$/m, `attestedAt:t:${value.attestedAtUtc}`)) })
  const pin = signedHead(head)
  const keys = keyManifest(head, '2026-11-14T00:00:00.000000Z', '2026-11-15T08:10:00.000020Z', '2026-11-15T08:10:00.000003Z')
  const [key] = keys.keys
  const checkpoint = {
    checkpointVersion: 2, kind: 'native-publication-checkpoint', checkpointKind: 'daily', algorithm: head.algorithm,
    origin, scopeKey: day, fromSequence: '1', toSequence: '5', entryCount: 3,
    rootSha256: '195aea196ec18745e11b9385b0f7499a0d3e96db0aa91379800ca0222539fe04',
    headSequence: head.sequence, headEntrySha256: head.entrySha256, keyId: head.keyId, keyVersion: 7, keySha256: fingerprint,
    attestedAtUtc: '2026-11-15T08:10:00.000002Z', signature: signed('publication-daily-checkpoint-discontiguous-v2'),
  }
  const inclusion = { sequence: '5', position: 2, entrySha256: '55'.repeat(32), siblings: [
    '44578fa957de83c75cda97c2be6ad8f426d33401728fc547dd6d2bb409232003',
    '7c441a12a87057e7d2322f6fc0efef9e5717d10bc61478296a89ff68f7680a57',
  ] }
  const bundle = { checkpoint, inclusion }
  const expected = { sequence: '5', entrySha256: '55'.repeat(32) }
  const verify = (value = bundle, witness = pin, date = day, entry = expected, registry = keys) =>
    verifyPublicationCheckpoint(value, registry, witness, origin, date, entry, 'daily')
  assert.deepEqual(verify(), { scopeKey: day, fromSequence: '1', toSequence: '5', rootSha256: checkpoint.rootSha256,
    headSequence: '6', inclusionSequence: '5' })
  assert.equal(verify(bundle, signedHead({ ...head, attestedAtUtc: '2026-11-15T00:00:00.000000Z' })).inclusionSequence, '5')
  assert.throws(() => verify(bundle, signedHead({ ...head, attestedAtUtc: '2026-11-14T23:59:59.999999Z' })), /scope/)
  assert.throws(() => verify({ ...bundle, checkpoint: { ...checkpoint, scopeKey: '2026-11-31' } }, pin, '2026-11-31'), /scope/)
  assert.throws(() => verify({ ...bundle, checkpoint: { ...checkpoint, headSequence: '16385' } },
    signedHead({ ...head, sequence: '16385' })), /signed range/)
  assert.throws(() => verify({ ...bundle, checkpoint: { ...checkpoint, entryCount: 4097 } }), /checkpoint/)
  for (const [changed, error] of [
    [{ sequence: '4' }, /position/],
    [{ position: 0 }, /position/],
    [{ entrySha256: '33'.repeat(32) }, /expected ledger entry/],
    [{ siblings: inclusion.siblings.toReversed() }, /odd sibling/],
  ] as const) {
    assert.throws(() => verify({ ...bundle, inclusion: { ...inclusion, ...changed } }), error)
  }
  assert.throws(() => verifyPublicationCheckpoint(bundle, keys, pin, origin, day), /release checkpoint/)
  assert.throws(() => verify(bundle, pin, day, expected, { ...keys, keys: [{ ...key, compromisedAtUtc: key.revokedAtUtc }] }), /ineligible/)

  const empty = { checkpoint: { ...checkpoint, fromSequence: '0', toSequence: '0', entryCount: 0,
    rootSha256: '3d0959f57c8020c30b6386278aed45cf3a56a37bd08b54f4f89f1bba59827cda',
    signature: signed('publication-daily-checkpoint-empty-v2') }, inclusion: null }
  assert.equal(verifyPublicationCheckpoint(empty, keys, pin, origin, day, undefined, 'daily').inclusionSequence, null)
  assert.throws(() => verifyPublicationCheckpoint(empty, keys, pin, origin, day, expected, 'daily'), /inclusion/)
  assert.throws(() => verifyPublicationCheckpoint({ ...empty, checkpoint: { ...empty.checkpoint, fromSequence: '1' } },
    keys, pin, origin, day, undefined, 'daily'), /range/)
})
