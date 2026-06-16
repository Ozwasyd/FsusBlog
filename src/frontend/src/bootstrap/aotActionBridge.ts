import type { Router } from 'vue-router'
import { dispatchAotActionEvent } from '@/bootstrap/aotActionEvent'
import { createPublicArticleDetailNavigationTarget } from '@/public-renderers/publicNavigationTargets'

export async function handleRootAotClick(event: MouseEvent, router: Router): Promise<void> {
  const target = event.target
  if (!(target instanceof HTMLElement)) {
    return
  }

  const actionNode = target.closest('[data-aot-action]')
  if (!(actionNode instanceof HTMLElement)) {
    return
  }

  const detail = dispatchAotActionEvent(actionNode)
  if (!detail) {
    return
  }

  if (detail.action === 'open-article') {
    const idText = actionNode.dataset.aotId
    const id = Number(idText)
    if (Number.isInteger(id) && id > 0) {
      await router.push(createPublicArticleDetailNavigationTarget(id).route).catch(() => {})
      return
    }
  }
}
