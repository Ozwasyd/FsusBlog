// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'
import AdminDashboardTaskWorkbench from '@/components/admin/AdminDashboardTaskWorkbench.vue'
import type { ConsoleSupportLink } from '@/config/consoleWelcomeCallout'
import {
  createAdminDashboardLedger,
  createAdminDashboardTasks,
  type AdminDashboardLedgerItem,
  type AdminDashboardTaskItem
} from '@/view-contracts/adminDashboard'

const RouterLinkStub = defineComponent({
  props: {
    to: { type: [String, Object], required: true }
  },
  setup(props, { slots }) {
    return () => h('a', {
      'data-route': typeof props.to === 'string' ? props.to : JSON.stringify(props.to)
    }, slots.default?.())
  }
})

const SectionHeaderStub = defineComponent({
  inheritAttrs: false,
  props: {
    title: { type: String, required: true }
  },
  setup(props, { attrs }) {
    return () => h('h2', attrs, props.title)
  }
})

const zeroTasks = createAdminDashboardTasks({
  comments: { count: 0, state: 'ready' },
  tickets: { count: 0, state: 'ready' },
  cache: { count: 0, state: 'ready' }
})

const zeroLedger = createAdminDashboardLedger({
  totalArticles: 0,
  totalComments: 0,
  trashCount: 0,
  totalReads: 0,
  humanVerifiedReads: 0,
  uniqueViewerKeyEstimate: 0,
  articleReads: 0,
  siteReads: 0
})

type WorkbenchProps = {
  hasSummaryData: boolean
  helpLinks: readonly ConsoleSupportLink[]
  ledgerItems: readonly AdminDashboardLedgerItem[]
  summaryErrorMessage: string
  summaryLoaded: boolean
  summaryLoading: boolean
  todayActions: readonly AdminDashboardTaskItem[]
}

const mountWorkbench = (override: Partial<WorkbenchProps> = {}) => mount(AdminDashboardTaskWorkbench, {
  props: {
    hasSummaryData: false,
    helpLinks: [
      { key: 'issue', label: '提交问题', href: 'https://example.test/support' }
    ],
    ledgerItems: zeroLedger,
    summaryErrorMessage: '',
    summaryLoaded: true,
    summaryLoading: false,
    todayActions: zeroTasks,
    ...override
  },
  global: {
    stubs: {
      FsusUiSectionHeader: SectionHeaderStub,
      RouterLink: RouterLinkStub
    }
  }
})

describe('AdminDashboardTaskWorkbench', () => {
  it('renders loading, unchecked, empty, and populated summary states without navigation', async () => {
    const wrapper = mountWorkbench({
      summaryLoaded: false,
      summaryLoading: true
    })

    expect(wrapper.get('[role="status"]').text()).toBe('正在读取站点摘要…')

    await wrapper.setProps({ summaryLoading: false })
    expect(wrapper.get('[role="status"]').text()).toContain('站点摘要尚未检查')

    await wrapper.setProps({ summaryLoaded: true })
    expect(wrapper.get('.dashboard-summary__empty').text()).toContain('先写新文章')

    await wrapper.setProps({
      hasSummaryData: true,
      ledgerItems: createAdminDashboardLedger({
        totalArticles: 12,
        totalComments: 34,
        trashCount: 1,
        totalReads: 56,
        humanVerifiedReads: 0,
        uniqueViewerKeyEstimate: 0,
        articleReads: 0,
        siteReads: 0
      })
    })
    expect(wrapper.find('.dashboard-summary__empty').exists()).toBe(false)
    expect(wrapper.get('dl[aria-label="站点统计摘要"]').text()).toContain('12')
  })

  it('renders all four zero-workload actions and the compact definition list', () => {
    const wrapper = mountWorkbench()

    expect(wrapper.get('h1').text()).toBe('站点工作台')
    expect(wrapper.get('[aria-label="今日待处理任务"]').findAll('li')).toHaveLength(4)
    expect(wrapper.findAll('.dashboard-task-row').map((row) => row.text())).toEqual([
      expect.stringContaining('待审评论'),
      expect.stringContaining('待处理工单'),
      expect.stringContaining('缓存异常'),
      expect.stringContaining('写新文章')
    ])
    expect(wrapper.get('dl[aria-label="站点统计摘要"]').findAll('dt')).toHaveLength(3)
    expect(wrapper.get('dl[aria-label="站点统计摘要"]').findAll('dd').map((item) => item.text()))
      .toEqual(['0', '0', '0'])
    expect(wrapper.text()).toContain('先写新文章，发布后摘要会自动更新')
    expect(wrapper.text()).not.toContain('暂无数据')
    expect(wrapper.find('.dashboard-stat-card').exists()).toBe(false)
    expect(wrapper.find('.el-icon').exists()).toBe(false)
  })

  it('keeps high workload values readable and routes every task directly', () => {
    const todayActions = createAdminDashboardTasks({
      comments: { count: 1384, state: 'ready' },
      tickets: { count: 92, state: 'ready' },
      cache: { count: 3, state: 'ready' }
    })
    const wrapper = mountWorkbench({
      hasSummaryData: true,
      ledgerItems: createAdminDashboardLedger({
        totalArticles: 12000,
        totalComments: 84291,
        trashCount: 71,
        totalReads: 9340021,
        humanVerifiedReads: 0,
        uniqueViewerKeyEstimate: 0,
        articleReads: 0,
        siteReads: 0
      }),
      todayActions
    })

    expect(wrapper.findAll('.dashboard-task-row__value').map((item) => item.text()))
      .toEqual(['1384', '92', '3', '开始'])
    expect(wrapper.findAll('.dashboard-stat-ledger dd').map((item) => item.text()))
      .toEqual(['12000', '84291', '71'])
    expect(wrapper.findAll('[data-route]').map((link) => link.attributes('data-route'))).toEqual([
      '{"name":"ManageModerationComments"}',
      '{"name":"ManageMessages"}',
      '{"name":"ManageCacheDiagnostics"}',
      '{"name":"ManageWriteArticle"}',
      '{"name":"ManageAnalytics"}'
    ])
  })

  it('moves repository feedback behind a neutral help disclosure', () => {
    const wrapper = mountWorkbench()

    expect(wrapper.get('.dashboard-help-menu__trigger').text()).toBe('帮助与反馈')
    expect(wrapper.get('.dashboard-help-menu__link').text()).toBe('提交问题')
    expect(wrapper.get('.dashboard-help-menu__link').attributes()).toMatchObject({
      href: 'https://example.test/support',
      rel: 'noopener noreferrer',
      target: '_blank'
    })
    expect(wrapper.get('.dashboard-page-header').text()).not.toMatch(/GitHub|Issue|仓库维护/u)
  })

  it('offers an explicit retry when the summary fails', async () => {
    const wrapper = mountWorkbench({
      hasSummaryData: false,
      ledgerItems: [],
      summaryErrorMessage: 'network failed',
      summaryLoaded: false
    })

    expect(wrapper.get('[role="alert"]').text()).toContain('站点摘要读取失败；请重新加载')
    await wrapper.get('button.dashboard-inline-action').trigger('click')
    expect(wrapper.emitted('refresh-summary')).toHaveLength(1)
  })
})
