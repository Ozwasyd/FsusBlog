import assert from 'node:assert/strict'
import test from 'node:test'

import {
  auditAdminSegmentedControlBrowserContract,
  auditAdminSegmentedControlRemoval
} from './check-admin-segmented-control-removal.mjs'

const listPath = 'src/frontend/src/views/admin/article/List.vue'
const composablePath = 'src/frontend/src/composables/useAdminArticleList.ts'
const adapterPath = 'src/frontend/src/fsusui/segmentedControl.ts'
const browserGroups = [
  'admin article direct FsusUI segmented consumer (#1888, light)',
  'admin article direct FsusUI segmented consumer (#1888, dark)'
]
const evidenceScreenshots = [
  'issue-1888-admin-article-segmented-light-375-100-states.png',
  'issue-1888-admin-article-segmented-dark-375-100-states.png',
  'issue-1888-admin-article-segmented-light-375-200-long-scroll.png',
  'issue-1888-admin-article-segmented-dark-375-200-long-scroll.png'
]

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

expectMutationFailure('rejects an arbitrarily named forwarding wrapper without native buttons', (sources) => {
  sources['src/frontend/src/components/admin/StatusChoice.vue'] = `
<template>
  <FsusUiSegmentedControl
    :items="props.items"
    :model-value="props.modelValue"
    @update:model-value="emit('update:modelValue', $event)"
  />
</template>
<script setup lang="ts">
import { FsusUiSegmentedControl } from '@/fsusui/segmentedControl'
const props = defineProps<{ items: readonly unknown[]; modelValue: unknown }>()
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>()
</script>`
}, /arbitrary FsusUiSegmentedControl items\/modelValue\/update forwarding wrapper/u)

expectMutationFailure('rejects an arbitrarily named compatibility export alias', (sources) => {
  sources['src/frontend/src/fsusui/statusChoice.ts'] =
    'export { FsusUiSegmentedControl as StatusChoice } from "./segmentedControl"'
}, /arbitrary FsusUiSegmentedControl compatibility alias/u)

expectMutationFailure('rejects an arbitrarily named local compatibility alias', (sources) => {
  sources['src/frontend/src/fsusui/statusChoice.ts'] =
    'import { FsusUiSegmentedControl } from "./segmentedControl"\nexport const StatusChoice = FsusUiSegmentedControl'
}, /arbitrary FsusUiSegmentedControl compatibility alias/u)

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

const canonicalBrowserSmoke = () => `
test.describe('${browserGroups[0]}', () => {})
test.describe('${browserGroups[1]}', () => {})
const routePath = '/user/manage/article/list?page=1&size=10&status=2'
const viewport = { width: 375, height: 812 }
document.documentElement.style.zoom = '2'
await selected.press('Home')
await selected.press('ArrowRight')
await expect(items).toBeDisabled()
const longLabel = '已发布且完成公开索引'
expect(url).toContain('status=0')
expect(url).toContain('status=3')
const geometry = { documentOverflow, scrollWidth, clientWidth, scrollLeft, itemInsideRoot, itemNotClipped }
${evidenceScreenshots.map((name) => `testInfo.outputPath('${name}')`).join('\n')}
`

const canonicalVisualRunner = () => `
segmented_consumer_config="\${FSUSBLOG_VISUAL_DIAGNOSTICS_CONFIG:-playwright.diagnostics.config.ts}"
segmented_consumer_groups=(
  '${browserGroups[0].replace(/[()]/gu, '\\$&')}'
  '${browserGroups[1].replace(/[()]/gu, '\\$&')}'
)
for group in "\${segmented_consumer_groups[@]}"; do
  npx playwright test --config="\${segmented_consumer_config}" ux/admin-article-segmented-consumer.spec.ts --grep "\${group}"
done
`

const expectBrowserContractMutationFailure = (name, mutate, expected) => {
  test(name, () => {
    const fixture = {
      browserSmoke: canonicalBrowserSmoke(),
      visualRunner: canonicalVisualRunner()
    }
    mutate(fixture)
    assert.equal(
      auditAdminSegmentedControlBrowserContract(fixture.browserSmoke, fixture.visualRunner)
        .some((failure) => expected.test(failure)),
      true
    )
  })
}

test('canonical focused browser execution and evidence contract is accepted', () => {
  assert.deepEqual(
    auditAdminSegmentedControlBrowserContract(canonicalBrowserSmoke(), canonicalVisualRunner()),
    []
  )
})

for (const group of browserGroups) {
  expectBrowserContractMutationFailure(`rejects missing browser group ${group}`, (fixture) => {
    fixture.browserSmoke = fixture.browserSmoke.replace(`test.describe('${group}', () => {})`, '')
  }, /focused browser group must exist exactly once/u)

  expectBrowserContractMutationFailure(`rejects changed browser group ${group}`, (fixture) => {
    fixture.browserSmoke = fixture.browserSmoke.replace(group, `${group}-changed`)
  }, /focused browser group must exist exactly once/u)

  expectBrowserContractMutationFailure(`rejects duplicated browser group ${group}`, (fixture) => {
    fixture.browserSmoke += `\ntest.describe('${group}', () => {})`
  }, /focused browser group must exist exactly once/u)

  expectBrowserContractMutationFailure(`rejects missing runner group ${group}`, (fixture) => {
    fixture.visualRunner = fixture.visualRunner.replace(group.replace(/[()]/gu, '\\$&'), '')
  }, /focused browser group must be registered exactly once/u)

  expectBrowserContractMutationFailure(`rejects changed runner group ${group}`, (fixture) => {
    fixture.visualRunner = fixture.visualRunner.replace(group.replace(/[()]/gu, '\\$&'), `${group}-changed`)
  }, /focused browser group must be registered exactly once/u)

  expectBrowserContractMutationFailure(`rejects duplicated runner group ${group}`, (fixture) => {
    fixture.visualRunner += `\n'${group.replace(/[()]/gu, '\\$&')}'`
  }, /focused browser group must be registered exactly once/u)
}

for (const screenshot of evidenceScreenshots) {
  expectBrowserContractMutationFailure(`rejects missing evidence screenshot ${screenshot}`, (fixture) => {
    fixture.browserSmoke = fixture.browserSmoke.replace(`testInfo.outputPath('${screenshot}')`, '')
  }, /fixed evidence screenshot must exist exactly once/u)
}

expectBrowserContractMutationFailure('rejects omitting the production-route browser spec from the runner', (fixture) => {
  fixture.visualRunner = fixture.visualRunner.replace('ux/admin-article-segmented-consumer.spec.ts', 'ux/other.spec.ts')
}, /missing focused browser execution contract/u)

expectBrowserContractMutationFailure('rejects disconnecting the focused spec from diagnostics config', (fixture) => {
  fixture.visualRunner = fixture.visualRunner.replace(
    '--config="${segmented_consumer_config}"',
    '--config="${playwright_config}"'
  )
}, /must bind diagnostics config, spec and exact group grep/u)
