// @vitest-environment happy-dom

import {
    ElMarkdownEditor,
    type MarkdownEditorDispatchResult,
    type MarkdownEditorTransaction,
    type MarkdownEditorTransactionEvent
} from '@ozwasyd/element-plus';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick, toRaw, watch } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getServerDraft } from '@/api/authoring';
import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite';
import { articleRecoveryJournal } from '@/services/articleRecoveryJournal';
import {
    createArticleEditorContinuityAcknowledgement,
    type ArticleEditorContinuityReceipt,
    type ArticleEditorMountedSessionPort
} from '@/services/authoring/articleEditorContinuity';
import { articleWorkspaceTabRouter } from '@/services/authoring/articleWorkspaceTabRouter';
import { projectArticleWriterWorkspaceDocument } from '@/services/authoring/articleWriterMountedEditorSource';
import { calculateOpenArticleDocumentDigest as digest, openArticleDocumentCommandSchema } from '@/services/authoring/openArticleDocumentRegistry';

// Only network/bootstrap dependencies are replaced. The writer, document,
// attachment, continuity, cache, render producer and public editor are real.
const boot = vi.hoisted(() => ({ principalId: '', push: vi.fn(), setPrincipal: (_value: string | null) => {} }));
vi.mock('vue-router', () => ({
    useRoute: () => ({ params: {}, query: {} }),
    useRouter: () => ({ push: boot.push })
}));
vi.mock('@/store/admin', async () => {
    const { reactive } = await vi.importActual<typeof import('vue')>('vue');
    return { useAdminStore: () => {
        // Actual reactive bootstrap state; original Writer/document/native owners remain real.
        const state = reactive<{ adminPrincipal: { id: string; username: string; } | null }>({
            adminPrincipal: { id: boot.principalId, username: 'integration-owner' }
        });
        boot.setPrincipal = id => { state.adminPrincipal = id === null ? null : { id, username: 'integration-owner' }; };
        return { setPageTitle: vi.fn(), get adminPrincipal() { return state.adminPrincipal; } };
    } };
});
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
    type Commands = ArticleEditorMountedSessionPort & {
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
    let mountedRead: (() => void) | null = null;
    session = authoring.authoringEditorRuntime.bindEditor(commands, bindingOptions, () => {
        mountedRead?.();
        return commands;
    });
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
        readMount: (callback: (() => void) | null) => { mountedRead = callback; },
        checkpoint: (ref: string) => session!.bindRecoveryCheckpoint(ref),
        associate: () => {
            const registry = articleWorkspaceTabRouter.getRegistry();
            const tabId = `tab:writer-journal-${principalSequence}`;
            const editorSessionRef = `session:writer-journal-${principalSequence}`;
            const id = `writer-journal-${principalSequence}`;
            registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'open-or-activate',
                commandId: `command:open-${id}`, idempotencyKey: `idempotency:open-${id}`,
                expectedRevision: registry.getRevision(), intent: 'workspace', entrypoint: 'direct-route',
                ...projectArticleWriterWorkspaceDocument(authoring.authoringDocumentContextAdapter.context),
                editorSessionRef, tabId, targetGroupId: 'group:primary', tabKind: 'pinned',
                status: { dirty: true, saving: false, conflict: false, recovery: false, pendingAttachments: false,
                    permission: 'allowed', lifecycle: 'current', statusRef: `status:${id}` }, lastActiveAnchorRef: null });
            expect(registry.getEntry(tabId)?.editorSessionRef).toBe(editorSessionRef);
            cleanups.push(() => {
                registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'request-close',
                    commandId: `command:close-${id}`, idempotencyKey: `idempotency:close-${id}`,
                    expectedRevision: registry.getRevision(), tabId });
                registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'detach-on-final-close',
                    commandId: `command:detach-${id}`, idempotencyKey: `idempotency:detach-${id}`,
                    expectedRevision: registry.getRevision(), tabId, closeDecisionRef: `decision:${id}` });
            });
            return editorSessionRef;
        },
        retain: () => {
            const registry = articleWorkspaceTabRouter.getRegistry();
            const context = authoring.authoringDocumentContextAdapter.context;
            const entry = registry.getEntryByIdentity({ articleId: context.articleId, draftId: context.draftId, documentId: context.documentId });
            if (!entry) throw new Error('original-writer-member-unavailable');
            return authoring.authoringRetainedPrimaryRuntime.adoptPrimaryRetainedDocument(registry.issueRetainedDocumentHandle(entry.tabId));
        },
        rebind: () => {
            session = authoring.authoringEditorRuntime.bindEditor(commands, bindingOptions);
            return session.binding;
        } };
}

