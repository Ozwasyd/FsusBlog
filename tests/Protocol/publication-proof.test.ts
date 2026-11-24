import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { articlePublicationDigests, publicationProofPath, verifyCurrentPublication } from '../../src/Contracts/article-publication-proof.ts';
import type { Article } from '../../src/Contracts/public-articles.ts';
import { verifyPublicationCheckpoint } from '../../tools/verify-publication-checkpoint.mjs';
import { verifyPublicationHead } from '../../tools/verify-publication-head.mjs';
import { verifyPublicationProof } from '../../tools/verify-publication-proof.mjs';
import { fixtureText, sha256Hex } from './fixture-source.ts';

function publicationSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const fingerprint = sha256Hex(spki);
  const signed = (file: string, project = (input: string) => input) => {
    const transcript = project(fixtureText(`${file}.txt`)).replace(/^keySha256:h:[a-f0-9]{64}$/m, `keySha256:h:${fingerprint}`);
    return sign('sha256', Buffer.from(transcript), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  };
  const origin = 'https://proof.example.test';
  const common = { origin, algorithm: 'ECDSA_P256_SHA256', keyId: 'rotate-1', keyVersion: 7, keySha256: fingerprint };
  function head(sequence: string, entrySha256: string, signature?: string, attestedAtUtc = '2026-11-15T08:10:00.000001Z') {
    signature ??= signed('article-transparency-head-v2', input => input
      .replace(/^sequence:i:.+$/m, `sequence:i:${sequence}`)
      .replace(/^entrySha256:h:.+$/m, `entrySha256:h:${entrySha256}`)
      .replace(/^attestedAt:t:.+$/m, `attestedAt:t:${attestedAtUtc}`));
    return { ...common, headVersion: 2, kind: 'native-publication-log-head', sequence, entrySha256, attestedAtUtc, signature };
  }
  function checkpoint(
    checkpointKind: 'release' | 'daily', scopeKey: string, fromSequence: string, toSequence: string,
    entryCount: number, rootSha256: string, witness: ReturnType<typeof head>, fixtureFile: string,
  ) {
    return {
      ...common, checkpointVersion: 2, kind: 'native-publication-checkpoint', checkpointKind, scopeKey, fromSequence, toSequence,
      entryCount, rootSha256, headSequence: witness.sequence, headEntrySha256: witness.entrySha256,
      attestedAtUtc: '2026-11-15T08:10:00.000002Z', signature: signed(fixtureFile),
    };
  }
  function keyManifest(notBeforeUtc: string, notAfterUtc: string, revokedAtUtc: string | null) {
    return {
      manifestVersion: 2, kind: 'native-publication-proof-keys', algorithm: common.algorithm,
      keys: [{ keyId: common.keyId, keyVersion: common.keyVersion, keySha256: fingerprint, publicKey: spki.toString('base64url'), notBeforeUtc, notAfterUtc, revokedAtUtc, compromisedAtUtc: null }],
    };
  }
  const withKey = (manifest: ReturnType<typeof keyManifest>, change: Record<string, string | null>) =>
    ({ ...manifest, keys: [{ ...manifest.keys[0], ...change }] });
  return { origin, fingerprint, signed, head, checkpoint, keyManifest, withKey };
}

const zeroSignature = Buffer.alloc(64).toString('base64url');
const publishedAtUtc = '2026-11-15T08:00:00.120001Z';
const issuedAtUtc = '2026-11-15T08:10:00.000001Z';
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
};
const contentSha256 = sha256Hex(fixtureText('article-content-canonical-v2.txt'));
const policyBase = fixtureText('article-policy-canonical-v2.txt');
const policySha256 = sha256Hex(policyBase.replace('enabled:b:0', 'enabled:b:1'));
const coverDigest = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const coveredArticle = { ...article, coverImageUrl: `/public-media/${article.id}/${article.publication}/${coverDigest}` };
const coveredContent = sha256Hex(fixtureText('article-content-canonical-v3.txt'));

test('rebuilds exact content and policy from the public article', async () => {
  assert.deepEqual(await articlePublicationDigests(article), { content: contentSha256, policy: sha256Hex(policyBase) });
  assert.notEqual((await articlePublicationDigests({ ...article, body: article.body.normalize('NFC') })).content, contentSha256);
  assert.notEqual((await articlePublicationDigests({ ...article, body: article.body.replace('\r\n', '\n') })).content, contentSha256);
});

