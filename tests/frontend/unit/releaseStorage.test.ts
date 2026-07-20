import { describe, expect, it } from 'vitest'
import {
  assertProductionFrontendBuildId,
  normalizeFrontendBuildId,
  resolveFrontendBuildIdentity,
  resolveReleaseSearchManifestUrl,
  resolveServiceWorkerScriptUrl
} from '../../../src/frontend/src/config/releaseStorage'

describe('release storage identity', () => {
  it('binds search and service worker URLs to one immutable frontend build', () => {
    const buildId = '20260711010101-0123456789ab'

    expect(normalizeFrontendBuildId(buildId)).toBe(buildId)
    expect(resolveReleaseSearchManifestUrl('/', buildId))
      .toBe(`/release-derived/${buildId}/search/index.manifest.aeds`)
    expect(resolveServiceWorkerScriptUrl('/', buildId))
      .toBe(`/sw.js?build=${buildId}`)
  })

  it('rejects traversal or mutable aliases and preserves development URLs', () => {
    for (const invalid of ['../active', 'latest', 'v1.2.0', '20260230010101-0123456789ab', 'bad/id', '']) {
      expect(normalizeFrontendBuildId(invalid)).toBeNull()
      expect(resolveReleaseSearchManifestUrl('/blog', invalid)).toBe('/blog/search/index.manifest.aeds')
      expect(resolveServiceWorkerScriptUrl('/blog', invalid)).toBe('/blog/sw.js')
    }
  })

  it('fails closed for missing or non-canonical production build identity', () => {
    for (const invalid of [undefined, '', 'local-unversioned', 'latest', 'v1.2.0']) {
      expect(() => assertProductionFrontendBuildId(invalid))
        .toThrow('Production frontend build identity is missing or invalid.')
      expect(() => resolveReleaseSearchManifestUrl('/', invalid, true)).toThrow()
      expect(() => resolveServiceWorkerScriptUrl('/', invalid, true)).toThrow()
    }
  })

  it('uses an explicit non-release identity only for local development', () => {
    expect(resolveFrontendBuildIdentity(undefined, false)).toBe('local-unversioned')
    expect(resolveFrontendBuildIdentity('v1.2.0', false)).toBe('local-unversioned')
  })
})
