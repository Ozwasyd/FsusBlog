import type { SiteComplianceConfigPublic } from '@/api/system'
import type { PublicHydrationPayload } from '@/public-renderers/publicPayloadTypes'
import { PUBLIC_SITE_IDENTITY_DEFAULTS } from '@/public-renderers/publicSiteIdentityDefaults'
import { isSupportedLocale, type SupportedLocale } from '@/locales'

export type PublicTakeoverSeed = Readonly<{
  siteTitle: string
  siteDescription: string
  siteLogoUrl: string
  siteLogoDarkUrl: string
  siteWordmarkUrl: string
  compliance: SiteComplianceConfigPublic | null
  renderYear: number | null
  renderLocale: SupportedLocale
}>

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numeric(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0
}

export function normalizePublicSiteTitle(value: unknown): string {
  return text(value) || PUBLIC_SITE_IDENTITY_DEFAULTS.siteTitle
}

export function normalizePublicSiteDescription(value: unknown): string {
  return text(value) || PUBLIC_SITE_IDENTITY_DEFAULTS.siteDescription
}

export function normalizePublicComplianceConfig(value: unknown): SiteComplianceConfigPublic | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const source = value as Record<string, unknown>
  const startYear = numeric(source.copyrightStartYear)

  return {
    enabled: Boolean(source.enabled),
    regionMode: text(source.regionMode) === 'mainland-cn' ? 'mainland-cn' : 'global',
    copyrightOwner: text(source.copyrightOwner),
    copyrightStartYear: startYear > 0 ? startYear : null,
    copyrightText: text(source.copyrightText),
    contentLicenseName: text(source.contentLicenseName),
    contentLicenseUrl: text(source.contentLicenseUrl),
    icpRecordNumber: text(source.icpRecordNumber),
    icpRecordUrl: text(source.icpRecordUrl) || 'https://beian.miit.gov.cn/',
    policeRecordNumber: text(source.policeRecordNumber),
    policeRecordUrl: text(source.policeRecordUrl) || 'https://beian.mps.gov.cn/',
    policeBadgeIconUrl: text(source.policeBadgeIconUrl),
    operatorName: text(source.operatorName),
    contactEmail: text(source.contactEmail)
  }
}

export function createPublicTakeoverSeed(payload: PublicHydrationPayload | null | undefined): PublicTakeoverSeed | null {
  if (!payload) {
    return null
  }
  if (!isSupportedLocale(payload.renderLocale)) {
    return null
  }

  const compliance = normalizePublicComplianceConfig(payload.compliance)
  return Object.freeze({
    siteTitle: normalizePublicSiteTitle(payload.siteTitle ?? payload.title),
    siteDescription: normalizePublicSiteDescription(payload.siteDescription),
    siteLogoUrl: text(payload.siteLogoUrl),
    siteLogoDarkUrl: text(payload.siteLogoDarkUrl),
    siteWordmarkUrl: text(payload.siteWordmarkUrl),
    compliance: compliance ? Object.freeze(compliance) : null,
    renderYear: Number.isInteger(payload.renderYear) ? Number(payload.renderYear) : null,
    renderLocale: payload.renderLocale
  })
}
