import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ElMessageBox } from '@ozwasyd/element-plus'
import { requestGlobalConfirm } from '@/composables/useGlobalConfirm'

describe('requestGlobalConfirm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true when user confirms', async () => {
    const mockConfirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValueOnce({ ok: true, value: 'confirm' } as never)
    const result = await requestGlobalConfirm({
      title: 'Delete?',
      content: 'Are you sure?',
      confirmText: 'Yes',
      cancelText: 'No'
    })
    expect(result).toBe(true)
    expect(mockConfirm).toHaveBeenCalledWith(
      'Are you sure?',
      'Delete?',
      expect.objectContaining({
        confirmButtonText: 'Yes',
        cancelButtonText: 'No'
      })
    )
  })

  it('returns false when user cancels', async () => {
    const mockConfirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'aborted',
        category: 'user',
        message: 'cancelled'
      }
    } as never)
    const result = await requestGlobalConfirm({
      title: 'Confirm',
      content: 'Do it?'
    })
    expect(result).toBe(false)
  })

  it('uses default confirm/cancel texts when not provided', async () => {
    const mockConfirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValueOnce({ ok: true, value: 'confirm' } as never)
    await requestGlobalConfirm({ title: 'T', content: 'C' })
    expect(mockConfirm).toHaveBeenCalledWith(
      'C', 'T',
      expect.objectContaining({
        confirmButtonText: '确认',
        cancelButtonText: '取消'
      })
    )
  })
})
