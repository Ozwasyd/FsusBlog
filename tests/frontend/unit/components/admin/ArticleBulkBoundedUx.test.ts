// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import ArticleBulkImpactPreview from '@/components/admin/article/ArticleBulkImpactPreview.vue';
import ArticleBulkExecutionProgress from '@/components/admin/article/ArticleBulkExecutionProgress.vue';
import ArticleBulkResults from '@/components/admin/article/ArticleBulkResults.vue';
import type { ArticleBulkItemPage, ArticleBulkPlanSummary, ArticleBulkResultSummary } from '@/services/authoring/articleBulkPresentation';

const plan: ArticleBulkPlanSummary = {
    reference: 'plan:exact', digest: 'sha256:plan-exact', registryDigest: 'sha256:registry', operationId: 'tag.add', operationLabel: '添加标签',
    strategy: 'per-item-isolated', selection: { reference: 'selection:exact', digest: 'sha256:selection', kind: 'query', count: 10_000 },
    selectedCount: 10_000, eligibleCount: 10_000, blockedCount: 0, conflictCount: 0, executable: true,
    expiresAtUtc: '2026-10-08T20:00:00Z', proposedChange: '添加已确认的标签', impactPageReference: 'impact:0'
};
const result: ArticleBulkResultSummary = {
    executionReference: 'execution:original', planDigest: plan.digest, receiptReference: 'receipt:original', receiptDigest: 'sha256:receipt',
    strategy: 'per-item-isolated', state: 'partial', selectedCount: 10_000, eligibleCount: 10_000,
    succeededCount: 9999, failedCount: 1, cancelledCount: 0, blockedCount: 0, notExecutedCount: 0, commitOutcome: null,
    itemPageReference: 'items:0'
};
function page(reference = 'items:0'): ArticleBulkItemPage {
    return { reference, planDigest: plan.digest, receiptDigest: result.receiptDigest, nextReference: 'items:1',
        items: Array.from({ length: 50 }, (_, index) => ({ articleIdentity: `article:${reference}:${index}`,
            receiptReference: `receipt:${reference}:${index}`, outcome: index === 0 ? 'revision-conflict' : 'success',
            reason: index === 0 ? '版本已变化' : '已处理', retryEligible: index === 0 })) };
}
// Happy DOM omits the native DOM toStringTag. Match the actual Chromium tag so Vue does not
// proxy this platform object (which would break Happy DOM's private fields); retain real observers.
const observerTag = Object.getOwnPropertyDescriptor(MutationObserver.prototype, Symbol.toStringTag);
beforeAll(() => Object.defineProperty(MutationObserver.prototype, Symbol.toStringTag, { value: 'MutationObserver', configurable: true }));
afterAll(() => {
    if (observerTag) Object.defineProperty(MutationObserver.prototype, Symbol.toStringTag, observerTag);
    else Reflect.deleteProperty(MutationObserver.prototype, Symbol.toStringTag);
});
const wrappers: ReturnType<typeof mount>[] = [];
function keep<T extends ReturnType<typeof mount>>(wrapper: T): T { wrappers.push(wrapper); return wrapper; }
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); document.body.innerHTML = ''; });

