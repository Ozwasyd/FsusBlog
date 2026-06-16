export const AOT_ACTION_EVENT_NAME = 'fsus:aot:event'

export type AotActionEventDetail = Readonly<{
  action: string
  value: number
  key?: string
}>

export function readAotActionEventDetail(actionNode: HTMLElement): AotActionEventDetail | null {
  const action = actionNode.dataset.aotAction
  if (!action) {
    return null
  }

  const rawValue = Number(actionNode.dataset.aotValue ?? actionNode.dataset.aotId ?? '0')
  const value = Number.isFinite(rawValue) ? Math.trunc(rawValue) : 0
  const key = actionNode.dataset.aotKey

  return {
    action,
    value,
    key
  }
}

export function dispatchAotActionEvent(actionNode: HTMLElement): AotActionEventDetail | null {
  const detail = readAotActionEventDetail(actionNode)
  if (!detail) {
    return null
  }

  window.dispatchEvent(new CustomEvent(AOT_ACTION_EVENT_NAME, { detail }))
  return detail
}
