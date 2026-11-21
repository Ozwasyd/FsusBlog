import type {
  CanvasGraphEdge,
  CanvasGraphHeader,
  CanvasNode,
} from '../../../Contracts/canvas-graph.ts'
import {
  buildCanvasEdge,
  buildCanvasNode,
  mergeFrameMembers,
  type CanvasMessageKey,
} from './canvasCommands.ts'

export interface CanvasFormFields {
  readonly title: string
  readonly nodeKind: CanvasNode['kind']
  readonly note: string
  readonly article: string
  readonly anchor: string
  readonly pinned: string
  readonly endpoint: string
  readonly choiceFilter: string
  readonly edgeKind: CanvasGraphEdge['kind']
  readonly label: string
}

export interface CanvasFormState extends CanvasFormFields {
  readonly form: 'title' | 'node' | 'edge' | undefined
  readonly members: readonly string[]
  readonly editingNode: CanvasNode | undefined
  readonly editingEdge: CanvasGraphEdge | undefined
}

/**
 * Pure form-draft model for Canvas title, node, and edge dialogs.
 */
export class CanvasFormModel {
  #form: 'title' | 'node' | 'edge' | undefined
  #title = ''
  #nodeKind: CanvasNode['kind'] = 'plain-text-note'
  #note = ''
  #article = ''
  #anchor = ''
  #pinned = ''
  #members: readonly string[] = []
  #endpoint = ''
  #editingNode: CanvasNode | undefined
  #editingEdge: CanvasGraphEdge | undefined
  #choiceFilter = ''
  #edgeKind: CanvasGraphEdge['kind'] = 'visual-only'
  #label = ''

  get isOpen(): boolean {
    return this.#form !== undefined
  }

  get title(): string {
    return this.#title
  }

  reset(clearTitle = true): void {
    this.#form = undefined
    this.#editingNode = undefined
    this.#editingEdge = undefined
    if (clearTitle) this.#title = ''
  }

  clearEditing(): void {
    this.#form = undefined
    this.#editingNode = undefined
    this.#editingEdge = undefined
  }

  update(patch: Partial<CanvasFormFields>): void {
    if (patch.title !== undefined) this.#title = patch.title
    if (patch.nodeKind !== undefined) this.#nodeKind = patch.nodeKind
    if (patch.note !== undefined) this.#note = patch.note
    if (patch.article !== undefined) this.#article = patch.article
    if (patch.anchor !== undefined) this.#anchor = patch.anchor
    if (patch.pinned !== undefined) this.#pinned = patch.pinned
    if (patch.endpoint !== undefined) this.#endpoint = patch.endpoint
    if (patch.choiceFilter !== undefined) this.#choiceFilter = patch.choiceFilter
    if (patch.edgeKind !== undefined) this.#edgeKind = patch.edgeKind
    if (patch.label !== undefined) this.#label = patch.label
  }

  setFrameMembers(shownChoices: readonly CanvasNode[], selectedOptionIds: readonly string[]): void {
    this.#members = mergeFrameMembers(this.#members, shownChoices, selectedOptionIds)
  }

  openTitle(currentTitle: string | undefined): void {
    this.#title = currentTitle ?? ''
    this.#form = 'title'
  }

  openNode(kind: CanvasNode['kind'] = 'plain-text-note', existing?: CanvasNode): void {
    this.#choiceFilter = ''
    this.#nodeKind = existing?.kind ?? kind
    this.#note = existing && 'text' in existing ? existing.text : ''
    this.#article = existing && 'articleId' in existing ? String(existing.articleId) : ''
    this.#anchor = existing && 'anchor' in existing ? existing.anchor : ''
    this.#pinned = existing && 'pinnedRevision' in existing ? existing.pinnedRevision?.toString() ?? '' : ''
    this.#members = existing?.kind === 'group-frame' ? [...existing.memberIds] : []
    this.#editingNode = existing
    this.#form = 'node'
  }

  openEdge(edge?: CanvasGraphEdge): void {
    this.#editingEdge = edge
    this.#endpoint = edge?.targetNodeId ?? ''
    this.#choiceFilter = ''
    this.#edgeKind = edge?.kind ?? 'visual-only'
    this.#label = edge?.label ?? ''
    this.#form = 'edge'
  }

  close(locked: boolean): boolean {
    if (locked || this.#form === undefined) return false
    this.#form = undefined
    return true
  }

  buildNode(
    canvas: CanvasGraphHeader,
    generatedNodeId: string,
  ): { readonly ok: true; readonly node: CanvasNode } | { readonly ok: false; readonly errorKey: CanvasMessageKey } {
    return buildCanvasNode(
      {
        kind: this.#nodeKind,
        text: this.#note,
        article: this.#article,
        anchor: this.#anchor,
        pinned: this.#pinned,
        memberIds: this.#members,
      },
      canvas,
      generatedNodeId,
      this.#editingNode,
    )
  }

  buildEdge(context: {
    selectedNodeId: string | undefined
    byId: ReadonlyMap<string, CanvasNode>
    edgeCount: number
    generatedEdgeId: string
  }): CanvasGraphEdge | undefined {
    return buildCanvasEdge(
      {
        endpoint: this.#endpoint,
        kind: this.#edgeKind,
        label: this.#label,
      },
      {
        prior: this.#editingEdge,
        selectedNodeId: context.selectedNodeId,
        byId: context.byId,
        edgeCount: context.edgeCount,
        generatedEdgeId: context.generatedEdgeId,
      },
    )
  }

  snapshot(): CanvasFormState {
    return {
      form: this.#form,
      title: this.#title,
      nodeKind: this.#nodeKind,
      note: this.#note,
      article: this.#article,
      anchor: this.#anchor,
      pinned: this.#pinned,
      members: this.#members,
      endpoint: this.#endpoint,
      editingNode: this.#editingNode,
      editingEdge: this.#editingEdge,
      choiceFilter: this.#choiceFilter,
      edgeKind: this.#edgeKind,
      label: this.#label,
    }
  }
}
