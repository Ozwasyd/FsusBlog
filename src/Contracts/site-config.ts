import { dataView, decodeFixedText, decodeUtf8, ProtocolError } from './binary.ts';
import { request } from './client.ts';
import { FrameType, WireLayouts as L, WireLimits, WireRoutes } from './wire.generated.ts';

function fields(payload: Uint8Array, podBytes: number, sliceOffset: number) {
  const start = podBytes + 4;
  const length = payload.byteLength - start;
  if (length < 0 || length > WireLimits.SiteConfigBlobBytes)
    throw new ProtocolError('Invalid site config payload size');
  const view = dataView(payload);
  if (view.getInt32(sliceOffset, true) !== 0 || view.getInt32(sliceOffset + 4, true) !== length ||
      view.getInt32(podBytes, true) !== length)
    throw new ProtocolError('Invalid site config text slice');
  const text = decodeUtf8(payload.subarray(start));
  if (text.includes('\0')) throw new ProtocolError('Invalid site config text');
  return {
    view,
    text,
    fixed: (from: number, end: number) =>
      decodeFixedText(payload.subarray(from, end), () => new ProtocolError('Invalid site config text padding')),
  };
}

export function decodeSeoConfig(payload: Uint8Array) {
  const { fixed, text } = fields(payload, L.SeoConfigPodBytes, L.SeoConfigDescriptionOffset);
  return {
    title: fixed(L.SeoConfigTitleOffset, L.SeoConfigDescriptionOffset),
    description: text,
    keywords: fixed(L.SeoConfigKeywordsOffset, L.SeoConfigAuthorOffset),
    author: fixed(L.SeoConfigAuthorOffset, L.SeoConfigOgImageOffset),
    ogImage: fixed(L.SeoConfigOgImageOffset, L.SeoConfigBaseUrlOffset),
    baseUrl: fixed(L.SeoConfigBaseUrlOffset, L.SeoConfigFaviconSvgUrlOffset),
    faviconSvgUrl: fixed(L.SeoConfigFaviconSvgUrlOffset, L.SeoConfigFaviconIcoUrlOffset),
    faviconIcoUrl: fixed(L.SeoConfigFaviconIcoUrlOffset, L.SeoConfigFaviconPngUrlOffset),
    faviconPngUrl: fixed(L.SeoConfigFaviconPngUrlOffset, L.SeoConfigAppleTouchIconUrlOffset),
    appleTouchIconUrl: fixed(L.SeoConfigAppleTouchIconUrlOffset, L.SeoConfigManifestNameOffset),
    manifestName: fixed(L.SeoConfigManifestNameOffset, L.SeoConfigManifestShortNameOffset),
    manifestShortName: fixed(L.SeoConfigManifestShortNameOffset, L.SeoConfigPwaIcon192UrlOffset),
    pwaIcon192Url: fixed(L.SeoConfigPwaIcon192UrlOffset, L.SeoConfigPwaIcon512UrlOffset),
    pwaIcon512Url: fixed(L.SeoConfigPwaIcon512UrlOffset, L.SeoConfigPwaMaskableIconUrlOffset),
    pwaMaskableIconUrl: fixed(L.SeoConfigPwaMaskableIconUrlOffset, L.SeoConfigThemeColorOffset),
    themeColor: fixed(L.SeoConfigThemeColorOffset, L.SeoConfigBackgroundColorOffset),
    backgroundColor: fixed(L.SeoConfigBackgroundColorOffset, L.SeoConfigSiteLogoUrlOffset),
    siteLogoUrl: fixed(L.SeoConfigSiteLogoUrlOffset, L.SeoConfigSiteLogoDarkUrlOffset),
    siteLogoDarkUrl: fixed(L.SeoConfigSiteLogoDarkUrlOffset, L.SeoConfigSiteWordmarkUrlOffset),
    siteWordmarkUrl: fixed(L.SeoConfigSiteWordmarkUrlOffset, L.SeoConfigAdminLogoUrlOffset),
    adminLogoUrl: fixed(L.SeoConfigAdminLogoUrlOffset, L.SeoConfigAdminCollapsedIconUrlOffset),
    adminCollapsedIconUrl: fixed(L.SeoConfigAdminCollapsedIconUrlOffset, L.SeoConfigLoginLogoUrlOffset),
    loginLogoUrl: fixed(L.SeoConfigLoginLogoUrlOffset, L.SeoConfigLoginIconUrlOffset),
    loginIconUrl: fixed(L.SeoConfigLoginIconUrlOffset, L.SeoConfigPodBytes),
  };
}

export function decodeSiteComplianceConfig(payload: Uint8Array) {
  const { fixed, view, text } = fields(payload, L.SiteCompliancePodBytes, L.SiteComplianceCopyrightTextOffset);
  const enabled = view.getUint8(L.SiteComplianceEnabledOffset);
  const regionMode = fixed(L.SiteComplianceRegionModeOffset, L.SiteComplianceCopyrightStartYearOffset);
  const year = view.getInt32(L.SiteComplianceCopyrightStartYearOffset, true);
  if ((enabled !== 0 && enabled !== 1) || (regionMode !== 'global' && regionMode !== 'mainland-cn') || year < 0 || year > 9999)
    throw new ProtocolError('Invalid site compliance policy');
  return {
    enabled: enabled === 1,
    regionMode,
    copyrightStartYear: year === 0 ? null : year,
    copyrightOwner: fixed(L.SiteComplianceCopyrightOwnerOffset, L.SiteComplianceCopyrightTextOffset),
    copyrightText: text,
    contentLicenseName: fixed(L.SiteComplianceContentLicenseNameOffset, L.SiteComplianceContentLicenseUrlOffset),
    contentLicenseUrl: fixed(L.SiteComplianceContentLicenseUrlOffset, L.SiteComplianceIcpRecordNumberOffset),
    icpRecordNumber: fixed(L.SiteComplianceIcpRecordNumberOffset, L.SiteComplianceIcpRecordUrlOffset),
    icpRecordUrl: fixed(L.SiteComplianceIcpRecordUrlOffset, L.SiteCompliancePoliceRecordNumberOffset),
    policeRecordNumber: fixed(L.SiteCompliancePoliceRecordNumberOffset, L.SiteCompliancePoliceRecordUrlOffset),
    policeRecordUrl: fixed(L.SiteCompliancePoliceRecordUrlOffset, L.SiteCompliancePoliceBadgeIconUrlOffset),
    policeBadgeIconUrl: fixed(L.SiteCompliancePoliceBadgeIconUrlOffset, L.SiteComplianceOperatorNameOffset),
    operatorName: fixed(L.SiteComplianceOperatorNameOffset, L.SiteComplianceContactEmailOffset),
    contactEmail: fixed(L.SiteComplianceContactEmailOffset, L.SiteCompliancePodBytes),
  };
}

export type SiteSeo = ReturnType<typeof decodeSeoConfig>;
export type SiteCompliance = ReturnType<typeof decodeSiteComplianceConfig>;

export function getSiteSeo(signal?: AbortSignal) {
  return request(WireRoutes.PublicSeo, FrameType.SeoConfig, decodeSeoConfig, signal);
}

export function getSiteCompliance(signal?: AbortSignal) {
  return request(WireRoutes.PublicCompliance, FrameType.SiteComplianceConfig, decodeSiteComplianceConfig, signal);
}
