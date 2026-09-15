import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import {
    ArticleWorkspaceTabRouter,
    articleWorkspaceTabRouter,
    type ArticleWorkspaceNavigationPort,
    type ArticleWorkspaceTabPresentation
} from '@/services/authoring/articleWorkspaceTabRouter';

export interface ArticleWorkspaceTabsOptions {
    coordinator?: ArticleWorkspaceTabRouter;
    router?: ArticleWorkspaceNavigationPort;
}

export function useArticleWorkspaceTabs(options: ArticleWorkspaceTabsOptions = {})
{
    const coordinator = options.coordinator ?? articleWorkspaceTabRouter;
    const defaultRouter = options.router ? null : useRouter();
    const tabs = ref<ArticleWorkspaceTabPresentation[]>(coordinator.listTabs());
    let unsubscribe: (() => void) | null = null;

    const refresh = (): void =>
    {
        tabs.value = coordinator.listTabs();
    };

    const routerPort = computed<ArticleWorkspaceNavigationPort>(() => options.router ?? {
        currentFullPath: defaultRouter?.currentRoute.value.fullPath ?? '',
        push: (location: string) => defaultRouter?.push(location) ?? Promise.resolve()
    });

    const activeTab = computed(() => tabs.value.find((tab) => tab.isActive) ?? null);

    const activateTab = async (tabId: string) =>
    {
        const receipt = await coordinator.activateAndNavigate(tabId, routerPort.value);
        refresh();
        return receipt;
    };

    const promotePreview = async (tabId: string) =>
    {
        const receipt = await coordinator.promotePreview(tabId);
        refresh();
        return receipt;
    };

    const unpinTab = async (tabId: string) =>
    {
        const receipt = await coordinator.unpinTab(tabId);
        refresh();
        return receipt;
    };

    const requestClose = (tabId: string) =>
    {
        const receipt = coordinator.requestClose(tabId);
        refresh();
        return receipt;
    };

    onMounted(() =>
    {
        refresh();
        unsubscribe = coordinator.subscribe(refresh);
    });

    onUnmounted(() =>
    {
        unsubscribe?.();
        unsubscribe = null;
    });

    return {
        tabs,
        activeTab,
        activateTab,
        promotePreview,
        unpinTab,
        requestClose,
        refresh
    };
}
