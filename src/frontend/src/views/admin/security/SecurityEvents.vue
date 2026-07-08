<template>
  <div class="space-y-8">
    <FsusUiSettingsSection title="风险事件" id="security-events-title">
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadEvents">刷新</el-button>
      </template>

      <div class="security-events-filters">
        <label class="security-events-filter">
          <span>来源</span>
          <el-input v-model="filters.source" placeholder="全部" />
        </label>
        <label class="security-events-filter">
          <span>原因</span>
          <el-input v-model="filters.reason" placeholder="全部" />
        </label>
        <label class="security-events-filter security-events-filter--limit">
          <span>条数</span>
          <el-input-number v-model="filters.limit" :min="10" :max="200" controls-position="right" />
        </label>
      </div>
    </FsusUiSettingsSection>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">事件聚合</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="row in eventAggregates" :key="`${row.source}:${row.reason}`" class="p-5">
            <div class="flex items-center justify-between gap-4">
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ formatRiskSource(row.source) }}</div>
              <div class="text-sm font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ row.count }} 次</div>
            </div>
            <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ formatRiskReason(row.reason) }} / +{{ row.scoreDeltaSum }}</div>
          </div>
          <div v-if="eventAggregates.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无聚合事件</div>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="security-events-section-heading">
            <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">事件明细</div>
            <div class="security-events-results-count">共 {{ events.length }} 条</div>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-full md:min-w-[58rem] text-left text-[12px]">
            <thead class="text-[11px] uppercase text-[var(--fsusblog-text-muted)]">
              <tr class="border-b border-[var(--fsusblog-panel-border)]">
                <th class="px-5 py-3">时间</th>
                <th class="px-5 py-3">来源</th>
                <th class="px-5 py-3">原因</th>
                <th class="px-5 py-3">动作</th>
                <th class="px-5 py-3">分数</th>
                <th class="px-5 py-3">路径</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="event in eventRows" :key="event.id" class="border-b border-[var(--fsusblog-panel-border)]">
                <td class="px-5 py-3">{{ event.formattedOccurredAt }}</td>
                <td class="px-5 py-3">{{ formatRiskSource(event.source) }}</td>
                <td class="px-5 py-3">{{ formatRiskReason(event.reason) }}</td>
                <td class="px-5 py-3">{{ formatRiskAction(event.action) }}</td>
                <td class="px-5 py-3 tabular-nums">{{ event.scoreDelta }} / {{ event.totalScore }}</td>
                <td class="px-5 py-3 break-all">{{ formatRiskRoute(event.path) }}</td>
              </tr>
              <tr v-if="events.length === 0">
                <td colspan="6" class="px-5 py-10 text-center text-[var(--fsusblog-text-muted)]">暂无风险事件</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from 'vue'
import { listSecurityRiskEvents, type AntiCrawlerRiskEventResponse } from '@/api/security'
import { FsusUiSettingsSection } from '@/fsusui'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const events = shallowRef<AntiCrawlerRiskEventResponse[]>([])
const filters = reactive({
  source: '',
  reason: '',
  limit: 100
})

const riskSourceLabels: Record<string, string> = {
  'anti-crawler': '反爬虫',
  auth: '认证',
  captcha: 'Captcha',
  'comment-governance': '评论治理',
  'device-fingerprint': '设备指纹',
  'human-read-proof': '阅读证明',
  passkey: 'Passkey',
  perception: 'Perception',
  'perception-localization': '点选定位',
  'perception-micro-interaction': '微交互',
  'perception-text-task': '文字识别',
  pospace: 'PoSpace',
  pow: '工作量证明',
  'public-read': '公开读取',
  'rate-limiter': '限流',
  'region-policy': '区域策略',
  'risk-control': '风险控制',
  'admin-step-up': '管理员二次验证'
}