describe('Writer composed attachment/tool/owner lifecycle regression', () => {
    // Source controls only: NOT RUN under the current product/mount/native holds.
    // Real Writer/mounted editor/registry/journal binding; no token/persistence result is fabricated.
    // Full-draft source counterexamples: UNRUN, genuine form/native/Registry; no fake checkpoint.
    it('refuses preparation without a genuine retained binding and preserves the original committed slot', async () => {
        const f = await openWriter();
        f.associate();
        const draft = f.authoring.authoringDraftCheckpointRuntime;
        const old = draft.captureDraftCheckpoint();
        expect(old).not.toBeNull();
        expect(draft.prepareDraftCheckpoint()).toBeNull();
        expect(draft.inspectDraftReference(old!.draftStateRef)).toBe(old);
    });

    it('prepares and cancels only its actual candidate without replacing the old draft reference', async () => {
        const f = await openWriter();
        f.associate();
        f.retain();
        const draft = f.authoring.authoringDraftCheckpointRuntime;
        const old = draft.captureDraftCheckpoint();
        expect(old).not.toBeNull();
        const prepared = draft.prepareDraftCheckpoint();
        expect(prepared).not.toBeNull();
        expect(prepared!.info.draftStateRef).not.toBe(old!.draftStateRef);
        expect(draft.inspectDraftReference(prepared!.info.draftStateRef)).toBeNull();
        expect(draft.inspectDraftReference(old!.draftStateRef)).toBe(old);
        expect(prepared!.hasCustody()).toBe(true);
        expect(prepared!.cancel()).toBe(true);
        expect(prepared!.cancel()).toBe(false);
        expect(prepared!.validate()).toBe(false);
        expect(prepared!.publish()).toBeNull();
        expect(draft.inspectDraftReference(old!.draftStateRef)).toBe(old);
        const successor = draft.prepareDraftCheckpoint();
        expect(successor).not.toBeNull();
        expect(prepared!.cancel()).toBe(false);
        expect(prepared!.publish()).toBeNull();
        expect(successor!.hasCustody()).toBe(true);
        expect(successor!.cancel()).toBe(true);
    });

    it('publishes one validated same-owner form candidate without native callbacks or form writes', async () => {
        const f = await openWriter();
        f.associate();
        f.retain();
        const draft = f.authoring.authoringDraftCheckpointRuntime;
        const old = draft.captureDraftCheckpoint();
        const prepared = draft.prepareDraftCheckpoint();
        expect(old).not.toBeNull();
        expect(prepared).not.toBeNull();
        expect(prepared!.validate()).toBe(true);
        const context = f.authoring.authoringDocumentContextAdapter.context;
        const content = f.authoring.articleForm.content;
        // Any borrowed mounted callback would fail. Publication must use private custody only.
        f.readMount(() => { throw new Error('publication-invoked-native-reader'); });
        expect(prepared!.publish()).toBe(prepared!.info);
        expect(f.authoring.articleForm.content).toBe(content);
        expect(f.authoring.authoringDocumentContextAdapter.context).toBe(context);
        expect(prepared!.publish()).toBeNull();
        expect(prepared!.cancel()).toBe(false);
        f.readMount(null);
        expect(draft.inspectDraftReference(old!.draftStateRef)).toBeNull();
        expect(draft.inspectDraftReference(prepared!.info.draftStateRef)).toBe(prepared!.info);
    });

    it('preserves committed custody when actual mounted preparation reads fail', async () => {
        const f = await openWriter();
        f.associate();
        f.retain();
        const draft = f.authoring.authoringDraftCheckpointRuntime;
        const old = draft.captureDraftCheckpoint();
        expect(old).not.toBeNull();
        f.readMount(() => { throw new Error('actual-prepare-owner-read-failed'); });
        expect(draft.prepareDraftCheckpoint()).toBeNull();
        f.readMount(null);
        expect(draft.inspectDraftReference(old!.draftStateRef)).toBe(old);
        const retry = draft.prepareDraftCheckpoint();
        expect(retry).not.toBeNull();
        expect(retry!.cancel()).toBe(true);
    });

    it('discards a failed validation candidate and cannot recommit it while the old slot remains valid', async () => {
        const f = await openWriter();
        f.associate();
        f.retain();
        const draft = f.authoring.authoringDraftCheckpointRuntime;
        const old = draft.captureDraftCheckpoint();
        const prepared = draft.prepareDraftCheckpoint();
        expect(old).not.toBeNull();
        expect(prepared).not.toBeNull();
        f.readMount(() => { throw new Error('actual-validation-reader-failed'); });
        expect(prepared!.validate()).toBe(false);
        f.readMount(null);
        expect(prepared!.hasCustody()).toBe(false);
        expect(prepared!.validate()).toBe(false);
        expect(prepared!.publish()).toBeNull();
        expect(prepared!.cancel()).toBe(false);
        expect(draft.inspectDraftReference(old!.draftStateRef)).toBe(old);
    });

    it('reserves preparation before mounted reentry and refuses legacy capture restore or release interleaving', async () => {
        const f = await openWriter();
        f.associate();
        f.retain();
        const draft = f.authoring.authoringDraftCheckpointRuntime;
        const old = draft.captureDraftCheckpoint();
        expect(old).not.toBeNull();
        let reads = 0;
        f.readMount(() => {
            reads += 1;
            expect(draft.prepareDraftCheckpoint()).toBeNull();
            expect(draft.captureDraftCheckpoint()).toBeNull();
            expect(draft.restoreDraftReference(old!.draftStateRef)).toBeNull();
            expect(draft.releaseDraftCheckpoint(old!.draftStateRef)).toBe(false);
        });
        const prepared = draft.prepareDraftCheckpoint();
        expect(reads).toBeGreaterThan(0);
        expect(prepared).not.toBeNull();
        f.readMount(null);
        expect(prepared!.cancel()).toBe(true);
        expect(draft.inspectDraftReference(old!.draftStateRef)).toBe(old);
    });

    it('refuses nested validation/publication and honors actual cancellation during borrowed reads', async () => {
        const f = await openWriter();
        f.associate();
        f.retain();
        const draft = f.authoring.authoringDraftCheckpointRuntime;
        const old = draft.captureDraftCheckpoint();
        const prepared = draft.prepareDraftCheckpoint();
        expect(old).not.toBeNull();
        expect(prepared).not.toBeNull();
        f.readMount(() => {
            expect(prepared!.validate()).toBe(false);
            expect(prepared!.publish()).toBeNull();
            prepared!.cancel();
        });
        expect(prepared!.validate()).toBe(false);
        f.readMount(null);
        expect(prepared!.publish()).toBeNull();
        expect(draft.inspectDraftReference(old!.draftStateRef)).toBe(old);
    });

    it('keeps old committed custody after actual candidate reference allocation fails', async () => {
        const f = await openWriter();
        f.associate();
        f.retain();
        const draft = f.authoring.authoringDraftCheckpointRuntime;
        const old = draft.captureDraftCheckpoint();
        expect(old).not.toBeNull();
        const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => { throw new Error('actual-reference-allocation-failed'); });
        expect(draft.prepareDraftCheckpoint()).toBeNull();
        uuid.mockRestore();
        expect(draft.inspectDraftReference(old!.draftStateRef)).toBe(old);
    });

    it('cancels the candidate on a real principal retirement and does not revive it after ABA', async () => {
        const f = await openWriter();
        f.associate();
        f.retain();
        const prepared = f.authoring.authoringDraftCheckpointRuntime.prepareDraftCheckpoint();
        expect(prepared).not.toBeNull();
        boot.setPrincipal(null);
        boot.setPrincipal(boot.principalId);
        expect(prepared!.validate()).toBe(false);
        expect(prepared!.hasCustody()).toBe(false);
        expect(prepared!.publish()).toBeNull();
        expect(f.authoring.authoringDraftCheckpointRuntime.prepareDraftCheckpoint()).toBeNull();
    });

    it('refuses a candidate after a real native transaction changes the original context revision', async () => {
        const f = await openWriter();
        f.associate();
        f.retain();
        const prepared = f.authoring.authoringDraftCheckpointRuntime.prepareDraftCheckpoint();
        expect(prepared).not.toBeNull();
        f.dispatch({ changes: [{ from: 0, to: 0, insert: 'New actual body' }], history: 'separate', origin: 'programmatic' });
        expect(prepared!.validate()).toBe(false);
        expect(prepared!.publish()).toBeNull();
    });

    it('refuses publication when the original mounted runtime was actually released', async () => {
        const f = await openWriter();
        f.associate();
        f.retain();
        const prepared = f.authoring.authoringDraftCheckpointRuntime.prepareDraftCheckpoint();
        expect(prepared).not.toBeNull();
        f.release();
        expect(prepared!.hasCustody()).toBe(false);
        expect(prepared!.publish()).toBeNull();
        expect(prepared!.cancel()).toBe(false);
    });

    it('cancels a pending candidate on a genuine handle permission notification before publication', async () => {
        const f = await openWriter();
        f.associate();
        f.retain();
        const draft = f.authoring.authoringDraftCheckpointRuntime;
        const prepared = draft.prepareDraftCheckpoint();
        expect(prepared).not.toBeNull();
        const registry = articleWorkspaceTabRouter.getRegistry();
        const context = f.authoring.authoringDocumentContextAdapter.context;
        const entry = registry.getEntryByIdentity({ articleId: context.articleId, draftId: context.draftId, documentId: context.documentId });
        if (!entry) throw new Error('original-writer-member-unavailable');
        registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'invalidate-permission',
            commandId: 'command:writer-prepare-permission', idempotencyKey: 'idempotency:writer-prepare-permission',
            expectedRevision: registry.getRevision(), tabId: entry.tabId,
            statusRef: 'status:writer-prepare-permission', permission: 'revoked' });
        expect(prepared!.hasCustody()).toBe(false);
        expect(prepared!.publish()).toBeNull();
        expect(prepared!.validate()).toBe(false);
        expect(prepared!.cancel()).toBe(false);
    });

    it('retires the original unadopted draft slot across principal A-null/B-A transitions', async () => {
        const f = await openWriter();
        f.associate();
        const draft = f.authoring.authoringDraftCheckpointRuntime;
        const captured = draft.captureDraftCheckpoint();
        expect(captured).not.toBeNull();
        const principal = boot.principalId;
        const document = f.authoring.authoringDocumentContextAdapter.context;
        boot.setPrincipal(null);
        boot.setPrincipal(`${principal}:B`);
        boot.setPrincipal(principal);
        expect(f.authoring.authoringDocumentContextAdapter.context).toBe(document);
        expect(draft.inspectDraftReference(captured!.draftStateRef)).toBeNull();
        expect(draft.captureDraftCheckpoint()).toBeNull();
    });

    it('stops after a tag watcher newer-rights edit and refuses nested restore/capture without replaying setters', async () => {
        const f = await openWriter();
        f.associate();
        const draft = f.authoring.authoringDraftCheckpointRuntime;
        const captured = draft.captureDraftCheckpoint();
        expect(captured).not.toBeNull();
        let nested = 0;
        const stop = watch(() => f.authoring.articleForm.tagIds, () => {
            nested += 1;
            expect(draft.restoreDraftReference(captured!.draftStateRef)).toBeNull();
            expect(draft.captureDraftCheckpoint()).toBeNull();
            f.authoring.articleForm.rights.rightsStatement = 'newer synchronous watcher edit';
        }, { flush: 'sync' });
        try {
            expect(draft.restoreDraftReference(captured!.draftStateRef)).toBeNull();
            expect(nested).toBe(1);
            expect(f.authoring.articleForm.rights.rightsStatement).toBe('newer synchronous watcher edit');
            expect(draft.inspectDraftReference(captured!.draftStateRef)).toBeNull();
        } finally { stop(); }
    });

    it('clears restore reservations and suppression after an actual form setter throws', async () => {
        const f = await openWriter();
        f.associate();
        const draft = f.authoring.authoringDraftCheckpointRuntime;
        const captured = draft.captureDraftCheckpoint();
        expect(captured).not.toBeNull();
        const form = toRaw(f.authoring.articleForm);
        const descriptor = Object.getOwnPropertyDescriptor(form, 'tagIds')!;
        Object.defineProperty(form, 'tagIds', { configurable: true, get: () => descriptor.value,
            set: () => { throw new Error('actual-form-setter-failed'); } });
        try {
            expect(() => draft.restoreDraftReference(captured!.draftStateRef)).toThrow('actual-form-setter-failed');
        } finally { Object.defineProperty(form, 'tagIds', descriptor); }
        // A direct edit of the SAME original form is observed only if suppression really cleaned up.
        const before = f.authoring.authoringDocumentContextAdapter.context.sourceRevision;
        f.authoring.articleForm.content += 'after failed restore';
        expect(f.authoring.authoringDocumentContextAdapter.context.sourceRevision).toBeGreaterThan(before);
        expect(draft.captureDraftCheckpoint()).toBeNull(); // canonical publication is now genuinely lagging
    });

    it('refuses checkpoint capture while the original loaded server draft conflict remains paused', async () => {
        vi.mocked(getServerDraft).mockResolvedValueOnce({ draftKey: 'fsus:article-draft:create', articleId: null,
            baseRevisionId: null, title: 'Pending server draft', content: 'Different server body', summary: null,
            coverImageUrl: null, categoryId: 0, tagIds: [], clientRevision: null, status: 0,
            scheduledPublishAt: null, rights: { mode: 'site' }, updatedAt: '2026-10-08T00:00:00Z', serverRevision: 1 });
        const f = await openWriter();
        f.associate();
        expect(f.authoring.pendingDraft.value?.source).toBe('server');
        const pending = f.authoring.pendingDraft.value;
        const conflict = f.authoring.draftConflictText.value;
        expect(f.authoring.authoringDraftCheckpointRuntime.captureDraftCheckpoint()).toBeNull();
        expect(f.authoring.authoringDraftCheckpointRuntime.restoreDraftReference('not-an-issued-draft')).toBeNull();
        expect(f.authoring.pendingDraft.value).toBe(pending);
        expect(f.authoring.draftConflictText.value).toBe(conflict);
    });

    it('reserves checkpoint creation before the first mounted callback and releases only real issued custody once', async () => {
        const f = await openWriter();
        f.dispatch({ changes: [{ from: 0, to: 0, insert: 'Journal source' }], history: 'separate', origin: 'programmatic' });
        const ref = f.associate();
        const original = articleRecoveryJournal.bindCheckpointSource.bind(articleRecoveryJournal);
        let releases = 0;
        const issued = vi.spyOn(articleRecoveryJournal, 'bindCheckpointSource').mockImplementation(reader => {
            const port = original(reader);
            return { ...port, release: () => { releases += 1; port.release(); } };
        });
        let reentries = 0;
        f.readMount(() => {
            f.readMount(null);
            reentries += 1;
            expect(() => f.checkpoint(ref)).toThrow('article-recovery-checkpoint-mounted-owner-unavailable');
        });
        const port = f.checkpoint(ref);
        expect(reentries).toBe(1);
        expect(issued).toHaveBeenCalledOnce();
        f.release();
        port.release();
        expect(releases).toBe(1);
    });

    it('reclaims a failed mounted read reservation so a later real binding can be created and released', async () => {
        const f = await openWriter();
        f.dispatch({ changes: [{ from: 0, to: 0, insert: 'Journal source' }], history: 'separate', origin: 'programmatic' });
        const ref = f.associate();
        f.readMount(() => { throw new Error('caller-mount-read-failed'); });
        expect(() => f.checkpoint(ref)).toThrow('caller-mount-read-failed');
        f.readMount(null);
        const port = f.checkpoint(ref);
        port.release();
        const successor = f.checkpoint(ref);
        port.release();
        // An already-released port must not clear or release its live successor.
        expect(() => f.checkpoint(ref)).toThrow('article-recovery-checkpoint-mounted-owner-unavailable');
        successor.release();
        f.release();
    });

    it('releases original issued custody when subscription fails after allocation, then allows a clean retry', async () => {
        const f = await openWriter();
        f.dispatch({ changes: [{ from: 0, to: 0, insert: 'Journal source' }], history: 'separate', origin: 'programmatic' });
        const ref = f.associate();
        const original = articleRecoveryJournal.bindCheckpointSource.bind(articleRecoveryJournal);
        let releases = 0;
        vi.spyOn(articleRecoveryJournal, 'bindCheckpointSource').mockImplementation(reader => {
            const port = original(reader);
            return { ...port, release: () => { releases += 1; port.release(); } };
        });
        const subscribe = vi.spyOn(f.authoring.authoringDocumentContextAdapter, 'subscribeContext');
        subscribe.mockImplementationOnce(() => { throw new Error('context-subscription-failed'); });
        expect(() => f.checkpoint(ref)).toThrow('context-subscription-failed');
        expect(releases).toBe(1);
        const port = f.checkpoint(ref);
        f.release();
        port.release();
        expect(releases).toBe(2);
    });

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
