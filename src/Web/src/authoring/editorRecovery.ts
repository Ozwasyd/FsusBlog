import { computed, readonly, ref, shallowRef } from 'vue'
import type { Draft } from '../../../Contracts/wire.generated'
import {
  DraftJournal, type DraftTarget, type PendingSource, type RecoveryCandidate,
} from './draftJournal'
import { verifyDraftScope } from './draftScope'
import type { CloseReservation, EditorTransport, RecoverableCloseDraft, WorkspaceTab } from './workspaceRegistry'

type Confirmation = Parameters<NonNullable<EditorTransport<Draft>['confirmed']>>[0]
type ActiveDraft = { tab: WorkspaceTab; draft: Draft; edit: number }
const recoveryTimeoutMs = 2_500

export function editorRecovery() {
  let journal: DraftJournal | undefined
  let scopeRequest = new AbortController()
  let checked: number | undefined
  let current: ActiveDraft | undefined
  const createTargets = new Map<number, string>()
  let inspection = 0
  const candidates = shallowRef<readonly RecoveryCandidate[]>([])
  const failure = ref(false)
  const attaching = ref(false)
  const inspecting = ref(false)
  const guarded = computed(() => attaching.value || inspecting.value)

  function setCurrent(tab: WorkspaceTab | undefined, draft: Draft | undefined, edit: number) {
    const previous = current
    current = tab && draft ? { tab, draft, edit } : undefined
    if (previous?.tab.sessionId !== current?.tab.sessionId || previous?.draft.id !== current?.draft.id) {
      checked = undefined
      candidates.value = []
      inspecting.value = false
      ++inspection
    }
    if (current && current.tab.risk === 'clean' && journal && checked !== current.tab.sessionId) void inspect(current)
  }

  async function attach(epoch: number, valid: () => boolean, currentHandle: () => string | undefined) {
    close()
    failure.value = false
    attaching.value = true
    const request = scopeRequest
    const timeout = setTimeout(() => {
      if (request.signal.aborted) return
      request.abort()
      attaching.value = false
      failure.value = true
    }, recoveryTimeoutMs)
    try {
      const scope = await verifyDraftScope(epoch, valid, currentHandle, request.signal)
      if (!scope) return
      const opened = await DraftJournal.open(scope)
      if (request.signal.aborted || !valid()) {
        opened.close()
        return
      }
      journal = opened
      if (current) {
        if (current.tab.risk === 'clean') void inspect(current)
        else if (current.edit > 0) persist(current.draft, current.edit)
      }
    } catch {
      if (!request.signal.aborted) failure.value = true
    } finally {
      clearTimeout(timeout)
      if (!request.signal.aborted) attaching.value = false
    }
  }

  async function inspect(snapshot: ActiveDraft) {
    const owner = journal
    if (!owner) return
    const sequence = ++inspection
    checked = snapshot.tab.sessionId
    inspecting.value = true
    const timeout = setTimeout(() => {
      if (journal !== owner || inspection !== sequence) return
      owner.close()
      journal = undefined
      inspecting.value = false
      failure.value = true
    }, recoveryTimeoutMs)
    try {
      const next = snapshot.draft.id === 0 ? await owner.inspectNew()
        : await owner.inspect({ articleId: snapshot.draft.id }, snapshot.draft)
      if (journal === owner && inspection === sequence && current?.edit === snapshot.edit && current.tab.risk === 'clean') {
        candidates.value = next
      }
    } catch {
      if (journal === owner && inspection === sequence) failure.value = true
    } finally {
      clearTimeout(timeout)
      if (journal === owner && inspection === sequence) inspecting.value = false
    }
  }

  function target(id: number, sessionId: number): DraftTarget {
    if (id > 0) return { articleId: id }
    let createDraftId = createTargets.get(sessionId)
    if (!createDraftId) {
      createDraftId = crypto.randomUUID()
      createTargets.set(sessionId, createDraftId)
    }
    return { createDraftId }
  }
  const source = (draft: Draft, edit: number): PendingSource => ({
    title: draft.title, body: draft.body, baseRevision: draft.revision, editSequence: edit,
  })

  function persist(draft: Draft, edit: number) {
    const owner = journal
    if (!owner || !current) return
    const destination = target(draft.id, current.tab.sessionId)
    void owner.write(destination, source(draft, edit)).then(outcome => {
      if (journal === owner && (outcome === 'full' || outcome === 'closed')) failure.value = true
    }).catch(() => {
      if (journal === owner) failure.value = true
    })
  }

  async function confirmed(write: Confirmation, closeSignal?: AbortSignal): Promise<boolean> {
    const owner = journal
    if (!owner) return false
    const signal = closeSignal ? AbortSignal.any([scopeRequest.signal, closeSignal]) : scopeRequest.signal
    // Capture the prior key before the registry publishes the persisted article id.
    const previous = target(write.previousArticleId, write.sessionId)
    const next = target(write.current.id, write.sessionId)
    const promote = write.previousArticleId !== write.current.id
    if (promote) createTargets.delete(write.sessionId)
    try {
      if (write.dirty) {
        const result = await owner.write(next, source(write.current, write.currentEdit))
        if (result !== 'stored' && result !== 'stale') throw Error('Recovery write was not recorded')
      }
      if (write.command === 'publish') await owner.purge(previous)
      else if (write.command === 'save' && !await owner.acknowledge(previous, write.acknowledgedEdit, signal)) return false
      if (promote && write.dirty) await owner.acknowledge(previous, write.currentEdit)
      return journal === owner
    } catch {
      if (journal === owner) failure.value = true
      return false
    }
  }

  async function remove(candidate: RecoveryCandidate, keep?: { draft: Draft; edit: number }) {
    const owner = journal
    const snapshot = current
    if (!owner || !snapshot || !candidates.value.includes(candidate)) return false
    try {
      if (keep) {
        const saved = await owner.write(target(keep.draft.id, snapshot.tab.sessionId), source(keep.draft, keep.edit))
        if (saved !== 'stored' && saved !== 'stale') throw Error('Recovery write was not recorded')
      }
      await owner.discard(candidate.target ?? target(snapshot.draft.id, snapshot.tab.sessionId), candidate)
      if (journal !== owner || current?.tab.sessionId !== snapshot.tab.sessionId) return false
      candidates.value = candidates.value.filter(item => item !== candidate)
      return true
    } catch {
      if (journal === owner) failure.value = true
      return false
    }
  }

  function discardArticle(id: number, sessionId: number, edit: number) {
    const owner = journal
    const document = target(id, sessionId)
    if (id === 0) createTargets.delete(sessionId)
    return owner?.acknowledge(document, edit).catch(() => { failure.value = true })
  }

  const closeCopies = (drafts: readonly RecoverableCloseDraft<Draft>[]) => drafts.map(({ draft, edit }) => ({
    target: { articleId: draft.id }, source: source(draft, edit),
  }))

  async function verifyCloseCopies(drafts: readonly RecoverableCloseDraft<Draft>[]): Promise<boolean> {
    const owner = journal
    if (!owner) return false
    try {
      const verified = await owner.verifyCopies(closeCopies(drafts))
      return verified && journal === owner
    } catch {
      return false
    }
  }

  async function discardCloseCopies(reservation: CloseReservation<Draft>): Promise<boolean> {
    const owner = journal
    if (!owner) return false
    try {
      return await owner.discardCopies(closeCopies(reservation.drafts), {
        signal: AbortSignal.any([reservation.signal, scopeRequest.signal]),
        current: () => journal === owner && reservation.current(),
      })
    } catch {
      return false
    }
  }

  function close() {
    scopeRequest.abort()
    scopeRequest = new AbortController()
    journal?.close()
    journal = undefined
    createTargets.clear()
    checked = undefined
    candidates.value = []
    attaching.value = false
    inspecting.value = false
    ++inspection
  }

  function dismissCandidates() {
    candidates.value = []
  }

  return {
    setCurrent, attach, close, persist, confirmed, remove, discardArticle, verifyCloseCopies, discardCloseCopies, dismissCandidates,
    candidates: readonly(candidates), failure: readonly(failure), guarded,
  }
}
