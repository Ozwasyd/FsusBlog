import {
  renderMarkdownResultWithRuntime,
  type MarkdownRenderResult as FsusMarkdownRenderResult
} from '@ozwasyd/element-plus/markdown-runtime'
import type { FsusUiResult } from '@/fsusui/result'

export type MarkdownRenderMode = 'article' | 'about' | 'preview' | 'editor'
export type MarkdownRenderResult = FsusMarkdownRenderResult

const unavailable = (message: string, cause?: unknown): FsusUiResult<MarkdownRenderResult> => ({
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
}): Promise<FsusUiResult<MarkdownRenderResult>> {
  try {
    return await renderMarkdownResultWithRuntime({
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

export {
  MARKDOWN_RENDERER_SURFACE_CLASSES,
  MARKDOWN_RENDERER_VERSION,
  MarkdownRuntimeError,
  activateMarkdownFeatures,
  buildMarkdownRenderResult,
  detectMarkdownFeatures,
  detectMarkdownPlaceholders,
  escapeMarkdownHtml,
  initMarkdownRuntime,
  normalizeMarkdownSource,
  renderMarkdownChunksWithRuntime,
  renderMarkdownHtmlWithRuntime,
  renderMarkdownResultWithRuntime,
  renderMarkdownSummaryWithRuntime,
  renderMarkdownWithRuntime
} from '@ozwasyd/element-plus/markdown-runtime'
export type {
  MarkdownFeatureActivationError,
  MarkdownFeatureActivationFeatureOptions,
  MarkdownFeatureActivationItem,
  MarkdownFeatureActivationKind,
  MarkdownFeatureActivationOptions,
  MarkdownFeatureActivationResult,
  MarkdownFeatureAdapter,
  MarkdownPlaceholderKind,
  MarkdownRenderChunk,
  MarkdownRenderChunkKind,
  MarkdownRenderFeature,
  MarkdownRenderMetadata,
  MarkdownRenderPlaceholder,
  MarkdownRenderRequest,
  MarkdownRenderTimings,
  MarkdownRendererSurfaceContract,
  MarkdownRuntimeChunkResult,
  MarkdownRuntimeErrorCode,
  MarkdownRuntimeHtmlResult,
  MarkdownRuntimeKind,
  MarkdownRuntimeProfile,
  MarkdownRuntimeProfilePhase,
  MarkdownRuntimeRenderResult,
  MarkdownRuntimeSummaryResult
} from '@ozwasyd/element-plus/markdown-runtime'
