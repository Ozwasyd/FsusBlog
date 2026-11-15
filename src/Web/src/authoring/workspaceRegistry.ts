export interface WorkspaceIdentity {
  readonly site: string
  readonly principalId: string
  readonly generation: bigint
  readonly expiresAt?: number
}

export interface ArticleDraft {
  readonly id: number
  readonly revision: bigint
  readonly title?: string
}

export type WorkspaceBlock = 'missing' | 'forbidden' | 'deleted' | 'expired' | 'unavailable' | 'stale-reference'

type Blocked = Readonly<{ kind: 'blocked'; reason: WorkspaceBlock }>

export type DraftLoad<Draft> = Readonly<{ kind: 'ready'; draft: Draft }> | Blocked
export type DraftSave<Draft> = Readonly<{ kind: 'saved'; draft: Draft }> | { kind: 'conflict' | 'rejected' } | Blocked

export interface EditorTransport<Draft> {
  load(id: number, signal: AbortSignal): Promise<DraftLoad<Draft>>
  save(draft: Draft, signal: AbortSignal, idempotencyKey: string): Promise<DraftSave<Draft>>
  confirmed?(write: Readonly<{
    command: WriteCommand
    sessionId: number
    previousArticleId: number
    acknowledgedEdit: number
    current: Draft
    currentEdit: number
    dirty: boolean
  }>): void
}

type ContentCommand<Draft> = (draft: Draft, signal: AbortSignal, idempotencyKey: string) => Promise<DraftSave<Draft>>
type WriteCommand = 'save' | 'publish' | 'publish-images' | 'retract' | 'assign-taxonomy' | 'rollback-history' | 'schedule-publication' | 'save-rights' | 'save-attachment'

export interface EditorSessionRef {
  readonly articleId: number
  readonly sessionId: number
}

type Risk = 'clean' | 'dirty' | 'saving' | 'conflict' | 'recovery' | 'pending' | 'blocked'
type TabMode = 'preview' | 'pinned'
export type WorkspaceGroup = 'main' | 'secondary'

export type WorkspaceTab = Readonly<EditorSessionRef & {
  title: string
  group: WorkspaceGroup
  mode: TabMode
  risk: Risk
  active: boolean
  retry?: WriteCommand
}>

export type RecentlyClosed = Readonly<{ articleId: number; title: string; group: WorkspaceGroup; mode: TabMode }>
export type WorkspaceSource<Draft> = Readonly<{ tab: WorkspaceTab; draft: Draft; selected: boolean }>
export type RecoverableCloseDraft<Draft> = Readonly<{ draft: Draft; edit: number }>
export type DiscardReservation<Draft> = Readonly<{
  drafts: readonly RecoverableCloseDraft<Draft>[]
  signal: AbortSignal
  current: () => boolean
}>

export type SavedWorkspaceLayout = Readonly<{
  tabs: readonly number[]
  activeArticleId: number
  inspectorOpen: boolean
  secondaryTabs: readonly number[]
  secondaryActiveArticleId: number
  focusedGroup: 0 | 1
}>

export type Activation =
  | Readonly<{ kind: 'ready'; tab: WorkspaceTab; workspaceRevision: number; witnessedRevision?: bigint }>
  | Blocked
  | Readonly<{ kind: 'superseded' }>
  | Readonly<{ kind: 'capacity' }>

type SaveReceipt =
  | Readonly<{ kind: 'saved'; articleId: number; revision: bigint }>
  | Readonly<{ kind: 'conflict' | 'superseded' | 'busy' | 'clean' | 'dirty' | 'rejected' }>
  | Blocked

export type ClosePlan = Readonly<{ revision: number; tabs: readonly WorkspaceTab[] }>
type CloseReceipt = Readonly<{ kind: 'closed' | 'stale' | 'protected' }>
type GroupReceipt = Readonly<{ kind: 'changed'; tab: WorkspaceTab; workspaceRevision: number }> |
  Readonly<{ kind: 'stale' | 'unchanged' }>
type Session<Draft> = {
  id: number
  sessionId: number
  group: WorkspaceGroup
  mode: TabMode
  controller: AbortController
  phase: 'loading' | 'ready' | 'blocked'
  loading?: Promise<DraftLoad<Draft> | undefined>
  draft?: Draft
  dirty: boolean
  writing?: WriteCommand
  conflict: boolean
  recovery: boolean
  pending: boolean
  block?: WorkspaceBlock
  edit: number
  request?: { command: WriteCommand; key: string; draft: Draft; edit: number; perform: ContentCommand<Draft> }
}

