import { describe, expect, it } from 'vitest'
import { PUBLIC_ROUTE_IDENTITY_TOKENS } from '@/public-renderers/generated/publicPageManifest'
import { ACCOUNT_ROUTE_PATHS, buildPublicFixedPath, PUBLIC_FIXED_PATHS, PUBLIC_ROUTE_PATH_PATTERNS, PUBLIC_ROUTE_PATHS } from '@/public-renderers/publicRoutePaths'

describe('publicRoutePaths shared path bridge', () => {
  it('derives router path patterns from shared page identity and route tokens', () => {
    expect(buildPublicFixedPath('Home')).toBe('/')
    expect(buildPublicFixedPath('About')).toBe('/about')
    expect(buildPublicFixedPath('Archive')).toBe('/archive')
    expect(buildPublicFixedPath('Privacy')).toBe('/privacy')
    expect(buildPublicFixedPath('Guidelines')).toBe('/guidelines')
    expect(buildPublicFixedPath('Copyright')).toBe('/copyright')
    expect(PUBLIC_FIXED_PATHS).toEqual({
      home: '/',
      archive: '/archive',
      about: '/about',
      privacy: '/privacy',
      guidelines: '/guidelines',
      copyright: '/copyright'
    })
    expect(PUBLIC_ROUTE_PATHS).toEqual({
      ...PUBLIC_FIXED_PATHS,
      search: PUBLIC_ROUTE_IDENTITY_TOKENS.searchPath
    })
    expect(ACCOUNT_ROUTE_PATHS).toEqual({
      profile: PUBLIC_ROUTE_IDENTITY_TOKENS.accountPath,
      profileChild: 'profile'
    })

    expect(PUBLIC_ROUTE_PATH_PATTERNS).toEqual({
      home: '',
      articleDetail: `${PUBLIC_ROUTE_IDENTITY_TOKENS.articlePathPrefix.slice(1)}:id`,
      archive: 'archive',
      about: 'about',
      privacy: 'privacy',
      guidelines: 'guidelines',
      copyright: 'copyright',
      category: `${PUBLIC_ROUTE_IDENTITY_TOKENS.categoryPathPrefix.slice(1)}:id(\\d+)`,
      tagById: `${PUBLIC_ROUTE_IDENTITY_TOKENS.tagPathPrefix.slice(1)}:id(\\d+)`,
      tag: `${PUBLIC_ROUTE_IDENTITY_TOKENS.tagPathPrefix.slice(1)}:id`,
      search: PUBLIC_ROUTE_IDENTITY_TOKENS.searchPath.slice(1)
    })
  })
})
