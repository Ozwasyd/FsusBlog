import assert from 'node:assert/strict'
import test from 'node:test'

import { auditAdminSegmentedControlRemoval } from './check-admin-segmented-control-removal.mjs'

const listPath = 'src/frontend/src/views/admin/article/List.vue'
const composablePath = 'src/frontend/src/composables/useAdminArticleList.ts'
const adapterPath = 'src/frontend/src/fsusui/segmentedControl.ts'

const canonicalSources = () => ({
  [listPath]: `
<template>
  <FsusUiSegmentedControl
    :model-value="selectedStatusFilter"
    :items="segmentedStatusFilters"
    aria-label="文章状态筛选"
    @update:model-value="handleStatusFilterChange"
  />
</template>
<script setup lang="ts">
import { computed } from 'vue'
import {
  FsusUiSegmentedControl,
  type FsusUiSegmentedControlItem,
  type FsusUiSegmentedControlValue
} from '@/fsusui/segmentedControl'
const segmentedStatusFilters = computed<readonly FsusUiSegmentedControlItem[]>(() =>
  statusFilters.map((item) => ({ ...item, value: item.value ?? 'all', disabled: isBusy.value }))
)
const handleStatusFilterChange = (value: FsusUiSegmentedControlValue): void => {
  setStatusFilter(typeof value === 'number' ? value : undefined)
}
</script>`,
  [composablePath]: `
const STATUS_FILTERS = [
  { label: '全部', value: undefined },
  { label: '草稿', value: ArticlePublishStatus.Draft },
  { label: '定时', value: ArticlePublishStatus.Scheduled },
  { label: '已发布', value: ArticlePublishStatus.Published },
  { label: '归档', value: ArticlePublishStatus.Archived }
]
queryParam.status = parseStatus(route.query.status)
if (queryParam.status !== undefined) query.status = String(queryParam.status)
const setStatusFilter = (status: ArticlePublishStatus | undefined): void => {
  queryParam.status = status
}`,
  [adapterPath]: `
export { ElSegmentedControl as FsusUiSegmentedControl } from '@ozwasyd/element-plus'
export type {
  SegmentedControlItem as FsusUiSegmentedControlItem,
  SegmentedControlValue as FsusUiSegmentedControlValue
} from '@ozwasyd/element-plus'`
})

const expectMutationFailure = (name, mutate, expected) => {
  test(name, () => {
    const sources = canonicalSources()
    mutate(sources)
    assert.deepEqual(auditAdminSegmentedControlRemoval(sources).some((failure) => expected.test(failure)), true)
  })
}

test('canonical direct consumer contract is accepted', () => {
  assert.deepEqual(auditAdminSegmentedControlRemoval(canonicalSources()), [])
})

expectMutationFailure('rejects the retired wrapper returning', (sources) => {
  sources['src/frontend/src/components/admin/AdminSegmentedControl.vue'] = '<template />'
}, /deleted wrapper/u)

expectMutationFailure('rejects a renamed AdminFilterTabs wrapper', (sources) => {
  sources['src/frontend/src/components/admin/AdminFilterTabs.vue'] = `
<template><button :aria-pressed="item.value === modelValue" /></template>
<script setup>defineProps<{ items: unknown[]; modelValue: unknown }>()</script>`
}, /renamed segmented wrapper/u)

expectMutationFailure('rejects native button aria-pressed in the article caller', (sources) => {
  sources[listPath] += '<button :aria-pressed="true">全部</button>'
}, /button\[aria-pressed\]/u)

expectMutationFailure('rejects as any type erasure', (sources) => {
  sources[listPath] = sources[listPath].replace('value: FsusUiSegmentedControlValue', 'value: FsusUiSegmentedControlValue') + '\nconst unsafe = statusFilters as any'
}, /must not widen/u)

expectMutationFailure('rejects private segmented selector overrides', (sources) => {
  sources[listPath] += '<style>.el-segmented-control__item { min-width: 0 }</style>'
}, /private \.el-segmented/u)

expectMutationFailure('rejects an old compatibility alias', (sources) => {
  sources['src/frontend/src/fsusui/legacySegmented.ts'] = 'export { FsusUiSegmentedControl as AdminSegmentedControl } from "./segmentedControl"'
}, /legacy AdminSegmentedControl reference/u)

expectMutationFailure('rejects migrating only the article list while another caller remains', (sources) => {
  sources['src/frontend/src/views/admin/Other.vue'] = '<AdminSegmentedControl />'
}, /legacy AdminSegmentedControl reference/u)

expectMutationFailure('rejects changed status option order', (sources) => {
  sources[composablePath] = sources[composablePath]
    .replace(
      "{ label: '草稿', value: ArticlePublishStatus.Draft },\n  { label: '定时', value: ArticlePublishStatus.Scheduled }",
      "{ label: '定时', value: ArticlePublishStatus.Scheduled },\n  { label: '草稿', value: ArticlePublishStatus.Draft }"
    )
}, /values and order/u)

expectMutationFailure('rejects the old whole-control disabled prop', (sources) => {
  sources[listPath] = sources[listPath].replace('aria-label="文章状态筛选"', ':disabled="isBusy" aria-label="文章状态筛选"')
}, /no public whole-control disabled prop/u)

expectMutationFailure('rejects whole-control disabled across multiline opening-tag attribute order', (sources) => {
  sources[listPath] = sources[listPath].replace(
    '    :model-value="selectedStatusFilter"\n    :items="segmentedStatusFilters"',
    '    :disabled="isBusy"\n    :items="segmentedStatusFilters"\n    :model-value="selectedStatusFilter"'
  )
}, /no public whole-control disabled prop/u)

test('allows trailing disabled bindings after the segmented opening tag closes', () => {
  const sources = canonicalSources()
  sources[listPath] = sources[listPath].replace(
    '    @update:model-value="handleStatusFilterChange"\n  />\n</template>',
    `    @update:model-value="handleStatusFilterChange"
  />
  <button
    type="button"
    :disabled="isBusy"
  >搜索</button>
</template>`
  )

  assert.deepEqual(auditAdminSegmentedControlRemoval(sources), [])
})
