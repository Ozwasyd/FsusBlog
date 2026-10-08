// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { ElMarkdownEditor, type MarkdownEditorDispatchResult, type MarkdownEditorTransaction } from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import {
    ArticleAnchorContextAdapter,
    articleScrollIntentPolicy,
    validateArticleAnchorCommand,
    validateArticleAnchorContext,
    type ArticleAnchorCaptureOptions,
    type ArticleAnchorOrigin,
    type ArticleManualScrollKind
} from '@/services/authoring/articleAnchorContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()));
const defaults: ArticleAnchorCaptureOptions = {
    affinity: 'after', viewportOffset: 130, percentage: 0.4, surface: 'live', tool: 'none'
};

function open(source = 'abcdef')
{
    const owner = createArticleDocumentContextAdapter({
        articleId: 1, draftId: 'article:1', editorSessionId: 'session:anchor',
        siteScope: 'site:test', userScope: 'user:test', content: source
    });
    const adapter = new ArticleAnchorContextAdapter(owner);
    const wrapper = mount(ElMarkdownEditor, {
        props: { modelValue: source, mode: 'source', documentIdentity: owner.documentIdentity }
    });
    cleanup.push(() => wrapper.unmount());
    const commands = wrapper.vm as unknown as {
        dispatchTransaction(input: MarkdownEditorTransaction): MarkdownEditorDispatchResult;
        undo(): MarkdownEditorDispatchResult;
        redo(): MarkdownEditorDispatchResult;
    };
    const binding = () => ({
        document: owner.context,
        map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source })
    });
    const accept = (result: MarkdownEditorDispatchResult) =>
    {
        expect(result.accepted).toBe(true);
        source = result.value;
        owner.updateSource(source, result.revision);
        return result;
    };
    const dispatch = (changes: MarkdownEditorTransaction['changes']) => accept(commands.dispatchTransaction({
        changes, documentIdentity: owner.documentIdentity, expectedRevision: owner.context.sourceRevision,
        history: 'separate', origin: 'programmatic'
    }));
    const capture = (start = 1, end = 5, options = defaults, direction: 'none' | 'forward' | 'backward' = 'forward') =>
        adapter.capture(binding(), { start, end, direction }, options);
    const restore = (saved: ReturnType<typeof capture>, transactions?: readonly MarkdownEditorDispatchResult[], origin: ArticleAnchorOrigin = 'refresh', now = 200) =>
        adapter.restore(saved, binding(), { origin, now, viewportHeight: 500, reducedMotion: false, transactions });
    return { owner, adapter, commands, binding, accept, dispatch, capture, restore };
}

