const IMMUTABLE_BUILD_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{5,127}$/
const MUTABLE_BUILD_IDS = new Set(['latest', 'current', 'final-current'])

export function normalizeFrontendBuildId(value?: string | null): string | null {
  const candidate = value?.trim() || ''
  return IMMUTABLE_BUILD_ID.test(candidate) && !MUTABLE_BUILD_IDS.has(candidate.toLowerCase())
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
