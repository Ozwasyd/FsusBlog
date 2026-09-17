// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ArticleWorkspaceTabStrip from '@/components/admin/article/ArticleWorkspaceTabStrip.vue';
import {
    ArticleWorkspaceTabRouter,
    type ArticleWorkspaceNavigationPort,
    type ArticleWorkspaceOpenInput
} from '@/services/authoring/articleWorkspaceTabRouter';
import type { ArticleWorkspaceStatusSummary } from '@/services/authoring/openArticleDocumentRegistry';

const originalMatchMedia = window.matchMedia;

const status = (overrides: Partial<ArticleWorkspaceStatusSummary> = {}): ArticleWorkspaceStatusSummary => ({
    dirty: false,
    saving: false,
    conflict: false,
    recovery: false,
    pendingAttachments: false,
    permission: 'allowed',
    lifecycle: 'current',
    statusRef: 'status:workspace-test',
    ...overrides
});

const input = (articleId: number, overrides: Partial<ArticleWorkspaceOpenInput> = {}): ArticleWorkspaceOpenInput => ({
    identity: {
        articleId,
        draftId: `draft:article:${articleId}`,
        documentId: `document:article:${articleId}`
    },
    documentContext: {
        documentEpoch: 1,
        sourceRevision: `source:article:${articleId}`,
        draftRevision: `draft:article:${articleId}`
    },
    title: `文章 ${articleId}`,
    status: status({ statusRef: `status:article:${articleId}` }),
    targetGroupId: 'group:primary',
    tabKind: 'pinned',
    entrypoint: 'direct-route',
    route: `/user/manage/article/edit/${articleId}`,
    ...overrides
});

function navigation(): ArticleWorkspaceNavigationPort & { push: ReturnType<typeof vi.fn>; }
{
    return {
        currentFullPath: '/user/manage/article/edit/1',
        push: vi.fn(async () => undefined)
    };
}

async function mountStrip(
    coordinator: ArticleWorkspaceTabRouter,
    router: ArticleWorkspaceNavigationPort
)
{
    const wrapper = mount(ArticleWorkspaceTabStrip, {
        props: { coordinator, router },
        attachTo: document.body
    });
    await nextTick();
    return wrapper;
}

afterEach(() =>
{
    window.matchMedia = originalMatchMedia;
    document.body.innerHTML = '';
});

describe('ArticleWorkspaceTabStrip (#2295)', () => {
    it.each([0, 1, 20, 100])('keeps the rendered tab projection bounded for %i registry tabs', async (count) => {
        const coordinator = new ArticleWorkspaceTabRouter();
        for (let articleId = 1; articleId <= count; articleId += 1)
        {
            await coordinator.openOrActivate(input(articleId));
        }
        const wrapper = await mountStrip(coordinator, navigation());

        expect(wrapper.findAll('[role="tab"]')).toHaveLength(Math.min(count, 24));
        expect(wrapper.find('.article-workspace-tabs__overflow').exists()).toBe(count > 1);
        wrapper.unmount();
    });

    it('projects registry tabs with tab semantics and activates through the route port', async () => {
        const coordinator = new ArticleWorkspaceTabRouter();
        await coordinator.openOrActivate(input(1));
        await coordinator.openOrActivate(input(2));
        const router = navigation();
        const wrapper = await mountStrip(coordinator, router);

        expect(wrapper.find('[role="tablist"]').exists()).toBe(true);
        expect(wrapper.findAll('[role="tab"]')).toHaveLength(2);
        expect(wrapper.text()).toContain('文章 1');
        expect(wrapper.text()).toContain('已固定');
        expect(wrapper.text()).not.toContain('category');

        await wrapper.get('[role="tab"][aria-label^="文章 1，"]').trigger('click');
        await nextTick();
        expect(router.push).toHaveBeenCalledWith('/user/manage/article/edit/1');
        expect(coordinator.getActiveTab()?.articleId).toBe(1);
        wrapper.unmount();
    });

    it('bounds the desktop tab band, supports keyboard navigation, overflow and middle-click close request', async () => {
        const coordinator = new ArticleWorkspaceTabRouter();
        for (let articleId = 1; articleId <= 100; articleId += 1)
        {
            await coordinator.openOrActivate(input(articleId));
        }
        const middleTab = coordinator.listTabs().find((tab) => tab.articleId === 50);
        await coordinator.activateTab(middleTab!.tabId);
        const router = navigation();
        const wrapper = await mountStrip(coordinator, router);

        expect(wrapper.findAll('[role="tab"]')).toHaveLength(24);
        const renderedArticleIds = wrapper.findAll('[role="tab"]').map((tab) =>
            Number(tab.attributes('aria-label')?.match(/文章 (\d+)/u)?.[1]));
        const active = wrapper.get('[role="tab"][aria-label^="文章 50，"]');
        await active.trigger('keydown', { key: 'ArrowRight' });
        await vi.waitFor(() => expect(coordinator.getActiveTab()?.articleId).not.toBe(50));
        await nextTick();
        await nextTick();
        const activeArticleId = coordinator.getActiveTab()?.articleId;
        expect(renderedArticleIds).toContain(activeArticleId);

        const tabButton = wrapper.get(`button[role="tab"][aria-label^="文章 ${activeArticleId}，"]`);
        tabButton.element.dispatchEvent(new MouseEvent('auxclick', {
            bubbles: true,
            cancelable: true,
            button: 1
        }));
        await nextTick();
        const closedRequestTab = coordinator.listTabs().find((tab) => tab.articleId === activeArticleId);
        expect(coordinator.getRegistry().getEntry(closedRequestTab!.tabId)?.closeRequestRef).toBeTruthy();

        const overflowTrigger = wrapper.get('.article-workspace-tabs__overflow');
        await overflowTrigger.trigger('click');
        expect(wrapper.findAll('.article-workspace-tabs__overflow-item')).toHaveLength(100);
        await wrapper.get('.article-workspace-tabs__overflow-list').trigger('keydown', { key: 'ArrowDown' });
        expect(document.activeElement).toBe(wrapper.find('.article-workspace-tabs__overflow-tab').element);
        await wrapper.get('.article-workspace-tabs__overflow-list').trigger('keydown', { key: 'Escape' });
        expect(document.activeElement).toBe(overflowTrigger.element);
        wrapper.unmount();
    });

    it('uses the compact current-tab switcher at the mobile breakpoint', async () => {
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
            matches: query === '(max-width: 1023px)',
            media: query,
            onchange: null,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn()
        }));
        const coordinator = new ArticleWorkspaceTabRouter();
        await coordinator.openOrActivate(input(7));
        await coordinator.openOrActivate(input(8));
        const wrapper = await mountStrip(coordinator, navigation());

        expect(wrapper.find('[data-article-workspace-tab-strip="desktop"]').exists()).toBe(false);
        expect(wrapper.find('[data-article-workspace-tab-strip="mobile"]').exists()).toBe(true);
        expect(wrapper.get('.article-workspace-tabs__compact-trigger').text()).toContain('文章 8');
        await wrapper.get('.article-workspace-tabs__compact-trigger').trigger('click');
        expect(wrapper.findAll('.article-workspace-tabs__compact-item')).toHaveLength(2);
        wrapper.unmount();
    });
});
