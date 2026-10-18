import { ElMarkdownEditor } from '@ozwasyd/element-plus';
import type { MarkdownEditorInstance } from '@ozwasyd/element-plus';
import { createApp, defineComponent, h, nextTick, onMounted, ref } from 'vue';
import '@ozwasyd/element-plus/dist/index.css';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleDocumentContextAuthority } from '@/services/authoring/articleDocumentContext';
import { AuthoringNavigationEntrypoints, createAuthoringNavigationIntent, createAuthoringNavigationOwnedMountedEditor,
    projectAuthoringNavigationAnchor } from '@/services/authoring/authoringNavigationEntrypoints';
import { AuthoringTabGroupRegistry } from '@/services/authoring/authoringTabGroupRegistry';
import { authoringWorkspaceRatioOwner } from '@/services/authoring/authoringWorkspaceRatioOwner';
import { OpenArticleDocumentRegistry, openArticleDocumentCommandSchema } from '@/services/authoring/openArticleDocumentRegistry';

const captureOptions = { affinity: 'after' as const, viewportOffset: 0, percentage: 0, surface: 'source' as const, tool: 'none' as const };
createApp(defineComponent({ setup()
{
    const source = ref(Array.from({ length: 80 }, (_, n) => `Paragraph ${n} with enough words for a real scrollable document.`).join('\n\n'));
    const authority = new ArticleDocumentContextAuthority();
    const registry = new OpenArticleDocumentRegistry();
    const ratioScope = authoringWorkspaceRatioOwner.openWorkspace();
    const groups = new AuthoringTabGroupRegistry(registry, { initialGroupId: 'group:main', ratioScope,
        splitRatioRef: authoringWorkspaceRatioOwner.read(ratioScope).ratioRef, historyCapacity: 16 });
    const prepared = authority.prepareRetainedDocument(registry, { articleId: 1, userScope: 'user:41', siteScope: 'site:test', content: source.value },
        { readPrincipalIdentityId: () => '41', readSiteScope: () => 'site:test' });
    const context = prepared.context;
    const identity = { articleId: context.articleId, draftId: context.draftId, documentId: context.documentId };
    registry.openOrActivate({ schema: openArticleDocumentCommandSchema, kind: 'open-or-activate',
        commandId: 'browser:open', idempotencyKey: 'browser:open', expectedRevision: registry.getRevision(), intent: 'workspace', entrypoint: 'direct-route',
        identity, documentContext: { documentEpoch: context.documentEpoch, sourceRevision: `source-revision:${context.sourceRevision}`, draftRevision: context.draftRevision },
        editorSessionRef: 'browser:original-native', tabId: 'tab:browser', targetGroupId: 'group:main', tabKind: 'pinned', lastActiveAnchorRef: null,
        status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
            permission: 'allowed', lifecycle: 'current', statusRef: 'status:current' } });
    const retained = authority.acquireRetainedDocument(registry.issueRetainedDocumentHandle('tab:browser'), prepared);
    const owner = retained.adapter;
    const editor = ref<MarkdownEditorInstance>();
    const shown = ref(true);
    const epoch = ref(owner.documentIdentity.epoch);
    const ready = ref(false);
    onMounted(async () =>
    {
        await nextTick();
        const native = editor.value;
        if (!native) throw new Error('original-mounted-editor-missing');
        const anchors = new ArticleAnchorContextAdapter(owner);
        const association = authority.issueEditorSessionAssociation(retained);
        if (!association) throw new Error('original-session-association-missing');
        let live = true;
        const mounted = createAuthoringNavigationOwnedMountedEditor({ document: owner, anchors, association,
            editor: native, isCurrent: () => live && editor.value === native, captureOptions: () => captureOptions,
            viewport: () => ({ height: 320, reducedMotion: true }) });
        const producer = mounted.positionProducer;
        let sequence = 0;
        let echoes = 0;
        let routeHook = () => {};
        const navigation = new AuthoringNavigationEntrypoints({ registry, groups,
            scope: { sessionRef: 'session:browser', workspaceRef: 'workspace:browser', siteScope: 'site:test', userScope: 'user:41' },
            mounted: { current: () => live ? mounted : null, wait: async () => live ? mounted : null },
            route: { update: async (_entry, _policy, origin, _signal, admit) =>
            {
                admit();
                if (navigation.observeRoute(origin).status === 'ignored') echoes += 1;
                routeHook();
                admit();
            } } });
        const target = source.value.indexOf('Paragraph 60');
        const binding = producer.binding();
        if (!binding) throw new Error('original-map-missing');
        const saved = anchors.capture(binding, { start: target, end: target + 12, direction: 'backward' }, captureOptions);
        const intent = (anchor: ReturnType<typeof projectAuthoringNavigationAnchor> | null = projectAuthoringNavigationAnchor(saved)) => createAuthoringNavigationIntent({
            requestId: `browser:${++sequence}`, sequence, initiatedAt: sequence, entrypoint: 'internal-link', identity,
            anchor, targetGroupId: null, routePolicy: 'push', recentRestore: null });
        const dispatch = (from: number, to: number, insert: string) => producer.dispatch({
            changes: [{ from, to, insert }], documentIdentity: owner.documentIdentity,
            expectedRevision: owner.context.sourceRevision, history: 'separate', origin: 'programmatic' });
        Reflect.set(window, 'runNavigation', async (action: string) =>
        {
            if (action.startsWith('back-'))
            {
                await navigation.navigate(intent());
                const currentBinding = producer.binding();
                if (!currentBinding) throw new Error('seed-binding-missing');
                const second = anchors.capture(currentBinding, { start: target + 64, end: target + 76, direction: 'forward' }, captureOptions);
                await navigation.navigate(intent(projectAuthoringNavigationAnchor(second)));
                document.getElementById('outside')?.focus();
            }
            let overlayHit = false;
            if (action === 'partial-overlay')
            {
                document.querySelector('textarea')?.addEventListener('focus', () => requestAnimationFrame(() =>
                {
                    const span = Array.from(document.querySelectorAll('.el-markdown-editor__focus-layer span:not(.is-dimmed)'))
                        .find(element => element.textContent?.startsWith('Paragraph 60'));
                    if (!span) throw new Error('original-selection-layout-missing');
                    const rect = span.getBoundingClientRect();
                    const overlay = document.createElement('div');
                    overlay.id = 'partial-occlusion';
                    Object.assign(overlay.style, { position: 'fixed', left: `${rect.left + 3}px`, top: `${rect.top + 1}px`,
                        width: '5px', height: '18px', background: 'black', zIndex: '99999' });
                    document.body.append(overlay);
                    overlayHit = document.elementFromPoint(rect.left + 5, rect.top + 5) === overlay;
                }), { once: true });
            }
            const before = navigation.history.exportState();
            if (['focus-fail', 'cancel-after-focus', 'retire-after-focus', 'back-cancel', 'back-focus-fail', 'source'].includes(action))
            {
                document.querySelector('textarea')?.addEventListener('focus', () =>
                {
                    if (action === 'source') dispatch(0, 0, '!');
                    else if (action.includes('cancel')) navigation.cancel();
                    else if (action === 'retire-after-focus') live = false;
                    else document.getElementById('outside')?.focus();
                }, { once: true });
            }
            let pending;
            if (action === 'rebased') dispatch(0, 0, '!');
            if (action === 'partial') dispatch(target + 2, target + 5, '');
            if (action === 'route-source') routeHook = () => { dispatch(0, 0, '!'); };
            if (action === 'reentry') routeHook = () => { routeHook = () => {}; void navigation.navigate(intent()); };
            if (action === 'route-retire') routeHook = () => { live = false; };
            pending = action.startsWith('back-') ? navigation.traverse('back', `browser:${++sequence}`, sequence)
                : navigation.navigate(intent(action === 'anchorless' ? null : projectAuthoringNavigationAnchor(saved)));
            if (action === 'cancel') navigation.cancel();
            if (action === 'retire') live = false;
            if (action === 'unmount') { shown.value = false; await nextTick(); }
            if (action === 'same-id-remount') { shown.value = false; await nextTick(); shown.value = true; await nextTick(); }
            if (action === 'epoch') { epoch.value += 1; await nextTick(); }
            if (action === 'newer')
            {
                const newer = navigation.navigate(intent());
                const old = await pending;
                const latest = await newer;
                return { old, latest, after: navigation.history.exportState(), echoes };
            }

            const receipt = await pending;
            return { receipt, before, after: navigation.history.exportState(), echoes, overlayHit,
                documentSession: owner.context.editorSessionId, registrySession: registry.getEntry('tab:browser')?.editorSessionRef,
                sourceRevision: owner.context.sourceRevision };
        });
        ready.value = true;
    });
    return () => h('main', { style: 'padding:24px;max-width:900px;margin:auto' }, [
        h('h1', 'Original authoring navigation integration'),
        h('button', { id: 'outside' }, 'Outside focus'),
        shown.value ? h(ElMarkdownEditor, { ref: editor, modelValue: source.value,
            documentIdentity: { id: owner.documentIdentity.id, epoch: epoch.value }, mode: 'source', editorProfile: 'prose',
            minRows: 8, height: '320px', writingAids: { focus: true }, 'onUpdate:modelValue': (value: string) => { source.value = value; } }) : null,
        h('output', { id: 'ready' }, ready.value ? 'ready' : 'pending')
    ]);
} })).mount('#app');
