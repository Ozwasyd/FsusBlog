import { computed, ref } from 'vue'
import {
  CommentModerationStatus,
  moderateComment,
  moderateCommentsBulk,
  type CommentModerationItemResponse
} from '@/api/authoring'
import { startMfaChallenge, verifyMfaChallenge } from '@/api/auth'
import { commentModerationStatusLabel } from '@/composables/useCommentModerationQueue'
import { AppErrorCode, isAppError } from '@/utils/appError'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { promptText, toast } from '@/fsusui/feedback'

const AdminSensitiveAction = 'admin-sensitive'

function isBanEligibleStatus(status: CommentModerationStatus): boolean {
  return status === CommentModerationStatus.Rejected || status === CommentModerationStatus.Hidden
}

function normalizeModerationReason(status: CommentModerationStatus, reason: string): string {
  const trimmed = reason.trim()
  return trimmed.length > 0 ? trimmed : commentModerationStatusLabel(status)
}

function moderationErrorMessage(error: unknown, fallback: string): string {
  if (!isAppError(error)) {
    if (error instanceof Error) {
      if (error.message === 'MFA_CHALLENGE_CANCELLED') {
        return '已取消管理员二次验证'
      }
      if (error.message === 'MFA_CHALLENGE_REQUIRED' || error.message === 'MFA_PROOF_REQUIRED') {
        return '管理员验证已过期，请重新完成二次验证'
      }
    }
    return fallback
  }

  const message = error.message || fallback
  if (message.includes('MFA_PROOF_REQUIRED') || message.includes('MFA_CHALLENGE_REQUIRED') || error.status === 428) {
    return '管理员验证已过期，请重新完成二次验证'
  }
  if (error.code === AppErrorCode.Forbidden || error.status === 403) {
    return '当前账号无权限执行该审核操作'
  }
  if (error.code === AppErrorCode.Conflict || error.status === 409) {
    return '该评论已被其他管理员处理，请刷新队列'
  }
  if (error.code === AppErrorCode.NotFound || error.status === 404) {
    return '评论不存在或已删除，队列需要刷新'
  }
  if (error.code === AppErrorCode.RateLimited || error.status === 429) {
    return '审核操作过于频繁，请稍后再试'
  }
  if (error.code === AppErrorCode.Unauthorized || error.status === 401) {
    return '登录状态已失效，请重新登录'
  }
  return message
}

export function useCommentModerationActions() {
  const selectedIds = ref<string[]>([])
  const actionReason = ref('')
  const banUsers = ref(false)
  const processingId = ref<string | null>(null)
  const processingBulk = ref(false)
  const isProcessing = computed(() => processingBulk.value || processingId.value !== null)

  const toggleSelection = (id: string, checked: boolean): void => {
    selectedIds.value = checked
      ? [...new Set([...selectedIds.value, id])]
      : selectedIds.value.filter((selectedId) => selectedId !== id)
  }

  const clearSelection = (): void => {
    selectedIds.value = []
  }

  const pruneSelection = (availableIds: readonly string[]): void => {
    const available = new Set(availableIds)
    selectedIds.value = selectedIds.value.filter((id) => available.has(id))
  }

  const ensureAdminSensitiveProof = async (): Promise<string> => {
    const challenge = await startMfaChallenge(AdminSensitiveAction)
    if (challenge.verified && challenge.proofToken) {
      return challenge.proofToken
    }

    const challengeToken = challenge.proofToken
    if (!challengeToken) {
      throw new Error('MFA_CHALLENGE_REQUIRED')
    }

    const code = await promptText('输入 MFA 验证码或恢复码', '管理员二次验证', {
      confirmButtonText: '确认',
      cancelButtonText: '取消',
      inputPlaceholder: '验证码或恢复码',
      inputValidator: (value: string) => value.trim().length > 0 || '请输入验证码或恢复码'
    })
    if (!code) {
      throw new Error('MFA_CHALLENGE_CANCELLED')
    }

    const proof = await verifyMfaChallenge({
      challengeToken,
      code,
      action: AdminSensitiveAction
    })
    if (!proof.verified || !proof.proofToken) {
      throw new Error('MFA_PROOF_REQUIRED')
    }

    return proof.proofToken
  }

  const applySingle = async (
    comment: CommentModerationItemResponse,
    status: CommentModerationStatus,
    afterSuccess?: () => Promise<void> | void
  ): Promise<boolean> => {
    processingId.value = comment.id
    try {
      const mfaProofToken = await ensureAdminSensitiveProof()
      await moderateComment(comment.id, {
        status,
        reason: normalizeModerationReason(status, actionReason.value),
        banUser: banUsers.value && isBanEligibleStatus(status)
      }, {
        mfaProofToken
      })
      toast.success('评论审核状态已更新')
      await afterSuccess?.()
      return true
    } catch (error: unknown) {
      showErrorToast(moderationErrorMessage(error, '评论审核操作失败'), '评论审核操作失败')
      return false
    } finally {
      processingId.value = null
    }
  }

  const applyBulk = async (
    status: CommentModerationStatus,
    afterSuccess?: () => Promise<void> | void
  ): Promise<boolean> => {
    if (selectedIds.value.length === 0) {
      showWarningToast('请先选择评论')
      return false
    }

    processingBulk.value = true
    try {
      const mfaProofToken = await ensureAdminSensitiveProof()
      const result = await moderateCommentsBulk({
        commentIds: selectedIds.value,
        status,
        reason: normalizeModerationReason(status, actionReason.value),
        banUsers: banUsers.value && isBanEligibleStatus(status)
      }, {
        mfaProofToken
      })
      toast.success(`已处理 ${result.updated} 条评论`)
      selectedIds.value = []
      await afterSuccess?.()
      return true
    } catch (error: unknown) {
      showErrorToast(moderationErrorMessage(error, '批量审核操作失败'), '批量审核操作失败')
      return false
    } finally {
      processingBulk.value = false
    }
  }

  return {
    selectedIds,
    actionReason,
    banUsers,
    processingId,
    processingBulk,
    isProcessing,
    toggleSelection,
    clearSelection,
    pruneSelection,
    ensureAdminSensitiveProof,
    applySingle,
    applyBulk
  }
}
