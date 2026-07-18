type AnimationFrameTimer = ReturnType<typeof setTimeout>

export type UnitAnimationFrameEnvironment = Readonly<{
  request: (callback: FrameRequestCallback) => number
  cancel: (id: number) => void
  dispose: () => void
}>

export function createUnitAnimationFrameEnvironment(): UnitAnimationFrameEnvironment {
  const pendingFrames = new Map<AnimationFrameTimer, typeof clearTimeout>()
  let disposed = false

  const cancel = (id: number): void => {
    const timer = id as unknown as AnimationFrameTimer
    const cancelTimer = pendingFrames.get(timer) ?? clearTimeout
    pendingFrames.delete(timer)
    cancelTimer(timer)
  }

  const request = (callback: FrameRequestCallback): number => {
    if (disposed) return 0

    const cancelTimer = clearTimeout
    const timer = setTimeout(() => {
      pendingFrames.delete(timer)
      if (!disposed) callback(Date.now())
    }, 0)
    pendingFrames.set(timer, cancelTimer)
    return timer as unknown as number
  }

  const dispose = (): void => {
    disposed = true
    for (const [timer, cancelTimer] of pendingFrames) cancelTimer(timer)
    pendingFrames.clear()
  }

  return { request, cancel, dispose }
}
