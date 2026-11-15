import { ApiError, ProtocolError } from './aeds.ts'
import { consumeBounded, siteSessionHeader } from './client.ts'
import { documentOutputs } from './document-export-tasks.ts'
import { WireHeaders, WireLimits } from './wire.generated.ts'

const exportsByFormat = {
  md: { type: 'text/markdown', limit: WireLimits.BodyBytes + WireLimits.TitleBytes * 6 + 128 },
  ...documentOutputs,
} as const
export type ArticleExportFormat = keyof typeof exportsByFormat
export const maxDocumentExportImages = 4
type DocumentExportAttachment = Readonly<{ id: string; credential: string }>

export async function exportArticleRevision(format: ArticleExportFormat, article: number, revision: bigint, selected: bigint,
  signal: AbortSignal, attachment?: DocumentExportAttachment): Promise<Blob> {
  if (!Number.isInteger(article) || article <= 0 || article > 2_147_483_647 || selected <= 0n || selected > revision ||
      revision > 9_223_372_036_854_775_807n) throw new ProtocolError('Invalid document export coordinates')
  const query = new URLSearchParams({ revision: revision.toString(), sourceRevision: selected.toString() })
  const { type, limit } = exportsByFormat[format]
  const headers = new Headers(attachment ? siteSessionHeader(attachment.credential) : undefined)
  headers.set('Accept', type)
  if (attachment) {
    const ids = attachment.id.split(',')
    const limit = format === 'md' ? 0 : maxDocumentExportImages
    if (ids.length > limit || new Set(ids).size !== ids.length || ids.some(id =>
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) || id === '00000000-0000-0000-0000-000000000000'))
      throw new ProtocolError('Invalid document attachment selection')
    headers.set(WireHeaders.HtmlExportAttachment, attachment.id)
  }
  const response = await fetch(`/api/v2/authoring/draft/${article}/export.${format}?${query}`, {
    headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new ApiError('Document export failed', response.status)
  }
  if (response.headers.get('Content-Type')?.split(';')[0].trim() !== type || !response.body) {
    await response.body?.cancel()
    throw new ProtocolError('Expected a document attachment')
  }

  const chunks: Uint8Array<ArrayBuffer>[] = []
  const size = await consumeBounded(response.body, limit, 'Document export exceeds its byte limit', chunk => { chunks.push(chunk) })
  if (size === 0) throw new ProtocolError('Empty document attachment')
  return new Blob(chunks, { type })
}
