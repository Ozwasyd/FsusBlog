import { renderMarkdownInWorker, retainMarkdownWorker } from '@/services/markdownWorkerService'
import { AppErrorCode, createAppError } from '@/utils/appError'
import {
  escapeMarkdownHtml,
  MARKDOWN_RENDERER_SURFACE_CLASSES,
  buildMarkdownRenderResult,
  normalizeMarkdownSource,
  type MarkdownRenderRequest,
  type MarkdownRenderResult
} from '@wasm/markdown'
import { MARKDOWN_RENDERER_VERSION, renderMarkdownResultWithRuntime } from '@wasm/markdown-runtime'
import { trustRendererHtml, type TrustedHtml } from '@/utils/trustedHtml'

export type { MarkdownRenderRequest, MarkdownRenderResult } from '@wasm/markdown'
export type TrustedMarkdownRenderResult = Omit<MarkdownRenderResult, 'html'> & { html: TrustedHtml }

export { retainMarkdownWorker }

export async function renderMarkdownDocument(request: MarkdownRenderRequest | string): Promise<TrustedMarkdownRenderResult> {
  const payload = typeof request === 'string' ? { source: request } : request
  const source = normalizeMarkdownSource(payload.source)
  const canUseWorker = typeof window !== 'undefined' && typeof document !== 'undefined' && typeof Worker !== 'undefined'

  try {
    if (canUseWorker) {
      const html = await renderMarkdownInWorker(payload)
      return buildMarkdownRenderResult({
        html: trustRendererHtml(html),
        source,
        rendererVersion: MARKDOWN_RENDERER_VERSION
      }) as TrustedMarkdownRenderResult
    }

    const result = await renderMarkdownResultWithRuntime(payload)
    if (result) {
      return {
        ...result,
        html: trustRendererHtml(result.html)
      }
    }

    throw createAppError(AppErrorCode.InfraFailure, 'markdown_wasm_runtime_unavailable')
  } catch (error) {
    console.error('[MarkdownRenderHost] render failed:', error)
    return buildMarkdownRenderResult({
      html: trustRendererHtml([
        `<div class="${MARKDOWN_RENDERER_SURFACE_CLASSES.root} ${MARKDOWN_RENDERER_SURFACE_CLASSES.error}">`,
        '<p>Markdown Wasm 渲染失败，已回退为安全文本。</p>',
        `<pre class="shiki"><code>${escapeMarkdownHtml(source)}</code></pre>`,
        '</div>'
      ].join('')),
      source,
      rendererVersion: MARKDOWN_RENDERER_VERSION
    }) as TrustedMarkdownRenderResult
  }
}
