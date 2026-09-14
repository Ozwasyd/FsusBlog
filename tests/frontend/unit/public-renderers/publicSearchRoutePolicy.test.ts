import { describe, expect, it } from 'vitest'
import {
  normalizePublicSearchKeyword,
  normalizePublicSearchQuery
} from '@/public-renderers/publicSearchRoutePolicy'

describe('public search route policy', () => {
  it('normalizes Unicode and whitespace into one stable query', () => {
    expect(normalizePublicSearchKeyword('  Cafe\u0301\t  搜索  ')).toBe('Café 搜索')
    expect(normalizePublicSearchQuery({
      page: '02',
      q: '  Cafe\u0301\t  搜索  ',
      sort: 'HOT',
      ignored: 'value'
    })).toEqual({
      query: { q: 'Café 搜索', sort: 'hot', page: '2' },
      shouldRedirect: true,
      invalidKeyword: false
    })
  })

  it('removes empty, default, duplicate, and invalid parameters', () => {
    expect(normalizePublicSearchQuery({ q: '', sort: 'hot', page: '4' })).toEqual({
      query: {},
      shouldRedirect: true,
      invalidKeyword: false
    })
    expect(normalizePublicSearchQuery({ q: ['test', 'ignored'], sort: 'unknown', page: '101' })).toEqual({
      query: { q: 'test' },
      shouldRedirect: true,
      invalidKeyword: false
    })
    expect(normalizePublicSearchQuery({ q: 'test', sort: 'relevance', page: '1' }).query).toEqual({ q: 'test' })
  })

  it('fails closed when the keyword exceeds the shared bound or contains controls', () => {
    expect(normalizePublicSearchQuery({ q: 'x'.repeat(129) })).toMatchObject({
      query: {},
      shouldRedirect: true,
      invalidKeyword: true
    })
    expect(normalizePublicSearchKeyword('test\u0000value')).toBeNull()
  })

  it('accepts the canonical query without a redirect', () => {
    expect(normalizePublicSearchQuery({
      q: 'test',
      sort: 'latest',
      page: '100',
      cursor: 'opaque_cursor'
    })).toEqual({
      query: { q: 'test', sort: 'latest', page: '100', cursor: 'opaque_cursor' },
      shouldRedirect: false,
      invalidKeyword: false
    })
  })

  it('preserves invalid pagination shape for fail-closed handling instead of redirect recovery', () => {
    expect(normalizePublicSearchQuery({ q: 'test', page: '2' })).toEqual({
      query: { q: 'test', page: '2' },
      shouldRedirect: false,
      invalidKeyword: false
    })
    expect(normalizePublicSearchQuery({ q: 'test', page: '2', cursor: 'bad cursor' })).toEqual({
      query: { q: 'test', page: '2', cursor: 'bad cursor' },
      shouldRedirect: false,
      invalidKeyword: false
    })
  })
})