// Actual active FsusUI primitives; business inputs do not qualify any production adapter.
describe('bounded bulk product UI with real primitives', () => {
    it.each([100, 10_000])('renders only one 50-row page for %i selected identities', count => {
        const wrapper = keep(mount(ArticleBulkResults, { props: { result: { ...result, selectedCount: count, eligibleCount: count,
            succeededCount: count - 1 }, page: page(), busy: false, retryPolicies: [] } }));
        expect(wrapper.findAll('tbody tr')).toHaveLength(50);
        expect(wrapper.get('h3').text()).toBe('部分处理成功');
        expect(wrapper.text()).toContain(`选择共 ${count} 篇`);
        expect(wrapper.find('[class*="success"]').exists()).toBe(false);
    });
    it('filters only the bounded page and leaves global counts intact', async () => {
        const wrapper = keep(mount(ArticleBulkResults, { props: { result, page: page(), busy: false, retryPolicies: [] } }));
        const input = wrapper.get('input[aria-label="筛选本页结果原因"]');
        await input.setValue('版本');
        expect(wrapper.findAll('tbody tr')).toHaveLength(1);
        expect(wrapper.text()).toContain('成功 9999 · 失败 1');
        expect(wrapper.text()).toContain('筛选只作用于本页');
        await input.setValue('没有匹配的原因');
        expect(wrapper.text()).toContain('其余页面尚未筛选');
        expect(wrapper.emitted('page')).toBeUndefined();
    });
    it('navigates exact next/back cursors, restores focus, and drops history for a new receipt', async () => {
        const wrapper = keep(mount(ArticleBulkResults, { attachTo: document.body,
            props: { result, page: page(), busy: false, retryPolicies: [] } }));
        await nextTick();
        await wrapper.findAll('button').find(button => button.text() === '下一页结果')!.trigger('click');
        expect(wrapper.emitted('page')).toEqual([['items:1']]);
        await wrapper.setProps({ page: { ...page('items:1'), nextReference: null } });
        await nextTick(); expect(document.activeElement).toBe(wrapper.get('section').element);
        await wrapper.findAll('button').find(button => button.text() === '上一页结果')!.trigger('click');
        expect(wrapper.emitted('page')?.at(-1)).toEqual(['items:0']);
        await wrapper.setProps({ result: { ...result, receiptDigest: 'sha256:new-receipt' }, page: null });
        expect(wrapper.text()).not.toContain('上一页结果');
        expect(wrapper.findAll('tbody tr')).toHaveLength(0);
    });
    it('confirms the displayed exact plan and blocks permission-invalidated confirmation', async () => {
        const wrapper = keep(mount(ArticleBulkImpactPreview, { props: { plan, expired: false, busy: false } }));
        const confirm = wrapper.findAll('button').find(button => button.text() === '确认执行此计划')!;
        await confirm.trigger('click');
        expect(wrapper.emitted('confirm')).toEqual([[{ planReference: plan.reference, planDigest: plan.digest }]]);
        await wrapper.setProps({ invalidation: 'permission-changed' });
        expect(confirm.attributes('disabled')).toBeDefined();
        await confirm.trigger('click'); expect(wrapper.emitted('confirm')).toHaveLength(1);
        expect(wrapper.get('[role="alert"]').text()).toContain('权限已变化，请重新预览并确认');
    });
    it('does not render foreign or oversized rich pages', async () => {
        const wrapper = keep(mount(ArticleBulkResults, { props: { result, page: { ...page(), receiptDigest: 'sha256:foreign' },
            busy: false, retryPolicies: [] } }));
        expect(wrapper.findAll('tbody tr')).toHaveLength(0);
        await wrapper.setProps({ page: { ...page(), items: [...page().items, page().items[0]!] } });
        expect(wrapper.findAll('tbody tr')).toHaveLength(0);
    });
    it('does not expose an unknown-item retry even if a malformed projection says eligible', () => {
        const wrapper = keep(mount(ArticleBulkResults, { props: { result, page: { ...page(), items: [{ ...page().items[0]!,
            outcome: 'infra-no-conclusion', retryEligible: true }] }, busy: false,
            retryPolicies: [{ reference: 'policy:explicit', label: '明确确认版本' }] } }));
        expect(wrapper.findAll('button').some(button => button.text() === '重新预览此项')).toBe(false);
    });
    it('returns focus to the host trigger after adjustment or leaving conclusive results', async () => {
        const target = document.createElement('button'); document.body.append(target);
        const impact = keep(mount(ArticleBulkImpactPreview, { attachTo: document.body,
            props: { plan, expired: false, busy: false, returnFocusTarget: target } }));
        await impact.findAll('button').find(button => button.text() === '返回调整')!.trigger('click');
        await nextTick(); expect(document.activeElement).toBe(target);
        const results = keep(mount(ArticleBulkResults, { attachTo: document.body,
            props: { result, page: null, busy: false, retryPolicies: [], returnFocusTarget: target } }));
        await results.findAll('button').find(button => button.text() === '返回文章列表')!.trigger('click');
        await nextTick(); expect(document.activeElement).toBe(target);
        expect(results.emitted('done')).toHaveLength(1);
    });
    it('states atomic cancellation boundaries and keeps focus after cancellation becomes unavailable', async () => {
        const wrapper = keep(mount(ArticleBulkExecutionProgress, { attachTo: document.body, props: { busy: false, progress: {
            executionReference: 'execution:atomic', planDigest: plan.digest, strategy: 'all-or-nothing', state: 'executing',
            selectedCount: 10_000, eligibleCount: 10_000, succeededCount: 0, failedCount: 0, cancelledCount: 0, cancelAllowed: true
        } } }));
        expect(wrapper.text()).toContain('仅准备阶段可请求安全取消');
        expect(wrapper.text()).not.toContain('成功 0');
        const cancel = wrapper.get('[data-bulk-cancel]'); (cancel.element as HTMLElement).focus();
        await wrapper.setProps({ busy: true });
        await nextTick(); expect(document.activeElement).toBe(wrapper.get('section').element);
        await wrapper.setProps({ busy: false, progress: { ...wrapper.props('progress'), cancelAllowed: false } });
        await nextTick(); expect(document.activeElement).toBe(wrapper.get('section').element);
        expect(cancel.attributes('disabled')).toBeDefined();
    });
});
