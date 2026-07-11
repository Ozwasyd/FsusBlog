import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrityAdminConsoleResponse } from '@/api/integrityConsole'

const mocks = vi.hoisted(() => ({
  ensureAdminSensitiveProof: vi.fn(),
  getIntegrityAdminConsole: vi.fn(),
  retryIntegrityProof: vi.fn(),
  showErrorToast: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('@/api/integrityConsole', () => ({
  getIntegrityAdminConsole: mocks.getIntegrityAdminConsole,
  retryIntegrityProof: mocks.retryIntegrityProof
}))

vi.mock('@/composables/useAdminSensitiveProof', () => ({
  ensureAdminSensitiveProof: mocks.ensureAdminSensitiveProof
}))

vi.mock('@/utils/errorPresentation', () => ({
  showErrorToast: mocks.showErrorToast
}))

vi.mock('@/fsusui/feedback', () => ({
  toast: { success: mocks.toastSuccess }
}))

import IntegrityProofConsole from '@/views/admin/IntegrityProofConsole.vue'

const PageHeaderStub = defineComponent({
  props: { title: { type: String, default: '' } },
  setup(props) {
    return () => h('h1', props.title)
  }
})

const SectionStub = defineComponent({
  props: { title: { type: String, default: '' } },
  setup(props, { slots }) {
    return () => h('section', [
      h('h2', props.title),
      slots.actions?.(),
      slots.default?.()
    ])
  }
})

const ButtonStub = defineComponent({
  inheritAttrs: false,
  props: {
    disabled: { type: Boolean, default: false }
  },
  setup(props, { attrs, slots }) {
    return () => h('button', {
      disabled: props.disabled,
      onClick: attrs.onClick as (() => void) | undefined
    }, slots.default?.())
  }
})

const TableStub = defineComponent({
  props: {
    data: { type: Array, default: () => [] }
  },
  setup(props, { slots }) {
    return () => h('div', { class: 'el-table-stub' },
      props.data.length > 0 ? slots.default?.() : slots.empty?.())
  }
})

const EmptyStateStub = defineComponent({
  props: {
    title: { type: String, default: '' },
    content: { type: String, default: '' }
  },
  setup(props, { slots }) {
    return () => h('div', { class: 'admin-inline-empty-state-stub' }, [
      `${props.title} ${props.content}`,
      slots.actions?.()
    ])
  }
})

const mountConsole = () => mount(IntegrityProofConsole, {
  global: {
    directives: {
      loading: () => undefined
    },
    stubs: {
      AdminInlineEmptyState: EmptyStateStub,
      FsusUiKeyValueGrid: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }),
      FsusUiKeyValueItem: defineComponent({ setup: (_, { slots }) => () => h('span', slots.default?.()) }),
      FsusUiPageHeader: PageHeaderStub,
      FsusUiSettingsSection: SectionStub,
      ElButton: ButtonStub,
      ElInput: true,
      ElTable: TableStub,
      ElTableColumn: true,
      ElTag: defineComponent({ setup: (_, { slots }) => () => h('span', slots.default?.()) })
    }
  }
})

const consoleResponse = (failed = false): IntegrityAdminConsoleResponse => {
  const proof = {
    proofId: 91,
    articleId: 17,
    articleRevisionId: 82,
    revisionNo: 3,
    proofStatus: 'failed',
    artifactStatus: 'ready',
    signatureStatus: 'signature-invalid',
    transparencyLogStatus: 'chain-broken',
    checkpointStatus: 'missing',
    canonicalHash: 'hash',
    signingKeyId: 'key-current',
    failureCode: 'artifact-hash-mismatch',
    retryAvailable: true,
    publishedAtUtc: '2026-07-11T08:00:00.000Z',
    updatedAtUtc: '2026-07-11T08:01:00.000Z'
  }
  return {
    checkedAtUtc: '2026-07-11T08:01:00.000Z',
    proofs: {
      total: failed ? 1 : 0,
      pending: 0,
      ready: 0,
      failed: failed ? 1 : 0,
      retrying: 0,
      superseded: 0,
      notPublic: 0
    },
    transparencyLog: {
      status: failed ? 'chain-broken' : 'missing',
      headSeq: null,
      headHash: null,
      errorCode: null,
      failedSeq: null
    },
    checkpoint: {
      status: 'missing',
      checkpointKind: null,
      scopeKey: null,
      logHeadSeq: null,
      logHeadHash: null,
      createdAtUtc: null
    },
    keyRegistry: { currentKeyId: null, keys: [] },
    recentProofs: failed ? [proof] : [],
    failedOrRetryingProofs: failed ? [proof] : []
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ensureAdminSensitiveProof.mockResolvedValue('proof-91')
  mocks.retryIntegrityProof.mockResolvedValue({
    proofId: 91,
    proofStatus: 'retrying',
    retriedAtUtc: '2026-07-11T08:02:00.000Z'
  })
  mocks.getIntegrityAdminConsole.mockResolvedValue(consoleResponse())
})

describe('IntegrityProofConsole browser behavior', () => {
  it('renders explicit empty states after a successful empty response', async () => {
    const wrapper = mountConsole()
    await flushPromises()

    expect(wrapper.text()).toContain('暂无 proof')
    expect(wrapper.text()).toContain('暂无失败 proof')
    expect(wrapper.text()).toContain('Signing key registry 未配置')
    expect(mocks.showErrorToast).not.toHaveBeenCalled()
  })

  it('reports a load failure through the shared error presentation path', async () => {
    const error = new Error('integrity console unavailable')
    mocks.getIntegrityAdminConsole.mockRejectedValueOnce(error)

    const wrapper = mountConsole()
    await flushPromises()

    expect(mocks.showErrorToast).toHaveBeenCalledWith(error)
    expect(wrapper.text()).toContain('Proof 状态读取失败')
    expect(wrapper.text()).toContain('integrity console unavailable')

    await wrapper.get('#integrity-proof-error-title button').trigger('click')
    await flushPromises()

    expect(mocks.getIntegrityAdminConsole).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('Proof 状态读取失败')
  })

  it('consumes admin step-up proof before retry and refreshes the console', async () => {
    mocks.getIntegrityAdminConsole.mockResolvedValue(consoleResponse(true))
    const wrapper = mountConsole()
    await flushPromises()

    await wrapper.get('.integrity-proof-console__failed-item button').trigger('click')
    await flushPromises()

    expect(mocks.ensureAdminSensitiveProof).toHaveBeenCalledTimes(1)
    expect(mocks.retryIntegrityProof).toHaveBeenCalledWith(91, 'proof-91')
    expect(mocks.toastSuccess).toHaveBeenCalledWith('已提交 proof 重试')
    expect(mocks.getIntegrityAdminConsole).toHaveBeenCalledTimes(2)
  })
})
