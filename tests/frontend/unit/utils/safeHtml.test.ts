import { afterEach, describe, expect, it, vi } from 'vitest'
import { sanitizeMarkdownRuntimeHtml, sanitizePreviewHtml } from '@/utils/safeHtml'

describe('safeHtml sanitizers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('removes executable preview markup and unsafe urls', () => {
    const sanitized = sanitizePreviewHtml(`
      <h1 onclick="steal()">Title</h1>
      <p>safe</p>
      <svg onload="steal()"><script>steal()</script></svg>
      <iframe srcdoc="<script>steal()</script>"></iframe>
      <object data="javascript:steal()"></object>
      <a href="javascript:steal()">bad</a>
      <img src="x" onerror="steal()">
    `)

    expect(sanitized).not.toMatch(/<script|<svg|<iframe|<object/i)
    expect(sanitized).not.toMatch(/onerror|onclick|onload|srcdoc|javascript:/i)
    expect(sanitized).toContain('<h1>Title</h1>')
    expect(sanitized).toContain('<p>safe</p>')
  })

  it('keeps safe markdown html while applying the same second pass', () => {
    const sanitized = sanitizeMarkdownRuntimeHtml('<p><a href="https://example.com/docs">docs</a></p>')

    expect(sanitized).toContain('href="https://example.com/docs"')
    expect(sanitized).toContain('rel="noopener noreferrer"')
  })

  it('removes entity-encoded dangerous urls when document is unavailable', () => {
    vi.stubGlobal('document', undefined)

    const sanitized = sanitizeMarkdownRuntimeHtml('<p><a href="jav&#x61;script:alert(1)">bad</a></p>')

    expect(sanitized).not.toMatch(/href=/i)
    expect(sanitized).not.toMatch(/jav&#x61;script|javascript:/i)
    expect(sanitized).toContain('<a>bad</a>')
  })
})
