import { stable } from '../fact-extractors/lib/canonicalize.mjs'
import { decodePublicAotPayload } from '../../tests/frontend/support/aeds-envelope.mjs'
import { createObservedArticle } from './runtime-observation-cache-mutation.mjs'
import {
  baseUrl,
  digest,
  directAeds,
  eventually,
  fail,
  fixtureProjection,
  psqlJson,
  redis,
  sha,
  timeoutMs
} from './runtime-observation-probe-io.mjs'

export async function cacheProbe(context)
{
  if (!baseUrl) fail('cache probe requires FSUSBLOG_BASE_URL')
  const { categoryId, tagId } = fixtureProjection(context.fixture)
  const { articleId, create, marker, title } = await createObservedArticle(
    context,
    categoryId,
    tagId
  )
  const terminal = await eventually('cache/search/outbox convergence', async () => {
    const outbox = await psqlJson(`SELECT COALESCE(json_agg(observed ORDER BY id), '[]'::json) FROM
      (SELECT id, event_id, aggregate_id, schema_version, article_revision_id, revision_no,
       article_publication_id, publication_no, event_type, status, retry_count, processed_at, last_error
       FROM article_mutation_outbox WHERE aggregate_type = 'article' AND aggregate_id = ${articleId}) observed;`)
    const projection = await psqlJson(`SELECT row_to_json(observed) FROM
      (SELECT article_id, version, visible, etag, content_hash, unavailable_reason,
       updated_at_utc, projection_schema_version FROM public_article_projection WHERE article_id = ${articleId}) observed;`)
    const detail = await directAeds(`/api/binary/article/${articleId}.aeds`, {
      headers: { 'X-Fsus-Device-Fp': `cache-public-${context.identity.runId}` }
    })
    const releaseId = detail.headers['x-fsus-release-id']
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/u.test(String(releaseId ?? '')))
    {
      throw new Error('public detail response did not bind an immutable release id')
    }
    const searchPath = `/release-derived/${releaseId}/search/index.bin`
    const searchResponse = await fetch(`${baseUrl}${searchPath}`, { signal: AbortSignal.timeout(timeoutMs) })
    const searchBytes = new Uint8Array(await searchResponse.arrayBuffer())
    const navigationResponse = await fetch(`${baseUrl}/api/public/navigation-snapshot.aeds?path=${encodeURIComponent(`/article/${articleId}`)}`, {
      headers: { Accept: 'application/octet-stream', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    const navigationBytes = new Uint8Array(await navigationResponse.arrayBuffer())
    const envelope = decodePublicAotPayload(Buffer.from(navigationBytes).toString('base64url'))
    const bootstrap = decodePublicAotPayload(envelope.bootstrapPayload)
    const hydration = decodePublicAotPayload(envelope.hydrationPropsPayload)
    const generation = await redis(['GET', 'public-aot:invalidation-generation:v1'])
    const keys = (await redis(['--scan', '--pattern', `*${articleId}*`])).split('\n').filter(Boolean).sort()
    const processed = Array.isArray(outbox) && outbox.length > 0
      && outbox.every((item) => item.status === 'processed' && item.last_error == null)
    const searchContains = searchResponse.ok && Buffer.from(searchBytes).includes(Buffer.from(marker))
    const navigationText = JSON.stringify({ envelope, bootstrap, hydration })
    const navigationContains = navigationResponse.ok && navigationText.includes(marker)
    const detailMatches = detail.status === 200 && detail.payload?.title === title
    if (!processed || projection?.visible !== true || !projection.etag || !projection.content_hash
      || !detailMatches || !searchContains || !navigationContains || !generation)
    {
      throw new Error(`partial processed=${processed} projection=${projection?.visible} detail=${detailMatches} search=${searchContains} navigation=${navigationContains} generation=${Boolean(generation)}`)
    }
    return { outbox, projection, detail, searchBytes, searchPath, navigationBytes,
      envelope: { envelope, bootstrap, hydration }, generation, keys,
      searchContains, navigationContains, searchStatus: searchResponse.status,
      navigationStatus: navigationResponse.status, processed, detailMatches }
  })
  return stable({
    schema: 'fsusblog.cache-search-outbox-probe-facts.v1',
    authorityCoordinate: { articleIdDigest: sha(String(articleId)), mutationIdDigest: digest(create.payload),
      projectionVersion: terminal.projection.version },
    events: terminal.outbox.map((item) => ({ ...item, event_id: sha(item.event_id), aggregate_id: sha(String(item.aggregate_id)) })),
    edges: { eventTypes: terminal.outbox.map((item) => item.event_type).sort(), redisKeyDigests: terminal.keys.map(sha) },
    generation: { value: terminal.generation, valueDigest: sha(terminal.generation), present: Boolean(terminal.generation) },
    query: { searchIndexDigest: sha(terminal.searchBytes), releaseScopedPath: terminal.searchPath,
      releaseId: terminal.detail.headers['x-fsus-release-id'], containsMarker: terminal.searchContains,
      responseStatus: terminal.searchStatus, markerDigest: sha(marker) },
    readModel: { projectionDigest: digest(terminal.projection), detailDigest: terminal.detail.bodyDigest,
      detailTitleDigest: sha(terminal.detail.payload.title), visible: terminal.projection.visible,
      projection: terminal.projection, responseStatus: terminal.detail.status },
    output: { navigationDigest: sha(terminal.navigationBytes), envelopeDigest: digest(terminal.envelope),
      containsMarker: terminal.navigationContains, responseStatus: terminal.navigationStatus, markerDigest: sha(marker) },
    terminal: { state: terminal.processed && terminal.detailMatches && terminal.searchContains
      && terminal.navigationContains ? 'converged' : 'partial',
      processedEvents: terminal.outbox.filter((entry) => entry.status === 'processed').length,
      poisonEvents: terminal.outbox.filter((entry) => entry.last_error != null).length },
    coherent: terminal.processed && terminal.detailMatches && terminal.searchContains && terminal.navigationContains
  })
}
