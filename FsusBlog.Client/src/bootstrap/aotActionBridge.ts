import type { Router } from 'vue-router'

export async function handleRootAotClick(event: MouseEvent, router: Router): Promise<void> {
  const target = event.target
  if (!(target instanceof HTMLElement)) {
    return
  }

  const actionNode = target.closest('[data-aot-action]')
  if (!(actionNode instanceof HTMLElement)) {
    return
  }

  const action = actionNode.dataset.aotAction
  if (!action) {
    return
  }

  const rawValue = Number(actionNode.dataset.aotValue ?? actionNode.dataset.aotId ?? '0')
  const safeValue = Number.isFinite(rawValue) ? Math.trunc(rawValue) : 0
  const key = actionNode.dataset.aotKey

  window.dispatchEvent(new CustomEvent('fsus:aot:event', {
    detail: {
      action,
      value: safeValue,
      key
    }
  }))

  if (action === 'open-article') {
    const idText = actionNode.dataset.aotId
    const id = Number(idText)
    if (Number.isInteger(id) && id > 0) {
      await router.push({ name: 'ArticleDetail', params: { id: String(id) } }).catch(() => {})
      return
    }
  }
}
