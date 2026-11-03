// @vitest-environment happy-dom

import UI, { ElInput, ElInputNumber, ElOption, ElSelect, ElSwitch } from '@ozwasyd/element-plus';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginAdminDetail, PluginAdminSummary } from '@/api/authoring';

const mocks = vi.hoisted(() => ({
    listPlugins: vi.fn(), getPlugin: vi.fn(), mutatePlugin: vi.fn(),
    ensureAdminSensitiveProof: vi.fn(), showErrorToast: vi.fn(), success: vi.fn()
}));
vi.mock('@/api/authoring', () => ({ ...mocks, installPlugin: vi.fn() }));
vi.mock('@/utils/errorPresentation', () => ({ showErrorToast: mocks.showErrorToast }));
vi.mock('@/composables/useAdminSensitiveProof', () => ({ ensureAdminSensitiveProof: mocks.ensureAdminSensitiveProof }));
vi.mock('@/fsusui/feedback', () => ({ confirmDanger: vi.fn(), confirmWarning: vi.fn(), toast: { success: mocks.success } }));
vi.mock('@/fsusui', async () =>
{
    const { FsusDataList, FsusEmptyState } = await import('@ozwasyd/element-plus');
    const section = defineComponent({ setup: (_, { slots }) => () => h('section', [slots.default?.(), slots.footer?.()]) });
    const header = defineComponent({ setup: (_, { slots }) => () => h('header', slots.actions?.()) });
    return {
        FsusUiDataList: FsusDataList, FsusUiEmptyState: FsusEmptyState,
        FsusUiTaskPageHeader: header, FsusUiSettingsSection: section,
        FsusUiKeyValueGrid: section, FsusUiKeyValueItem: section
    };
});

import PluginAdmin from '@/views/admin/PluginAdmin.vue';

const summary: PluginAdminSummary = {
    pluginId: 'disposable-plugin', name: 'Plugin', version: '1.2.3', runtime: 'wasm',
    installState: 'installed', healthState: 'healthy', enabled: false,
    installedAtUtc: '', updatedAtUtc: '', lastErrorCode: null,
    activeHookCount: 0, grantedCapabilityCount: 0, requestedCapabilityCount: 0, clusterConsistent: true
};
const mounted: ReturnType<typeof mount>[] = [];
const content = defineComponent({ setup: (_, { slots }) => () => h('section', slots.default?.()) });

async function render(properties: unknown, value: Record<string, unknown>)
{
    const detail: PluginAdminDetail = {
        summary,
        manifest: {
            pluginId: summary.pluginId, name: summary.name, version: summary.version, runtime: summary.runtime,
            runtimeEntry: 'entry', author: 'Author', hostVersionRange: '*', description: 'Description',
            requestedCapabilities: [], deniedRawPermissions: [], hooks: []
        },
        permissions: [], nodes: [], recentErrors: [], recentExecutions: [], recentLogs: [],
        config: { value, schema: { properties }, version: 1, updatedAtUtc: '', reloadState: 'ready' },
        metrics: {
            executionCount: 0, successCount: 0, errorCount: 0, timeoutCount: 0,
            permissionDeniedCount: 0, quarantineCount: 0, runtimeLoadCount: 0, runtimeLoadFailureCount: 0,
            averageDurationMilliseconds: 0, maximumDurationMilliseconds: 0
        }
    };
    mocks.listPlugins.mockResolvedValue({ generatedAtUtc: '', currentNodeId: 'disposable-node', plugins: [summary] });
    mocks.getPlugin.mockResolvedValue(detail);
    const wrapper = mount(PluginAdmin, { attachTo: document.body, global: { plugins: [UI], stubs: { ElTable: true, ElTableColumn: true, ElTabs: content, ElTabPane: content } } });
    mounted.push(wrapper);
    await flushPromises();
    return wrapper;
}

async function save(wrapper: ReturnType<typeof mount>)
{
    const button = wrapper.findAll('button').find((item) => item.text() === '校验并保存');
    expect(button).toBeDefined();
    await button!.trigger('click');
    await flushPromises();
    expect(mocks.ensureAdminSensitiveProof).toHaveBeenCalledTimes(1);
    expect(mocks.mutatePlugin).toHaveBeenCalledTimes(1);
    return mocks.mutatePlugin.mock.calls[0][1] as { action: string; config: Record<string, unknown>; expectedConfigVersion: number };
}

