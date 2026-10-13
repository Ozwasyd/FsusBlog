// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, effectScope, h } from 'vue';
import { describe, expect, it } from 'vitest';

import type { ArticlePackageCandidateReadContext, ArticlePackageCandidateReadIntent, ArticlePackageCandidateReadRequest, ArticlePackageCandidateReadResponse } from '@/api/types/articlePackageCandidateRead';
import type { ArticlePackageCandidateReview } from '@/api/types/articlePackageCandidateReview';
import ReviewView from '@/components/admin/article-packages/ArticlePackageCandidateReview.vue';
import { useArticlePackageCandidateReadHost } from '@/composables/useArticlePackageCandidateReadHost';

// Controlled typed port and Happy DOM prove integration behavior, not production I/O or UX acceptance.
const digest = 'e'.repeat(64);
const context: ArticlePackageCandidateReadContext = {
    identity: `fsus-site:${'a'.repeat(64)}`, lifecycleVersion: 1, generation: 2, mappingRevision: 7, scopeRevision: 3
};

function input(): ArticlePackageCandidateReadIntent
{
    return {
        archiveBytes: 'UEsDBA==', requestedMode: 'UpdateRequested', callerPolicyDigest: 'd'.repeat(64),
        callerPermissionContextDigest: 'b'.repeat(64), createdAtUtc: '2026-10-09T01:02:03.0000000Z',
        expiresAtUtc: '2026-10-09T01:32:03.0000000Z', pageSize: 1,
        requestedTargets: [{ portableArticle: 'article:00000000-0000-0000-0000-000000000001',
            requestedTargetArticleId: 41, expectedTargetRevision: '9223372036854775807' }]
    };
}

function page(index = 0): ArticlePackageCandidateReview
{
    return {
        candidateStatus: 'finite_bytes_validated', summary: { articleCount: 2, fileCount: 4, schemaVersion: 1,
            canonicalHashVersion: 1, propertySchemaVersion: 1, packageBytesDigest: 'a'.repeat(64),
            manifestSemanticDigest: 'b'.repeat(64), checksumComponentDigest: 'c'.repeat(64) },
        requestedMode: 'UpdateRequested', policyDigest: 'd'.repeat(64), createdAtUtc: '2026-10-09T01:02:03.0000000Z',
        expiresAtUtc: '2026-10-09T01:32:03.0000000Z', intervalStatus: 'caller_interval_current',
        planDigest: digest, pageIndex: index, pageSize: 1, totalTargets: 2,
        targets: [{ portableArticle: `article:00000000-0000-0000-0000-00000000000${index + 1}`,
            requiresNewIdentity: false, requestedTargetArticleId: 41 + index, expectedTargetRevision: '9223372036854775807' }],
        requiredAuthorities: ['complete_package_schema', 'current_actor_site_target_permissions', 'execution_qualification'],
        executeDisabled: true, executionReasonCode: 'article_package_import_authority_unavailable'
    };
}

function response(request: ArticlePackageCandidateReadRequest): ArticlePackageCandidateReadResponse
{
    return { requestId: request.requestId, review: page(request.pageIndex), context: { ...context } };
}

function deferred<T>()
{
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
    return { promise, resolve, reject };
}

function port()
{
    const calls: { request: ArticlePackageCandidateReadRequest; signal: AbortSignal;
        result: ReturnType<typeof deferred<ArticlePackageCandidateReadResponse>> }[] = [];
    const host = useArticlePackageCandidateReadHost((request, signal) =>
    {
        const result = deferred<ArticlePackageCandidateReadResponse>();
        calls.push({ request, signal, result });
        return result.promise;
    });
    return { host, calls };
}

async function seeded(p = port())
{
    const pending = p.host.seed(input(), 'seed-1');
    await flushPromises();
    p.calls[0].result.resolve(response(p.calls[0].request));
    expect(await pending).toBe(true);
    return p;
}

const nextPage = { requestId: 'page-1', planDigest: digest, pageIndex: 1, pageSize: 1 };

