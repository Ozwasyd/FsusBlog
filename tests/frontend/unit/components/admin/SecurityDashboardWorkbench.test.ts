// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'
import SecurityDashboardWorkbench from '@/components/admin/SecurityDashboardWorkbench.vue'
import type { SecurityDashboardModel } from '@/view-contracts/securityDashboard'

const RouterLinkStub = defineComponent({
  props: {
    to: { type: Object, required: true }
  },
  setup(props, { slots }) {
    return () => h('a', {
      'data-route': JSON.stringify(props.to)
    }, slots.default?.())
  }
})

const createModel = (taskCount: number): SecurityDashboardModel => ({
  checkedAtUtc: '2026-07-23T08:00:00.000Z',
  changes: [{
    actor: 'admin:7',
    key: 'pow-7',
    label: 'PoW 策略',
    occurredAt: '2026-07-23T07:30:00.000Z',
    value: 'strict'
  }],
  status: taskCount > 0 ? 'attention' : 'healthy',
  statusCopy: taskCount > 0
    ? `发现 ${taskCount} 类需要处理的安全异常。`
    : '系统处于预期状态，当前没有需要处理的安全异常。',
  tasks: Array.from({ length: taskCount }, (_, index) => ({
    actionLabel: '查看风险事件',
    helper: '确认来源、处置结果和是否需要调整当前策略。',
    key: `task-${index}`,
    occurredAt: '2026-07-23T08:00:00.000Z',
    severity: index === 0 ? 'critical' : 'warning',
    severityLabel: index === 0 ? '严重' : '警告',
    title: `安全异常 ${index + 1}`,
    to: { name: 'ManageSecurityEvents' }
  })),
  trends: [
    { key: 'hour', label: '近 1 小时事件', value: String(taskCount) }
  ]
})

const mountWorkbench = (taskCount: number) => mount(SecurityDashboardWorkbench, {
  props: {
    errorMessage: '',
    loading: false,
    model: createModel(taskCount)
  },
  global: {
    stubs: {
      RouterLink: RouterLinkStub
    }
  }
})

describe('SecurityDashboardWorkbench', () => {
  it('renders one compact healthy state without a subsystem directory or status wall', () => {
    const wrapper = mountWorkbench(0)

    expect(wrapper.get('[role="status"]').text()).toContain('暂无待处理异常')
    expect(wrapper.find('.security-dashboard__links').exists()).toBe(false)
    expect(wrapper.find('[aria-label="安全系统入口"]').exists()).toBe(false)
    expect(wrapper.findAll('.security-task-list__item')).toHaveLength(0)
    expect(wrapper.findAll('.security-workbench__count')).toHaveLength(0)
    expect(wrapper.text()).not.toMatch(/风险模拟器|验证任务|反爬虫系统|PoW 系统/u)
  })

  it.each([1, 5, 20])('renders %i contextual anomaly rows with explicit next actions', (count) => {
    const wrapper = mountWorkbench(count)

    expect(wrapper.findAll('.security-task-list__item')).toHaveLength(count)
    expect(wrapper.findAll('.security-task-list__action')).toHaveLength(count)
    expect(wrapper.findAll('[data-route]')).toHaveLength(count)
    expect(wrapper.get('.security-workbench__count').text()).toBe(String(count))
    expect(wrapper.get('.security-task-list__severity').text()).toContain('严重')
  })

  it('keeps policy changes in a flat recent-change list and emits refresh', async () => {
    const wrapper = mountWorkbench(1)

    expect(wrapper.get('.security-change-list').text()).toContain('PoW 策略')
    expect(wrapper.get('.security-change-list').text()).toContain('admin:7')
    expect(wrapper.find('.security-dashboard__link').exists()).toBe(false)

    await wrapper.get('button.security-workbench__refresh').trigger('click')
    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })
})
