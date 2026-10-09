// @vitest-environment happy-dom

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as publicUi from '@ozwasyd/element-plus';

import type { AuditLogItemResponse, AuditLogListResponse, AuditLogSummaryResponse } from '@/api/authoring';
import {
    FsusUiTableV2FixedDir,
    FsusUiTableV2SortOrder,
    type FsusUiTableV2Column,
    type FsusUiTableV2SortState
} from '@/fsusui/tableV2';
import AuditLog from '@/views/admin/AuditLog.vue';

const api = vi.hoisted(() => ({
    listAuditLogs: vi.fn(),
    getAuditLogSummary: vi.fn(),
    getAuditLogDetail: vi.fn(),
    verifyAuditLog: vi.fn(),
    showErrorToast: vi.fn(),
    replace: vi.fn()
}));

vi.mock('@/api/authoring', () => api);
vi.mock('@/utils/errorPresentation', () => ({
    showErrorToast: api.showErrorToast,
    showWarningToast: vi.fn()
}));
vi.mock('vue-router', () => ({
    useRoute: () => ({ query: {} }),
    useRouter: () => ({ replace: api.replace })
}));

const runtime = {
    queuedCount: 0, droppedCount: 0, writeSuccessCount: 0, writeFailureCount: 0,
    fallbackWriteCount: 0, lastWriteSuccessUtc: null, lastWriteFailureUtc: null,
    lastFallbackWriteUtc: null
};
const row: AuditLogItemResponse = {
    id: 'audit-17', source: 'admin', type: 'operation', action: 'article.publish',
    outcome: 'success', severity: 'info', isHighValue: false,
    actorType: 'admin', actorId: '7', actorRole: null, targetType: 'article',
    targetId: '19', reasonCode: null, occurredAtUtc: '2026-10-09T08:00:00Z',
    eventInfo: 'Published article', traceId: null, requestPath: null, requestMethod: null,
    ipHash: null, userAgentHash: null, sessionIdHash: null, deviceFingerprintHash: null,
    chainId: null, prevHash: null, recordHash: null, recordMac: null, piiMode: 'pii-redacted'
};
const summary: AuditLogSummaryResponse = {
    total: 1, sources: [], actions: [], outcomes: [], severities: [], runtime
};
const list = (items: AuditLogItemResponse[], nextCursor: string | null = null): AuditLogListResponse => ({
    items, total: items.length, page: 1, pageSize: 50, nextCursor, runtime
});

// happy-dom has no measured layout; provide viewport dimensions while retaining
// the genuine public TableV2 renderer and responsive collection.
const measuredViewport = defineComponent({
    setup(_props, { slots }) {
        return () => slots.default?.({ width: 1220, height: 400 });
    }
});
const wrappers: VueWrapper[] = [];
const mountAudit = () => {
    const wrapper = mount(AuditLog, {
        global: {
            components: {
                ElButton: publicUi.ElButton,
                ElDatePicker: publicUi.ElDatePicker,
                ElDescriptions: publicUi.ElDescriptions,
                ElDescriptionsItem: publicUi.ElDescriptionsItem,
                ElDrawer: publicUi.ElDrawer,
                ElInput: publicUi.ElInput,
                ElOption: publicUi.ElOption,
                ElPagination: publicUi.ElPagination,
                ElResponsiveCollection: publicUi.ElResponsiveCollection,
                ElSelect: publicUi.ElSelect,
                ElSkeleton: publicUi.ElSkeleton,
                ElTableV2: publicUi.ElTableV2,
                ElTag: publicUi.ElTag,
                ElTooltip: publicUi.ElTooltip
            },
            stubs: { ElAutoResizer: measuredViewport },
            directives: { loading: publicUi.ElLoading.directive }
        }
    });
    wrappers.push(wrapper);
    return wrapper;
};

