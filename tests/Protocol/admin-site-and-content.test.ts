import { deepEqual, equal, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  AdminArticleRollbackBlock, executeAdminArticleDraftRollback, executeAdminArticleRollback, isValidAdminArticleRollbackReason,
  readAdminArticleRollbackAvailability, readAdminArticleRollbackPreview,
} from '../../src/Contracts/admin-article-rollback.ts';
import { decodeClusterObservation } from '../../src/Contracts/admin-cluster.ts';
import {
  readAdminSiteConfig, saveAdminSiteConfig, validCopyrightStartYear, validSiteColor, validSiteEmail, validSiteText, validSiteUrl,
  type AdminSiteConfigCommand, type AdminSiteConfigState,
} from '../../src/Contracts/admin-site-config.ts';
import { decodeAdminSiteTraffic } from '../../src/Contracts/admin-site-traffic.ts';
import { PodWriter } from '../../src/Contracts/binary.ts';
import {
  decodeAdminArticleDraftRollbackIntent, decodeAdminArticleRollbackIntent, decodeAdminSiteConfigCommand, decodeAdminSiteConfigState,
  encodeAdminArticleDraftRollbackReceipt, encodeAdminArticleRollbackPreview, encodeAdminArticleRollbackReceipt,
  encodeAdminClusterStatus, encodeAdminSiteConfigCommand, encodeAdminSiteConfigState, FrameType, WireHeaders, WireRoutes,
} from '../../src/Contracts/wire.generated.ts';
import { appendByte, captureFetch, encodedResponse, framedFixture, frameResponse, rejectInputs } from './fixture-source.ts';
import { emptySuccessFrame, installPasskeyEnvironment, installPowWorker, loginBeginFrame, mfaChallengeResultFrame, powChallengeFrame } from './step-up-fixture.ts';

const signal = new AbortController().signal;

test('standalone deployment observation matches independent AEDS vector and rejects invalid fields', () => {
  const payload = framedFixture('admin-cluster-status-v2.hex', FrameType.AdminClusterStatus);
  const status = {
    mode: 1, nodeId: 'lab-a', instanceId: 'bd978cbd-7565-44ed-876d-d734cbe45c79', buildVersion: '2.0.0+ca32',
    startedAt: 1794680000000n, observedAt: 1794680040012n, leaseAgeMs: 349, snapshotReady: true,
  };
  deepEqual(Buffer.from(encodeAdminClusterStatus(status)), Buffer.from(payload));
  deepEqual(decodeClusterObservation(payload), { ...status, startedAt: Number(status.startedAt), observedAt: Number(status.observedAt) });
  rejectInputs(invalid => decodeClusterObservation(encodeAdminClusterStatus({ ...status, ...invalid })), [
    { mode: 0 }, { leaseAgeMs: 1000 }, { leaseAgeMs: -1 }, { startedAt: 0n }, { observedAt: 253_402_300_800_000n },
    { instanceId: '00000000-0000-0000-0000-000000000000' }, { nodeId: 'invalid\n' }, { buildVersion: '1.0.0\n' },
  ]);
});

