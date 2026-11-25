import { ApiError } from '../../../Contracts/aeds.ts'
import type { ArticleBodyEditsCommand, ArticleBodyInsertionsCommand, BodyEdit } from '../../../Contracts/article-body-insertion.ts'
import type { AttachmentEdit } from '../../../Contracts/article-media.ts'
import type { RightsEdit } from '../../../Contracts/article-rights.ts'
import type { TaxonomySelection } from '../../../Contracts/taxonomy-client.ts'
import type { ArticleBodyInsertionCommand, ArticleCommand, Draft, DraftRollback } from '../../../Contracts/wire.generated.ts'
import { normalizeDraftTitle } from './draftMarkdownImport.ts'
import type { DraftLoad, DraftSave, WorkspaceBlock, WorkspaceTab } from './workspaceRegistry.ts'

export type ArticleAction = 'save' | 'publish' | 'retract'
export type WriteAction = ArticleAction | 'publish-images' | 'assign-taxonomy' | 'rollback-history' | 'schedule-publication' | 'save-rights' | 'save-attachment' | 'save-summary'
export type RestoreSelection = Readonly<{ sourceRevision: bigint; reason: string }>
export const sessionMismatchMessage = 'The current browser session changed. Reload before making changes.'

export const failureMessageKeyByReason = {
  missing: 'author.write.theArticleIsUnavailable', deleted: 'author.write.theArticleIsUnavailable',
  forbidden: 'author.write.youCanNoLongerEditThisArticle', expired: 'author.write.logInAgainToContinueWriting',
  unavailable: 'author.write.theServerCouldNotConfirmThisChangeTry', 'stale-reference': 'author.write.theReferencedRevisionIsNoLongerCurrentResolve',
} as const satisfies Record<WorkspaceBlock, string>

export const savedMessageKeyByAction = {
  save: 'author.write.draftSaved', publish: 'author.write.articlePublished', retract: 'author.write.articleWithdrawn',
  'publish-images': 'author.write.articleAndSelectedImagesPublished', 'assign-taxonomy': 'author.write.classificationSaved',
  'rollback-history': 'author.write.revisionRestoredToANewDraft', 'schedule-publication': 'author.write.publicationScheduleUpdated',
  'save-rights': 'author.write.publicationRightsSaved', 'save-attachment': 'author.write.privateArticleMediaSaved', 'save-summary': 'author.write.summarySaved',
} as const satisfies Record<WriteAction, string>

export const closeRiskMessageKey = {
  dirty: 'author.write.unsavedChanges', saving: 'author.write.saveInProgress', conflict: 'author.write.saveConflict',
  recovery: 'author.write.draftRecovery', pending: 'author.write.pendingChange', blocked: 'author.write.unavailable',
} as const satisfies Record<Exclude<WorkspaceTab['risk'], 'clean'>, string>

export type SaveTransportPlan =
  | Readonly<{ kind: 'full'; action: ArticleAction; input: ArticleCommand }>
  | Readonly<{ kind: 'body-insertion'; input: ArticleBodyInsertionCommand }>
  | Readonly<{ kind: 'body-insertions'; input: ArticleBodyInsertionsCommand }>
  | Readonly<{ kind: 'body-edits'; input: ArticleBodyEditsCommand }>

export const isSessionMismatchError = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409 && error.message === sessionMismatchMessage

export function selectSaveTransport(action: ArticleAction, draft: Draft, idempotencyKey: string, edits?: readonly BodyEdit[]): SaveTransportPlan {
  const input: ArticleCommand = {
    id: draft.id, expectedRevision: draft.revision, idempotencyKey,
    title: action === 'save' ? normalizeDraftTitle(draft.title) : '', body: action === 'save' ? draft.body : '',
  }
  if (action === 'save' && edits?.length) {
    if (edits.some(edit => edit.removedLength > 0)) return { kind: 'body-edits', input: { ...input, edits } }
    const insertions = edits.map(edit => ({ offset: edit.offset, length: edit.insert.length }))
    return insertions.length === 1 ? { kind: 'body-insertion', input: { ...input, ...insertions[0] } } : { kind: 'body-insertions', input: { ...input, insertions } }
  }
  return { kind: 'full', action, input }
}

