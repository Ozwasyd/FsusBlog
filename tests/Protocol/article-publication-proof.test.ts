import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { articlePublicationDigests, publicationProofPath, verifyCurrentPublication } from '../../src/Contracts/article-publication-proof.ts'
import type { Article } from '../../src/Contracts/public-articles.ts'
import { verifyPublicationProof } from '../../tools/verify-publication-proof.mjs'

const origin = 'https://proof.example.test'
const publishedAtUtc = '2026-11-15T08:00:00.120001Z'
const issuedAtUtc = '2026-11-15T08:10:00.000001Z'
const article: Article = {
  id: 42, revision: 9007199254740993n, revisionNo: 7, publication: 9007199254741999n, publicationNo: 3,
  createdAt: 1, updatedAt: null, publishedAt: Date.parse(publishedAtUtc), scheduledPublishAt: null,
  title: 'Réseau 🐈', body: 'Cafe\u0301\r\n独立😀\n', summary: 'derived', views: 3, coverImageUrl: '',
  category: { id: 0, name: '' },
  tags: [{ id: 42, name: 'Tag 42' }, { id: 11, name: 'Tag 11' }, { id: 42, name: 'Tag 42' }],
  rights: {
    snapshotId: 9007199254742999n, enabled: false, proofBindingEnabled: true, allowCodeCopy: true,
    showPublicBadge: false, licenseType: 'CC-BY-4.0', copyrightHolder: '', copyrightYear: null,
    rightsStatement: 'État\n新', attributionTemplate: '{title}', copyPolicy: 'append-attribution', maxExcerptChars: 0,
  },
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}.txt`, import.meta.url), 'utf8')
const contentSha256 = digest(fixture('article-content-canonical-v2'))
const policySha256 = digest(fixture('article-policy-canonical-v2').replace('enabled:b:0', 'enabled:b:1'))
const coverDigest = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
const coveredArticle = { ...article, coverImageUrl: `/public-media/${article.id}/${article.publication}/${coverDigest}` }

test('rebuilds exact content and policy from the public article', async () => {
  assert.deepEqual(await articlePublicationDigests(article), {
    content: contentSha256, policy: digest(fixture('article-policy-canonical-v2')),
  })
  assert.notEqual((await articlePublicationDigests({ ...article, body: article.body.normalize('NFC') })).content, contentSha256)
  assert.notEqual((await articlePublicationDigests({ ...article, body: article.body.replace('\r\n', '\n') })).content, contentSha256)
})

test('rebuilds canonical v3 only from the exact managed cover for the publication', async () => {
  assert.deepEqual(await articlePublicationDigests(coveredArticle), {
    content: digest(fixture('article-content-canonical-v3')),
    policy: '71bf0b9f49605076ce0c60099358f77d241c63f2fcbb265ffd5d4a7d8a4c0dff',
  })
  await assert.rejects(articlePublicationDigests(coveredArticle, 2), { reason: 'invalid' })
  await assert.rejects(articlePublicationDigests(article, 3), { reason: 'invalid' })
  await assert.rejects(articlePublicationDigests({ ...coveredArticle, publication: article.publication + 1n }), { reason: 'invalid' })
  await assert.rejects(articlePublicationDigests({ ...coveredArticle, coverImageUrl: coveredArticle.coverImageUrl + '?v=1' }), { reason: 'invalid' })
})

test('verifies the frozen signing transcript with a rotated key and checks current eligibility again', async t => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const keySha256 = digest(spki)
  const originalTranscript = fixture('article-publication-proof-v2')
  const transcript = originalTranscript
    .replace(/^keySha256:h:.+$/m, `keySha256:h:${keySha256}`)
    .replace(/^policySha256:h:.+$/m, `policySha256:h:${policySha256}`)
  const signature = sign('SHA256', Buffer.from(transcript), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  const proof = {
    proofVersion: 2, canonicalVersion: 2, algorithm: 'ECDSA_P256_SHA256', origin,
    articleId: 42, revision: '9007199254740993', publicationId: '9007199254741999', publicationNo: 3,
    publishedAtUtc, rightsSnapshotId: '9007199254742999', publicationOutboxId: '9007199254743999',
    contentSha256, policySha256, keyId: 'rotate-1', keyVersion: 7, keySha256, issuedAtUtc, signature,
  }
  const validKey = {
    keyId: 'rotate-1', keyVersion: 7, publicKey: spki.toString('base64url'), keySha256,
    notBeforeUtc: publishedAtUtc, notAfterUtc: issuedAtUtc, revokedAtUtc: '2026-11-15T08:10:00.000002Z', compromisedAtUtc: null,
  }
  const current = { ...article, rights: { ...article.rights!, enabled: true } }
  const path = publicationProofPath(current)
  let returnedProof: object = proof
  let returnedKey: object = validKey
  let duringRecheck = 200
  let headers = { 'Cache-Control': 'no-store' }
  const calls: string[] = []
  let proofRequests = 0
  t.mock.method(globalThis, 'fetch', async (requested: string, options: RequestInit) => {
    calls.push(requested)
    assert.equal(options.cache, 'no-store')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    if (requested === path) {
      const status = proofRequests++ === 0 ? 200 : duringRecheck
      return Response.json(returnedProof, { status, headers })
    }
    assert.equal(requested, '/integrity/v2/keys.json')
    return Response.json({
      manifestVersion: 2, kind: 'native-publication-proof-keys', algorithm: proof.algorithm,
      currentKeyId: 'rotate-2', keys: [returnedKey, { keyId: 'rotate-2' }],
    }, { headers })
  })
  const verify = (value = current) => {
    proofRequests = 0
    return verifyCurrentPublication(value, origin, new AbortController().signal)
  }
  await verify()
  assert.deepEqual(calls, [path, '/integrity/v2/keys.json', path])

  const manifest = { manifestVersion: 2, kind: 'native-publication-proof-keys', algorithm: proof.algorithm, keys: [validKey] }
  verifyPublicationProof(proof, manifest, origin)
  const currentCovered = { ...coveredArticle, rights: current.rights }
  const coveredContent = digest(fixture('article-content-canonical-v3'))
  const coveredPolicy = digest(fixture('article-policy-canonical-v2')
    .replace('enabled:b:0', 'enabled:b:1').replace(contentSha256, coveredContent))
  const coveredTranscript = fixture('article-publication-proof-canonical-v3')
    .replace(/^keySha256:h:.+$/m, `keySha256:h:${keySha256}`)
    .replace(/^policySha256:h:.+$/m, `policySha256:h:${coveredPolicy}`)
  const coveredProof = {
    ...proof, canonicalVersion: 3, contentSha256: coveredContent, policySha256: coveredPolicy,
    signature: sign('SHA256', Buffer.from(coveredTranscript), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
  }
  returnedProof = coveredProof
  await verify(currentCovered)
  verifyPublicationProof(coveredProof, manifest, origin)
  await assert.rejects(verify(), { reason: 'invalid' })
  await assert.rejects(verify({ ...currentCovered, coverImageUrl: currentCovered.coverImageUrl.replace(coverDigest, 'a'.repeat(64)) }),
    { reason: 'invalid' })
  assert.throws(() => verifyPublicationProof({ ...coveredProof, canonicalVersion: 2 }, manifest, origin), /signature/)
  returnedProof = proof
  await assert.rejects(verify(currentCovered), { reason: 'invalid' })

  returnedKey = { ...validKey, compromisedAtUtc: '2026-11-16T08:00:00.000000Z' }
  await assert.rejects(verify(), { reason: 'invalid' })
  returnedKey = { ...validKey, revokedAtUtc: issuedAtUtc }
  await assert.rejects(verify(), { reason: 'invalid' })
  returnedKey = { ...validKey, revokedAtUtc: null }
  await assert.rejects(verify({ ...current, body: 'other public body' }), { reason: 'invalid' })
  returnedProof = { ...proof, issuedAtUtc: '2026-11-15T08:10:00.000000Z' }
  await assert.rejects(verify(), { reason: 'invalid' })
  returnedProof = { ...proof, signature: Buffer.alloc(64).toString('base64url') }
  await assert.rejects(verify(), { reason: 'invalid' })
  returnedProof = proof
  duringRecheck = 404
  await assert.rejects(verify(), { reason: 'unavailable' })
  duringRecheck = 200
  headers = { 'Cache-Control': 'max-age=3600' }
  await assert.rejects(verify(), { reason: 'unavailable' })
})