test('site traffic distinguishes disabled, absent region mapping, valid ISO aggregates, and rejects contradictory states', () => {
  const traffic = (enabled: boolean, configured: boolean, days: readonly [string, bigint][], regions: readonly [string, bigint][]) => {
    const w = new PodWriter();
    w.bool(enabled); w.bool(configured);
    w.i32(days.length);
    for (const [date, count] of days) { w.text(date, 10); w.i64(count); }
    w.i32(regions.length);
    for (const [region, count] of regions) { w.text(region, 7); w.i64(count); }
    return w.finish();
  };
  deepEqual(decodeAdminSiteTraffic(traffic(false, false, [], [])),
    { enabled: false, regionsConfigured: false, days: [], regions: [] });
  deepEqual(decodeAdminSiteTraffic(traffic(true, false, [['2026-11-16', 2n]], [])),
    { enabled: true, regionsConfigured: false, days: [{ date: '2026-11-16', views: 2 }], regions: [] });
  deepEqual(decodeAdminSiteTraffic(traffic(true, true, [['2026-11-16', 0n], ['2026-11-17', 4n]], [['CN-BJ', 3n], ['unknown', 1n]])), {
    enabled: true, regionsConfigured: true,
    days: [{ date: '2026-11-16', views: 0 }, { date: '2026-11-17', views: 4 }],
    regions: [{ region: 'CN-BJ', views: 3 }, { region: 'unknown', views: 1 }],
  });
  rejectInputs(decodeAdminSiteTraffic, [
    traffic(false, true, [], []), traffic(false, false, [['2026-11-17', 1n]], []),
    traffic(true, false, [], [['CN', 1n]]), traffic(true, true, [], [['CN-BJ', 1n], ['CN-BJ', 3n]]),
    traffic(true, true, [], [['1.1.1.1', 1n]]), traffic(true, true, [], [['CN', 0n]]),
    traffic(true, true, [['2026-02-30', 1n]], []), traffic(true, true, [['2026-01-01', 9007199254740992n]], []),
    traffic(true, true, [['2026-11-17', 1n], ['2026-11-16', 2n]], []), appendByte(traffic(true, true, [], [])),
  ]);
});

