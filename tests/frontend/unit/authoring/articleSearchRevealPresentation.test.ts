// @vitest-environment happy-dom

import { ElMarkdownEditor, type MarkdownEditorDispatchResult, type MarkdownEditorTransaction } from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import ArticleSearchRevealStatus from '@/components/admin/article/ArticleSearchRevealStatus.vue';
import { ArticleAnchorContextAdapter, type ArticleAnchorOrigin } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter } from '@/services/authoring/articleAttachmentContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { bindArticleEditorRuntime } from '@/services/authoring/articleEditorRuntimeBinding';
import { projectArticleSearchReveal } from '@/services/authoring/articleSearchRevealPresentation';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()));

const revealLabels = {
    label: 'Source reveal',
    statusLabels: { ready: 'Command available', paused: 'Paused', rejected: 'Unavailable', unavailable: 'Unavailable' },
    precisionLabels: {
        exact: 'Exact source range', rebased: 'Mapped after edits', partial: 'Partial source range',
        'semantic-neighbor': 'Nearby semantic position', percentage: 'Approximate percentage'
    }
};

function open(initialSource = 'abcdef')
{
    let source = initialSource;
    const owner = createArticleDocumentContextAdapter({
        articleId: 1, draftId: 'article:1', editorSessionId: 'session:search',
        siteScope: 'site:test', userScope: 'user:test', content: source
    });
    const anchor = new ArticleAnchorContextAdapter(owner);
    const wrapper = mount(ElMarkdownEditor, {
        props: { modelValue: source, mode: 'source', documentIdentity: owner.documentIdentity }
    });
    cleanup.push(() => wrapper.unmount());
    const editor = wrapper.vm as unknown as {
        dispatchTransaction(input: MarkdownEditorTransaction): MarkdownEditorDispatchResult;
    };
    const binding = () => ({
        document: owner.context,
        map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source })
    });
    const attachments = new ArticleAttachmentContextAdapter(owner, 'search:test-attachments', 'search:test-v1', anchor);
    const runtime = bindArticleEditorRuntime(owner, anchor, attachments, {
        dispatch: input => editor.dispatchTransaction(input),
        commitSource: result =>
        {
            source = result.value;
            owner.updateSource(source, result.revision);
        },
        binding
    }, () => source, editor, {
        surface: 'source', configuration: { allowLatex: true, allowMermaid: true, baseUrl: null },
        identity: { themeDigest: owner.context.contentDigest, locale: 'zh-CN' },
        cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 }
    });
    cleanup.push(() =>
    {
        runtime.dispose();
        attachments.dispose();
        owner.dispose();
    });
    const saved = anchor.capture(binding(), { start: 1, end: 5, direction: 'forward' }, {
        affinity: 'after', viewportOffset: 40, percentage: 0.4, surface: 'source', tool: 'none'
    });
    const dispatch = (changes: MarkdownEditorTransaction['changes']) =>
    {
        const result = editor.dispatchTransaction({
            changes, documentIdentity: owner.documentIdentity, expectedRevision: owner.context.sourceRevision,
            history: 'separate', origin: 'programmatic'
        });
        expect(result.accepted).toBe(true);
        source = result.value;
        owner.updateSource(source, result.revision);
        return result;
    };
    const restore = (transactions?: readonly MarkdownEditorDispatchResult[], origin: ArticleAnchorOrigin = 'search') =>
        anchor.restore(saved, binding(), { origin, now: 200, viewportHeight: 500, reducedMotion: true, transactions });
    const lease = () => owner.beginTask('search', 'search:reveal-presentation');
    return { owner, anchor, runtime, dispatch, restore, lease };
}

