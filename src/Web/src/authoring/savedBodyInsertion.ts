import {
  createMarkdownAnchorMap, createMarkdownSourceCoordinateMap,
} from '@ozwasyd/element-plus/markdown-runtime'
import type { MarkdownEditorTransactionEvent } from '@ozwasyd/element-plus'
import { readBodyInsertion, type BodyInsertion } from '../../../Contracts/article-body-insertion'
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

export function captureBodyInsertion(source: string, model: string, crlf: boolean,
  event: MarkdownEditorTransactionEvent): BodyInsertion | undefined {
  const { changes, origin } = event.transaction
  const change = changes[0]
  if (!event.accepted || origin !== 'command' || !event.positionMap || changes.length !== 1 || !change ||
    change.from !== change.to || !change.insert || !validBoundary(model, change.from) ||
    event.revision !== event.beforeRevision + 1 ||
    model.slice(0, change.from) + change.insert + model.slice(change.from) !== event.value) return

  let offset = change.from
  if (source !== model) {
    if (!crlf) return
    const coordinates = createMarkdownSourceCoordinateMap(source)
    if (coordinates.normalizedSource !== model) return
    offset = coordinates.toRawOffset(offset, { affinity: 'backward' })
  }
  const length = (crlf ? restoreCrlf(change.insert) : change.insert).length
  const body = crlf ? restoreCrlf(event.value) : event.value
  const insertion = { offset, length }
  if (uniqueInsertion(source, body, insertion)) return insertion
}

function digestHex(digest: Uint8Array): string {
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function rebaseSavedBodyHit(previous: SearchEditorTarget, revision: bigint, credential: string,
  signal: AbortSignal): Promise<SearchEditorTarget | undefined> {
  if (previous.field !== 'body' || previous.revision <= 0n || revision !== previous.revision + 1n) return
  const map = await readBodyInsertion(previous.articleId, revision, previous.revision, credential, signal)
  if (!map.available || !uniqueInsertion(map.sourceBody, map.body, map) || digestHex(previous.sourceDigest) !== map.sourceDigest ||
    !await verifySourceMatch(map.sourceBody, previous)) return
  signal.throwIfAborted()
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(map.body)))
  if (digestHex(digest) !== map.digest) return
  signal.throwIfAborted()

  const anchor = createMarkdownAnchorMap({
    source: map.sourceBody,
    identity: { id: `blog-saved-body-${previous.articleId}-${previous.revision}`, epoch: 0 },
  })
  const mapped = anchor.remapRange({ start: previous.sourceStart, end: previous.sourceEnd }, {
    insert: { at: map.offset, length: map.length },
  })
  if (mapped.status !== 'mapped') return
  const { start, end } = mapped.range
  if (!validBoundary(map.body, start) || !validBoundary(map.body, end) || map.body.slice(start, end) !== previous.match) return
  const sourceByteStart = utf8.encode(map.body.slice(0, start)).length
  return { ...previous, revision, precision: 'rebased', sourceStart: start, sourceEnd: end,
    sourceByteStart, sourceByteEnd: sourceByteStart + utf8.encode(previous.match).length, sourceDigest: digest }
}
