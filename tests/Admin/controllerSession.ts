import { strict as assert } from 'node:assert'
import type { AdminClock } from '../../src/Web/src/admin/adminOperationCoordinator.ts'

export function bindTestSession(controller: { bindSession(signal: AbortSignal): void }): AbortController {
  const session = new AbortController()
  controller.bindSession(session.signal)
  return session
}

export async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

export async function bindAndFlush(controller: { bindSession(signal: AbortSignal): void }): Promise<AbortController> {
  const session = bindTestSession(controller)
  await flushMicrotasks()
  return session
}

export function expectFields<T extends object>(actual: T, expected: Partial<T>): void {
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual((actual as Record<string, unknown>)[key], value, key)
}

export class FakeClock implements AdminClock {
  currentTime: number
  private nextId = 1
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>()
  readonly scheduledDelays: number[] = []
  readonly allCallbacks: Array<() => void> = []

  constructor(startMs = 1_700_000_000_000) { this.currentTime = startMs }
  now() { return this.currentTime }
  get activeTimerCount() { return this.timers.size }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++
    this.scheduledDelays.push(delayMs)
    this.allCallbacks.push(callback)
    this.timers.set(id, { dueAt: this.currentTime + Math.max(0, delayMs), callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  advance(deltaMs: number): void {
    const target = this.currentTime + deltaMs
    while (true) {
      let earliest: [number, { dueAt: number; callback: () => void }] | undefined
      for (const entry of this.timers)
        if (entry[1].dueAt <= target && (!earliest || entry[1].dueAt < earliest[1].dueAt)) earliest = entry
      if (!earliest) break
      this.timers.delete(earliest[0])
      this.currentTime = Math.max(this.currentTime, earliest[1].dueAt)
      earliest[1].callback()
    }
    this.currentTime = target
  }
}
