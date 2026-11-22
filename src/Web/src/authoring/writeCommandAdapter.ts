import { ApiError } from '../../../Contracts/aeds.ts'
import type {
  ArticleBodyEditsCommand,
  ArticleBodyInsertionsCommand,
  BodyEdit,
} from '../../../Contracts/article-body-insertion.ts'
import type { AttachmentEdit } from '../../../Contracts/article-media.ts'
import type { RightsEdit } from '../../../Contracts/article-rights.ts'
import type { TaxonomySelection } from '../../../Contracts/taxonomy-client.ts'
import type {
  ArticleBodyInsertionCommand,
  ArticleCommand,
  Draft,
  DraftRollback,
} from '../../../Contracts/wire.generated.ts'
import { normalizeDraftTitle } from './draftMarkdownImport.ts'
import type { DraftLoad, DraftSave, WorkspaceBlock, WorkspaceTab } from './workspaceRegistry.ts'

export type ArticleAction = 'save' | 'publish' | 'retract'
export type WriteAction =
  | ArticleAction
  | 'publish-images'
  | 'assign-taxonomy'
  | 'rollback-history'
  | 'schedule-publication'
  | 'save-rights'
  | 'save-attachment'
  | 'save-summary'

export type RestoreSelection = Readonly<{ sourceRevision: bigint; reason: string }>

export const sessionMismatchMessage = 'The current browser session changed. Reload before making changes.'

export const failureMessageKeyByReason = {
  missing: 'author.write.theArticleIsUnavailable',
  deleted: 'author.write.theArticleIsUnavailable',
  forbidden: 'author.write.youCanNoLongerEditThisArticle',
  expired: 'author.write.logInAgainToContinueWriting',
  unavailable: 'author.write.theServerCouldNotConfirmThisChangeTry',
  'stale-reference': 'author.write.theReferencedRevisionIsNoLongerCurrentResolve',
} as const satisfies Record<WorkspaceBlock, string>

export const savedMessageKeyByAction = {
  save: 'author.write.draftSaved',
  publish: 'author.write.articlePublished',
  retract: 'author.write.articleWithdrawn',
  'publish-images': 'author.write.articleAndSelectedImagesPublished',
  'assign-taxonomy': 'author.write.classificationSaved',
  'rollback-history': 'author.write.revisionRestoredToANewDraft',
  'schedule-publication': 'author.write.publicationScheduleUpdated',
  'save-rights': 'author.write.publicationRightsSaved',
  'save-attachment': 'author.write.privateArticleMediaSaved',
  'save-summary': 'author.write.summarySaved',
} as const satisfies Record<WriteAction, string>

export const closeRiskMessageKey = {
  dirty: 'author.write.unsavedChanges',
  saving: 'author.write.saveInProgress',
  conflict: 'author.write.saveConflict',
  recovery: 'author.write.draftRecovery',
  pending: 'author.write.pendingChange',
  blocked: 'author.write.unavailable',
} as const satisfies Record<Exclude<WorkspaceTab['risk'], 'clean'>, string>

export type SaveTransportPlan =
  | Readonly<{ kind: 'full'; action: ArticleAction; input: ArticleCommand }>
  | Readonly<{ kind: 'body-insertion'; input: ArticleBodyInsertionCommand }>
  | Readonly<{ kind: 'body-insertions'; input: ArticleBodyInsertionsCommand }>
  | Readonly<{ kind: 'body-edits'; input: ArticleBodyEditsCommand }>

export function isSessionMismatchError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.message === sessionMismatchMessage
}

export function selectSaveTransport(
  action: ArticleAction,
  draft: Draft,
  idempotencyKey: string,
  edits?: readonly BodyEdit[],
): SaveTransportPlan {
  const title = action === 'save' ? normalizeDraftTitle(draft.title) : ''
  const body = action === 'save' ? draft.body : ''
  const input: ArticleCommand = {
    id: draft.id,
    expectedRevision: draft.revision,
    title,
    body,
    idempotencyKey,
  }
  if (action === 'save' && edits?.length) {
    if (edits.some(edit => edit.removedLength > 0)) {
      return { kind: 'body-edits', input: { ...input, edits } }
    }
    const insertions = edits.map(edit => ({ offset: edit.offset, length: edit.insert.length }))
    if (insertions.length === 1) {
      return { kind: 'body-insertion', input: { ...input, ...insertions[0] } }
    }
    return { kind: 'body-insertions', input: { ...input, insertions } }
  }
  return { kind: 'full', action, input }
}

