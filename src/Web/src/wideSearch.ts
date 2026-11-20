import { ApiError, ProtocolError } from '../../Contracts/aeds.ts'
import {
  decodeCorpusDocuments, encodeLocalSearchResult, queryCorpusPage, scoreAdmittedCorpusPage, searchTerms,
  type PublicSearchSort,
} from '../../Contracts/local-search.ts'
import type { ArticleCard } from '../../Contracts/public-articles.ts'
import { withWideSearchStorage, type WideSearchStorage } from './wideSearchStorage.ts'
import {
  fetchWideSearchManifest, fetchWideSearchPage, verifyWideSearchGeneration, verifyWideSearchPageBytes,
  type WideSearchIdentity, type WideSearchManifest, type WideSearchPage,
} from './wideSearchWire.ts'

type Result = { frame: Uint8Array<ArrayBuffer>; identity: WideSearchIdentity | null }
type CachedCorpus = { manifest: WideSearchManifest; owner: string }
type CachedRanking = { corpus: CachedCorpus; terms: readonly number[]; sort: PublicSearchSort; positions: Uint32Array }

const attemptMs = 300_000
const rowsPerSlot = 256 // Each FSPK page contains at most 200 articles.

function sameIdentity(left: WideSearchIdentity, right: WideSearchIdentity) {
  return left.generation === right.generation && left.digest === right.digest && left.pageCount === right.pageCount
}

function parsePage(bytes: Uint8Array, page: WideSearchPage, terms: readonly number[]) {
  const shard = queryCorpusPage(bytes, terms)
  let last = 0
  for (const id of shard.documents.keys()) last = id
  if (shard.documents.size !== page.documentCount ||
      (shard.documents.keys().next().value ?? 0) !== page.firstArticleId || last !== page.lastArticleId) {
    throw new ProtocolError('Invalid wide search corpus article range')
  }
  return shard
}

function sortRanks(indices: Uint32Array, compare: (left: number, right: number) => number) {
  function sift(root: number, size: number) {
    const value = indices[root]
    for (let child = root * 2 + 1; child < size; child = root * 2 + 1) {
      if (child + 1 < size && compare(indices[child], indices[child + 1]) < 0) child++
      if (compare(value, indices[child]) >= 0) break
      indices[root] = indices[child]
      root = child
    }
    indices[root] = value
  }
  for (let root = Math.floor(indices.length / 2) - 1; root >= 0; root--) sift(root, indices.length)
  for (let last = indices.length - 1; last > 0; last--) {
    const value = indices[last]
    indices[last] = indices[0]
    indices[0] = value
    sift(0, last)
  }
}

type ReadPageBytes = (page: WideSearchPage) => Promise<Uint8Array<ArrayBuffer>>

async function rankPages(
  manifest: WideSearchManifest,
  terms: readonly number[],
  sort: PublicSearchSort,
  read: ReadPageBytes,
) {
  const positions = new Uint32Array(manifest.documentCount)
  const ids = new Uint32Array(manifest.documentCount)
  const times = new Float64Array(manifest.documentCount)
  const scores = new Float64Array(manifest.documentCount)
  let matches = 0
  for (const page of manifest.pages) {
    const bytes = await read(page)
    for (const hit of scoreAdmittedCorpusPage(bytes, terms)) {
      positions[matches] = (page.number - 1) * rowsPerSlot + hit.row
      ids[matches] = hit.id
      times[matches] = hit.publishedAt
      scores[matches++] = hit.score
    }
  }
  const order = Uint32Array.from({ length: matches }, (_, i) => i)
  sortRanks(order, sort === 'latest'
    ? (left, right) => times[right] - times[left] || scores[right] - scores[left] || ids[right] - ids[left]
    : (left, right) => scores[right] - scores[left] || times[right] - times[left] || ids[right] - ids[left])
  for (let i = 0; i < order.length; i++) order[i] = positions[order[i]]
  return order
}

async function readResults(manifest: WideSearchManifest, positions: Uint32Array, page: number, size: number, read: ReadPageBytes) {
  const start = (page - 1) * size
  const selected = positions.subarray(start, start + size)
  const items = new Array<ArticleCard>(selected.length)
  const needed = new Map<number, { row: number; result: number }[]>()
  for (const [result, position] of selected.entries()) {
    const ordinal = Math.floor(position / rowsPerSlot)
    const selection = needed.get(ordinal) ?? []
    selection.push({ row: position % rowsPerSlot, result })
    needed.set(ordinal, selection)
  }
  for (const [ordinal, selection] of needed) {
    const bytes = await read(manifest.pages[ordinal])
    const decoded = decodeCorpusDocuments(bytes, selection.map(entry => entry.row))
    for (let i = 0; i < selection.length; i++) items[selection[i].result] = decoded[i]
  }
  return encodeLocalSearchResult(items, positions.length)
}

