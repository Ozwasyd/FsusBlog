<template>
  <div class="space-y-8">
    <FsusUiSettingsSection
      title="RiskControl 模拟器"
      :description="result ? `策略版本：${result.policyVersion}` : ''"
      id="security-simulator-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" type="primary" @click="runSimulation">运行</el-button>
      </template>

      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.45fr)]">
        <el-form label-position="top" class="grid gap-4 md:grid-cols-2">
          <el-form-item label="动作">
            <el-select v-model="form.action" class="w-full" filterable>
              <el-option v-for="item in actionOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="routeKey">
            <el-input v-model="form.routeKey" />
          </el-form-item>
          <el-form-item label="subject">
            <el-input v-model="form.subject" />
          </el-form-item>
          <el-form-item label="riskScore">
            <el-input-number v-model="form.riskScore" class="w-full" :min="0" :max="500" :step="5" controls-position="right" />
          </el-form-item>
          <el-form-item label="clientIp">
            <el-input v-model="form.clientIp" />
          </el-form-item>
          <el-form-item label="region">
            <el-input v-model="form.region" />
          </el-form-item>
          <el-form-item label="actorStatus">
            <el-select v-model="form.actorStatus" class="w-full">
              <el-option label="anonymous" value="anonymous" />
              <el-option label="authenticated" value="authenticated" />
              <el-option label="admin_principal" value="admin_principal" />
            </el-select>
          </el-form-item>
          <el-form-item label="identityKind">
            <el-input v-model="form.identityKind" />
          </el-form-item>
          <el-form-item label="deviceFingerprint">
            <el-input v-model="form.deviceFingerprint" />
          </el-form-item>
          <el-form-item label="userAgent">
            <el-input v-model="form.userAgent" />
          </el-form-item>
        </el-form>

        <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
          <button
            v-for="preset in presets"
            :key="preset.label"
            type="button"
            class="flex w-full items-center justify-between border-b border-[var(--fsusblog-panel-border)] px-5 py-4 text-left transition hover:bg-[var(--fsusblog-page-bg-soft)]"
            @click="applyPreset(preset)"
          >
            <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ preset.label }}</span>
            <span class="text-[12px] font-semibold text-[var(--fsusblog-text-muted)] tabular-nums">{{ preset.riskScore }}</span>
          </button>
        </div>
      </div>
    </FsusUiSettingsSection>

    <section class="grid gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">decision</div>
          <div class="mt-2 text-2xl font-bold text-[var(--fsusblog-text-primary)]">{{ result?.decision ?? '-' }}</div>
        </div>
        <div class="grid grid-cols-2 gap-px bg-[var(--fsusblog-panel-border)]">
          <div v-for="metric in resultMetrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
            <div class="mt-2 break-words text-lg font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ metric.value }}</div>
          </div>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">reasons</div>
        </div>
        <div class="grid gap-px bg-[var(--fsusblog-panel-border)]">
          <div class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">requiredChallenges</div>
            <div class="mt-3 flex flex-wrap gap-2">
              <el-tag v-for="item in result?.requiredChallenges ?? []" :key="item" type="warning">{{ item }}</el-tag>
              <span v-if="(result?.requiredChallenges ?? []).length === 0" class="text-[12px] text-[var(--fsusblog-text-muted)]">无需挑战</span>
            </div>
          </div>
          <div class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="flex flex-wrap gap-2">
              <el-tag v-for="item in result?.reasons ?? []" :key="item">{{ item }}</el-tag>
              <span v-if="(result?.reasons ?? []).length === 0" class="text-[12px] text-[var(--fsusblog-text-muted)]">尚未返回原因</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, shallowRef } from 'vue'
import { simulateRiskControl, type RiskControlSimulationRequest, type RiskControlSimulationResponse } from '@/api/security'
import { FsusUiSettingsSection } from '@/fsusui'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

type Preset = {
  label: string
  riskScore: number
}

const loading = shallowRef(false)
const result = shallowRef<RiskControlSimulationResponse | null>(null)

const form = reactive<Required<Omit<RiskControlSimulationRequest, 'verifiedCrawler' | 'socialPreviewBot'>>>({
  action: 'comment.create',
  routeKey: 'comment.create',
  subject: 'ip:203.0.113.10',
  riskScore: 50,
  clientIp: '203.0.113.10',
  userAgent: 'Mozilla/5.0',
  deviceFingerprint: 'device-123456',
  region: 'CN',
  actorStatus: 'anonymous',
  identityKind: 'anonymous'
})

const actionOptions = [
  { label: 'comment.create', value: 'comment.create' },
  { label: 'comment.reply', value: 'comment.reply' },
  { label: 'auth.login', value: 'auth.login' },
  { label: 'auth.passkey.begin', value: 'auth.passkey.begin' },
  { label: 'notification.subscribe', value: 'notification.subscribe' },
  { label: 'admin.security.write', value: 'admin.security.write' },
  { label: 'admin.comment.batch', value: 'admin.comment.batch' }
] as const

const presets: Preset[] = [
  { label: 'allow', riskScore: 10 },
  { label: 'challenge', riskScore: 50 },
  { label: 'queue', riskScore: 90 },
  { label: 'block', riskScore: 125 }
]

const resultMetrics = computed(() => [
  { label: 'riskScore', value: result.value?.riskScore ?? '-' },
  { label: 'effectiveRiskScore', value: result.value?.effectiveRiskScore ?? '-' },
  { label: 'escalationLevel', value: result.value?.escalationLevel ?? '-' },
  { label: 'policyVersion', value: result.value?.policyVersion ?? '-' },
  { label: 'action', value: result.value?.action ?? '-' },
  { label: 'routeKey', value: result.value?.routeKey ?? '-' },
  { label: 'subject', value: result.value?.subject ?? '-' },
  { label: 'actorStatus', value: result.value?.actorStatus ?? '-' }
])

const applyPreset = (preset: Preset): void => {
  form.riskScore = preset.riskScore
}

const runSimulation = async (): Promise<void> => {
  loading.value = true
  try {
    result.value = await simulateRiskControl({
      ...form,
      verifiedCrawler: false,
      socialPreviewBot: false
    })
  } catch (error) {
    showErrorToast(error, 'RiskControl 模拟失败')
  } finally {
    loading.value = false
  }
}
</script>
