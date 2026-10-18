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
        classifyFailure: (error) => error === 'revoked' ? 'permission-revoked' : 'uncertain',
    };
}

const drawer = defineComponent({
    name: 'ElDrawer', props: ['modelValue'], emits: ['update:modelValue'],
    setup: (_props, { slots }) => () => h('section', slots.default?.()),
});
const table = defineComponent({
    name: 'ElTableV2', props: ['data', 'columns', 'rowKey'],
    setup: (props) => () => h('div', (props.data as DocumentExportPresentation[]).map((rowData) =>
        (props.columns as { cellRenderer: (data: { rowData: DocumentExportPresentation }) => ReturnType<typeof h> }[])[0]!.cellRenderer({ rowData }))),
});
const resizer = defineComponent({
    name: 'ElAutoResizer', setup: (_props, { slots }) => () => slots.default?.({ width: 600, height: 300 }),
});

function mountCenter(port = createPort()) {
    const wrapper = shallowMount(ExportCenter<DocumentExportPresentation, unknown>, {
        props: { visible: true, identity: 'user/site/session', port },
        attachTo: document.body,
        slots: { 'markdown-package': '<a href="/existing-package-entry">Markdown package</a>' },
        global: { renderStubDefaultSlot: true, stubs: { ElDrawer: drawer, ElAutoResizer: resizer, ElTableV2: table } },
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
    it.each([0, 1, 100, 1000])('renders at most twenty of %i task rows and pages through the authority', async (count) => {
        const port = createPort();
        const roster = Array.from({ length: count }, (_, index) => ({ ...snapshot, taskId: `task-${index}`, source: `coordinate-${index}`, status: 7 }));
        port.list = vi.fn(async (offset, limit) => roster.slice(offset, offset + limit));
        const { wrapper } = mountCenter(port);
        await flushPromises();
        if (count === 0) {
            expect(wrapper.text()).toContain('本页暂无可用任务');
            expect(wrapper.findComponent({ name: 'ElTableV2' }).exists()).toBe(false);
        } else {
            expect(wrapper.findComponent({ name: 'ElTableV2' }).props('data')).toHaveLength(Math.min(20, count));
        }
        if (count >= 100) {
            await wrapper.findAll('el-button-stub').find((button) => button.text() === '下一页')!.trigger('click');
            await flushPromises();
            expect(port.list).toHaveBeenLastCalledWith(20, 20);
            expect(wrapper.findComponent({ name: 'ElTableV2' }).props('data')[0].taskId).toBe('task-20');
            expect(wrapper.text()).toContain('第 2 页，本页 20 项');
        }
    });

    it('focuses details and returns focus to tasks when uniform denial removes private content', async () => {
        const { wrapper, port } = mountCenter();
        await flushPromises();
        await wrapper.find('[aria-label^="查看 specified"]').trigger('click');
        await flushPromises();
        expect(document.activeElement).toBe(wrapper.find('#document-export-detail').element);
        port.status = vi.fn().mockRejectedValue('revoked');
        await wrapper.findAll('el-button-stub').find((button) => button.text() === '核实状态')!.trigger('click');
        await flushPromises();
        expect(wrapper.find('[data-export-task]').exists()).toBe(false);
        expect(wrapper.text()).toContain('权限已失效或任务不可用，当前私密视图已清除');
        expect(wrapper.find('form').exists()).toBe(false);
        expect(document.activeElement).toBe(wrapper.find('#document-export-tasks').element);
        // Source picker labels stay public; frozen private row/detail content disappears.
        expect(wrapper.find('[aria-label^="查看 specified"]').exists()).toBe(false);
        expect(port.delete).not.toHaveBeenCalled();
    });

    it('announces deterministic cancellation rejection without changing the running receipt', async () => {
        const { wrapper, port } = mountCenter();
        await flushPromises();
        await wrapper.find('[aria-label^="查看 specified"]').trigger('click');
        await flushPromises();
        port.cancel = vi.fn().mockRejectedValue(new Error('private backend exception details'));
        port.classifyFailure = () => 'rejected';
        await wrapper.findAll('el-button-stub').find((button) => button.text() === '取消任务')!.trigger('click');
        await flushPromises();
        const feedback = wrapper.findAll('[role="status"]').find((node) => node.text().includes('取消任务请求被拒绝'));
        expect(feedback).toBeDefined();
        expect(feedback!.attributes('aria-live')).toBe('polite');
        expect(feedback!.attributes('aria-atomic')).toBe('true');
        expect(wrapper.find('[data-export-status]').attributes('data-export-status')).toBe('3');
        expect(wrapper.find('[data-export-receipt-digest]').attributes('data-export-receipt-digest')).toBe(snapshot.contentDigest);
        expect(wrapper.text()).toContain('正在导出');
        expect(wrapper.text()).not.toContain('已取消');
        expect(wrapper.text()).not.toContain('private backend exception details');
        expect(wrapper.text()).not.toContain('操作结果待核实');
        expect(port.cancel).toHaveBeenCalledTimes(1);
        expect(port.status).not.toHaveBeenCalled();
        expect(wrapper.findAll('el-button-stub').find((button) => button.text() === '取消任务')!.attributes('disabled')).toBe('false');

        port.status = vi.fn().mockResolvedValue(snapshot);
        await wrapper.findAll('el-button-stub').find((button) => button.text() === '核实状态')!.trigger('click');
        await flushPromises();
        expect(wrapper.text()).not.toContain('取消任务请求被拒绝');
        expect(port.status).toHaveBeenCalledWith(snapshot.taskId);
        expect(wrapper.find('[data-export-status]').attributes('data-export-status')).toBe('3');
    });

    it('shows no refusal while cancellation is pending or after its actual response confirms cancelling', async () => {
        const { wrapper, port } = mountCenter();
        await flushPromises();
        await wrapper.find('[aria-label^="查看 specified"]').trigger('click');
        await flushPromises();
        let finish!: (response: DocumentExportPresentation) => void;
        port.cancel = vi.fn(() => new Promise<DocumentExportPresentation>((resolve) => { finish = resolve; }));
        await wrapper.findAll('el-button-stub').find((button) => button.text() === '取消任务')!.trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('等待服务器确认');
        expect(wrapper.text()).not.toContain('取消任务请求被拒绝');
        expect(wrapper.find('[data-export-status]').attributes('data-export-status')).toBe('3');
        expect(wrapper.findAll('el-button-stub').find((button) => button.text() === '取消任务')!.attributes('disabled')).toBe('true');
        const confirmed = { ...snapshot, version: 2, status: 4 };
        port.list = vi.fn().mockResolvedValue([confirmed]);
        finish(confirmed);
        await flushPromises();
        expect(wrapper.find('[data-export-status]').attributes('data-export-status')).toBe('4');
        expect(wrapper.text()).toContain('正在取消');
        expect(wrapper.text()).not.toContain('取消任务请求被拒绝');
        expect(wrapper.text()).not.toContain('等待服务器确认');
        expect(wrapper.text()).not.toContain('已取消');
        expect(port.cancel).toHaveBeenCalledTimes(1);
    });

    it('keeps uncertain operation recovery visible after its task leaves the page', async () => {
        const { wrapper, port } = mountCenter();
        await flushPromises();
        await wrapper.find('[aria-label^="查看 specified"]').trigger('click');
        port.cancel = vi.fn().mockRejectedValue('response-lost');
        await wrapper.findAll('el-button-stub').find((button) => button.text() === '取消任务')!.trigger('click');
        await flushPromises();
        port.list = vi.fn().mockResolvedValue([]);
        await wrapper.findAll('el-button-stub').find((button) => button.text() === '刷新任务')!.trigger('click');
        await flushPromises();
        expect(wrapper.find('[data-export-task]').exists()).toBe(false);
        expect(wrapper.text()).toContain('操作结果待核实，未确认取消、删除或下载完成');
        await wrapper.findAll('el-button-stub').find((button) => button.text() === '核实任务')!.trigger('click');
        await flushPromises();
        expect(port.status).toHaveBeenCalledWith('fixture-task');
        expect(port.cancel).toHaveBeenCalledTimes(1);
        expect(wrapper.text()).not.toContain('操作结果待核实');
    });

    it('offers cleanup of revoked output while reporting the actual unresolved receipt', async () => {
        const port = createPort();
        const receipt = { ...snapshot, status: 10, reason: 'cleanup-required', output: { filename: null, bytes: 0, mediaType: 'application/pdf', expiresAt: '2001-01-01', deleted: true } };
        port.list = vi.fn().mockResolvedValue([receipt]);
        port.delete = vi.fn().mockResolvedValue({ ...receipt, version: 2 });
        const { wrapper } = mountCenter(port);
        await flushPromises();
        await wrapper.find('[aria-label^="查看 specified"]').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('下载授权已撤销；清理状态见任务状态');
        expect(wrapper.findAll('el-button-stub').find((button) => button.text() === '授权下载')!.attributes('disabled')).toBe('true');
        await wrapper.findAll('el-button-stub').find((button) => button.text() === '请求清理')!.trigger('click');
        await flushPromises();
        expect(port.delete).toHaveBeenCalledWith('fixture-task');
        expect(wrapper.find('[data-export-status]').attributes('data-export-status')).toBe('10');
        expect(wrapper.text()).not.toContain('已删除');
    });

    it('queries the new identity and rejects old rows after a delayed old list completes', async () => {
        const port = createPort();
        let finish!: (page: readonly DocumentExportPresentation[]) => void;
        port.list = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
            .mockResolvedValue([{ ...snapshot, taskId: 'new-task', source: 'new user/site coordinate' }]);
        const { wrapper } = mountCenter(port);
        await wrapper.setProps({ identity: 'new-user/new-site/new-session' });
        await flushPromises();
        finish([{ ...snapshot, source: 'private old user coordinate' }]);
        await flushPromises();
        expect(wrapper.text()).toContain('new user/site coordinate');
        expect(wrapper.text()).not.toContain('private old user coordinate');
        expect(port.cancel).not.toHaveBeenCalled();
    });

    it('does not steal focus from outside the removed detail', async () => {
        const { wrapper, port } = mountCenter();
        await flushPromises();
        await wrapper.find('[aria-label^="查看 specified"]').trigger('click');
        await flushPromises();
        const outside = document.createElement('button');
        document.body.append(outside);
        disposals.push(() => outside.remove());
        outside.focus();
        port.list = vi.fn().mockRejectedValue('revoked');
        await wrapper.findAll('el-button-stub').find((button) => button.text() === '刷新任务')!.trigger('click');
        await flushPromises();
        expect(wrapper.find('[data-export-task]').exists()).toBe(false);
        expect(document.activeElement).toBe(outside);
    });

    it('does not overwrite a new focus target between removal and the queued fallback', async () => {
        const { wrapper, port } = mountCenter();
        await flushPromises();
        await wrapper.find('[aria-label^="查看 specified"]').trigger('click');
        await flushPromises();
        const outside = document.createElement('button');
        document.body.append(outside);
        disposals.push(() => outside.remove());
        port.list = vi.fn().mockResolvedValue([]);
        const update = wrapper.setProps({ identity: 'new-context' });
        await Promise.resolve();
        outside.focus();
        await update;
        await flushPromises();
        expect(document.activeElement).toBe(outside);
    });

    it('restores tasks focus after denied admission removes the focused private form', async () => {
        const { wrapper, port } = mountCenter();
        await flushPromises();
        const selects = () => wrapper.findAllComponents({ name: 'ElSelect' });
        selects()[0]!.vm.$emit('update:modelValue', 'draft-v12');
        wrapper.findComponent({ name: 'ElRadioGroup' }).vm.$emit('update:modelValue', 'pdf');
        await flushPromises();
        selects()[1]!.vm.$emit('update:modelValue', 'reading');
        selects()[2]!.vm.$emit('update:modelValue', 'light');
        await flushPromises();
        wrapper.findComponent({ name: 'ElCheckbox' }).vm.$emit('update:modelValue', true);
        await flushPromises();
        // The shallow ElButton stub is not a native focusable control.
        const submit = document.createElement('button');
        wrapper.find('form').element.append(submit);
        submit.focus();
        expect(document.activeElement).toBe(submit);
        port.request = vi.fn().mockRejectedValue('revoked');
        await wrapper.find('form').trigger('submit');
        await flushPromises();
        expect(wrapper.find('form').exists()).toBe(false);
        expect(wrapper.find('[data-export-task]').exists()).toBe(false);
        expect(document.activeElement).toBe(wrapper.find('#document-export-tasks').element);
    });

});


describe('exact output size presentation', () => {
    it('renders an authorized cleanup receipt size without converting it to Number', async () => {
        const port = createPort();
        const receipt = { ...snapshot, version: '9223372036854775807', status: 10, output: { filename: null, bytes: '9223372036854775807', mediaType: 'application/pdf', expiresAt: '2001-01-01', deleted: true } };
        port.list = vi.fn().mockResolvedValue([receipt]);
        const { wrapper } = mountCenter(port);
        await flushPromises();
        await wrapper.find('[aria-label^="查看 specified"]').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('9223372036854775807 bytes');
        expect(wrapper.text()).not.toContain('9223372036854776000');
        expect(port.download).not.toHaveBeenCalled();
    });
});
