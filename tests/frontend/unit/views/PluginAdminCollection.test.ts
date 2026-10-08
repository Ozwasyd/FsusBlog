// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { ElAlert, ElButton, ElTag } from '@ozwasyd/element-plus'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PluginAdminOverview, PluginAdminSummary } from '@/api/authoring'

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
        components: { ElAlert, ElButton, ElTag },
        stubs: {
            ElDescriptions: true, ElDescriptionsItem: true, ElTabs: true, ElTabPane: true,
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

describe('PluginAdmin public collection consumer', () => {
    it.each([0, 1, 1000])('renders %i real public collection rows and preserves all metadata', async (count) => {
        mocks.listPlugins.mockResolvedValue(snapshot(count))
        const wrapper = render()
        await flushPromises()
        const list = wrapper.get('[role="list"][aria-label="已安装插件"]')
        expect(list.findAll('[role="listitem"]')).toHaveLength(count)
        expect(list.findAll('button')).toHaveLength(count)
        expect(wrapper.text()).toContain('disposable-node')
        if (count) {
            for (const value of ['Duplicate name', 'plugin-0', '1.2.3', 'Healthy', 'wasm'])
                expect(list.findAll('button')[0].text()).toContain(value)
            expect(mocks.getPlugin).toHaveBeenCalledWith('plugin-0')
            expect(list.findAll('button')[0].attributes('aria-current')).toBe('true')
        } else expect(list.text()).toContain('尚未安装插件')
    })

    it('selects duplicate names by plugin ID and retains detail error handling', async () => {
        mocks.listPlugins.mockResolvedValue(snapshot(2))
        const wrapper = render()
        await flushPromises()
        const list = wrapper.get('[role="list"][aria-label="已安装插件"]')
        await list.findAll('button')[1].trigger('click')
        await flushPromises()
        expect(mocks.getPlugin).toHaveBeenLastCalledWith('plugin-1')
        expect(list.findAll('button')[1].attributes('aria-current')).toBe('true')
        expect(list.findAll('button')[0].attributes('aria-current')).toBeUndefined()
        expect(mocks.showErrorToast).toHaveBeenLastCalledWith(expect.any(Error), '插件详情加载失败')
        const reordered = snapshot(2)
        reordered.plugins.reverse()
        mocks.listPlugins.mockResolvedValue(reordered)
        await wrapper.findAll('button').find((button) => button.text() === '刷新')!.trigger('click')
        await flushPromises()
        expect(mocks.getPlugin).toHaveBeenLastCalledWith('plugin-1')
        expect(list.findAll('button')[0].attributes('aria-current')).toBe('true')
    })

    it('announces loading and failed initial reads, then recovers without a fallback list', async () => {
        let reject!: (reason: Error) => void
        mocks.listPlugins.mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
        const wrapper = render()
        await nextTick()
        expect(wrapper.text()).toContain('正在读取插件列表…')
        expect(wrapper.get('[role="list"]').attributes('aria-busy')).toBe('true')
        reject(new Error('Disposable overview failure'))
        await flushPromises()
        expect(wrapper.text()).toContain('插件列表加载失败')
        expect(mocks.showErrorToast).toHaveBeenCalledWith(expect.any(Error), '插件列表加载失败')
        mocks.listPlugins.mockResolvedValue(snapshot(1))
        await wrapper.findAll('button').find((button) => button.text() === '刷新')!.trigger('click')
        await flushPromises()
        expect(wrapper.get('[role="list"]').findAll('button')).toHaveLength(1)
        expect(wrapper.text()).not.toContain('插件列表加载失败')
    })

    it('keeps long identity content in public cells', async () => {
        const overview = snapshot(1)
        overview.plugins[0].pluginId = 'plugin-long-identity'.repeat(20)
        mocks.listPlugins.mockResolvedValue(overview)
        const wrapper = render()
        await flushPromises()
        expect(wrapper.get('[role="list"]').text()).toContain(overview.plugins[0].pluginId)
        expect(mocks.getPlugin).toHaveBeenCalledWith(overview.plugins[0].pluginId)
    })

    it('rejects busy row activation and recovers after detail failure', async () => {
        let reject!: (reason: Error) => void
        mocks.listPlugins.mockResolvedValue(snapshot(2))
        mocks.getPlugin.mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
        const wrapper = render()
        await flushPromises()
        const button = wrapper.get('[role="list"]').findAll('button')[0]
        expect((button.element as HTMLButtonElement).disabled).toBe(true)
        button.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(mocks.getPlugin).toHaveBeenCalledTimes(1)
        reject(new Error('Interrupted detail load'))
        await flushPromises()
        expect((button.element as HTMLButtonElement).disabled).toBe(false)
        await button.trigger('click')
        await flushPromises()
        expect(mocks.getPlugin).toHaveBeenCalledTimes(2)
    })
})
