import { describe, expect, it } from 'vitest'
import type { MarkdownSafeRenderResult } from '@ozwasyd/element-plus/markdown-runtime'
import { unwrapMarkdownRuntimeResult } from '@/fsusui/markdown'

describe('FsusUI Markdown runtime consumer boundary', () => {
  it('returns the exact FsusUI safe result object without repackaging it', () => {
    const safeResult = Object.freeze({
      html: '<p>safe</p>',
      normalizedSource: 'safe',
      sourceIdentity: 'markdown:test:safe',
      rendererVersion: 'test',
      features: Object.freeze([]),
      placeholders: Object.freeze([])
    }) as unknown as MarkdownSafeRenderResult
    const envelope = Object.freeze({ ok: true, value: safeResult })

    const required = unwrapMarkdownRuntimeResult(envelope)

    expect(required).toBe(safeResult)
  })

  it('keeps runtime failure explicit instead of producing fallback HTML', () => {
    expect(() => unwrapMarkdownRuntimeResult({
      ok: false,
      error: {
        code: 'runtime_unavailable',
        category: 'runtime',
        message: 'unavailable'
      }
    })).toThrow('markdown_runtime_failed:runtime_unavailable')
  })
})
