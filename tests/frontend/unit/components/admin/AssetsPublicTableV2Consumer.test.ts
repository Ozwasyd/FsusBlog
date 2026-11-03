// @vitest-environment happy-dom

import {
    ElAutoResizer,
    ElButton,
    ElCheckbox,
    ElForm,
    ElFormItem,
    ElInput,
    ElLoading,
    ElResponsiveCollection,
    ElSkeleton,
    ElTableV2,
    ElTag
} from '@ozwasyd/element-plus';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssetLibraryItemResponse } from '@/api/authoring';
import { FsusUiTableV2FixedDir, FsusUiTableV2SortOrder } from '@/fsusui/tableV2';
import Assets from '@/views/admin/Assets.vue';

const mocks = vi.hoisted(() => ({
    list: vi.fn(),
    reindex: vi.fn(),
    cleanup: vi.fn(),
    deleteImage: vi.fn(),
    confirm: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
}));

vi.mock('@/api/authoring', () => ({
    listAssetLibrary: mocks.list,
    reindexArticleAssets: mocks.reindex,
    cleanupOrphanAssets: mocks.cleanup
}));
vi.mock('@/api/system', () => ({ deleteImage: mocks.deleteImage }));
vi.mock('@/fsusui/feedback', () => ({
    confirmDanger: mocks.confirm,
    toast: { success: mocks.success }
}));
vi.mock('@/utils/errorPresentation', () => ({
    showErrorToast: mocks.error,
    showWarningToast: mocks.warning
}));

const rows: AssetLibraryItemResponse[] = [
    {
        id: '00000000-0000-0000-0000-000000000001',
        url: '/uploads/illustration/referenced.png',
        altText: null,
        sourceArticleId: 42,
        referenceCount: 4,
        sha256: 'ABC123',
        updatedAt: '2026-10-09T00:00:00Z'
    },
    {
        id: '00000000-0000-0000-0000-000000000002',
        url: '/uploads/illustration/orphan.png',
        altText: null,
        sourceArticleId: null,
        referenceCount: 0,
        sha256: null,
        updatedAt: '2026-10-08T00:00:00Z'
    },
    {
        id: '00000000-0000-0000-0000-000000000003',
        url: '/uploads/illustration/other.png',
        altText: null,
        sourceArticleId: 43,
        referenceCount: 2,
        sha256: 'DEF456',
        updatedAt: '2026-10-07T00:00:00Z'
    }
];

// Supply deterministic browser geometry while keeping the real AutoResizer and table.
class AssetResizeObserver implements ResizeObserver
{
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback)
    {
        this.callback = callback;
    }

    observe(target: Element): void
    {
        this.callback([{
            target,
            contentRect: new DOMRectReadOnly(0, 0, 800, 420),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: []
        }], this);
    }

    unobserve(): void {}

    disconnect(): void {}
}

let compact = false;
let wrapper: VueWrapper | undefined;

function mountAssets(): VueWrapper
{
    wrapper = mount(Assets, {
        attachTo: document.body,
        global: {
            components: {
                ElAutoResizer,
                ElButton,
                ElCheckbox,
                ElForm,
                ElFormItem,
                ElInput,
                ElResponsiveCollection,
                ElSkeleton,
                ElTableV2,
                ElTag
            },
            directives: { loading: ElLoading.directive }
        }
    });
    return wrapper;
}

beforeEach(() =>
{
    vi.clearAllMocks();
    compact = false;
    mocks.list.mockResolvedValue(rows);
    mocks.confirm.mockResolvedValue({ kind: 'cancelled' });
    mocks.deleteImage.mockResolvedValue(undefined);
    mocks.reindex.mockResolvedValue([]);
    mocks.cleanup.mockResolvedValue(1);
    vi.spyOn(window, 'ResizeObserver').mockImplementation(function (callback: ResizeObserverCallback)
    {
        return new AssetResizeObserver(callback);
    });
    vi.stubGlobal('ResizeObserver', window.ResizeObserver);
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
        matches: compact && query === '(max-width: 767px)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: () => true
    }));
});

