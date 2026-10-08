// @vitest-environment happy-dom

import { ElMarkdownEditor, type MarkdownEditorTransaction } from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { renderToString } from 'vue/server-renderer';
import { mount } from '@vue/test-utils';
import { createSSRApp, h } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';

import ArticleSearchRevealStatus from '@/components/admin/article/ArticleSearchRevealStatus.vue';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter } from '@/services/authoring/articleAttachmentContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { type ArticleEditorContinuityPort } from '@/services/authoring/articleEditorContinuity';
import { bindArticleEditorRuntime } from '@/services/authoring/articleEditorRuntimeBinding';
import { projectArticleSearchReveal, type ArticleSearchRevealPresentation } from '@/services/authoring/articleSearchRevealPresentation';

// Consume exact Blog d1758a52b948a98f010dac57f3dadae036db6e9d with real
// FsusUI f2b3bb89ffe5f749da26c388f058efdbb6aee864. This isolated public editor
// binding is not the Writer host, a backend search admission, or a navigation receipt.
const privateBody = '# PRIVATE_DRAFT_SOURCE_2319\n\nIdentical body in two documents.';
const labels = {
    label: '原文定位',
    statusLabels: { ready: '命令可用', paused: '已暂停', rejected: '无法定位', unavailable: '不可用' },
    precisionLabels: {
        exact: '精确原文范围', rebased: '编辑后映射', partial: '部分原文范围',
        'semantic-neighbor': '邻近语义位置', percentage: '大致百分比'
    }
};
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));

function openPrivateDraft()
{
    let source = privateBody;
    const owner = createArticleDocumentContextAdapter({
        articleId: 231901, draftId: 'PRIVATE_DRAFT_ID_2319', editorSessionId: 'session:qa-search-reveal',
        siteScope: 'PRIVATE_SITE_SCOPE_2319', userScope: 'PRIVATE_USER_SCOPE_2319', content: source
    });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const wrapper = mount(ElMarkdownEditor, {
        props: { modelValue: source, mode: 'source', documentIdentity: owner.documentIdentity }
    });
    const editor = wrapper.vm as unknown as ArticleEditorContinuityPort;
    const binding = () => ({ document: owner.context,
        map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) });
    const attachments = new ArticleAttachmentContextAdapter(owner, 'qa:search-reveal', 'qa:v1', anchors);
    const runtime = bindArticleEditorRuntime(owner, anchors, attachments, {
        dispatch: (input: MarkdownEditorTransaction) => editor.dispatchTransaction(input),
        commitSource: result =>
        {
            if (result.revision > owner.context.sourceRevision)
            {
                source = result.value;
                owner.updateSource(source, result.revision);
            }
            else
            {
                expect(result.value).toBe(source);
            }
        },
        binding
    }, () => source, editor, {
        surface: 'source', configuration: { allowLatex: true, allowMermaid: true, baseUrl: null },
        identity: { themeDigest: owner.context.contentDigest, locale: 'zh-CN' },
        cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 8 }
    });
    cleanup.push(() => { runtime.dispose(); attachments.dispose(); owner.dispose(); wrapper.unmount(); });
    expect(runtime.initialize()).toBe(true);
    const anchor = anchors.capture(binding(), { start: 2, end: 12, direction: 'backward' }, {
        affinity: 'after', viewportOffset: 0, percentage: 0.2, surface: 'source', tool: 'none'
    });
    const command = anchors.restore(anchor, binding(), {
        origin: 'search', now: 10, viewportHeight: 768, reducedMotion: true
    });
    const lease = owner.beginTask('search', 'qa:search-reveal');
    return { owner, anchors, runtime, command, lease };
}

async function statusHtml(presentation: ArticleSearchRevealPresentation)
{
    return renderToString(createSSRApp({ render: () => h(ArticleSearchRevealStatus, { ...labels, presentation }) }));
}

function assertNoPrivateDiagnostics(html: string, ...digests: Array<string | null>)
{
    for (const secret of [privateBody, 'PRIVATE_DRAFT_SOURCE_2319', 'PRIVATE_DRAFT_ID_2319',
        'PRIVATE_SITE_SCOPE_2319', 'PRIVATE_USER_SCOPE_2319', ...digests])
    {
        if (secret !== null) expect(html).not.toContain(secret);
    }
    expect(html).not.toMatch(/data-(?:reason|digest)|commandDigest|contextDigest|itemprop|application\/ld\+json/);
}

