import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeFrame } from '../../src/Contracts/aeds.ts';
import { ProtocolError } from '../../src/Contracts/binary.ts';
import { decodeSeoConfig, decodeSiteComplianceConfig } from '../../src/Contracts/site-config.ts';
import { FrameType, WireLayouts as L } from '../../src/Contracts/wire.generated.ts';

function fixture(name: string, frame: FrameType): Uint8Array {
  const source = readFileSync(new URL(`./fixtures/${name}.hex`, import.meta.url), 'utf8');
  return decodeFrame(Buffer.from(source.replaceAll(/\s/g, ''), 'hex'), frame).payload;
}

test('SEO v1 POD retains ordered text fields, a full-width UTF-8 slot, and its only blob', () => {
  const payload = fixture('seo-config-v1', FrameType.SeoConfig);
  assert.deepEqual(decodeSeoConfig(payload), {
    title: 'A️⃣ 公开 · Site', description: '独立描述 & café\nLine two 🐈', keywords: 'k=α', author: 'Fsu🐈',
    ogImage: 'https://cdn.example.test/og.png', baseUrl: 'https://scope.example.test:8443', faviconSvgUrl: '/assets/site.svg',
    faviconIcoUrl: '/favicon.ico', faviconPngUrl: '/fav.png', appleTouchIconUrl: '/apple.png', manifestName: '测试清单',
    manifestShortName: '名字', pwaIcon192Url: '/pwa192.png', pwaIcon512Url: '/pwa512.png', pwaMaskableIconUrl: '/maskable.png',
    themeColor: '#112233', backgroundColor: '#445566', siteLogoUrl: '/light.svg', siteLogoDarkUrl: '/dark.svg',
    siteWordmarkUrl: '/wordmark.svg', adminLogoUrl: '/backoffice.svg', adminCollapsedIconUrl: '/compact.svg', loginLogoUrl: '/login.svg',
    loginIconUrl: 'x'.repeat(252) + '🧪',
  });
  assert.throws(() => decodeSeoConfig(payload.subarray(0, -1)), ProtocolError);
  for (const offset of [255, 256, 260, L.SeoConfigPodBytes, L.SeoConfigBlobOffset, payload.length - 1]) {
    const changed = Uint8Array.from(payload);
    changed[offset] = 0xff;
    assert.throws(() => decodeSeoConfig(changed), ProtocolError);
  }
});

test('compliance v1 POD decodes its unaligned year and protects fixed fields and text framing', () => {
  const payload = fixture('site-compliance-v1', FrameType.SiteComplianceConfig);
  assert.deepEqual(decodeSiteComplianceConfig(payload), {
    enabled: true, regionMode: 'mainland-cn', copyrightStartYear: 2024, copyrightOwner: '站点所有者', copyrightText: '©保留 · 独立\nRésumé 🧭',
    contentLicenseName: 'CC BY 4.0', contentLicenseUrl: 'https://creativecommons.org/licenses/by/4.0/', icpRecordNumber: '示例ICP备123号',
    icpRecordUrl: 'https://icp.example.test/check', policeRecordNumber: '示例网安备012号', policeRecordUrl: 'https://police.example.test/check',
    policeBadgeIconUrl: '/badge.svg', operatorName: '测试 Operator', contactEmail: 'public@example.test',
  });
  assert.throws(() => decodeSiteComplianceConfig(Uint8Array.from([...payload, 0])), ProtocolError);
  for (const [offset, byte] of [[0, 2], [1, 97], [36, 128], [164, 0xff], [L.SiteComplianceCopyrightTextOffset, 1]]) {
    const invalid = Uint8Array.from(payload);
    invalid[offset] = byte;
    assert.throws(() => decodeSiteComplianceConfig(invalid), ProtocolError);
  }
  const unknownYear = Uint8Array.from(payload);
  unknownYear.fill(0, L.SiteComplianceCopyrightStartYearOffset, L.SiteComplianceCopyrightOwnerOffset);
  assert.equal(decodeSiteComplianceConfig(unknownYear).copyrightStartYear, null);
});
