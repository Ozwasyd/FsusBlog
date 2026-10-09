// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';

import type { ArticlePackageCandidateReview } from '@/api/types/articlePackageCandidateReview';
import ArticlePackageCandidateReviewView from '@/components/admin/article-packages/ArticlePackageCandidateReview.vue';

function review(total = 1, pageIndex = 0, pageSize = 25): ArticlePackageCandidateReview
{
    const start = pageIndex * pageSize;
    return {
        candidateStatus: 'finite_bytes_validated',
        summary: {
            articleCount: total,
            fileCount: total + 2,
            schemaVersion: 1,
            canonicalHashVersion: 1,
            propertySchemaVersion: 1,
            packageBytesDigest: 'a'.repeat(64),
            manifestSemanticDigest: 'b'.repeat(64),
            checksumComponentDigest: 'c'.repeat(64)
        },
        requestedMode: 'UpdateRequested',
        policyDigest: 'd'.repeat(64),
        createdAtUtc: '2026-10-08T01:02:03.1234567Z',
        expiresAtUtc: '2026-10-08T01:32:03.7654321Z',
        intervalStatus: 'caller_interval_current',
        planDigest: 'e'.repeat(64),
        pageIndex,
        pageSize,
        totalTargets: total,
        targets: Array.from({ length: Math.min(pageSize, total - start) }, (_, index) => ({
            portableArticle: `article:00000000-0000-0000-0000-${(start + index + 1).toString(16).padStart(12, '0')}`,
            requiresNewIdentity: false,
            requestedTargetArticleId: 101 + start + index,
            expectedTargetRevision: '9223372036854775807'
        })),
        requiredAuthorities: ['complete_package_schema', 'current_actor_site_target_permissions', 'execution_qualification'],
        executeDisabled: true,
        executionReasonCode: 'article_package_import_authority_unavailable'
    };
}

const mounted: ReturnType<typeof mount>[] = [];
function mountReview(props: Record<string, unknown> = {})
{
    const wrapper = mount(ArticlePackageCandidateReviewView, { props, attachTo: document.body });
    mounted.push(wrapper);
    return wrapper;
}

afterEach(() =>
{
    mounted.splice(0).forEach(wrapper => wrapper.unmount());
    document.body.innerHTML = '';
});