describe('inactive authenticated candidate read host', () =>
{
    it('owns only exact wire fields and forwards original intent, Int64 and echoed coordinates to the page read', async () =>
    {
        const p = port();
        const source = Object.assign(input(), { actor: 'must-not-forward', session: 'must-not-forward' });
        const pending = p.host.seed(source, 'seed-1');
        await flushPromises();
        const first = p.calls[0];
        expect(Object.keys(first.request).sort()).toEqual(['archiveBytes', 'callerPermissionContextDigest', 'callerPolicyDigest',
            'createdAtUtc', 'expectedContext', 'expectedPlanDigest', 'expiresAtUtc', 'pageIndex', 'pageSize',
            'requestId', 'requestedMode', 'requestedTargets'].sort());
        expect(first.request.expectedContext).toBeNull();
        expect(first.request.expectedPlanDigest).toBeNull();
        first.result.resolve(response(first.request));
        expect(await pending).toBe(true);
        const reading = p.host.requestPage(nextPage);
        const second = p.calls[1];
        expect(second.request.expectedContext).toEqual(context);
        expect(second.request.expectedPlanDigest).toBe(digest);
        expect(second.request.archiveBytes).toBe(source.archiveBytes);
        expect(second.request.requestedTargets?.[0].expectedTargetRevision).toBe('9223372036854775807');
        expect('planDigest' in second.request).toBe(false);
        expect(second.signal.aborted).toBe(false);
        second.result.resolve(response(second.request));
        await reading;
        expect(p.host.review.value?.pageIndex).toBe(1);
        expect(p.host.pageCompletion.value?.request).toEqual(nextPage);
        expect(p.host.review.value?.executeDisabled).toBe(true);
        p.host.dispose();
    });

    it.each(['request-id', 'page-index', 'page-size', 'generation', 'mapping', 'scope-revision', 'digest', 'execution'])
        ('refuses %s mismatch without replacing the seed or granting execution', async field =>
        {
            const p = await seeded();
            const pending = p.host.requestPage(nextPage);
            const value = response(p.calls[1].request);
            const changed = field === 'request-id' ? { ...value, requestId: 'old-read' }
                : field === 'generation' ? { ...value, context: { ...context, generation: 3 } }
                    : field === 'mapping' ? { ...value, context: { ...context, mappingRevision: 8 } }
                        : field === 'scope-revision' ? { ...value, context: { ...context, scopeRevision: 4 } }
                            : { ...value, review: { ...value.review, ...(field === 'page-index' ? { pageIndex: 0 }
                                : field === 'page-size' ? { pageSize: 2 } : field === 'digest' ? { planDigest: 'f'.repeat(64) }
                                    : { executeDisabled: false as unknown as true }) } };
            p.calls[1].result.resolve(changed);
            await pending;
            expect(p.host.state.value).toBe('error');
            expect(p.host.pageCompletion.value?.status).toBe('error');
            expect(p.host.review.value?.pageIndex).toBe(0);
            expect(p.host.review.value?.executeDisabled).toBe(true);
            p.host.dispose();
        });

    it.each(['lifecycle', 'generation', 'scope'])('rejects malformed seed %s coordinates', async field =>
    {
        const p = port();
        const pending = p.host.seed(input(), 'seed-1');
        await flushPromises();
        const changed = field === 'lifecycle' ? { ...context, lifecycleVersion: 2 }
            : field === 'generation' ? { ...context, generation: 0 } : { ...context, scopeRevision: 8 };
        p.calls[0].result.resolve({ ...response(p.calls[0].request), context: changed });
        expect(await pending).toBe(false);
        expect(p.host.review.value).toBeNull();
        expect(p.host.state.value).toBe('error');
        p.host.dispose();
    });

    it('clear aborts an ignored seed and settles its waiter; late completion cannot restore it', async () =>
    {
        const p = port();
        const pending = p.host.seed(input(), 'seed-1');
        await flushPromises();
        await p.host.clear();
        expect(await pending).toBe(false);
        expect(p.calls[0].signal.aborted).toBe(true);
        p.calls[0].result.resolve(response(p.calls[0].request));
        await flushPromises();
        expect(p.host.review.value).toBeNull();
        expect(p.host.state.value).toBe('ready');
        p.host.dispose();
    });

    it('a new seed aborts an outstanding page; a late previous page cannot replace the new sequence', async () =>
    {
        const p = await seeded();
        const old = p.host.requestPage(nextPage);
        const replacement = p.host.seed(input(), 'seed-2');
        await flushPromises();
        expect(p.calls[1].signal.aborted).toBe(true);
        p.calls[2].result.resolve(response(p.calls[2].request));
        expect(await replacement).toBe(true);
        await old;
        p.calls[1].result.resolve(response(p.calls[1].request));
        await flushPromises();
        expect(p.host.review.value?.pageIndex).toBe(0);
        expect(p.host.pageCompletion.value).toBeNull();
        p.host.dispose();
    });

    it('empty-review reseeding recovers the real frozen component after an identified page error', async () =>
    {
        let p!: ReturnType<typeof port>;
        const wrapper = mount(defineComponent({ setup()
        {
            p = port();
            return () => h(ReviewView, { review: p.host.review.value, state: p.host.state.value,
                pageCompletion: p.host.pageCompletion.value, onRequestPage: p.host.requestPage });
        } }));
        try
        {
            await seeded(p);
            await flushPromises();
            const next = wrapper.findAll('button').find(button => button.text() === '下一页');
            expect(next).toBeDefined();
            await next!.trigger('click');
            await flushPromises();
            expect(p.calls).toHaveLength(2);
            p.calls[1].result.reject(new Error('controlled-read-error'));
            await flushPromises();
            expect(wrapper.find('[role="alert"]').exists()).toBe(true);
            const replacement = p.host.seed(input(), 'seed-2');
            await flushPromises();
            p.calls[2].result.resolve(response(p.calls[2].request));
            expect(await replacement).toBe(true);
            await flushPromises();
            expect(wrapper.find('[role="alert"]').exists()).toBe(false);
            expect(wrapper.text()).toContain('9223372036854775807');
            expect(wrapper.find('[data-reason-code="article_package_import_authority_unavailable"]').exists()).toBe(true);
        }
        finally
        {
            wrapper.unmount();
        }
    });

    it('scope disposal aborts and settles the initial seed without a successful review', async () =>
    {
        const scope = effectScope();
        const p = scope.run(port)!;
        const pending = p.host.seed(input(), 'seed-1');
        await flushPromises();
        scope.stop();
        expect(await pending).toBe(false);
        expect(p.calls[0].signal.aborted).toBe(true);
        expect(p.host.review.value).toBeNull();
        expect(await p.host.seed(input(), 'seed-2')).toBe(false);
    });
});
