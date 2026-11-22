import type { AdminClock } from '../../src/Web/src/admin/adminOperationCoordinator.ts'

export class FakeClock implements AdminClock {
  currentTime: number
  private nextId = 1
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>()
  readonly scheduledDelays: number[] = []
  readonly allCallbacks: Array<() => void> = []
  clearedCount = 0

  constructor(startMs = 1_700_000_000_000) {
    this.currentTime = startMs
  }

  now(): number {
    return this.currentTime
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++
    this.scheduledDelays.push(delayMs)
    this.allCallbacks.push(callback)
    this.timers.set(id, { dueAt: this.currentTime + Math.max(0, delayMs), callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number' && this.timers.delete(handle)) {
      this.clearedCount++
    }
  }

  get activeTimerCount(): number {
    return this.timers.size
  }

  advance(deltaMs: number): void {
    const target = this.currentTime + deltaMs
    while (true) {
      let earliestId: number | undefined
      let earliestDue = Infinity
      for (const [id, entry] of this.timers) {
        if (entry.dueAt <= target && entry.dueAt < earliestDue) {
          earliestDue = entry.dueAt
          earliestId = id
        }
      }
      if (earliestId === undefined) break
      const entry = this.timers.get(earliestId)!
      this.timers.delete(earliestId)
      this.currentTime = Math.max(this.currentTime, entry.dueAt)
      entry.callback()
    }
    this.currentTime = target
  }
}
