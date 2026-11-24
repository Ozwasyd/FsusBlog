import { encodePod, ProtocolError } from './aeds.ts'
import { decodePod, PodReader, ZERO_UUID } from './binary.ts'
import { validSiteSessionId } from './client.ts'
import { post, request } from './internal/http.ts'
import { decodePropertyMatches, encodePropertyQuery, type PropertyQuery } from './property-query.ts'
import { FrameType, WireHeaders, WireLimits, WireRoutes } from './wire.generated.ts'

export type SavedView = Readonly<{ id: string; revision: bigint; name: string }>
export type SavedViewCatalog = Readonly<{ revision: bigint; nextId: string; views: readonly SavedView[] }>
export type PlacementAction = 'pin' | 'unpin' | 'default' | 'clear-default' | 'move-before'
export type PlacementChange = Readonly<{ action: PlacementAction; view: SavedView; revision: bigint; requestId: string; before?: string }>
export type SavedViewPlacement = Readonly<{ revision: bigint; defaultView?: SavedView; requested?: SavedView;
  requestedPinned: boolean; offset: number; pins: readonly SavedView[] }>
export type SavedViewChange = Readonly<{
  id: string; revision: bigint; collectionRevision: bigint; requestId: string
} & ({ action: 'save'; name: string; query: PropertyQuery } | { action: 'rename'; name: string } | { action: 'retire' })>

const placementActions: readonly PlacementAction[] = ['pin', 'unpin', 'default', 'clear-default', 'move-before']

function sessionHeaders(session: string) {
  if (!validSiteSessionId(session)) throw new ProtocolError('Invalid saved view session')
  return { [WireHeaders.CurrentSession]: session }
}

export function listSavedViews(session: string, after?: { id: string; revision: bigint }, signal?: AbortSignal) {
  const path = after ? WireRoutes.SavedViews + '?' + new URLSearchParams({ after: after.id, revision: String(after.revision) })
    : WireRoutes.SavedViews
  return request<SavedViewCatalog>(path, FrameType.SavedViewCatalog, bytes => decodePod(bytes, input => {
    const revision = input.i64(), next = input.uuid(), count = input.i32()
    if (revision < 0n || after && revision !== after.revision || count < 0 || count > WireLimits.SavedViewPageSize)
      throw new ProtocolError('Invalid saved view catalog')
    let previous = after?.id ?? ZERO_UUID
    const views: SavedView[] = []
    for (let index = 0; index < count; index++) {
      const id = input.uuid(), viewRevision = input.i64(), name = input.text(WireLimits.SavedViewNameBytes)
      if (id <= previous || viewRevision <= 0n || viewRevision > revision || !name) throw new ProtocolError('Invalid saved view entry')
      views.push({ id, revision: viewRevision, name })
      previous = id
    }
    if (next !== ZERO_UUID && (count !== WireLimits.SavedViewPageSize || next !== previous))
      throw new ProtocolError('Invalid saved view continuation')
    return { revision, nextId: next === ZERO_UUID ? '' : next, views }
  }), signal, 'GET', undefined, sessionHeaders(session))
}

export function changeSavedView(session: string, change: SavedViewChange, signal?: AbortSignal) {
  const body = encodePod(FrameType.SavedViewCommand, writer => writer
    .i32(change.action === 'save' ? 1 : change.action === 'rename' ? 2 : 3).uuid(change.id)
    .i64(change.revision).i64(change.collectionRevision).uuid(change.requestId)
    .text(change.action === 'retire' ? '' : change.name, WireLimits.SavedViewNameBytes)
    .bytes(change.action === 'save' ? encodePropertyQuery({ ...change.query, cursor: '' }) : new Uint8Array(0)))
  return post(WireRoutes.SavedViews, FrameType.SavedViewReceipt, bytes => decodePod(bytes, input => {
    const id = input.uuid(), revision = input.i64(), collectionRevision = input.i64(), retired = input.bool()
    if (id !== change.id || revision !== change.revision + 1n || collectionRevision !== change.collectionRevision + 1n ||
        retired !== (change.action === 'retire')) throw new ProtocolError('Invalid saved view receipt')
    return { id, revision, collectionRevision, retired }
  }), signal, body, sessionHeaders(session))
}

export function runSavedView(session: string, view: SavedView, cursor: string, signal?: AbortSignal) {
  const body = encodePod(FrameType.SavedViewExecute, w => w.uuid(view.id).i64(view.revision).text(cursor, WireLimits.PropertyQueryCursorChars))
  return post(WireRoutes.SavedViewExecute, FrameType.PropertyArticlePage, decodePropertyMatches, signal, body, sessionHeaders(session))
}

function readSummary(input: PodReader, collectionRevision: bigint): SavedView {
  const id = input.uuid(), revision = input.i64(), name = input.text(WireLimits.SavedViewNameBytes)
  if (id === ZERO_UUID || revision <= 0n || revision > collectionRevision || !name) throw new ProtocolError('Invalid saved view entry')
  return { id, revision, name }
}

export function savedViewPlacement(session: string, at?: { id: string } | { offset: number; revision: bigint }, signal?: AbortSignal) {
  const params = !at ? '' : new URLSearchParams('id' in at ? { view: at.id, viewSchema: '1' }
    : { offset: String(at.offset), revision: String(at.revision) }).toString()
  const path = WireRoutes.SavedViewPlacement + (params ? '?' + params : '')
  return request<SavedViewPlacement>(path, FrameType.SavedViewPlacement, bytes => decodePod(bytes, input => {
    const revision = input.i64()
    const defaultView = input.bool() ? readSummary(input, revision) : undefined
    const requested = input.bool() ? readSummary(input, revision) : undefined
    const requestedPinned = input.bool(), offset = input.i32(), count = input.i32()
    if (revision < 0n || requestedPinned && !requested || at && 'revision' in at && revision !== at.revision ||
        requested?.id !== (at && 'id' in at ? at.id : undefined) ||
        count < 0 || count > WireLimits.SavedViewPageSize || offset < 0 || offset >= WireLimits.SavedViewMaxCount ||
        offset !== 0 && (count !== WireLimits.SavedViewPageSize || offset !== (at && 'offset' in at ? at.offset : 0) + count))
      throw new ProtocolError('Invalid saved view placement')
    const pins = Array.from({ length: count }, () => readSummary(input, revision))
    if (new Set(pins.map(pin => pin.id)).size !== count) throw new ProtocolError('Invalid saved view pins')
    return { revision, defaultView, requested, requestedPinned, offset, pins }
  }), signal, 'GET', undefined, sessionHeaders(session))
}

export function placeSavedView(session: string, change: PlacementChange, signal?: AbortSignal) {
  const body = encodePod(FrameType.SavedViewPlacementCommand, writer => writer
    .i32(4 + placementActions.indexOf(change.action)).uuid(change.view.id).i64(change.view.revision)
    .i64(change.revision).uuid(change.requestId).uuid(change.before ?? ZERO_UUID))
  return post(WireRoutes.SavedViewPlacement, FrameType.SavedViewReceipt, bytes => decodePod(bytes, input => {
    const id = input.uuid(), revision = input.i64(), collection = input.i64(), retired = input.bool()
    if (id !== change.view.id || revision !== change.view.revision || collection !== change.revision + 1n || retired)
      throw new ProtocolError('Invalid saved view placement receipt')
  }), signal, body, sessionHeaders(session))
}
