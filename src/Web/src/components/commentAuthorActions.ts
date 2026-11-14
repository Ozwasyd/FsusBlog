import { computed, onBeforeUnmount, shallowRef, watch, type ComputedRef, type InjectionKey } from 'vue'
import { commentAuthorEligibility } from '../../../Contracts/comment-author'
import type { CommentNode } from '../../../Contracts/comment-read'
import { WireLimits } from '../../../Contracts/wire.generated'
import { currentSession, identityEpoch } from '../session'

export const commentAuthorDelete: InjectionKey<(id: string) => void> = Symbol('comment author delete')

export function useCommentAuthorEligibility(article: () => number, nodes: ComputedRef<readonly CommentNode[]>) {
  const allowed = shallowRef(new Set<string>())
  const candidates = computed(() => [...new Set(nodes.value.filter(node => node.author.mode === 'public' && !node.deleted)
    .map(node => node.id))].join(','))
  let request: AbortController | undefined
  onBeforeUnmount(() => request?.abort())
  watch([article, candidates, identityEpoch, () => currentSession.value?.siteSessionId], async ([id, keys, epoch, handle], _, cleanup) => {
    allowed.value = new Set()
    const session = currentSession.value
    if (!keys || !handle || !session || session.expiresAt <= Date.now()) return
    const controller = new AbortController()
    request = controller
    cleanup(() => controller.abort())
    const ids = keys.split(',')
    const result = new Set<string>()
    try {
      for (let index = 0; index < ids.length; index += WireLimits.CommentAuthorBatchSize) {
        for (const eligible of await commentAuthorEligibility(id, ids.slice(index, index + WireLimits.CommentAuthorBatchSize), handle, controller.signal))
          result.add(eligible)
      }
      if (!controller.signal.aborted && identityEpoch.value === epoch && handle === currentSession.value?.siteSessionId)
        allowed.value = result
    } catch {
      // Signed-out, ineligible and unavailable all leave the public reading surface unchanged.
    }
  }, { immediate: true, flush: 'sync' })
  return allowed
}