describe('search reveal draft identity and SSR diagnostic boundaries', () =>
{
    it('renders localized availability from a genuine private-draft command without serializing its identity or diagnostics', async () =>
    {
        const state = openPrivateDraft();
        const context = state.owner.context;
        const receipts = state.anchors.receipts;
        const presentation = projectArticleSearchReveal(state.command, state.runtime, state.lease);
        expect(presentation).toMatchObject({ status: 'ready', precision: 'exact', commandDigest: state.command.contentDigest });
        const html = await statusHtml(presentation);
        expect(html).toContain('命令可用');
        expect(html).toContain('精确原文范围');
        expect(html).toContain('aria-label="原文定位"');
        assertNoPrivateDiagnostics(html, presentation.commandDigest, context.contextDigest, context.contentDigest);
        expect(state.owner.context).toBe(context);
        expect(state.anchors.receipts).toEqual(receipts);
    });

    it('rejects an old search command after an identical-body document switch and withholds the internal rejection from SSR', async () =>
    {
        const state = openPrivateDraft();
        const old = state.owner.context;
        state.owner.switchDocument({ articleId: 231902, draftId: 'PRIVATE_NEXT_DRAFT_2319', content: privateBody });
        expect(state.owner.context.contentDigest).toBe(old.contentDigest);
        expect(state.owner.context.contextDigest).not.toBe(old.contextDigest);
        const presentation = projectArticleSearchReveal(state.command, state.runtime, state.lease);
        expect(presentation).toMatchObject({ status: 'rejected', precision: null,
            reason: 'search-reveal-context-stale', commandDigest: null });
        const html = await statusHtml(presentation);
        expect(html).toContain('无法定位');
        expect(html).not.toContain('精确原文范围');
        expect(html).not.toContain(presentation.reason!);
        assertNoPrivateDiagnostics(html, state.command.contentDigest, old.contextDigest, state.owner.context.contextDigest);
    });

    it('requires a fresh canonical projection after cancellation instead of treating a retained availability value as a live acknowledgement', async () =>
    {
        const state = openPrivateDraft();
        const ready = projectArticleSearchReveal(state.command, state.runtime, state.lease);
        const view = mount(ArticleSearchRevealStatus, { props: { ...labels, presentation: ready } });
        cleanup.push(() => view.unmount());
        expect(view.text()).toContain('精确原文范围');
        state.lease.cancel('PRIVATE_QUERY_CANCELED_2319');
        expect(state.lease.isCurrent()).toBe(false);
        // The shipped component is read-only. Its host must refresh on lease changes;
        // an immutable prior value cannot prove current permission or navigation.
        expect(ready.status).toBe('ready');
        expect(view.text()).toContain('命令可用');
        const rejected = projectArticleSearchReveal(state.command, state.runtime, state.lease);
        await view.setProps({ presentation: rejected });
        expect(view.text()).toContain('无法定位');
        expect(view.text()).not.toContain('精确原文范围');
        const html = await statusHtml(rejected);
        expect(html).not.toContain('PRIVATE_QUERY_CANCELED_2319');
        expect(html).not.toContain(rejected.reason!);
        assertNoPrivateDiagnostics(html, ready.commandDigest, state.owner.context.contextDigest);
    });

    it('rejects an invalid boundary getter without reflecting a private exception into SSR or accessible status', async () =>
    {
        const state = openPrivateDraft();
        const privateException = 'PRIVATE_BACKEND_QUERY_FAILURE_2319';
        const invalid = new Proxy({}, { ownKeys() { throw new Error(privateException); } });
        const presentation = projectArticleSearchReveal(invalid, state.runtime, state.lease);
        expect(presentation).toMatchObject({ status: 'rejected', reason: 'search-reveal-command-invalid', commandDigest: null });
        const html = await statusHtml(presentation);
        expect(html).toContain('无法定位');
        expect(html).not.toContain(privateException);
        expect(html).not.toContain(presentation.reason!);
        assertNoPrivateDiagnostics(html, state.command.contentDigest, state.owner.context.contextDigest);
    });
});
