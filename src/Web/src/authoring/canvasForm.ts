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

const emptyCanvasForm = () => ({
  form: undefined as 'title' | 'node' | 'edge' | undefined,
  title: '',
  nodeKind: 'plain-text-note' as CanvasNode['kind'],
  note: '',
  article: '',
  anchor: '',
  pinned: '',
  members: [] as readonly string[],
  endpoint: '',
  editingNode: undefined as CanvasNode | undefined,
  editingEdge: undefined as CanvasGraphEdge | undefined,
  choiceFilter: '',
  edgeKind: 'visual-only' as CanvasGraphEdge['kind'],
  label: '',
})

type MutableCanvasFormState = ReturnType<typeof emptyCanvasForm>
export type CanvasFormState = Readonly<MutableCanvasFormState>
export type CanvasFormFields = Omit<CanvasFormState, 'form' | 'members' | 'editingNode' | 'editingEdge'>

/**
 * Pure form-draft model for Canvas title, node, and edge dialogs.
 */
export class CanvasFormModel {
  readonly #s: MutableCanvasFormState = emptyCanvasForm()

  get isOpen(): boolean { return this.#s.form !== undefined }
  get title(): string { return this.#s.title }

  reset(clearTitle = true): void {
    this.#s.form = undefined
    this.#s.editingNode = undefined
    this.#s.editingEdge = undefined
    if (clearTitle) this.#s.title = ''
  }

  clearEditing(): void { this.reset(false) }

  update(patch: Partial<CanvasFormFields>): void {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (this.#s as Record<string, unknown>)[key] = value
    }
  }

  setFrameMembers(shownChoices: readonly CanvasNode[], selectedOptionIds: readonly string[]): void {
    this.#s.members = mergeFrameMembers(this.#s.members, shownChoices, selectedOptionIds)
  }

  openTitle(currentTitle: string | undefined): void {
    this.#s.title = currentTitle ?? ''
    this.#s.form = 'title'
  }

  openNode(kind: CanvasNode['kind'] = 'plain-text-note', existing?: CanvasNode): void {
    Object.assign(this.#s, {
      choiceFilter: '',
      nodeKind: existing?.kind ?? kind,
      note: existing && 'text' in existing ? existing.text : '',
      article: existing && 'articleId' in existing ? String(existing.articleId) : '',
      anchor: existing && 'anchor' in existing ? existing.anchor : '',
      pinned: existing && 'pinnedRevision' in existing ? existing.pinnedRevision?.toString() ?? '' : '',
      members: existing?.kind === 'group-frame' ? [...existing.memberIds] : [],
      editingNode: existing,
      form: 'node' as const,
    })
  }

  openEdge(edge?: CanvasGraphEdge): void {
    Object.assign(this.#s, {
      editingEdge: edge,
      endpoint: edge?.targetNodeId ?? '',
      choiceFilter: '',
      edgeKind: edge?.kind ?? 'visual-only',
      label: edge?.label ?? '',
      form: 'edge' as const,
    })
  }

  close(locked: boolean): boolean {
    if (locked || this.#s.form === undefined) return false
    this.#s.form = undefined
    return true
  }

  buildNode(
    canvas: CanvasGraphHeader,
    generatedNodeId: string,
  ): { readonly ok: true; readonly node: CanvasNode } | { readonly ok: false; readonly errorKey: CanvasMessageKey } {
    const s = this.#s
    return buildCanvasNode(
      { kind: s.nodeKind, text: s.note, article: s.article, anchor: s.anchor, pinned: s.pinned, memberIds: s.members },
      canvas,
      generatedNodeId,
      s.editingNode,
    )
  }

  buildEdge(context: {
    selectedNodeId: string | undefined
    byId: ReadonlyMap<string, CanvasNode>
    edgeCount: number
    generatedEdgeId: string
  }): CanvasGraphEdge | undefined {
    const s = this.#s
    return buildCanvasEdge(
      { endpoint: s.endpoint, kind: s.edgeKind, label: s.label },
      { prior: s.editingEdge, ...context },
    )
  }

  snapshot(): CanvasFormState { return { ...this.#s } }
}
