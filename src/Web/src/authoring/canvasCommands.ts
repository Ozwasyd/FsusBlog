import {
  encodeCanvasGraphCommand, type CanvasGraphChange, type CanvasGraphCommand, type CanvasGraphEdge,
  type CanvasGraphHeader, type CanvasGraphHistory, type CanvasNode, type CanvasViewport,
} from '../../../Contracts/canvas-graph.ts'
import type { MessageKey } from '../siteLocale.ts'
import { CANVAS_MAX_COORDINATE, CANVAS_SHOW_NODE_OFFSET } from './canvasViewport.ts'

export type CanvasMessageKey = MessageKey
export type CanvasNotice = Readonly<{ kind: 'key'; key: CanvasMessageKey }> | Readonly<{ kind: 'text'; text: string }>
export const keyNotice = (key: CanvasMessageKey): CanvasNotice => ({ kind: 'key', key })
export const textNotice = (text: string): CanvasNotice => ({ kind: 'text', text })

export type CanvasNodeDraftInput = Readonly<{
  kind: CanvasNode['kind']; text: string; article: string; anchor: string; pinned: string; memberIds: readonly string[]
}>
export type CanvasEdgeDraftInput = Readonly<{ endpoint: string; kind: CanvasGraphEdge['kind']; label: string }>
export type CanvasActiveLinkPair = Readonly<{
  from: Extract<CanvasNode, { kind: 'article-reference' }>
  to: Extract<CanvasNode, { kind: 'article-reference' }>
}>

export const OUTLINE_PAGE_SIZE = 50
export const CHOICE_CAP = 256

type CanvasDocumentRef = Pick<CanvasGraphHeader, 'id' | 'revision'>
type CanvasEditOptions = { changes?: readonly CanvasGraphChange[]; title?: string; viewport?: CanvasViewport | null }

const canvasCommand = (
  id: string, commandId: string, expectedRevision: bigint, action: CanvasGraphCommand['action'],
  { changes = [], title = '', viewport = null }: CanvasEditOptions = {},
): CanvasGraphCommand => ({ id, commandId, expectedRevision, action, title, viewport, changes })

export const createCanvasCommand = (title: string, canvasId: string, commandId: string): CanvasGraphCommand =>
  canvasCommand(canvasId, commandId, 0n, 'create', { title })
export const editCanvasCommand = (document: CanvasDocumentRef, commandId: string, options: CanvasEditOptions = {}): CanvasGraphCommand =>
  canvasCommand(document.id, commandId, document.revision, 'edit', options)
export const historyTravelCommand = (document: CanvasDocumentRef, action: 'undo' | 'redo', commandId: string): CanvasGraphCommand =>
  canvasCommand(document.id, commandId, document.revision, action)
export const deleteCanvasCommand = (document: CanvasDocumentRef, commandId: string): CanvasGraphCommand =>
  canvasCommand(document.id, commandId, document.revision, 'delete')

export function validateCanvasCommand(command: CanvasGraphCommand): boolean {
  try { encodeCanvasGraphCommand(command); return true }
  catch { return false }
}

export function buildCanvasNode(
  draft: CanvasNodeDraftInput, canvas: Pick<CanvasGraphHeader, 'nodeCount' | 'viewport'>,
  generatedNodeId: string, editingNode?: CanvasNode,
): { ok: true; node: CanvasNode } | { ok: false; errorKey: CanvasMessageKey } {
  const shift = (canvas.nodeCount % 8) * 3400
  const geometry = editingNode?.geometry ?? {
    x: Math.min(CANVAS_MAX_COORDINATE, canvas.viewport.x + CANVAS_SHOW_NODE_OFFSET + shift),
    y: Math.min(CANVAS_MAX_COORDINATE, canvas.viewport.y + CANVAS_SHOW_NODE_OFFSET + shift),
    width: 17000, height: 10000,
  }
  const base = { id: editingNode?.id ?? generatedNodeId, geometry }
  if (draft.kind === 'plain-text-note') return { ok: true, node: { ...base, kind: draft.kind, text: draft.text } }
  if (draft.kind === 'group-frame') return { ok: true, node: { ...base, kind: draft.kind, text: draft.text, memberIds: [...draft.memberIds] } }
  if (!/^[1-9]\d{0,9}$/.test(draft.article) || Number(draft.article) > 2_147_483_647 ||
    (draft.pinned && !/^[1-9]\d{0,18}$/.test(draft.pinned)))
    return { ok: false, errorKey: 'author.canvas.enter_a_valid_article_id_and_optional_pinned_revision' }
  const referenced = { ...base, articleId: Number(draft.article), pinnedRevision: draft.pinned ? BigInt(draft.pinned) : null }
  return {
    ok: true,
    node: draft.kind === 'article-reference' ? { ...referenced, kind: draft.kind } : { ...referenced, kind: draft.kind, anchor: draft.anchor },
  }
}

