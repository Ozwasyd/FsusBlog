import { escapeMarkdownHtml, type MarkdownRenderRequest } from '@wasm/markdown'
import { renderMarkdownWithRuntime } from '@wasm/markdown-runtime'

self.onmessage = async (event: MessageEvent<{ id: number; source?: string; allowHtml?: boolean; allowLatex?: boolean; allowMermaid?: boolean }>) => {
  const { id, source, allowHtml, allowLatex, allowMermaid } = event.data

  try {
    const payload: MarkdownRenderRequest = {
      source: typeof source === 'string' ? source : '',
      allowHtml,
      allowLatex,
      allowMermaid
    }
    const wasmHtml = await renderMarkdownWithRuntime(payload)
    const html = wasmHtml ?? `<div class="markdown-renderer__error"><p>Markdown Wasm 运行时不可用，已回退为安全文本。</p><pre class="shiki"><code>${escapeMarkdownHtml(payload.source)}</code></pre></div>`
    self.postMessage({ id, html })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'markdown render failed'
    self.postMessage({ id, html: `<div class="markdown-renderer__error"><p>渲染调度失败: ${escapeMarkdownHtml(message)}</p></div>` })
  }
}
