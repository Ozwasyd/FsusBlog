// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { ElAlert, ElButton, ElDescriptions, ElDescriptionsItem, ElTag } from '@ozwasyd/element-plus'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PluginAdminDetail, PluginAdminOverview, PluginAdminSummary } from '@/api/authoring'

const mocks = vi.hoisted(() => ({ listPlugins: vi.fn(), getPlugin: vi.fn(), showErrorToast: vi.fn() }))
vi.mock('@/api/authoring', () => ({ ...mocks, installPlugin: vi.fn(), mutatePlugin: vi.fn() }))
vi.mock('@/utils/errorPresentation', () => ({ showErrorToast: mocks.showErrorToast }))
vi.mock('@/composables/useAdminSensitiveProof', () => ({ ensureAdminSensitiveProof: vi.fn() }))
vi.mock('@/fsusui/feedback', () => ({ confirmDanger: vi.fn(), confirmWarning: vi.fn(), toast: { success: vi.fn() } }))
vi.mock('@/fsusui', async () => {
    const { FsusDataList, FsusEmptyState } = await import('@ozwasyd/element-plus')
    const passive = defineComponent({ setup: (_, { slots }) => () => h('section', slots.default?.()) })
    const header = defineComponent({ setup: (_, { slots }) => () => h('header', slots.actions?.()) })
    return { FsusUiDataList: FsusDataList, FsusUiEmptyState: FsusEmptyState,
        FsusUiTaskPageHeader: header, FsusUiSettingsSection: passive,
        FsusUiKeyValueGrid: passive, FsusUiKeyValueItem: passive }
})

import PluginAdmin from '@/views/admin/PluginAdmin.vue'

function snapshot(count: number): PluginAdminOverview {
    return { generatedAtUtc: '2026-10-08T00:00:00Z', currentNodeId: 'disposable-node',
        plugins: Array.from({ length: count }, (_, index): PluginAdminSummary => ({
            pluginId: `plugin-${index}`, name: 'Duplicate name', version: '1.2.3', runtime: 'wasm',
            installState: 'installed', healthState: 'healthy', enabled: false,
            installedAtUtc: '', updatedAtUtc: '', lastErrorCode: null, activeHookCount: 0,
            grantedCapabilityCount: 0, requestedCapabilityCount: 0, clusterConsistent: true,
        })) }
}

const mounted: ReturnType<typeof mount>[] = []
function render() {
    const wrapper = mount(PluginAdmin, { global: {
        components: { ElAlert, ElButton, ElDescriptions, ElDescriptionsItem, ElTag },
        stubs: {
            ElDescriptions: false, ElDescriptionsItem: false, ElTabs: true, ElTabPane: true,
            ElSwitch: true, ElTable: true, ElTableColumn: true, ElSelect: true,
            ElOption: true, ElInputNumber: true, ElInput: true,
        },
    } })
    mounted.push(wrapper)
    return wrapper
}

beforeEach(() => {
    vi.resetAllMocks()
    // Reject the mocked detail API to keep this contract on list selection and error handling.
    mocks.getPlugin.mockRejectedValue(new Error('Disposable detail failure'))
})
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount() })

