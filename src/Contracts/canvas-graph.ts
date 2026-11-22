import { encodeFrame, ProtocolError } from './aeds.ts'
import { PodReader, PodWriter } from './binary.ts'
import { request } from './client.ts'
import { getWithSession, post } from './internal/http-methods.ts'
import { FrameType, WireHeader, WireLimits, WireRoutes } from './wire.generated.ts'

export type CanvasGeometry = { x: number; y: number; width: number; height: number }
export type CanvasViewport = { x: number; y: number; zoom: number }
export const defaultCanvasViewport: Readonly<CanvasViewport> = Object.freeze({ x: 0, y: 0, zoom: 1000 })

type CanvasNodeBase = { id: string; geometry: CanvasGeometry }
export type CanvasNode =
  | CanvasNodeBase & { kind: 'article-reference'; articleId: number; pinnedRevision: bigint | null }
  | CanvasNodeBase & { kind: 'heading-reference' | 'block-reference'; articleId: number; anchor: string; pinnedRevision: bigint | null }
  | CanvasNodeBase & { kind: 'plain-text-note'; text: string }
  | CanvasNodeBase & { kind: 'group-frame'; text: string; memberIds: readonly string[] }

export type CanvasGraphEdge = {
  id: string
  kind: 'visual-only' | 'explicit-reference-note'
  sourceNodeId: string
  targetNodeId: string
  order: number
  label: string | null
}

export type CanvasGraphChange =
  | { kind: 'upsert-node'; node: CanvasNode }
  | { kind: 'remove-node'; id: string }
  | { kind: 'upsert-edge'; edge: CanvasGraphEdge }
  | { kind: 'remove-edge'; id: string }

export type CanvasGraphCommand = {
  id: string
  commandId: string
  expectedRevision: bigint
  action: keyof typeof actions
  title: string
  viewport: CanvasViewport | null
  changes: readonly CanvasGraphChange[]
}

export type CanvasGraphHeader = {
  id: string
  revision: bigint
  title: string
  viewport: CanvasViewport
  deleted: boolean
  nodeCount: number
  edgeCount: number
  touchedAt: number
}

export type CanvasGraphPage = {
  header: CanvasGraphHeader
  nextOffset: number | null
  nodes: CanvasNode[]
  edges: CanvasGraphEdge[]
}

export type CanvasGraphHistory = {
  revision: bigint
  undoRevision: bigint | null
  redoRevision: bigint | null
}

export type CanvasReferenceResolution = {
  canvasId: string
  nodeId: string
  canvasRevision: bigint
  state: typeof referenceStates[number]
  articleId: number | null
  articleRevision: bigint | null
  pinned: boolean
  title: string | null
  excerpt: string | null
  sourceOffset: number | null
}

const maxRecords = 10_000
const maxCoordinate = 1_000_000_000
const actions = { create: 0, edit: 1, delete: 2, undo: 5, redo: 6 } as const
const nodeKinds = ['article-reference', 'heading-reference', 'block-reference', 'plain-text-note', 'group-frame'] as const
const edgeKinds = ['visual-only', 'explicit-reference-note'] as const
const referenceStates = ['unavailable', 'resolved', 'missing-anchor', 'duplicate-anchor', 'stale-revision'] as const
const zeroUuid = '00000000-0000-0000-0000-000000000000'
const controls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/
const htmlLike = /<[\s\S]*?>/

function check(valid: boolean, field: string): asserts valid {
  if (!valid) throw new ProtocolError(`Invalid Canvas graph ${field}`)
}

function identity(value: string): string {
  check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) && value !== zeroUuid, 'identifier')
  return value.toLowerCase()
}

function bounded(value: number, minimum: number, maximum: number, field: string): number {
  check(Number.isInteger(value) && value >= minimum && value <= maximum, field)
  return value
}

function plain(value: string, maxLength: number, field: string, required = false): string {
  check(value.length <= maxLength && (!required || value.trim().length > 0) && !controls.test(value) && !htmlLike.test(value), field)
  return value
}

