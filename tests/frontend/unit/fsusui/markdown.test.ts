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
    const envelope = {
      ok: false,
      error: {
        code: 'infra',
        category: 'runtime',
        message: 'markdown_wasm_runtime_unavailable'
      }
    } satisfies Parameters<typeof unwrapMarkdownRuntimeResult>[0]

    expect(() => unwrapMarkdownRuntimeResult(envelope)).toThrow('markdown_runtime_failed:infra')
  })

  it('preserves distinct public protocol failures instead of hardcoding infra', () => {
    const envelope = {
      ok: false,
      error: {
        code: 'protocol',
        category: 'runtime',
        message: 'protocol failure'
      }
    } satisfies Parameters<typeof unwrapMarkdownRuntimeResult>[0]

    expect(() => unwrapMarkdownRuntimeResult(envelope)).toThrow('markdown_runtime_failed:protocol')
  })
})
