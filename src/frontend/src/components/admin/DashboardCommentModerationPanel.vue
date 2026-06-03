<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-labelledby="comment-moderation-title">
    <header class="border-b border-[var(--fsusblog-panel-border)] p-8">
      <div class="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">评论审核 / MODERATION</div>
          <h2 id="comment-moderation-title" class="mt-4 text-3xl font-bold text-[var(--fsusblog-text-primary)]">待审与处置队列</h2>
          <p class="mt-4 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">
            新评论先进入审核队列，批准后才进入公开评论流；隐藏或拒绝可联动封禁用户并写入审计。
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <el-radio-group v-model="statusFilter" size="small" @change="refreshQueue">
            <el-radio-button v-for="option in statusOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </el-radio-button>
          </el-radio-group>
          <el-button :icon="Refresh" size="small" @click="refreshQueue">刷新</el-button>
        </div>
      </div>
    </header>

    <div class="grid grid-cols-1 sm:grid-cols-3 gap-px bg-[var(--fsusblog-panel-bg-soft)]">
      <div v-for="counter in counters" :key="counter.label" class="bg-[var(--fsusblog-page-bg)] p-6">
        <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ counter.label }}</div>
        <div class="mt-3 text-3xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ counter.value }}</div>
      </div>
    </div>

    <div class="border-t border-[var(--fsusblog-panel-border)] p-8" v-loading="loading">
      <div class="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <el-input
          v-model="actionReason"
          maxlength="120"
          show-word-limit
          placeholder="审核原因，会写入评论审核审计"
          aria-label="评论审核原因"
        />
        <div class="flex flex-wrap items-center gap-3">
          <el-checkbox v-model="banUsers">联动封禁用户</el-checkbox>
          <el-button :icon="Check" size="small" type="success" :disabled="selectedIds.length === 0" @click="applyBulk(CommentModerationStatus.Approved)">
            批量通过
          </el-button>
          <el-button :icon="Close" size="small" type="danger" :disabled="selectedIds.length === 0" @click="applyBulk(CommentModerationStatus.Rejected)">
            批量拒绝
          </el-button>
          <el-button :icon="Hide" size="small" :disabled="selectedIds.length === 0" @click="applyBulk(CommentModerationStatus.Hidden)">
            批量隐藏
          </el-button>
        </div>
      </div>

      <div v-if="!loading && items.length === 0" class="flex min-h-60 items-center justify-center">
        <el-empty description="暂无匹配的评论审核项" />
      </div>

      <div v-else class="divide-y divide-[var(--fsusblog-panel-border)] border-y border-[var(--fsusblog-panel-border)]">
        <article v-for="comment in items" :key="comment.id" class="grid grid-cols-[auto_minmax(0,1fr)] gap-5 bg-[var(--fsusblog-page-bg)] p-6">
          <el-checkbox
            :model-value="selectedIds.includes(comment.id)"
            :aria-label="`选择评论 ${comment.id}`"
            @change="(value: unknown) => toggleSelection(comment.id, Boolean(value))"
          />
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-3">
              <span class="text-xs font-bold text-[var(--fsusblog-text-primary)]">{{ comment.userName }}</span>
              <span class="text-[11px] font-bold text-[var(--fsusblog-text-muted)]">#{{ comment.id }}</span>
              <span class="text-[11px] font-bold text-[var(--fsusblog-text-muted)]">文章 {{ comment.articleId }} · {{ comment.articleTitle }}</span>
              <SemanticTime
                :value="comment.createTime"
                class="text-[11px] font-bold tabular-nums text-[var(--fsusblog-text-muted)]"
              />
            </div>
            <p class="mt-4 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--fsusblog-text-secondary)]">{{ comment.content }}</p>
            <div class="mt-4 flex flex-wrap items-center gap-2">
              <span v-for="reason in comment.hitReasons" :key="reason" class="border border-[var(--fsusblog-panel-border)] px-2 py-1 text-[11px] font-bold text-[var(--fsusblog-text-muted)]">
                {{ reasonLabel(reason) }}
              </span>
              <span class="px-2 py-1 text-[11px] font-black text-[var(--fsusblog-page-bg)]" :class="statusClass(comment.status)">
                {{ statusLabel(comment.status) }}
              </span>
            </div>
            <div class="mt-5 flex flex-wrap gap-3">
              <el-button :icon="Check" size="small" type="success" @click="applySingle(comment, CommentModerationStatus.Approved)">通过</el-button>
              <el-button :icon="Close" size="small" type="danger" @click="applySingle(comment, CommentModerationStatus.Rejected)">拒绝</el-button>
              <el-button :icon="Hide" size="small" @click="applySingle(comment, CommentModerationStatus.Hidden)">隐藏</el-button>
            </div>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessageBox } from '@ozwasyd/element-plus'
import { Check, Close, Hide, Refresh } from '@/ui/fsusIcons'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import {
  CommentModerationStatus,
  listCommentModerationQueue,
  moderateComment,
  moderateCommentsBulk,
  type CommentModerationItemResponse,
  type CommentModerationQueueResponse
} from '@/api/authoring'
import { startMfaChallenge, verifyMfaChallenge } from '@/api/auth'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { isFsusUiOk } from '@/utils/fsusUiResult'
import { toast } from '@/utils/toast'

const AdminSensitiveAction = 'admin-sensitive'

