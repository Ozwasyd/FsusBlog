import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { createDelayedBusyGate, DEFAULT_BUSY_INDICATOR_DELAY_MS } from './admin/delayedBusyGate'

export { DEFAULT_BUSY_INDICATOR_DELAY_MS }

export function useDelayedBusy(
  source: () => boolean,
  delayMs = DEFAULT_BUSY_INDICATOR_DELAY_MS,
): Readonly<Ref<boolean>> {
  const visible = ref(false)
  const gate = createDelayedBusyGate(next => { visible.value = next }, delayMs)

  watch(source, active => gate.update(active), { immediate: true, flush: 'sync' })
  onScopeDispose(() => gate.dispose())

  return visible
}

export function useMediaQuery(query: string, onChange?: (matches: boolean) => void) {
  const mql = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : undefined
  const matches = ref(mql?.matches ?? false)
  if (mql) {
    const sync = (event: MediaQueryListEvent) => {
      matches.value = event.matches
      onChange?.(event.matches)
    }
    mql.addEventListener('change', sync)
    onScopeDispose(() => mql.removeEventListener('change', sync))
  }
  return matches
}
