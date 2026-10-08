// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { ElMarkdownEditor, type MarkdownEditorDispatchResult, type MarkdownEditorTransaction, type MarkdownEditorTransactionEvent } from '@ozwasyd/element-plus';
import { effectScope, ref, shallowRef } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useArticleLinkInspectorPage } from '@/composables/useArticleLinkInspectorPage';
import { createMarkdownAnchorMap } from '@/fsusui/articlePositionMaps';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter, type ArticleAttachmentTransactionPort } from '@/services/authoring/articleAttachmentContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { bindArticleEditorRuntime, type ArticleEditorRuntimeBinding } from '@/services/authoring/articleEditorRuntimeBinding';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness() {
    let source = '# Heading\n\nUnchanged body';
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
        editorSessionId: 'session:link-inspector', siteScope: 'site:test', userScope: 'user:test', content: source });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'version:1', anchors);
    let binding: ArticleEditorRuntimeBinding | null = null;
    const editor = mount(ElMarkdownEditor, { props: {
        mode: 'source', modelValue: source, documentIdentity: owner.documentIdentity,
        'onUpdate:modelValue': (value: string) => { source = value; },
        onTransaction: (event: MarkdownEditorTransactionEvent) => binding?.consumeTransaction(event)
    } });
    const port = editor.vm as unknown as { dispatchTransaction(transaction: MarkdownEditorTransaction): MarkdownEditorDispatchResult };
    const transactions: ArticleAttachmentTransactionPort = {
        dispatch: transaction => port.dispatchTransaction(transaction),
        commitSource: result => {
            source = result.value;
            if (result.revision > owner.context.sourceRevision) owner.updateSource(source, result.revision);
        },
        binding: () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) })
    };
    binding = bindArticleEditorRuntime(owner, anchors, attachments, transactions, () => source, port, {
        surface: 'source', configuration: { allowLatex: true, allowMermaid: true, baseUrl: null },
        identity: { themeDigest: digest({ theme: 'fixture' }), locale: 'zh-CN' },
        cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 }
    });
    expect(binding.initialize()).toBe(true);
    const runtime = shallowRef<ArticleEditorRuntimeBinding | null>(binding);
    const active = ref(true);
    // Fixture UI coordinate, not a fabricated server permission/index receipt.
    const admittedCoordinate = ref<string | null>('fixture:admitted-page:1');
    const scope = effectScope();
    const state = scope.run(() => useArticleLinkInspectorPage<Readonly<{ rowIds: readonly string[]; pageKey: string }>>({
        owner, runtime, active, admittedCoordinate, section: 'backlinks'
    }))!;
    cleanups.push(() => { scope.stop(); binding?.dispose(); attachments.dispose(); editor.unmount(); owner.dispose(); });
    return { owner, runtime, active, admittedCoordinate, scope, state, binding, port, editor, readSource: () => source };
}

const page = { rowIds: ['relation:fixture'], pageKey: 'page:fixture:1' } as const;

