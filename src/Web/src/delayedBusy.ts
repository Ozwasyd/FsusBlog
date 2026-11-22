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