describe('ArticlePackageCandidateReview ordinary component controls', () =>
{
    it('labels the finite candidate, original summary, assertions and unresolved hints accurately', () =>
    {
        const data = review();
        const wrapper = mountReview({ review: data });
        expect(wrapper.text()).toContain('有限字节已验证；完整包准入尚未获得');
        expect(wrapper.text()).toContain('1 篇文章，3 个文件');
        expect(wrapper.text()).toContain('当前候选未提供');
        expect(wrapper.text()).toContain('请求更新（提示未验证）');
        expect(wrapper.text()).toContain('调用方声明的有效区间（UTC）');
        expect(wrapper.text()).toContain(data.createdAtUtc);
        expect(wrapper.text()).toContain(data.expiresAtUtc);
        expect(wrapper.text()).toContain('尚未解析为当前目标');
        expect(wrapper.text()).toContain('9223372036854775807');
        expect(wrapper.text()).not.toContain('9223372036854776000');
        expect(wrapper.text()).toContain(data.planDigest);
        expect(wrapper.text()).toContain(data.policyDigest);
        data.requiredAuthorities.forEach(value => expect(wrapper.text()).toContain(value));
        expect(wrapper.text()).toContain('认证 intake 与读取路由');
        expect(wrapper.findAll('.package-review__targets > li')).toHaveLength(1);
    });

    it('shows new identity requirements without implying a created identity or resolved target', () =>
    {
        const data = review();
        const wrapper = mountReview({ review: {
            ...data,
            requestedMode: 'CreateNew',
            targets: [{ ...data.targets[0], requiresNewIdentity: true, requestedTargetArticleId: null, expectedTargetRevision: null }]
        } });
        expect(wrapper.text()).toContain('请求创建新身份');
        expect(wrapper.text()).toContain('需要新身份（尚未创建）');
        expect(wrapper.text()).toContain('未提供');
    });

    it('never enables or emits execution for complete structurally valid hints, clicks or keys', async () =>
    {
        const wrapper = mountReview({ review: review(), canExecute: true, onExecute: () => { throw new Error('execution forbidden'); } });
        const execute = wrapper.get('button[data-reason-code="article_package_import_authority_unavailable"]');
        expect(execute.attributes('disabled')).toBeDefined();
        expect(execute.attributes('aria-describedby')).toBe(wrapper.get('p[data-reason-code="article_package_import_authority_unavailable"]').attributes('id'));
        await execute.trigger('click');
        await execute.trigger('keydown', { key: 'Enter' });
        await execute.trigger('keydown', { key: ' ' });
        expect(wrapper.emitted('execute')).toBeUndefined();
        expect(wrapper.emitted('request-page')).toBeUndefined();
        expect(wrapper.attributes('canexecute')).toBeUndefined();
    });

    it('handles zero supplied candidates without inventing a zero-article validated plan', () =>
    {
        const wrapper = mountReview();
        expect(wrapper.get('[role="status"]').text()).toContain('尚未提供候选审阅');
        expect(wrapper.findAll('.package-review__targets > li')).toHaveLength(0);
        expect(wrapper.find('nav').exists()).toBe(false);
        expect(wrapper.get('button').attributes('disabled')).toBeDefined();
    });

    it('announces loading and error states and keeps the execution refusal', async () =>
    {
        const wrapper = mountReview({ state: 'loading' });
        expect(wrapper.attributes('aria-busy')).toBe('true');
        expect(wrapper.get('[role="status"]').text()).toContain('正在读取');
        await wrapper.setProps({ state: 'error' });
        expect(wrapper.get('[role="alert"]').attributes('data-reason-code')).toBe('article_package_candidate_review_invalid');
        expect(wrapper.text()).toContain('article_package_import_authority_unavailable');
        expect(wrapper.get('button').attributes('disabled')).toBeDefined();
    });

    it.each(['caller_interval_not_started', 'caller_interval_expired', 'caller_interval_current'] as const)(
        'keeps stale/refusal semantics for %s', (intervalStatus) =>
        {
            const wrapper = mountReview({ review: { ...review(), intervalStatus }, stale: intervalStatus === 'caller_interval_current' });
            expect(wrapper.get('[data-reason-code="article_package_import_plan_stale"]').attributes('role')).toBe('status');
            expect(wrapper.get('button[data-reason-code]').attributes('disabled')).toBeDefined();
            expect(wrapper.emitted('execute')).toBeUndefined();
        });

    it('renders only one supplied page for 1000 hints with semantic headings, list and live pagination', () =>
    {
        const wrapper = mountReview({ review: review(1000, 0, 50) });
        expect(wrapper.findAll('.package-review__targets > li')).toHaveLength(50);
        expect(wrapper.text()).toContain('第 1 / 20 页；共 1000 条提示');
        expect(wrapper.get('nav').attributes('aria-label')).toBe('请求目标提示分页');
        const list = wrapper.get('ol');
        expect(list.attributes('aria-labelledby')).toBe(wrapper.get('h3').attributes('id'));
        expect(wrapper.get('section').attributes('aria-labelledby')).toBe(wrapper.get('h2').attributes('id'));
        expect(wrapper.get('nav [role="status"]').attributes('aria-live')).toBe('polite');
        const buttons = wrapper.findAll('nav button');
        expect(buttons[0].attributes('disabled')).toBeDefined();
        expect(buttons[1].attributes('disabled')).toBeUndefined();
    });

    it('requests digest-bound pages only, blocks repeated requests and focuses arrived hints through loading', async () =>
    {
        const wrapper = mountReview({ review: review(1000, 0, 50) });
        const next = wrapper.findAll('nav button')[1];
        (next.element as HTMLElement).focus();
        // Native buttons supply Enter/Space activation; no custom keyboard or permission inference.
        (next.element as HTMLButtonElement).click();
        await nextTick();
        expect(document.activeElement).toBe(wrapper.get('h3').element);
        expect(wrapper.attributes('aria-busy')).toBe('true');
        expect(wrapper.emitted('request-page')).toEqual([[{ planDigest: 'e'.repeat(64), pageIndex: 1, pageSize: 50 }]]);
        await next.trigger('click');
        expect(wrapper.emitted('request-page')).toHaveLength(1);
        await wrapper.setProps({ state: 'loading' });
        expect(wrapper.get('nav button:last-of-type').attributes('disabled')).toBeDefined();
        await wrapper.setProps({ state: 'ready', review: review(1000, 1, 50) });
        await nextTick();
        expect(document.activeElement).toBe(wrapper.get('h3').element);
        expect(wrapper.get('ol').attributes('start')).toBe('51');
        expect(wrapper.findAll('.package-review__targets > li')).toHaveLength(50);
        await wrapper.findAll('nav button')[0].trigger('click');
        expect(wrapper.emitted('request-page')?.[1]).toEqual([{ planDigest: 'e'.repeat(64), pageIndex: 0, pageSize: 50 }]);
    });

    it('returns focus to the review heading after a failed page read', async () =>
    {
        const wrapper = mountReview({ review: review(51, 0, 50) });
        const next = wrapper.findAll('nav button')[1];
        (next.element as HTMLElement).focus();
        await next.trigger('click');
        await wrapper.setProps({ state: 'error' });
        await nextTick();
        expect(document.activeElement).toBe(wrapper.get('h2').element);
        expect(wrapper.find('nav').exists()).toBe(false);
        expect(wrapper.get('[role="alert"]').exists()).toBe(true);
    });

    it('handles final pages and plan replacement without stealing outside focus', async () =>
    {
        const wrapper = mountReview({ review: review(51, 1, 50) });
        expect(wrapper.findAll('.package-review__targets > li')).toHaveLength(1);
        expect(wrapper.findAll('nav button')[1].attributes('disabled')).toBeDefined();
        (wrapper.findAll('nav button')[0].element as HTMLElement).focus();
        await wrapper.setProps({ review: { ...review(1), planDigest: 'f'.repeat(64) } });
        await nextTick();
        expect(document.activeElement).toBe(wrapper.get('h2').element);
        const outside = document.createElement('button');
        document.body.append(outside);
        outside.focus();
        await wrapper.setProps({ review: review(1) });
        await nextTick();
        expect(document.activeElement).toBe(outside);
    });

    it.each([
        { executeDisabled: false },
        { totalTargets: 1001 },
        { pageSize: 51 },
        { pageIndex: Number.MAX_SAFE_INTEGER },
        { targets: [{ ...review().targets[0], expectedTargetRevision: 9223372036854776000 }] },
        { targets: [{ ...review().targets[0], expectedTargetRevision: '9223372036854775808' }] },
        { targets: Array.from({ length: 1000 }, () => review().targets[0]) },
        { requiredAuthorities: Array.from({ length: 17 }, () => 'authority') }
    ])('refuses malformed or overbudget display projections %#', (fault) =>
    {
        const wrapper = mountReview({ review: { ...review(), ...fault } });
        expect(wrapper.get('[role="alert"]').exists()).toBe(true);
        expect(wrapper.findAll('.package-review__targets > li')).toHaveLength(0);
        expect(wrapper.find('dl').exists()).toBe(false);
        expect(wrapper.get('button').attributes('disabled')).toBeDefined();
        expect(wrapper.emitted('execute')).toBeUndefined();
    });
});
