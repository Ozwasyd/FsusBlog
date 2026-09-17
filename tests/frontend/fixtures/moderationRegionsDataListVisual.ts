import { createApp, h, nextTick } from 'vue'

import '@/assets/main.css'
import { ArrowRight } from '@/fsusui/icons'
import {
  FsusDataList as FsusUiDataList,
  type DataListColumn as FsusUiDataListColumn,
} from '@element-plus/components/collection-primitives'

const params = new URL(window.location.href).searchParams
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.classList.toggle('dark', theme === 'dark')
document.documentElement.dataset.themeMode = theme
document.documentElement.dataset.themeResolved = theme
document.body.className = 'account-shell'

const fixtureHost = document.getElementById('moderation-regions-data-list-fixture')
if (!fixtureHost) {
  throw new Error('moderation_regions_data_list_fixture_host_missing')
}

fixtureHost.style.width = 'min(calc(100% - 2rem), 44rem)'
fixtureHost.style.margin = '1.5rem auto'

const rows = [
  { regionCode: 'GLOBAL', region: '全局', meta: '默认策略' },
  { regionCode: 'CN-MAINLAND', region: '中国大陆', meta: '独立地区 · 标准策略' },
  { regionCode: 'CN-HK', region: '中国香港', meta: '中国大陆下属地区 · 标准策略' },
]
const columns: FsusUiDataListColumn[] = [
  { key: 'region', label: '地区', grid: 'minmax(0, 1fr)' },
  { key: 'indicator', label: '进入', grid: '40px', align: 'end' },
]

createApp({
  render: () =>
    h(
      'main',
      {
        'aria-label': 'Moderation regions DataList fixture',
      },
      [
        h('h1', { style: 'font-size:1.25rem;font-weight:700' }, '地区生效规则'),
        h(
          FsusUiDataList,
          {
            class: 'moderation-regions-mobile-list',
            style: {
              '--el-data-list-hover-background':
                'color-mix(in srgb, var(--fsusblog-color-primary) 5%, transparent)',
              '--el-data-list-active-background':
                'color-mix(in srgb, var(--fsusblog-color-primary) 8%, transparent)',
              '--el-data-list-focus-ring': 'var(--fsusblog-color-focus-ring)',
              '--el-data-list-active-indicator':
                'var(--fsusblog-color-primary)',
              '--el-data-list-row-accent-color': 'var(--fsusblog-text-muted)',
              'margin-top': '1rem',
              'border-block':
                '1px solid var(--fsusblog-panel-border)',
            },
            rows,
            columns,
            rowKey: 'regionCode',
            activeKey: 'CN-MAINLAND',
            href: (row: Record<string, unknown>) =>
              `#${String(row.regionCode)}`,
            density: 'compact',
            variant: 'navigation',
            showHeader: false,
            ariaLabel: '地区定义列表',
          },
          {
            cell: ({
              row,
              column,
              active,
            }: {
              row: Record<string, unknown>
              column: FsusUiDataListColumn
              active: boolean
            }) =>
              column.key === 'region'
                ? h(
                    'span',
                    {
                      style:
                        'display:grid;min-width:0;gap:4px;overflow:hidden',
                    },
                    [
                      h(
                        'span',
                        {
                          style:
                            'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:700;line-height:1.15',
                        },
                        String(row.region),
                      ),
                      h(
                        'span',
                        {
                          style:
                            'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fsusblog-text-muted);font-size:12px;font-weight:500;line-height:1.2',
                        },
                        String(row.meta),
                      ),
                    ],
                  )
                : h(
                    'span',
                    {
                      'data-region-indicator': String(row.regionCode),
                      'data-active': active ? 'true' : 'false',
                      style:
                        'display:inline-flex;width:22px;height:22px;align-items:center;justify-content:center;color:var(--el-data-list-row-accent-color);opacity:var(--el-data-list-row-accent-opacity)',
                    },
                    [h(ArrowRight, { style: 'width:14px;height:14px' })],
                  ),
          },
        ),
      ],
    ),
}).mount(fixtureHost)

await nextTick()
document.documentElement.dataset.moderationRegionsDataListFixtureReady = 'true'