test('rebuilds canonical v3 only from the exact managed cover for the publication', async () => {
  assert.deepEqual(await articlePublicationDigests(coveredArticle), {
    content: coveredContent, policy: '71bf0b9f49605076ce0c60099358f77d241c63f2fcbb265ffd5d4a7d8a4c0dff',
  });
  for (const [candidate, version] of [
    [coveredArticle, 2], [article, 3],
    [{ ...coveredArticle, publication: article.publication + 1n }, undefined],
    [{ ...coveredArticle, coverImageUrl: coveredArticle.coverImageUrl + '?v=1' }, undefined],
  ] as const) await assert.rejects(articlePublicationDigests(candidate, version), { reason: 'invalid' });
});

test('verifies the frozen signing transcript with a rotated key and checks current eligibility again', async t => {
  const { origin, fingerprint: keySha256, signed, keyManifest } = publicationSigner();
  const signProof = (file: string, policy: string) => signed(file, input => input.replace(/^policySha256:h:.+$/m, `policySha256:h:${policy}`));
  const proof = {
    proofVersion: 2, canonicalVersion: 2, algorithm: 'ECDSA_P256_SHA256', origin,
    articleId: 42, revision: '9007199254740993', publicationId: '9007199254741999', publicationNo: 3,
    publishedAtUtc, rightsSnapshotId: '9007199254742999', publicationOutboxId: '9007199254743999',
    contentSha256, policySha256, keyId: 'rotate-1', keyVersion: 7, keySha256, issuedAtUtc,
    signature: signProof('article-publication-proof-v2', policySha256),
  };
  const manifest = keyManifest(publishedAtUtc, issuedAtUtc, '2026-11-15T08:10:00.000002Z');
  const [validKey] = manifest.keys;
  const current = { ...article, rights: { ...article.rights!, enabled: true } };
  const path = publicationProofPath(current);
  let returnedProof: object = proof;
  let returnedKey: object = validKey;
  let duringRecheck = 200;
  let headers = { 'Cache-Control': 'no-store' };
  const calls: string[] = [];
  let proofRequests = 0;
  t.mock.method(globalThis, 'fetch', async (requested: string, options: RequestInit) => {
    calls.push(requested);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    if (requested === path) return Response.json(returnedProof, { status: proofRequests++ === 0 ? 200 : duringRecheck, headers });
    assert.equal(requested, '/integrity/v2/keys.json');
    return Response.json({ ...manifest, currentKeyId: 'rotate-2', keys: [returnedKey, { keyId: 'rotate-2' }] }, { headers });
  });
  const signal = new AbortController().signal;
  const verify = (value = current) => { proofRequests = 0; return verifyCurrentPublication(value, origin, signal); };
  const rejectInvalid = (value = current) => assert.rejects(verify(value), { reason: 'invalid' });
  await verify();
  assert.deepEqual(calls, [path, '/integrity/v2/keys.json', path]);
  verifyPublicationProof(proof, manifest, origin);

  const currentCovered = { ...coveredArticle, rights: current.rights };
  const coveredPolicy = sha256Hex(policyBase.replace('enabled:b:0', 'enabled:b:1').replace(contentSha256, coveredContent));
  const coveredProof = {
    ...proof, canonicalVersion: 3, contentSha256: coveredContent, policySha256: coveredPolicy,
    signature: signProof('article-publication-proof-canonical-v3', coveredPolicy),
  };
  returnedProof = coveredProof;
  await verify(currentCovered);
  verifyPublicationProof(coveredProof, manifest, origin);
  await rejectInvalid();
  await rejectInvalid({ ...currentCovered, coverImageUrl: currentCovered.coverImageUrl.replace(coverDigest, 'a'.repeat(64)) });
  assert.throws(() => verifyPublicationProof({ ...coveredProof, canonicalVersion: 2 }, manifest, origin), /signature/);

  returnedProof = proof;
  await rejectInvalid(currentCovered);
  for (const keyChange of [{ compromisedAtUtc: '2026-11-16T08:00:00.000000Z' }, { revokedAtUtc: issuedAtUtc }]) {
    returnedKey = { ...validKey, ...keyChange };
    await rejectInvalid();
  }
  returnedKey = { ...validKey, revokedAtUtc: null };
  await rejectInvalid({ ...current, body: 'other public body' });
  for (const proofChange of [{ issuedAtUtc: '2026-11-15T08:10:00.000000Z' }, { signature: zeroSignature }]) {
    returnedProof = { ...proof, ...proofChange };
    await rejectInvalid();
  }
  returnedProof = proof;
  duringRecheck = 404;
  await assert.rejects(verify(), { reason: 'unavailable' });
  duringRecheck = 200;
  headers = { 'Cache-Control': 'max-age=3600' };
  await assert.rejects(verify(), { reason: 'unavailable' });
});

