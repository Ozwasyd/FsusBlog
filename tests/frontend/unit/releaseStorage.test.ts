import { describe, expect, it } from 'vitest'
import {
  normalizeFrontendBuildId,
  resolveReleaseSearchManifestUrl,
  resolveServiceWorkerScriptUrl
} from '../../../src/frontend/src/config/releaseStorage'

describe('release storage identity', () => {
  it('binds search and service worker URLs to one immutable frontend build', () => {
    const buildId = 'release-20260711-abcdef'

    expect(normalizeFrontendBuildId(buildId)).toBe(buildId)
    expect(resolveReleaseSearchManifestUrl('/', buildId))
      .toBe(`/release-derived/${buildId}/search/index.manifest.aeds`)
    expect(resolveServiceWorkerScriptUrl('/', buildId))
      .toBe(`/sw.js?build=${buildId}`)
  })

  it('rejects traversal or mutable aliases and preserves development URLs', () => {
    for (const invalid of ['../active', 'latest', 'bad/id', '']) {
      expect(normalizeFrontendBuildId(invalid)).toBeNull()
      expect(resolveReleaseSearchManifestUrl('/blog', invalid)).toBe('/blog/search/index.manifest.aeds')
      expect(resolveServiceWorkerScriptUrl('/blog', invalid)).toBe('/blog/sw.js')
    }
  })
})
