type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback) => number
  cancelIdleCallback?: (handle: number) => void
}

export type IdleTaskHandle = {
  cancel: () => void
}

export const scheduleIdleTask = (task: () => void, timeoutMs = 1000): IdleTaskHandle => {
  const idleWindow = window as IdleWindow
  let idleId: number | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleId = idleWindow.requestIdleCallback(task)
  } else {
    timeoutId = setTimeout(task, timeoutMs)
  }

  return {
    cancel: () => {
      if (idleId !== null && typeof idleWindow.cancelIdleCallback === 'function') {
        idleWindow.cancelIdleCallback(idleId)
        idleId = null
      }

      if (timeoutId !== null) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }
  }
}
