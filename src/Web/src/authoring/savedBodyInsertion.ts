import {
  createMarkdownAnchorMap, createMarkdownSourceCoordinateMap, MarkdownRuntimeError,
} from '@ozwasyd/element-plus/markdown-runtime'
import type { MarkdownEditorTransactionEvent } from '@ozwasyd/element-plus'
import {
  readBodyEditChain, readBodyInsertion, readBodyInsertionChain, type BodyEdit,
} from '../../../Contracts/article-body-insertion'
import { ApiError, ProtocolError } from '../../../Contracts/client'
import { WireLimits } from '../../../Contracts/wire.generated'
import type { SearchEditorTarget } from './canvasEditorHandoff'
import { restoreCrlf, validBoundary, verifySourceMatch } from './sourceCoordinates'

const utf8 = new TextEncoder()

function uniqueEdit(source: string, body: string, offset: number, removed: number, added: number): boolean {
  const end = offset + removed
  const newEnd = offset + added
  return validBoundary(source, offset) && validBoundary(source, end) &&
    validBoundary(body, offset) && validBoundary(body, newEnd) &&
    source.slice(offset, end) !== body.slice(offset, newEnd) &&
    (offset === 0 || source[end - 1] !== body[newEnd - 1]) &&
    (end === source.length || source[offset] !== body[offset])
}

export function captureBodyEdits(source: string, model: string, crlf: boolean,
  event: MarkdownEditorTransactionEvent): readonly BodyEdit[] | undefined {
  const { changes, origin } = event.transaction
  const positionMap = event.positionMap
  if (!event.accepted || origin !== 'command' || !positionMap || !changes.length ||
    changes.length > WireLimits.ArticleBodyInsertionOperations || event.revision !== event.beforeRevision + 1) return

  const coordinates = source === model ? undefined : createMarkdownSourceCoordinateMap(source)
  if (coordinates && (!crlf || coordinates.normalizedSource !== model)) return
  function rawBoundary(position: number): number | undefined {
    if (!coordinates) return position
    const candidates = coordinates.rawCaretsAtNormalized(position).filter(offset => validBoundary(source, offset))
    if (candidates.length === 1) return candidates[0]
  }
  const edits: BodyEdit[] = []
  let body = source
  let editedModel = model
  let previousEnd = -1
  let modelDelta = 0
  for (const change of changes) {
    const position = change.from + modelDelta
    // A shared start can already belong to the preceding replacement in the editor's point map.
    const boundary = change.from === previousEnd ? change.to : change.from
    if (change.from > change.to || change.from < previousEnd || (change.from === previousEnd && change.from === change.to) ||
      change.insert.includes('\0') || /\p{Surrogate}/u.test(change.insert) ||
      !validBoundary(model, change.from) || !validBoundary(model, change.to) ||
      positionMap.map(boundary, -1) !== position ||
      positionMap.map(boundary, 1) !== position + change.insert.length) return

    const from = rawBoundary(change.from)
    const to = rawBoundary(change.to)
    if (from === undefined || to === undefined || to < from) return
    const offset = from + body.length - source.length
    const removedLength = to - from
    const insert = crlf ? restoreCrlf(change.insert) : change.insert
    const next = body.slice(0, offset) + insert + body.slice(offset + removedLength)
    if (next.length > WireLimits.BodyBytes || !uniqueEdit(body, next, offset, removedLength, insert.length)) return
    edits.push({ offset, removedLength, insert })
    body = next
    editedModel = editedModel.slice(0, position) + change.insert + editedModel.slice(change.to + modelDelta)
    previousEnd = change.to
    modelDelta += change.insert.length - (change.to - change.from)
  }
  if (editedModel === event.value && body === (crlf ? restoreCrlf(event.value) : event.value)) return edits
}