describe('ArticleAnchorContextAdapter (#2246) real public map consumption', () =>
{
    it.each([0, 100])('restores all semantic kinds with %i headings, without a heading authority', headings =>
    {
        const source = [
            ...Array.from({ length: headings }, (_, index) => `# Heading ${index}\n`),
            'paragraph\n', '- list\n', '| a | b |\n|---|---|\n| c | d |\n',
            '```ts\nlet x = 1\n```\n', '![alt](https://example.test/a.png)\n',
            '```mermaid\ngraph TD; A-->B;\n```\n', '$$x^2$$\n'
        ].join('\n');
        const editor = open(source);
        const binding = editor.binding();
        for (const kind of ['paragraph', 'list', 'table', 'code', 'image', 'mermaid', 'latex', ...(headings ? ['heading'] : [])])
        {
            const node = binding.map.syntax.find(item => item.id.includes(`:${kind}:`));
            expect(node, kind).toBeDefined();
            if (!node) throw new Error('missing public syntax kind');
            const saved = editor.capture(node.start, node.end, defaults, 'backward');
            expect(validateArticleAnchorContext(saved)).toBe(true);
            const receipt = editor.restore(saved);
            expect(receipt).toMatchObject({ status: 'ready', kind: 'exact', direction: 'backward', range: { start: node.start, end: node.end }, approximate: false });
            expect(validateArticleAnchorCommand(receipt)).toBe(true);
            expect(binding.map.syntax.some(item => item.id === receipt.nodeId)).toBe(true);
            expect(receipt.beforeAnchor).toEqual(saved);
            expect(receipt.nodeId).toBe(saved.nodeId);
        }
    });

    it.each(['refresh', 'surface', 'tool', 'outline', 'search', 'attachment', 'typewriter'] as const)(
        'shares context commands for %s without writing document or preference state', origin =>
        {
            const editor = open();
            const context = editor.owner.context;
            for (const surface of ['live', 'source'] as const)
            {
                for (const tool of ['none', 'publish-preview', 'source-compare'] as const)
                {
                    const saved = editor.capture(1, 5, { ...defaults, surface, tool });
                    expect(editor.restore(saved, undefined, origin)).toMatchObject({ status: 'ready', origin, surface, tool, viewportOffset: 130 });
                }
            }
            expect(editor.owner.context).toBe(context);
        }
    );

    it('rebases contiguous public dispatch, undo and redo maps and rejects missing or stale chains', () =>
    {
        const editor = open();
        const saved = editor.capture(2, 4);
        const first = editor.dispatch([{ from: 0, to: 0, insert: 'X' }, { from: 6, to: 6, insert: 'Y' }]);
        expect(editor.restore(saved, [first])).toMatchObject({ status: 'ready', kind: 'rebased', range: { start: 3, end: 5 }, rebase: ['mapped'] });
        const undo = editor.accept(editor.commands.undo());
        const redo = editor.accept(editor.commands.redo());
        expect(editor.restore(saved, [first, undo, redo])).toMatchObject({ status: 'ready', range: { start: 3, end: 5 }, rebase: ['mapped', 'mapped', 'mapped'] });
        expect(editor.restore(saved).reason).toBe('source-revision-unmapped');
        expect(editor.restore(saved, [first, redo]).reason).toBe('transaction-chain-invalid');
        expect(editor.restore(saved, [{ ...first, positionMap: undefined }]).reason).toBe('transaction-chain-invalid');
        expect(editor.restore(saved, [{ ...first, documentIdentity: { ...first.documentIdentity, epoch: 99 } }]).reason).toBe('transaction-chain-invalid');
        expect(editor.restore(saved, [first, undo, { ...redo, value: 'tampered' }]).reason).toBe('source-revision-unmapped');
    });

    it.each(['before', 'after'] as const)('retains collapsed caret %s association from the public map', affinity =>
    {
        const editor = open();
        const saved = editor.capture(2, 2, { ...defaults, affinity }, 'none');
        const result = editor.dispatch([{ from: 2, to: 2, insert: 'XX' }]);
        const point = result.positionMap?.map(2, affinity === 'before' ? -1 : 1);
        expect(editor.restore(saved, [result])).toMatchObject({ status: 'ready', range: { start: point, end: point }, affinity });
    });

    it('fails closed with a receipt when a real dispatch map is missing, throws, or reports invalid bounds', () =>
    {
        const editor = open();
        const saved = editor.capture();
        const result = editor.dispatch([{ from: 0, to: 0, insert: 'X' }]);
        if (!result.positionMap) throw new Error('public map missing');
        const missing = { ...result, positionMap: { ...result.positionMap, map: undefined } } as unknown as MarkdownEditorDispatchResult;
        expect(editor.restore(saved, [missing]).reason).toBe('transaction-chain-invalid');
        const throwing = { ...result, positionMap: { ...result.positionMap, mapRange: () => { throw new Error('interrupted public map'); } } };
        const failed = editor.restore(saved, [throwing]);
        expect(failed.reason).toBe('public-position-map-invalid');
        expect(validateArticleAnchorCommand(failed)).toBe(true);
        const invalid = { ...result, positionMap: { ...result.positionMap, map: () => -1 } };
        expect(editor.restore(saved, [invalid]).reason).toBe('mapped-point-invalid');
    });

    it('uses explicit partial, deleted semantic-neighbor and approximate percentage outcomes', () =>
    {
        const partial = open();
        const savedPartial = partial.capture();
        const removed = partial.dispatch([{ from: 2, to: 4, insert: '' }]);
        expect(partial.restore(savedPartial, [removed])).toMatchObject({ status: 'ready', kind: 'partial', range: { start: 1, end: 3 }, rebase: ['partial'] });
        const full = open();
        const savedFull = full.capture();
        const deleted = full.dispatch([{ from: 1, to: 5, insert: '' }]);
        expect(full.restore(savedFull, [deleted])).toMatchObject({ status: 'ready', kind: 'semantic-neighbor', rebase: ['deleted'], approximate: false });
        const empty = open();
        const savedEmpty = empty.capture(0, 6);
        const allDeleted = empty.dispatch([{ from: 0, to: 6, insert: '' }]);
        expect(empty.restore(savedEmpty, [allDeleted])).toMatchObject({ status: 'ready', kind: 'percentage', approximate: true, percentage: 0.4, range: null, nodeId: null });
        expect(validateArticleAnchorCommand(empty.restore(savedEmpty, [allDeleted]))).toBe(true);
    });

    it.each(['wheel', 'trackpad', 'touch', 'drag', 'selection'] as ArticleManualScrollKind[])(
        'honors manual %s intent, explicit input/navigation and machine-readable idle resume', kind =>
        {
            const editor = open();
            const saved = editor.capture();
            editor.adapter.manual(kind, 'renderer', 100);
            for (const origin of ['refresh', 'typewriter', 'sync'] as const)
                expect(editor.restore(saved, undefined, origin)).toMatchObject({ status: 'paused', reason: 'user-scroll-priority' });
            expect(editor.adapter.resume('idle', 100 + articleScrollIntentPolicy.idleResumeMs - 1)).toBe(false);
            expect(editor.adapter.resume('idle', 100 + articleScrollIntentPolicy.idleResumeMs)).toBe(true);
            expect(editor.restore(saved, undefined, 'refresh', 1400).status).toBe('ready');
            editor.adapter.manual(kind, 'source', 1500);
            expect(editor.adapter.resume('input', 1501)).toBe(true);
            editor.adapter.manual(kind, 'source', 1600);
            expect(editor.adapter.resume('navigation', 1601)).toBe(true);
            expect(() => editor.adapter.manual(kind, 'source', 1599)).toThrow('article-anchor-time-invalid');
        }
    );

    it('disables synchronization by default and rejects feedback, debounce, foreign context and non-driving panes', () =>
    {
        const editor = open();
        const saved = editor.capture();
        const sync = (pane: 'source' | 'renderer', now: number, generation: number | null = null, document = editor.owner.context) =>
            editor.adapter.synchronize({ pane, now, generation, document }, saved, editor.binding(), { height: 500, reducedMotion: false });
        expect(sync('source', 1)).toBeNull();
        editor.adapter.setSynchronization(true);
        const first = sync('source', 100);
        expect(first?.target).toBe('renderer');
        expect(first?.command).toMatchObject({ status: 'ready', origin: 'sync' });
        expect(sync('renderer', 101, first?.command.generation)).toBeNull();
        expect(sync('source', 101)).toBeNull();
        expect(sync('source', 116)?.command.status).toBe('ready');
        editor.adapter.manual('wheel', 'renderer', 200);
        expect(sync('source', 201)).toBeNull();
        expect(sync('renderer', 201)).toBeNull();
        editor.adapter.resume('navigation', 202);
        expect(sync('source', 220)).toBeNull();
        expect(sync('renderer', 220)?.target).toBe('source');
        editor.adapter.setSynchronization(false);
        expect(sync('renderer', 300)).toBeNull();
        expect(sync('source', 301, null, { ...editor.owner.context, contextDigest: '0'.repeat(64) })).toBeNull();
    });

    it('retains exact range under reduced motion and reachable offsets in a soft keyboard viewport', () =>
    {
        const editor = open();
        const saved = editor.capture(1, 5, { ...defaults, viewportOffset: 900 });
        expect(editor.adapter.restore(saved, editor.binding(), { origin: 'attachment', now: 10, viewportHeight: 180, reducedMotion: true })).toMatchObject({ status: 'ready', behavior: 'instant', viewportOffset: 180, range: { start: 1, end: 5 } });
        expect(() => editor.adapter.restore(saved, editor.binding(), { origin: 'refresh', now: 10, viewportHeight: 0, reducedMotion: true })).toThrow();
    });

    it('rejects source/map/context tamper, extra fields and same-source foreign article/epoch; cleans up on switch', () =>
    {
        const editor = open();
        const saved = editor.capture();
        expect(validateArticleAnchorContext({ ...saved, percentage: 0.9 })).toBe(false);
        expect(validateArticleAnchorContext({ ...saved, extra: true })).toBe(false);
        expect(validateArticleAnchorContext({ ...saved, range: { start: -1, end: 5 } })).toBe(false);
        const receipt = editor.restore(saved);
        expect(validateArticleAnchorCommand({ ...receipt, approximate: true })).toBe(false);
        expect(validateArticleAnchorCommand({ ...receipt, beforeAnchor: { ...saved, tool: 'source-compare' } })).toBe(false);
        expect(() => editor.capture(1, 5, { ...defaults, extra: true } as ArticleAnchorCaptureOptions)).toThrow();
        const mapTamper = { document: editor.owner.context, map: createMarkdownAnchorMap({ identity: editor.owner.documentIdentity, source: 'ghijkl' }) };
        expect(editor.adapter.restore(saved, mapTamper, { origin: 'refresh', now: 200, viewportHeight: 500, reducedMotion: false }).reason).toBe('map-binding-invalid');
        const foreignMap = { document: editor.owner.context, map: createMarkdownAnchorMap({ identity: { ...editor.owner.documentIdentity, epoch: 99 }, source: 'abcdef' }) };
        expect(() => editor.adapter.capture(foreignMap, { start: 1, end: 5, direction: 'forward' }, defaults)).toThrow();
        editor.adapter.manual('selection', 'source', 300);
        editor.adapter.setSynchronization(true);
        editor.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: 'abcdef', reason: 'article-switch' });
        expect(editor.adapter.receipts).toEqual([]);
        expect(editor.adapter.userIntent.state).toBe('automatic');
        expect(editor.restore(saved).reason).toBe('document-mismatch');
        expect(editor.owner.context.contentDigest).toBe(saved.document.contentDigest);
    });

    it('bounds receipt retention and keeps cloned receipt mutations out of the owner', () =>
    {
        const editor = open();
        const saved = editor.capture();
        for (let now = 1; now <= 70; now++) editor.restore(saved, undefined, 'refresh', now);
        expect(editor.adapter.receipts).toHaveLength(64);
        const copied = editor.adapter.receipts[0];
        if (!copied?.range) throw new Error('missing receipt');
        Object.assign(copied.range, { start: 99 });
        expect(validateArticleAnchorCommand(copied)).toBe(false);
        expect(editor.adapter.receipts.every(validateArticleAnchorCommand)).toBe(true);
    });
});