beforeEach(() =>
{
    vi.resetAllMocks();
    mocks.ensureAdminSensitiveProof.mockResolvedValue('disposable-unit-proof');
    mocks.mutatePlugin.mockResolvedValue(null);
});
afterEach(() =>
{
    for (const wrapper of mounted.splice(0))
    {
        wrapper.unmount();
    }
});

describe('PluginAdmin public config inputs', () =>
{
    it('preserves scalar metadata, false/zero/empty values and unrelated draft data through explicit public edits', async () =>
    {
        const value = { flag: false, count: 0, text: '', choice: false, nested: { keep: ['unaltered'] } };
        const wrapper = await render({
            flag: { type: 'boolean', title: false, description: 0 },
            count: { type: 'number', title: 0, minimum: 0, maximum: 10 },
            text: { type: 'string', title: '', description: false },
            choice: { enum: ['', 0, false, { key: 'object' }] }
        }, value);
        expect(wrapper.findComponent(ElSwitch).props('modelValue')).toBe(false);
        expect(wrapper.findComponent(ElInputNumber).props('modelValue')).toBe(0);
        expect(wrapper.findComponent(ElSelect).props('modelValue')).toBe(false);
        const text = wrapper.findAllComponents(ElInput).find((input) => input.element.closest('.plugin-config-field')?.querySelector('span')?.textContent === '');
        expect(text).toBeDefined();
        expect(text!.props('modelValue')).toBe('');
        expect(wrapper.findAll('.plugin-config-field > span').map((item) => item.text())).toEqual(['false', '0', '', 'choice']);
        expect(wrapper.findAll('.plugin-config-field > small').map((item) => item.text())).toEqual(['0', '', 'false', '']);
        wrapper.findComponent(ElSwitch).vm.$emit('update:modelValue', true);
        wrapper.findComponent(ElInputNumber).vm.$emit('update:modelValue', 3);
        text!.vm.$emit('update:modelValue', 'edited');
        wrapper.findComponent(ElSelect).vm.$emit('update:modelValue', 0);
        await flushPromises();
        expect(await save(wrapper)).toEqual({
            action: 'update-config', config: { ...value, flag: true, count: 3, text: 'edited', choice: 0 }, expectedConfigVersion: 1
        });
        expect(value).toEqual({ flag: false, count: 0, text: '', choice: false, nested: { keep: ['unaltered'] } });
        expect(mocks.showErrorToast).not.toHaveBeenCalled();
    });

    it('rejects malformed properties/options and projects invalid control values without rewriting the JSON draft', async () =>
    {
        const value = { text: { retain: true }, flag: ['retain'], count: '17', choice: null, hidden: { retain: ['also'] } };
        const wrapper = await render({
            nullProperty: null, arrayProperty: [], primitiveProperty: true,
            text: { title: {}, description: ['invalid'], type: {} },
            flag: { type: 'boolean' }, count: { type: 'number', minimum: '0', maximum: '20' },
            choice: { enum: [null, [], '', 0, false, { allowed: true }] }
        }, value);
        expect(wrapper.findAll('.plugin-config-field > span').map((item) => item.text())).toEqual(['text', 'flag', 'count', 'choice']);
        expect(wrapper.findAll('.plugin-config-field > small').every((item) => item.text() === '')).toBe(true);
        expect(wrapper.findComponent(ElSwitch).props('modelValue')).toBe(false);
        expect(wrapper.findComponent(ElInputNumber).props('modelValue')).toBeUndefined();
        expect(wrapper.findComponent(ElOption).props('value')).toBe('');
        expect(wrapper.findAllComponents(ElOption).map((option) => option.props('value'))).toEqual(['', 0, false, { allowed: true }]);
        expect((await save(wrapper)).config).toEqual(value);
        expect(mocks.showErrorToast).not.toHaveBeenCalled();
    });

    it.each([{ properties: null }, { properties: [] }, { properties: true }, { properties: 'invalid' }])('keeps a malformed properties root inert without erasing configuration: $properties', async ({ properties }) =>
    {
        const value = { hidden: { retained: true } };
        const wrapper = await render(properties, value);
        expect(wrapper.findAll('.plugin-config-field')).toHaveLength(0);
        expect(wrapper.text()).toContain('此插件没有可编辑的顶层配置字段');
        expect((await save(wrapper)).config).toEqual(value);
        expect(mocks.showErrorToast).not.toHaveBeenCalled();
    });
});
