// @vitest-environment happy-dom

import {
    ElMarkdownEditor,
    type MarkdownEditorDispatchResult,
    type MarkdownEditorTransaction,
    type MarkdownEditorTransactionEvent
} from '@ozwasyd/element-plus';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite';
import {
    createArticleEditorContinuityAcknowledgement,
    type ArticleEditorContinuityReceipt
} from '@/services/authoring/articleEditorContinuity';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

// Only network/bootstrap dependencies are replaced. The writer, document,
// attachment, continuity, cache, render producer and public editor are real.
const boot = vi.hoisted(() => ({ principalId: '', push: vi.fn() }));
vi.mock('vue-router', () => ({
    useRoute: () => ({ params: {}, query: {} }),
    useRouter: () => ({ push: boot.push })
}));
vi.mock('@/store/admin', () => ({
    useAdminStore: () => ({
        setPageTitle: vi.fn(),
        adminPrincipal: { id: boot.principalId, username: 'integration-owner' }
    })
}));
vi.mock('@/api/article', () => ({
    ArticlePublishStatus: { Draft: 0, Published: 1, Scheduled: 2, Private: 3 },
    createArticle: vi.fn(),
    updateArticle: vi.fn(),
    getAdminArticleById: vi.fn()
}));
vi.mock('@/api/authoring', () => ({
    saveServerDraft: vi.fn().mockResolvedValue({ clientRevision: 'integration:boot', serverRevision: 1, savedAt: 0, updatedAt: '2026-10-08T00:00:00Z' }),
    getServerDraft: vi.fn().mockResolvedValue(null),
    discardServerDraft: vi.fn(),
    checkArticlePrepublish: vi.fn(),
    generateAiAssist: vi.fn(),
    createArticlePreviewSourceIdentity: vi.fn(),
    cleanupOrphanAssets: vi.fn(),
    listAssetLibrary: vi.fn().mockResolvedValue([]),
    listArticleRevisions: vi.fn().mockResolvedValue([]),
    getArticleRevision: vi.fn(),
    rollbackArticleRevision: vi.fn(),
    reindexArticleAssets: vi.fn(),
    previewArticleDraft: vi.fn()
}));
vi.mock('@/api/category', () => ({ getCategories: vi.fn().mockResolvedValue([]), createCategory: vi.fn() }));
vi.mock('@/api/tag', () => ({ getTags: vi.fn().mockResolvedValue([]), createTag: vi.fn() }));
vi.mock('@/api/system', () => ({
    getAdminSiteConfig: vi.fn().mockResolvedValue({ siteName: 'Integration', baseUrl: 'https://fsusblog.test', enableArticleRights: false, rights: {} }),
    getAdminSiteComplianceConfig: vi.fn().mockResolvedValue({})
}));

const cleanups: (() => void)[] = [];
let principalSequence = 0;
const captureOptions = {
    affinity: 'after' as const,
    viewportOffset: 0,
    percentage: 0,
    surface: 'source' as const,
    tool: 'none' as const
};
const restoreOptions = { origin: 'tool' as const, now: 100, viewportHeight: 500, reducedMotion: true };
const bindingOptions = {
    surface: 'source' as const,
    configuration: { allowLatex: true, allowMermaid: true, baseUrl: null },
    identity: { themeDigest: digest({ theme: 'integration' }), locale: 'zh-CN' },
    cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 }
};

beforeEach(() => {
    boot.principalId = `writer-composed-integration-${++principalSequence}`;
});
afterEach(() => {
    cleanups.splice(0).reverse().forEach(cleanup => cleanup());
    vi.restoreAllMocks();
});

