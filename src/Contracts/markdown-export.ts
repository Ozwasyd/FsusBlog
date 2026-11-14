import { ApiError, ProtocolError } from './aeds.ts'
import { WireLimits } from './wire.generated.ts'

const markdown = 'text/markdown'
const maxBytes = WireLimits.BodyBytes + WireLimits.TitleBytes * 6 + 128
export const markdownDownloadName = 'article.md'

export async function exportMarkdown(article: number, revision: bigint, selected: bigint, signal: AbortSignal): Promise<Blob> {
  if (!Number.isInteger(article) || article <= 0 || article > 2_147_483_647 || selected <= 0n || selected > revision ||
      revision > 9_223_372_036_854_775_807n) throw new ProtocolError('Invalid Markdown export coordinates')
  const query = new URLSearchParams({ revision: revision.toString(), sourceRevision: selected.toString() })
  const response = await fetch(`/api/v2/authoring/draft/${article}/export.md?${query}`, {
    headers: { Accept: markdown }, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new ApiError('Markdown export failed', response.status)
  }
  if (response.headers.get('Content-Type')?.split(';')[0].trim() !== markdown || !response.body) {
    await response.body?.cancel()
    throw new ProtocolError('Expected a Markdown attachment')
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > maxBytes) {
        await reader.cancel()
        throw new ProtocolError('Markdown export exceeds its byte limit')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (size === 0) throw new ProtocolError('Empty Markdown attachment')
  return new Blob(chunks, { type: markdown })
}