function title(value: string, required = false): string {
  check(!/[\n\r\t]/.test(value), 'title')
  return plain(value, 128, 'title', required)
}

function articleId(value: number): number {
  return bounded(value, 1, 0x7fffffff, 'article reference')
}

function anchor(value: string): string {
  check(/^[a-z][a-z0-9-]{0,63}$/u.test(value) && value.trim() === value, 'anchor')
  return value
}

function pinned(value: bigint): bigint | null {
  check(value >= 0n, 'pinned revision')
  return value || null
}

function viewport(view: CanvasViewport): CanvasViewport {
  bounded(view.x, -maxCoordinate, maxCoordinate, 'viewport x')
  bounded(view.y, -maxCoordinate, maxCoordinate, 'viewport y')
  bounded(view.zoom, 100, 4000, 'viewport zoom')
  return view
}

function geometry(value: CanvasGeometry): CanvasGeometry {
  bounded(value.x, -maxCoordinate, maxCoordinate, 'node x')
  bounded(value.y, -maxCoordinate, maxCoordinate, 'node y')
  bounded(value.width, 2400, 409_600, 'node width')
  bounded(value.height, 2400, 409_600, 'node height')
  return value
}

function writeViewport(output: PodWriter, input: CanvasViewport): void {
  const value = viewport(input)
  output.i32(value.x)
  output.i32(value.y)
  output.i32(value.zoom)
}

function readViewport(input: PodReader): CanvasViewport {
  return viewport({ x: input.i32(), y: input.i32(), zoom: input.i32() })
}

function membership(frame: string, values: readonly string[]): string[] {
  bounded(values.length, 0, maxRecords, 'frame member count')
  const nodes = values.map(identity)
  check(!nodes.includes(frame) && new Set(nodes).size === nodes.length, 'frame membership')
  return nodes
}

function writeNode(output: PodWriter, node: CanvasNode): void {
  const id = identity(node.id)
  output.uuid(id)
  const tag = nodeKinds.indexOf(node.kind)
  check(tag >= 0, 'node kind')
  output.i32(tag)
  const bounds = geometry(node.geometry)
  output.i32(bounds.x)
  output.i32(bounds.y)
  output.i32(bounds.width)
  output.i32(bounds.height)
  switch (node.kind) {
    case 'article-reference':
    case 'heading-reference':
    case 'block-reference':
      output.i32(articleId(node.articleId))
      if (node.kind !== 'article-reference') output.text(anchor(node.anchor), WireLimits.CanvasGraphAnchorBytes)
      check(node.pinnedRevision === null || node.pinnedRevision > 0n, 'pinned revision')
      output.i64(node.pinnedRevision ?? 0n)
      break
    case 'plain-text-note':
      output.text(plain(node.text, 8192, 'note', true), WireLimits.CanvasGraphNoteBytes)
      break
    case 'group-frame': {
      output.text(plain(node.text, 128, 'frame label', true), WireLimits.CanvasGraphLabelBytes)
      const ids = membership(id, node.memberIds)
      output.i32(ids.length)
      for (const member of ids) output.uuid(member)
      break
    }
  }
}

function readNode(input: PodReader): CanvasNode {
  const id = identity(input.uuid())
  const kind = nodeKinds[input.i32()]
  check(kind !== undefined, 'node kind')
  const bounds = geometry({ x: input.i32(), y: input.i32(), width: input.i32(), height: input.i32() })
  const base = { id, geometry: bounds }
  switch (kind) {
    case 'article-reference':
      return { ...base, kind, articleId: articleId(input.i32()), pinnedRevision: pinned(input.i64()) }
    case 'heading-reference':
    case 'block-reference':
      return { ...base, kind, articleId: articleId(input.i32()), anchor: anchor(input.text(WireLimits.CanvasGraphAnchorBytes)), pinnedRevision: pinned(input.i64()) }
    case 'plain-text-note':
      return { ...base, kind, text: plain(input.text(WireLimits.CanvasGraphNoteBytes), 8192, 'note', true) }
    case 'group-frame': {
      const text = plain(input.text(WireLimits.CanvasGraphLabelBytes), 128, 'frame label', true)
      const count = bounded(input.i32(), 0, maxRecords, 'frame member count')
      return { ...base, kind, text, memberIds: membership(id, Array.from({ length: count }, () => input.uuid())) }
    }
  }
}