export interface WriteCommandSessionPort {
  currentHandle(): string | undefined
  hasSession(): boolean
  recheckCredential(handle: string, signal: AbortSignal): Promise<void>
}
type DraftCoord = Readonly<{ id: number; expectedRevision: bigint; idempotencyKey: string }>

export interface WriteCommandTransportPort {
  readDraft(articleId: number, signal: AbortSignal, handle: string): Promise<Draft>
  articleAction(action: ArticleAction, input: ArticleCommand, signal: AbortSignal, handle: string): Promise<Draft>
  saveWithBodyInsertion(input: ArticleBodyInsertionCommand, handle: string, signal: AbortSignal): Promise<Draft>
  saveWithBodyInsertions(input: ArticleBodyInsertionsCommand, handle: string, signal: AbortSignal): Promise<Draft>
  saveWithBodyEdits(input: ArticleBodyEditsCommand, handle: string, signal: AbortSignal): Promise<Draft>
  assignTaxonomy(input: Readonly<DraftCoord & { categoryId: number | null; tagIds: number[] }>, signal: AbortSignal): Promise<Readonly<{ id: number; revision: bigint }>>
  rollbackDraft(input: DraftRollback, signal: AbortSignal): Promise<Draft>
  setArticleSchedule(input: Readonly<DraftCoord & { dueUnixMs: bigint }>, signal: AbortSignal): Promise<Readonly<{ revision: bigint; publishedRevision: bigint }>>
  setDraftRights(input: Readonly<RightsEdit & DraftCoord>, signal: AbortSignal): Promise<Readonly<{ revision: bigint }>>
  editArticleMedia(articleId: number, revision: bigint, key: string, edit: AttachmentEdit, handle: string, signal: AbortSignal): Promise<Draft>
  saveDraftSummary(input: Readonly<DraftCoord & { text: string }>, handle: string, signal: AbortSignal): Promise<Draft>
  publishArticleImages(articleId: number, revision: bigint, key: string, assets: readonly string[], handle: string, signal: AbortSignal): Promise<Draft>
}

export async function classifyWorkspaceBlock(
  error: unknown, handle: string | undefined, signal: AbortSignal,
  session: Pick<WriteCommandSessionPort, 'recheckCredential' | 'hasSession'>,
): Promise<WorkspaceBlock> {
  if (!(error instanceof ApiError)) return 'unavailable'
  if (error.status === 401 || isSessionMismatchError(error)) {
    if (!handle || signal.aborted) return 'unavailable'
    await session.recheckCredential(handle, signal)
    return session.hasSession() ? 'unavailable' : 'expired'
  }
  return error.status === 403 ? 'forbidden' : error.status === 404 ? 'missing' : 'unavailable'
}