const equalIdentity = (a: WorkspaceIdentity | null, b: WorkspaceIdentity | null): boolean =>
  a === b || (a !== null && b !== null && a.site === b.site && a.principalId === b.principalId
    && a.generation === b.generation && a.expiresAt === b.expiresAt)

const blocked = (reason: WorkspaceBlock): Blocked => ({ kind: 'blocked', reason })

function untilAborted<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined)
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve().then(() => signal.aborted ? undefined : action()).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

/**
 * One identity scope and one session per article. Route and group controls consume immutable tab
 * views. The draft belongs to its session. Transport results publish only to the session that
 * started them, and only while the identity is still current.
 */
export class WorkspaceRegistry<Draft extends ArticleDraft> {
  readonly #sessions = new Map<number, Session<Draft>>()
  readonly #recent: RecentlyClosed[] = []
  readonly #listeners = new Set<() => void>()
  readonly #transport: EditorTransport<Draft>
  readonly #limit: number
  readonly #now: () => number
  readonly #newRequestKey: () => string
  #identity: WorkspaceIdentity | null = null
  #expired = false
  #active: Session<Draft> | undefined
  readonly #selected: Partial<Record<WorkspaceGroup, Session<Draft>>> = {}
  #retainedSource: Session<Draft> | undefined
  #inspectorOpen = false
  #opening: AbortController | undefined
  #discarding: { reservation: DiscardReservation<Draft>; controller: AbortController; sessions: Set<Session<Draft>> } | undefined
  #activation = 0
  #sequence = 0
  #editSequence = 0
  #revision = 0

  constructor(
    transport: EditorTransport<Draft>,
    limit = 100,
    now = Date.now,
    newRequestKey = () => crypto.randomUUID(),
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid workspace capacity')
    this.#transport = transport
    this.#limit = limit
    this.#now = now
    this.#newRequestKey = newRequestKey
  }

  get revision(): number {
    return this.#revision
  }

  get activeTab(): WorkspaceTab | undefined {
    return this.#active && this.#currentIdentity() ? this.#view(this.#active) : undefined
  }

  get activeDraft(): Draft | undefined {
    const draft = this.#currentIdentity() && this.#active?.draft
    return draft ? structuredClone(draft) : undefined
  }

  get activeEditSequence(): number {
    return this.#active && this.#currentIdentity() ? this.#active.edit : 0
  }