function writeEdge(output: PodWriter, edge: CanvasGraphEdge): void {
  output.uuid(identity(edge.id))
  const tag = edgeKinds.indexOf(edge.kind)
  check(tag >= 0, 'edge kind')
  output.i32(tag)
  output.uuid(identity(edge.sourceNodeId))
  output.uuid(identity(edge.targetNodeId))
  output.i32(bounded(edge.order, 0, 0x7fffffff, 'edge order'))
  output.bool(edge.label !== null)
  if (edge.label !== null) output.text(plain(edge.label, 128, 'edge label'), WireLimits.CanvasGraphLabelBytes)
}

function readEdge(input: PodReader): CanvasGraphEdge {
  const id = identity(input.uuid())
  const kind = edgeKinds[input.i32()]
  check(kind !== undefined, 'edge kind')
  const sourceNodeId = identity(input.uuid())
  const targetNodeId = identity(input.uuid())
  const order = bounded(input.i32(), 0, 0x7fffffff, 'edge order')
  const label = input.bool() ? plain(input.text(WireLimits.CanvasGraphLabelBytes), 128, 'edge label') : null
  return { id, kind, sourceNodeId, targetNodeId, order, label }
}

export function encodeCanvasGraphCommand(command: CanvasGraphCommand): Uint8Array {
  const tag = actions[command.action]
  check(typeof tag === 'number' && (command.action === 'create' ? command.expectedRevision === 0n : command.expectedRevision > 0n), 'command revision or action')
  check(command.action !== 'delete' || command.title === '' && command.viewport === null && command.changes.length === 0, 'delete shape')
  if (command.action === 'undo' || command.action === 'redo') {
    check(command.title === '' && command.viewport === null && command.changes.length === 0, 'history command shape')
  }
  check(command.action !== 'edit' || command.title !== '' || command.viewport !== null || command.changes.length !== 0, 'empty edit')
  const output = new PodWriter()
  output.uuid(identity(command.id))
  output.uuid(identity(command.commandId))
  output.i64(command.expectedRevision)
  output.i32(tag)
  output.text(title(command.title, command.action === 'create' || command.title !== ''), WireLimits.TitleBytes)
  output.bool(command.viewport !== null)
  if (command.viewport) writeViewport(output, command.viewport)
  output.i32(bounded(command.changes.length, 0, WireLimits.CanvasGraphMaxChanges, 'change count'))
  for (const change of command.changes) {
    switch (change.kind) {
      case 'upsert-node':
        output.i32(0)
        writeNode(output, change.node)
        break
      case 'remove-node':
        output.i32(1)
        output.uuid(identity(change.id))
        break
      case 'upsert-edge':
        output.i32(2)
        writeEdge(output, change.edge)
        break
      case 'remove-edge':
        output.i32(3)
        output.uuid(identity(change.id))
        break
      default:
        throw new ProtocolError('Invalid Canvas graph change kind')
    }
  }
  const payload = output.finish()
  check(payload.length + WireHeader.HeaderSize <= WireLimits.CanvasGraphCommandBytes, 'command byte budget')
  return payload
}

function readHeader(input: PodReader): CanvasGraphHeader {
  const id = identity(input.uuid())
  const revision = input.i64()
  check(revision > 0n, 'revision')
  const name = title(input.text(WireLimits.TitleBytes))
  const view = readViewport(input)
  const deleted = input.bool()
  const nodeCount = bounded(input.i32(), 0, maxRecords, 'node count')
  const edgeCount = bounded(input.i32(), 0, maxRecords, 'edge count')
  const touchedAt = Number(input.i64())
  check(Number.isSafeInteger(touchedAt) && touchedAt >= -62_135_596_800_000 && touchedAt <= 253_402_300_799_999, 'modification time')
  check(deleted ? nodeCount === 0 && edgeCount === 0 : name.trim() !== '', 'header shape')
  return { id, revision, title: name, viewport: view, deleted, nodeCount, edgeCount, touchedAt }
}

