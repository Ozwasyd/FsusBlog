import { computed, onBeforeUnmount, shallowRef, watch, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import { commentAuthorEligibility } from '../../../Contracts/comment-author'
import { commentReportingAvailable } from '../../../Contracts/comment-reports'
import type { CommentNode } from '../../../Contracts/comment-read'
import { WireLimits } from '../../../Contracts/wire.generated'
import { currentSession, identityEpoch } from '../session'

export const commentAuthorDelete: InjectionKey<(id: string) => void> = Symbol('comment author delete')
export const commentAuthorEdit: InjectionKey<(node: CommentNode) => void> = Symbol('comment author edit')
export const commentReport: InjectionKey<{
  available: Readonly<Ref<boolean>>
  start: (node: CommentNode) => void
}> = Symbol('comment report')
export const commentReply: InjectionKey<{
  available: Readonly<Ref<boolean>>
  start: (node: CommentNode) => void
}> = Symbol('comment reply')

function editDeadline(node: CommentNode) {
  return node.createdAt + WireLimits.CommentAuthorEditWindowMinutes * 60_000
}

export function canOpenCommentEditor(node: CommentNode, now = Date.now()) {
  return node.author.mode === 'public' && !node.deleted && now < editDeadline(node)
}

export function useCommentReportingAvailability() {
  const available = shallowRef(false)
  watch([identityEpoch, () => currentSession.value?.siteSessionId], async ([epoch, handle], _, cleanup) => {
    available.value = false
    const session = currentSession.value
    if (!handle || !session || session.expiresAt <= Date.now()) return
    const controller = new AbortController()
    cleanup(() => controller.abort())
    try {
      await commentReportingAvailable(handle, controller.signal)
      if (!controller.signal.aborted && identityEpoch.value === epoch && currentSession.value?.siteSessionId === handle)
        available.value = true
    } catch {
      // Report availability is optional on an older catalog.
    }
  }, { immediate: true, flush: 'sync' })
  return available
}

export function useCommentAuthorEligibility(article: () => number, nodes: ComputedRef<readonly CommentNode[]>) {
  const allowed = shallowRef({ deletable: new Set<string>(), editable: new Set<string>() })
  const candidates = computed(() => [...new Set(nodes.value.filter(node => node.author.mode === 'public' && !node.deleted)
    .map(node => node.id))].join(','))
  let request: AbortController | undefined
  onBeforeUnmount(() => request?.abort())
  watch([article, candidates, identityEpoch, () => currentSession.value?.siteSessionId], async ([id, keys, epoch, handle], _, cleanup) => {
    allowed.value = { deletable: new Set(), editable: new Set() }
    const session = currentSession.value
    if (!keys || !handle || !session || session.expiresAt <= Date.now()) return
    const controller = new AbortController()
    request = controller
    let expiry: ReturnType<typeof setTimeout> | undefined
    cleanup(() => {
      controller.abort()
      clearTimeout(expiry)
    })
    const ids = keys.split(',')
    const deletable = new Set<string>()
    const editableIds = new Set<string>()
    try {
      for (let index = 0; index < ids.length; index += WireLimits.CommentAuthorBatchSize) {
        const page = await commentAuthorEligibility(id, ids.slice(index, index + WireLimits.CommentAuthorBatchSize), handle, controller.signal)
        for (const eligible of page.ids) {
          deletable.add(eligible)
          if (page.editEnabled) editableIds.add(eligible)
        }
      }
      const editCandidates = nodes.value.filter(node => editableIds.has(node.id))
      const update = () => {
        if (controller.signal.aborted || identityEpoch.value !== epoch || handle !== currentSession.value?.siteSessionId) return
        const now = Date.now()
        const editable = new Set<string>()
        let nextExpiry = Infinity
        for (const node of editCandidates) {
          if (!canOpenCommentEditor(node, now)) continue
          editable.add(node.id)
          nextExpiry = Math.min(nextExpiry, editDeadline(node))
        }
        allowed.value = { deletable, editable }
        if (Number.isFinite(nextExpiry)) expiry = setTimeout(update, Math.min(nextExpiry - now, 2_147_483_647))
      }
      update()
    } catch {
      // Signed-out, ineligible and unavailable all leave the public reading surface unchanged.
    }
  }, { immediate: true, flush: 'sync' })
  return allowed
}
