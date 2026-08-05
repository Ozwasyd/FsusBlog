// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, type Component } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OpsHealthResponse } from '@/api/authoring'

type Deferred<T> = Readonly<{
    promise: Promise<T>
    reject: (reason?: unknown) => void
    resolve: (value: T) => void
}>

const mocks = vi.hoisted(() => ({
    getOpsHealth: vi.fn(),
    showErrorToast: vi.fn()
}))

vi.mock('@/api/authoring', () => ({
    getOpsHealth: mocks.getOpsHealth
}))

vi.mock('@/utils/errorPresentation', () => ({
    showErrorToast: mocks.showErrorToast
}))

import OpsHealth from '@/views/admin/OpsHealth.vue'

const healthSnapshot = (status = 'ready'): OpsHealthResponse => ({
    status,
    checkedAt: '2026-08-05T08:00:00.000Z',
    environment: 'Production',
    releaseIdentity: {
        releaseId: '20260805-0800-contract',
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        releaseSlot: 'blue'
    },
    services: [],
    workers: [],
    queueBacklog: {
        articleMutationPending: 0,
        articleMutationFailed: 0,
        auditQueued: 0,
        auditDropped: 0
    },
    backup: {
        status: 'ready',
        checkedAt: '2026-08-05T08:00:00.000Z',
        backupRoot: '/srv/fsusblog/backups',
        artifacts: [],
        restoreDrillCommand: 'fsus restore drill',
        restoreCommand: 'fsus restore latest'
    },
    recentErrors: []
})

function deferred<T>(): Deferred<T> {
    let resolvePromise!: (value: T) => void
    let rejectPromise!: (reason?: unknown) => void
    const promise = new Promise<T>((resolve, reject) => {
        resolvePromise = resolve
        rejectPromise = reject
    })
    return {
        promise,
        resolve: resolvePromise,
        reject: rejectPromise
    }
}

const TaskPageHeaderStub = defineComponent({
    name: 'FsusUiTaskPageHeader',
    props: { title: { type: String, default: '' } },
    setup: (props) => () => h('h1', props.title)
})

const EmptyStateStub = defineComponent({
    name: 'FsusUiEmptyState',
    inheritAttrs: false,
    props: {
        actionVariant: { type: String, default: '' },
        ariaLive: { type: String, default: 'off' },
        description: { type: String, default: '' },
        illustration: { type: [Boolean, String], default: 'auto' },
        role: { type: String, default: '' },
        size: { type: String, default: '' },
        title: { type: String, default: '' },
        titleTag: { type: String, default: 'p' }
    },
    setup(props, { attrs, slots }) {
        return () =>
            h(
                'section',
                {
                    ...attrs,
                    'aria-live': props.ariaLive === 'off' ? undefined : props.ariaLive,
                    'data-action-variant': props.actionVariant,
                    'data-illustration': String(props.illustration),
                    'data-ops-health-state': '',
                    'data-size': props.size,
                    role: props.role
                },
                [h(props.titleTag, props.title), h('p', props.description), slots.actions?.(), slots.default?.()]
            )
    }
})

const ButtonStub = defineComponent({
    name: 'ElButton',
    inheritAttrs: false,
    props: {
        disabled: Boolean,
        loading: Boolean,
        nativeType: { type: String, default: 'button' }
    },
    emits: ['click'],
    setup(props, { attrs, emit, slots }) {
        return () =>
            h(
                'button',
                {
                    ...attrs,
                    'aria-busy': props.loading ? 'true' : undefined,
                    disabled: props.disabled || props.loading,
                    type: props.nativeType,
                    onClick: () => {
                        if (!props.disabled && !props.loading) emit('click')
                    }
                },
                slots.default?.()
            )
    }
})

const WorkbenchStub = defineComponent({
    name: 'OpsHealthWorkbench',
    props: {
        health: { type: Object, required: true },
        loading: Boolean
    },
    emits: ['refresh'],
    setup(props, { emit }) {
        return () =>
            h(
                'section',
                {
                    'data-ops-health-workbench': '',
                    'data-status': (props.health as OpsHealthResponse).status
                },
                [
                    h(
                        'button',
                        {
                            'data-workbench-refresh': '',
                            disabled: props.loading,
                            onClick: () => emit('refresh')
                        },
                        'refresh'
                    )
                ]
            )
    }
})

function mountPage() {
    return mount(OpsHealth, {
        attachTo: document.body,
        shallow: true,
        global: {
            stubs: {
                ElButton: ButtonStub,
                ElEmptyState: EmptyStateStub,
                FsusTaskPageHeader: TaskPageHeaderStub,
                OpsHealthWorkbench: WorkbenchStub
            } satisfies Record<string, Component>
        }
    })
}

beforeEach(() => {
    vi.resetAllMocks()
    mocks.showErrorToast.mockImplementation((_error, fallback: string) => fallback)
})