describe('link inspector page lifecycle with the existing owner and real local FsusUI runtime', () => {
    it('retains the exact admitted loader value under the original document task lease', async () => {
        const test = harness();
        let signal: AbortSignal | null = null;
        const result = test.state.load(async input => { signal = input; return page; });
        expect(test.state.status.value).toBe('loading');
        expect(test.owner.activeTaskRefs).toHaveLength(1);
        expect(await result).toBe(true);
        expect(signal!.aborted).toBe(false);
        expect(test.state.data.value).toBe(page);
        expect(test.state.contextKey.value).toBe(JSON.stringify([test.owner.context.contextDigest, test.admittedCoordinate.value]));
        expect(test.owner.activeTaskRefs).toEqual([]);
        expect(test.owner.completedTaskEnvelopes.at(-1)).toMatchObject({
            kind: 'feature', producerRef: 'article-links:backlinks', status: 'completed',
            startedRevision: 0, completedRevision: 0, resultDigest: null
        });
        expect(test.readSource()).toBe('# Heading\n\nUnchanged body');
    });

    it.each(['coordinate', 'runtime', 'inactive'] as const)('does not call a loader without current %s', async gate => {
        const test = harness();
        if (gate === 'coordinate') test.admittedCoordinate.value = null;
        if (gate === 'runtime') test.runtime.value = null;
        if (gate === 'inactive') test.active.value = false;
        const loader = vi.fn(async () => page);
        expect(await test.state.load(loader)).toBe(false);
        expect(loader).not.toHaveBeenCalled();
        expect(test.state.status.value).toBe('unavailable');
        expect(test.owner.activeTaskRefs).toEqual([]);
    });

    it('aborts the original pending lease when the owner coordinate changes and rejects its late value', async () => {
        const test = harness();
        const pending = deferred<typeof page>();
        let signal!: AbortSignal;
        const result = test.state.load(input => { signal = input; return pending.promise; });
        test.admittedCoordinate.value = 'fixture:permission-index-generation:2';
        expect(signal.aborted).toBe(true);
        expect(test.state.status.value).toBe('stale');
        expect(test.state.data.value).toBeNull();
        pending.resolve(page);
        expect(await result).toBe(false);
        expect(test.state.contextKey.value).toBeNull();
    });

    it('clears a held page synchronously before refreshing; no old title/context remains current', async () => {
        const test = harness();
        expect(await test.state.load(async () => page)).toBe(true);
        const pending = deferred<typeof page>();
        const result = test.state.load(() => pending.promise);
        expect(test.state.data.value).toBeNull();
        expect(test.state.contextKey.value).toBeNull();
        expect(test.state.status.value).toBe('loading');
        pending.resolve(page);
        expect(await result).toBe(true);
    });

    it('keeps the newest lease and UI value when superseded work ignores cancellation and finishes late', async () => {
        const test = harness();
        const first = deferred<typeof page>();
        const second = deferred<typeof page>();
        let oldSignal!: AbortSignal;
        const old = test.state.load(signal => { oldSignal = signal; return first.promise; });
        const current = test.state.load(() => second.promise);
        expect(oldSignal.aborted).toBe(true);
        first.resolve(page);
        expect(await old).toBe(false);
        expect(test.state.status.value).toBe('loading');
        expect(test.owner.activeTaskRefs).toHaveLength(1);
        const newest = { rowIds: ['relation:new'], pageKey: 'page:new' };
        second.resolve(newest as unknown as typeof page);
        expect(await current).toBe(true);
        expect(test.state.data.value).toBe(newest);
    });

    it('clears current content after an actual public editor transaction advances the owner revision', async () => {
        const test = harness();
        expect(await test.state.load(async () => page)).toBe(true);
        const transaction = test.port.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'New text\n' }],
            documentIdentity: test.owner.documentIdentity, expectedRevision: 0, history: 'separate' });
        expect(transaction.accepted).toBe(true);
        expect(test.owner.context.sourceRevision).toBe(1);
        expect(test.state.status.value).toBe('stale');
        expect(test.state.data.value).toBeNull();
    });

    it('rejects a response after same-byte article switching without guessing identity from source content', async () => {
        const test = harness();
        const pending = deferred<typeof page>();
        const result = test.state.load(() => pending.promise);
        test.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: test.readSource(), reason: 'article-switch' });
        pending.resolve(page);
        expect(await result).toBe(false);
        expect(test.state.data.value).toBeNull();
    });

    it.each(['siteScope', 'userScope'] as const)('aborts on an actual owner %s switch', async scope => {
        const test = harness();
        const pending = deferred<typeof page>();
        let signal!: AbortSignal;
        const result = test.state.load(input => { signal = input; return pending.promise; });
        test.owner.switchDocument({ articleId: 1, draftId: 'article:1', content: test.readSource(), [scope]: `${scope}:other` });
        expect(signal.aborted).toBe(true);
        pending.resolve(page);
        expect(await result).toBe(false);
    });

    it('scrubs content and aborts immediately when the existing inspector closes', async () => {
        const test = harness();
        const pending = deferred<typeof page>();
        let signal!: AbortSignal;
        const result = test.state.load(input => { signal = input; return pending.promise; });
        test.active.value = false;
        expect(signal.aborted).toBe(true);
        expect(test.state.status.value).toBe('unavailable');
        pending.resolve(page);
        expect(await result).toBe(false);
    });

    it('refuses an already released actual editor binding without pretending its retained context is live', async () => {
        const test = harness();
        test.binding.dispose();
        const loader = vi.fn(async () => page);
        expect(await test.state.load(loader)).toBe(false);
        expect(loader).not.toHaveBeenCalled();
        expect(test.state.status.value).toBe('unavailable');
    });

    it('refuses settlement against a released binding and clears loading', async () => {
        const test = harness();
        const pending = deferred<typeof page>();
        const result = test.state.load(() => pending.promise);
        test.binding.dispose();
        pending.resolve(page);
        expect(await result).toBe(false);
        expect(test.state.status.value).toBe('unavailable');
    });

    it('shows a content-free error state and finishes its original lease after loader failure', async () => {
        const test = harness();
        expect(await test.state.load(async () => { throw new Error('private title and source'); })).toBe(false);
        expect(test.state.status.value).toBe('error');
        expect(test.state.data.value).toBeNull();
        expect(test.state.contextKey.value).toBeNull();
        expect(test.owner.activeTaskRefs).toEqual([]);
        expect(JSON.stringify(test.owner.completedTaskEnvelopes)).not.toContain('private title');
    });

    it('observes supersession by the existing shared task owner without starting a second registry', async () => {
        const test = harness();
        const pending = deferred<typeof page>();
        const result = test.state.load(() => pending.promise);
        const other = test.owner.beginTask('feature', 'article-links:backlinks', 'article-links-page:v1');
        expect(test.state.status.value).toBe('stale');
        pending.resolve(page);
        expect(await result).toBe(false);
        expect(other.isCurrent()).toBe(true);
        other.cancel();
    });

    it('cancels and unsubscribes on scope disposal; a late page cannot reappear', async () => {
        const test = harness();
        const pending = deferred<typeof page>();
        let signal!: AbortSignal;
        const result = test.state.load(input => { signal = input; return pending.promise; });
        test.scope.stop();
        expect(signal.aborted).toBe(true);
        pending.resolve(page);
        expect(await result).toBe(false);
        expect(test.state.status.value).toBe('unavailable');
        expect(await test.state.load(async () => page)).toBe(false);
    });

    it('cancels when the original document owner is disposed', async () => {
        const test = harness();
        const pending = deferred<typeof page>();
        const result = test.state.load(() => pending.promise);
        test.owner.dispose();
        pending.resolve(page);
        expect(await result).toBe(false);
        expect(test.state.status.value).toBe('unavailable');
        expect(await test.state.load(async () => page)).toBe(false);
    });

    it('rejects a binding from another actual owner even with identical source bytes', async () => {
        const first = harness();
        const other = harness();
        first.runtime.value = other.binding;
        expect(await first.state.load(async () => page)).toBe(false);
        expect(first.state.status.value).toBe('unavailable');
    });
});
