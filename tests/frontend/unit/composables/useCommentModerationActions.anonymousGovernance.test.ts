import { effectScope } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCommentModerationActions } from '@/composables/useCommentModerationActions'
import type { CommentModerationViewItem } from '@/composables/useCommentModerationQueue'
import { AppErrorCode, createAppError } from '@/utils/appError'
import { verifyMfaChallenge } from '@/api/auth'
import { blockAnonymousNullifier, revokeAnonymousCredential } from '@/api/authoring'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { promptText, toast } from '@/fsusui/feedback'

const mocks = vi.hoisted(() => ({
  moderateComment: vi.fn(),
  moderateCommentsBulk: vi.fn(),
  blockAnonymousNullifier: vi.fn(),
  revokeAnonymousCredential: vi.fn(),
  ensureAdminSensitiveProof: vi.fn(),
  verifyMfaChallenge: vi.fn(),
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
  promptText: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/api/authoring', () => ({
  CommentModerationStatus: {
    Pending: 0,
    Approved: 1,
    Rejected: 2,
    Hidden: 3
  },
  moderateComment: mocks.moderateComment,
  moderateCommentsBulk: mocks.moderateCommentsBulk,
  blockAnonymousNullifier: mocks.blockAnonymousNullifier,
  revokeAnonymousCredential: mocks.revokeAnonymousCredential
}))

vi.mock('@/api/auth', () => ({
  verifyMfaChallenge: mocks.verifyMfaChallenge
}))

vi.mock('@/composables/useAdminSensitiveProof', () => ({
  ensureAdminSensitiveProof: mocks.ensureAdminSensitiveProof
}))

vi.mock('@/utils/errorPresentation', () => ({
  showErrorToast: mocks.showErrorToast,
  showWarningToast: mocks.showWarningToast
}))

vi.mock('@/fsusui/feedback', () => ({
  promptText: mocks.promptText,
  toast: {
    success: mocks.toastSuccess,
    info: mocks.toastInfo,
    error: mocks.toastError
  }
}))

const nullifierItem = {
  id: 'comment-42',
  actorDisplayName: '强匿名评论者',
  anonymousScope: 'article:42',
  nullifierHash: 'hash_abc',
  anonymousCredentialId: 'credential-88001',
  canBlockAnonymousNullifier: true,
  canRevokeAnonymousCredential: true
} as unknown as CommentModerationViewItem

describe('useCommentModerationActions anonymous governance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ensureAdminSensitiveProof.mockResolvedValue('proof-admin')
    mocks.promptText.mockResolvedValue('abuse confirmed')
  })

  it('blocks anonymous nullifiers through the real authoring API and refreshes the queue', async () => {
    mocks.blockAnonymousNullifier.mockResolvedValue({ applied: true })
    const scope = effectScope()
    const actions = scope.run(() => useCommentModerationActions())!
    const afterSuccess = vi.fn()

    await expect(actions.applyBlockAnonymousNullifier(nullifierItem, afterSuccess)).resolves.toBe(true)

    expect(promptText).toHaveBeenCalledWith(
      '输入处理原因',
      '封禁匿名 Nullifier',
      expect.objectContaining({
        confirmButtonText: '封禁',
        inputPlaceholder: '说明封禁原因'
      })
    )
    expect(mocks.ensureAdminSensitiveProof).toHaveBeenCalledTimes(1)
    expect(blockAnonymousNullifier).toHaveBeenCalledWith({
      nullifierHash: 'hash_abc',
      scope: 'article:42',
      reason: 'abuse confirmed'
    }, {
      mfaProofToken: 'proof-admin'
    })
    expect(afterSuccess).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('匿名 Nullifier 已封禁')
    scope.stop()
  })

  it('revokes anonymous credentials through the real authoring API and refreshes the queue', async () => {
    mocks.revokeAnonymousCredential.mockResolvedValue({ applied: true })
    const scope = effectScope()
    const actions = scope.run(() => useCommentModerationActions())!
    const afterSuccess = vi.fn()

    await expect(actions.applyRevokeAnonymousCredential(nullifierItem, afterSuccess)).resolves.toBe(true)

    expect(verifyMfaChallenge).not.toHaveBeenCalled()
    expect(revokeAnonymousCredential).toHaveBeenCalledWith('credential-88001', {
      reason: 'abuse confirmed'
    }, {
      mfaProofToken: 'proof-admin'
    })
    expect(afterSuccess).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('匿名凭证已撤销')
    scope.stop()
  })

  it.each([
    {
      status: 403,
      code: AppErrorCode.Forbidden,
      expected: '当前账号无权限执行匿名治理操作'
    },
    {
      status: 428,
      code: AppErrorCode.Validation,
      expected: '管理员验证已过期，请重新完成二次验证'
    },
    {
      status: 404,
      code: AppErrorCode.NotFound,
      expected: '匿名治理对象不存在或已失效，请刷新队列'
    },
    {
      status: 429,
      code: AppErrorCode.RateLimited,
      expected: '匿名治理操作过于频繁，请稍后再试'
    }
  ])('shows a readable anonymous governance error for HTTP $status', async ({ status, code, expected }) => {
    mocks.blockAnonymousNullifier.mockRejectedValue(createAppError(code, 'request failed', { status }))
    const scope = effectScope()
    const actions = scope.run(() => useCommentModerationActions())!

    await expect(actions.applyBlockAnonymousNullifier(nullifierItem)).resolves.toBe(false)

    expect(showErrorToast).toHaveBeenCalledWith(expected, '匿名 Nullifier 封禁失败')
    scope.stop()
  })

  it('does not call the API when the selected anonymous actor is missing governance data', async () => {
    const scope = effectScope()
    const actions = scope.run(() => useCommentModerationActions())!

    await expect(actions.applyBlockAnonymousNullifier({
      ...nullifierItem,
      nullifierHash: null
    } as unknown as CommentModerationViewItem)).resolves.toBe(false)

    expect(blockAnonymousNullifier).not.toHaveBeenCalled()
    expect(showWarningToast).toHaveBeenCalledWith('当前匿名主体缺少可封禁的 Nullifier 信息')
    scope.stop()
  })
})