describe('global search canonical reveal presentation (#2319)', () =>
{
    it('preserves the exact original command identity and does not execute or write history', () =>
    {
        const state = open();
        const command = state.restore();
        const receipts = state.anchor.receipts;
        const context = state.owner.context;
        const lease = state.lease();
        const result = projectArticleSearchReveal(command, state.runtime, lease);
        expect(result).toEqual({
            status: 'ready', precision: 'exact', exact: true, approximate: false,
            reason: null, commandDigest: command.contentDigest
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(state.anchor.receipts).toEqual(receipts);
        expect(state.owner.context).toBe(context);
        expect(Object.keys(result)).not.toContain('command');
    });

    it.each([
        ['rebased', [{ from: 0, to: 0, insert: 'X' }]],
        ['partial', [{ from: 2, to: 4, insert: '' }]],
        ['semantic-neighbor', [{ from: 1, to: 5, insert: '' }]],
        ['percentage', [{ from: 0, to: 6, insert: '' }]]
    ] as const)('keeps real public %s outcomes distinct from exact success', (precision, changes) =>
    {
        const state = open();
        const transaction = state.dispatch([...changes]);
        const command = state.restore([transaction]);
        expect(command.kind).toBe(precision);
        expect(projectArticleSearchReveal(command, state.runtime, state.lease())).toMatchObject({
            status: 'ready', precision, exact: false, approximate: precision === 'percentage',
            commandDigest: command.contentDigest
        });
    });

    it('retains manual-scroll refusal and the canonical stale-chain reason', () =>
    {
        const state = open();
        state.anchor.manual('touch', 'renderer', 100);
        const paused = state.restore();
        expect(projectArticleSearchReveal(paused, state.runtime, state.lease())).toMatchObject({
            status: 'paused', precision: null, exact: false, reason: 'user-scroll-priority'
        });
        state.anchor.resume('navigation', 101);
        state.dispatch([{ from: 0, to: 0, insert: 'X' }]);
        expect(projectArticleSearchReveal(state.restore(), state.runtime, state.lease())).toMatchObject({
            status: 'rejected', precision: null, exact: false, reason: 'source-revision-unmapped'
        });
    });

    it.each(['source', 'article', 'site', 'user', 'dispose'] as const)(
        'rejects a late exact command after %s identity changes', change =>
        {
            const state = open();
            const command = state.restore();
            const lease = state.lease();
            if (change === 'source')
            {
                state.dispatch([{ from: 0, to: 0, insert: 'X' }]);
            }
            else if (change === 'dispose')
            {
                state.owner.dispose();
            }
            else
            {
                state.owner.switchDocument({
                    articleId: change === 'article' ? 2 : 1,
                    draftId: 'article:1', content: 'abcdef',
                    siteScope: change === 'site' ? 'site:other' : 'site:test',
                    userScope: change === 'user' ? 'user:other' : 'user:test'
                });
            }
            expect(projectArticleSearchReveal(command, state.runtime, lease)).toEqual({
                status: 'rejected', precision: null, exact: false, approximate: false,
                reason: change === 'dispose' ? 'search-reveal-lease-stale' : 'search-reveal-context-stale', commandDigest: null
            });
        }
    );

    it.each(['outline', 'refresh', 'sync', 'attachment'] as const)(
        'refuses to present %s as a search reveal', origin =>
        {
            const state = open();
            expect(projectArticleSearchReveal(state.restore(undefined, origin), state.runtime, state.lease())).toMatchObject({
                status: 'rejected', precision: null, reason: 'search-reveal-origin-mismatch', commandDigest: null
            });
        }
    );

    it('rejects mutated precision, context, ranges, receipt fields and malformed input without raw payloads', () =>
    {
        const state = open();
        const command = state.restore();
        const secret = 'PRIVATE_QUERY_NOT_FOR_PRESENTATION';
        for (const invalid of [
            null, {}, { ...command, kind: 'percentage' }, { ...command, approximate: true },
            { ...command, document: { ...command.document, articleId: 2 } },
            { ...command, range: { start: 999, end: 1000 } },
            { ...command, reason: secret }, { ...command, extra: secret }
        ])
        {
            const result = projectArticleSearchReveal(invalid, state.runtime, state.lease());
            expect(result).toMatchObject({
                status: 'rejected', precision: null, exact: false, reason: 'search-reveal-command-invalid', commandDigest: null
            });
            expect(JSON.stringify(result)).not.toContain(secret);
        }
    });

    it.each(['evaluation', 'candidate', 'raw-range', 'snippet-evaluation', 'snippet-evidence'] as const)(
        'does not promote unadmitted internal index %s evidence to an exact source reveal', kind =>
        {
            const state = open();
            const lease = state.lease();
            const receipts = state.anchor.receipts;
            const context = state.owner.context;
            // Untrusted boundary samples, not a production response or a wire codec.
            // Record names follow the original evaluator/snippet stage at aa67f03.
            const privateEpoch = 'PRIVATE_INTERNAL_SOURCE_EPOCH';
            const privateText = 'PRIVATE_INTERNAL_SNIPPET_TEXT';
            const range = {
                Authority: 'fsusui.markdown-source-coordinate-map', ParserVersion: 'explicit-algorithm-fixture',
                DocumentEpoch: privateEpoch, SourceRevision: 1, SourceDigest: `sha256:${'0'.repeat(64)}`,
                Utf16Start: 1, Utf16End: 5, Utf8Start: 1, Utf8End: 5
            };
            const candidate = {
                Document: { Identity: { Permission: 1 } }, Ranges: [range],
                PhraseClauses: 1, MatchedRanges: 1, FieldWeight: 10
            };
            const evaluation = {
                QueryDigest: `sha256:${'1'.repeat(64)}`, IndexGeneration: 1, SourceGeneration: 1,
                SnapshotDigest: `sha256:${'2'.repeat(64)}`, Candidates: [candidate]
            };
            const snippetEvidence = {
                Document: candidate.Document,
                Snippet: {
                    DocumentDigest: `sha256:${'3'.repeat(64)}`, SourceDigest: range.SourceDigest,
                    Field: 2, HeadingIdentity: null, Context: range, Highlights: [range],
                    TruncatedBefore: true, TruncatedAfter: true
                },
                RawText: privateText, RawTextDigest: `sha256:${'4'.repeat(64)}`
            };
            const snippetEvaluation = {
                QueryDigest: evaluation.QueryDigest, IndexGeneration: evaluation.IndexGeneration,
                SourceGeneration: evaluation.SourceGeneration, SnapshotDigest: evaluation.SnapshotDigest,
                Snippets: [snippetEvidence]
            };
            const inputs = {
                evaluation, candidate, 'raw-range': range,
                'snippet-evaluation': snippetEvaluation, 'snippet-evidence': snippetEvidence
            };
            const input = inputs[kind];
            const result = projectArticleSearchReveal(input, state.runtime, lease);
            expect(result).toEqual({
                status: 'rejected', precision: null, exact: false, approximate: false,
                reason: 'search-reveal-command-invalid', commandDigest: null
            });
            expect(JSON.stringify(result)).not.toContain(privateEpoch);
            expect(JSON.stringify(result)).not.toContain(privateText);
            expect(state.owner.context).toBe(context);
            expect(state.anchor.receipts).toEqual(receipts);
            expect(lease.isCurrent()).toBe(true);
        }
    );

    it.each(['cancel', 'supersede', 'complete', 'other-kind', 'other-document'] as const)(
        'rejects a canonical lease after %s without promoting an exact command', action =>
        {
            const state = open();
            const command = state.restore();
            let lease = state.lease();
            if (action === 'cancel')
            {
                lease.cancel('search-panel-closed');
            }
            else if (action === 'supersede')
            {
                state.lease();
            }
            else if (action === 'complete')
            {
                lease.complete();
            }
            else if (action === 'other-kind')
            {
                lease = state.owner.beginTask('outline', 'outline:other');
            }
            else
            {
                lease = open().lease();
            }
            expect(projectArticleSearchReveal(command, state.runtime, lease)).toMatchObject({
                status: 'rejected', precision: null, exact: false,
                reason: 'search-reveal-lease-stale', commandDigest: null
            });
        }
    );

    it('rejects the released canonical runtime even while its document/search lease is current', () =>
    {
        const state = open();
        const command = state.restore();
        const lease = state.lease();
        state.runtime.dispose();
        expect(lease.isCurrent()).toBe(true);
        expect(projectArticleSearchReveal(command, state.runtime, lease)).toMatchObject({
            status: 'rejected', precision: null, exact: false,
            reason: 'search-reveal-binding-unavailable', commandDigest: null
        });
    });

    it.each([
        ['exact', undefined],
        ['rebased', [{ from: 0, to: 0, insert: 'X' }]],
        ['partial', [{ from: 2, to: 4, insert: '' }]],
        ['semantic-neighbor', [{ from: 1, to: 5, insert: '' }]],
        ['percentage', [{ from: 0, to: 6, insert: '' }]]
    ] as const)('renders actual canonical %s availability without claiming a completed jump', (precision, changes) =>
    {
        const state = open();
        const transactions = changes ? [state.dispatch([...changes])] : undefined;
        const presentation = projectArticleSearchReveal(state.restore(transactions), state.runtime, state.lease());
        const view = mount(ArticleSearchRevealStatus, { props: { ...revealLabels, presentation } });
        cleanup.push(() => view.unmount());
        const output = view.get('output');
        expect(output.text()).toContain(revealLabels.statusLabels.ready);
        expect(output.text()).toContain(revealLabels.precisionLabels[precision]);
        expect(output.attributes()).toMatchObject({ role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
        expect(view.findAll('button, a, input, textarea')).toHaveLength(0);
        expect(view.text()).not.toContain(presentation.commandDigest);
        expect(view.emitted()).toEqual({});
    });

    it('updates from paused to available to canceled and removes the old precision label', async () =>
    {
        const state = open();
        state.anchor.manual('touch', 'renderer', 100);
        const lease = state.lease();
        const view = mount(ArticleSearchRevealStatus, {
            props: { ...revealLabels, presentation: projectArticleSearchReveal(state.restore(), state.runtime, lease) }
        });
        cleanup.push(() => view.unmount());
        expect(view.text()).toContain('Paused');
        state.anchor.resume('navigation', 101);
        await view.setProps({ presentation: projectArticleSearchReveal(state.restore(), state.runtime, lease) });
        expect(view.text()).toContain('Exact source range');
        lease.cancel('search-panel-closed');
        await view.setProps({ presentation: projectArticleSearchReveal(state.restore(), state.runtime, lease) });
        expect(view.text()).toContain('Unavailable');
        expect(view.text()).not.toContain('Exact source range');
        expect(view.text()).not.toContain('search-reveal-lease-stale');
    });

    it('escapes localized labels and withholds invalid private payloads from visible and accessible output', () =>
    {
        const state = open();
        const secret = 'PRIVATE_INTERNAL_QUERY_PAYLOAD';
        for (const evidence of [{ Candidates: [secret] }, { Snippets: [{ RawText: secret }] }])
        {
            const presentation = projectArticleSearchReveal(evidence, state.runtime, state.lease());
            const view = mount(ArticleSearchRevealStatus, {
                props: {
                    ...revealLabels, presentation, label: '原文定位',
                    statusLabels: { ...revealLabels.statusLabels, rejected: '<img src=x onerror=alert(1)> 无法定位' }
                }
            });
            cleanup.push(() => view.unmount());
            expect(view.get('output').attributes('aria-label')).toBe('原文定位');
            expect(view.text()).toContain('<img src=x onerror=alert(1)> 无法定位');
            expect(view.find('img').exists()).toBe(false);
            expect(view.html()).not.toContain(secret);
            expect(view.text()).not.toContain(presentation.reason);
        }
    });
});
