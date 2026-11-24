import { onScopeDispose, watch } from 'vue'
import { ApiError } from '../../../Contracts/aeds'

export const isAdminSessionLost = (cause: unknown): cause is ApiError =>
  cause instanceof ApiError && cause.status === 401 && !cause.details.startsWith('pow_')

export function watchAdminSessionClear(source: () => AbortSignal | readonly [unknown, AbortSignal],
  clear: () => void, dispose = clear) {
  watch(source, (value, _, cleanup) => {
    const signal = 'aborted' in value ? value : value[1]
    clear()
    signal.addEventListener('abort', clear, { once: true })
    cleanup(() => signal.removeEventListener('abort', clear))
  }, { flush: 'sync', immediate: true })
  onScopeDispose(dispose)
}

export function useAdminRequests(source: () => AbortSignal | readonly [unknown, AbortSignal], onClear: () => void) {
  const lifetime = new AbortController()
  let active: AbortController | undefined
  const sessionSignal = () => {
    const value = source()
    return 'aborted' in value ? value : value[1]
  }
  const abort = () => { active?.abort(); active = undefined }
  const start = () => {
    abort()
    const controller = active = new AbortController()
    const signal = AbortSignal.any([controller.signal, lifetime.signal, sessionSignal()])
    return { controller, signal, isCurrent: () => active === controller, finish: () => { if (active === controller) active = undefined } }
  }
  watchAdminSessionClear(source, () => { abort(); onClear() }, () => { abort(); lifetime.abort() })
  return { lifetime, signal: () => AbortSignal.any([lifetime.signal, sessionSignal()]), start, abort }
}
