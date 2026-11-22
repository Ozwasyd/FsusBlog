<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import {
  ElAlert, ElButton, ElDistributionBarRow, ElDistributionList, ElEmptyState,
  ElKpiGroup, ElSettingsSection, ElSkeleton, ElStatistic, ElTable, ElTableColumn,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import type { AdminSession } from '../../../Contracts/admin-identity'
import { readAdminSiteTraffic } from '../../../Contracts/admin-site-traffic'
import { siteLocale, t, type MessageKey } from '../siteLocale'
import { watchAdminSessionClear } from './adminSessionClear'

const props = defineProps<{ session: AdminSession; sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: ApiError] }>()
const observation = shallowRef<Awaited<ReturnType<typeof readAdminSiteTraffic>>>()
const busy = ref(false)
const error = ref<MessageKey | ''>('')
let request: AbortController | undefined
const total = computed(() => observation.value?.days.reduce((sum, day) => sum + day.views, 0) ?? 0)
const peak = computed(() => Math.max(1, ...observation.value?.days.map(day => day.views) ?? []))
const points = computed(() => observation.value?.days.map((day, index, days) =>
  `${days.length === 1 ? 150 : index * 300 / (days.length - 1)},${90 - day.views / peak.value * 80}`).join(' ') ?? '')
const days = computed(() => [...observation.value?.days ?? []])
const regions = computed(() => [...observation.value?.regions ?? []].sort((a, b) => b.views - a.views))
const regionPeak = computed(() => Math.max(1, ...regions.value.map(region => region.views)))
const regionNames = computed(() => new Intl.DisplayNames([siteLocale.value], { type: 'region' }))
const subdivisions: Readonly<Record<string, MessageKey>> = {
  'CN-BJ': 'admin.traffic.region.beijing', 'CN-SH': 'admin.traffic.region.shanghai',
  'CN-GD': 'admin.traffic.region.guangdong', 'CN-ZJ': 'admin.traffic.region.zhejiang',
  'CN-JS': 'admin.traffic.region.jiangsu', 'CN-SC': 'admin.traffic.region.sichuan',
  'CN-HK': 'admin.traffic.region.hongKong', 'CN-MO': 'admin.traffic.region.macao',
}
function regionName(code: string) {
  if (code.toLowerCase() === 'unknown') return t('admin.traffic.unknown')
  const subdivision = subdivisions[code.toUpperCase()]
  if (subdivision) return t(subdivision)
  try { return regionNames.value.of(code.toUpperCase()) ?? code } catch { return code }
}
const number = (value: number) => new Intl.NumberFormat(siteLocale.value).format(value)

function clear() {
  request?.abort()
  request = undefined
  observation.value = undefined
  busy.value = false
  error.value = ''
}
async function load() {
  if (busy.value || props.sessionSignal.aborted) return
  clear()
  const current = request = new AbortController()
  const signal = AbortSignal.any([current.signal, props.sessionSignal])
  busy.value = true
  try {
    const result = await readAdminSiteTraffic(props.session, signal)
    if (!signal.aborted) observation.value = result
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else error.value = 'admin.traffic.failed'
  } finally {
    if (request === current) { request = undefined; busy.value = false }
  }
}
watchAdminSessionClear(() => [props.session, props.sessionSignal] as const, clear)
onMounted(() => { void load() })
</script>

<template>
  <ElSettingsSection class="admin-traffic" ariaLabelledby="admin-traffic-heading" v-bind="{ 'aria-busy': busy }" density="compact">
    <template #title>
      <span id="admin-traffic-heading">{{ t('admin.traffic.title') }}</span>
    </template>
    <template #description>{{ t('admin.traffic.period') }}</template>
    <template #actions>
      <ElButton native-type="button" :loading="busy" @click="load">{{ t('admin.traffic.refresh') }}</ElButton>
    </template>

    <div v-if="busy" class="traffic-loading" role="status">
      <p>{{ t('admin.traffic.loading') }}</p>
      <ElSkeleton :rows="4" />
    </div>
    <ElAlert v-else-if="error" :title="t(error)" type="error" :closable="false" />
    <ElEmptyState v-else-if="observation && !observation.enabled" size="inline" :title="t('admin.traffic.disabled')" :description="t('admin.traffic.disabledHint')" role="status" />
    <template v-else-if="observation">
      <ElKpiGroup density="compact">
        <ElStatistic class="traffic-total" :title="t('admin.traffic.total')" :value="total" :formatter="number" />
      </ElKpiGroup>
      <div class="traffic-grid">
        <section class="traffic-card" aria-labelledby="traffic-trend-heading">
          <h3 id="traffic-trend-heading">{{ t('admin.traffic.trend') }}</h3>
          <ElEmptyState v-if="total === 0" size="inline" :title="t('admin.traffic.empty')" role="status" />
          <template v-else>
            <svg class="traffic-chart" viewBox="0 0 300 100" role="img" :aria-label="t('admin.traffic.chart')">
              <line x1="0" y1="90" x2="300" y2="90" class="traffic-axis" />
              <polyline :points="points" class="traffic-line" />
            </svg>
            <p class="traffic-range"><span>{{ observation.days[0]?.date }}</span><span>{{ observation.days.at(-1)?.date }}</span></p>
          </template>
          <details v-if="observation.days.length" class="traffic-details">
            <summary>{{ t('admin.traffic.dailyData') }}</summary>
            <ElTable :data="days" border stripe>
              <ElTableColumn prop="date" :label="t('admin.traffic.date')" min-width="120" />
              <ElTableColumn prop="views" :label="t('admin.traffic.views')" min-width="90" align="right">
                <template #default="{ row }">{{ number(row.views) }}</template>
              </ElTableColumn>
            </ElTable>
          </details>
        </section>
        <section class="traffic-card" aria-labelledby="traffic-regions-heading">
          <h3 id="traffic-regions-heading">{{ t('admin.traffic.regions') }}</h3>
          <ElEmptyState v-if="!observation.regionsConfigured" size="inline" :title="t('admin.traffic.regionsUnconfigured')" role="status" />
          <ElEmptyState v-else-if="!regions.length" size="inline" :title="t('admin.traffic.regionsEmpty')" role="status" />
          <ElDistributionList v-else density="compact">
            <ElDistributionBarRow
              v-for="row in regions"
              :key="row.region"
              :label="regionName(row.region)"
              :value="number(row.views)"
              :ratio="row.views / regionPeak"
            />
          </ElDistributionList>
        </section>
      </div>
    </template>
  </ElSettingsSection>
</template>

<style scoped>
.traffic-loading {
  display: grid;
  gap: 8px;
}

.traffic-loading p {
  margin: 0;
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

.traffic-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.traffic-card {
  display: grid;
  align-content: start;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 12px);
  background: var(--el-bg-color);
}

.traffic-card h3 {
  margin: 0;
  font-size: var(--el-font-size-base);
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.traffic-chart {
  width: 100%;
  height: auto;
  overflow: visible;
}

.traffic-axis {
  stroke: var(--el-border-color);
  stroke-width: 1;
}

.traffic-line {
  fill: none;
  stroke: var(--el-color-primary);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.traffic-range {
  display: flex;
  justify-content: space-between;
  margin: 0;
  font-size: var(--el-font-size-extra-small);
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}

.traffic-details {
  display: grid;
  gap: 10px;
}

.traffic-details summary {
  cursor: pointer;
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
}
</style>
