export const DEFAULT_BUSY_INDICATOR_DELAY_MS = 180

export interface DelayedBusyGate {
  update(active: boolean): void
  dispose(): void
}

/**
 * Pure timer controller that suppresses visual busy/spinner states for fast
 * (< delayMs) idempotent read/search/refresh operations while clearing
 * synchronously when work completes.
 */
export function createDelayedBusyGate(
  onVisibleChange: (visible: boolean) => void,
  delayMs = DEFAULT_BUSY_INDICATOR_DELAY_MS,
): DelayedBusyGate {
  let active = false
  let visible = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const setVisible = (next: boolean) => {
    if (visible === next) return
    visible = next
    onVisibleChange(next)
  }

  return {
    update(nextActive: boolean) {
      if (disposed) return
      active = nextActive
      cancel()
      if (!nextActive) {
        setVisible(false)
        return
      }
      if (delayMs <= 0) {
        setVisible(true)
        return
      }
      timer = setTimeout(() => {
        timer = undefined
        if (!disposed && active) setVisible(true)
      }, delayMs)
    },
    dispose() {
      disposed = true
      active = false
      cancel()
    },
  }
}
