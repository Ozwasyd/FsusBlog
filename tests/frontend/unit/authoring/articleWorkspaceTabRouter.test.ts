import { describe, expect, it } from 'vitest';

import {
    AuthoringSessionHost,
    authoringSessionSnapshotSchema,
    sealAuthoringSessionSnapshot,
    type FsusUiPublicEditorSessionFactory
} from '@/services/authoring/authoringSessionHost';
import {
    ArticleWorkspaceTabRouter,
    articleWorkspaceSessionReceiptSchema,
    articleWorkspaceTabRouterSchema,
    canonicalArticleWorkspaceRoute,
    createArticleWorkspaceSessionPort,
    verifyArticleWorkspaceRouterReceipt,
    verifyArticleWorkspaceSessionReceipt,
    type ArticleWorkspaceOpenInput,
    type ArticleWorkspaceSessionReceipt,
    type ArticleWorkspaceSessionPort
} from '@/services/authoring/articleWorkspaceTabRouter';
import { calculateOpenArticleDocumentDigest } from '@/services/authoring/openArticleDocumentRegistry';
import type {
    ArticleWorkspaceStatusSummary,
    OpenArticleDocumentEntry
} from '@/services/authoring/openArticleDocumentRegistry';

const status = (overrides: Partial<ArticleWorkspaceStatusSummary> = {}): ArticleWorkspaceStatusSummary => ({
    dirty: false,
    saving: false,
    conflict: false,
    recovery: false,
    pendingAttachments: false,
    permission: 'allowed',
    lifecycle: 'current',
    statusRef: 'status:test-article',
    ...overrides
});

const input = (articleId: number, overrides: Partial<ArticleWorkspaceOpenInput> = {}): ArticleWorkspaceOpenInput => ({
    identity: {
        articleId,
        draftId: `draft:${articleId}`,
        documentId: `document:${articleId}`
    },
    documentContext: {
        documentEpoch: 1,
        sourceRevision: `source:${articleId}`,
        draftRevision: `draft-revision:${articleId}`
    },
    title: `文章标题 ${articleId}`,
    status: status({ statusRef: `status:${articleId}` }),
    targetGroupId: 'group:primary',
    tabKind: 'preview',
    entrypoint: 'quick-switcher',
    ...overrides
});