function pendingDetail<T = PluginAdminDetail>() {
    let resolve!: (value: T) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
function detailSnapshot(index: number, value: string): PluginAdminDetail {
    return { summary: snapshot(2).plugins[index], manifest: {pluginId:'plugin-'+index,name:'Duplicate name',version:'1.2.3',runtime:'wasm',requestedCapabilities:[],runtimeEntry: value,author: '',hostVersionRange: '',description: '',deniedRawPermissions: [],hooks: []},
        config: {value: {label:value}, schema: {}, version: 1, updatedAtUtc:'', reloadState: ''}, permissions: [], nodes: [],recentErrors: [],recentExecutions: [],recentLogs: [],
        metrics:{averageDurationMilliseconds:0,errorCount:0,executionCount:0,timeoutCount:0,successCount:0,permissionDeniedCount:0,quarantineCount:0,runtimeLoadCount:0,runtimeLoadFailureCount:0,maximumDurationMilliseconds:0} }
}
describe('current request identity and lifecycle regression', () => {
    it('releases list loading before default detail and leaves unrelated rows operable', async () => {
        const pending = pendingDetail()
        mocks.listPlugins.mockResolvedValue(snapshot(2))
        mocks.getPlugin.mockReturnValueOnce(pending.promise)
        const wrapper = render()
        await flushPromises()
        const list = wrapper.get('[role="list"]'), rows = list.findAll('button')
        expect(list.attributes('aria-busy')).not.toBe('true')
        expect(rows[0].attributes('aria-busy')).toBe('true')
        expect((rows[0].element as HTMLButtonElement).disabled).toBe(true)
        expect((rows[1].element as HTMLButtonElement).disabled).toBe(false)
        await rows[1].trigger('click'); await flushPromises()
        expect(mocks.getPlugin).toHaveBeenLastCalledWith('plugin-1')
        pending.reject(new Error('obsolete default detail')); await flushPromises()
    })
    it('does not let stale B completion clear busy A or report its error', async () => {
        mocks.listPlugins.mockResolvedValue(snapshot(2)); const wrapper = render(); await flushPromises()
        mocks.showErrorToast.mockClear()
        const b=pendingDetail(), a=pendingDetail()
        mocks.getPlugin.mockReturnValueOnce(b.promise).mockReturnValueOnce(a.promise)
        const rows=wrapper.get('[role="list"]').findAll('button')
        await rows[1].trigger('click'); await rows[0].trigger('click')
        b.reject(new Error('obsolete B')); await flushPromises()
        expect((rows[0].element as HTMLButtonElement).disabled).toBe(true)
        expect((rows[1].element as HTMLButtonElement).disabled).toBe(false)
        expect(mocks.showErrorToast).not.toHaveBeenCalled()
        a.reject(new Error('current A')); await flushPromises()
        expect((rows[0].element as HTMLButtonElement).disabled).toBe(false)
        expect(mocks.showErrorToast).toHaveBeenCalledTimes(1)
    })
    it('rejects obsolete successful responses even for repeated selection of the same ID', async () => {
        mocks.listPlugins.mockResolvedValue(snapshot(2)); const wrapper=render(); await flushPromises()
        const bOld=pendingDetail(), a=pendingDetail(), bCurrent=pendingDetail()
        mocks.getPlugin.mockReturnValueOnce(bOld.promise).mockReturnValueOnce(a.promise).mockReturnValueOnce(bCurrent.promise)
        const rows=wrapper.get('[role="list"]').findAll('button')
        await rows[1].trigger('click'); await rows[0].trigger('click'); await rows[1].trigger('click')
        bOld.resolve(detailSnapshot(1,'obsolete-B')); await flushPromises()
        expect((rows[1].element as HTMLButtonElement).disabled).toBe(true)
        expect(wrapper.text()).not.toContain('obsolete-B')
        bCurrent.resolve(detailSnapshot(1,'current-B')); await flushPromises()
        a.resolve(detailSnapshot(0,'obsolete-A')); await flushPromises()
        expect(wrapper.text()).toContain('current-B'); expect(wrapper.text()).not.toContain('obsolete-A')
        expect((rows[1].element as HTMLButtonElement).disabled).toBe(false)
    })
    it('invalidates pending detail on an empty refresh and component disposal', async () => {
        mocks.listPlugins.mockResolvedValue(snapshot(2)); const wrapper=render(); await flushPromises()
        const detail=pendingDetail(); mocks.getPlugin.mockReturnValueOnce(detail.promise)
        await wrapper.get('[role="list"]').findAll('button')[1].trigger('click')
        mocks.listPlugins.mockResolvedValue(snapshot(0))
        await wrapper.findAll('button').find(button=>button.text()==='刷新')!.trigger('click'); await flushPromises()
        mocks.showErrorToast.mockClear(); detail.reject(new Error('removed plugin')); await flushPromises()
        expect(mocks.showErrorToast).not.toHaveBeenCalled(); expect(wrapper.get('[role="list"]').attributes('aria-busy')).not.toBe('true')
        const overview=pendingDetail<PluginAdminOverview>(); mocks.listPlugins.mockReturnValueOnce(overview.promise)
        const disposing=render(); await nextTick(); disposing.unmount()
        overview.reject(new Error('disposed overview')); await flushPromises()
        expect(mocks.showErrorToast).not.toHaveBeenCalled()
    })
})
