// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SecurityChallenges from '@/views/admin/security/SecurityChallenges.vue'

const apiMocks = vi.hoisted(() => ({
  getSecurityChallengeMetrics: vi.fn(),
  getRiskControlOptions: vi.fn()
}))

vi.mock('@/api/security', () => ({
  getSecurityChallengeMetrics: apiMocks.getSecurityChallengeMetrics,
  getRiskControlOptions: apiMocks.getRiskControlOptions
}))

vi.mock('@/utils/errorPresentation', () => ({
  showErrorToast: vi.fn()
}))

vi.mock('@/fsusui', () => ({
  FsusUiSettingsSection: {
    name: 'FsusUiSettingsSection',
    template: '<section><slot name="actions" /><slot /></section>'
  }
}))

vi.mock('@/fsusui/icons', () => ({
  Refresh: { name: 'Refresh', template: '<span />' }
}))

describe('SecurityChallenges capability readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getSecurityChallengeMetrics.mockResolvedValue({
      windowStartedAtUtc: '2026-07-19T00:00:00Z',
      totalIssued: 0,
      totalAttempts: 0,
      verified: 0,
      successRate: 0,
      failureRate: 0,
      kindBreakdown: [],
      recentAttempts: []
    })
    apiMocks.getRiskControlOptions.mockResolvedValue({
      subsystemModes: {
        pow: 'enforce',
        'perception-localization': 'observe'
      }
    })
  })

  it('separates contract expressibility, current client execution, and policy eligibility by mode', async () => {
    const wrapper = mount(SecurityChallenges, {
      global: {
        stubs: {
          FsusUiSettingsSection: {
            template: '<section><slot name="actions" /><slot /></section>'
          },
          AdminStatusMatrix: true,
          ElButton: { template: '<button><slot /></button>' },
          ElTag: { template: '<span><slot /></span>' }
        }
      }
    })
    await flushPromises()

    const headers = wrapper.findAll('[data-test="challenge-capability-matrix"] th').map((cell) => cell.text())
    expect(headers).toEqual([
      '类型',
      '契约可表达',
      '当前客户端可执行',
      '策略可启用 / 模式',
      'Provider',
      '业务表面'
    ])
    expect(wrapper.find('[data-test="capability-contract-sha256PowV1"]').text()).toBe('可表达')
    expect(wrapper.find('[data-test="capability-client-sha256PowV1"]').text()).toBe('UI + Headless')
    expect(wrapper.find('[data-test="capability-policy-sha256PowV1"]').text()).toBe('可启用（UI + Headless）；模式：enforce')

    expect(wrapper.find('[data-test="capability-contract-perceptionLocalizationV2"]').text()).toBe('可表达')
    expect(wrapper.find('[data-test="capability-client-perceptionLocalizationV2"]').text()).toBe('UI')
    expect(wrapper.find('[data-test="capability-policy-perceptionLocalizationV2"]').text()).toBe('可启用（UI）；模式：observe')
    expect(wrapper.find('[data-test="capability-contract-unknown"]').text()).toBe('不可表达')
  })

  it('keeps contract tables inside a controlled horizontal scroll container', async () => {
    const wrapper = mount(SecurityChallenges, {
      global: {
        stubs: {
          FsusUiSettingsSection: {
            template: '<section><slot name="actions" /><slot /></section>'
          },
          AdminStatusMatrix: true,
          ElButton: { template: '<button><slot /></button>' },
          ElTag: { template: '<span><slot /></span>' }
        }
      }
    })
    await flushPromises()

    const capabilityMatrix = wrapper.get('[data-test="challenge-capability-matrix"]')
    const capabilityScroll = capabilityMatrix.element.closest('.blog-scroll-x-safe')
    expect(capabilityScroll).not.toBeNull()
    expect(capabilityScroll?.classList.contains('security-challenges-table-scroll')).toBe(true)
    expect(capabilityMatrix.find('thead').element.closest('.blog-scroll-x-safe')).toBe(capabilityScroll)
    expect(capabilityMatrix.find('tr').element.closest('.blog-scroll-x-safe')).toBe(capabilityScroll)

    const kindBreakdown = wrapper.get('[data-test="challenge-kind-breakdown"]')
    expect(kindBreakdown.element.closest('.blog-scroll-x-safe')).not.toBeNull()
    expect(wrapper.findAll('.overflow-x-auto').length).toBe(0)
  })
})
