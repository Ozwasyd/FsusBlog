import { ApiError, ProtocolError } from './aeds.ts'
import { WireLimits } from './wire.generated.ts'

const exportsByFormat = {
  md: { type: 'text/markdown', maxBytes: WireLimits.BodyBytes + WireLimits.TitleBytes * 6 + 128 },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', maxBytes: 2 * 1024 * 1024 },
  html: { type: 'text/html', maxBytes: 2 * 1024 * 1024 },
  epub: { type: 'application/epub+zip', maxBytes: 2 * 1024 * 1024 },
} as const
export type ArticleExportFormat = keyof typeof exportsByFormat

export async function exportArticleRevision(format: ArticleExportFormat, article: number, revision: bigint, selected: bigint,
  signal: AbortSignal): Promise<Blob> {
  if (!Number.isInteger(article) || article <= 0 || article > 2_147_483_647 || selected <= 0n || selected > revision ||
      revision > 9_223_372_036_854_775_807n) throw new ProtocolError('Invalid document export coordinates')
  const query = new URLSearchParams({ revision: revision.toString(), sourceRevision: selected.toString() })
  const { type, maxBytes } = exportsByFormat[format]
  const response = await fetch(`/api/v2/authoring/draft/${article}/export.${format}?${query}`, {
    headers: { Accept: type }, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new ApiError('Document export failed', response.status)
  }
  if (response.headers.get('Content-Type')?.split(';')[0].trim() !== type || !response.body) {
    await response.body?.cancel()
    throw new ProtocolError('Expected a document attachment')
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
        throw new ProtocolError('Document export exceeds its byte limit')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (size === 0) throw new ProtocolError('Empty document attachment')
  return new Blob(chunks, { type })
}
