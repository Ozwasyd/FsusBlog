import { afterEach, describe, expect, it, vi } from 'vitest'

class MockWorker {
  static instances: MockWorker[] = []

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly messages: unknown[] = []
  terminated = false

  constructor() {
    MockWorker.instances.push(this)
  }

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  terminate(): void {
    this.terminated = true
  }
}

describe('usePow abort handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
    MockWorker.instances = []
  })

  it('calculate aborts matching active run without crashing worker runtime', async () => {
    vi.stubGlobal('Worker', MockWorker)
    const { usePow } = await import('@/composables/usePow')
    const controller = new AbortController()
    const pow = usePow()

    const calculation = pow.calculate('salt-value', 'browser-fp', 4, 30000, controller.signal)
    expect(MockWorker.instances).toHaveLength(1)
    expect(pow.isCalculating.value).toBe(true)

    controller.abort()

    await expect(calculation).rejects.toMatchObject({ name: 'PowAbortError' })
    expect(MockWorker.instances[0].terminated).toBe(true)
    expect(MockWorker.instances[0].onmessage).toBeNull()
    expect(MockWorker.instances[0].onerror).toBeNull()
    expect(pow.isCalculating.value).toBe(false)
  })
})
