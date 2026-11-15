import { onBeforeUnmount, ref, watch } from 'vue'
import { listRecentOpens, recordRecentOpen } from '../../../Contracts/author-recent-opens'
import { ApiError } from '../../../Contracts/client'
import { currentSession, identityEpoch } from '../session'

type Visit = Readonly<{ articleId: number; articleRevision: bigint; expiresAt: number }>

export function recentArticleOpens() {
  const changed = ref(0)
  const notice = ref('')
  let active = new AbortController()
  let collectionRevision: bigint | undefined
  let running = false
  let unavailable = false
  const pending: Visit[] = []

  function reset() {
    active.abort()
    active = new AbortController()
    pending.length = 0
    collectionRevision = undefined
    running = false
    unavailable = false
    notice.value = ''
  }

  watch([identityEpoch, () => currentSession.value?.siteSessionId, () => currentSession.value?.canAuthor], reset, { flush: 'sync' })
  onBeforeUnmount(reset)

  async function write(handle: string, scope: AbortSignal) {
    running = true
    try {
      while (pending.length && !scope.aborted) {
        const { articleId, articleRevision, expiresAt } = pending.shift()!
        const remaining = expiresAt - Date.now()
        if (remaining <= 0 || !navigator.onLine || (currentSession.value?.expiresAt ?? 0) <= Date.now()) {
          pending.length = 0
          return
        }
        const signal = AbortSignal.any([scope, AbortSignal.timeout(remaining)])
        if (collectionRevision === undefined) {
          const head = await listRecentOpens(handle, signal)
          signal.throwIfAborted()
          collectionRevision = head.revision
        }
        const receipt = await recordRecentOpen(handle, signal, { expectedRevision: collectionRevision,
          requestId: crypto.randomUUID(), articleId, articleRevision })
        signal.throwIfAborted()
        collectionRevision = receipt.revision
        notice.value = ''
        changed.value++
      }
    } catch (error) {
      if (scope.aborted) return
      // A future, explicit open can read the new head. The failed intent is never rebased or queued offline.
      pending.length = 0
      const known = collectionRevision !== undefined
      unavailable = !known && error instanceof ApiError && error.status === 404
      collectionRevision = undefined
      if (!unavailable) {
        notice.value = 'This article open could not be recorded.'
        changed.value++
      }
    } finally {
      if (!scope.aborted) running = false
    }
  }

  function record(articleId: number, articleRevision: bigint) {
    const session = currentSession.value
    if (!session?.canAuthor || !session.siteSessionId || session.expiresAt <= Date.now() || !navigator.onLine ||
        unavailable || pending.length >= 8) return
    pending.push({ articleId, articleRevision, expiresAt: Date.now() + 3_000 })
    if (!running) void write(session.siteSessionId, active.signal)
  }

  return { record, changed, notice }
}