describe('ArticleWorkspaceTabRouter contract (#2295)', () => {
    it('keeps one registry entry per article across the bounded tab cardinalities', async () => {
        for (const count of [0, 1, 20, 100])
        {
            const router = new ArticleWorkspaceTabRouter();
            for (let articleId = 1; articleId <= count; articleId += 1)
            {
                await router.openOrActivate(input(articleId, { tabKind: 'pinned' }));
            }
            expect(router.listTabs()).toHaveLength(count);
            expect(router.listTabs().filter((tab) => tab.isActive)).toHaveLength(Math.min(count, 1));
        }
    });

    it('uses one registry authority for all entrypoints and activates an existing group/tab', async () => {
        const router = new ArticleWorkspaceTabRouter();
        for (const [index, entrypoint] of ([
            'rail',
            'quick-switcher',
            'internal-link',
            'recent-restore',
            'direct-route'
        ] as const).entries()) {
            const receipt = await router.openOrActivate(input(10, {
                entrypoint,
                targetGroupId: index === 0 ? 'group:secondary' : 'group:primary'
            }));
            expect(receipt.resultStatus).toMatch(/applied|activated-existing|replayed/u);
            expect(receipt.tabId).toBeTruthy();
        }

        const [tab] = router.listTabs();
        expect(router.listTabs()).toHaveLength(1);
        expect(tab?.owningGroupId).toBe('group:secondary');
        expect(tab?.title).toBe('文章标题 10');
    });

    it('promotes a safe preview, but keeps a risky preview protected from replacement', async () => {
        const router = new ArticleWorkspaceTabRouter();
        const first = await router.openOrActivate(input(20));
        expect(first.sessionState).toBe('ready');

        const promoted = await router.promotePreview(first.tabId!);
        expect(promoted.resultStatus).toBe('applied');
        expect(router.getTab(first.tabId!)?.isPinned).toBe(true);
        expect(router.getTab(first.tabId!)?.isPreview).toBe(false);

        const second = await router.openOrActivate(input(21, {
            title: '第二篇',
            tabKind: 'preview'
        }));
        expect(second.resultStatus).toBe('applied');
        expect(router.listTabs()).toHaveLength(2);

        const riskyRouter = new ArticleWorkspaceTabRouter();
        const risky = await riskyRouter.openOrActivate(input(22, {
            status: status({ dirty: true, statusRef: 'status:risky' })
        }));
        const replacement = await riskyRouter.openOrActivate(input(23, {
            title: '不可替换',
            tabKind: 'preview'
        }));
        expect(riskyRouter.getTab(risky.tabId!)).toBeTruthy();
        expect(replacement.resultStatus).toBe('applied');
        expect(riskyRouter.listTabs()).toHaveLength(2);

        const unpinned = await router.unpinTab(first.tabId!);
        expect(unpinned.resultStatus).toBe('applied');
        expect(router.getTab(first.tabId!)?.isPreview).toBe(true);

        const riskyUnpin = await riskyRouter.unpinTab(risky.tabId!);
        expect(riskyUnpin.resultStatus).toBe('rejected-preview-risk');
    });

    it('waits for a session ready/blocked receipt before reporting activation', async () => {
        const calls: string[] = [];
        const sessionPort: ArticleWorkspaceSessionPort = {
            waitForReady: async (entry: OpenArticleDocumentEntry) => {
                calls.push(entry.editorSessionRef);
                const base = {
                    schema: articleWorkspaceSessionReceiptSchema,
                    receiptRef: `session-ready:${entry.tabId}:1`,
                    tabId: entry.tabId,
                    editorSessionRef: entry.editorSessionRef,
                    registryRevision: 1,
                    status: 'ready' as const,
                    reason: null
                };
                return {
                    ...base,
                    contentDigest: calculateDigest(base)
                };
            }
        };
        const router = new ArticleWorkspaceTabRouter();
        router.setSessionPort(sessionPort);

        const receipt = await router.openOrActivate(input(30));
        expect(calls).toEqual([receipt.editorSessionRef]);
        expect(receipt.sessionState).toBe('ready');
        expect(verifyArticleWorkspaceSessionReceipt({
            schema: articleWorkspaceSessionReceiptSchema,
            receiptRef: `session-ready:${receipt.tabId}:1`,
            tabId: receipt.tabId!,
            editorSessionRef: receipt.editorSessionRef!,
            registryRevision: 1,
            status: 'ready',
            reason: null,
            contentDigest: calculateDigest({
                schema: articleWorkspaceSessionReceiptSchema,
                receiptRef: `session-ready:${receipt.tabId}:1`,
                tabId: receipt.tabId!,
                editorSessionRef: receipt.editorSessionRef!,
                registryRevision: 1,
                status: 'ready',
                reason: null
            })
        })).toBe(true);
    });

    it('rejects a session receipt that resolves after the registry entry changed', async () => {
        let release: ((receipt: ArticleWorkspaceSessionReceipt) => void) | undefined;
        const deferred = new Promise<ArticleWorkspaceSessionReceipt>((resolve) =>
        {
            release = resolve;
        });
        const router = new ArticleWorkspaceTabRouter();
        router.setSessionPort({ waitForReady: async () => deferred });

        const pendingOpen = router.openOrActivate(input(35));
        await Promise.resolve();
        const tab = router.listTabs()[0]!;
        router.markStatus(tab.tabId, status({ dirty: true, statusRef: 'status:changed-before-ready' }));
        const entry = router.getRegistry().getEntry(tab.tabId)!;
        const base = {
            schema: articleWorkspaceSessionReceiptSchema,
            receiptRef: `session-ready:${entry.tabId}:1`,
            tabId: entry.tabId,
            editorSessionRef: entry.editorSessionRef,
            registryRevision: entry.lifecycleRevision,
            status: 'ready' as const,
            reason: null
        };
        release?.({ ...base, contentDigest: calculateDigest(base) });

        const receipt = await pendingOpen;
        expect(receipt.sessionState).toBe('blocked');
        expect(receipt.reason).toBe('session-result-stale');
        expect(router.getTab(tab.tabId)?.sessionState).toBe('pending');
    });

    it.each([
        ['ready', 'editorSessionRef'],
        ['ready', 'registryRevision'],
        ['blocked', 'editorSessionRef'],
        ['blocked', 'registryRevision']
    ] as const)('rejects a fully resealed %s receipt with foreign %s', async (sessionState, field) => {
        const router = new ArticleWorkspaceTabRouter();
        let returnedReceipt: ArticleWorkspaceSessionReceipt | undefined;
        router.setSessionPort({
            waitForReady: async (entry) => {
                expect(entry.lifecycleRevision).toBeGreaterThan(0);
                const base = {
                    schema: articleWorkspaceSessionReceiptSchema,
                    receiptRef: `session-ready:${entry.tabId}:${entry.lifecycleRevision}`,
                    tabId: entry.tabId,
                    editorSessionRef: field === 'editorSessionRef' ? 'session:foreign-article' : entry.editorSessionRef,
                    registryRevision: field === 'registryRevision' ? entry.lifecycleRevision - 1 : entry.lifecycleRevision,
                    status: sessionState,
                    reason: sessionState === 'blocked' ? 'session-host-blocked' : null
                };
                returnedReceipt = { ...base, contentDigest: calculateDigest(base) };
                expect(verifyArticleWorkspaceSessionReceipt(returnedReceipt)).toBe(true);
                expect(returnedReceipt.tabId).toBe(entry.tabId);
                expect(returnedReceipt[field]).not.toBe(field === 'editorSessionRef' ? entry.editorSessionRef : entry.lifecycleRevision);
                return returnedReceipt;
            }
        });
        const pushes: string[] = [];
        const result = await router.openOrActivateAndNavigate(input(36), {
            currentFullPath: '/user/manage/article/write',
            push: async (route) => { pushes.push(route); }
        });
        expect(result.sessionState).toBe('blocked');
        expect(result.reason).toBe('session-ready-receipt-invalid');
        expect(result.sessionReceiptRef).not.toBe(returnedReceipt?.receiptRef);
        expect(router.getTab(result.tabId!)?.sessionState).toBe('blocked');
        expect(pushes).toEqual([]);
    });

    it.each(['ready', 'blocked'] as const)('preserves an exact entry-bound %s receipt and its reason', async (sessionState) => {
        const router = new ArticleWorkspaceTabRouter();
        router.setSessionPort({
            waitForReady: async (entry) => {
                const base = {
                    schema: articleWorkspaceSessionReceiptSchema,
                    receiptRef: `session-ready:${entry.tabId}:${entry.lifecycleRevision}`,
                    tabId: entry.tabId,
                    editorSessionRef: entry.editorSessionRef,
                    registryRevision: entry.lifecycleRevision,
                    status: sessionState,
                    reason: sessionState === 'blocked' ? 'session-host-blocked' : null
                };
                const receipt = { ...base, contentDigest: calculateDigest(base) };
                expect(verifyArticleWorkspaceSessionReceipt(receipt)).toBe(true);
                return receipt;
            }
        });
        await router.openOrActivate(input(37, { tabKind: 'pinned' }));
        const result = await router.openOrActivate(input(38, { tabKind: 'pinned' }));
        const entry = router.getRegistry().getEntry(result.tabId!)!;
        expect(router.getRevision()).toBeGreaterThan(entry.lifecycleRevision);
        expect(result.sessionState).toBe(sessionState);
        expect(result.reason).toBe(sessionState === 'blocked' ? 'session-host-blocked' : null);
        expect(result.sessionReceiptRef).toBe(`session-ready:${entry.tabId}:${entry.lifecycleRevision}`);
    });

    it('accepts the original host bridge mapping without substituting the host revision', async () => {
        const host = new AuthoringSessionHost(sessionFactory());
        const bridge = createArticleWorkspaceSessionPort(host);
        const router = new ArticleWorkspaceTabRouter();
        router.setSessionPort(bridge);
        const opened = await router.openOrActivate(input(39, { tabKind: 'pinned' }));
        const entry = router.getRegistry().getEntry(opened.tabId!)!;
        expect(opened.sessionState).toBe('ready');
        expect(host.getSession(entry.editorSessionRef)?.tabId).toBe(entry.tabId);
        for (let index = 0; index < 3; index += 1)
        {
            const receipt = await bridge.waitForReady(entry);
            expect(verifyArticleWorkspaceSessionReceipt(receipt)).toBe(true);
            expect(receipt.tabId).toBe(entry.tabId);
            expect(receipt.editorSessionRef).toBe(entry.editorSessionRef);
            expect(receipt.registryRevision).toBe(entry.lifecycleRevision);
            expect(receipt.status).toBe('ready');
            expect(receipt.reason).toBeNull();
            expect(host.exportState().revision).toBeGreaterThan(receipt.registryRevision);
        }
        expect((await router.activateTab(entry.tabId)).sessionState).toBe('ready');
    });

    it('prevents route feedback loops and blocks unknown routes without creating a ghost tab', async () => {
        const router = new ArticleWorkspaceTabRouter();
        const opened = await router.openOrActivate(input(40, { tabKind: 'pinned' }));
        const pushes: string[] = [];
        const navigation = {
            currentFullPath: '/user/manage/article/edit/40',
            push: async (location: string) => {
                pushes.push(location);
            }
        };
        const update = await router.activateAndNavigate(opened.tabId!, navigation);
        expect(update.resultStatus).toBe('applied');
        expect(pushes).toEqual([canonicalArticleWorkspaceRoute(router.getRegistry().getEntry(opened.tabId!)!)]);

        const replay = await router.syncRoute({
            route: {
                name: 'ManageEditArticle',
                path: '/user/manage/article/edit/40',
                fullPath: '/user/manage/article/edit/40'
            },
            identity: input(40).identity
        });
        expect(replay.resultStatus).toBe('replayed');
        expect(router.listTabs()).toHaveLength(1);

        const unknown = await router.syncRoute({
            route: {
                name: 'ManageEditArticle',
                path: '/user/manage/article/edit/999',
                fullPath: '/user/manage/article/edit/999'
            },
            identity: input(999).identity
        });
        expect(unknown.resultStatus).toBe('blocked');
        expect(unknown.reason).toMatch(/ghost/u);
        expect(router.listTabs()).toHaveLength(1);
    });

    it('keeps browser new-tab intent outside the workspace registry and blocks invalid direct routes', async () => {
        const router = new ArticleWorkspaceTabRouter();
        const browserTab = await router.openOrActivate(input(41, {
            intent: 'browser-new-tab',
            entrypoint: 'internal-link'
        }));
        expect(browserTab.resultStatus).toBe('ignored-browser-new-tab');
        expect(router.listTabs()).toHaveLength(0);

        const blocked = await router.syncRoute({
            route: {
                name: 'ManageEditArticle',
                path: '/user/manage/article/edit/42',
                fullPath: '/user/manage/article/edit/42'
            },
            identity: input(42).identity,
            documentContext: input(42).documentContext,
            status: status({ lifecycle: 'deleted', statusRef: 'status:deleted' }),
            allowCreate: true
        });
        expect(blocked.resultStatus).toBe('blocked');
        expect(blocked.sessionState).toBe('blocked');
        expect(router.listTabs()).toHaveLength(0);
    });

    it('rejects stale title projections and keeps close as a request only', async () => {
        const router = new ArticleWorkspaceTabRouter();
        const opened = await router.openOrActivate(input(50, { tabKind: 'pinned' }));
        const newer = router.updatePresentation(opened.tabId!, { title: '新标题', registryRevision: 5 });
        expect(newer).not.toBeNull();
        const stale = router.updatePresentation(opened.tabId!, { title: '旧标题', registryRevision: 4 });
        expect(stale?.resultStatus).toBe('stale');
        expect(router.getTab(opened.tabId!)?.title).toBe('新标题');

        const close = router.requestClose(opened.tabId!);
        expect(close.resultStatus).toBe('applied');
        expect(router.getTab(opened.tabId!)?.status).toEqual(status({ statusRef: 'status:50' }));
        expect(router.getRegistry().getEntry(opened.tabId!)?.closeRequestRef).toBeTruthy();
    });

    it('verifies tamper-resistant router receipts', async () => {
        const router = new ArticleWorkspaceTabRouter();
        const receipt = await router.openOrActivate(input(60, { tabKind: 'pinned' }));
        expect(receipt.schema).toBe(articleWorkspaceTabRouterSchema);
        expect(verifyArticleWorkspaceRouterReceipt(receipt)).toBe(true);
        expect(verifyArticleWorkspaceRouterReceipt({ ...receipt, reason: 'tampered' })).toBe(false);
    });
});