const loading = ref(false)
const queue = ref<CommentModerationQueueResponse | null>(null)
const statusFilter = ref<CommentModerationStatus>(CommentModerationStatus.Pending)
const selectedIds = ref<string[]>([])
const actionReason = ref('')
const banUsers = ref(false)

const statusOptions = [
  { value: CommentModerationStatus.Pending, label: '待审' },
  { value: CommentModerationStatus.Approved, label: '已通过' },
  { value: CommentModerationStatus.Rejected, label: '已拒绝' },
  { value: CommentModerationStatus.Hidden, label: '已隐藏' }
] as const

const items = computed(() => queue.value?.items ?? [])
const counters = computed(() => [
  { label: '待审', value: queue.value?.pendingCount ?? 0 },
  { label: '已拒绝', value: queue.value?.rejectedCount ?? 0 },
  { label: '已隐藏', value: queue.value?.hiddenCount ?? 0 }
])

const refreshQueue = async (): Promise<void> => {
  loading.value = true
  try {
    queue.value = await listCommentModerationQueue(statusFilter.value, 50)
    selectedIds.value = selectedIds.value.filter((id) => items.value.some((comment) => comment.id === id))
  } catch (error: unknown) {
    showErrorToast(error, '评论审核队列加载失败')
  } finally {
    loading.value = false
  }
}

const toggleSelection = (id: string, checked: boolean): void => {
  selectedIds.value = checked
    ? [...new Set([...selectedIds.value, id])]
    : selectedIds.value.filter((selectedId) => selectedId !== id)
}

const applySingle = async (comment: CommentModerationItemResponse, status: CommentModerationStatus): Promise<void> => {
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    await moderateComment(comment.id, {
      status,
      reason: normalizeReason(status),
      banUser: banUsers.value && shouldLinkBan(status)
    }, {
      mfaProofToken
    })
    toast.success('评论审核状态已更新')
    await refreshQueue()
  } catch (error: unknown) {
    showErrorToast(error, '评论审核操作失败')
  }
}

const applyBulk = async (status: CommentModerationStatus): Promise<void> => {
  if (selectedIds.value.length === 0) {
    showWarningToast('请先选择评论', '请先选择评论')
    return
  }

  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    const result = await moderateCommentsBulk({
      commentIds: selectedIds.value,
      status,
      reason: normalizeReason(status),
      banUsers: banUsers.value && shouldLinkBan(status)
    }, {
      mfaProofToken
    })
    toast.success(`已处理 ${result.updated} 条评论`)
    selectedIds.value = []
    await refreshQueue()
  } catch (error: unknown) {
    showErrorToast(error, '批量审核操作失败')
  }
}

const normalizeReason = (status: CommentModerationStatus): string => {
  const reason = actionReason.value.trim()
  return reason.length > 0 ? reason : statusLabel(status)
}

const shouldLinkBan = (status: CommentModerationStatus): boolean =>
  status === CommentModerationStatus.Rejected || status === CommentModerationStatus.Hidden

const ensureAdminSensitiveProof = async (): Promise<string> => {
  const challenge = await startMfaChallenge(AdminSensitiveAction)
  if (challenge.verified && challenge.proofToken) {
    return challenge.proofToken
  }

  const challengeToken = challenge.proofToken
  if (!challengeToken) {
    throw new Error('MFA_CHALLENGE_REQUIRED')
  }

  const result = await ElMessageBox.prompt('输入 MFA 验证码或恢复码', '管理员二次验证', {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    inputPlaceholder: '验证码或恢复码',
    inputValidator: (value: string) => value.trim().length > 0 || '请输入验证码或恢复码'
  })
  if (!isFsusUiOk(result)) {
    throw new Error('MFA_CHALLENGE_CANCELLED')
  }

  const proof = await verifyMfaChallenge({
    challengeToken,
    code: ((result as { value?: { value?: string } }).value?.value ?? '').trim(),
    action: AdminSensitiveAction
  })
  if (!proof.verified || !proof.proofToken) {
    throw new Error('MFA_PROOF_REQUIRED')
  }

  return proof.proofToken
}

const statusLabel = (status: CommentModerationStatus): string => {
  switch (status) {
    case CommentModerationStatus.Pending:
      return '待审'
    case CommentModerationStatus.Approved:
      return '已通过'
    case CommentModerationStatus.Rejected:
      return '已拒绝'
    case CommentModerationStatus.Hidden:
      return '已隐藏'
    default:
      return '未知'
  }
}

const statusClass = (status: CommentModerationStatus): string => {
  switch (status) {
    case CommentModerationStatus.Approved:
      return 'bg-[var(--fsusblog-color-success)]'
    case CommentModerationStatus.Rejected:
      return 'bg-[var(--fsusblog-color-error)]'
    case CommentModerationStatus.Hidden:
      return 'bg-[var(--fsusblog-text-muted)]'
    default:
      return 'bg-[var(--fsusblog-color-warning)]'
  }
}

const reasonLabel = (reason: string): string => {
  const labels: Record<string, string> = {
    'pending-review': '待人工审核',
    'manual-review': '人工复核',
    'html-risk': 'HTML 风险',
    'link-heavy': '链接密集',
    'spam-repeat': '重复刷屏',
    sensitive_term_detected: '敏感词命中',
    malicious_ad_detected: '广告/引流',
    contact_lead_detected: '联系方式引流',
    political_redline_detected: '红线词命中'
  }
  return labels[reason] ?? reason
}

onMounted(() => {
  void refreshQueue()
})
</script>
