<template>
  <div class="space-y-8">
    <FsusUiSettingsSection title="风险事件" id="security-events-title">
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadEvents">刷新</el-button>
      </template>

      <div class="grid gap-3 md:grid-cols-4">
        <label class="bg-[var(--fsusblog-page-bg)] p-5">
          <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">来源</span>
          <el-input v-model="filters.source" class="mt-2" placeholder="全部" />
        </label>
        <label class="bg-[var(--fsusblog-page-bg)] p-5">
          <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">原因</span>
          <el-input v-model="filters.reason" class="mt-2" placeholder="全部" />
        </label>
        <label class="bg-[var(--fsusblog-page-bg)] p-5">
          <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">条数</span>
          <el-input-number v-model="filters.limit" class="mt-2 w-full" :min="10" :max="200" controls-position="right" />
        </label>
        <div class="bg-[var(--fsusblog-page-bg)] p-4">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">事件总数</div>
          <div class="mt-2 text-base font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ events.length }}</div>
        </div>
      </div>
    </FsusUiSettingsSection>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">eventAggregates</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="row in eventAggregates" :key="`${row.source}:${row.reason}`" class="p-5">
            <div class="flex items-center justify-between gap-4">
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ row.source }}</div>
              <div class="text-sm font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ row.count }}</div>
            </div>
            <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ row.reason }} / +{{ row.scoreDeltaSum }}</div>
          </div>
          <div v-if="eventAggregates.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无聚合事件</div>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">事件明细</div>
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
              <tr v-for="event in events" :key="event.id" class="border-b border-[var(--fsusblog-panel-border)]">
                <td class="px-5 py-3">{{ formatTime(event.occurredAtUtc) }}</td>
                <td class="px-5 py-3">{{ event.source }}</td>
                <td class="px-5 py-3">{{ event.reason }}</td>
                <td class="px-5 py-3">{{ event.action }}</td>
                <td class="px-5 py-3 tabular-nums">{{ event.scoreDelta }} / {{ event.totalScore }}</td>
                <td class="px-5 py-3 break-all">{{ event.path }}</td>
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
