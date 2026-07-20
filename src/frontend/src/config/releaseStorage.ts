import { isCanonicalReleaseId } from '@/generated/releaseIdContract'

export function normalizeFrontendBuildId(value?: string | null): string | null {
  const candidate = value?.trim() || ''
  return isCanonicalReleaseId(candidate)
    ? candidate
    : null
}

export function resolveReleaseSearchManifestUrl(baseUrl: string, buildId?: string | null): string {
  const base = (baseUrl || '/').replace(/\/?$/, '/')
  const normalizedBuildId = normalizeFrontendBuildId(buildId)
  return normalizedBuildId
    ? `${base}release-derived/${normalizedBuildId}/search/index.manifest.aeds`
    : `${base}search/index.manifest.aeds`
}

export function resolveServiceWorkerScriptUrl(baseUrl: string, buildId?: string | null): string {
  const base = (baseUrl || '/').replace(/\/?$/, '/')
  const normalizedBuildId = normalizeFrontendBuildId(buildId)
  return normalizedBuildId
    ? `${base}sw.js?build=${encodeURIComponent(normalizedBuildId)}`
    : `${base}sw.js`
}
