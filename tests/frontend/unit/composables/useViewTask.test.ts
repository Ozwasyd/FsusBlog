import { describe, it, expect, vi } from 'vitest'
import { useViewTask } from '@/composables/useViewTask'

describe('useViewTask', () => {
  it('initial state is idle', () => {
    const vt = useViewTask()
    expect(vt.loading.value).toBe(false)
    expect(vt.errorMessage.value).toBe('')
    expect(vt.hasError.value).toBe(false)
    expect(vt.isRunning.value).toBe(false)
  })

  it('run sets loading and returns result', async () => {
    const vt = useViewTask()
    const result = await vt.run(() => Promise.resolve('hello'))
    expect(result).toBe('hello')
    expect(vt.loading.value).toBe(false)
    expect(vt.errorMessage.value).toBe('')
  })

  it('run sets errorMessage on error', async () => {
    const vt = useViewTask()
    await vt.run(() => Promise.reject(new Error('something broke')))
    expect(vt.errorMessage.value).toContain('something broke')
    expect(vt.hasError.value).toBe(true)
    expect(vt.loading.value).toBe(false)
  })

  it('run clears errorMessage by default', async () => {
    const vt = useViewTask()
    vt.errorMessage.value = 'old error'
    await vt.run(() => Promise.resolve('ok'))
    expect(vt.errorMessage.value).toBe('')
  })

  it('run does NOT clear error when clearError=false', async () => {
    const vt = useViewTask()
    vt.errorMessage.value = 'old error'
    await vt.run(() => Promise.resolve('ok'), { clearError: false })
    // original error is preserved
    expect(vt.errorMessage.value).toBe('old error')
  })

  it('run returns undefined for abort errors (no error set)', async () => {
    const vt = useViewTask()
    const abortError = new DOMException('Aborted', 'AbortError')
    const result = await vt.run(() => Promise.reject(abortError))
    expect(result).toBeUndefined()
    expect(vt.errorMessage.value).toBe('')
  })

  it('run calls onError callback', async () => {
    const vt = useViewTask()
    const onError = vi.fn()
    await vt.run(() => Promise.reject(new Error('err')), { onError })
    expect(onError).toHaveBeenCalledOnce()
    const [error, message] = onError.mock.calls[0]
    expect(message).toContain('err')
  })

  it('run uses fallbackMessage when error has no message', async () => {
    const vt = useViewTask()
    await vt.run(() => Promise.reject(null), { fallbackMessage: 'default msg' })
    expect(vt.errorMessage.value).toContain('default msg')
  })

  it('clearError clears the error message', async () => {
    const vt = useViewTask()
    await vt.run(() => Promise.reject(new Error('error')))
    vt.clearError()
    expect(vt.errorMessage.value).toBe('')
    expect(vt.hasError.value).toBe(false)
  })

  it('cancel cancels the running task', async () => {
    const vt = useViewTask()
    // Start a never-resolving task
    const runPromise = vt.run(() => new Promise(() => {}))
    expect(vt.isRunning.value).toBe(true)
    vt.cancel()
    expect(vt.isRunning.value).toBe(false)
  })
})