function unique(records: readonly { id: string }[]): void {
  check(new Set(records.map(record => record.id)).size === records.length, 'duplicate identifier')
}

export function decodeCanvasGraphReceipt(payload: Uint8Array): CanvasGraphHeader {
  const input = new PodReader(payload)
  const header = readHeader(input)
  input.finish()
  return header
}

export function decodeCanvasGraphList(payload: Uint8Array): CanvasGraphHeader[] {
  const input = new PodReader(payload)
  const count = bounded(input.i32(), 0, WireLimits.CanvasGraphMaxDocuments, 'document count')
  const documents = Array.from({ length: count }, () => readHeader(input))
  unique(documents)
  check(documents.every(item => !item.deleted), 'deleted document in list')
  input.finish()
  return documents
}

export function decodeCanvasGraphPage(payload: Uint8Array, offset = 0): CanvasGraphPage {
  const input = new PodReader(payload)
  const header = readHeader(input)
  check(!header.deleted, 'deleted document in page')
  const next = input.i32()
  bounded(offset, 0, Math.max(0, header.nodeCount + header.edgeCount - 1), 'page offset')
  const remainingNodes = Math.max(0, header.nodeCount - offset)
  const remainingEdges = header.edgeCount - Math.max(0, offset - header.nodeCount)
  const nodeCount = bounded(input.i32(), 0, Math.min(remainingNodes, WireLimits.CanvasGraphMaxPageNodes), 'page node count')
  const nodes = Array.from({ length: nodeCount }, () => readNode(input))
  const edgeCount = bounded(input.i32(), 0, remainingNodes > 0 ? 0 : Math.min(remainingEdges, WireLimits.CanvasGraphMaxPageEdges), 'page edge count')
  const edges = Array.from({ length: edgeCount }, () => readEdge(input))
  const total = header.nodeCount + header.edgeCount
  const consumed = offset + nodeCount + edgeCount
  check(consumed <= total && (next === -1 ? consumed === total : next === consumed && consumed > offset && consumed < total), 'next offset')
  unique(nodes)
  unique(edges)
  input.finish()
  return { header, nextOffset: next === -1 ? null : next, nodes, edges }
}

export function decodeCanvasGraphHistory(payload: Uint8Array): CanvasGraphHistory {
  const input = new PodReader(payload)
  const revision = input.i64()
  const undo = input.i64()
  const redo = input.i64()
  input.finish()
  check(revision > 0n && undo >= 0n && undo <= revision && redo >= 0n && redo <= revision &&
    (undo === 0n || undo !== redo), 'history revision')
  return { revision, undoRevision: undo || null, redoRevision: redo || null }
}

export function decodeCanvasReferenceResolution(payload: Uint8Array): CanvasReferenceResolution {
  const input = new PodReader(payload)
  const canvasId = identity(input.uuid())
  const nodeId = identity(input.uuid())
  const canvasRevision = input.i64()
  const state = referenceStates[input.i32()]
  const article = input.i32()
  const articleRev = input.i64()
  const pinned = input.bool()
  const title = input.text(WireLimits.TitleBytes) || null
  const excerpt = input.text(WireLimits.CanvasReferenceExcerptBytes) || null
  const offset = input.i32()
  const articleId = article === 0 ? null : article
  const articleRevision = articleRev === 0n ? null : articleRev
  const sourceOffset = offset === -1 ? null : offset
  input.finish()
  check(canvasRevision > 0n && state !== undefined, 'reference coordinates')

  if (state === 'unavailable' || state === 'stale-revision') {
    check(articleId === null && articleRevision === null && !pinned && title === null && excerpt === null && sourceOffset === null,
      'unavailable reference shape')
  } else {
    check(articleId !== null && articleId > 0 && articleRevision !== null && articleRevision > 0n &&
      title !== null && !/^\p{White_Space}|\p{White_Space}$/u.test(title) && !/\p{Cc}/u.test(title), 'reference metadata')
    check(state === 'resolved' || excerpt === null && sourceOffset === null, 'unresolved reference excerpt')
    check((sourceOffset === null || sourceOffset >= 0) && (excerpt === null || sourceOffset !== null && !controls.test(excerpt)),
      'reference excerpt or offset')
  }
  return { canvasId, nodeId, canvasRevision, state, articleId, articleRevision, pinned, title, excerpt, sourceOffset }
}