beforeEach(() => {
    vi.resetAllMocks();
    api.listAuditLogs.mockResolvedValue(list([row]));
    api.getAuditLogSummary.mockResolvedValue(summary);
    api.getAuditLogDetail.mockResolvedValue({ item: row, contextJson: '{}', tamperEvidenceValid: true });
});
afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe('audit log public TableV2 consumer repair', () => {
    it('preserves the public enum identity, fixed detail renderer, row key and server order', async () => {
        expect(FsusUiTableV2FixedDir).toBe(publicUi.TableV2FixedDir);
        expect(FsusUiTableV2SortOrder).toBe(publicUi.TableV2SortOrder);
        const rows = [row, { ...row, id: 'audit-18', occurredAtUtc: '2026-10-09T09:00:00Z' }];
        api.listAuditLogs.mockResolvedValue(list(rows));
        const wrapper = mountAudit();
        await flushPromises();
        const table = wrapper.getComponent(publicUi.ElTableV2);
        const columns = table.props('columns');
        expect(columns.map((column: FsusUiTableV2Column<AuditLogItemResponse>) => column.key)).toEqual([
            'occurredAt', 'action', 'actor', 'target', 'outcome', 'evidence', 'detail'
        ]);
        expect(columns.at(-1)).toMatchObject({ key: 'detail', fixed: FsusUiTableV2FixedDir.RIGHT, align: 'right', width: 110 });
        expect(columns.every((column: FsusUiTableV2Column<AuditLogItemResponse>) => !column.sortable)).toBe(true);
        expect(table.props('rowKey')).toBe('id');
        expect(table.props('data')).toEqual(rows);
        const detailAction = wrapper.get('.el-table-v2__right .audit-table-action');
        expect(detailAction.text()).toBe('查看');
        await detailAction.trigger('click');
        await flushPromises();
        expect(api.getAuditLogDetail).toHaveBeenCalledExactlyOnceWith(row.id);
    });

    it('preserves genuine public sorting events and the right fixed action with typed sort state', async () => {
        const columns: FsusUiTableV2Column<AuditLogItemResponse>[] = [
            { key: 'action', dataKey: 'action', title: '动作', width: 300, sortable: true },
            { key: 'detail', title: '详情', width: 110, fixed: FsusUiTableV2FixedDir.RIGHT,
                cellRenderer: () => h('button', { class: 'detail-probe' }, '查看') }
        ];
        const sortState: FsusUiTableV2SortState = { action: FsusUiTableV2SortOrder.ASC };
        const sorted = vi.fn();
        const wrapper = mount(publicUi.ElTableV2, {
            props: { columns, data: [row], rowKey: 'id', width: 800, height: 300, sortState, onColumnSort: sorted }
        });
        wrappers.push(wrapper);
        await nextTick();
        await wrapper.get('.el-table-v2__header-cell[data-key="action"]').trigger('click');
        expect(sorted).toHaveBeenCalledExactlyOnceWith({ column: columns[0], key: 'action', order: FsusUiTableV2SortOrder.DESC });
        expect(wrapper.get('.el-table-v2__right .detail-probe').text()).toBe('查看');
        expect(wrapper.props('data')).toEqual([row]);
    });

    it('keeps initial loading, then renders the ordinary empty state', async () => {
        let resolveList!: (value: AuditLogListResponse) => void;
        api.listAuditLogs.mockReturnValue(new Promise<AuditLogListResponse>((resolve) => { resolveList = resolve; }));
        const wrapper = mountAudit();
        await nextTick();
        expect(wrapper.get('[aria-busy="true"]').exists()).toBe(true);
        expect(wrapper.findComponent(publicUi.ElTableV2).exists()).toBe(false);
        resolveList(list([]));
        await flushPromises();
        expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false);
        expect(wrapper.text()).toContain('暂无审计日志');
        expect(wrapper.text()).toContain('刷新审计日志');
    });

    it('keeps existing rows and reports refresh errors without leaving loading active', async () => {
        const wrapper = mountAudit();
        await flushPromises();
        const error = new Error('ordinary renderer refresh failure');
        api.listAuditLogs.mockRejectedValueOnce(error);
        const refresh = wrapper.findAllComponents(publicUi.ElButton).find((button) => button.text() === '刷新');
        expect(refresh).toBeDefined();
        await refresh!.trigger('click');
        await flushPromises();
        expect(api.showErrorToast).toHaveBeenCalledWith(error, '审计日志加载失败');
        expect(wrapper.getComponent(publicUi.ElTableV2).props('data')).toEqual([row]);
        expect(refresh!.props('loading')).toBe(false);
        expect(wrapper.get('.el-table-v2__right .audit-table-action').text()).toBe('查看');
    });

    it('preserves filter values and cursor pagination through the existing controls', async () => {
        api.listAuditLogs.mockResolvedValue(list([row], 'next-page-token'));
        const wrapper = mountAudit();
        await flushPromises();
        await wrapper.get('input[aria-label="操作者"]').setValue(' admin:7 ');
        const query = wrapper.findAllComponents(publicUi.ElButton).find((button) => button.text() === '查询');
        expect(query).toBeDefined();
        await query!.trigger('click');
        await flushPromises();
        expect(api.listAuditLogs.mock.calls.at(-1)?.[0]).toMatchObject({ actor: 'admin:7', page: 1, cursor: null, pageSize: 50 });
        const pagination = wrapper.getComponent(publicUi.ElPagination);
        pagination.vm.$emit('update:current-page', 2);
        pagination.vm.$emit('current-change', 2);
        await flushPromises();
        expect(api.listAuditLogs.mock.calls.at(-1)?.[0]).toMatchObject({ actor: 'admin:7', page: 2, cursor: 'next-page-token', pageSize: 50 });
        expect(api.getAuditLogSummary.mock.calls.at(-1)?.[0]).toEqual(api.listAuditLogs.mock.calls.at(-1)?.[0]);
    });
});