describe('OpsHealth state contract', () => {
    it('binds FsusUI export aliases through their real component identities without losing slots or aria-live', async () => {
        mocks.getOpsHealth.mockRejectedValueOnce(new Error('alias identity failure'))

        const wrapper = mountPage()
        await flushPromises()

        expect(wrapper.findComponent(EmptyStateStub).exists()).toBe(true)
        expect(wrapper.findComponent(TaskPageHeaderStub).exists()).toBe(true)
        expect(wrapper.find('el-empty-state-stub').exists()).toBe(false)
        expect(wrapper.find('fsus-task-page-header-stub').exists()).toBe(false)
        expect(wrapper.get('[data-ops-health-state]').attributes('aria-live')).toBe('assertive')
        expect(wrapper.get('[data-ops-health-retry]').text()).toContain('重新加载')

        wrapper.unmount()
    })

    it('announces initial loading without flashing the failure reason or retry action', async () => {
        const first = deferred<OpsHealthResponse>()
        mocks.getOpsHealth.mockReturnValueOnce(first.promise)

        const wrapper = mountPage()
        await nextTick()

        const state = wrapper.get('[data-ops-health-state]')
        expect(state.attributes('role')).toBe('status')
        expect(state.attributes('aria-live')).toBe('polite')
        expect(state.attributes('data-size')).toBe('compact')
        expect(state.attributes('data-illustration')).toBe('false')
        expect(state.text()).toContain('正在读取运维状态')
        expect(state.text()).not.toContain('暂不可用')
        expect(wrapper.find('[data-ops-health-retry]').exists()).toBe(false)
        expect(wrapper.find('[data-ops-health-workbench]').exists()).toBe(false)
        expect(mocks.showErrorToast).not.toHaveBeenCalled()

        wrapper.unmount()
    })

    it('replaces initial loading with the workbench after success', async () => {
        mocks.getOpsHealth.mockResolvedValueOnce(healthSnapshot())

        const wrapper = mountPage()
        await flushPromises()

        expect(wrapper.find('[data-ops-health-state]').exists()).toBe(false)
        expect(wrapper.get('[data-ops-health-workbench]').attributes('data-status')).toBe('ready')
        expect(mocks.showErrorToast).not.toHaveBeenCalled()

        wrapper.unmount()
    })

    it('exposes the mapped failure reason and one keyboard-discoverable FsusUI retry action', async () => {
        const error = new Error('upstream unavailable')
        mocks.getOpsHealth.mockRejectedValueOnce(error)
        mocks.showErrorToast.mockReturnValueOnce('运维状态读取失败：上游不可用')

        const wrapper = mountPage()
        await flushPromises()

        const state = wrapper.get('[data-ops-health-state]')
        const retry = wrapper.get<HTMLButtonElement>('[data-ops-health-retry]')
        expect(state.attributes('role')).toBe('alert')
        expect(state.attributes('aria-live')).toBe('assertive')
        expect(state.text()).toContain('运维状态暂不可用')
        expect(state.text()).toContain('运维状态读取失败：上游不可用')
        expect(retry.text()).toContain('重新加载')
        expect(retry.attributes('type')).toBe('button')
        expect(retry.element.disabled).toBe(false)
        expect(mocks.showErrorToast).toHaveBeenCalledTimes(1)
        expect(mocks.showErrorToast).toHaveBeenCalledWith(error, '服务与后台状态加载失败')

        await retry.trigger('keydown', { key: 'Tab' })
        retry.element.focus()
        expect(document.activeElement).toBe(retry.element)

        wrapper.unmount()
    })

    it('admits only one retry request, exposes loading and disabled, then replaces feedback with success', async () => {
        mocks.getOpsHealth.mockRejectedValueOnce(new Error('initial failure'))
        const retryRequest = deferred<OpsHealthResponse>()
        mocks.getOpsHealth.mockReturnValueOnce(retryRequest.promise)

        const wrapper = mountPage()
        await flushPromises()

        const retry = wrapper.get<HTMLButtonElement>('[data-ops-health-retry]')
        await Promise.all([retry.trigger('click'), retry.trigger('click')])
        await nextTick()

        expect(mocks.getOpsHealth).toHaveBeenCalledTimes(2)
        expect(wrapper.get<HTMLButtonElement>('[data-ops-health-retry]').element.disabled).toBe(true)
        expect(wrapper.get('[data-ops-health-retry]').attributes('aria-busy')).toBe('true')
        expect(wrapper.get('[data-ops-health-state]').text()).toContain('正在重新读取运维状态')

        retryRequest.resolve(healthSnapshot('degraded'))
        await flushPromises()

        expect(wrapper.find('[data-ops-health-state]').exists()).toBe(false)
        expect(wrapper.get('[data-ops-health-workbench]').attributes('data-status')).toBe('degraded')
        expect(mocks.showErrorToast).toHaveBeenCalledTimes(1)

        wrapper.unmount()
    })

    it('coalesces repeated workbench refresh while the current request is pending', async () => {
        mocks.getOpsHealth.mockResolvedValueOnce(healthSnapshot())
        const refreshRequest = deferred<OpsHealthResponse>()
        mocks.getOpsHealth.mockReturnValueOnce(refreshRequest.promise)

        const wrapper = mountPage()
        await flushPromises()

        const refresh = wrapper.get('[data-workbench-refresh]')
        await Promise.all([refresh.trigger('click'), refresh.trigger('click')])
        await nextTick()

        expect(mocks.getOpsHealth).toHaveBeenCalledTimes(2)

        refreshRequest.resolve(healthSnapshot('degraded'))
        await flushPromises()
        expect(wrapper.get('[data-ops-health-workbench]').attributes('data-status')).toBe('degraded')

        wrapper.unmount()
    })

    it('aborts the in-flight request on unmount so a stale response cannot commit', async () => {
        const first = deferred<OpsHealthResponse>()
        let capturedSignal: AbortSignal | undefined
        mocks.getOpsHealth.mockImplementationOnce((config?: { signal?: AbortSignal }) => {
            capturedSignal = config?.signal
            return first.promise
        })

        const wrapper = mountPage()
        await nextTick()
        expect(capturedSignal).toBeInstanceOf(AbortSignal)
        expect(capturedSignal?.aborted).toBe(false)

        wrapper.unmount()
        expect(capturedSignal?.aborted).toBe(true)

        first.resolve(healthSnapshot('stale-must-not-commit'))
        await flushPromises()
        expect(mocks.showErrorToast).not.toHaveBeenCalled()
    })
})
