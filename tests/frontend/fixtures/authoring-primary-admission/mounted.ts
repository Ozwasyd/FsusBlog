import { ElMarkdownEditor } from '@ozwasyd/element-plus';
import type { MarkdownEditorInstance } from '@ozwasyd/element-plus';
import { createApp, defineComponent, h, nextTick, onUnmounted, ref } from 'vue';
import '@ozwasyd/element-plus/dist/index.css';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import type { ArticleAnchorPrimaryRetainedAdmission, ArticleAnchorPositionProducer } from '@/services/authoring/articleAnchorContext';
import { ArticleDocumentContextAuthority, inspectArticleDocumentEditorSessionAssociation } from '@/services/authoring/articleDocumentContext';
import { OpenArticleDocumentRegistry, openArticleDocumentCommandSchema } from '@/services/authoring/openArticleDocumentRegistry';

const input = { articleId: 1, siteScope: 'primary-site', userScope: 'user:41', content: '# Original loaded primary\n\nActual source owner.\n' };
const scope = { readPrincipalIdentityId: () => '41', readSiteScope: () => 'primary-site' };
createApp(defineComponent({ setup()
{
    const authority = new ArticleDocumentContextAuthority();
    const privatePrimary = authority.acquire(input);
    const adapter = privatePrimary.adapter;
    const anchors = new ArticleAnchorContextAdapter(adapter);
    const registry = new OpenArticleDocumentRegistry();
    const canonical = new URL(location.href).searchParams.get('canonical') === '1';
    const target = canonical ? new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input, scope).context : adapter.context;
    registry.openOrActivate({ schema: openArticleDocumentCommandSchema, kind: 'open-or-activate', commandId: 'open:browser', idempotencyKey: 'open:browser',
        expectedRevision: registry.getRevision(), intent: 'workspace', entrypoint: 'direct-route',
        identity: { articleId: target.articleId, draftId: target.draftId, documentId: target.documentId },
        documentContext: { documentEpoch: target.documentEpoch, sourceRevision: `source-revision:${target.sourceRevision}`, draftRevision: target.draftRevision },
        editorSessionRef: 'native:original-primary', tabId: 'tab:primary', targetGroupId: 'group:primary', tabKind: 'pinned', lastActiveAnchorRef: null,
        status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
            permission: 'allowed', lifecycle: 'current', statusRef: 'status:current' } });
    const entry = registry.getEntry('tab:primary');
    if (!entry) throw new Error('actual-registry-admission-missing');
    const entryRevision = registry.getRevision();
    const lifetime = new AbortController();
    const native = ref<MarkdownEditorInstance>();
    const identity = ref(adapter.documentIdentity);
    const source = ref(input.content);
    const shown = ref(true);
    const ready = ref(false);
    const boundary = defineComponent({ setup()
    {
        onUnmounted(() => lifetime.abort());
        return () => h(ElMarkdownEditor, { ref: native, modelValue: source.value, mode: 'source', editorProfile: 'prose',
            documentIdentity: identity.value, height: '320px', 'onUpdate:modelValue': (value: string) => { source.value = value; } });
    } });
    let loan: ArticleAnchorPrimaryRetainedAdmission | null = null;
    let producer: ArticleAnchorPositionProducer | null = null;
    const pending = adapter.beginTask('attachment', 'actual:primary-owned-work');
    const before = adapter.context;
    const snapshot = () => ({ sameAnchor: loan?.anchors === anchors, sameAdapter: loan?.binding.adapter === adapter,
        current: loan?.isCurrent() ?? false, aborted: loan?.signal.aborted ?? false,
        documentId: adapter.context.documentId, previousDocumentId: before.documentId, targetDocumentId: target.documentId,
        sourceRevision: adapter.context.sourceRevision, registrySource: registry.getEntry(entry.tabId)?.documentContext.sourceRevision,
        mapAvailable: producer?.binding() != null, pendingAborted: pending.signal.aborted,
        retainedPending: loan?.binding.inspect().pendingTaskRefs.includes(pending.taskRef),
        documentSession: adapter.context.editorSessionId,
        registrySession: loan ? inspectArticleDocumentEditorSessionAssociation(loan.association, adapter)?.registryEditorSessionRef : null });
    Reflect.set(window, 'runPrimaryAdmission', async (action: string) =>
    {
        if (action === 'stale')
        {
            registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'activate', commandId: 'activate:stale', idempotencyKey: 'activate:stale',
                expectedRevision: registry.getRevision(), tabId: entry.tabId, lastActiveAnchorRef: 'anchor:later' });
            try { anchors.admitCurrentPrimaryRetainedDocument(authority, registry, entry, entryRevision, scope, lifetime.signal); }
            catch (error) { return { error: String(error), adopted: false }; }
            throw new Error('stale-primary-admission-was-accepted');
        }
        if (!loan)
        {
            const originalEditor = native.value;
            if (!originalEditor) throw new Error('actual-native-mount-missing');
            const actualSession = originalEditor.getSession(entry.editorSessionRef);
            // Only adapter/anchors cross the host boundary; the private primary binding is not cast or exported.
            loan = anchors.admitCurrentPrimaryRetainedDocument(authority, registry, entry, entryRevision, scope, lifetime.signal);
            identity.value = adapter.documentIdentity;
            await nextTick();
            const editor = native.value;
            if (!editor || editor !== originalEditor || editor.getSession(entry.editorSessionRef) !== actualSession)
                throw new Error('actual-native-session-loan-changed');
            if (actualSession.inspectDocumentState().documentIdentity.id !== adapter.context.documentId)
                throw new Error('actual-native-identity-not-refreshed');
            producer = anchors.bindOwnedPositionProducer(loan.association, editor);
        }
        if (action === 'dispatch')
        {
            if (!producer) throw new Error('actual-position-producer-missing');
            const result = producer.dispatch({ changes: [{ from: 0, to: 0, insert: '!' }], expectedRevision: adapter.context.sourceRevision,
                documentIdentity: adapter.documentIdentity, origin: 'programmatic', history: 'separate' });
            if (!result.accepted) throw new Error('actual-native-dispatch-refused');
        }
        if (action === 'release') loan.release();
        if (action === 'unmount') { shown.value = false; await nextTick(); }
        if (action === 'scope') authority.revokeRetainedScope('primary-site', '41');
        ready.value = true;
        return snapshot();
    });
    onUnmounted(() => { lifetime.abort(); privatePrimary.release(); });
    return () => h('main', { style: 'max-width:850px;margin:24px auto;padding:16px' }, [
        h('h1', 'Original primary retained admission'), shown.value ? h(boundary) : null,
        h('output', { id: 'state' }, ready.value ? 'admitted' : 'mounted')
    ]);
} })).mount('#app');