test('independently verifies the head signature and rejects altered or overexposed head data', () => {
  const { origin, signed, head: makeHead, keyManifest, withKey } = publicationSigner();
  const head = makeHead('9007199254741001', '7fa4d9ff96c8a5324a9f912e1012a2ef686a92ac0308cee6b089191b54c6ddb3', signed('article-transparency-head-v2'));
  const manifest = keyManifest(publishedAtUtc, '2026-11-15T08:10:00.000002Z', '2026-11-15T08:10:00.000002Z');
  const verify = (value: typeof head & { articleId?: number }, keys = manifest, site = origin) => verifyPublicationHead(value, keys, site);
  assert.deepEqual(verify(head), { sequence: head.sequence, entrySha256: head.entrySha256 });
  assert.throws(() => verify({ ...head, articleId: 42 }), /Invalid native publication log head/);
  for (const bad of [{ sequence: '9007199254741000' }, { entrySha256: '0'.repeat(64) }, { signature: zeroSignature }])
    assert.throws(() => verify({ ...head, ...bad }), /signature/);
  for (const change of [{ revokedAtUtc: head.attestedAtUtc }, { compromisedAtUtc: head.attestedAtUtc }])
    assert.throws(() => verify(head, withKey(manifest, change)), /ineligible/);
  assert.throws(() => verify(head, manifest, 'https://other.example.test'), /Invalid native publication log head/);
});

test('verifies independently signed release checkpoints and exact odd-leaf paths', () => {
  const { origin, signed, head: makeHead, checkpoint: makeCheckpoint, keyManifest, withKey } = publicationSigner();
  const head = makeHead('9007199254741003', '33'.repeat(32));
  const checkpoint = makeCheckpoint('release', 'release-2026.11', '9007199254741001', head.sequence, 3,
    '963380bd8bc6cfe8fd61281c1a4938fc94e04666fd3372b74b319d0c6f9f4840', head, 'publication-release-checkpoint-v2');
  const leafSha256 = '27826deb7e05792ea526bfe761fe4272205c247afd425789bb9c9edec3c8d6f3';
  const inclusion = { sequence: head.sequence, leafSha256, siblings: [leafSha256, '5effb111c1c250c40435fc625350efe37a9d688b92ced3884380852b8d1a06a8'] };
  const manifest = keyManifest(publishedAtUtc, '2026-11-15T08:10:00.000020Z', '2026-11-15T08:10:00.000003Z');
  const bundle = { checkpoint, inclusion };
  const expected = { sequence: inclusion.sequence, entrySha256: '33'.repeat(32) };
  const scope = checkpoint.scopeKey;
  const check = (value: object = bundle, keys = manifest, witness = head, targetScope = scope, entry?: typeof expected) =>
    verifyPublicationCheckpoint(value, keys, witness, origin, targetScope, entry);
  const checkInclusion = (value: (typeof inclusion & { title?: string }) | null, entry?: typeof expected) =>
    check({ ...bundle, inclusion: value }, manifest, head, scope, entry);

  assert.deepEqual(check(bundle, manifest, head, scope, expected), {
    scopeKey: scope, fromSequence: checkpoint.fromSequence, toSequence: checkpoint.toSequence,
    rootSha256: checkpoint.rootSha256, headSequence: head.sequence, inclusionSequence: inclusion.sequence,
  });
  assert.equal(checkInclusion(null).inclusionSequence, null);
  assert.throws(() => check(bundle, manifest, head, 'other'), /Invalid native release checkpoint/);
  assert.throws(() => check({ ...bundle, checkpoint: { ...checkpoint, scopeKey: 'other' } }, manifest, head, 'other'), /signature/);
  assert.throws(() => checkInclusion({ ...inclusion, title: 'private' }), /inclusion/);
  assert.throws(() => checkInclusion({ ...inclusion, siblings: inclusion.siblings.toReversed() }, expected), /odd sibling/);
  assert.throws(() => checkInclusion({ ...inclusion, siblings: inclusion.siblings.slice(0, 1) }), /Incomplete checkpoint/);
  assert.throws(() => check(bundle, manifest, head, scope, { ...expected, entrySha256: '22'.repeat(32) }), /expected ledger entry/);

  const substitutedHash = '44'.repeat(32);
  const substitutedCheckpoint = {
    ...checkpoint, headEntrySha256: substitutedHash,
    signature: signed('publication-release-checkpoint-v2', input => input.replace(/^headEntrySha256:h:.+$/m, `headEntrySha256:h:${substitutedHash}`)),
  };
  assert.throws(() => check({ ...bundle, checkpoint: substitutedCheckpoint }, manifest, makeHead('9007199254741003', substitutedHash)), /expected ledger digest/);
  for (const change of [{ revokedAtUtc: checkpoint.attestedAtUtc }, { compromisedAtUtc: manifest.keys[0].revokedAtUtc }])
    assert.throws(() => check(bundle, withKey(manifest, change)), /ineligible/);
});

