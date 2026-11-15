import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { verifyPublicationCheckpoint } from '../../tools/verify-publication-checkpoint.mjs'

test('verifies independently signed release checkpoints and exact odd-leaf paths', () => {
  const origin = 'https://proof.example.test'
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = keyPair.publicKey.export({ type: 'spki', format: 'der' })
  const fingerprint = createHash('sha256').update(spki).digest('hex')
  const signed = (file: string, project = (input: string) => input) => {
    const transcript = project(readFileSync(new URL('./fixtures/' + file + '.txt', import.meta.url), 'utf8'))
      .replace(/^keySha256:h:[a-f0-9]{64}$/m, `keySha256:h:${fingerprint}`)
    return sign('sha256', Buffer.from(transcript), { key: keyPair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  }
  const head = {
    origin, headVersion: 2, kind: 'native-publication-log-head', algorithm: 'ECDSA_P256_SHA256',
    sequence: '9007199254741003', entrySha256: '33'.repeat(32), keyId: 'rotate-1', keyVersion: 7,
    keySha256: fingerprint, attestedAtUtc: '2026-11-15T08:10:00.000001Z',
    signature: signed('article-transparency-head-v2', input => input.replace(/^sequence:i:.+$/m, 'sequence:i:9007199254741003')
      .replace(/^entrySha256:h:.+$/m, `entrySha256:h:${'33'.repeat(32)}`)),
  }
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
  const key = {
    keyId: head.keyId, keyVersion: head.keyVersion, keySha256: fingerprint, publicKey: spki.toString('base64url'),
    notBeforeUtc: '2026-11-15T08:00:00.120001Z', notAfterUtc: '2026-11-15T08:10:00.000020Z',
    revokedAtUtc: '2026-11-15T08:10:00.000003Z', compromisedAtUtc: null,
  }
  const manifest = { manifestVersion: 2, kind: 'native-publication-proof-keys', algorithm: head.algorithm, keys: [key] }
  const bundle = { checkpoint, inclusion }
  const expected = { sequence: inclusion.sequence, entrySha256: '33'.repeat(32) }
  const scope = checkpoint.scopeKey
  assert.deepEqual(verifyPublicationCheckpoint(bundle, manifest, head, origin, scope, expected), {
    scopeKey: scope, fromSequence: checkpoint.fromSequence, toSequence: checkpoint.toSequence,
    rootSha256: checkpoint.rootSha256, headSequence: head.sequence, inclusionSequence: inclusion.sequence,
  })
  assert.equal(verifyPublicationCheckpoint({ ...bundle, inclusion: null }, manifest, head, origin, scope).inclusionSequence, null)
  assert.throws(() => verifyPublicationCheckpoint(bundle, manifest, head, origin, 'other'), /Invalid native release checkpoint/)
  assert.throws(() => verifyPublicationCheckpoint({ ...bundle, checkpoint: { ...checkpoint, scopeKey: 'other' } }, manifest, head, origin, 'other'), /signature/)
  assert.throws(() => verifyPublicationCheckpoint({ ...bundle, inclusion: { ...inclusion, title: 'private' } }, manifest, head, origin, scope), /inclusion/)
  assert.throws(() => verifyPublicationCheckpoint({ ...bundle, inclusion: { ...inclusion, siblings: inclusion.siblings.toReversed() } },
    manifest, head, origin, scope, expected), /odd sibling/)
  assert.throws(() => verifyPublicationCheckpoint({ ...bundle, inclusion: { ...inclusion, siblings: inclusion.siblings.slice(0, 1) } },
    manifest, head, origin, scope), /Incomplete checkpoint/)
  assert.throws(() => verifyPublicationCheckpoint(bundle, manifest, head, origin, scope,
    { ...expected, entrySha256: '22'.repeat(32) }), /expected ledger entry/)
  const substitutedHash = '44'.repeat(32)
  const substitutedHead = { ...head, entrySha256: substitutedHash,
    signature: signed('article-transparency-head-v2', input => input.replace(/^sequence:i:.+$/m, 'sequence:i:9007199254741003')
      .replace(/^entrySha256:h:.+$/m, `entrySha256:h:${substitutedHash}`)) }
  const substitutedCheckpoint = { ...checkpoint, headEntrySha256: substitutedHash,
    signature: signed('publication-release-checkpoint-v2', input => input.replace(/^headEntrySha256:h:.+$/m, `headEntrySha256:h:${substitutedHash}`)) }
  assert.throws(() => verifyPublicationCheckpoint({ ...bundle, checkpoint: substitutedCheckpoint },
    manifest, substitutedHead, origin, scope), /expected ledger digest/)
  assert.throws(() => verifyPublicationCheckpoint(bundle, { ...manifest, keys: [{ ...key, revokedAtUtc: checkpoint.attestedAtUtc }] },
    head, origin, scope), /ineligible/)
  assert.throws(() => verifyPublicationCheckpoint(bundle, { ...manifest, keys: [{ ...key, compromisedAtUtc: key.revokedAtUtc }] },
    head, origin, scope), /ineligible/)
})
