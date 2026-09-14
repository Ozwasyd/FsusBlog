// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import SecurityRiskControl from '@/views/admin/security/SecurityRiskControl.vue'

const apiMocks = vi.hoisted(() => ({
  getRiskControlConsole: vi.fn()
}))

vi.mock('@/api/security', () => ({
  getRiskControlConsole: apiMocks.getRiskControlConsole
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

function createConsoleResponse() {
  return {
    activePolicy: {
      snapshotId: 'snap-1',
      policyVersion: '2',
      updatedAtUtc: '2026-09-03T00:00:00Z',
      globalMode: 'enforce',
      maxRiskScore: 100,
      strictRiskMultiplierPercent: 100,
      lastKnownGoodSnapshotId: null,
      defaultAction: {
        actionName: '*',
        thresholds: {
          challengeScore: 20,
          hardChallengeScore: 60,
          queueScore: 80,
          blockScore: 90
        },
        challengeKind: 'perceptionSealedV2',
        escalationLevel: 1,
        modeOverride: null,
        anonymousWriteAllowed: false,
        hardChallengeKinds: [],
        hardChallengeEscalationLevel: 2
      },
      actionOverrides: {
        'comment.create': {
          actionName: 'comment.create',
          thresholds: {
            challengeScore: 10,
            hardChallengeScore: 40,
            queueScore: 70,
            blockScore: 95
          },
          challengeKind: 'sha256PowV1',
          escalationLevel: 2,
          modeOverride: null,
          anonymousWriteAllowed: false,
          hardChallengeKinds: [],
          hardChallengeEscalationLevel: 3
        }
      },
      subsystemModes: {
        pow: 'enforce'
      }
    },
    risk: {
      eventsLastHour: 0,
      eventsLastDay: 4,
      snapshotCount: 1,
      highRiskSnapshotCount: 0,
      topReason: 'none',
      topSource: 'none'
    },
    riskEventAggregate: [],
    challengeMetrics: {
      kind: null,
      windowStartedAtUtc: '2026-09-03T00:00:00Z',
      totalIssued: 0,
      totalAttempts: 0,
      verified: 0,
      failed: 0,
      replayed: 0,
      expired: 0,
      revoked: 0,
      successRate: 0,
      failureRate: 0,
      kindBreakdown: [],
      recentAttempts: []
    },
    recentEvents: [],
    topRiskSnapshots: []
  }
}

describe('SecurityRiskControl action policy table', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getRiskControlConsole.mockResolvedValue(createConsoleResponse())
  })

  it('keeps the action policy table inside a controlled horizontal scroll container', async () => {
    const wrapper = mount(SecurityRiskControl, {
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

    const table = wrapper.get('[data-test="risk-control-action-policy"]')
    const scroll = table.element.closest('.blog-scroll-x-safe')
    expect(scroll).not.toBeNull()
    expect(scroll?.classList.contains('security-risk-control-table-scroll')).toBe(true)
    expect(table.classes()).toContain('min-w-[32rem]')
    expect(table.find('thead').element.closest('.blog-scroll-x-safe')).toBe(scroll)
    expect(table.find('tr').element.closest('.blog-scroll-x-safe')).toBe(scroll)
    expect(wrapper.findAll('.overflow-x-auto').length).toBe(0)
    expect(table.text()).toContain('20/60/80/90')
    expect(table.text()).toContain('10/40/70/95')
    wrapper.unmount()
  })
})