const riskReasonLabels: Record<string, string> = {
  AdminStepUpFailed: '管理员二次验证失败',
  AdminStepUpRequired: '需要管理员二次验证',
  AnonymousNullifierAbuse: '匿名凭据滥用',
  AuthFailureBurst: '登录失败过多',
  AuthLoginFailed: '登录失败',
  BlockedUserAgent: 'User-Agent 被拦截',
  CaptchaChallengeRequired: '需要 Captcha 验证',
  CaptchaInvalid: 'Captcha 无效',
  CaptchaReplay: 'Captcha 重放',
  CaptchaSolveTooFast: 'Captcha 完成过快',
  ChallengeExpired: '验证任务过期',
  ChallengeKindMismatch: '验证任务类型不匹配',
  ChallengeSignatureInvalid: '验证任务签名无效',
  CommentNullifierAbuse: '评论匿名凭据滥用',
  CommentRegionCompliance: '评论区域合规命中',
  CommentSpamPattern: '评论垃圾模式',
  CommentSpamPatternHit: '评论垃圾模式命中',
  DeviceFingerprintChanged: '设备指纹变化',
  DeviceFingerprintMissing: '缺少设备指纹',
  FakeCrawler: '伪装爬虫',
  PasskeyAssertionAccepted: 'Passkey 验证通过',
  PasskeyAssertionFailed: 'Passkey 验证失败',
  PasskeyAssertionFailure: 'Passkey 验证失败',
  PowInvalid: '工作量证明无效',
  PowReplay: '工作量证明重放',
  PublicReadBlocked: '公开读取被拦截',
  PublicReadChallengeRequired: '公开读取需要验证',
  RateLimited: '触发限流',
  ReadProofAccepted: '阅读证明通过',
  ReadProofRejected: '阅读证明拒绝',
  RegionPolicyHit: '区域策略命中',
  SecurityChallengeRejected: '验证任务被拒绝',
  UnknownBot: '未知自动化访问',
  UserAgentMissing: '缺少 User-Agent',
  VerifiedCrawler: '已验证爬虫'
}

const riskActionLabels: Record<string, string> = {
  'admin.comment.batch': '后台批量评论处理',
  'admin.security.write': '后台安全策略写入',
  'auth.login': '登录',
  'auth.passkey.begin': '开始 Passkey 验证',
  'auth.passkey.complete': '完成 Passkey 验证',
  'comment.create': '发表评论',
  'comment.reply': '回复评论',
  'notification.subscribe': '订阅通知流',
  'public.read': '公开读取',
  'rate_limited': '触发限流',
  'recovery-key.verify': '恢复密钥验证',
  'risk_control': '风险控制',
  'risk_control_blocked': '风险控制拦截',
  'risk_control_queue': '风险控制排队',
  'risk_control_rejected': '风险控制拒绝',
  'risk_control_throttled': '风险控制延迟',
  'shield_observed': 'Shield 观察',
  'shield_rejected': 'Shield 拦截',
  accepted: '已放行',
  allow: '放行',
  blocked: '已拦截',
  challenge: '要求验证',
  denied: '拒绝',
  rejected: '拒绝',
  required: '要求验证',
  received: '已接收'
}

const formatRiskSource = (value: string | null | undefined): string => formatRiskText(value, riskSourceLabels)

const formatRiskReason = (value: string | null | undefined): string => formatRiskText(value, riskReasonLabels)

const formatRiskAction = (value: string | null | undefined): string => formatRiskText(value, riskActionLabels)

const formatRiskRoute = (value: string | null | undefined): string => formatRiskText(value, riskActionLabels)

const formatRiskText = (value: string | null | undefined, labels: Record<string, string>): string => {
  if (!value) {
    return '-'
  }
  return labels[value] ?? value
}

const eventAggregates = computed(() => {
  const map = new Map<string, { source: string; reason: string; count: number; scoreDeltaSum: number }>()
  for (const event of events.value) {
    const key = `${event.source}\u0000${event.reason}`
    const current = map.get(key) ?? {
      source: event.source,
      reason: event.reason,
      count: 0,
      scoreDeltaSum: 0
    }
    current.count += 1
    current.scoreDeltaSum += event.scoreDelta
    map.set(key, current)
  }
  return Array.from(map.values()).sort((left, right) => right.count - left.count)
})

const eventRows = computed(() =>
  events.value.map((event) => ({
    ...event,
    formattedOccurredAt: formatTime(event.occurredAtUtc)
  }))
)

const formatTime = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString() : '-'

const loadEvents = async (): Promise<void> => {
  loading.value = true
  try {
    events.value = await listSecurityRiskEvents({
      source: filters.source,
      reason: filters.reason,
      limit: filters.limit
    })
  } catch (error) {
    showErrorToast(error, '风险事件加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadEvents()
})
</script>

<style scoped>
.security-events-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1rem;
  align-items: end;
}

.security-events-filter {
  display: grid;
  min-width: 0;
  gap: 0.5rem;
}

.security-events-filter span {
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.3;
}

:deep(.security-events-filter .el-input-number) {
  width: min(100%, 12rem);
}

.security-events-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-width: 0;
}

.security-events-results-count {
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.3;
  white-space: nowrap;
}

@media (min-width: 640px) {
  .security-events-filters {
    grid-template-columns: minmax(9rem, 1fr) minmax(9rem, 1fr) minmax(7.5rem, 10rem);
  }
}
</style>
