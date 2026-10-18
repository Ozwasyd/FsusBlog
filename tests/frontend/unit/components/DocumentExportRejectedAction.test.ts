// @vitest-environment happy-dom
// Ordinary controlled component reproduction; no provider, receipt or transport qualification.
import { defineComponent, h } from 'vue';
import { flushPromises, shallowMount } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';

import ExportCenter from '@/views/admin/article/ExportCenter.vue';
import type {
    DocumentExportPresentation,
    DocumentExportUiPort,
} from '@/components/document-export/documentExportUiPort';

it('must announce a definite rejected cancel operation', async () => {
    const task: DocumentExportPresentation = {
        taskId: 'controlled-task',
        version: 1,
        status: 3,
        source: 'revision 17',
        format: 'PDF',
        provider: 'controlled',
        options: 'reading/light',
        inputDigest: 'controlled-input',
        contentDigest: 'controlled-task',
        reason: '',
        warnings: null,
        diagnostic: false,
        output: null,
    };

    const port: DocumentExportUiPort<DocumentExportPresentation, unknown> = {
        catalog: [],
        sources: [],
        prepareRequest: x => x,
        captureRequest: x => x,
        request: vi.fn(),
        list: vi.fn(async () => [task]),
        status: vi.fn(async () => task),
        cancel: vi.fn(async () => {
            throw new Error('controlled definite rejection');
        }),
        retry: vi.fn(),
        delete: vi.fn(),
        download: vi.fn(),
        inspect: x => x,
        classifyFailure: () => 'rejected',
    };

    const drawer = defineComponent({
        setup: (_, { slots }) => () => h('section', slots.default?.()),
    });
    const resizer = defineComponent({
        setup: (_, { slots }) =>
            () => slots.default?.({ width: 600, height: 300 }),
    });
    const table = defineComponent({
        props: ['data', 'columns'],
        setup: props => () => h(
            'div',
            (props.data as DocumentExportPresentation[]).map(
                rowData => props.columns[0].cellRenderer({ rowData }),
            ),
        ),
    });

    const wrapper = shallowMount(ExportCenter<DocumentExportPresentation, unknown>, {
        props: {
            visible: true,
            identity: 'controlled-user/site/session',
            port,
        },
        global: {
            renderStubDefaultSlot: true,
            stubs: {
                ElDrawer: drawer,
                ElAutoResizer: resizer,
                ElTableV2: table,
            },
        },
    });

    try {
        await flushPromises();
        await wrapper.find('[aria-label^="查看 revision"]').trigger('click');
        await flushPromises();

        await wrapper.findAll('el-button-stub')
            .find(x => x.text() === '取消任务')!
            .trigger('click');
        await flushPromises();

        expect(port.cancel).toHaveBeenCalledOnce();
        expect(
            wrapper.find('[data-export-status]')
                .attributes('data-export-status'),
        ).toBe('3');

        // It must give a visible, accessible error for the operation that failed.
        expect(
            wrapper.findAll('[role="status"], [role="alert"]')
                .some(x => /拒绝|失败|不可用/.test(x.text())),
        ).toBe(true);
    } finally {
        wrapper.unmount();
    }
});
