// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, effectScope, h, isReadonly, nextTick, watch } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';

import type { ArticlePackageCandidateReview, ArticlePackageCandidateReviewPageRequest } from '@/api/types/articlePackageCandidateReview';
import ArticlePackageCandidateReviewView from '@/components/admin/article-packages/ArticlePackageCandidateReview.vue';
import { useArticlePackageCandidateReview, type ArticlePackageCandidateReviewReadPort } from '@/composables/useArticlePackageCandidateReview';

// Decoded projection and controlled promise fixtures prove host behavior, not authenticated production I/O.
function page(index = 0, digest = 'e'.repeat(64)): ArticlePackageCandidateReview
{
    return {
        candidateStatus: 'finite_bytes_validated',
        summary: { articleCount: 100, fileCount: 102, schemaVersion: 1, canonicalHashVersion: 1, propertySchemaVersion: 1, packageBytesDigest: 'a'.repeat(64), manifestSemanticDigest: 'b'.repeat(64), checksumComponentDigest: 'c'.repeat(64) },
        requestedMode: 'UpdateRequested', policyDigest: 'd'.repeat(64),
        createdAtUtc: '2026-10-08T01:02:03.1234567Z', expiresAtUtc: '2026-10-08T01:32:03.7654321Z',
        intervalStatus: 'caller_interval_current', planDigest: digest, pageIndex: index, pageSize: 50, totalTargets: 100,
        targets: Array.from({ length: 50 }, (_, i) => ({ portableArticle: `article:00000000-0000-0000-0000-${(index * 50 + i + 1).toString(16).padStart(12, '0')}`, requiresNewIdentity: false, requestedTargetArticleId: 101 + index * 50 + i, expectedTargetRevision: '9223372036854775807' })),
        requiredAuthorities: ['complete_package_schema', 'current_actor_site_target_permissions', 'execution_qualification'],
        executeDisabled: true, executionReasonCode: 'article_package_import_authority_unavailable'
    };
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
    const calls: { request: ArticlePackageCandidateReviewPageRequest; signal: AbortSignal; result: ReturnType<typeof deferred<ArticlePackageCandidateReview>> }[] = [];
    const read: ArticlePackageCandidateReviewReadPort = (request, signal) =>
    {
        const result = deferred<ArticlePackageCandidateReview>();
        calls.push({ request, signal, result });
        return result.promise;
    };
    return { read, calls };
}

function request(id = 'read-1', pageIndex = 1): ArticlePackageCandidateReviewPageRequest
{
    return { requestId: id, planDigest: 'e'.repeat(64), pageIndex, pageSize: 50 };
}

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() =>
{
    wrappers.splice(0).forEach(wrapper => wrapper.unmount());
    document.body.innerHTML = '';
});

async function mountedHost(read: ArticlePackageCandidateReviewReadPort)
{
    let host!: ReturnType<typeof useArticlePackageCandidateReview>;
    const component = defineComponent({
        setup()
        {
            host = useArticlePackageCandidateReview(read);
            return () => h(ArticlePackageCandidateReviewView, { review: host.review.value, state: host.state.value, pageCompletion: host.pageCompletion.value, onRequestPage: host.requestPage });
        }
    });
    const wrapper = mount(component, { attachTo: document.body });
    wrappers.push(wrapper);
    await host.setReview(page());
    await nextTick();
    return { host, wrapper };
}

