import { encodeFrame, ProtocolError } from './aeds.ts'
import { PodReader, PodWriter } from './binary.ts'
import { request, validSiteSessionId } from './client.ts'
import { decodePropertyMatches, encodePropertyQuery, type PropertyQuery } from './property-query.ts'
import { FrameType, WireHeaders, WireLimits, WireRoutes } from './wire.generated.ts'

export type SavedView = Readonly<{ id: string; revision: bigint; name: string }>
export type SavedViewCatalog = Readonly<{ revision: bigint; nextId: string; views: readonly SavedView[] }>
export type SavedViewChange = Readonly<{
  id: string; revision: bigint; collectionRevision: bigint; requestId: string
} & ({ action: 'save'; name: string; query: PropertyQuery } | { action: 'rename'; name: string } | { action: 'retire' })>

const emptyId = '00000000-0000-0000-0000-000000000000'

function sessionHeaders(session: string) {
  if (!validSiteSessionId(session)) throw new ProtocolError('Invalid saved view session')
  return { [WireHeaders.CurrentSession]: session }
}

export function listSavedViews(session: string, after?: { id: string; revision: bigint }, signal?: AbortSignal) {
  const path = after ? WireRoutes.SavedViews + '?' + new URLSearchParams({ after: after.id, revision: String(after.revision) })
    : WireRoutes.SavedViews
  return request<SavedViewCatalog>(path, FrameType.SavedViewCatalog, bytes => {
    const input = new PodReader(bytes)
    const revision = input.i64(), next = input.uuid(), count = input.i32()
    if (revision < 0n || after && revision !== after.revision || count < 0 || count > WireLimits.SavedViewPageSize)
      throw new ProtocolError('Invalid saved view catalog')
    let previous = after?.id ?? emptyId
    const views: SavedView[] = []
    for (let index = 0; index < count; index++) {
      const id = input.uuid(), viewRevision = input.i64(), name = input.text(WireLimits.SavedViewNameBytes)
      if (id <= previous || viewRevision <= 0n || viewRevision > revision || !name) throw new ProtocolError('Invalid saved view entry')
      views.push({ id, revision: viewRevision, name })
      previous = id
    }
    input.finish()
    if (next !== emptyId && (count !== WireLimits.SavedViewPageSize || next !== previous))
      throw new ProtocolError('Invalid saved view continuation')
    return { revision, nextId: next === emptyId ? '' : next, views }
  }, signal, 'GET', undefined, sessionHeaders(session))
}

export function changeSavedView(session: string, change: SavedViewChange, signal?: AbortSignal) {
  const writer = new PodWriter()
  writer.i32(change.action === 'save' ? 1 : change.action === 'rename' ? 2 : 3)
  writer.uuid(change.id)
  writer.i64(change.revision)
  writer.i64(change.collectionRevision)
  writer.uuid(change.requestId)
  writer.text(change.action === 'retire' ? '' : change.name, WireLimits.SavedViewNameBytes)
  writer.bytes(change.action === 'save' ? encodePropertyQuery({ ...change.query, cursor: '' }) : new Uint8Array(0))
  return request(WireRoutes.SavedViews, FrameType.SavedViewReceipt, bytes => {
    const input = new PodReader(bytes)
    const id = input.uuid(), revision = input.i64(), collectionRevision = input.i64(), retired = input.bool()
    input.finish()
    if (id !== change.id || revision !== change.revision + 1n || collectionRevision !== change.collectionRevision + 1n ||
        retired !== (change.action === 'retire')) throw new ProtocolError('Invalid saved view receipt')
    return { id, revision, collectionRevision, retired }
  }, signal, 'POST', encodeFrame(FrameType.SavedViewCommand, writer.finish()), sessionHeaders(session))
}

export function runSavedView(session: string, view: SavedView, cursor: string, signal?: AbortSignal) {
  const writer = new PodWriter()
  writer.uuid(view.id)
  writer.i64(view.revision)
  writer.text(cursor, WireLimits.PropertyQueryCursorChars)
  return request(WireRoutes.SavedViewExecute, FrameType.PropertyArticlePage, decodePropertyMatches, signal, 'POST',
    encodeFrame(FrameType.SavedViewExecute, writer.finish()), sessionHeaders(session))
}
