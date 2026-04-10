import type { Router } from 'vue-router'

type AotModuleSet = {
  handleAotEvent: typeof import('@wasm/aeds')['handleAotEvent']
  AotActionId: typeof import('@wasm/protocol/aot')['AotActionId']
  toAotActionId: typeof import('@wasm/protocol/aot')['toAotActionId']
  useArticleBinaryStore: typeof import('@/store/article')['useArticleBinaryStore']
}

let aotModulesPromise: Promise<AotModuleSet> | null = null

async function loadAotModules(): Promise<AotModuleSet> {
  aotModulesPromise ??= Promise.all([
    import('@wasm/aeds'),
    import('@wasm/protocol/aot'),
    import('@/store/article')
  ]).then(([aedsModule, protocolModule, articleStoreModule]) => ({
    handleAotEvent: aedsModule.handleAotEvent,
    AotActionId: protocolModule.AotActionId,
    toAotActionId: protocolModule.toAotActionId,
    useArticleBinaryStore: articleStoreModule.useArticleBinaryStore
  }))

  return await aotModulesPromise
}

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

  const { handleAotEvent, AotActionId, toAotActionId, useArticleBinaryStore } = await loadAotModules()
  const articleStore = useArticleBinaryStore()
  const actionId = toAotActionId(action)
  const rawValue = Number(actionNode.dataset.aotValue ?? actionNode.dataset.aotId ?? '0')
  const safeValue = Number.isFinite(rawValue) ? Math.trunc(rawValue) : 0
  const key = actionNode.dataset.aotKey
  const rendered = actionId !== AotActionId.None ? handleAotEvent(actionId, safeValue) : ''

  window.dispatchEvent(new CustomEvent('fsus:aot:event', {
    detail: {
      action,
      actionId,
      value: safeValue,
      key,
      html: rendered && rendered.length > 0 ? rendered : undefined
    }
  }))

  if (actionId === AotActionId.OpenArticle) {
    const idText = actionNode.dataset.aotId
    const id = Number(idText)
    if (Number.isInteger(id) && id > 0) {
      await router.push({ name: 'ArticleDetail', params: { id: String(id) } }).catch(() => {})
      return
    }
  }

  articleStore.handleAotAction(action)
}
