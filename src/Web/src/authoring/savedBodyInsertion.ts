import {
  createMarkdownAnchorMap, createMarkdownSourceCoordinateMap, MarkdownRuntimeError,
} from '@ozwasyd/element-plus/markdown-runtime'
import type { MarkdownEditorTransactionEvent } from '@ozwasyd/element-plus'
import { readBodyInsertion, readBodyInsertionChain, type BodyInsertion } from '../../../Contracts/article-body-insertion'
import { ApiError, ProtocolError } from '../../../Contracts/client'
import { WireLimits } from '../../../Contracts/wire.generated'
import type { SearchEditorTarget } from './canvasEditorHandoff'
import { restoreCrlf, validBoundary, verifySourceMatch } from './sourceCoordinates'

const utf8 = new TextEncoder()

function uniqueInsertion(source: string, body: string, { offset, length }: BodyInsertion): boolean {
  return Number.isSafeInteger(length) && length > 0 && length === body.length - source.length &&
    validBoundary(source, offset) && validBoundary(body, offset) && validBoundary(body, offset + length) &&
    body.slice(0, offset) === source.slice(0, offset) && body.slice(offset + length) === source.slice(offset) &&
    (offset === 0 || source[offset - 1] !== body[offset + length - 1]) &&
    (offset === source.length || source[offset] !== body[offset])
}

export function captureBodyInsertions(source: string, model: string, crlf: boolean,
  event: MarkdownEditorTransactionEvent): readonly BodyInsertion[] | undefined {
  const { changes, origin } = event.transaction
  const positionMap = event.positionMap
  if (!event.accepted || origin !== 'command' || !positionMap || !changes.length ||
    changes.length > WireLimits.ArticleBodyInsertionOperations || event.revision !== event.beforeRevision + 1) return

  const coordinates = source === model ? undefined : createMarkdownSourceCoordinateMap(source)
  if (coordinates && (!crlf || coordinates.normalizedSource !== model)) return
  const insertions: BodyInsertion[] = []
  let body = source
  let editedModel = model
  let previousOffset = -1
  let modelDelta = 0
  for (const change of changes) {
    const position = change.from + modelDelta
    if (change.from !== change.to || !change.insert || change.from <= previousOffset ||
      !validBoundary(model, change.from) || positionMap.map(change.from, -1) !== position ||
      positionMap.map(change.from, 1) !== position + change.insert.length) return

    const beforeInsertions = coordinates?.toRawOffset(change.from, { affinity: 'backward' }) ?? change.from
    const offset = beforeInsertions + body.length - source.length
    const text = crlf ? restoreCrlf(change.insert) : change.insert
    const next = body.slice(0, offset) + text + body.slice(offset)
    const insertion = { offset, length: text.length }
    if (!uniqueInsertion(body, next, insertion)) return
    insertions.push(insertion)
    body = next
    editedModel = editedModel.slice(0, position) + change.insert + editedModel.slice(position)
    previousOffset = change.from
    modelDelta += change.insert.length
  }
  if (editedModel === event.value && body === (crlf ? restoreCrlf(event.value) : event.value)) return insertions
}

function digestHex(digest: Uint8Array): string {
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function canRebaseSavedBodyRevision(sourceRevision: bigint, revision: bigint): boolean {
  return sourceRevision > 0n && revision > sourceRevision &&
    revision - sourceRevision <= BigInt(WireLimits.ArticleBodyInsertionChainEdges)
}

async function readMap(previous: SearchEditorTarget, revision: bigint, credential: string, signal: AbortSignal) {
  if (revision === previous.revision + 1n) {
    const single = await readBodyInsertion(previous.articleId, revision, previous.revision, credential, signal)
      .catch(error => {
        if (error instanceof ApiError && error.status === 404) return
        throw error
      })
    if (single?.available) return { ...single, edges: [{
      sourceDigest: single.sourceDigest, digest: single.digest, insertions: [{ offset: single.offset, length: single.length }],
    }] }
  }
  return readBodyInsertionChain(previous.articleId, revision, previous.revision, credential, signal)
}

async function bodyDigest(body: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(body)))
  signal.throwIfAborted()
  return digest
}

async function verifyMap(map: Awaited<ReturnType<typeof readMap>>, signal: AbortSignal) {
  const steps: { source: string; body: string; insertion: BodyInsertion }[] = []
  let body = map.body
  const finalDigest = await bodyDigest(body, signal)
  let digest = digestHex(finalDigest)
  // Recover exact intermediate bodies from the final immutable body and the recorded insertions.
  for (const edge of map.edges.slice().reverse()) {
    if (edge.digest !== digest || edge.insertions.length > WireLimits.ArticleBodyInsertionOperations) return
    for (const insertion of edge.insertions.slice().reverse()) {
      const { offset, length } = insertion
      if (!Number.isSafeInteger(length) || length <= 0 || !validBoundary(body, offset) ||
        !validBoundary(body, offset + length)) return
      const source = body.slice(0, offset) + body.slice(offset + length)
      if (!uniqueInsertion(source, body, insertion)) return
      steps.push({ source, body, insertion })
      body = source
    }
    if (edge.insertions.length) digest = digestHex(await bodyDigest(body, signal))
    if (edge.sourceDigest !== digest) return
  }
  if (body === map.sourceBody) return { steps: steps.reverse(), digest: finalDigest }
}

export async function rebaseSavedBodyHit(previous: SearchEditorTarget, revision: bigint, credential: string,
  signal: AbortSignal): Promise<SearchEditorTarget | undefined> {
  if (previous.field !== 'body' || !canRebaseSavedBodyRevision(previous.revision, revision)) return
  try {
    const map = await readMap(previous, revision, credential, signal)
    if (!map.available || BigInt(map.edges.length) !== revision - previous.revision ||
      digestHex(previous.sourceDigest) !== map.edges[0]?.sourceDigest || !await verifySourceMatch(map.sourceBody, previous)) return
    const verified = await verifyMap(map, signal)
    if (!verified) return

    let range = { start: previous.sourceStart, end: previous.sourceEnd }
    for (const { source, body, insertion } of verified.steps) {
      signal.throwIfAborted()
      const anchor = createMarkdownAnchorMap({
        source, identity: { id: `blog-saved-body-${previous.articleId}`, epoch: 0 }, syntax: [],
      })
      const mapped = anchor.remapRange(range, { insert: { at: insertion.offset, length: insertion.length } })
      if (mapped.status !== 'mapped') return
      range = mapped.range
      if (!validBoundary(body, range.start) || !validBoundary(body, range.end) ||
        body.slice(range.start, range.end) !== previous.match) return
    }
    const { start, end } = range
    const sourceByteStart = utf8.encode(map.body.slice(0, start)).length
    return { ...previous, revision, precision: 'rebased', sourceStart: start, sourceEnd: end,
      sourceByteStart, sourceByteEnd: sourceByteStart + utf8.encode(previous.match).length, sourceDigest: verified.digest }
  } catch (error) {
    if (error instanceof ProtocolError || error instanceof MarkdownRuntimeError ||
      error instanceof ApiError && (error.status === 400 || error.status === 404)) return
    throw error
  }
}
