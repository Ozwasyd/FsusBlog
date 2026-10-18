// @vitest-environment happy-dom
import { defineComponent, h } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { ElButton, ElForm, ElFormItem, ElMarkdownEditor, ElMarkdownRenderer, ElOption, ElSelect } from '@ozwasyd/element-plus';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AuthorTypographySettings from '@/components/admin/article/AuthorTypographySettings.vue';
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue';
import { AUTHOR_TYPOGRAPHY_FIELDS } from '@/view-contracts/authorTypographyProfile';
import type { AuthorTypographySettingsView } from '@/view-contracts/authorTypographySettings';

const observation: AuthorTypographySettingsView = Object.freeze({
    profile: Object.freeze({
        schemaVersion: 1, fontFamily: 'cjk-sans', fontSize: 'large', lineHeight: 'relaxed',
        canvasWidth: 'narrow', paragraphSpacing: 'compact'
    }),
    revision: 17, status: 'current', permission: 'allowed', device: 'verified',
    designDefault: 'verified', font: 'unavailable'
});
const cleanups: (() => void)[] = [];
const publicControls = { ElButton, ElForm, ElFormItem, ElOption, ElSelect };
function open(view = observation, registerControls = true)
{
    const wrapper = mount(AuthorTypographySettings, {
        props: { view }, global: { components: { ElMarkdownRenderer, ...(registerControls ? publicControls : {}) } }
    });
    cleanups.push(() => wrapper.unmount());
    return wrapper;
}
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));

