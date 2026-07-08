<template>
  <div class="space-y-8">
    <FsusUiSettingsSection
      title="Captcha 验证"
      :description="metricsState ? `验证类型：${captchaDisplayName}` : ''"
      id="security-captcha-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadMetrics">刷新</el-button>
      </template>

      <AdminStatusMatrix :items="metrics" density="compact" aria-label="Captcha 指标" />
    </FsusUiSettingsSection>

    <section class="grid gap-8 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">运行状态</div>
        </div>
        <AdminStatusMatrix :items="statusRows" density="compact" aria-label="Captcha 运行状态" />
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">最近尝试</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="attempt in attempts" :key="attempt.attemptId" class="grid gap-3 p-5 md:grid-cols-[1fr_auto]">
            <div class="min-w-0">
              <div class="break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ attempt.challengeId }}</div>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ formatAttemptContext(attempt.action, attempt.routeKey) }}</div>
            </div>
            <el-tag :type="attempt.outcome === 'verified' ? 'success' : 'warning'">{{ formatOutcome(attempt.outcome) }}</el-tag>
          </div>
          <div v-if="attempts.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无 Captcha 尝试记录</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import { getSecurityChallengeMetrics, type SecurityChallengeMetricsResponse } from '@/api/security'
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue'
import { FsusUiSettingsSection } from '@/fsusui'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const captchaV1 = 'captchaV1'
const captchaDisplayName = '图形验证码'
const loading = shallowRef(false)
const metricsState = shallowRef<SecurityChallengeMetricsResponse | null>(null)

const attempts = computed(() => metricsState.value?.recentAttempts ?? [])

const formatPercent = (value: number | null | undefined): string =>
  `${Math.round((value ?? 0) * 1000) / 10}%`

const formatOutcome = (value: string | null | undefined): string => {
  const labels: Record<string, string> = {
    verified: '已通过',
    failed: '未通过',
    replayed: '重放拦截',
    expired: '已过期'
  }
  return value ? labels[value] ?? `结果代码：${value}` : '结果未知'
}

const formatAttemptContext = (action: string | null | undefined, routeKey: string | null | undefined): string => {
  const actionText = formatAction(action)
  const routeText = formatRoute(routeKey)
  return actionText === routeText ? actionText : `${actionText} / ${routeText}`
}

const formatAction = (value: string | null | undefined): string => {
  const labels: Record<string, string> = {
    'admin.comment.batch': '后台批量评论处理',
    'admin.security.write': '后台安全策略写入',
    'auth.login': '登录',
    'auth.passkey.begin': '开始 Passkey 验证',
    'auth.passkey.complete': '完成 Passkey 验证',
    'comment.create': '发表评论',
    'comment.reply': '回复评论',
    'notification.subscribe': '订阅通知流',
    'public.read': '公开读取',
    'recovery-key.verify': '恢复密钥验证'
  }
  return value ? labels[value] ?? value : '未知动作'
}

const formatRoute = (value: string | null | undefined): string => {
  const labels: Record<string, string> = {
    'admin.comment.batch': '后台批量评论处理',
    'admin.security.write': '后台安全策略写入',
    'auth.login': '登录',
    'auth.passkey.begin': '开始 Passkey 验证',
    'auth.passkey.complete': '完成 Passkey 验证',
    'comment.create': '发表评论',
    'comment.reply': '回复评论',
    'notification.subscribe': '订阅通知流',
    'public.read': '公开读取',
    'recovery-key.verify': '恢复密钥验证'
  }
  return value ? labels[value] ?? value : '未知路径'
}

const metrics = computed<AdminStatusMatrixItem[]>(() => [
  { label: '发起', value: metricsState.value?.totalIssued ?? '-' },
  { label: '提交', value: metricsState.value?.totalAttempts ?? '-' },
  { label: '成功率', value: formatPercent(metricsState.value?.successRate) },
  { label: '失败率', value: formatPercent(metricsState.value?.failureRate) }
])

const statusRows = computed<AdminStatusMatrixItem[]>(() => [
  { label: '验证类型', value: captchaDisplayName },
  { label: '通过次数', value: String(metricsState.value?.verified ?? 0) },
  { label: '失败次数', value: String(metricsState.value?.failed ?? 0) },
  { label: '重放拦截', value: String(metricsState.value?.replayed ?? 0) }
])

const loadMetrics = async (): Promise<void> => {
  loading.value = true
  try {
    metricsState.value = await getSecurityChallengeMetrics({ kind: captchaV1 })
  } catch (error) {
    showErrorToast(error, 'Captcha 验证加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadMetrics()
})
</script>
