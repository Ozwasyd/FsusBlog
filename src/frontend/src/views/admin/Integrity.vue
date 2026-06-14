<template>
  <div class="account-page integrity-page account-motion-enter w-full">
    <AccountPageHeader
      title="数据巡检"
      description="检查文章、评论、分类标签、session、上传文件、搜索与 sitemap 的一致性。"
      compact
    />

    <AdminTaskFeedbackBar
      class="mb-8"
      :phase="taskFeedbackPhase"
      :message="taskFeedbackMessage"
      :detail="taskFeedbackDetail"
      :aria-message="taskFeedbackAriaMessage"
      :assertive-message="taskFeedbackAssertiveMessage"
      :busy="taskFeedbackBusy"
    />

    <WorkbenchPanel
      class="blog-motion-task-region mb-8"
      :class="{
        'blog-motion-task-region--pending': loading || fixing,
        'blog-motion-task-region--settled': isTaskHighlighted('integrity-report')
      }"
      title="巡检结果"
      title-id="integrity-report-title"
    >
      <template #actions>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <el-button :icon="Refresh" :loading="loading" @click="loadAll">一键检查</el-button>
          <el-button :icon="Download" :disabled="!report" @click="exportReport">导出报告</el-button>
        </div>
      </template>

      <div v-if="report" class="grid gap-4 md:grid-cols-4">
        <div class="integrity-kv">
          <span>状态</span>
          <el-tag :type="statusType(report.status)">{{ statusLabel(report.status) }}</el-tag>
        </div>
        <div class="integrity-kv">
          <span>检查项</span>
          <strong>{{ report.checkCount }}</strong>
        </div>
        <div class="integrity-kv">
          <span>问题项</span>
          <strong>{{ report.issueCount }}</strong>
        </div>
        <div class="integrity-kv">
          <span>差异</span>
          <strong>{{ preview?.diffs.length ?? 0 }}</strong>
        </div>
      </div>
    </WorkbenchPanel>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <WorkbenchPanel title="检查项" title-id="integrity-checks-title">
        <el-table v-loading="loading" :data="report?.checks ?? []" row-key="code">
          <el-table-column label="检查" min-width="220">
            <template #default="{ row }: { row: IntegrityCheckResponse }">
              <div class="font-semibold text-[var(--fsusblog-text-primary)]">{{ row.title }}</div>
              <div class="text-[11px] text-[var(--fsusblog-text-muted)]">{{ row.code }}</div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }: { row: IntegrityCheckResponse }">
              <el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="数量" width="90" prop="count" />
          <el-table-column label="样本" min-width="260">
            <template #default="{ row }: { row: IntegrityCheckResponse }">
              <div class="break-all text-xs leading-6 text-[var(--fsusblog-text-secondary)]">
                {{ row.sampleKeys.slice(0, 3).join(', ') || row.detail }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="修复" width="90">
            <template #default="{ row }: { row: IntegrityCheckResponse }">
              <el-tag :type="row.autoFixAvailable ? 'warning' : 'info'">
                {{ row.autoFixAvailable ? '可安全修复' : '-' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </WorkbenchPanel>

      <div class="space-y-8">
        <WorkbenchPanel title="安全修复差异" title-id="integrity-diff-title">
          <div class="max-h-[24rem] overflow-auto">
            <el-table :data="preview?.diffs ?? []" row-key="field">
              <el-table-column label="字段" min-width="180" prop="field" />
              <el-table-column label="修复前" width="110" prop="before" />
              <el-table-column label="修复后" width="110" prop="after" />
            </el-table>
          </div>
          <div class="mt-5 space-y-3 border-t border-[var(--fsusblog-panel-border)] pt-5">
            <el-input v-model="confirmPhrase" placeholder="APPLY_SAFE_FIXES" aria-label="确认短语" />
            <el-input v-model="mfaProof" placeholder="MFA proof" aria-label="MFA proof" show-password />
            <el-button
              type="danger"
              :icon="Tools"
              :disabled="!preview?.diffs.length"
              :loading="fixing"
              @click="applyFix"
            >
              应用安全修复
            </el-button>
          </div>
        </WorkbenchPanel>

        <WorkbenchPanel title="危险操作策略" title-id="integrity-policy-title">
          <div class="space-y-4">
            <div
              v-for="rule in policy?.rules ?? []"
              :key="rule.level"
              class="border-t border-[var(--fsusblog-panel-border)] pt-4"
            >
              <div class="flex items-center justify-between gap-3">
                <span class="text-xs font-semibold">{{ formatDangerLevel(rule.level) }}</span>
                <el-tag type="info">{{ formatDangerInteraction(rule.interaction) }}</el-tag>
              </div>
              <div class="mt-2 text-[11px] leading-5 text-[var(--fsusblog-text-muted)]">
                {{ rule.examples.join(' / ') }}
              </div>
            </div>
          </div>
        </WorkbenchPanel>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue'
import {
  applyIntegrityFix,
  getDangerousOperationPolicy,
  inspectIntegrity,
  previewIntegrityFix,
  type DangerousOperationPolicyResponse,
  type IntegrityCheckResponse,
  type IntegrityFixPreviewResponse,
  type IntegrityReportResponse
} from '@/api/authoring'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import AdminTaskFeedbackBar from '@/components/admin/AdminTaskFeedbackBar.vue'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { Download, Refresh, Tools } from '@/fsusui/icons'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback'

const loading = ref(false)
const fixing = ref(false)
const report = shallowRef<IntegrityReportResponse | null>(null)
const preview = shallowRef<IntegrityFixPreviewResponse | null>(null)
const policy = shallowRef<DangerousOperationPolicyResponse | null>(null)
const confirmPhrase = ref('')
const mfaProof = ref('')
const taskFeedback = useAdminTaskFeedback()
const {
  phase: taskFeedbackPhase,
  message: taskFeedbackMessage,
  detail: taskFeedbackDetail,
  assertiveMessage: taskFeedbackAssertiveMessage,
  busy: taskFeedbackBusy,
  ariaMessage: taskFeedbackAriaMessage,
  isHighlighted: isTaskHighlighted
} = taskFeedback

const loadAll = async (): Promise<void> => {
  loading.value = true
  taskFeedback.begin('正在执行数据巡检', '检查文章、评论、session、上传文件、搜索与 sitemap', 'integrity-report')
  try {
    const [nextReport, nextPreview, nextPolicy] = await Promise.all([
      inspectIntegrity(),
      previewIntegrityFix(),
      getDangerousOperationPolicy()
    ])
    report.value = nextReport
    preview.value = nextPreview
    policy.value = nextPolicy
    const detail = `检查项 ${nextReport.checkCount}，问题项 ${nextReport.issueCount}`
    if (nextReport.issueCount > 0) {
      taskFeedback.partial('数据巡检完成', detail, 'integrity-report')
    } else {
      taskFeedback.succeed('数据巡检完成', detail, 'integrity-report')
    }
  } catch (error) {
    taskFeedback.fail('数据巡检加载失败', error, '数据巡检加载失败', 'integrity-report')
    showErrorToast(error, '数据巡检加载失败')
  } finally {
    loading.value = false
  }
}

const exportReport = (): void => {
  if (!report.value) return
  const blob = new Blob([JSON.stringify(report.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `fsusblog-integrity-${Date.now()}.json`
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

const applyFix = async (): Promise<void> => {
  if (confirmPhrase.value.trim() !== 'APPLY_SAFE_FIXES') {
    showWarningToast('确认短语不匹配', '确认短语不匹配')
    return
  }

  fixing.value = true
  taskFeedback.begin('正在应用安全修复', '执行 APPLY_SAFE_FIXES', 'integrity-report')
  try {
    const response = await applyIntegrityFix(
      { codes: null, confirmPhrase: confirmPhrase.value.trim() },
      { mfaProofToken: mfaProof.value.trim() || null }
    )
    taskFeedback.succeed('安全修复完成', `已应用 ${response.appliedCount} 项`, 'integrity-report')
    toast.success(`安全修复完成：${response.appliedCount}`)
    await loadAll()
  } catch (error) {
    taskFeedback.fail('安全修复失败', error, '安全修复失败', 'integrity-report')
    showErrorToast(error, '安全修复失败')
  } finally {
    fixing.value = false
  }
}

const statusType = (status: string): 'success' | 'warning' | 'danger' | 'info' => {
  if (status === 'ok' || status === 'empty' || status === 'applied') return 'success'
  if (status === 'issue' || status === 'issues' || status === 'ready') return 'warning'
  if (status === 'failed') return 'danger'
  return 'info'
}

const statusLabel = (status: string | null | undefined): string => {
  const labels: Record<string, string> = {
    ok: '正常',
    empty: '无数据',
    applied: '已应用',
    issue: '有问题',
    issues: '有问题',
    ready: '待确认',
    failed: '失败'
  }
  return status ? labels[status] ?? status : '-'
}

const formatDangerLevel = (level: string): string => {
  const labels: Record<string, string> = {
    'normal-confirm': '普通确认',
    'strong-confirm': '二次确认',
    'typed-confirm': '输入对象名',
    'mfa-step-up': 'MFA 加强验证',
    'diff-preview': '差异预览'
  }
  return labels[level] ?? level
}

const formatDangerInteraction = (interaction: string): string => {
  const labels: Record<string, string> = {
    confirm: '确认操作',
    '二次确认': '二次确认',
    '输入对象名': '输入对象名',
    'MFA proof': 'MFA Proof 验证',
    '展示 changed fields': '展示变更字段'
  }
  return labels[interaction] ?? interaction
}

onMounted(loadAll)
</script>

<style scoped>
.integrity-kv {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border-top: 1px solid var(--fsusblog-panel-border);
  padding: 0.875rem 0;
  font-size: 0.75rem;
}

.integrity-kv span {
  color: var(--fsusblog-text-muted);
}
</style>