describe('AuthorTypographySettings with the real local FsusUI', () =>
{
    it('requires the public control registration when the production resolver is absent', () =>
    {
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try
        {
            const wrapper = open(observation, false);
            for (const [name, control] of Object.entries(publicControls))
            {
                expect(warnings.mock.calls.some(([message]) => String(message).includes(`Failed to resolve component: ${name}`))).toBe(true);
                expect(wrapper.findComponent(control).exists()).toBe(false);
            }
            expect(wrapper.emitted('change')).toBeUndefined();
            expect(wrapper.emitted('reset')).toBeUndefined();
        }
        finally { warnings.mockRestore(); }
    });

    it('projects exactly five current choices, associated labels and actual unavailable mapping', async () =>
    {
        const wrapper = open();
        await flushPromises();
        const selects = wrapper.findAllComponents(ElSelect);
        expect(selects).toHaveLength(5);
        expect(selects.map(select => select.props('modelValue'))).toEqual(AUTHOR_TYPOGRAPHY_FIELDS.map(field => observation.profile![field]));
        for (const select of selects)
        {
            const id = select.props('id');
            expect(wrapper.get(`label[for="${id}"]`).text()).not.toBe('');
            expect(select.get('input[role="combobox"]').attributes('disabled')).toBeDefined();
        }
        expect(wrapper.getComponent(ElForm).props('disabled')).toBe(true);
        expect(wrapper.text()).toContain('当前偏好版本 17');
        expect(wrapper.text()).toContain('当前排版组合尚不受写作表面支持');
        expect(wrapper.text()).toContain('不展示所选排版');
        expect(wrapper.findComponent(ElMarkdownEditor).exists()).toBe(false);
        const sample = wrapper.getComponent(MarkdownRenderer);
        expect(sample.props()).toMatchObject({ mode: 'preview', allowLatex: false, allowMermaid: false, baseUrl: null });
        expect(sample.getComponent(ElMarkdownRenderer).vm).toBeDefined();
        expect(sample.props('content')).toContain('العربية');
        expect(sample.props('content')).toContain('👩🏽‍💻');
        expect(wrapper.emitted('change')).toBeUndefined();
    });

    it('disables unsupported options and emits only controlled supported CAS/reset intents without a second editor', async () =>
    {
        const supported: AuthorTypographySettingsView = {
            ...observation, profile: { ...observation.profile!, fontFamily: 'system-sans', paragraphSpacing: 'standard' }
        };
        const wrapper = open(supported);
        expect(wrapper.getComponent(ElForm).props('disabled')).toBe(false);
        const selects = wrapper.findAllComponents(ElSelect);
        expect(selects[0].findAllComponents(ElOption).map(option => option.props('disabled'))).toEqual([false, true, true]);
        expect(selects[4].findAllComponents(ElOption).map(option => option.props('disabled'))).toEqual([true, false, true]);
        selects[0].vm.$emit('update:modelValue', 'reading-serif');
        selects[4].vm.$emit('update:modelValue', 'relaxed');
        expect(wrapper.emitted('change')).toBeUndefined();
        selects[1].vm.$emit('update:modelValue', 'compact');
        await flushPromises();
        expect(wrapper.emitted('change')).toEqual([[{ expectedRevision: 17, profile: { ...supported.profile!, fontSize: 'compact' } }]]);
        expect(Object.isFrozen(wrapper.emitted('change')![0][0])).toBe(true);
        expect(selects[1].props('modelValue')).toBe('large');
        expect(wrapper.props('view')).toBe(supported);
        wrapper.getComponent(ElButton).vm.$emit('click', new MouseEvent('click'));
        expect(wrapper.emitted('reset')).toEqual([[{ expectedRevision: 17 }]]);
        expect(wrapper.findComponent(ElMarkdownEditor).exists()).toBe(false);
        expect(wrapper.text()).not.toContain('服务端已确认偏好');
        expect(wrapper.text()).not.toContain('已应用');
    });

    it('refuses forced select/reset events and does not keep optimistic local choices', async () =>
    {
        const wrapper = open();
        for (const select of wrapper.findAllComponents(ElSelect))
        {
            select.vm.$emit('update:modelValue', 'standard');
            select.vm.$emit('update:modelValue', 'https://fonts.example/font.woff2');
        }
        wrapper.findAllComponents(ElButton)[0].vm.$emit('click', new MouseEvent('click'));
        await flushPromises();
        expect(wrapper.emitted('change')).toBeUndefined();
        expect(wrapper.emitted('reset')).toBeUndefined();
        expect(wrapper.props('view')).toBe(observation);
        await wrapper.setProps({ view: { ...observation, revision: 18, profile: { ...observation.profile!, fontSize: 'compact' } } });
        expect(wrapper.findAllComponents(ElSelect)[1].props('modelValue')).toBe('compact');
        expect(wrapper.text()).toContain('当前偏好版本 18');
    });

    it('displays absence without choosing a client default and distinguishes pending confirmation', async () =>
    {
        const wrapper = open({ ...observation, profile: null, revision: null, status: 'loading' });
        expect(wrapper.findAllComponents(ElSelect).every(select => select.props('modelValue') === undefined)).toBe(true);
        expect(wrapper.get('form').attributes('aria-busy')).toBe('true');
        await wrapper.setProps({ view: { ...observation, status: 'saving' } });
        expect(wrapper.text()).toContain('正在保存偏好');
        expect(wrapper.text()).not.toContain('服务端已确认偏好');
        expect(wrapper.emitted('change')).toBeUndefined();
    });

    it('never reports malformed or absent observations as a confirmed save', async () =>
    {
        const wrapper = open({ ...observation, profile: null, revision: null, status: 'saved' });
        expect(wrapper.text()).not.toContain('服务端已确认偏好');
        expect(wrapper.text()).toContain('不能确认保存');
        await wrapper.setProps({ view: { ...observation, status: 'saved', revision: 1.5 } });
        expect(wrapper.text()).not.toContain('服务端已确认偏好');
        expect(wrapper.emitted('change')).toBeUndefined();
    });

    it.each(([
        ['permission denied', { permission: 'denied' }, '作者权限尚未确认'],
        ['permission denied before device/default', { permission: 'denied', device: 'unavailable', designDefault: 'unavailable' }, '作者权限尚未确认'],
        ['permission unavailable', { permission: 'unavailable', device: 'unavailable', designDefault: 'unavailable' }, '作者权限尚未确认'],
        ['device unavailable', { device: 'unavailable', designDefault: 'unavailable' }, '设备验证暂不可用'],
        ['default unavailable', { designDefault: 'unavailable' }, '当前默认排版尚未确认']
    ] as const).flatMap(([reason, denial, message]) => (['saved', 'current'] as const).map(status => [reason, status, denial, message] as const)))(
        'refuses false confirmation under %s for %s without changing denial priority or control guards', async (_reason, status, denial, message) =>
    {
        const wrapper = open({ ...observation, ...denial, status: 'saved', profile: null, revision: null });
        const invalidObservations = [
            { profile: null, revision: null },
            { profile: null, revision: 17 },
            { profile: { ...observation.profile!, schemaVersion: 2 } as unknown as AuthorTypographySettingsView['profile'], revision: 17 },
            { revision: null }, { revision: -1 }, { revision: 1.5 }, { revision: Number.NaN },
            { revision: Number.POSITIVE_INFINITY }, { revision: Number.MAX_SAFE_INTEGER + 1 }
        ];
        for (const invalid of invalidObservations)
        {
            await wrapper.setProps({ view: { ...observation, ...denial, ...invalid, status } });
            expect(wrapper.text()).not.toContain('服务端已确认偏好');
            expect(wrapper.text()).toContain('尚无已验证偏好，不能确认保存');
            expect(wrapper.text()).not.toContain('当前偏好版本');
            expect(wrapper.findAll('[role="status"]')[1].text()).toContain(message);
            expect(wrapper.getComponent(ElForm).props('disabled')).toBe(true);
            for (const select of wrapper.findAllComponents(ElSelect))
            {
                expect(select.get('input[role="combobox"]').attributes('disabled')).toBeDefined();
                select.vm.$emit('update:modelValue', 'standard');
            }
            const reset = wrapper.getComponent(ElButton);
            expect(reset.attributes('disabled')).toBeDefined();
            reset.vm.$emit('click', new MouseEvent('click'));
            expect(wrapper.emitted('change')).toBeUndefined();
            expect(wrapper.emitted('reset')).toBeUndefined();
            expect(wrapper.emitted('reload')).toBeUndefined();
        }
        for (const revision of [0, 17, Number.MAX_SAFE_INTEGER])
        {
            await wrapper.setProps({ view: { ...observation, ...denial, revision, status: 'saved' } });
            expect(wrapper.text()).toContain('服务端已确认偏好');
            expect(wrapper.text()).not.toContain('不能确认保存');
            expect(wrapper.findAll('[role="status"]')[1].text()).toContain(message);
            expect(wrapper.getComponent(ElForm).props('disabled')).toBe(true);
        }
    });

    it('distinguishes an exhausted valid revision from a missing observation', () =>
    {
        const wrapper = open({ ...observation, revision: Number.MAX_SAFE_INTEGER });
        expect(wrapper.text()).toContain('偏好版本已达上限');
        expect(wrapper.text()).not.toContain('尚无已验证的当前偏好');
        expect(wrapper.getComponent(ElForm).props('disabled')).toBe(true);
    });

    it.each(['conflict', 'unavailable'] as const)('offers only a fresh read intent after %s', async status =>
    {
        const wrapper = open({ ...observation, status });
        const reload = wrapper.findAll('button').find(button => button.text() === '重新读取偏好')!;
        await reload.trigger('click');
        expect(wrapper.emitted('reload')).toEqual([[]]);
        expect(wrapper.emitted('change')).toBeUndefined();
        expect(wrapper.emitted('reset')).toBeUndefined();
        await wrapper.setProps({ view: { ...observation, status, permission: 'denied' } });
        expect(reload.attributes('disabled')).toBeDefined();
        await reload.trigger('click');
        expect(wrapper.emitted('reload')).toHaveLength(1);
        wrapper.findAllComponents(ElButton)[1].vm.$emit('click', new MouseEvent('click'));
        expect(wrapper.emitted('reload')).toHaveLength(1);
    });

    it('keeps labels unique between two settings surfaces without creating a per-mode store', () =>
    {
        const parent = mount(defineComponent({
            setup: () => () => h('div', [h(AuthorTypographySettings, { view: observation }), h(AuthorTypographySettings, { view: observation })])
        }), { global: { components: { ElMarkdownRenderer, ...publicControls } } });
        try
        {
            const ids = parent.findAllComponents(ElSelect).map(select => select.props('id'));
            expect(new Set(ids).size).toBe(10);
        }
        finally { parent.unmount(); }
    });
});