async function openWriter()
{
    let authoring!: ReturnType<typeof useAdminArticleWrite>;
    const host = mount(defineComponent({
        setup() {
            authoring = useAdminArticleWrite();
            return {};
        },
        template: '<div />'
    }));
    cleanups.push(() => host.unmount());
    await vi.waitFor(async () => {
        await flushPromises();
        expect(authoring.pageLoading.value).toBe(false);
    }, { timeout: 3000 });

    type Session = ReturnType<typeof authoring.authoringEditorRuntime.bindEditor>;
    type Commands = {
        dispatchTransaction(transaction: MarkdownEditorTransaction): MarkdownEditorDispatchResult;
        undo(): MarkdownEditorDispatchResult;
        redo(): MarkdownEditorDispatchResult;
    };
    let session: Session | null = null;
    const changed: MarkdownEditorDispatchResult[] = [];
    const consumed: boolean[] = [];
    const editor = mount(ElMarkdownEditor, {
        attachTo: document.body,
        props: {
            modelValue: authoring.articleForm.content,
            mode: 'source',
            documentIdentity: authoring.authoringDocumentIdentity.value,
            'onUpdate:modelValue': (value: string) => {
                authoring.articleForm.content = value;
            },
            onTransaction: (result: MarkdownEditorTransactionEvent) => {
                if (session)
                {
                    consumed.push(session.binding.consumeTransaction(result));
                }
                if (result.accepted && result.revision > result.beforeRevision)
                {
                    changed.push(result);
                }
            }
        }
    });
    const commands = editor.vm as unknown as Commands;
    session = authoring.authoringEditorRuntime.bindEditor(commands, bindingOptions);
    const runtime = session.binding;
    const focusIn = () => runtime.consumeFocus('focusin');
    const focusOut = () => runtime.consumeFocus('focusout');
    editor.element.addEventListener('focusin', focusIn);
    editor.element.addEventListener('focusout', focusOut);
    cleanups.push(() => {
        session?.release();
        editor.element.removeEventListener('focusin', focusIn);
        editor.element.removeEventListener('focusout', focusOut);
        editor.unmount();
    });
    expect(runtime.initialize()).toBe(true);
    const textarea = () => editor.get('textarea').element as HTMLTextAreaElement;
    const observe = async () => {
        await nextTick();
        await nextTick();
        textarea().focus();
        expect(document.activeElement).toBe(textarea());
    };
    const dispatch = (transaction: Omit<MarkdownEditorTransaction, 'documentIdentity' | 'expectedRevision'>) => {
        const result = commands.dispatchTransaction({ documentIdentity: authoring.authoringDocumentIdentity.value,
            expectedRevision: runtime.context.sourceRevision, ...transaction });
        expect(result.accepted).toBe(true);
        expect(consumed.at(-1)).toBe(true);
        return result;
    };
    const attachment = authoring.authoringAttachmentRuntime;
    const insert = () => {
        const captured = attachment.capture({ origin: 'pick',
            anchor: attachment.captureAnchor({ start: 0, end: 0, direction: 'none' }, captureOptions),
            files: ['one.png', 'two.png'].map(name => ({ name, mimeType: 'image/png', byteLength: 3 })) });
        expect(captured.status).toBe('created');
        return attachment.commitCreated(captured);
    };
    const acknowledge = (receipt: ArticleEditorContinuityReceipt) => {
        const context = runtime.continuity.capture(runtime.positionBinding(), captureOptions);
        const node = textarea();
        const focused = document.activeElement === node;
        return createArticleEditorContinuityAcknowledgement({
            requestRef: receipt.requestRef,
            document: runtime.context,
            instanceRef: runtime.continuity.instanceRef,
            sessionRef: runtime.context.editorSessionId,
            historyRef: context.historyRef,
            history: context.history,
            selection: { start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection },
            surface: receipt.targetSurface,
            tool: receipt.targetTool,
            generation: receipt.anchorCommand!.generation,
            focus: focused ? 'editor' : 'outside',
            focusEvent: focused ? 'focusin' : 'focusout',
            viewportOffset: node.scrollTop
        });
    };
    return { authoring, editor, commands, runtime, attachment, dispatch, insert, changed, consumed, observe, acknowledge,
        release: () => session!.release(),
        rebind: () => {
            session = authoring.authoringEditorRuntime.bindEditor(commands, bindingOptions);
            return session.binding;
        } };
}

