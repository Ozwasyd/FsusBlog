import { onScopeDispose, watch } from 'vue'
import { ApiError } from '../../../Contracts/aeds'

export const isAdminSessionLost = (cause: unknown): cause is ApiError =>
  cause instanceof ApiError && cause.status === 401 && !cause.details.startsWith('pow_')

type SessionBinding = AbortSignal | readonly [unknown, AbortSignal]
const sessionSignal = (value: SessionBinding) => 'aborted' in value ? value : value[1]

export function watchAdminSessionClear(source: () => SessionBinding,
  clear: () => void, dispose = clear) {
  watch(source, (value, _, cleanup) => {
    const signal = sessionSignal(value)
    clear()
    signal.addEventListener('abort', clear, { once: true })
    cleanup(() => signal.removeEventListener('abort', clear))
  }, { flush: 'sync', immediate: true })
  onScopeDispose(dispose)
}

export function useAdminRequests(source: () => SessionBinding, onClear: () => void) {
  const lifetime = new AbortController()
  let active: AbortController | undefined
  const abort = () => { active?.abort(); active = undefined }
  const start = () => {
    abort()
    const controller = active = new AbortController()
    const signal = AbortSignal.any([controller.signal, lifetime.signal, sessionSignal(source())])
    const isCurrent = () => active === controller
    const finish = () => {
      if (!isCurrent()) return false
      active = undefined
      return true
    }
    return { controller, signal, isCurrent, finish }
  }
  watchAdminSessionClear(source, () => { abort(); onClear() }, () => { abort(); lifetime.abort() })
  return { lifetime, signal: () => AbortSignal.any([lifetime.signal, sessionSignal(source())]), start, abort }
}
