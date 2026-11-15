import { decodeUtf8, ProtocolError } from './binary.ts'
import { WireLayouts as layout, WireLimits } from './wire.generated.ts'

export type PopularArticle = { id: number; views: number; title: string }

const encoder = new TextEncoder()
const maximumInt32 = 0x7fff_ffff

function check(condition: boolean, field: string): asserts condition {
  if (!condition) throw new ProtocolError(`Invalid popular article ${field}`)
}

function validateItem(id: number, views: number, ids: Set<number>) {
  check(Number.isInteger(id) && id > 0 && id <= maximumInt32 && !ids.has(id), 'identity')
  check(Number.isInteger(views) && views >= 0 && views <= maximumInt32, 'views')
  ids.add(id)
}

export function encodeArticleHot(articles: readonly PopularArticle[]): Uint8Array {
  check(articles.length <= WireLimits.PublicArticleHotMaxSize, 'count')
  const ids = new Set<number>()
  const titles = articles.map(item => {
    validateItem(item.id, item.views, ids)
    check(item.title.length <= WireLimits.TitleBytes, 'title length')
    const title = encoder.encode(item.title)
    check(title.length <= WireLimits.TitleBytes && decodeUtf8(title) === item.title, 'title')
    return title
  })
  const blobSize = titles.reduce((sum, title) => sum + title.length, 0)
  const recordsAt = layout.ArticleHotHeaderSize + blobSize
  const payload = new Uint8Array(recordsAt + articles.length * layout.ArticleHotRecordSize)
  const view = new DataView(payload.buffer)
  view.setInt32(0, articles.length, true)
  view.setInt32(4, blobSize, true)

  let offset = 0
  for (let index = 0; index < articles.length; index++) {
    const item = articles[index]
    const title = titles[index]
    const record = recordsAt + index * layout.ArticleHotRecordSize
    view.setInt32(record, item.id, true)
    view.setInt32(record + layout.ArticleHotViewsOffset, item.views, true)
    view.setInt32(record + layout.ArticleHotTitleOffset, offset, true)
    view.setInt32(record + layout.ArticleHotTitleOffset + 4, title.length, true)
    payload.set(title, layout.ArticleHotHeaderSize + offset)
    offset += title.length
  }
  return payload
}

export function decodeArticleHot(payload: Uint8Array): PopularArticle[] {
  check(payload.length >= layout.ArticleHotHeaderSize, 'header')
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const int = (offset: number) => view.getInt32(offset, true)
  const count = int(0)
  const blobSize = int(4)
  const recordsAt = layout.ArticleHotHeaderSize + blobSize
  check(count >= 0 && count <= WireLimits.PublicArticleHotMaxSize && blobSize >= 0 && blobSize <= count * WireLimits.TitleBytes &&
    payload.length === recordsAt + count * layout.ArticleHotRecordSize, 'payload size')

  const ids = new Set<number>()
  const articles: PopularArticle[] = []
  let consumed = 0
  for (let index = 0; index < count; index++) {
    const record = recordsAt + index * layout.ArticleHotRecordSize
    const id = int(record)
    const views = int(record + layout.ArticleHotViewsOffset)
    const offset = int(record + layout.ArticleHotTitleOffset)
    const length = int(record + layout.ArticleHotTitleOffset + 4)
    validateItem(id, views, ids)
    check(offset === consumed && length >= 0 && length <= WireLimits.TitleBytes && length <= blobSize - consumed, 'title range')
    const start = layout.ArticleHotHeaderSize + offset
    articles.push({ id, views, title: decodeUtf8(payload.subarray(start, start + length)) })
    consumed += length
  }
  check(consumed === blobSize, 'unused title bytes')
  return articles
}
