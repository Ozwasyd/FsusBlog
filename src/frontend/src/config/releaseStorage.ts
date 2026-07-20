import {
  isCanonicalReleaseId,
  LOCAL_UNVERSIONED_RELEASE_ID
} from '../generated/releaseIdContract'

export function normalizeFrontendBuildId(value?: string | null): string | null {
  const candidate = value?.trim() || ''
  return isCanonicalReleaseId(candidate)
    ? candidate
    : null
}

export function resolveFrontendBuildIdentity(
  value: string | null | undefined,
  production: boolean
): string {
  const normalized = normalizeFrontendBuildId(value)
  if (normalized) return normalized
  if (!production) return LOCAL_UNVERSIONED_RELEASE_ID
  throw new Error('Production frontend build identity is missing or invalid.')
}

export function assertProductionFrontendBuildId(value?: string | null): string {
  return resolveFrontendBuildIdentity(value, true)
}

export function resolveReleaseSearchManifestUrl(
  baseUrl: string,
  buildId?: string | null,
  production = false
): string {
  const base = (baseUrl || '/').replace(/\/?$/, '/')
  const identity = resolveFrontendBuildIdentity(buildId, production)
  return isCanonicalReleaseId(identity)
    ? `${base}release-derived/${identity}/search/index.manifest.aeds`
    : `${base}search/index.manifest.aeds`
}

export function resolveServiceWorkerScriptUrl(
  baseUrl: string,
  buildId?: string | null,
  production = false
): string {
  const base = (baseUrl || '/').replace(/\/?$/, '/')
  const identity = resolveFrontendBuildIdentity(buildId, production)
  return isCanonicalReleaseId(identity)
    ? `${base}sw.js?build=${encodeURIComponent(identity)}`
    : `${base}sw.js`
}
