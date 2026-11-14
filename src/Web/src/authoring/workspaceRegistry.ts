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

export type WorkspaceBlock = 'missing' | 'forbidden' | 'deleted' | 'expired' | 'unavailable'

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
type WriteCommand = 'save' | 'publish' | 'retract' | 'assign-taxonomy' | 'rollback-history' | 'schedule-publication' | 'save-rights' | 'save-attachment'

export interface EditorSessionRef {
  readonly articleId: number
  readonly sessionId: number
}

type Risk = 'clean' | 'dirty' | 'saving' | 'conflict' | 'recovery' | 'pending' | 'blocked'
type TabMode = 'preview' | 'pinned'

export type WorkspaceTab = Readonly<EditorSessionRef & {
  title: string
  group: string
  mode: TabMode
  risk: Risk
  active: boolean
  retry?: WriteCommand
}>

export type RecentlyClosed = Readonly<{ articleId: number; title: string; group: string; mode: TabMode }>

export type SavedWorkspaceLayout = Readonly<{ tabs: readonly number[]; activeArticleId: number }>

export type Activation =
  | Readonly<{ kind: 'ready'; tab: WorkspaceTab; workspaceRevision: number }>
  | Blocked
  | Readonly<{ kind: 'superseded' }>
  | Readonly<{ kind: 'capacity' }>

type SaveReceipt =
  | Readonly<{ kind: 'saved'; articleId: number; revision: bigint }>
  | Readonly<{ kind: 'conflict' | 'superseded' | 'busy' | 'clean' | 'dirty' | 'rejected' }>
  | Blocked

type ClosePlan = Readonly<{ revision: number; tabs: readonly WorkspaceTab[] }>
type CloseReceipt = Readonly<{ kind: 'closed' | 'stale' | 'protected' }>
type Session<Draft> = {
  id: number
  sessionId: number
  group: string
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
  #opening: AbortController | undefined
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
    if (!this.#currentIdentity()) return { tabs: [], activeArticleId: 0 }
    return {
      tabs: [...this.#sessions.values()].filter(session => session.id > 0 && session.phase === 'ready')
        .map(session => session.mode === 'pinned' ? session.id : -session.id),
      activeArticleId: this.#active?.id ?? 0,
    }
  }

  editSequence(tab: EditorSessionRef): number | undefined {
    return this.#find(tab)?.edit
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

  async restoreLayout(layout: SavedWorkspaceLayout, signal: AbortSignal): Promise<number | undefined> {
    if (signal.aborted || !this.#currentIdentity() || this.#sessions.size !== 0 || layout.tabs.length > this.#limit)
      return undefined
    const ids = new Set(layout.tabs.map(Math.abs))
    if (ids.size !== layout.tabs.length || layout.tabs.some(id => !Number.isInteger(id) || id === 0 || Math.abs(id) > 2_147_483_647) ||
        layout.tabs.filter(id => id < 0).length > 1 || (layout.activeArticleId !== 0 && !ids.has(layout.activeArticleId))) return undefined
    const intent = ++this.#activation
    const restored: { id: number; mode: TabMode; draft: Draft }[] = []
    // Load every retained position through the normal draft authority, publishing no intermediate active tab.
    // Batches stay below the shared command concurrency limit and retain the server's order.
    for (let index = 0; index < layout.tabs.length; index += 8) {
      const batch = await Promise.all(layout.tabs.slice(index, index + 8).map(async reference => {
        const id = Math.abs(reference)
        const loaded = await untilAborted(signal, () => this.#transport.load(id, signal)).catch(() => undefined)
        if (loaded?.kind === 'blocked' && (loaded.reason === 'missing' || loaded.reason === 'deleted' || loaded.reason === 'forbidden')) return null
        if (loaded?.kind !== 'ready' || loaded.draft.id !== id || loaded.draft.revision <= 0n) return undefined
        return { id, mode: reference > 0 ? 'pinned' as const : 'preview' as const, draft: loaded.draft }
      }))
      if (signal.aborted || intent !== this.#activation || !this.#currentIdentity() || batch.includes(undefined)) return undefined
      for (const item of batch) {
        if (item) restored.push(item)
      }
    }
    if (signal.aborted || intent !== this.#activation || !this.#currentIdentity()) return undefined
    for (const item of restored) {
      this.#sessions.set(item.id, { ...item, draft: structuredClone(item.draft), sessionId: ++this.#sequence, group: 'main',
        controller: new AbortController(), phase: 'ready', dirty: false, conflict: false, recovery: false, pending: false, edit: 0 })
    }
    this.#active = this.#sessions.get(layout.activeArticleId)
    if (restored.length) this.#changed()
    return layout.tabs.length - restored.length
  }

  async openOrActivate(
    articleId: number,
    group = this.#active?.group ?? 'main',
    mode: TabMode = 'preview',
    canActivate: () => boolean = () => true,
  ): Promise<Activation> {
    if (!Number.isSafeInteger(articleId) || articleId < 0) return blocked('missing')
    if (!this.#currentIdentity()) return blocked(this.#identity ? 'expired' : 'forbidden')

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

    if (session.phase === 'ready' && session.id > 0 && session !== this.#active) {
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
      if (this.#risk(session) === 'clean') session.draft = structuredClone(result.draft)
      else if (session.draft?.revision !== result.draft.revision && !session.request && !session.writing)
        session.conflict = true
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
      const currentPreview = session.mode === 'preview' && mode === 'preview' ? this.#cleanPreview(session.group) : undefined
      if (currentPreview) this.#remove(currentPreview)
      if (this.#sessions.size > this.#limit) {
        this.#remove(session)
        return { kind: 'capacity' }
      }
      session.draft = structuredClone(result.draft)
      delete session.loading
      session.phase = 'ready'
    }
    if (!canActivate()) return { kind: 'superseded' }
    if (mode === 'pinned') session.mode = mode
    this.#active = session
    this.#forgetRecent(articleId)
    this.#changed()
    if (intent !== this.#activation || this.#active !== session || !this.#currentIdentity()) return { kind: 'superseded' }
    return { kind: 'ready', tab: this.#view(session), workspaceRevision: this.#revision }
  }

  startDraft(draft: Draft, group = this.#active?.group ?? 'main'): Promise<Activation> {
    if (draft.id !== 0 || draft.revision !== 0n) return Promise.resolve(blocked('missing'))
    if (!this.#currentIdentity()) return Promise.resolve(blocked(this.#identity ? 'expired' : 'forbidden'))
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
    if (this.#active === session) this.#active = undefined
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
    return session?.sessionId === tab.sessionId ? session : undefined
  }

  #cleanPreview(group: string): Session<Draft> | undefined {
    return Array.from(this.#sessions.values()).find(session =>
      session.phase === 'ready' && session.group === group && session.mode === 'preview' && this.#risk(session) === 'clean')
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
    if (this.#active === session) this.#active = undefined
    delete session.draft
    delete session.request
    session.controller.abort()
  }

  #clear(): void {
    const previous = Array.from(this.#sessions.values())
    this.#sessions.clear()
    this.#recent.length = 0
    this.#active = undefined
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