test('site configuration codecs, validators, read, and Step-Up + PoW save preserve safety boundaries', async t => {
  const state: AdminSiteConfigState = {
    revision: 2n, digest: 'a'.repeat(64), origin: 'https://blog.example.test',
    title: 'North Journal', description: 'Notes on fieldwork', author: 'Editors',
    ogImage: '/assets/og.png', faviconSvgUrl: '/assets/favicon.svg', faviconIcoUrl: '/assets/favicon.ico',
    faviconPngUrl: '/assets/favicon.png', appleTouchIconUrl: '/assets/apple-touch.png',
    manifestName: 'North Journal App', manifestShortName: 'North',
    pwaIcon192Url: '/assets/icon-192.png', pwaIcon512Url: '/assets/icon-512.png', pwaMaskableIconUrl: '/assets/icon-maskable.png',
    themeColor: '#123456', backgroundColor: '#fafafa',
    siteLogoUrl: '/assets/logo.svg', siteLogoDarkUrl: '/assets/logo-dark.svg', siteWordmarkUrl: '/assets/wordmark.svg',
    complianceEnabled: true, regionMode: 'mainland-cn', copyrightStartYear: 2024,
    copyrightOwner: 'North Studio', copyrightText: 'All rights reserved.',
    contentLicenseName: 'CC BY 4.0', contentLicenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    icpRecordNumber: '京ICP备2026000000号-1', icpRecordUrl: 'https://beian.miit.gov.cn/',
    policeRecordNumber: '京公网安备11000002000000号', policeRecordUrl: 'https://beian.mps.gov.cn/',
    policeBadgeIconUrl: '/assets/police.png', operatorName: 'North Studio', contactEmail: 'hello@example.test',
  };
  const { revision, digest, origin: _origin, ...fields } = state;
  const command: AdminSiteConfigCommand = { expectedRevision: revision, expectedDigest: digest, ...fields };
  const stateFrame = (s: AdminSiteConfigState) => encodeFrame(FrameType.AdminSiteConfigState, encodeAdminSiteConfigState(s));
  deepEqual(decodeAdminSiteConfigState(decodeFrame(stateFrame(state), FrameType.AdminSiteConfigState).payload), state);
  deepEqual(decodeAdminSiteConfigCommand(decodeFrame(encodeFrame(FrameType.AdminSiteConfigCommand, encodeAdminSiteConfigCommand(command)), FrameType.AdminSiteConfigCommand).payload), command);

  for (const [args, expected] of [
    [['  ', 256, true], 'required'], [['North Journal', 256, true], null],
    [['bad\u0007text', 256], 'invalidChars'], [['line1\nline2', 256, false, true], null], [['x'.repeat(257), 256], 'tooLong'],
  ] as const) equal(validSiteText(...args), expected);
  for (const [url, options, expected] of [
    ['', { asset: true }, null], ['/assets/brand/logo.svg', { asset: true }, null],
    ['https://cdn.example.test/logo.png', { asset: true }, null], ['/assets/../secret.png', { asset: true }, 'invalidAssetUrl'],
    ['/assets/logo.png', { asset: false }, 'invalidUrl'], ['https://example.test/x?q=1', { asset: true }, 'invalidAssetUrl'],
    ['https://user@example.test/x.png', { asset: true }, 'invalidAssetUrl'], ['http://example.test/x.png', { asset: true }, 'invalidAssetUrl'],
    ['https://beian.miit.gov.cn/', { label: '' }, 'requiresLabel'], ['https://beian.miit.gov.cn/', { label: 'ICP-1' }, null],
  ] as const) equal(validSiteUrl(url, options), expected);
  for (const [v, expected] of [['', null], ['#1234af', null], ['#1234', 'invalidColor'], ['red', 'invalidColor']] as const) equal(validSiteColor(v), expected);
  for (const [v, expected] of [['', null], ['hello@example.test', null], ['Name <hello@example.test>', 'invalidEmail']] as const) equal(validSiteEmail(v), expected);
  for (const [y, expected] of [[null, null], [0, null], [2024, null], [1989, 'invalidYear'], [2027, 'invalidYear']] as const) equal(validCopyrightStartYear(y, 2026), expected);

  let next = state;
  captureFetch(t, () => frameResponse(stateFrame(next)));
  deepEqual(await readAdminSiteConfig(signal), state);
  next = { ...state, digest: 'BAD' };
  await rejects(() => readAdminSiteConfig(signal), ProtocolError);

  const proof = 'P'.repeat(43);
  const challenge = powChallengeFrame({ salt: 'a'.repeat(32), timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  installPasskeyEnvironment(t);
  installPowWorker(t);
  const calls = captureFetch(t, ({ url, headers }) => {
    if (url === WireRoutes.AdminSiteConfigStepUpBegin) return frameResponse(loginBeginFrame());
    if (url === WireRoutes.AdminSiteConfigStepUpComplete) return frameResponse(mfaChallengeResultFrame({ proof }));
    if (url === WireRoutes.AdminSiteConfigPow) return frameResponse(challenge);
    if (url === WireRoutes.AdminSiteConfigSave) {
      equal(headers.get(WireHeaders.MfaProof), proof);
      equal(typeof headers.get(WireHeaders.PowProof), 'string');
      return frameResponse(emptySuccessFrame());
    }
    throw new Error(`Unexpected path: ${url}`);
  });
  await saveAdminSiteConfig(command, signal);
  deepEqual(calls.map(c => c.url), [
    WireRoutes.AdminSiteConfigStepUpBegin, WireRoutes.AdminSiteConfigStepUpComplete,
    WireRoutes.AdminSiteConfigPow, WireRoutes.AdminSiteConfigSave,
  ]);
});

test('article and draft rollback enforce intent binding, receipts, preview, availability, and reason limits', async t => {
  const intent = {
    articleId: 42, expectedRevision: 9007199254740993n, expectedPublicationId: 67n,
    sourceRevision: 9007199254740991n, idempotencyKey: '00000000-0011-4222-8333-445566778899', reason: '恢复已核验的历史内容',
  };
  const receipt = {
    articleId: intent.articleId, revision: intent.expectedRevision + 1n, sourceRevision: intent.sourceRevision,
    previousPublicationId: intent.expectedPublicationId, publicationId: 78n, publicationNo: 4,
    publishedUnixMs: 1794659381000n, rightsSnapshotId: 88n, responsibilitySnapshotId: 93n,
  };
  let nextReceipt = receipt;
  const calls = captureFetch(t, ({ url, method, body }, init) => {
    equal(url, WireRoutes.AdminArticleRollbackExecute);
    equal(method, 'POST');
    equal(init?.credentials, 'same-origin');
    deepEqual(decodeAdminArticleRollbackIntent(decodeFrame(body, FrameType.AdminArticleRollbackIntent).payload), intent);
    return encodedResponse(FrameType.AdminArticleRollbackReceipt, encodeAdminArticleRollbackReceipt(nextReceipt));
  });
  const proof = 'a'.repeat(43);
  deepEqual(await executeAdminArticleRollback(intent, proof, signal), receipt);
  equal(calls[0].headers.get(WireHeaders.MfaProof), proof);
  deepEqual(await executeAdminArticleRollback(intent, undefined, signal), receipt);
  equal(calls[1].headers.get(WireHeaders.MfaProof), null);
  nextReceipt = { ...receipt, previousPublicationId: 69n };
  await rejects(() => executeAdminArticleRollback(intent, undefined, signal), ProtocolError);
  throws(() => executeAdminArticleRollback({ ...intent, sourceRevision: intent.expectedRevision }, proof, signal), ProtocolError);
  throws(() => executeAdminArticleRollback(intent, 'not-a-proof', signal), ProtocolError);

  const draftIntent = { ...intent, targetStatus: 0 };
  const { publicationId: privateReleaseId, publishedUnixMs: transitionedUnixMs, ...coordinates } = receipt;
  const draftReceipt = { ...coordinates, privateReleaseId, transitionedUnixMs, targetStatus: 0 };
  const draftProof = 'b'.repeat(43);
  let nextDraft = () => encodedResponse(FrameType.AdminArticleDraftRollbackReceipt, encodeAdminArticleDraftRollbackReceipt(draftReceipt));
  captureFetch(t, ({ url, headers, body }) => {
    equal(url, WireRoutes.AdminArticleDraftRollbackExecute);
    if (headers.has(WireHeaders.MfaProof)) equal(headers.get(WireHeaders.MfaProof), draftProof);
    deepEqual(decodeAdminArticleDraftRollbackIntent(decodeFrame(body, FrameType.AdminArticleDraftRollbackIntent).payload), draftIntent);
    return nextDraft();
  });
  deepEqual(await executeAdminArticleDraftRollback(draftIntent, draftProof, signal), draftReceipt);
  throws(() => executeAdminArticleDraftRollback({ ...draftIntent, targetStatus: 3 }, draftProof, signal), ProtocolError);
  for (const response of [
    () => encodedResponse(FrameType.AdminArticleRollbackReceipt, encodeAdminArticleRollbackReceipt(receipt)),
    () => encodedResponse(FrameType.AdminArticleDraftRollbackReceipt, encodeAdminArticleDraftRollbackReceipt({ ...draftReceipt, targetStatus: 2 })),
  ]) { nextDraft = response; await rejects(() => executeAdminArticleDraftRollback(draftIntent, undefined, signal), ProtocolError); }

  const preview = {
    articleId: intent.articleId, currentRevision: intent.expectedRevision,
    currentPublicationId: intent.expectedPublicationId, sourceRevision: intent.sourceRevision,
    sourcePublicationId: 54n, sourceTitle: '旧标题',
    packageComplete: false, blockingReason: AdminArticleRollbackBlock.MissingResponsibility,
  };
  let nextPreview = preview;
  captureFetch(t, ({ url }) => {
    equal(url, `${WireRoutes.AdminArticleRollbackPreview}?articleId=42&sourceRevision=9007199254740991`);
    return encodedResponse(FrameType.AdminArticleRollbackPreview, encodeAdminArticleRollbackPreview(nextPreview));
  });
  deepEqual(await readAdminArticleRollbackPreview(intent.articleId, intent.sourceRevision, signal), preview);
  nextPreview = { ...preview, packageComplete: true };
  await rejects(() => readAdminArticleRollbackPreview(intent.articleId, intent.sourceRevision, signal), ProtocolError);

  let status = 204;
  captureFetch(t, () => new Response(null, { status }));
  equal(await readAdminArticleRollbackAvailability(signal), true);
  status = 404;
  equal(await readAdminArticleRollbackAvailability(signal), false);
  status = 403;
  await rejects(() => readAdminArticleRollbackAvailability(signal), { status: 403 });

  equal(isValidAdminArticleRollbackReason('历史内容已经重新核对'), true);
  equal(isValidAdminArticleRollbackReason('回'.repeat(500)), true);
  for (const reason of ['short', ` ${intent.reason}`, `${intent.reason}\u0000`, `${intent.reason}\ud800`, '回'.repeat(501)])
    equal(isValidAdminArticleRollbackReason(reason), false);
});
