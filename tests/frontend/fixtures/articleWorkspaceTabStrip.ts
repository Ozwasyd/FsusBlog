import { createApp, h, nextTick } from 'vue';

import '@/assets/main.css';
import ArticleWorkspaceTabStrip from '@/components/admin/article/ArticleWorkspaceTabStrip.vue';
import {
    ArticleWorkspaceTabRouter,
    articleWorkspaceSessionReceiptSchema,
    type ArticleWorkspaceOpenInput,
    type ArticleWorkspaceSessionReceipt
} from '@/services/authoring/articleWorkspaceTabRouter';
import {
    calculateOpenArticleDocumentDigest,
    type OpenArticleDocumentEntry
} from '@/services/authoring/openArticleDocumentRegistry';

export interface ArticleWorkspaceTabFixture {
    snapshot(): { active: { tabId: string } | null; route: string; pending: boolean; entries: OpenArticleDocumentEntry[] };
    block(): void;
    defer(): void;
    release(): void;
    reset(count: number): Promise<void>;
    remount(): Promise<void>;
}

/** Controlled host receipts exercise the production component, registry and public Button. */
export async function mountArticleWorkspaceTabFixture(count: number, theme: string): Promise<void>
{
    delete document.documentElement.dataset.workspaceTabFixtureReady;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    const coordinator = new ArticleWorkspaceTabRouter();
    const navigation = {
        currentFullPath: `/user/manage/article/edit/${count}`,
        async push(location: string): Promise<void>
        {
            navigation.currentFullPath = location;
        }
    };
    const input = (articleId: number): ArticleWorkspaceOpenInput => ({
        identity: { articleId, draftId: `draft:${articleId}`, documentId: `document:${articleId}` },
        documentContext: {
            documentEpoch: 1,
            sourceRevision: `source:${articleId}`,
            draftRevision: `draft-revision:${articleId}`
        },
        title: `文章 ${articleId} · 一个非常长的工作区文章标题 Long workspace article title`,
        status: {
            dirty: false,
            saving: false,
            conflict: false,
            recovery: false,
            pendingAttachments: false,
            permission: 'allowed',
            lifecycle: 'current',
            statusRef: `status:${articleId}`
        },
        targetGroupId: 'group:primary',
        tabKind: 'pinned',
        entrypoint: 'direct-route'
    });
    for (let articleId = 1; articleId <= count; articleId += 1)
    {
        await coordinator.openOrActivate(input(articleId));
    }
    const receipt = (entry: OpenArticleDocumentEntry, status: 'ready' | 'blocked'): ArticleWorkspaceSessionReceipt =>
    {
        const base = {
            schema: articleWorkspaceSessionReceiptSchema,
            receiptRef: `fixture-session:${entry.tabId}:${entry.lifecycleRevision}`,
            tabId: entry.tabId,
            editorSessionRef: entry.editorSessionRef,
            registryRevision: entry.lifecycleRevision,
            status,
            reason: status === 'blocked' ? 'fixture-session-blocked' : null
        };
        return { ...base, contentDigest: calculateOpenArticleDocumentDigest(base) };
    };
    const create = () => createApp({ render: () => h(ArticleWorkspaceTabStrip, { coordinator, router: navigation }) });
    let app = create();
    let release: (() => void) | null = null;
    const fixture: ArticleWorkspaceTabFixture = {
        snapshot: () => ({
            active: coordinator.getActiveTab(),
            route: navigation.currentFullPath,
            entries: coordinator.getRegistry().listEntries(),
            pending: release !== null
        }),
        block: () => coordinator.setSessionPort({ waitForReady: async entry => receipt(entry, 'blocked') }),
        defer: () => coordinator.setSessionPort({
            waitForReady: entry => new Promise(resolve =>
            {
                release = () =>
                {
                    release = null;
                    resolve(receipt(entry, 'ready'));
                };
            })
        }),
        release: () => release?.(),
        async reset(nextCount: number): Promise<void>
        {
            app.unmount();
            await mountArticleWorkspaceTabFixture(nextCount, theme);
        },
        async remount(): Promise<void>
        {
            app.unmount();
            app = create();
            app.mount('#article-workspace-tab-fixture');
            await nextTick();
        }
    };
    Object.assign(window, { articleWorkspaceTabFixture: fixture });
    app.mount('#article-workspace-tab-fixture');
    await nextTick();
    document.documentElement.dataset.workspaceTabFixtureReady = 'true';
}