  get hasSecondaryGroup(): boolean {
    return this.#currentIdentity() && Array.from(this.#sessions.values()).some(session =>
      session.group === 'secondary' && session.phase !== 'loading')
  }

  get sourcePanes(): readonly WorkspaceSource<Draft>[] {
    if (!this.#currentIdentity()) return []
    const panes: WorkspaceSource<Draft>[] = []
    const append = (session: Session<Draft> | undefined, selected: boolean) => {
      if (session?.phase === 'ready' && session.draft)
        panes.push(Object.freeze({ tab: this.#view(session), draft: structuredClone(session.draft), selected }))
    }
    append(this.#selected.main, true)
    append(this.#selected.secondary, true)
    if (panes.length < 2 && this.#retainedSource !== this.#selected.main && this.#retainedSource !== this.#selected.secondary)
      append(this.#retainedSource, false)
    // Vue can keep both source hosts in the same DOM order during ownership changes.
    panes.sort((left, right) => left.tab.sessionId - right.tab.sessionId)
    return Object.freeze(panes)
  }

  moveActiveTab(tab: EditorSessionRef, destination: WorkspaceGroup, expectedRevision: number): GroupReceipt {
    const session = this.#groupChange(tab, expectedRevision)
    if (!session || (destination !== 'main' && destination !== 'secondary')) return { kind: 'stale' }
    const source = session.group
    if (destination === source || !this.hasSecondaryGroup) return { kind: 'unchanged' }

    const previousSelection = this.#selected[destination]
    const restored = this.#retainedSource?.group === source ? this.#retainedSource : undefined
    this.#selected[source] = restored
    this.#selected[destination] = session
    this.#retainedSource = previousSelection ?? (restored ? undefined : this.#retainedSource)
    this.#placement(session, destination)
    return this.#finishGroupChange(session)
  }

  mergeGroups(tab: EditorSessionRef, expectedRevision: number): GroupReceipt {
    const active = this.#groupChange(tab, expectedRevision)
    if (!active) return { kind: 'stale' }
    const incoming = Array.from(this.#sessions.values()).filter(session => session.group === 'secondary')
    if (!incoming.length) return { kind: 'unchanged' }

    const otherSelection = active.group === 'main' ? this.#selected.secondary : this.#selected.main
    this.#retainedSource = otherSelection ?? this.#retainedSource
    for (const session of incoming) this.#placement(session, 'main')
    this.#selected.main = active
    delete this.#selected.secondary
    return this.#finishGroupChange(active)
  }

  async recheckComparison(tab: EditorSessionRef, signal: AbortSignal): Promise<boolean> {
    const session = this.#find(tab)
    if (!session?.draft || session.phase !== 'ready' || this.#selected[session.group] !== session || signal.aborted)
      return false
    if (session === this.#active || session.id === 0) return true
    const activation = this.#activation
    const current = AbortSignal.any([signal, session.controller.signal])
    const result = await untilAborted(current, () => this.#transport.load(session.id, current)).catch(() => undefined)
    if (current.aborted || activation !== this.#activation || this.#find(tab) !== session ||
        this.#selected[session.group] !== session || session === this.#active)
      return false
    if (result?.kind === 'blocked' && result.reason !== 'unavailable') this.invalidate(tab, result.reason)
    if (result?.kind !== 'ready' || result.draft.id !== session.id || result.draft.revision < session.draft.revision) return false
    if (session.draft.revision !== result.draft.revision) {
      if (this.#risk(session) === 'clean') session.draft = structuredClone(result.draft)
      else if (!session.request && !session.writing) session.conflict = true
      this.#changed()
    }
    return true
  }

  get tabs(): readonly WorkspaceTab[] {
    if (!this.#currentIdentity()) return Object.freeze([])
    return Object.freeze(Array.from(this.#sessions.values())
      .filter(session => session.phase !== 'loading')
      .map(session => this.#view(session)))
  }

  get recentlyClosed(): readonly RecentlyClosed[] {
    return this.#currentIdentity() ? Object.freeze([...this.#recent]) : Object.freeze([])
  }

  get savedLayout(): SavedWorkspaceLayout {
    if (!this.#currentIdentity()) return { tabs: [], activeArticleId: 0, inspectorOpen: false,
      secondaryTabs: [], secondaryActiveArticleId: 0, focusedGroup: 0 }
    const byGroup: Record<WorkspaceGroup, number[]> = { main: [], secondary: [] }
    for (const session of this.#sessions.values()) {
      if (session.phase === 'ready' && session.id > 0)
        byGroup[session.group].push(session.mode === 'pinned' ? session.id : -session.id)
    }
    const activeArticleId = this.#active ? this.#selected.main?.id ?? 0 : 0
    const secondaryActiveArticleId = this.#active ? this.#selected.secondary?.id ?? 0 : 0
    return {
      tabs: byGroup.main,
      activeArticleId,
      inspectorOpen: this.#inspectorOpen,
      secondaryTabs: byGroup.secondary,
      secondaryActiveArticleId,
      focusedGroup: this.#active?.group === 'secondary' && secondaryActiveArticleId > 0 ? 1 : 0,
    }
  }

  get inspectorOpen(): boolean {
    return this.#currentIdentity() && this.#inspectorOpen
  }

  editSequence(tab: EditorSessionRef): number | undefined {
    return this.#find(tab)?.edit
  }

  setInspectorOpen(tab: EditorSessionRef, open: boolean): void {
    const session = this.#find(tab)
    if (!session || session !== this.#active || session.id === 0 || this.#inspectorOpen === open) return
    this.#inspectorOpen = open
    this.#changed()
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  setIdentity(identity: WorkspaceIdentity | null): void {
    const next = identity ? Object.freeze({ ...identity }) : null
    if (equalIdentity(this.#identity, next)) return
    this.#identity = next
    this.#expired = false
    this.#clear()
    this.#changed()
  }

  updateIdentityExpiry(expiresAt: number): void {
    if (!this.#identity || this.#expired || !Number.isFinite(expiresAt) || expiresAt <= this.#now()
        || this.#identity.expiresAt === expiresAt) return
    this.#identity = Object.freeze({ ...this.#identity, expiresAt })
  }

  async restoreLayout(layout: SavedWorkspaceLayout, signal: AbortSignal): Promise<number | undefined> {
    const total = layout.tabs.length + layout.secondaryTabs.length
    if (signal.aborted || !this.#currentIdentity() || this.#sessions.size !== 0 || total > this.#limit)
      return undefined
    const validGroup = (tabs: readonly number[], active: number) => tabs.filter(id => id < 0).length <= 1 &&
      (active === 0 || active > 0 && tabs.some(id => Math.abs(id) === active))
    const main = layout.tabs.map(value => ({ value, group: 'main' as const }))
    const secondary = layout.secondaryTabs.map(value => ({ value, group: 'secondary' as const }))
    const references = [...main, ...secondary]
    if (new Set(references.map(ref => Math.abs(ref.value))).size !== total ||
        references.some(({ value }) => !Number.isInteger(value) || value === 0 || Math.abs(value) > 2_147_483_647) ||
        !validGroup(layout.tabs, layout.activeArticleId) || !validGroup(layout.secondaryTabs, layout.secondaryActiveArticleId) ||
        (layout.focusedGroup !== 0 && layout.focusedGroup !== 1) || (layout.focusedGroup === 1 && layout.secondaryActiveArticleId === 0))
      return undefined
    const intent = ++this.#activation
    const restored: { id: number; group: WorkspaceGroup; mode: TabMode; draft: Draft }[] = []
    // Load every retained position through the normal draft authority, publishing no intermediate active tab.
    // Batches stay below the shared command concurrency limit and retain the server's order.
    for (let index = 0; index < total; index += 8) {
      const batch = await Promise.all(references.slice(index, index + 8).map(async ({ value, group }) => {
        const id = Math.abs(value)
        const loaded = await untilAborted(signal, () => this.#transport.load(id, signal)).catch(() => undefined)
        if (loaded?.kind === 'blocked' && (loaded.reason === 'missing' || loaded.reason === 'deleted' || loaded.reason === 'forbidden')) return null
        if (loaded?.kind !== 'ready' || loaded.draft.id !== id || loaded.draft.revision <= 0n) return undefined
        return { id, group, mode: value > 0 ? 'pinned' as const : 'preview' as const, draft: loaded.draft }
      }))
      if (signal.aborted || intent !== this.#activation || !this.#currentIdentity() || batch.includes(undefined)) return undefined
      for (const item of batch) {
        if (item) restored.push(item)
      }
    }
    if (signal.aborted || intent !== this.#activation || !this.#currentIdentity()) return undefined
    for (const item of restored) {
      this.#sessions.set(item.id, { ...item, draft: structuredClone(item.draft), sessionId: ++this.#sequence,
        controller: new AbortController(), phase: 'ready', dirty: false, conflict: false, recovery: false, pending: false, edit: 0 })
    }
    this.#selected.main = this.#sessions.get(layout.activeArticleId)
    this.#selected.secondary = this.#sessions.get(layout.secondaryActiveArticleId)
    this.#active = layout.focusedGroup === 1 ? this.#selected.secondary ?? this.#selected.main : this.#selected.main ?? this.#selected.secondary
    this.#inspectorOpen = layout.inspectorOpen
    if (restored.length || this.#inspectorOpen) this.#changed()
    return total - restored.length
  }

  async openOrActivate(
    articleId: number,
    group: WorkspaceGroup = this.#active?.group ?? 'main',
    mode: TabMode = 'preview',
    canActivate: () => boolean = () => true,
    requiredRevision?: bigint,
  ): Promise<Activation> {
    if (!Number.isSafeInteger(articleId) || articleId < 0) return blocked('missing')
    if (!this.#currentIdentity()) return blocked(this.#identity ? 'expired' : 'forbidden')
    if (group !== 'main' && group !== 'secondary') return blocked('unavailable')
    if (this.#discarding) return blocked('unavailable')

    const intent = ++this.#activation
    this.#opening?.abort()
    for (const session of this.#sessions.values()) {
      if (session.id !== articleId && session.phase === 'loading') this.#remove(session)
    }
    let session = this.#sessions.get(articleId)
    if (session?.phase === 'blocked') return blocked(session.block ?? 'forbidden')

    if (!session) {
      if (articleId === 0) return blocked('missing')
      // Keep a clean preview until its replacement proves it can actually open.
      const canReplace = mode === 'preview' && this.#cleanPreview(group)
      if (this.#sessions.size >= this.#limit && !canReplace) return { kind: 'capacity' }
      const controller = new AbortController()
      session = {
        id: articleId, sessionId: ++this.#sequence, group, mode, controller,
        phase: 'loading', dirty: false, conflict: false, recovery: false, pending: false, edit: 0,
        loading: untilAborted(controller.signal, () => this.#transport.load(articleId, controller.signal))
          .catch(() => blocked('unavailable')),
      }
      this.#sessions.set(articleId, session)
    }

    let witnessedRevision: bigint | undefined
    if (session.phase === 'ready' && session.id > 0 && (session !== this.#active || requiredRevision !== undefined)) {
      const { id } = session
      const opening = new AbortController()
      this.#opening = opening
      const signal = AbortSignal.any([opening.signal, session.controller.signal])
      const result = await untilAborted(signal, () => this.#transport.load(id, signal))
        .catch(() => blocked('unavailable'))
      if (this.#opening === opening) this.#opening = undefined
      if (intent !== this.#activation || !canActivate() || this.#sessions.get(id) !== session)
        return { kind: 'superseded' }
      if (!this.#currentIdentity()) return blocked('expired')
      if (result?.kind !== 'ready' || result.draft.id !== id || result.draft.revision <= 0n) {
        if (result?.kind === 'blocked' && result.reason !== 'unavailable') {
          this.invalidate({ articleId: id, sessionId: session.sessionId }, result.reason)
          return result
        }
        return blocked('unavailable')
      }
      if (requiredRevision !== undefined && (result.draft.revision !== requiredRevision || this.#risk(session) !== 'clean'))
        return blocked('stale-reference')
      if (this.#risk(session) === 'clean') session.draft = structuredClone(result.draft)
      else if (session.draft?.revision !== result.draft.revision && !session.request && !session.writing)
        session.conflict = true
      witnessedRevision = result.draft.revision
    }

    if (session.phase === 'loading') {
      const result = await session.loading
      if (intent !== this.#activation || this.#sessions.get(articleId) !== session) return { kind: 'superseded' }
      if (!this.#currentIdentity()) {
        this.#remove(session)
        return blocked('expired')
      }
      if (result?.kind !== 'ready' || result.draft.id !== articleId || result.draft.revision <= 0n) {
        this.#remove(session)
        return result?.kind === 'blocked' ? result : blocked('unavailable')
      }
      if (!canActivate()) {
        this.#remove(session)
        return { kind: 'superseded' }
      }
      if (requiredRevision !== undefined && result.draft.revision !== requiredRevision) {
        this.#remove(session)
        return blocked('stale-reference')
      }
      const currentPreview = session.mode === 'preview' && mode === 'preview' ? this.#cleanPreview(session.group) : undefined
      if (currentPreview) this.#remove(currentPreview)
      if (this.#sessions.size > this.#limit) {
        this.#remove(session)
        return { kind: 'capacity' }
      }
      session.draft = structuredClone(result.draft)
      witnessedRevision = result.draft.revision
      delete session.loading
      session.phase = 'ready'
    }
    if (!canActivate()) return { kind: 'superseded' }
    if (mode === 'pinned') session.mode = mode
    this.#active = session
    if (this.#retainedSource === session) this.#retainedSource = this.#selected[session.group]
    this.#selected[session.group] = session
    if (this.#selected.main && this.#selected.secondary) this.#retainedSource = undefined
    this.#forgetRecent(articleId)
    this.#changed()
    if (intent !== this.#activation || this.#active !== session || !this.#currentIdentity()) return { kind: 'superseded' }
    return { kind: 'ready', tab: this.#view(session), workspaceRevision: this.#revision, witnessedRevision }
  }

  startDraft(draft: Draft, group: WorkspaceGroup = this.#active?.group ?? 'main'): Promise<Activation> {
    if (draft.id !== 0 || draft.revision !== 0n) return Promise.resolve(blocked('missing'))
    if (!this.#currentIdentity()) return Promise.resolve(blocked(this.#identity ? 'expired' : 'forbidden'))
    if (this.#discarding) return Promise.resolve(blocked('unavailable'))
    if (group !== 'main' && group !== 'secondary') return Promise.resolve(blocked('unavailable'))
    if (!this.#sessions.has(0)) {
      const visibleCount = Array.from(this.#sessions.values()).filter(session => session.phase !== 'loading').length
      if (visibleCount >= this.#limit) return Promise.resolve({ kind: 'capacity' })
      this.#sessions.set(0, {
        id: 0, sessionId: ++this.#sequence, group, mode: 'pinned', draft: structuredClone(draft),
        controller: new AbortController(), phase: 'ready', dirty: false, conflict: false,
        recovery: false, pending: false, edit: 0,
      })
    }
    return this.openOrActivate(0, group, 'pinned')
  }

  pin(tab: EditorSessionRef): boolean {
    const session = this.#find(tab)
    if (!session || session.phase !== 'ready') return false
    if (session.mode !== 'pinned') {
      session.mode = 'pinned'
      this.#changed()
    }
    return true
  }

  unpin(tab: EditorSessionRef): boolean {
    const session = this.#find(tab)
    if (!session || session.id === 0 || session.phase !== 'ready' || this.#risk(session) !== 'clean'
      || this.#cleanPreview(session.group)) return false
    if (session.mode === 'preview') return true
    session.mode = 'preview'
    this.#changed()
    return true
  }

  cancelOpening(): void {
    ++this.#activation
    this.#opening?.abort()
    this.#opening = undefined
    for (const session of this.#sessions.values()) if (session.phase === 'loading') this.#remove(session)
  }

  updateDraft(tab: EditorSessionRef, draft: Draft): boolean {
    const session = this.#find(tab)
    if (!session?.draft || session !== this.#active || draft.id !== session.id
      || draft.revision !== session.draft.revision) return false
    if (session.writing && session.writing !== 'save') return false
    session.draft = structuredClone(draft)
    session.mode = 'pinned'
    session.dirty = true
    session.edit = ++this.#editSequence
    this.#changed()
    return true
  }

  setObligation(tab: EditorSessionRef, obligation: 'pending' | 'recovery', value: boolean): boolean {
    const session = this.#find(tab)
    if (!session || session.phase !== 'ready') return false
    if (session[obligation] !== value) {
      session[obligation] = value
      if (value) session.mode = 'pinned'
      this.#changed()
    }
    return true
  }

  save(tab: EditorSessionRef): Promise<SaveReceipt> {
    return this.#write(tab, 'save', (draft, signal, key) => this.#transport.save(draft, signal, key))
  }

  commit(tab: EditorSessionRef, command: Exclude<WriteCommand, 'save'>, perform: ContentCommand<Draft>): Promise<SaveReceipt> {
    return this.#write(tab, command, perform)
  }

  retry(tab: EditorSessionRef): Promise<SaveReceipt> {
    const request = this.#find(tab)?.request
    return request ? this.#write(tab, request.command, request.perform) : Promise.resolve({ kind: 'superseded' })
  }

  async #write(tab: EditorSessionRef, command: WriteCommand, perform: ContentCommand<Draft>): Promise<SaveReceipt> {
    const session = this.#find(tab)
    if (!session?.draft) return { kind: 'superseded' }
    if (session.writing || session.pending || session.recovery) return { kind: 'busy' }
    if (session.conflict) return { kind: 'conflict' }
    if (session.request && session.request.command !== command) return { kind: 'busy' }
    if (!session.request && command === 'save' && !session.dirty) return { kind: 'clean' }
    if (!session.request && command !== 'save' && (session.dirty || session.id === 0)) return { kind: 'dirty' }

    const { draft, edit, key, perform: performCommand } = session.request ??= {
      command, key: this.#newRequestKey(), draft: structuredClone(session.draft), edit: session.edit, perform,
    }
    session.writing = command
    this.#changed()

    const result = await untilAborted(session.controller.signal, () => performCommand(structuredClone(draft), session.controller.signal, key))
      .catch(() => blocked('unavailable'))
    if (!result || this.#find(tab) !== session || session.phase !== 'ready' || !session.draft) {
      return { kind: 'superseded' }
    }
    delete session.writing
    if (result.kind === 'conflict') session.conflict = true
    if (result.kind === 'conflict' || result.kind === 'rejected') delete session.request
    if (result.kind === 'saved') {
      const articleId = result.draft.id
      const creating = session.id === 0
      if (result.draft.revision <= draft.revision || (creating
        ? !Number.isSafeInteger(articleId) || articleId < 1 || this.#sessions.has(articleId)
        : articleId !== session.id)) {
        this.#changed()
        return blocked('unavailable')
      }
      if (creating) {
        this.#sessions.delete(0)
        session.id = articleId
        this.#sessions.set(articleId, session)
      }
      if (session.edit === edit) {
        session.draft = structuredClone(result.draft)
        session.dirty = false
      } else {
        session.draft = { ...session.draft, id: articleId, revision: result.draft.revision }
      }
      delete session.request
      try {
        this.#transport.confirmed?.({
          command, sessionId: session.sessionId, previousArticleId: draft.id, acknowledgedEdit: edit,
          current: structuredClone(session.draft), currentEdit: session.edit, dirty: session.dirty,
        })
      } catch {
        // A local recovery failure cannot change an acknowledged server write.
      }
    }
    if (result.kind === 'blocked' && result.reason !== 'unavailable') {
      this.invalidate(tab, result.reason)
    } else {
      this.#changed()
    }
    if (result.kind !== 'saved') return result
    if (!this.#currentIdentity() || this.#sessions.get(session.id) !== session || session.phase !== 'ready') {
      return { kind: 'superseded' }
    }
    return { kind: 'saved', articleId: session.id, revision: result.draft.revision }
  }

  invalidate(tab: EditorSessionRef, reason: WorkspaceBlock): boolean {
    const session = this.#find(tab)
    if (!session || session.phase !== 'ready') return false
    session.phase = 'blocked'
    session.block = reason
    delete session.draft
    delete session.request
    session.mode = 'pinned'
    session.controller.abort()
    this.#unselect(session)
    this.#changed()
    return true
  }

  planClose(tabs: readonly EditorSessionRef[]): ClosePlan | undefined {
    const unique = new Set<Session<Draft>>()
    for (const tab of tabs) {
      const session = this.#find(tab)
      if (!session || session.phase === 'loading') return undefined
      unique.add(session)
    }
    return Object.freeze({
      revision: this.#revision,
      tabs: Object.freeze(Array.from(unique, session => this.#view(session))),
    })
  }

  applyClose(plan: ClosePlan): CloseReceipt {
    if (plan.revision !== this.#revision) return { kind: 'stale' }
    const sessions: Session<Draft>[] = []
    for (const tab of plan.tabs) {
      const session = this.#find(tab)
      if (!session || session.phase === 'loading') return { kind: 'stale' }
      if (this.#risk(session) !== 'clean') return { kind: 'protected' }
      sessions.push(session)
    }
    if (sessions.length > 0) {
      for (const session of sessions) this.#close(session)
      this.#changed()
    }
    return { kind: 'closed' }
  }

  recoveryDraftsForClose(plan: ClosePlan): readonly RecoverableCloseDraft<Draft>[] | undefined {
    if (plan.revision !== this.#revision) return undefined
    const sources: RecoverableCloseDraft<Draft>[] = []
    for (const tab of plan.tabs) {
      const session = this.#find(tab)
      if (!session || session.phase !== 'ready' || !session.draft) return undefined
      const risk = this.#risk(session)
      if (risk === 'clean') continue
      if (risk !== 'dirty' || session.id <= 0 || session.edit <= 0) return undefined
      sources.push({ draft: structuredClone(session.draft), edit: session.edit })
    }
    return sources
  }

  reserveDiscard(plan: ClosePlan): DiscardReservation<Draft> | undefined {
    const active = this.#active
    if (!active || this.#discarding || this.#opening || Array.from(this.#sessions.values()).some(session => session.phase === 'loading'))
      return undefined
    const drafts = this.recoveryDraftsForClose(plan)
    if (!drafts?.length) return undefined
    const sessions = new Set<Session<Draft>>()
    for (const tab of plan.tabs) {
      const session = this.#find(tab)
      if (!session || session === active || session.group !== active.group || session.id <= 0) return undefined
      sessions.add(session)
    }
    const controller = new AbortController()
    const reservation: DiscardReservation<Draft> = Object.freeze({
      drafts, signal: controller.signal,
      current: () => this.#discarding?.reservation === reservation && this.#currentIdentity(),
    })
    this.#discarding = { reservation, controller, sessions }
    return reservation
  }

  completeDiscard(reservation: DiscardReservation<Draft>, committed: boolean): CloseReceipt {
    const held = this.#discarding
    if (!held || held.reservation !== reservation || !reservation.current()) return { kind: 'stale' }
    this.#discarding = undefined
    if (!committed) {
      held.controller.abort()
      return { kind: 'protected' }
    }
    for (const session of held.sessions) this.#close(session)
    this.#changed()
    return { kind: 'closed' }
  }

  requestClose(tab: EditorSessionRef): CloseReceipt {
    const plan = this.planClose([tab])
    return plan ? this.applyClose(plan) : { kind: 'stale' }
  }

  discard(tab: EditorSessionRef, confirmedRevision: number): CloseReceipt {
    const plan = this.planClose([tab])
    return plan && plan.revision === confirmedRevision ? this.discardMany(plan) : { kind: 'stale' }
  }

  discardMany(plan: ClosePlan): CloseReceipt {
    if (plan.revision !== this.#revision) return { kind: 'stale' }
    const sessions = new Set<Session<Draft>>()
    for (const tab of plan.tabs) {
      const session = this.#find(tab)
      if (!session || session.phase === 'loading') return { kind: 'stale' }
      if (session.writing || session.request || session.pending || session.recovery) return { kind: 'protected' }
      sessions.add(session)
    }
    if (sessions.size) {
      for (const session of sessions) this.#close(session)
      this.#changed()
    }
    return { kind: 'closed' }
  }

  idle(): void {
    this.cancelOpening()
    if (this.#active) {
      this.#active = undefined
      this.#changed()
    }
  }

  #currentIdentity(): boolean {
    const identity = this.#identity
    if (identity === null || this.#expired) return false
    if (identity.expiresAt === undefined || this.#now() < identity.expiresAt) return true
    this.#expired = true
    this.#clear()
    queueMicrotask(() => {
      if (this.#identity === identity && this.#expired) this.#changed()
    })
    return false
  }

  #find(tab: EditorSessionRef): Session<Draft> | undefined {
    if (!this.#currentIdentity()) return undefined
    const session = this.#sessions.get(tab.articleId)
    return session && session.sessionId === tab.sessionId && !this.#discarding?.sessions.has(session) ? session : undefined
  }

  #cleanPreview(group: WorkspaceGroup): Session<Draft> | undefined {
    return Array.from(this.#sessions.values()).find(session =>
      session.phase === 'ready' && session.group === group && session.mode === 'preview' && this.#risk(session) === 'clean')
  }

  #groupChange(tab: EditorSessionRef, expectedRevision: number): Session<Draft> | undefined {
    const session = this.#find(tab)
    if (this.#revision !== expectedRevision || !session || session !== this.#active || session.phase !== 'ready' ||
        this.#opening || this.#discarding || Array.from(this.#sessions.values()).some(entry => entry.phase === 'loading')) return undefined
    return session
  }

  #placement(session: Session<Draft>, group: WorkspaceGroup): void {
    if (session.mode === 'preview' && this.#cleanPreview(group)) session.mode = 'pinned'
    session.group = group
    // Reinsert at the end so the destination's existing tab order stays intact.
    this.#sessions.delete(session.id)
    this.#sessions.set(session.id, session)
  }

  #finishGroupChange(session: Session<Draft>): GroupReceipt {
    ++this.#activation
    this.#changed()
    if (this.#active !== session || !this.#currentIdentity()) return { kind: 'stale' }
    return { kind: 'changed', tab: this.#view(session), workspaceRevision: this.#revision }
  }

  #risk(session: Session<Draft>): Risk {
    if (session.phase === 'blocked') return 'blocked'
    if (session.conflict) return 'conflict'
    if (session.recovery) return 'recovery'
    if (session.pending) return 'pending'
    if (session.writing) return 'saving'
    if (session.request) return 'recovery'
    return session.dirty ? 'dirty' : 'clean'
  }

  #view(session: Session<Draft>): WorkspaceTab {
    return Object.freeze({
      articleId: session.id, sessionId: session.sessionId, group: session.group, mode: session.mode,
      title: session.draft?.title?.trim() || (session.id === 0 ? 'New draft' : `Article ${session.id}`),
      risk: this.#risk(session), active: session === this.#active,
      ...(!session.writing && session.request ? { retry: session.request.command } : {}),
    })
  }

  #forgetRecent(articleId: number): void {
    const index = this.#recent.findIndex(item => item.articleId === articleId)
    if (index !== -1) this.#recent.splice(index, 1)
  }

  #close(session: Session<Draft>): void {
    if (session.id > 0 && session.phase === 'ready') {
      this.#forgetRecent(session.id)
      // Closed items omit the title until the backing article is loaded again and reauthorized.
      this.#recent.unshift(Object.freeze({
        articleId: session.id, title: `Article ${session.id}`, group: session.group, mode: session.mode,
      }))
      if (this.#recent.length > 12) this.#recent.pop()
    }
    this.#remove(session)
  }

  #remove(session: Session<Draft>): void {
    if (this.#sessions.get(session.id) !== session) return
    this.#sessions.delete(session.id)
    this.#unselect(session)
    delete session.draft
    delete session.request
    session.controller.abort()
  }

  #unselect(session: Session<Draft>): void {
    if (this.#active === session) this.#active = undefined
    if (this.#selected[session.group] === session) delete this.#selected[session.group]
    if (this.#retainedSource === session) this.#retainedSource = undefined
  }

  #clear(): void {
    this.#discarding?.controller.abort()
    this.#discarding = undefined
    const previous = Array.from(this.#sessions.values())
    this.#sessions.clear()
    this.#recent.length = 0
    this.#active = undefined
    this.#retainedSource = undefined
    delete this.#selected.main
    delete this.#selected.secondary
    this.#inspectorOpen = false
    this.cancelOpening()
    for (const session of previous) {
      delete session.draft
      delete session.request
      session.controller.abort()
    }
  }

  #changed(): void {
    this.#revision++
    for (const listener of this.#listeners) listener()
  }
}
