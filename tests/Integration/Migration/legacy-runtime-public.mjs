import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { decodeApiError, decodeFrame, encodeFrame } from '../../../src/Contracts/aeds.ts'
import { decodeArticle, decodeSearch } from '../../../src/Contracts/public-articles.ts'
import { decodeTaxonomyMetadata } from '../../../src/Contracts/taxonomy.ts'
import { encodeSignIn, FrameType, WireHeaders, WireLayouts, WireRoutes } from '../../../src/Contracts/wire.generated.ts'

const inputs = process.argv.slice(2)
assert.equal(inputs.length, 10,
  'Usage: node legacy-runtime-public.mjs BASE_URL ARTICLE_ID REVISION PUBLICATION_ID RIGHTS_ID CATEGORY_ID "TAG_NAME" "ALIAS" "TITLE" "BODY"')
const [url, articleInput, revisionInput, publicationInput, rightsInput, categoryInput, tagName, alias, title, body] = inputs
const base = new URL(url)
assert(['http:', 'https:'].includes(base.protocol) && ['127.0.0.1', '[::1]'].includes(base.hostname) &&
  base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash,
  'The migration read probe requires a literal loopback origin.')
assert(tagName && alias && title && body.trim(), 'Supply nonempty fixture taxonomy, title and body.')
assert(!/^[0-9]+$|[/\\]/u.test(alias) && !['.', '..', tagName].includes(alias),
  'Supply a distinct, path-safe legacy tag alias.')

const id = Number(positive(articleInput, 2147483647n))
const expectedRevision = positive(revisionInput, 2147483647n)
const expectedPublication = positive(publicationInput)
const expectedRights = positive(rightsInput)
const categoryId = Number(positive(categoryInput, 2147483647n))
const missingId = id === 1 ? 2 : 1
const evidence = {}
const binary = 'application/octet-stream'
let generation

function positive(value, max = 9223372036854775807n) {
  assert(/^[1-9][0-9]{0,18}$/.test(value), 'Expected a positive decimal database coordinate.')
  const number = BigInt(value)
  assert(number <= max, 'Database coordinate is out of range.')
  return number
}

function pathFor(route, article = id, publication = expectedPublication) {
  return route.replace(/\{id(?::int)?\}/, String(article)).replace('{publication:long}', String(publication))
}

async function send(path, expected, options) {
  const reply = await fetch(new URL(path, base), {
    redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(10_000), ...options,
  })
  assert.equal(reply.status, expected, `${options?.method ?? 'GET'} ${path}`)
  assert.equal(reply.headers.get('set-cookie'), null, `Unexpected session at ${path}`)
  return reply
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function checkGeneration(reply, path) {
  const current = reply.headers.get(WireHeaders.SearchIndexGeneration)
  assert.match(current ?? '', /^(0|[1-9][0-9]{0,18})$/, `Missing public generation at ${path}`)
  generation ??= current
  assert.equal(current, generation, `Unexpected public generation at ${path}`)
}

async function read(label, path, mediaType) {
  const reply = await send(path, 200)
  checkGeneration(reply, path)
  assert.equal(reply.headers.get('content-type')?.split(';')[0], mediaType, path)
  const bytes = Buffer.from(await reply.arrayBuffer())
  evidence[label] = hash(bytes)
  return { reply, bytes }
}

async function frame(label, path, type) {
  const { bytes } = await read(label, path, binary)
  return decodeFrame(bytes, type).payload
}

function checkArticle(article) {
  assert(article, 'Expected the retained article in the public projection.')
  assert.deepEqual([article.id, article.revision, article.publication, article.revisionNo, article.publicationNo],
    [id, expectedRevision, expectedPublication, Number(expectedRevision), 1])
  assert.equal(article.title, title)
  assert.equal(article.category.id, categoryId)
  assert(article.tags.some(tag => tag.name === tagName), 'Expected the retained public taxonomy assignment.')
}

function plainHtmlText(fragment) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return fragment.replace(/&#(x[0-9a-f]+|[0-9]+);|&(amp|lt|gt|quot|apos);/gi, (_, numeric, entity) => {
    if (!numeric) return entities[entity.toLowerCase()]
    const hex = numeric[0].toLowerCase() === 'x'
    return String.fromCodePoint(Number.parseInt(hex ? numeric.slice(1) : numeric, hex ? 16 : 10))
  })
}

async function reject(label, path, status, options) {
  const reply = await send(path, status, options)
  if (path.startsWith('/api/')) {
    assert.equal(reply.headers.get('content-type')?.split(';')[0], binary, path)
    const error = decodeFrame(new Uint8Array(await reply.arrayBuffer()), FrameType.ApiError)
    assert.equal(decodeApiError(error.payload, status).status, status, path)
  } else {
    await reply.body?.cancel()
  }
  evidence[label] = status
}

