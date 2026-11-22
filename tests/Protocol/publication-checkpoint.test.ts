import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publicationSigner } from './publication-signing-fixture.ts'
import { verifyPublicationCheckpoint } from '../../tools/verify-publication-checkpoint.mjs'

test('verifies independently signed release checkpoints and exact odd-leaf paths', () => {
  const { origin, fingerprint, signed, head: makeHead, keyManifest } = publicationSigner()
  function signHead(entryHash: string) {
    return signed('article-transparency-head-v2', input => input.replace(/^sequence:i:.+$/m, 'sequence:i:9007199254741003')
      .replace(/^entrySha256:h:.+$/m, `entrySha256:h:${entryHash}`))
  }
  const head = makeHead('9007199254741003', '33'.repeat(32), signHead('33'.repeat(32)))
  const checkpoint = {
    checkpointVersion: 2, kind: 'native-publication-checkpoint', checkpointKind: 'release', algorithm: head.algorithm,
    origin, scopeKey: 'release-2026.11', fromSequence: '9007199254741001', toSequence: head.sequence, entryCount: 3,
    rootSha256: '963380bd8bc6cfe8fd61281c1a4938fc94e04666fd3372b74b319d0c6f9f4840',
    headSequence: head.sequence, headEntrySha256: head.entrySha256, keyId: head.keyId, keyVersion: 7, keySha256: fingerprint,
    attestedAtUtc: '2026-11-15T08:10:00.000002Z', signature: signed('publication-release-checkpoint-v2'),
  }
  const leafSha256 = '27826deb7e05792ea526bfe761fe4272205c247afd425789bb9c9edec3c8d6f3'
  const inclusion = {
    sequence: head.sequence, leafSha256,
    siblings: [leafSha256, '5effb111c1c250c40435fc625350efe37a9d688b92ced3884380852b8d1a06a8'],
  }
  const manifest = keyManifest(head, '2026-11-15T08:00:00.120001Z', '2026-11-15T08:10:00.000020Z', '2026-11-15T08:10:00.000003Z')
  const [key] = manifest.keys
  const bundle = { checkpoint, inclusion }
  const expected = { sequence: inclusion.sequence, entrySha256: '33'.repeat(32) }
  const scope = checkpoint.scopeKey
  const verifyInclusion = (value: (typeof inclusion & { title?: string }) | null, ...entries: [entry?: typeof expected]) =>
    verifyPublicationCheckpoint({ ...bundle, inclusion: value }, manifest, head, origin, scope, ...entries)
  assert.deepEqual(verifyPublicationCheckpoint(bundle, manifest, head, origin, scope, expected), {
    scopeKey: scope, fromSequence: checkpoint.fromSequence, toSequence: checkpoint.toSequence,
    rootSha256: checkpoint.rootSha256, headSequence: head.sequence, inclusionSequence: inclusion.sequence,
  })
  assert.equal(verifyInclusion(null).inclusionSequence, null)
  assert.throws(() => verifyPublicationCheckpoint(bundle, manifest, head, origin, 'other'), /Invalid native release checkpoint/)
  assert.throws(() => verifyPublicationCheckpoint({ ...bundle, checkpoint: { ...checkpoint, scopeKey: 'other' } }, manifest, head, origin, 'other'), /signature/)
  assert.throws(() => verifyInclusion({ ...inclusion, title: 'private' }), /inclusion/)
  assert.throws(() => verifyInclusion({ ...inclusion, siblings: inclusion.siblings.toReversed() }, expected), /odd sibling/)
  assert.throws(() => verifyInclusion({ ...inclusion, siblings: inclusion.siblings.slice(0, 1) }), /Incomplete checkpoint/)
  assert.throws(() => verifyPublicationCheckpoint(bundle, manifest, head, origin, scope,
    { ...expected, entrySha256: '22'.repeat(32) }), /expected ledger entry/)
  const substitutedHash = '44'.repeat(32)
  const substitutedHead = { ...head, entrySha256: substitutedHash, signature: signHead(substitutedHash) }
  const substitutedCheckpoint = { ...checkpoint, headEntrySha256: substitutedHash,
    signature: signed('publication-release-checkpoint-v2', input => input.replace(/^headEntrySha256:h:.+$/m, `headEntrySha256:h:${substitutedHash}`)) }
  assert.throws(() => verifyPublicationCheckpoint({ ...bundle, checkpoint: substitutedCheckpoint },
    manifest, substitutedHead, origin, scope), /expected ledger digest/)
  for (const change of [{ revokedAtUtc: checkpoint.attestedAtUtc }, { compromisedAtUtc: key.revokedAtUtc }]) {
    assert.throws(() => verifyPublicationCheckpoint(bundle, { ...manifest, keys: [{ ...key, ...change }] },
      head, origin, scope), /ineligible/)
  }
})