export const canvasGraph = {
  list(signal?: AbortSignal): Promise<CanvasGraphHeader[]> {
    return request(WireRoutes.CanvasGraphList, FrameType.CanvasGraphList, decodeCanvasGraphList, signal)
  },
  page(id: string, position: { revision?: bigint; offset?: number } = {}, signal?: AbortSignal): Promise<CanvasGraphPage> {
    const document = identity(id)
    const { revision, offset = 0 } = position
    bounded(offset, 0, maxRecords * 2, 'page offset')
    check(revision === undefined ? offset === 0 : revision > 0n, 'page revision')
    const query = new URLSearchParams()
    if (revision !== undefined) query.set('revision', revision.toString())
    if (offset > 0) query.set('offset', String(offset))
    const path = WireRoutes.CanvasGraphPage.replace(/\{id(?::guid)?\}/, document)
    const url = query.size ? `${path}?${query}` : path
    return request(url, FrameType.CanvasGraphPage, payload => {
      const page = decodeCanvasGraphPage(payload, offset)
      check(page.header.id === document && (revision === undefined || page.header.revision === revision), 'page document or revision')
      return page
    }, signal)
  },
  history(id: string, expectedRevision: bigint, signal?: AbortSignal): Promise<CanvasGraphHistory> {
    check(expectedRevision > 0n && BigInt.asIntN(64, expectedRevision) === expectedRevision, 'history revision')
    const path = WireRoutes.CanvasGraphHistory.replace('{id:guid}', identity(id))
    return request(`${path}?revision=${expectedRevision}`, FrameType.CanvasGraphHistory, payload => {
      const history = decodeCanvasGraphHistory(payload)
      check(history.revision === expectedRevision, 'history revision')
      return history
    }, signal)
  },
  resolve(id: string, nodeId: string, revision: bigint, signal?: AbortSignal, currentSession?: string): Promise<CanvasReferenceResolution> {
    const canvas = identity(id)
    const node = identity(nodeId)
    check(revision > 0n && BigInt.asIntN(64, revision) === revision, 'reference revision')
    const path = WireRoutes.CanvasReference.replace('{id:guid}', canvas).replace('{nodeId:guid}', node)
    const current = currentSession === undefined ? '' : '&current=1'
    return getWithSession(`${path}?revision=${revision}${current}`, FrameType.CanvasReferenceResolution, payload => {
      const resolution = decodeCanvasReferenceResolution(payload)
      check(resolution.canvasId === canvas && resolution.nodeId === node && resolution.canvasRevision === revision, 'reference response coordinates')
      return resolution
    }, signal, currentSession)
  },
  write(command: CanvasGraphCommand, signal?: AbortSignal): Promise<CanvasGraphHeader> {
    const body = encodeFrame(FrameType.CanvasGraphCommand, encodeCanvasGraphCommand(command))
    return post(WireRoutes.CanvasGraphWrite, FrameType.CanvasGraphReceipt, payload => {
      const receipt = decodeCanvasGraphReceipt(payload)
      check(receipt.id === identity(command.id) && receipt.revision === command.expectedRevision + 1n &&
        receipt.deleted === (command.action === 'delete'), 'command receipt')
      return receipt
    }, signal, body)
  },
}