await send('/health/ready', 204)
const detailPath = pathFor(WireRoutes.PublicArticle)
const detail = await read('detail', detailPath, binary)
const article = decodeArticle(decodeFrame(detail.bytes, FrameType.ArticleDetail).payload)
checkArticle(article)
assert.equal(article.body, body)
assert.equal(article.coverImageUrl, '', 'The fixture must have no cover image.')
assert.equal(detail.reply.headers.get(WireHeaders.PublicArticleMediaPresent), null)
assert.equal(article.rights?.snapshotId, expectedRights)
assert.equal(article.rights.enabled, true, 'The retained rights must be visible and enabled.')
assert.equal(article.rights.proofBindingEnabled, false, 'The fixture must not request a native proof.')

const { bytes: htmlBytes } = await read('html', `/article/${id}`, 'text/html')
const html = htmlBytes.toString('utf8').match(/<article>([\s\S]*?)<\/article>/)?.[1] ?? ''
assert.equal(plainHtmlText(html.match(/<h1>([^<]*)<\/h1>/)?.[1] ?? ''), title)
assert.equal(plainHtmlText(html.match(/<p>([^<]*)<\/p>/)?.[1] ?? ''), body.trim())
const badge = html.match(/<aside aria-label="Article rights"><p>([^<]*)<\/p>/)
assert.equal(badge !== null, article.rights.showPublicBadge)
if (badge) assert.equal(plainHtmlText(badge[1]), article.rights.licenseType)
assert(!html.includes('data-fsus-public-article-media'), 'Public HTML must not expose a media section.')

const category = decodeTaxonomyMetadata(await frame('category', pathFor(WireRoutes.CategoryMetadata, categoryId),
  FrameType.TaxonomyExactMetadata))
assert.deepEqual({ id: category.id, name: category.name }, article.category)
const tag = article.tags.find(candidate => candidate.name === tagName)
const tagAlias = decodeTaxonomyMetadata(await frame('tagAlias',
  `${WireRoutes.TagMetadataByName}?${new URLSearchParams({ name: alias })}`, FrameType.TaxonomyExactMetadata))
assert.deepEqual({ id: tagAlias.id, name: tagAlias.name }, tag)
const aliasPath = `/tag/${encodeURIComponent(alias)}`
const redirected = await send(aliasPath, 301)
checkGeneration(redirected, aliasPath)
assert.equal(redirected.headers.get('location'), `/tag/${tag.id}`)
evidence.aliasRedirect = redirected.headers.get('location')
await redirected.body?.cancel()

const query = `${WireRoutes.PublicSearch}?${new URLSearchParams({ q: title })}`
const search = decodeSearch(await frame('search', query, FrameType.ArticleSearch))
checkArticle(search.articles.find(candidate => candidate.id === id))
const page = `${WireRoutes.PublicIndex}?${new URLSearchParams({ page: '1', generation })}`
const index = decodeSearch(await frame('index', page, FrameType.ArticleSearch))
checkArticle(index.articles.find(candidate => candidate.id === id))
const corpusPath = `${WireRoutes.PublicSearchCorpus}?${new URLSearchParams({ page: '1', generation })}`
const corpus = await read('corpus', corpusPath, binary)
assert.equal(corpus.reply.headers.get(WireHeaders.SearchIndexPages), '1')
assert(corpus.bytes.length > 8, 'Expected a public search corpus page.')
assert.equal(corpus.bytes.readUInt32LE(0), WireLayouts.SearchPackageMagic)
assert.equal(corpus.bytes.readUInt32LE(4), WireLayouts.SearchArtifactVersion)

await reject('missingHtml', `/article/${missingId}`, 404)
await reject('missingDetail', pathFor(WireRoutes.PublicArticle, missingId), 404)
await reject('anonymousDraft', pathFor(WireRoutes.Draft), 401)
await reject('media', pathFor(WireRoutes.PublicArticleMedia), 404)
await reject('proof', `/integrity/v2/article/${id}/${expectedPublication}/rights.json`, 404)
const legacyShapedTicket = Buffer.alloc(32, 0x26).toString('base64url')
await reject('legacySignIn', WireRoutes.SignIn, 401, {
  method: 'POST',
  headers: { 'Content-Type': binary, Origin: base.origin, 'Sec-Fetch-Site': 'same-origin' },
  body: encodeFrame(FrameType.OperatorSignIn, encodeSignIn({ ticket: legacyShapedTicket })),
})

console.log(hash(JSON.stringify({ generation, ...evidence })))
