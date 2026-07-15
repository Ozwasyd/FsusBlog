import crypto from 'node:crypto'

export const PUBLIC_AOT_WARM_EVIDENCE_SCHEMA = 'fsusblog.public-aot-warm-evidence.v1'
const REQUIRED_SEO_CHECKS = Object.freeze([
  'title', 'description', 'canonical', 'robots',
  'openGraph', 'twitter', 'jsonLd', 'mainContent'
])

function headerValue(headers, name) {
  if (headers && typeof headers.get === 'function') return headers.get(name) || ''
  const normalized = name.toLowerCase()
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === normalized)
  return entry ? String(entry[1] ?? '') : ''
}

function htmlDecode(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function stripHtml(value) {
  return htmlDecode(value.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim())
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'iu'))
  return htmlDecode(match?.[1] ?? match?.[2] ?? '')
}

function metaContent(html, attributeName, expectedValue) {
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    if (attribute(match[0], attributeName).toLowerCase() === expectedValue.toLowerCase()) {
      return attribute(match[0], 'content')
    }
  }
  return ''
}

function linkHref(html, rel) {
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const rels = attribute(match[0], 'rel').toLowerCase().split(/\s+/u)
    if (rels.includes(rel.toLowerCase())) return attribute(match[0], 'href')
  }
  return ''
}

function parseJsonLd(html) {
  const documents = []
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
    if (attribute(match[1], 'type').toLowerCase() !== 'application/ld+json') continue
    try {
      documents.push(JSON.parse(match[2]))
    } catch {
      return []
    }
  }
  return documents
}

function normalizeOrigin(value) {
  if (!value) return ''
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

export function canonicalManifest(routes) {
  return routes
    .map((route) => ({
      pageId: String(route.pageId ?? ''),
      kind: String(route.kind ?? ''),
      routeKey: String(route.routeKey ?? ''),
      path: String(route.path ?? ''),
      canonicalPath: String(route.canonicalPath ?? route.path ?? ''),
      dependencyKeys: [...new Set((route.dependencyKeys ?? []).map(String))].sort(),
      priority: Number(route.priority ?? 0)
    }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.routeKey.localeCompare(right.routeKey))
}

export function publicAotManifestDigest(routes) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalManifest(routes))).digest('hex')
}

export function inspectPublicAotResponse({ path, status, headers, html, expectedPublicOrigin = '' }) {
  const title = stripHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? '')
  const description = metaContent(html, 'name', 'description')
  const canonicalUrl = linkHref(html, 'canonical')
  const robots = metaContent(html, 'name', 'robots')
  const ogTitle = metaContent(html, 'property', 'og:title')
  const ogDescription = metaContent(html, 'property', 'og:description')
  const ogUrl = metaContent(html, 'property', 'og:url')
  const twitterCard = metaContent(html, 'name', 'twitter:card')
  const twitterTitle = metaContent(html, 'name', 'twitter:title')
  const twitterDescription = metaContent(html, 'name', 'twitter:description')
  const jsonLd = parseJsonLd(html)
  const mainText = stripHtml(html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/iu)?.[1] ?? '')
  let canonicalPathMatches = false
  let canonicalOriginMatches = false
  try {
    const canonical = new URL(canonicalUrl)
    canonicalPathMatches = canonical.pathname === path && canonical.search === ''
    canonicalOriginMatches = !expectedPublicOrigin || canonical.origin === normalizeOrigin(expectedPublicOrigin)
  } catch {
  }

  const checks = {
    title: title.length > 0,
    description: description.trim().length > 0,
    canonical: canonicalPathMatches && canonicalOriginMatches,
    robots: robots.length > 0 && !robots.toLowerCase().includes('noindex'),
    openGraph: ogTitle.length > 0 && ogDescription.length > 0 && ogUrl === canonicalUrl,
    twitter: twitterCard.length > 0 && twitterTitle.length > 0 && twitterDescription.length > 0,
    jsonLd: jsonLd.length > 0,
    mainContent: mainText.length >= 8
  }
  const retryAfter = headerValue(headers, 'retry-after')
  const cacheControl = headerValue(headers, 'cache-control')
  const xRobotsTag = headerValue(headers, 'x-robots-tag')
  const noindex = robots.toLowerCase().includes('noindex') || xRobotsTag.toLowerCase().includes('noindex')

  return {
    status,
    source: headerValue(headers, 'x-fsus-public-aot-source') || 'unknown',
    state: headerValue(headers, 'x-fsus-public-aot-state') || 'unknown',
    rendererVersion: headerValue(headers, 'x-fsus-public-aot-version'),
    frontendAssetVersion: headerValue(headers, 'x-fsus-public-aot-frontend-asset-version'),
    releaseId: headerValue(headers, 'x-fsus-release-id'),
    releaseSlot: headerValue(headers, 'x-fsus-release-slot'),
    retryAfter,
    cacheControl,
    xRobotsTag,
    canonicalUrl,
    checks,
    retryableFailure: status === 503
      && /^\d+$/u.test(retryAfter)
      && Number(retryAfter) > 0
      && cacheControl.toLowerCase().includes('no-store')
      && noindex
      && headerValue(headers, 'x-fsus-public-aot-source') === 'server-status'
      && headerValue(headers, 'x-fsus-public-aot-state') === 'transient-failure'
  }
}

