// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { ElMessage } from '@ozwasyd/element-plus'
import { defineComponent, h, nextTick, type Component } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('@/utils/errorPresentation', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/errorPresentation')>()
    return {
        ...actual,
        showErrorToast: (...args: Parameters<typeof actual.showErrorToast>) => {
            mocks.showErrorToast(...args)
            return actual.showErrorToast(...args)
        }
    }
})

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
                    role: props.role || undefined
                },
                [
                    h(props.titleTag, props.title),
                    h('p', slots.description?.() ?? props.description),
                    slots.actions?.(),
                    slots.default?.()
                ]
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

function assertiveLiveRegions(): Element[] {
    return [...document.querySelectorAll('[aria-live="assertive"]')]
}

function alertRoles(): Element[] {
    return [...document.querySelectorAll('[role="alert"]')]
}

function toastMessages(): Element[] {
    return [...document.querySelectorAll('.el-message')]
}

beforeEach(() => {
    vi.resetAllMocks()
})

afterEach(() => {
    ElMessage.closeAll()
    document.body.innerHTML = ''
})

describe('OpsHealth state contract', () => {
    it('binds FsusUI export aliases through their real component identities without losing slots', async () => {
        mocks.getOpsHealth.mockRejectedValueOnce(new Error('alias identity failure'))

        const wrapper = mountPage()
        await flushPromises()

        expect(wrapper.findComponent(EmptyStateStub).exists()).toBe(true)
        expect(wrapper.findComponent(TaskPageHeaderStub).exists()).toBe(true)
        expect(wrapper.find('el-empty-state-stub').exists()).toBe(false)
        expect(wrapper.find('fsus-task-page-header-stub').exists()).toBe(false)
        expect(wrapper.get('[data-ops-health-failure-reason]').text()).toContain('alias identity failure')
        expect(wrapper.get('[data-ops-health-retry]').text()).toContain('重新加载')

        wrapper.unmount()
    })

    it('announces initial loading without flashing the failure reason, alert, toast or retry action', async () => {
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
        expect(wrapper.find('[data-ops-health-failure-reason]').exists()).toBe(false)
        expect(wrapper.find('[data-ops-health-retry]').exists()).toBe(false)
        expect(wrapper.find('[data-ops-health-workbench]').exists()).toBe(false)
        expect(alertRoles()).toHaveLength(0)
        expect(assertiveLiveRegions()).toHaveLength(0)
        expect(toastMessages()).toHaveLength(0)
        expect(mocks.showErrorToast).not.toHaveBeenCalled()

        wrapper.unmount()
    })

    it('replaces initial loading with the workbench after success and leaves no inline failure state', async () => {
        mocks.getOpsHealth.mockResolvedValueOnce(healthSnapshot())

        const wrapper = mountPage()
        await flushPromises()

        expect(wrapper.find('[data-ops-health-state]').exists()).toBe(false)
        expect(wrapper.find('[data-ops-health-failure-reason]').exists()).toBe(false)
        expect(wrapper.find('[data-ops-health-retry]').exists()).toBe(false)
        expect(wrapper.get('[data-ops-health-workbench]').attributes('data-status')).toBe('ready')
        expect(mocks.showErrorToast).not.toHaveBeenCalled()

        wrapper.unmount()
    })

    it('uses one real toast and a visible described failure reason', async () => {
        const error = new Error('upstream unavailable')
        mocks.getOpsHealth.mockRejectedValueOnce(error)

        const wrapper = mountPage()
        await flushPromises()
        await nextTick()

        const state = wrapper.get('[data-ops-health-state]')
        const reason = wrapper.get('[data-ops-health-failure-reason]')
        const retry = wrapper.get<HTMLButtonElement>('[data-ops-health-retry]')
        expect(state.attributes('role')).toBeUndefined()
        expect(state.attributes('aria-live')).toBeUndefined()
        expect(state.text()).toContain('运维状态暂不可用')
        expect(reason.text()).toContain('upstream unavailable')
        expect(reason.attributes('id')).toBe('ops-health-failure-reason')
        expect(retry.attributes('aria-describedby')).toBe(reason.attributes('id'))
        expect(retry.text()).toContain('重新加载')
        expect(retry.attributes('type')).toBe('button')
        expect(retry.element.disabled).toBe(false)
        expect(mocks.showErrorToast).toHaveBeenCalledTimes(1)
        expect(mocks.showErrorToast).toHaveBeenCalledWith(error, '服务与后台状态加载失败')
        expect(toastMessages()).toHaveLength(1)
        expect(assertiveLiveRegions()).toHaveLength(1)
        expect(assertiveLiveRegions()[0]?.textContent).toContain('upstream unavailable')

        retry.element.focus()
        expect(document.activeElement).toBe(retry.element)

        wrapper.unmount()
    })

    it('prevents duplicate retry announcements and clears inline state on success', async () => {
        mocks.getOpsHealth.mockRejectedValueOnce(new Error('initial failure'))
        const retryRequest = deferred<OpsHealthResponse>()
        mocks.getOpsHealth.mockReturnValueOnce(retryRequest.promise)

        const wrapper = mountPage()
        await flushPromises()
        await nextTick()

        expect(mocks.showErrorToast).toHaveBeenCalledTimes(1)
        expect(toastMessages()).toHaveLength(1)
        expect(assertiveLiveRegions()).toHaveLength(1)

        const retry = wrapper.get<HTMLButtonElement>('[data-ops-health-retry]')
        await Promise.all([retry.trigger('click'), retry.trigger('click')])
        await nextTick()

        expect(mocks.getOpsHealth).toHaveBeenCalledTimes(2)
        expect(mocks.showErrorToast).toHaveBeenCalledTimes(1)
        expect(toastMessages()).toHaveLength(1)
        expect(assertiveLiveRegions()).toHaveLength(1)
        expect(wrapper.get<HTMLButtonElement>('[data-ops-health-retry]').element.disabled).toBe(true)
        expect(wrapper.get('[data-ops-health-retry]').attributes('aria-busy')).toBe('true')
        expect(wrapper.get('[data-ops-health-state]').text()).toContain('正在重新读取运维状态')

        retryRequest.resolve(healthSnapshot('degraded'))
        await flushPromises()

        expect(wrapper.find('[data-ops-health-state]').exists()).toBe(false)
        expect(wrapper.find('[data-ops-health-failure-reason]').exists()).toBe(false)
        expect(wrapper.find('[data-ops-health-retry]').exists()).toBe(false)
        expect(wrapper.get('[data-ops-health-workbench]').attributes('data-status')).toBe('degraded')
        expect(mocks.showErrorToast).toHaveBeenCalledTimes(1)

        wrapper.unmount()
    })

    it('adds exactly one toast and one assertive announcement for each newly admitted retry failure', async () => {
        const firstError = new Error('initial failure')
        const retryError = new Error('retry failure')
        mocks.getOpsHealth.mockRejectedValueOnce(firstError)
        const retryRequest = deferred<OpsHealthResponse>()
        mocks.getOpsHealth.mockReturnValueOnce(retryRequest.promise)

        const wrapper = mountPage()
        await flushPromises()
        await nextTick()

        expect(mocks.showErrorToast).toHaveBeenCalledTimes(1)
        expect(toastMessages()).toHaveLength(1)
        expect(assertiveLiveRegions()).toHaveLength(1)

        const retry = wrapper.get('[data-ops-health-retry]')
        await Promise.all([retry.trigger('click'), retry.trigger('click')])
        await nextTick()
        expect(mocks.getOpsHealth).toHaveBeenCalledTimes(2)
        expect(mocks.showErrorToast).toHaveBeenCalledTimes(1)
        expect(assertiveLiveRegions()).toHaveLength(1)

        retryRequest.reject(retryError)
        await flushPromises()
        await nextTick()

        expect(mocks.getOpsHealth).toHaveBeenCalledTimes(2)
        expect(mocks.showErrorToast).toHaveBeenCalledTimes(2)
        expect(mocks.showErrorToast).toHaveBeenNthCalledWith(1, firstError, '服务与后台状态加载失败')
        expect(mocks.showErrorToast).toHaveBeenNthCalledWith(2, retryError, '服务与后台状态加载失败')
        expect(toastMessages()).toHaveLength(2)
        expect(assertiveLiveRegions()).toHaveLength(2)
        expect(wrapper.get('[data-ops-health-failure-reason]').text()).toContain('retry failure')
        expect(wrapper.get('[data-ops-health-retry]').attributes('aria-describedby')).toBe(
            'ops-health-failure-reason'
        )

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

    it('aborts the in-flight request on unmount so a stale response cannot commit, toast or announce', async () => {
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
        expect(toastMessages()).toHaveLength(0)
        expect(assertiveLiveRegions()).toHaveLength(0)
    })
})
