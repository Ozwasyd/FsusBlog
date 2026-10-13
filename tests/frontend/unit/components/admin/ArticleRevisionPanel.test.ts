// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, shallowRef } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArticleRevisionDetailResponse } from '@/api/authoring';
import ArticleRevisionPanel from '@/components/admin/article/ArticleRevisionPanel.vue';
import type { useArticleRevisionCompare } from '@/composables/useArticleRevisionCompare';
import type { RevisionSourcePresentation } from '@/services/revisionComparePresentation';

const holder = vi.hoisted(() => ({ state: null as ReturnType<typeof useArticleRevisionCompare> | null }));
vi.mock('@/composables/useArticleRevisionCompare', () => ({ useArticleRevisionCompare: () => holder.state }));
vi.mock('@/composables/useMediaQuery', async () =>
{
    const vue = await import('vue');
    return { useMediaQuery: () => vue.ref(true) };
});
const Button = defineComponent({ name: 'ElButton', inheritAttrs: false, setup(_, { attrs, slots }) { return () => h('button', attrs, slots.default?.()); } });
const range = { offset: 0, length: 4, end: 4 };

// Deliberate UI state fixture. Original service receipts are verified separately.
function presentation(): RevisionSourcePresentation
{
    return { response: { planReceipt: { planDigest: 'a'.repeat(64), basePackageDigest: 'b'.repeat(64), comparePackageDigest: 'c'.repeat(64) },
        sourceDiff: { receipt: { chunkCount: 1 } } }, baseBytes: new TextEncoder().encode('old\n'), compareBytes: new TextEncoder().encode('new\n'),
    rows: [{ id: 'stable-context', kind: 0, base: [{ text: 'old\n', changed: false }], compare: [{ text: 'new\n', changed: false }],
        baseRange: range, compareRange: range, baseLine: 1, compareLine: 1, collapsed: true, headingIdentities: [] }], headings: [] } as unknown as RevisionSourcePresentation;
}
function render()
{
    const selected = { id: '9007199254740993', articleId: 42, title: 'Old title', content: 'old\n', tagIds: [],
        rights: null, responsibility: null, release: null, packageComplete: false } as unknown as ArticleRevisionDetailResponse;
    return mount(ArticleRevisionPanel, { attachTo: document.body, props: { isEdit: true, revisions: [], selectedRevision: selected,
        selectedLabel: '版本 1', loading: false, rollbacking: false, statusText: 'history ready', compareText: 'unused',
        currentRevisionId: '9007199254740994', currentContent: 'new\n', contextIdentity: 'authoring-context', active: true },
    global: { components: { ElButton: Button }, stubs: { ElSelect: { template: '<select><slot /></select>' }, ElOption: true, ElInput: true, SemanticTime: true } } });
}

describe('single revision inspector comparison composition', () =>
{
    beforeEach(() =>
    {
        holder.state = { baseSelection: ref('current'), mode: ref<0 | 1>(0), status: ref<ReturnType<typeof useArticleRevisionCompare>['status']['value']>('ready'),
            result: shallowRef<RevisionSourcePresentation | null>(presentation()), phase: ref(''), canCompare: computed(() => true),
            compare: vi.fn().mockResolvedValue(undefined), cancel: vi.fn(), setMode: vi.fn().mockResolvedValue(undefined) };
    });

    it('keeps the same source renderer and context state across metadata switching without another request', async () =>
    {
        const wrapper = render();
        const source = wrapper.get('.revision-source-view').element;
        const button = (label: string) => wrapper.findAll('button').find(item => item.text() === label)!;
        await button('展开未变化范围').trigger('click');
        expect(wrapper.findAll('pre')).toHaveLength(2);
        await button('元数据差异').trigger('click');
        expect(wrapper.text()).toContain('未取得服务端元数据结果');
        expect(wrapper.get('.revision-source-view').isVisible()).toBe(false);
        await button('正文差异').trigger('click');
        expect(wrapper.get('.revision-source-view').element).toBe(source);
        expect(wrapper.findAll('pre')).toHaveLength(2);
        expect(holder.state!.compare).not.toHaveBeenCalled();
        expect(holder.state!.setMode).not.toHaveBeenCalled();
        expect(wrapper.findAll('.article-revision-panel')).toHaveLength(1);
        wrapper.unmount();
    });

    it('shows pending cancellation and cancels a pending request when its inspector becomes inactive', async () =>
    {
        holder.state!.status.value = 'loading';
        holder.state!.phase.value = '正在执行服务端有界比较；可取消';
        holder.state!.result.value = null;
        const wrapper = render();
        const cancel = wrapper.findAll('button').find(item => item.text() === '取消比较')!;
        expect(wrapper.text()).toContain('有界比较');
        expect(wrapper.find('.revision-source-view').exists()).toBe(false);
        await cancel.trigger('click');
        expect(holder.state!.cancel).toHaveBeenCalledTimes(1);
        await wrapper.setProps({ active: false });
        expect(holder.state!.cancel).toHaveBeenCalledTimes(2);
        wrapper.unmount();
    });

    it.each(['stale', 'cancelled', 'unavailable'] as const)('shows %s without any partial result', (status) =>
    {
        holder.state!.status.value = status;
        holder.state!.result.value = null;
        const wrapper = render();
        expect(wrapper.find('.revision-source-view').exists()).toBe(false);
        expect(wrapper.find('.revision-metadata-view').exists()).toBe(false);
        expect(wrapper.findAll('[role="status"]').some(item => item.text().includes(status === 'stale' ? '已变化' : status === 'cancelled' ? '已取消' : '不可用'))).toBe(true);
        wrapper.unmount();
    });
});
