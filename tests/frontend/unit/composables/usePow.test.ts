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

  completeMessage(index: number, nonce = `nonce-${index}`): void {
    const message = this.messages[index] as { runId?: number } | undefined
    this.onmessage?.({
      data: {
        success: true,
        nonce,
        duration: index + 1,
        runId: message?.runId,
        type: 'CALC_RESULT'
      }
    } as MessageEvent)
  }

  crash(): void {
    this.onerror?.({} as ErrorEvent)
  }
}

async function createPow() {
  vi.stubGlobal('Worker', MockWorker)
  const { usePow } = await import('@/composables/usePow')
  return usePow()
}

describe('usePow queued worker scheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
    vi.restoreAllMocks()
    MockWorker.instances = []
  })

  it('calculate queues concurrent pow tasks instead of preempting', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const pow = await createPow()

    const first = pow.calculate('salt-a', 'browser-fp', 4)
    const second = pow.calculate('salt-b', 'browser-fp', 4)
    const worker = MockWorker.instances[0]

    expect(MockWorker.instances).toHaveLength(1)
    expect(worker.messages).toHaveLength(1)
    expect(worker.messages[0]).toMatchObject({ salt: 'salt-a', type: 'CALC' })
    expect(consoleInfo).not.toHaveBeenCalled()

    worker.completeMessage(0, 'nonce-a')
    await expect(first).resolves.toMatchObject({ nonce: 'nonce-a' })
    expect(worker.messages).toHaveLength(2)
    expect(worker.messages[1]).toMatchObject({ salt: 'salt-b', type: 'CALC' })

    worker.completeMessage(1, 'nonce-b')
    await expect(second).resolves.toMatchObject({ nonce: 'nonce-b' })
  })

  it('queued pow tasks run in fifo order', async () => {
    const pow = await createPow()

    const first = pow.calculate('salt-1', 'browser-fp', 4)
    const second = pow.calculate('salt-2', 'browser-fp', 4)
    const third = pow.calculate('salt-3', 'browser-fp', 4)
    const worker = MockWorker.instances[0]

    expect(worker.messages.map((message) => (message as { salt: string }).salt)).toEqual(['salt-1'])

    worker.completeMessage(0, 'nonce-1')
    await expect(first).resolves.toMatchObject({ nonce: 'nonce-1' })
    expect(worker.messages.map((message) => (message as { salt: string }).salt)).toEqual(['salt-1', 'salt-2'])

    worker.completeMessage(1, 'nonce-2')
    await expect(second).resolves.toMatchObject({ nonce: 'nonce-2' })
    expect(worker.messages.map((message) => (message as { salt: string }).salt)).toEqual(['salt-1', 'salt-2', 'salt-3'])

    worker.completeMessage(2, 'nonce-3')
    await expect(third).resolves.toMatchObject({ nonce: 'nonce-3' })
  })

  it('aborting queued task does not abort running task', async () => {
    const pow = await createPow()
    const queuedController = new AbortController()

    const running = pow.calculate('salt-running', 'browser-fp', 4)
    const queued = pow.calculate('salt-queued', 'browser-fp', 4, 30000, queuedController.signal)
    const worker = MockWorker.instances[0]

    queuedController.abort()

    await expect(queued).rejects.toMatchObject({ name: 'PowAbortError' })
    expect(worker.terminated).toBe(false)
    expect(worker.messages).toHaveLength(1)

    worker.completeMessage(0, 'nonce-running')
    await expect(running).resolves.toMatchObject({ nonce: 'nonce-running' })
    expect(worker.messages).toHaveLength(1)
  })

  it('aborting running task starts next queued task', async () => {
    const controller = new AbortController()
    const pow = await createPow()

    const running = pow.calculate('salt-running', 'browser-fp', 4, 30000, controller.signal)
    const queued = pow.calculate('salt-next', 'browser-fp', 4)
    const worker = MockWorker.instances[0]
    expect(MockWorker.instances).toHaveLength(1)
    expect(pow.isCalculating.value).toBe(true)
    expect(worker.messages).toHaveLength(1)

    controller.abort()

    await expect(running).rejects.toMatchObject({ name: 'PowAbortError' })
    expect(worker.terminated).toBe(false)
    expect(worker.messages).toHaveLength(2)
    expect(worker.messages[1]).toMatchObject({ salt: 'salt-next' })

    worker.completeMessage(1, 'nonce-next')
    await expect(queued).resolves.toMatchObject({ nonce: 'nonce-next' })
    expect(pow.isCalculating.value).toBe(false)
  })

  it('prewarm does not interrupt running task', async () => {
    const pow = await createPow()
    const running = pow.calculate('salt-running', 'browser-fp', 4)
    const worker = MockWorker.instances[0]

    pow.prewarm()

    expect(MockWorker.instances).toHaveLength(1)
    expect(worker.messages).toHaveLength(1)
    expect(worker.messages[0]).toMatchObject({ type: 'CALC' })
    expect(worker.terminated).toBe(false)

    worker.completeMessage(0, 'nonce-running')
    await expect(running).resolves.toMatchObject({ nonce: 'nonce-running' })
  })

  it('worker is reused across sequential tasks', async () => {
    const pow = await createPow()

    const first = pow.calculate('salt-1', 'browser-fp', 4)
    const worker = MockWorker.instances[0]
    worker.completeMessage(0, 'nonce-1')
    await expect(first).resolves.toMatchObject({ nonce: 'nonce-1' })

    const second = pow.calculate('salt-2', 'browser-fp', 4)
    expect(MockWorker.instances).toHaveLength(1)
    expect(MockWorker.instances[0]).toBe(worker)
    expect(worker.messages).toHaveLength(2)

    worker.completeMessage(1, 'nonce-2')
    await expect(second).resolves.toMatchObject({ nonce: 'nonce-2' })
    expect(worker.terminated).toBe(false)
  })

  it('worker terminates only on timeout or crash', async () => {
    vi.useFakeTimers()
    const pow = await createPow()

    const timedOut = pow.calculate('salt-timeout', 'browser-fp', 4, 5)
    const timeoutWorker = MockWorker.instances[0]
    vi.advanceTimersByTime(5)
    await expect(timedOut).rejects.toMatchObject({ code: 'Timeout' })
    expect(timeoutWorker.terminated).toBe(true)

    const crashed = pow.calculate('salt-crash', 'browser-fp', 4)
    const crashWorker = MockWorker.instances[1]
    crashWorker.crash()
    await expect(crashed).rejects.toMatchObject({ message: 'pow_worker_thread_crashed' })
    expect(crashWorker.terminated).toBe(true)
  })
})