export function isCompletePublicAotSuccess(response) {
  return response?.status === 200
    && response.source === 'server-ssr'
    && response.state === 'fresh'
    && typeof response.rendererVersion === 'string'
    && response.rendererVersion.length > 0
    && typeof response.frontendAssetVersion === 'string'
    && response.frontendAssetVersion.length > 0
    && REQUIRED_SEO_CHECKS.every((check) => response.checks?.[check] === true)
}

export function isValidColdFirstResponse(response) {
  return isCompletePublicAotSuccess(response) || response?.retryableFailure === true
}

export function createPublicAotWarmEvidence({
  baseUrl,
  scope,
  manifest,
  results,
  generatedAtUtc = new Date().toISOString(),
  expectedPublicOrigin = ''
}) {
  const normalizedManifest = canonicalManifest(manifest)
  const failed = results.filter((result) => !result.ok)
  const rendererVersions = [...new Set(results.map((result) => result.settled?.rendererVersion).filter(Boolean))]
  const frontendAssetVersions = [...new Set(results.map((result) => result.settled?.frontendAssetVersion).filter(Boolean))]
  return {
    schema: PUBLIC_AOT_WARM_EVIDENCE_SCHEMA,
    status: failed.length === 0 ? 'ok' : 'failed',
    generatedAtUtc,
    baseUrl,
    expectedPublicOrigin: normalizeOrigin(expectedPublicOrigin),
    scope,
    manifestDigest: publicAotManifestDigest(normalizedManifest),
    manifest: normalizedManifest,
    rendererVersions,
    frontendAssetVersions,
    total: normalizedManifest.length,
    warmed: results.length,
    failed: failed.length,
    routes: results
  }
}

export function validatePublicAotWarmEvidence(evidence, {
  expectedRelease = '',
  expectedSlot = '',
  expectedPublicOrigin = '',
  requireScope = '',
  maxAgeSeconds = 900,
  now = Date.now()
} = {}) {
  const errors = []
  if (!evidence || evidence.schema !== PUBLIC_AOT_WARM_EVIDENCE_SCHEMA) errors.push('schema mismatch')
  if (evidence?.status !== 'ok') errors.push('status is not ok')
  const generatedAt = Date.parse(evidence?.generatedAtUtc ?? '')
  if (!Number.isFinite(generatedAt) || generatedAt > now + 60_000 || now - generatedAt > maxAgeSeconds * 1000) {
    errors.push('report is missing, future-dated, or stale')
  }
  if (requireScope && evidence?.scope !== requireScope) errors.push(`scope must be ${requireScope}`)
  const manifest = Array.isArray(evidence?.manifest) ? evidence.manifest : []
  const routes = Array.isArray(evidence?.routes) ? evidence.routes : []
  if (manifest.length === 0) errors.push('manifest is empty')
  if (evidence?.manifestDigest !== publicAotManifestDigest(manifest)) errors.push('manifest digest mismatch')
  const manifestPaths = [...new Set(manifest.map((route) => route.path))].sort()
  const resultPaths = [...new Set(routes.map((route) => route.path))].sort()
  if (manifestPaths.length !== manifest.length) errors.push('manifest paths are not unique')
  if (JSON.stringify(manifestPaths) !== JSON.stringify(resultPaths)) errors.push('route coverage is incomplete')
  if (evidence?.total !== manifest.length || evidence?.warmed !== routes.length || evidence?.failed !== 0) {
    errors.push('summary counts are inconsistent')
  }
  if (!Array.isArray(evidence?.rendererVersions) || evidence.rendererVersions.length !== 1) {
    errors.push('renderer version identity is not singular')
  }
  if (!Array.isArray(evidence?.frontendAssetVersions) || evidence.frontendAssetVersions.length !== 1) {
    errors.push('frontend asset version identity is not singular')
  }
  const observedRendererVersions = [...new Set(routes.map((route) => route.settled?.rendererVersion).filter(Boolean))]
  const observedFrontendAssetVersions = [...new Set(routes.map((route) => route.settled?.frontendAssetVersion).filter(Boolean))]
  if (JSON.stringify(evidence?.rendererVersions ?? []) !== JSON.stringify(observedRendererVersions)) {
    errors.push('renderer version summary does not match route evidence')
  }
  if (JSON.stringify(evidence?.frontendAssetVersions ?? []) !== JSON.stringify(observedFrontendAssetVersions)) {
    errors.push('frontend asset version summary does not match route evidence')
  }
  const requiredOrigin = normalizeOrigin(expectedPublicOrigin || evidence?.expectedPublicOrigin || '')
  for (const route of routes) {
    if (!isValidColdFirstResponse(route.first)) errors.push(`${route.path}: invalid cold first response`)
    if (!isCompletePublicAotSuccess(route.settled)) errors.push(`${route.path}: settled response is incomplete`)
    if (!route.ok) errors.push(`${route.path}: route is not ok`)
    if (expectedRelease && route.settled?.releaseId !== expectedRelease) errors.push(`${route.path}: release identity mismatch`)
    if (expectedSlot && route.settled?.releaseSlot !== expectedSlot) errors.push(`${route.path}: release slot mismatch`)
    if (requiredOrigin) {
      try {
        if (new URL(route.settled?.canonicalUrl ?? '').origin !== requiredOrigin) errors.push(`${route.path}: canonical origin mismatch`)
      } catch {
        errors.push(`${route.path}: canonical URL invalid`)
      }
    }
  }
  return [...new Set(errors)]
}