function calculateDigest(value: unknown): string
{
    return calculateOpenArticleDocumentDigest(value);
}

// A public-session SOURCE fixture drives the actual host and adapter, not a production composition.
function sessionFactory(): FsusUiPublicEditorSessionFactory
{
    const resources = { editorInstances: 1, renderers: 0, observers: 0, timers: 0,
        backgroundTasks: 0, networkRequests: 0, memoryUnits: 1 };
    return {
        createSession: (entry) => ({
            editorSessionRef: entry.editorSessionRef,
            captureSnapshot: (context) => sealAuthoringSessionSnapshot({
                schema: authoringSessionSnapshotSchema,
                snapshotRef: 'snapshot:router-bridge',
                identity: structuredClone(context.identity),
                editorSessionRef: context.editorSessionRef,
                documentContext: structuredClone(context.documentContext),
                permission: context.permission,
                permissionRef: context.permissionRef,
                selectionRef: 'selection:router-bridge',
                selectionDirection: 'none',
                historyRef: 'history:router-bridge',
                activeNodeRef: 'active-node:router-bridge',
                scrollAnchorRef: 'scroll-anchor:router-bridge',
                outlineRef: 'outline:router-bridge',
                searchRef: 'search:router-bridge',
                attachmentStateRef: 'attachment:router-bridge',
                lastValidRenderRef: 'render:router-bridge',
                draftStateRef: 'draft:router-bridge',
                crashJournalRef: 'crash:router-bridge',
                editorContentDigest: calculateDigest({ editorSessionRef: context.editorSessionRef })
            }),
            pauseResources: () => ({ ...resources }),
            resumeResources: () => ({ ...resources }),
            inspectResources: () => ({ ...resources }),
            restoreSnapshot: (snapshot) => ({ status: 'restored', snapshotRef: snapshot.snapshotRef,
                snapshotDigest: snapshot.snapshotDigest, identityValidated: true, refsValidated: true, reason: null }),
            disposeAfterSnapshot: () => undefined
        })
    };
}
