import { ProtocolError } from '../../Contracts/aeds.ts'
import { decodeArticleHot, type PopularArticle } from '../../Contracts/article-hot.ts'
import { request } from '../../Contracts/client.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../Contracts/wire.generated.ts'

const size = 10
const path = WireRoutes.PublicArticleHot.replace('{size}', String(size))

export async function loadPublicHotArticles(signal: AbortSignal): Promise<PopularArticle[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted()
    const result = await request(path, FrameType.ArticleHot, (payload, headers) => {
      const generation = headers.get(WireHeaders.SearchIndexGeneration)
      const tag = headers.get('ETag')
      if (generation === null || !/^(0|[1-9][0-9]{0,18})$/.test(generation) || BigInt(generation) > 0x7fff_ffff_ffff_ffffn ||
        tag === null || !/^"[\x21\x23-\x7e]+"$/.test(tag)) throw new ProtocolError('Invalid popular article generation or validator')
      const articles = decodeArticleHot(payload)
      if (articles.length > size) throw new ProtocolError('Too many popular articles')
      return { articles, generation, tag }
    }, signal, 'GET', undefined, { 'Cache-Control': 'no-cache' }, 'omit')

    const query = new URLSearchParams({ generation: result.generation })
    const proof = await fetch(`${path}?${query}`, {
      method: 'HEAD', credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
      headers: { Accept: 'application/octet-stream' },
    })
    signal.throwIfAborted()
    if (proof.status === 204 && proof.headers.get(WireHeaders.SearchIndexGeneration) === result.generation &&
      proof.headers.get('ETag') === result.tag) return result.articles
    if (proof.status !== 409 && proof.status !== 204) break
  }
  return []
}