export function createWriteCommandAdapter({ session, transport }: Readonly<{ session: WriteCommandSessionPort; transport: WriteCommandTransportPort }>) {
  async function mutationResult(operation: () => Promise<Draft>, signal: AbortSignal): Promise<DraftSave<Draft>> {
    const handle = session.currentHandle()
    try {
      return { kind: 'saved', draft: await operation() }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 409 && !isSessionMismatchError(error)) return { kind: 'conflict' }
        if (error.status === 400) return { kind: 'rejected' }
      }
      return { kind: 'blocked', reason: signal.aborted ? 'unavailable' : await classifyWorkspaceBlock(error, handle, signal, session) }
    }
  }

  async function loadDraft(articleId: number, signal: AbortSignal): Promise<DraftLoad<Draft>> {
    const handle = session.currentHandle()
    if (!handle) return { kind: 'blocked', reason: 'unavailable' }
    try {
      const draft = await transport.readDraft(articleId, signal, handle)
      return signal.aborted || session.currentHandle() !== handle ? { kind: 'blocked', reason: 'unavailable' } : { kind: 'ready', draft }
    } catch (error) {
      const reason = signal.aborted ? 'unavailable' : await classifyWorkspaceBlock(error, handle, signal, session)
      return { kind: 'blocked', reason: reason !== 'expired' && session.currentHandle() !== handle ? 'unavailable' : reason }
    }
  }

  const coordinates = (draft: Draft, idempotencyKey: string): DraftCoord => ({ id: draft.id, expectedRevision: draft.revision, idempotencyKey })
  const withMutation = (run: (draft: Draft, signal: AbortSignal, key: string) => Promise<Draft>) =>
    (draft: Draft, signal: AbortSignal, key: string): Promise<DraftSave<Draft>> => mutationResult(() => run(draft, signal, key), signal)
  const withCredential = <T extends unknown[]>(run: (draft: Draft, signal: AbortSignal, key: string, handle: string, ...extra: T) => Promise<Draft>) =>
    (draft: Draft, signal: AbortSignal, key: string, ...extra: T): Promise<DraftSave<Draft>> => {
      const handle = session.currentHandle()
      return !handle || signal.aborted ? Promise.resolve({ kind: 'blocked', reason: 'unavailable' }) : mutationResult(() => run(draft, signal, key, handle, ...extra), signal)
    }

  const articleCommand = (action: ArticleAction) => withCredential<[edits?: readonly BodyEdit[]]>(async (draft, signal, key, handle, edits) => {
    const plan = selectSaveTransport(action, draft, key, edits)
    const stored = plan.kind === 'body-edits' ? await transport.saveWithBodyEdits(plan.input, handle, signal)
      : plan.kind === 'body-insertion' ? await transport.saveWithBodyInsertion(plan.input, handle, signal)
      : plan.kind === 'body-insertions' ? await transport.saveWithBodyInsertions(plan.input, handle, signal)
      : await transport.articleAction(plan.action, plan.input, signal, handle)
    if (action === 'save' && (stored.title !== plan.input.title || stored.body !== plan.input.body))
      throw new Error('The save reply did not match the submitted draft source.')
    return stored
  })

  const saveTaxonomy = (selection: TaxonomySelection) => withMutation(async (draft, signal, key) => {
    const stored = await transport.assignTaxonomy({ ...coordinates(draft, key), categoryId: selection.categoryId, tagIds: selection.tagIds.slice() }, signal)
    return { ...draft, id: stored.id, revision: stored.revision }
  })
  const restoreRevision = (selection: RestoreSelection) => withMutation((draft, signal, key) => transport.rollbackDraft({ ...coordinates(draft, key), ...selection }, signal))
  const updateSchedule = (dueUnixMs: bigint) => withMutation(async (draft, signal, key) => {
    const result = await transport.setArticleSchedule({ ...coordinates(draft, key), dueUnixMs }, signal)
    return { ...draft, revision: result.revision, published: result.publishedRevision !== 0n }
  })
  const updateRights = (policy: RightsEdit) => withMutation(async (draft, signal, key) =>
    ({ ...draft, revision: (await transport.setDraftRights({ ...policy, ...coordinates(draft, key) }, signal)).revision }))
  const updateAttachment = (edit: AttachmentEdit) =>
    withCredential((draft, signal, key, handle) => transport.editArticleMedia(draft.id, draft.revision, key, edit, handle, signal))
  const updateSummary = (text: string) => withCredential(async (draft, signal, key, handle) => {
    const stored = await transport.saveDraftSummary({ ...coordinates(draft, key), text }, handle, signal)
    if (stored.title !== draft.title || stored.body !== draft.body) throw new Error('The summary reply changed the draft source.')
    return stored
  })
  const publishImages = (assets: readonly string[]) =>
    withCredential((draft, signal, key, handle) => transport.publishArticleImages(draft.id, draft.revision, key, assets, handle, signal))

  return { loadDraft, articleCommand, saveTaxonomy, restoreRevision, updateSchedule, updateRights, updateAttachment, updateSummary, publishImages }
}

export type WriteCommandAdapter = ReturnType<typeof createWriteCommandAdapter>
