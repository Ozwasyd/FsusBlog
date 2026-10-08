// @vitest-environment happy-dom

import { defineComponent, h } from 'vue';

import { flushPromises, shallowMount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DocumentExportPresentation, DocumentExportUiPort } from '@/components/document-export/documentExportUiPort';
import ExportCenter from '@/views/admin/article/ExportCenter.vue';

const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach((dispose) => dispose()); });
const snapshot: DocumentExportPresentation = {
    taskId: 'fixture-task', version: 1, status: 3, source: 'specified revision 12',
    format: 'PDF', provider: 'canonical-pdf', options: 'reading/light', inputDigest: 'fixture-input',
    contentDigest: 'fixture-digest', reason: '', warnings: null, diagnostic: false, output: null,
};

function createPort(): DocumentExportUiPort<DocumentExportPresentation, unknown> {
    return {
        sources: [{ id: 'draft-v12', label: 'current draft version 12', private: true }, { id: 'revision-12', label: 'specified revision 12', private: true }, { id: 'publication-7', label: 'published coordinate 7', private: false }],
        catalog: ['self-contained-html', 'pdf', 'docx', 'epub'].map((id) => ({
            id, label: id, providerId: `canonical-${id}`, available: id !== 'epub', reason: id === 'epub' ? 'provider unavailable' : '', layouts: ['reading'], themes: ['light'], support: ['mermaid: explicit warning'],
        })),
        prepareRequest: (selection) => Object.freeze({ ...selection }),
        captureRequest: (request) => request,
        request: vi.fn().mockResolvedValue(snapshot), list: vi.fn().mockResolvedValue([snapshot]),
        status: vi.fn().mockResolvedValue(snapshot), cancel: vi.fn().mockResolvedValue({ ...snapshot, version: 2, status: 4 }),
        retry: vi.fn().mockResolvedValue(snapshot), delete: vi.fn().mockResolvedValue(snapshot),
        download: vi.fn().mockResolvedValue(undefined), inspect: (value) => value,
        classifyFailure: () => 'uncertain',
    };
}

const drawer = defineComponent({
    name: 'ElDrawer', props: ['modelValue'], emits: ['update:modelValue'],
    setup: (_props, { slots }) => () => h('section', slots.default?.()),
});
const resizer = defineComponent({
    name: 'ElAutoResizer', setup: (_props, { slots }) => () => slots.default?.({ width: 600, height: 300 }),
});

function mountCenter(port = createPort()) {
    const wrapper = shallowMount(ExportCenter, {
        props: { visible: true, identity: 'user/site/session', port },
        slots: { 'markdown-package': '<a href="/existing-package-entry">Markdown package</a>' },
        global: { renderStubDefaultSlot: true, stubs: { ElDrawer: drawer, ElAutoResizer: resizer } },
    });
    disposals.push(() => wrapper.unmount());
    return { wrapper, port };
}

describe('export center product composition', () => {
    it('shows all four compact choices, explicit coordinates, limits and independent package entry', async () => {
        const { wrapper } = mountCenter();
        await flushPromises();
        expect(wrapper.findAll('el-radio-stub')).toHaveLength(4);
        expect(wrapper.findAll('el-option-stub').map((node) => node.attributes('label'))).toEqual(['current draft version 12', 'specified revision 12', 'published coordinate 7']);
        expect(wrapper.text()).toContain('provider unavailable');
        expect(wrapper.find('[aria-label="Markdown package"]').text()).toBe('Markdown package');
        const table = wrapper.findComponent({ name: 'ElTableV2' });
        expect(table.props('data')).toHaveLength(1);
        expect(table.props('rowKey')).toBe('taskId');
        expect(wrapper.find('form').find('el-button-stub').attributes('disabled')).toBe('true');
    });

    it('requires source/closed options confirmation and freezes the submitted selection', async () => {
        const { wrapper, port } = mountCenter();
        const selects = () => wrapper.findAllComponents({ name: 'ElSelect' });
        selects()[0]!.vm.$emit('update:modelValue', 'draft-v12');
        wrapper.findComponent({ name: 'ElRadioGroup' }).vm.$emit('update:modelValue', 'pdf');
        await flushPromises();
        expect(wrapper.text()).toContain('结果含私密内容，仅短期保留，未自动加密');
        selects()[1]!.vm.$emit('update:modelValue', 'reading');
        selects()[2]!.vm.$emit('update:modelValue', 'light');
        await flushPromises();
        await wrapper.find('form').trigger('submit');
        expect(port.request).not.toHaveBeenCalled();
        wrapper.findComponent({ name: 'ElCheckbox' }).vm.$emit('update:modelValue', true);
        await flushPromises();
        await wrapper.find('form').trigger('submit');
        await flushPromises();
        expect(port.request).toHaveBeenCalledWith({ sourceId: 'draft-v12', formatId: 'pdf', layout: 'reading', theme: 'light' });
        await wrapper.setProps({ visible: false });
        expect(port.cancel).not.toHaveBeenCalled();
    });
});
