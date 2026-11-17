<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElEmptyState, ElSkeleton, ElStatistic, ElTable, ElTableColumn } from '@ozwasyd/element-plus'
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
  <section class="admin-traffic" aria-labelledby="admin-traffic-heading" :aria-busy="busy">
    <header>
      <div><h2 id="admin-traffic-heading">{{ t('admin.traffic.title') }}</h2><p>{{ t('admin.traffic.period') }}</p></div>
      <ElButton native-type="button" :loading="busy" @click="load">{{ t('admin.traffic.refresh') }}</ElButton>
    </header>
    <div v-if="busy" role="status"><p>{{ t('admin.traffic.loading') }}</p><ElSkeleton :rows="4" /></div>
    <ElAlert v-else-if="error" :title="t(error)" type="error" :closable="false" />
    <ElEmptyState v-else-if="observation && !observation.enabled" :title="t('admin.traffic.disabled')" role="status" />
    <template v-else-if="observation">
      <ElStatistic class="traffic-total" :title="t('admin.traffic.total')" :value="total" :formatter="number" />
      <div class="traffic-grid">
        <section aria-labelledby="traffic-trend-heading">
          <h3 id="traffic-trend-heading">{{ t('admin.traffic.trend') }}</h3>
          <ElEmptyState v-if="total === 0" :title="t('admin.traffic.empty')" role="status" />
          <template v-else>
            <svg viewBox="0 0 300 100" role="img" :aria-label="t('admin.traffic.chart')">
              <line x1="0" y1="90" x2="300" y2="90" class="traffic-axis" />
              <polyline :points="points" />
            </svg>
            <p class="traffic-range"><span>{{ observation.days[0]?.date }}</span><span>{{ observation.days.at(-1)?.date }}</span></p>
          </template>
          <details v-if="observation.days.length">
            <summary>{{ t('admin.traffic.dailyData') }}</summary>
            <ElTable :data="days">
              <ElTableColumn prop="date" :label="t('admin.traffic.date')" min-width="120" />
              <ElTableColumn prop="views" :label="t('admin.traffic.views')" min-width="90" align="right">
                <template #default="{ row }">{{ number(row.views) }}</template>
              </ElTableColumn>
            </ElTable>
          </details>
        </section>
        <section aria-labelledby="traffic-regions-heading">
          <h3 id="traffic-regions-heading">{{ t('admin.traffic.regions') }}</h3>
          <ElEmptyState v-if="!observation.regionsConfigured" :title="t('admin.traffic.regionsUnconfigured')" role="status" />
          <ElEmptyState v-else-if="!regions.length" :title="t('admin.traffic.regionsEmpty')" role="status" />
          <ElTable v-else :data="regions">
            <ElTableColumn prop="region" :label="t('admin.traffic.region')" min-width="120">
              <template #default="{ row }">{{ regionName(row.region) }}</template>
            </ElTableColumn>
            <ElTableColumn prop="views" :label="t('admin.traffic.views')" min-width="90" align="right">
              <template #default="{ row }">{{ number(row.views) }}</template>
            </ElTableColumn>
          </ElTable>
        </section>
      </div>
    </template>
  </section>
</template>

<style scoped>
.admin-traffic { min-width: 0; margin-block: 1rem 2rem; }
header { display: flex; align-items: start; justify-content: space-between; flex-wrap: wrap; gap: .75rem; }
header h2, header p { margin-block: 0 .5rem; }
.traffic-total { font-size: 1.25rem; font-weight: 600; }
.traffic-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem; }
.traffic-grid > section { min-width: 0; padding: 1rem; border: 1px solid var(--fsus-border); border-radius: .5rem; }
svg { display: block; width: 100%; max-height: 12rem; overflow: visible; }
polyline { fill: none; stroke: var(--el-color-primary); stroke-width: 2; vector-effect: non-scaling-stroke; }
.traffic-axis { stroke: var(--fsus-border); }
.traffic-range { display: flex; justify-content: space-between; gap: .75rem; }
.traffic-range { font-size: .85rem; }
summary { cursor: pointer; padding-block: .75rem; }
@media (max-width: 42rem) { .traffic-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