export function buildCanvasEdge(
  draft: CanvasEdgeDraftInput,
  context: { prior?: CanvasGraphEdge; selectedNodeId?: string; byId: ReadonlyMap<string, CanvasNode>; edgeCount: number; generatedEdgeId: string },
): CanvasGraphEdge | undefined {
  const sourceNodeId = context.prior?.sourceNodeId ?? context.selectedNodeId
  if (!sourceNodeId || (!context.byId.has(draft.endpoint) && context.prior?.targetNodeId !== draft.endpoint)) return undefined
  return {
    id: context.prior?.id ?? context.generatedEdgeId, sourceNodeId, targetNodeId: draft.endpoint,
    kind: draft.kind, order: context.prior?.order ?? context.edgeCount, label: draft.label || null,
  }
}

export function mergeFrameMembers(currentMembers: readonly string[], shownChoices: readonly CanvasNode[], selectedIds: readonly string[]): string[] {
  const shown = new Set(shownChoices.map(node => node.id))
  return [...currentMembers.filter(member => !shown.has(member)), ...selectedIds]
}

export function resolveActiveArticleLink(edge: CanvasGraphEdge | undefined, byId: ReadonlyMap<string, CanvasNode>): CanvasActiveLinkPair | undefined {
  if (!edge) return undefined
  const from = byId.get(edge.sourceNodeId), to = byId.get(edge.targetNodeId)
  if (!from || !to || from.kind !== 'article-reference' || to.kind !== 'article-reference' ||
    from.pinnedRevision || to.pinnedRevision || from.articleId === to.articleId) return undefined
  return { from, to }
}

export function canApplyOptimisticNodeUpsert(
  completeGraph: boolean, command: CanvasGraphCommand, byId: ReadonlyMap<string, CanvasNode>,
  result: CanvasGraphHeader, currentNodesLength: number, currentEdgesLength: number,
): CanvasNode | undefined {
  if (!completeGraph || command.changes.length !== 1) return undefined
  const [change] = command.changes
  if (change.kind !== 'upsert-node' || !byId.has(change.node.id) ||
    result.nodeCount !== currentNodesLength || result.edgeCount !== currentEdgesLength) return undefined
  return change.node
}

export function computeHistoryAvailability(params: {
  disabled: boolean; hasOpenForm: boolean; document: CanvasGraphHeader | undefined; history: CanvasGraphHistory | undefined
}): { readonly undo: boolean; readonly redo: boolean } {
  const { disabled, hasOpenForm, document, history } = params
  const ready = !disabled && !hasOpenForm && document !== undefined && history?.revision === document.revision
  return { undo: Boolean(ready && history.undoRevision !== null), redo: Boolean(ready && history.redoRevision !== null) }
}

export function resolveHistoryShortcutAction(input: {
  defaultPrevented: boolean; repeat: boolean; isComposing: boolean
  altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; key: string
}): 'undo' | 'redo' | undefined {
  if (input.defaultPrevented || input.repeat || input.isComposing || input.altKey || input.ctrlKey === input.metaKey) return undefined
  const key = input.key.toLowerCase()
  if (key === 'z') return input.shiftKey ? 'redo' : 'undo'
  return key === 'y' && !input.shiftKey ? 'redo' : undefined
}

export function filterOutlineNodes(nodes: readonly CanvasNode[], query: string, nodeLabel: (node: CanvasNode) => string): readonly CanvasNode[] {
  const normalized = query.trim().toLowerCase()
  return normalized ? nodes.filter(node => nodeLabel(node).toLowerCase().includes(normalized) || ('anchor' in node && node.anchor.includes(normalized))) : nodes
}

export function filterOutlineEdges(edges: readonly CanvasGraphEdge[], query: string, edgeLabel: (edge: CanvasGraphEdge) => string): readonly CanvasGraphEdge[] {
  const normalized = query.trim().toLowerCase()
  return normalized ? edges.filter(edge => edgeLabel(edge).toLowerCase().includes(normalized)) : edges
}

export function sliceOutlineRecords<T>(items: readonly T[], page: number): T[] {
  const extent = Math.max(0, page) * OUTLINE_PAGE_SIZE
  return items.slice(extent, extent + OUTLINE_PAGE_SIZE)
}

export function hasNextOutlinePage(matchingNodesCount: number, matchingEdgesCount: number, page: number): boolean {
  return (Math.max(0, page) + 1) * OUTLINE_PAGE_SIZE < Math.max(matchingNodesCount, matchingEdgesCount)
}

export function filterMemberChoices(nodes: readonly CanvasNode[], filter: string, nodeLabel: (node: CanvasNode) => string): CanvasNode[] {
  const query = filter.trim().toLowerCase()
  return nodes.filter(node => node.kind !== 'group-frame' && nodeLabel(node).toLowerCase().includes(query)).slice(0, CHOICE_CAP)
}

export function filterEndpointChoices(
  nodes: readonly CanvasNode[], byId: ReadonlyMap<string, CanvasNode>,
  selectedEndpointId: string, filter: string, nodeLabel: (node: CanvasNode) => string,
): CanvasNode[] {
  const query = filter.trim().toLowerCase()
  const selected = byId.get(selectedEndpointId)
  return [
    ...(selected ? [selected] : []),
    ...nodes.filter(node => node.id !== selectedEndpointId && nodeLabel(node).toLowerCase().includes(query))
      .slice(0, selected ? CHOICE_CAP - 1 : CHOICE_CAP),
  ]
}