export interface WriteCommandSessionPort {
  currentHandle(): string | undefined
  hasSession(): boolean
  recheckCredential(handle: string, signal: AbortSignal): Promise<void>
}

export interface WriteCommandTransportPort {
  readDraft(articleId: number, signal: AbortSignal, handle: string): Promise<Draft>
  articleAction(action: ArticleAction, input: ArticleCommand, signal: AbortSignal, handle: string): Promise<Draft>
  saveWithBodyInsertion(input: ArticleBodyInsertionCommand, handle: string, signal: AbortSignal): Promise<Draft>
  saveWithBodyInsertions(input: ArticleBodyInsertionsCommand, handle: string, signal: AbortSignal): Promise<Draft>
  saveWithBodyEdits(input: ArticleBodyEditsCommand, handle: string, signal: AbortSignal): Promise<Draft>
  assignTaxonomy(input: Readonly<{
    id: number
    expectedRevision: bigint
    idempotencyKey: string
    categoryId: number | null
    tagIds: number[]
  }>, signal: AbortSignal): Promise<Readonly<{ id: number; revision: bigint }>>
  rollbackDraft(input: DraftRollback, signal: AbortSignal): Promise<Draft>
  setArticleSchedule(input: Readonly<{
    id: number
    expectedRevision: bigint
    idempotencyKey: string
    dueUnixMs: bigint
  }>, signal: AbortSignal): Promise<Readonly<{ revision: bigint; publishedRevision: bigint }>>
  setDraftRights(input: Readonly<RightsEdit & {
    id: number
    expectedRevision: bigint
    idempotencyKey: string
  }>, signal: AbortSignal): Promise<Readonly<{ revision: bigint }>>
  editArticleMedia(articleId: number, revision: bigint, key: string, edit: AttachmentEdit, handle: string, signal: AbortSignal): Promise<Draft>
  saveDraftSummary(input: Readonly<{
    id: number
    expectedRevision: bigint
    idempotencyKey: string
    text: string
  }>, handle: string, signal: AbortSignal): Promise<Draft>
  publishArticleImages(articleId: number, revision: bigint, key: string, assets: readonly string[], handle: string, signal: AbortSignal): Promise<Draft>
}

export async function classifyWorkspaceBlock(
  error: unknown,
  handle: string | undefined,
  signal: AbortSignal,
  session: Pick<WriteCommandSessionPort, 'recheckCredential' | 'hasSession'>,
): Promise<WorkspaceBlock> {
  if (!(error instanceof ApiError)) return 'unavailable'
  if (error.status === 401 || isSessionMismatchError(error)) {
    if (!handle || signal.aborted) return 'unavailable'
    await session.recheckCredential(handle, signal)
    return session.hasSession() ? 'unavailable' : 'expired'
  }
  if (error.status === 403) return 'forbidden'
  if (error.status === 404) return 'missing'
  return 'unavailable'
}