export function createWideSearch() {
  let preferred = false
  let retained: CachedCorpus | undefined
  let ranking: CachedRanking | undefined

  async function forget(storage: WideSearchStorage, corpus: CachedCorpus) {
    if (retained?.owner === corpus.owner) retained = undefined
    if (ranking?.corpus.owner === corpus.owner) ranking = undefined
    await storage.discard(corpus.owner)
  }

  async function invalidate(identity: WideSearchIdentity) {
    const corpus = retained
    if (!corpus || !sameIdentity(corpus.manifest, identity)) return
    retained = undefined
    ranking = undefined
    await discardOwned(corpus)
  }

  function discardOwned(corpus: CachedCorpus) {
    return withWideSearchStorage(AbortSignal.timeout(5_000), storage => forget(storage, corpus))
  }

  async function search(
    query: string,
    page: number,
    size: number,
    request: AbortSignal,
    sort: PublicSearchSort = 'relevance',
  ): Promise<Result | undefined> {
    if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(size) || size < 1 || size > 100) {
      throw new ProtocolError('Invalid local search query page')
    }
    const terms = searchTerms(query)
    request.throwIfAborted()
    if (terms.length === 0) return { frame: encodeLocalSearchResult([], 0), identity: null }

    // Changing the query only cancels scoring and display. The active route owns admission.
    const deadline = Date.now() + attemptMs
    const attempt = AbortSignal.timeout(attemptMs)
    const scoring = AbortSignal.any([request, attempt])
    function check(signal: AbortSignal) {
      signal.throwIfAborted()
      if (Date.now() >= deadline) throw new DOMException('Wide search timed out', 'TimeoutError')
    }

    let manifest: WideSearchManifest
    try {
      manifest = await fetchWideSearchManifest(attempt)
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 503)) throw error
      preferred = false
      return undefined
    }
    preferred = true

    let abandoned: CachedCorpus | undefined
    async function discard(storage: WideSearchStorage, corpus: CachedCorpus) {
      try {
        await forget(storage, corpus)
      } catch {
        abandoned = corpus
      }
    }

    async function run(storage: WideSearchStorage) {
      check(attempt)
      const existing = await storage.select(manifest)
      // A different tab may have held the lock while the published generation changed.
      try {
        await verifyWideSearchGeneration(manifest, attempt)
      } catch (error) {
        if (existing !== undefined && (error instanceof ProtocolError || error instanceof ApiError &&
            (error.status === 409 || error.status === 404))) {
          await discard(storage, { manifest, owner: existing })
        }
        throw error
      }
      check(attempt)
      const corpus: CachedCorpus = { manifest, owner: existing ?? await storage.begin(manifest) }
      let sealed = existing !== undefined
      try {
        if (!sealed) {
          for (const part of manifest.pages) {
            check(attempt)
            const bytes = await fetchWideSearchPage(manifest, part, attempt)
            parsePage(bytes, part, [])
            check(attempt)
            await storage.append(corpus.owner, part.number, bytes)
          }
          await verifyWideSearchGeneration(manifest, attempt)
          check(attempt)
          await storage.seal(corpus.owner)
          sealed = true
        }
        retained = corpus
        check(scoring)
        const read: ReadPageBytes = async part => {
          check(scoring)
          const bytes = await storage.read(corpus.owner, part.number)
          await verifyWideSearchPageBytes(part, bytes, scoring)
          check(scoring)
          return bytes
        }
        const cached = ranking
        const current = cached && cached.corpus.owner === corpus.owner && sameIdentity(cached.corpus.manifest, manifest) &&
          cached.sort === sort && terms.length === cached.terms.length &&
          terms.every((hash, index) => hash === cached.terms[index])
          ? cached
          : { corpus, terms, sort, positions: await rankPages(manifest, terms, sort, read) }
        ranking = current
        const frame = await readResults(manifest, current.positions, page, size, read)
        check(scoring)
        const { generation, digest, pageCount } = manifest
        return { frame, identity: { generation, digest, pageCount } }
      } catch (error) {
        const interrupted = request.aborted && error === request.reason || attempt.aborted && error === attempt.reason ||
          error instanceof DOMException && error.name === 'TimeoutError'
        if (!sealed || !interrupted) {
          await discard(storage, corpus)
        }
        throw error
      }
    }

    try {
      return await withWideSearchStorage(attempt, run)
    } finally {
      if (abandoned) await discardOwned(abandoned).catch(() => {})
    }
  }

  return { search, invalidate, prefersWide: () => preferred }
}