afterEach(() =>
{
    wrapper?.unmount();
    wrapper = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('Assets ordinary public TableV2 consumer', () =>
{
    it('renders the original columns and delete controls in the real right-fixed table', async () =>
    {
        const view = mountAssets();
        await flushPromises();
        const table = view.getComponent(ElTableV2);
        expect(view.findComponent(ElAutoResizer).exists()).toBe(true);
        expect(table.props('width')).toBe(800);
        expect(table.props('height')).toBe(420);
        expect(table.props('rowKey')).toBe('id');
        expect(table.props('rowHeight')).toBe(72);
        expect(table.props('columns')).toEqual([
            { key: 'id', dataKey: 'id', title: 'ID', width: 96, align: 'center' },
            { key: 'file', dataKey: 'url', title: '文件', width: 420 },
            { key: 'referenceCount', dataKey: 'referenceCount', title: '引用', width: 120, align: 'center', sortable: true },
            { key: 'sourceArticleId', dataKey: 'sourceArticleId', title: '来源文章', width: 130, align: 'center' },
            { key: 'updatedAt', dataKey: 'updatedAt', title: '更新时间', width: 190 },
            { key: 'actions', title: '管理', width: 150, align: 'right', fixed: FsusUiTableV2FixedDir.RIGHT }
        ]);
        const right = table.get('.el-table-v2__right');
        expect(right.get('[role="columnheader"]').text()).toBe('管理');
        expect(right.findAll('button').map((button) => button.text())).toEqual(rows.map(() => '删除文件'));
        expect(table.find('.el-table-v2__left').exists()).toBe(false);
        expect(table.get('.el-table-v2__main').findAll('button')).toHaveLength(0);
        expect(table.findAll('a').map((link) => link.attributes('href'))).toEqual(rows.map((row) => row.url));
    });

    it('sorts through the real header, toggles direction and ignores unrelated column events', async () =>
    {
        const view = mountAssets();
        await flushPromises();
        const table = view.getComponent(ElTableV2);
        const header = table.get('[role="columnheader"][data-key="referenceCount"]');
        await header.trigger('click');
        expect(table.props('sortState')).toEqual({ referenceCount: FsusUiTableV2SortOrder.ASC });
        expect(table.props('data')).toEqual([rows[1], rows[2], rows[0]]);
        await header.trigger('click');
        expect(table.props('sortState')).toEqual({ referenceCount: FsusUiTableV2SortOrder.DESC });
        expect(table.props('data')).toEqual([rows[0], rows[2], rows[1]]);
        table.vm.$emit('column-sort', { key: 'id', order: FsusUiTableV2SortOrder.ASC });
        await flushPromises();
        expect(table.props('data')).toEqual([rows[0], rows[2], rows[1]]);
        table.vm.$emit('column-sort', { key: 'referenceCount' });
        await flushPromises();
        expect(table.props('sortState')).toEqual({ referenceCount: FsusUiTableV2SortOrder.ASC });
    });

    it('keeps URL/SHA filtering, orphan filtering and the filtered empty reset action', async () =>
    {
        const view = mountAssets();
        await flushPromises();
        const search = view.get<HTMLInputElement>('input[aria-label="搜索资产"]');
        await search.setValue(' abc123 ');
        expect(view.getComponent(ElTableV2).props('data')).toEqual([rows[0]]);
        await search.setValue('ORPHAN.PNG');
        expect(view.getComponent(ElTableV2).props('data')).toEqual([rows[1]]);
        await search.setValue('');
        await view.getComponent(ElCheckbox).get('input').setValue(true);
        expect(view.getComponent(ElTableV2).props('data')).toEqual([rows[1]]);
        await search.setValue('missing');
        expect(view.text()).toContain('没有匹配的资产');
        const reset = view.findAllComponents(ElButton).find((button) => button.text() === '清除筛选');
        expect(reset).toBeDefined();
        await reset?.trigger('click');
        expect(view.getComponent(ElTableV2).props('data')).toEqual(rows);
        expect(search.element.value).toBe('');
    });

    it('preserves the initial skeleton and the unfiltered empty refresh state', async () =>
    {
        let resolveList!: (items: AssetLibraryItemResponse[]) => void;
        mocks.list.mockReturnValueOnce(new Promise<AssetLibraryItemResponse[]>((resolve) =>
        {
            resolveList = resolve;
        }));
        const view = mountAssets();
        await view.vm.$nextTick();
        expect(view.findComponent(ElSkeleton).exists()).toBe(true);
        expect(view.get('[aria-busy="true"]').attributes('aria-busy')).toBe('true');
        expect(view.findComponent(ElTableV2).exists()).toBe(false);
        resolveList([]);
        await flushPromises();
        expect(view.text()).toContain('资产库暂无文件');
        const refresh = view.findAllComponents(ElButton).find((button) => button.text() === '刷新资产库');
        expect(refresh).toBeDefined();
        await refresh?.trigger('click');
        await flushPromises();
        expect(mocks.list).toHaveBeenCalledTimes(2);
        expect(view.getComponent(ElTableV2).props('data')).toEqual(rows);
    });

    it('reports a failed refresh while retaining the current rows and clearing loading', async () =>
    {
        const view = mountAssets();
        await flushPromises();
        const failure = new Error('ordinary fixture read failed');
        mocks.list.mockRejectedValueOnce(failure);
        const refresh = view.findAllComponents(ElButton).find((button) => button.text() === '刷新');
        expect(refresh).toBeDefined();
        await refresh?.trigger('click');
        await flushPromises();
        expect(mocks.error).toHaveBeenCalledWith(failure, '资产库同步失败');
        expect(view.getComponent(ElTableV2).props('data')).toEqual(rows);
        expect(refresh?.props('loading')).toBe(false);
    });

    it('preserves confirmation, asset-id deletion, cleanup and article reindex dispatch using isolated API mocks', async () =>
    {
        const view = mountAssets();
        await flushPromises();
        const remove = view.getComponent(ElTableV2).get('.el-table-v2__right button');
        await remove.trigger('click');
        await flushPromises();
        expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining('4 个引用'), '删除服务器文件', expect.any(Object));
        expect(mocks.deleteImage).not.toHaveBeenCalled();
        mocks.confirm.mockResolvedValue({ kind: 'confirmed' });
        await remove.trigger('click');
        await flushPromises();
        expect(mocks.deleteImage).toHaveBeenCalledWith(rows[0]?.id);
        expect(mocks.success).toHaveBeenCalledWith('服务器文件已删除');
        const cleanup = view.findAllComponents(ElButton).find((button) => button.text() === '清理孤儿资产');
        await cleanup?.trigger('click');
        await flushPromises();
        expect(mocks.cleanup).toHaveBeenCalledTimes(1);
        await view.get('input[placeholder="输入文章 ID"]').setValue('42');
        const reindex = view.findAllComponents(ElButton).find((button) => button.text() === '重建文章引用');
        await reindex?.trigger('click');
        await flushPromises();
        expect(mocks.reindex).toHaveBeenCalledWith(42);
        expect(mocks.list).toHaveBeenCalledTimes(4);
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it('keeps compact asset cards and their confirmation action on the real responsive collection', async () =>
    {
        compact = true;
        const view = mountAssets();
        await flushPromises();
        expect(view.findComponent(ElResponsiveCollection).exists()).toBe(true);
        expect(view.getComponent(ElTableV2).isVisible()).toBe(false);
        const cards = view.findAll('[role="listitem"]');
        expect(cards).toHaveLength(3);
        expect(cards[1]?.text()).toContain('无 SHA256');
        await cards[1]?.get('button').trigger('click');
        await flushPromises();
        expect(mocks.confirm).toHaveBeenCalledWith('确认删除该孤儿文件？', '删除服务器文件', expect.any(Object));
        expect(mocks.deleteImage).not.toHaveBeenCalled();
    });

    it.each([
        { label: 'alphabetic suffix', input: '42oops' },
        { label: 'decimal', input: '42.9' },
        { label: 'exponent', input: '1e3' },
        { label: 'empty', input: '' },
        { label: 'whitespace', input: '   ' },
        { label: 'zero', input: '0' },
        { label: 'negative', input: '-1' },
        { label: 'plus sign', input: '+42' },
        { label: 'hexadecimal', input: '0x2a' },
        { label: 'internal whitespace', input: '4 2' },
        { label: 'above Int32', input: '2147483648' },
        { label: 'unsafe integer', input: '9007199254740992' },
        { label: 'rounded unsafe integer', input: '9007199254740993' }
    ])('rejects $label article ID before invoking reindex', async ({ input }) =>
    {
        const view = mountAssets();
        await flushPromises();
        await view.get('input[placeholder="输入文章 ID"]').setValue(input);
        const reindex = view.findAllComponents(ElButton).find((button) => button.text() === '重建文章引用');
        expect(reindex).toBeDefined();
        await reindex?.trigger('click');
        await flushPromises();
        expect(mocks.reindex).not.toHaveBeenCalled();
        expect(mocks.warning).toHaveBeenCalledWith('请输入有效文章 ID', '请输入有效文章 ID');
        expect(mocks.success).not.toHaveBeenCalled();
        expect(mocks.list).toHaveBeenCalledTimes(1);
        expect(reindex?.props('loading')).toBe(false);
    });

    it.each([
        { label: '42', input: '42', articleId: 42 },
        { label: 'trimmed 42', input: ' 42 ', articleId: 42 },
        { label: 'lower Int32 boundary', input: '1', articleId: 1 },
        { label: 'upper Int32 boundary', input: '2147483647', articleId: 2147483647 },
        { label: 'leading-zero decimal', input: '00042', articleId: 42 }
    ])('reindexes valid $label article ID without changing its value', async ({ input, articleId }) =>
    {
        const view = mountAssets();
        await flushPromises();
        await view.get('input[placeholder="输入文章 ID"]').setValue(input);
        const reindex = view.findAllComponents(ElButton).find((button) => button.text() === '重建文章引用');
        expect(reindex).toBeDefined();
        await reindex?.trigger('click');
        await flushPromises();
        expect(mocks.reindex).toHaveBeenCalledTimes(1);
        expect(mocks.reindex).toHaveBeenCalledWith(articleId);
        expect(mocks.warning).not.toHaveBeenCalled();
        expect(mocks.error).not.toHaveBeenCalled();
        expect(mocks.success).toHaveBeenCalledWith('文章资产引用已重建');
        expect(mocks.list).toHaveBeenCalledTimes(2);
        expect(reindex?.props('loading')).toBe(false);
    });
});
