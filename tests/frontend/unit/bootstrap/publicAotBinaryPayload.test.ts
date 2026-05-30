import { describe, expect, it } from 'vitest'
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'

describe('public AOT binary payload', () => {
  it('round-trips nested bootstrap payloads without JSON script text', () => {
    const payload = {
      kind: 'Home',
      path: '/',
      query: '',
      siteTitle: 'FsusBlog',
      total: 2,
      featured: true,
      articles: [
        {
          id: 1,
          title: 'AEDS',
          views: 42,
          tags: ['binary', 'aot']
        },
        {
          id: 2,
          title: 'Bootstrap',
          views: 7,
          tags: []
        }
      ]
    }

    const encoded = encodePublicAotPayload(payload)

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(decodePublicAotPayload<typeof payload>(encoded)).toEqual(payload)
  })

  it('rejects non-AEDS text', () => {
    expect(decodePublicAotPayload('{ "kind": "Home" }')).toBeNull()
  })
})
