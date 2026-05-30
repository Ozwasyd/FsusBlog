import type { MarkdownRenderResult } from '@/services/markdownActivationService'
import type { FsusResult } from '@ozwasyd/element-plus/result'

export type MarkdownRenderMode = 'article' | 'about' | 'preview' | 'editor'

type FsusMarkdownRuntime = Readonly<{
  renderMarkdownResultWithRuntime: (request: {
    source: string
    mode: MarkdownRenderMode
    allowHtml: boolean
    allowLatex: boolean
    allowMermaid: boolean
    baseUrl: string | null
  }) => Promise<FsusResult<MarkdownRenderResult>>
}>

const unavailable = (message: string, cause?: unknown): FsusResult<MarkdownRenderResult> => ({
  ok: false,
  error: {
    code: 'infra',
    category: 'runtime',
    message,
    cause
  }
})

export async function renderMarkdownWithFsusRuntime(input: {
  source: string
  mode?: MarkdownRenderMode
  allowHtml?: boolean
  allowLatex?: boolean
  allowMermaid?: boolean
  baseUrl?: string | null
}): Promise<FsusResult<MarkdownRenderResult>> {
  try {
    const runtime = await import('@ozwasyd/element-plus/es/wasm/index.mjs') as FsusMarkdownRuntime
    return await runtime.renderMarkdownResultWithRuntime({
      source: input.source,
      mode: input.mode ?? 'article',
      allowHtml: input.allowHtml ?? false,
      allowLatex: input.allowLatex ?? true,
      allowMermaid: input.allowMermaid ?? true,
      baseUrl: input.baseUrl ?? null
    })
  } catch (error: unknown) {
    return unavailable('FsusUI markdown runtime is unavailable.', error)
  }
}