describe('Writer composed attachment/tool/owner lifecycle regression', () => {
    it('invalidates an admitted tool restore when another real provider completion commits, preserving undo/redo', async () => {
        const f = await openWriter();
        f.dispatch({ changes: [{ from: 0, to: 0, insert: 'Body abcdef' }], history: 'separate', origin: 'programmatic' });
        const handles = f.insert();
        expect(handles).toHaveLength(2);
        const bodyStart = f.authoring.articleForm.content.indexOf('Body');
        f.dispatch({ changes: [], history: 'skip', origin: 'programmatic', selection: { start: bodyStart, end: bodyStart + 4, direction: 'backward' } });
        await f.observe();
        f.runtime.continuity.setTaskOwners({ search: null, outline: null, diagnostic: null, attachments: f.runtime.attachmentTaskLeases });
        const opened = f.runtime.continuity.toolLifecycle('source-compare-open', f.runtime.positionBinding(), captureOptions, restoreOptions);
        expect(opened.before.stateRefs.attachments).toHaveLength(2);
        const tool = f.runtime.beginToolTask('source-compare');

        const second = handles[1]!;
        expect(f.attachment.complete(second, { ...second.request, status: 'resolved',
            payload: { markdownKind: 'image', href: '/two.png', alt: 'two.png', mimeType: 'image/png' } }).state).toBe('transaction-committed');
        expect(tool.signal.aborted).toBe(true);
        expect(handles[0]!.signal.aborted).toBe(false);
        const firstCompletion = f.changed.at(-1)!;
        const beforeLastCompletion = f.authoring.articleForm.content;
        f.runtime.continuity.setTaskOwners({ search: null, outline: null, diagnostic: null, attachments: f.runtime.attachmentTaskLeases });
        const closed = f.runtime.continuity.toolLifecycle('source-compare-close', f.runtime.positionBinding(),
            { ...captureOptions, tool: 'source-compare' }, { ...restoreOptions, transactions: [firstCompletion] });
        expect(closed.status).toBe('planned');
        const admitted = f.runtime.continuity.apply(closed.requestRef);
        expect(admitted.status).toBe('awaiting-ack');
        await f.observe();
        const lateAck = f.acknowledge(admitted);

        const first = handles[0]!;
        expect(f.attachment.complete(first, { ...first.request, status: 'resolved',
            payload: { markdownKind: 'image', href: '/one.png', alt: 'one.png', mimeType: 'image/png' } }).state).toBe('transaction-committed');
        const completedSource = f.authoring.articleForm.content;
        expect(completedSource).toBe('![one.png](/one.png)\n![two.png](/two.png)Body abcdef');
        expect(f.runtime.continuity.acknowledge(f.commands, lateAck)).toBeNull();
        expect(() => f.runtime.continuity.apply(closed.requestRef)).toThrow('continuity-plan-not-current');
        expect(f.runtime.attachmentTaskLeases).toEqual([]);
        expect(f.commands.undo().value).toBe(beforeLastCompletion);
        expect(f.authoring.articleForm.content).toBe(beforeLastCompletion);
        expect(f.commands.redo().value).toBe(completedSource);
        expect(f.authoring.articleForm.content).toBe(completedSource);
        expect(f.consumed.every(Boolean)).toBe(true);
    });

    it('host release and rebind keep the real editor/owner but deny an old provider capability and old acknowledgement', async () => {
        const f = await openWriter();
        f.dispatch({ changes: [{ from: 0, to: 0, insert: 'Body' }], history: 'separate', origin: 'programmatic' });
        const handle = f.insert()[0]!;
        await f.observe();
        const plan = f.runtime.continuity.transitionSurface('source', f.runtime.positionBinding(), captureOptions, restoreOptions);
        const admitted = f.runtime.continuity.apply(plan.requestRef);
        expect(admitted.status).toBe('awaiting-ack');
        await f.observe();
        const oldAck = f.acknowledge(admitted);
        const before = f.runtime.context;
        const source = f.authoring.articleForm.content;
        const instance = f.editor.vm;
        type ProviderResult = Parameters<typeof f.attachment.complete>[1];
        let resolveProvider!: (result: ProviderResult) => void;
        const providerCompletion = new Promise<ProviderResult>(resolve => {
            resolveProvider = resolve;
        }).then(result => f.attachment.complete(handle, result));
        // The real completion boundary is invoked after release and successor
        // work; only delivery timing is controlled, never the owner's decision.
        const rejectedCompletion = expect(providerCompletion).rejects.toThrow('attachment-pending-handle-invalid');
        f.release();
        expect(handle.signal.aborted).toBe(true);
        expect(handle.snapshot.reason).toBe('article-attachment-editor-release');
        const reopened = f.rebind();
        expect(reopened.initialize()).toBe(true);
        expect(reopened.context.contextDigest).toBe(before.contextDigest);
        expect(reopened.context.documentEpoch).toBe(before.documentEpoch);
        expect(f.editor.vm).toBe(instance);
        expect(reopened.continuity.instanceRef).not.toBe(f.runtime.continuity.instanceRef);
        expect(reopened.continuity.acknowledge(f.commands, oldAck)).toBeNull();
        expect(f.runtime.continuity.acknowledge(f.commands, oldAck)).toBeNull();
        expect(f.runtime.consumeTransaction(f.changed.at(-1)!)).toBe(false);
        expect(f.authoring.articleForm.content).toBe(source);
        expect(reopened.context.contextDigest).toBe(before.contextDigest);
        expect(reopened.attachmentTaskLeases).toEqual([]);

        const freshCapture = f.attachment.capture({ origin: 'pick',
            anchor: f.attachment.captureAnchor({ start: source.length, end: source.length, direction: 'none' }, captureOptions),
            files: [{ name: 'fresh.png', mimeType: 'image/png', byteLength: 4 }] });
        const fresh = f.attachment.commitCreated(freshCapture)[0]!;
        expect(f.attachment.complete(fresh, { ...fresh.request, status: 'resolved',
            payload: { markdownKind: 'image', href: '/fresh.png', alt: 'fresh', mimeType: 'image/png' } }).state).toBe('transaction-committed');
        const freshSource = f.authoring.articleForm.content;
        expect(freshSource).toBe(`${source}![fresh](/fresh.png)`);
        resolveProvider({ ...handle.request, status: 'resolved',
            payload: { markdownKind: 'image', href: '/late-after-fresh.png', mimeType: 'image/png' } });
        await rejectedCompletion;
        expect(f.authoring.articleForm.content).toBe(freshSource);
        expect(reopened.context.documentEpoch).toBe(before.documentEpoch);
        expect(f.commands.undo().value).toBe(`${source}![fresh.png]()`);
        expect(f.commands.redo().value).toBe(freshSource);
    });
});