export function createWriteCommandAdapter(ports: Readonly<{
  session: WriteCommandSessionPort
  transport: WriteCommandTransportPort
}>) {
  const { session, transport } = ports

  async function mutationResult(operation: () => Promise<Draft>, signal: AbortSignal): Promise<DraftSave<Draft>> {
    const handle = session.currentHandle()
    try {
      return { kind: 'saved', draft: await operation() }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 409 && !isSessionMismatchError(error)) return { kind: 'conflict' }
        if (error.status === 400) return { kind: 'rejected' }
      }
      return {
        kind: 'blocked',
        reason: signal.aborted ? 'unavailable' : await classifyWorkspaceBlock(error, handle, signal, session),
      }
    }
  }

  async function loadDraft(articleId: number, signal: AbortSignal): Promise<DraftLoad<Draft>> {
    const handle = session.currentHandle()
    if (!handle) return { kind: 'blocked', reason: 'unavailable' }
    try {
      const draft = await transport.readDraft(articleId, signal, handle)
      if (signal.aborted || session.currentHandle() !== handle) return { kind: 'blocked', reason: 'unavailable' }
      return { kind: 'ready', draft }
    } catch (error) {
      const reason = signal.aborted ? 'unavailable' : await classifyWorkspaceBlock(error, handle, signal, session)
      return {
        kind: 'blocked',
        reason: reason !== 'expired' && session.currentHandle() !== handle ? 'unavailable' : reason,
      }
    }
  }

  const articleCommand = (action: ArticleAction) => (
    draft: Draft,
    signal: AbortSignal,
    idempotencyKey: string,
    edits?: readonly BodyEdit[],
  ): Promise<DraftSave<Draft>> => {
    const handle = session.currentHandle()
    if (!handle || signal.aborted) return Promise.resolve({ kind: 'blocked', reason: 'unavailable' })
    const plan = selectSaveTransport(action, draft, idempotencyKey, edits)
    return mutationResult(async () => {
      let stored: Draft
      if (plan.kind === 'body-edits') {
        stored = await transport.saveWithBodyEdits(plan.input, handle, signal)
      } else if (plan.kind === 'body-insertion') {
        stored = await transport.saveWithBodyInsertion(plan.input, handle, signal)
      } else if (plan.kind === 'body-insertions') {
        stored = await transport.saveWithBodyInsertions(plan.input, handle, signal)
      } else {
        stored = await transport.articleAction(plan.action, plan.input, signal, handle)
      }
      if (action === 'save' && (stored.title !== plan.input.title || stored.body !== plan.input.body)) {
        throw new Error('The save reply did not match the submitted draft source.')
      }
      return stored
    }, signal)
  }

  const coordinates = (draft: Draft, idempotencyKey: string) => ({
    id: draft.id, expectedRevision: draft.revision, idempotencyKey,
  })

  const saveTaxonomy = (selection: TaxonomySelection) => (
    draft: Draft,
    signal: AbortSignal,
    idempotencyKey: string,
  ): Promise<DraftSave<Draft>> =>
    mutationResult(async () => {
      const stored = await transport.assignTaxonomy({
        ...coordinates(draft, idempotencyKey),
        categoryId: selection.categoryId,
        tagIds: selection.tagIds.slice(),
      }, signal)
      return { ...draft, id: stored.id, revision: stored.revision }
    }, signal)

  const restoreRevision = (selection: RestoreSelection) => (
    draft: Draft,
    signal: AbortSignal,
    idempotencyKey: string,
  ): Promise<DraftSave<Draft>> =>
    mutationResult(() => transport.rollbackDraft({
      ...coordinates(draft, idempotencyKey),
      ...selection,
    }, signal), signal)

  const updateSchedule = (dueUnixMs: bigint) => (
    draft: Draft,
    signal: AbortSignal,
    idempotencyKey: string,
  ): Promise<DraftSave<Draft>> =>
    mutationResult(async () => {
      const result = await transport.setArticleSchedule({
        ...coordinates(draft, idempotencyKey),
        dueUnixMs,
      }, signal)
      return { ...draft, revision: result.revision, published: result.publishedRevision !== 0n }
    }, signal)

  const updateRights = (policy: RightsEdit) => (
    draft: Draft,
    signal: AbortSignal,
    idempotencyKey: string,
  ): Promise<DraftSave<Draft>> =>
    mutationResult(async () => {
      const result = await transport.setDraftRights({
        ...policy,
        ...coordinates(draft, idempotencyKey),
      }, signal)
      return { ...draft, revision: result.revision }
    }, signal)

  const withCredential = (run: (draft: Draft, signal: AbortSignal, key: string, handle: string) => Promise<Draft>) =>
    (draft: Draft, signal: AbortSignal, key: string): Promise<DraftSave<Draft>> => {
      const handle = session.currentHandle()
      if (!handle || signal.aborted) return Promise.resolve({ kind: 'blocked', reason: 'unavailable' })
      return mutationResult(() => run(draft, signal, key, handle), signal)
    }

  const updateAttachment = (edit: AttachmentEdit) =>
    withCredential((draft, signal, key, handle) => transport.editArticleMedia(draft.id, draft.revision, key, edit, handle, signal))

  const updateSummary = (text: string) => withCredential(async (draft, signal, key, handle) => {
    const stored = await transport.saveDraftSummary({ ...coordinates(draft, key), text }, handle, signal)
    if (stored.title !== draft.title || stored.body !== draft.body) {
      throw new Error('The summary reply changed the draft source.')
    }
    return stored
  })

  const publishImages = (assets: readonly string[]) =>
    withCredential((draft, signal, key, handle) => transport.publishArticleImages(draft.id, draft.revision, key, assets, handle, signal))

  return {
    loadDraft,
    articleCommand,
    saveTaxonomy,
    restoreRevision,
    updateSchedule,
    updateRights,
    updateAttachment,
    updateSummary,
    publishImages,
  }
}

export type WriteCommandAdapter = ReturnType<typeof createWriteCommandAdapter>
