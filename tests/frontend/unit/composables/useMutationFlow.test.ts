import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useMutationFlow } from '@/composables/useMutationFlow'

vi.mock('@/utils/errorPresentation', () => ({
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn()
}))

vi.mock('@/fsusui/feedback', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn()
  }
}))

vi.mock('@/composables/useGlobalConfirm', () => ({
  requestGlobalConfirm: vi.fn().mockResolvedValue(true)
}))

import { toast } from '@/fsusui/feedback'
import { showWarningToast } from '@/utils/errorPresentation'
import { requestGlobalConfirm } from '@/composables/useGlobalConfirm'

describe('useMutationFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('run returns ok:true when executor succeeds', async () => {
    const flow = useMutationFlow()
    const result = await flow.run(
      () => Promise.resolve(),
      { fallbackMessage: 'failed' }
    )
    expect(result.ok).toBe(true)
    expect(result.mutationSucceeded).toBe(true)
    expect(result.postSuccessSyncFailed).toBe(false)
  })

  it('run shows success toast when successMessage provided', async () => {
    const flow = useMutationFlow()
    await flow.run(
      () => Promise.resolve(),
      { fallbackMessage: 'failed', successMessage: 'Done!', successType: 'success' }
    )
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Done!')
  })

  it('run shows warning toast for successType=warning', async () => {
    const flow = useMutationFlow()
    await flow.run(
      () => Promise.resolve(),
      { fallbackMessage: 'failed', successMessage: 'Careful!', successType: 'warning' }
    )
    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith('Careful!')
  })

  it('run shows error toast for successType=error', async () => {
    const flow = useMutationFlow()
    await flow.run(
      () => Promise.resolve(),
      { fallbackMessage: 'failed', successMessage: 'Err!', successType: 'error' }
    )
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Err!')
  })

  it('run shows info toast for successType=info', async () => {
    const flow = useMutationFlow()
    await flow.run(
      () => Promise.resolve(),
      { fallbackMessage: 'failed', successMessage: 'Info', successType: 'info' }
    )
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Info')
  })

  it('run returns ok:false when executor throws', async () => {
    const flow = useMutationFlow()
    const result = await flow.run(
      () => Promise.reject(new Error('executor error')),
      { fallbackMessage: 'Operation failed' }
    )
    expect(result.ok).toBe(false)
    expect(result.mutationSucceeded).toBe(false)
  })

  it('run calls onSuccess and returns postSuccessSyncFailed=false on success', async () => {
    const flow = useMutationFlow()
    const onSuccess = vi.fn().mockResolvedValue(true)
    const result = await flow.run(
      () => Promise.resolve(),
      { fallbackMessage: 'failed', onSuccess }
    )
    expect(onSuccess).toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.postSuccessSyncFailed).toBe(false)
  })

  it('run sets postSuccessSyncFailed=true when onSuccess returns false', async () => {
    const flow = useMutationFlow()
    const result = await flow.run(
      () => Promise.resolve(),
      { fallbackMessage: 'failed', onSuccess: () => false }
    )
    expect(result.postSuccessSyncFailed).toBe(true)
    expect(showWarningToast).toHaveBeenCalled()
  })

  it('run sets postSuccessSyncFailed=true when onSuccess throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const flow = useMutationFlow()
    const result = await flow.run(
      () => Promise.resolve(),
      { fallbackMessage: 'failed', onSuccess: () => { throw new Error('sync error') } }
    )
    expect(result.postSuccessSyncFailed).toBe(true)
    expect(result.postSuccessError).toBeInstanceOf(Error)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('confirmThenRun proceeds when confirmed', async () => {
    vi.mocked(requestGlobalConfirm).mockResolvedValueOnce(true)
    const flow = useMutationFlow()
    const executor = vi.fn().mockResolvedValue(undefined)
    const result = await flow.confirmThenRun(
      { title: 'T', message: 'M', confirmButtonText: 'OK' },
      executor,
      { fallbackMessage: 'failed' }
    )
    expect(executor).toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it('confirmThenRun returns ok:false when user cancels', async () => {
    vi.mocked(requestGlobalConfirm).mockResolvedValueOnce(false)
    const flow = useMutationFlow()
    const executor = vi.fn()
    const result = await flow.confirmThenRun(
      { title: 'T', message: 'M', confirmButtonText: 'OK' },
      executor,
      { fallbackMessage: 'failed' }
    )
    expect(executor).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.mutationSucceeded).toBe(false)
  })
})