function digestHex(digest: Uint8Array): string {
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function canRebaseSavedBodyRevision(sourceRevision: bigint, revision: bigint): boolean {
  return sourceRevision > 0n && revision > sourceRevision &&
    revision - sourceRevision <= BigInt(WireLimits.ArticleBodyInsertionChainEdges)
}

async function readInsertionMap(previous: SearchEditorTarget, revision: bigint, credential: string, signal: AbortSignal) {
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

type MappedBodyStep = { source: string; body: string; offset: number; removed: number; added: number }
type VerifiedBodyMap = Readonly<{ body: string; digest: Uint8Array; steps: readonly MappedBodyStep[] }>

async function verifyInsertionMap(map: Awaited<ReturnType<typeof readInsertionMap>>,
  signal: AbortSignal): Promise<VerifiedBodyMap | undefined> {
  const steps: MappedBodyStep[] = []
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
      if (!uniqueEdit(source, body, offset, 0, length)) return
      steps.push({ source, body, offset, removed: 0, added: length })
      body = source
    }
    if (edge.insertions.length) digest = digestHex(await bodyDigest(body, signal))
    if (edge.sourceDigest !== digest) return
  }
  if (body === map.sourceBody) return { body: map.body, steps: steps.reverse(), digest: finalDigest }
}

async function verifyEditMap(map: Awaited<ReturnType<typeof readBodyEditChain>>, previous: SearchEditorTarget,
  revision: bigint, signal: AbortSignal): Promise<VerifiedBodyMap | undefined> {
  if (!map.available || BigInt(map.edges.length) !== revision - previous.revision ||
    !await verifySourceMatch(map.sourceBody, previous)) return
  const steps: MappedBodyStep[] = []
  let source = map.sourceBody
  let digest = previous.sourceDigest
  for (const edge of map.edges) {
    if (edge.sourceDigest !== digestHex(digest)) return
    for (const { offset, removedLength: removed, insert } of edge.edits) {
      if (!Number.isSafeInteger(removed) || removed < 0 ||
        !validBoundary(source, offset) || !validBoundary(source, offset + removed)) return
      const body = source.slice(0, offset) + insert + source.slice(offset + removed)
      if (!uniqueEdit(source, body, offset, removed, insert.length)) return
      steps.push({ source, body, offset, removed, added: insert.length })
      source = body
    }
    if (edge.edits.length) digest = await bodyDigest(source, signal)
    if (edge.digest !== digestHex(digest)) return
  }
  if (source === map.body) return { body: source, digest, steps }
}

async function readVerifiedMap(previous: SearchEditorTarget, revision: bigint, credential: string, signal: AbortSignal) {
  const map = await readInsertionMap(previous, revision, credential, signal)
  if (!map.available) {
    const edits = await readBodyEditChain(previous.articleId, revision, previous.revision, credential, signal)
    return verifyEditMap(edits, previous, revision, signal)
  }
  if (BigInt(map.edges.length) !== revision - previous.revision ||
    digestHex(previous.sourceDigest) !== map.edges[0]?.sourceDigest || !await verifySourceMatch(map.sourceBody, previous)) return
  return verifyInsertionMap(map, signal)
}

export async function rebaseSavedBodyHit(previous: SearchEditorTarget, revision: bigint, credential: string,
  signal: AbortSignal): Promise<SearchEditorTarget | undefined> {
  if (previous.field !== 'body' || !canRebaseSavedBodyRevision(previous.revision, revision)) return
  try {
    const verified = await readVerifiedMap(previous, revision, credential, signal)
    if (!verified) return

    let range = { start: previous.sourceStart, end: previous.sourceEnd }
    for (const { source, body, offset, removed, added } of verified.steps) {
      signal.throwIfAborted()
      const anchor = createMarkdownAnchorMap({
        source, identity: { id: `blog-saved-body-${previous.articleId}`, epoch: 0 }, syntax: [],
      })
      const mapped = anchor.remapRange(range, {
        delete: removed ? [offset, offset + removed] : undefined,
        insert: added ? { at: offset, length: added } : undefined,
      })
      if (mapped.status !== 'mapped') return
      range = mapped.range
      if (!validBoundary(body, range.start) || !validBoundary(body, range.end) ||
        body.slice(range.start, range.end) !== previous.match) return
    }
    const { start, end } = range
    const sourceByteStart = utf8.encode(verified.body.slice(0, start)).length
    return { ...previous, revision, precision: 'rebased', sourceStart: start, sourceEnd: end,
      sourceByteStart, sourceByteEnd: sourceByteStart + utf8.encode(previous.match).length, sourceDigest: verified.digest }
  } catch (error) {
    if (error instanceof ProtocolError || error instanceof MarkdownRuntimeError ||
      error instanceof ApiError && (error.status === 400 || error.status === 404)) return
    throw error
  }
}