describe('useArticlePackageCandidateReview ordinary host controls', () =>
{
    it('starts empty and cannot invoke a read without a provided projection', async () =>
    {
        const p = port(); const host = useArticlePackageCandidateReview(p.read);
        await host.requestPage(request());
        expect(host.review.value).toBeNull(); expect(host.pageCompletion.value).toBeNull();
        expect(host.state.value).toBe('ready'); expect(p.calls).toHaveLength(0);
    });
    it('seeds one readonly page without an intake, plan store or execution capability', async () =>
    {
        const host = useArticlePackageCandidateReview(port().read); const original = page();
        const seed = host.setReview(original); expect(host.review.value).toBeNull(); await seed;
        expect(isReadonly(host.review)).toBe(true); expect(isReadonly(host.state)).toBe(true);
        expect(host.review.value).toBe(original); expect(host.review.value?.targets[0].expectedTargetRevision).toBe('9223372036854775807');
        expect(host.review.value?.executeDisabled).toBe(true); expect('execute' in host).toBe(false);
    });
    it('passes the complete frozen identity and owned signal, then publishes its exact ready completion', async () =>
    {
        const p = port(); const host = useArticlePackageCandidateReview(p.read); await host.setReview(page());
        const input = request(); const reading = host.requestPage(input);
        expect(p.calls[0].request).toEqual(input); expect(Object.isFrozen(p.calls[0].request)).toBe(true);
        expect(p.calls[0].signal.aborted).toBe(false); expect(host.state.value).toBe('loading');
        const result = page(1); p.calls[0].result.resolve(result); await reading;
        expect(host.review.value).toBe(result); expect(host.pageCompletion.value).toEqual({ request: input, status: 'ready', review: result });
        expect(host.pendingRequest.value).toBeNull(); expect(host.state.value).toBe('ready');
    });
    it('actually aborts and settles cancellation even when the supplied promise ignores abort', async () =>
    {
        const p = port(); const host = useArticlePackageCandidateReview(p.read); const original = page(); await host.setReview(original);
        const reading = host.requestPage(request()); let aborted = 0; p.calls[0].signal.addEventListener('abort', () => { aborted++; });
        host.cancel(); await reading;
        expect(aborted).toBe(1); expect(p.calls[0].signal.aborted).toBe(true); expect(host.review.value).toBe(original);
        expect(host.pageCompletion.value).toEqual({ request: request(), status: 'cancelled' });
        p.calls[0].result.resolve(page(1)); await flushPromises(); expect(host.review.value).toBe(original);
    });
    it('rejects old and mismatched cancellations after a same-coordinate retry', async () =>
    {
        const p = port(); const host = useArticlePackageCandidateReview(p.read); await host.setReview(page());
        const first = host.requestPage(request('first')); host.cancel(); await first;
        const second = host.requestPage(request('second'));
        host.cancel(request('first')); host.cancel({ ...request('second'), pageSize: 25 });
        expect(p.calls[1].signal.aborted).toBe(false); expect(host.pendingRequest.value?.requestId).toBe('second');
        host.cancel(request('second')); await second; const completed = host.pageCompletion.value; host.cancel();
        expect(host.pageCompletion.value).toBe(completed); expect(p.calls[1].signal.aborted).toBe(true);
    });
    it('ignores late rejection while a newer request owns the page', async () =>
    {
        const p = port(); const host = useArticlePackageCandidateReview(p.read); await host.setReview(page());
        const first = host.requestPage(request('first')); host.cancel(); await first;
        const second = host.requestPage(request('second')); p.calls[0].result.reject(new Error('late failure')); await flushPromises();
        expect(host.state.value).toBe('loading'); expect(host.pendingRequest.value?.requestId).toBe('second');
        p.calls[1].result.resolve(page(1)); await second; expect(host.pageCompletion.value?.request.requestId).toBe('second');
    });
    it('aborts a pending read and clears completion before replacing a context', async () =>
    {
        const p = port(); const host = useArticlePackageCandidateReview(p.read); await host.setReview(page());
        const reading = host.requestPage(request()); const changing = host.setReview(page(0, 'f'.repeat(64)));
        expect(host.pageCompletion.value).toBeNull(); expect(host.review.value).toBeNull(); expect(p.calls[0].signal.aborted).toBe(true);
        await changing; await reading; p.calls[0].result.resolve(page(1)); await flushPromises();
        expect(host.review.value?.planDigest).toBe('f'.repeat(64)); expect(host.pageCompletion.value).toBeNull();
    });
    it('lets only the newest overlapping context seed survive its empty tick', async () =>
    {
        const host = useArticlePackageCandidateReview(port().read);
        const a = host.setReview(page()); const b = host.setReview(page(0, 'f'.repeat(64))); await Promise.all([a, b]);
        expect(host.review.value?.planDigest).toBe('f'.repeat(64));
    });
    it('does not start a page read during the empty context transition', async () =>
    {
        const p = port(); const host = useArticlePackageCandidateReview(p.read);
        const changing = host.setReview(page()); await host.requestPage(request()); await changing;
        expect(p.calls).toHaveLength(0); expect(host.pendingRequest.value).toBeNull();
    });
    it.each(['digest', 'page', 'size', 'refusal'])('finishes mismatched %s responses as identified read errors', async fault =>
    {
        const p = port(); const host = useArticlePackageCandidateReview(p.read); const original = page(); await host.setReview(original);
        const reading = host.requestPage(request()); const response = { ...page(1) };
        const malformed = fault === 'digest' ? { ...response, planDigest: 'f'.repeat(64) } : fault === 'page' ? page() : fault === 'size' ? { ...response, pageSize: 25 } : { ...response, executeDisabled: false };
        p.calls[0].result.resolve(malformed as ArticlePackageCandidateReview); await reading;
        expect(host.review.value).toBe(original); expect(host.pageCompletion.value).toEqual({ request: request(), status: 'error' });
        expect(host.state.value).toBe('error'); expect(host.pendingRequest.value).toBeNull();
    });
    it('contains synchronous port throws as identified errors without exposing private details', async () =>
    {
        const host = useArticlePackageCandidateReview(() => { throw new Error('private transport detail'); }); await host.setReview(page());
        await host.requestPage(request()); expect(host.pageCompletion.value).toEqual({ request: request(), status: 'error' });
        expect(JSON.stringify(host.pageCompletion.value)).not.toContain('private transport detail');
    });
    it('does not infer cancellation authority from an unsolicited AbortError', async () =>
    {
        const p = port(); const host = useArticlePackageCandidateReview(p.read); await host.setReview(page());
        const reading = host.requestPage(request()); p.calls[0].result.reject(new DOMException('failed port', 'AbortError')); await reading;
        expect(p.calls[0].signal.aborted).toBe(false); expect(host.pageCompletion.value?.status).toBe('error');
    });
    it('ignores duplicate active and completed request IDs without creating another read', async () =>
    {
        const p = port(); const host = useArticlePackageCandidateReview(p.read); await host.setReview(page());
        const reading = host.requestPage(request()); await host.requestPage(request()); expect(p.calls).toHaveLength(1);
        p.calls[0].result.resolve(page(1)); await reading; await host.requestPage(request()); expect(p.calls).toHaveLength(1);
    });
    it('scope disposal aborts and prevents future contexts, calls or late results', async () =>
    {
        const p = port(); const scope = effectScope(); const host = scope.run(() => useArticlePackageCandidateReview(p.read))!;
        await host.setReview(page()); const reading = host.requestPage(request()); scope.stop(); await reading;
        expect(p.calls[0].signal.aborted).toBe(true); p.calls[0].result.resolve(page(1)); await flushPromises();
        await host.setReview(page()); await host.requestPage(request('later')); expect(p.calls).toHaveLength(1); expect(host.review.value).toBeNull();
    });
    it('wires the frozen component event to the callable port and renders only the exact returned page', async () =>
    {
        const p = port(); const { wrapper } = await mountedHost(p.read);
        await wrapper.findAll('nav button')[1].trigger('click'); expect(p.calls).toHaveLength(1);
        expect(p.calls[0].request.pageIndex).toBe(1); expect(wrapper.get('section').attributes('aria-busy')).toBe('true');
        p.calls[0].result.resolve(page(1)); await flushPromises(); await nextTick();
        expect(wrapper.get('ol').attributes('start')).toBe('51'); expect(wrapper.get('section').attributes('aria-busy')).toBe('false');
        expect(wrapper.get('button[data-reason-code]').attributes('disabled')).toBeDefined();
    });
    it('wires owned cancellation, re-enables the frozen view and rejects late promise refill', async () =>
    {
        const p = port(); const { host, wrapper } = await mountedHost(p.read);
        await wrapper.findAll('nav button')[1].trigger('click'); host.cancel(); await flushPromises(); await nextTick();
        expect(p.calls[0].signal.aborted).toBe(true); expect(wrapper.findAll('nav button')[1].attributes('disabled')).toBeUndefined();
        await wrapper.findAll('nav button')[1].trigger('click'); p.calls[0].result.resolve(page(1)); await flushPromises();
        expect(wrapper.get('ol').attributes('start')).toBe('1'); expect(wrapper.get('section').attributes('aria-busy')).toBe('true');
        p.calls[1].result.resolve(page(1)); await flushPromises(); expect(wrapper.get('ol').attributes('start')).toBe('51');
    });
    it('lets the frozen view observe empty review before same-candidate error recovery', async () =>
    {
        const p = port(); const { host, wrapper } = await mountedHost(p.read);
        await wrapper.findAll('nav button')[1].trigger('click'); p.calls[0].result.reject(new Error('read failed')); await flushPromises();
        expect(wrapper.get('[role="alert"]').exists()).toBe(true); const seen: boolean[] = [];
        const stop = watch(computed(() => host.review.value), value => { seen.push(value === null); }, { flush: 'sync' });
        const original = host.review.value; const resetting = host.setReview(original); await nextTick();
        await resetting; await nextTick(); stop(); expect(seen).toContain(true);
        expect(wrapper.find('[role="alert"]').exists()).toBe(false); await wrapper.findAll('nav button')[1].trigger('click');
        expect(p.calls).toHaveLength(2); p.calls[1].result.resolve(page(1)); await flushPromises();
        expect(wrapper.get('ol').attributes('start')).toBe('51');
    });
});
