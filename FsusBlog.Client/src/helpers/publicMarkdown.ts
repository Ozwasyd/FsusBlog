import { escapeMarkdownHtml, type MarkdownRenderRequest } from '@wasm/markdown';
import { renderMarkdownResultWithRuntime } from '@wasm/markdown-runtime';

function normalizeRequest(request: MarkdownRenderRequest | string): MarkdownRenderRequest {
  return typeof request === 'string' ? { source: request } : request;
}

export async function renderPublicMarkdownHtml(request: MarkdownRenderRequest | string): Promise<string> {
  const payload = normalizeRequest(request);
  const result = await renderMarkdownResultWithRuntime(payload);

  if (result?.html) {
    return result.html;
  }

  return `<div class="markdown-renderer__error"><p>Markdown Wasm 运行时不可用，已回退为安全文本。</p><pre class="shiki"><code>${escapeMarkdownHtml(payload.source)}</code></pre></div>`;
}
