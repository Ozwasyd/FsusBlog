import type { PageContentPublic, SeoConfigPublic, SiteComplianceConfigPublic } from '@/api/system';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { BinaryReader, readBlobText, readFixedUtf8, readInt32 } from './reader';

const SEO_CONFIG_POD_SIZE = 1096;
const PAGE_CONTENT_POD_SIZE = 136;
const SITE_COMPLIANCE_CONFIG_POD_SIZE = 1709;

export function mapSeoConfigFromPayload(payload: Uint8Array): SeoConfigPublic {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(SEO_CONFIG_POD_SIZE);
  const blob = reader.readBlob();

  const result = {
    title: readFixedUtf8(pod, 0, 256),
    description: readBlobText(pod, blob, 256),
    keywords: readFixedUtf8(pod, 264, 256),
    author: readFixedUtf8(pod, 520, 64),
    ogImage: readFixedUtf8(pod, 584, 256),
    baseUrl: readFixedUtf8(pod, 840, 256)
  };

  ensureConsumed(reader, 'seo_config_trailing_payload_invalid');
  return result;
}

export function mapPageContentFromPayload(payload: Uint8Array): PageContentPublic {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(PAGE_CONTENT_POD_SIZE);
  const blob = reader.readBlob();

  const result = {
    slug: readFixedUtf8(pod, 0, 128),
    content: readBlobText(pod, blob, 128)
  };

  ensureConsumed(reader, 'page_content_trailing_payload_invalid');
  return result;
}

export function mapSiteComplianceConfigFromPayload(payload: Uint8Array): SiteComplianceConfigPublic {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(SITE_COMPLIANCE_CONFIG_POD_SIZE);
  const blob = reader.readBlob();

  const regionMode = readFixedUtf8(pod, 1, 32) === 'mainland-cn' ? 'mainland-cn' : 'global';
  const startYear = readInt32(pod, 33);
  const result: SiteComplianceConfigPublic = {
    enabled: pod[0] !== 0,
    regionMode,
    copyrightOwner: readFixedUtf8(pod, 37, 128),
    copyrightStartYear: startYear > 0 ? startYear : null,
    copyrightText: readBlobText(pod, blob, 165),
    contentLicenseName: readFixedUtf8(pod, 173, 128),
    contentLicenseUrl: readFixedUtf8(pod, 301, 256),
    icpRecordNumber: readFixedUtf8(pod, 557, 64),
    icpRecordUrl: readFixedUtf8(pod, 621, 256),
    policeRecordNumber: readFixedUtf8(pod, 877, 64),
    policeRecordUrl: readFixedUtf8(pod, 941, 256),
    policeBadgeIconUrl: readFixedUtf8(pod, 1197, 256),
    operatorName: readFixedUtf8(pod, 1453, 128),
    contactEmail: readFixedUtf8(pod, 1581, 128)
  };

  ensureConsumed(reader, 'site_compliance_config_trailing_payload_invalid');
  return result;
}

function ensureConsumed(reader: BinaryReader, errorCode: string): void {
  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }
}