test('verifies opaque daily checkpoint coverage and ordered inclusion against an independently retained head', () => {
  const day = '2026-11-14';
  const { origin, signed, head: makeHead, checkpoint: makeCheckpoint, keyManifest, withKey } = publicationSigner();
  const pin = makeHead('6', '66'.repeat(32));
  const keys = keyManifest('2026-11-14T00:00:00.000000Z', '2026-11-15T08:10:00.000020Z', '2026-11-15T08:10:00.000003Z');
  const checkpoint = makeCheckpoint('daily', day, '1', '5', 3,
    '195aea196ec18745e11b9385b0f7499a0d3e96db0aa91379800ca0222539fe04', pin, 'publication-daily-checkpoint-discontiguous-v2');
  const inclusion = {
    sequence: '5', position: 2, entrySha256: '55'.repeat(32), siblings: [
      '44578fa957de83c75cda97c2be6ad8f426d33401728fc547dd6d2bb409232003',
      '7c441a12a87057e7d2322f6fc0efef9e5717d10bc61478296a89ff68f7680a57',
    ],
  };
  const bundle = { checkpoint, inclusion };
  const expected = { sequence: '5', entrySha256: '55'.repeat(32) };
  const verify = (value: object = bundle, witness = pin, date = day, entry: typeof expected | null = expected, registry = keys) =>
    verifyPublicationCheckpoint(value, registry, witness, origin, date, entry ?? undefined, 'daily');

  assert.deepEqual(verify(), { scopeKey: day, fromSequence: '1', toSequence: '5', rootSha256: checkpoint.rootSha256, headSequence: '6', inclusionSequence: '5' });
  assert.equal(verify(bundle, makeHead('6', '66'.repeat(32), undefined, '2026-11-15T00:00:00.000000Z')).inclusionSequence, '5');
  assert.throws(() => verify(bundle, makeHead('6', '66'.repeat(32), undefined, '2026-11-14T23:59:59.999999Z')), /scope/);
  assert.throws(() => verify({ ...bundle, checkpoint: { ...checkpoint, scopeKey: '2026-11-31' } }, pin, '2026-11-31'), /scope/);
  assert.throws(() => verify({ ...bundle, checkpoint: { ...checkpoint, headSequence: '16385' } }, makeHead('16385', '66'.repeat(32))), /signed range/);
  assert.throws(() => verify({ ...bundle, checkpoint: { ...checkpoint, entryCount: 4097 } }), /checkpoint/);
  for (const [changed, error] of [
    [{ sequence: '4' }, /position/], [{ position: 0 }, /position/],
    [{ entrySha256: '33'.repeat(32) }, /expected ledger entry/], [{ siblings: inclusion.siblings.toReversed() }, /odd sibling/],
  ] as const) assert.throws(() => verify({ ...bundle, inclusion: { ...inclusion, ...changed } }), error);
  assert.throws(() => verifyPublicationCheckpoint(bundle, keys, pin, origin, day), /release checkpoint/);
  assert.throws(() => verify(bundle, pin, day, expected, withKey(keys, { compromisedAtUtc: keys.keys[0].revokedAtUtc })), /ineligible/);

  const empty = {
    checkpoint: {
      ...checkpoint, fromSequence: '0', toSequence: '0', entryCount: 0,
      rootSha256: '3d0959f57c8020c30b6386278aed45cf3a56a37bd08b54f4f89f1bba59827cda',
      signature: signed('publication-daily-checkpoint-empty-v2'),
    },
    inclusion: null,
  };
  assert.equal(verify(empty, pin, day, null).inclusionSequence, null);
  assert.throws(() => verify(empty), /inclusion/);
  assert.throws(() => verify({ ...empty, checkpoint: { ...empty.checkpoint, fromSequence: '1' } }, pin, day, null), /range/);
});
