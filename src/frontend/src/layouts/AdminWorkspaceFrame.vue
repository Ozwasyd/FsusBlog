<template>
    <AccountRouteFrame
        :area-label="workspaceContext.areaMeta.label"
        :nav-groups="navGroups"
        :content-classes="contentClasses"
        frame-class="admin-workspace-frame"
        :motion-policy="motionPolicy"
        :route-view-key="articleRouteViewKey"
        :route-outlet-enabled="!isArticleWorkspaceRouteValue || workspaceStartupState !== 'starting'"
    >
        <template #before-content="{ mobileNavigationActive }">
            <ArticleWorkspaceTabStrip v-if="isArticleWorkspaceRouteValue && workspaceStartupState !== 'starting'" />
            <div
                v-if="isArticleWorkspaceRouteValue"
                class="admin-workspace-library"
            >
                <ArticleLibraryRail
                    v-if="!mobileNavigationActive"
                    :presentation="libraryPresentation"
                    :active-group="libraryGroup"
                    :current-article-id="routeArticleIdentity?.articleId ?? null"
                    @group="selectLibraryGroup"
                    @page="forwardLibraryPage"
                    @open-article="openLibraryArticle"
                    @reveal-current="emit('revealCurrent', $event)"
                    @expanded="emit('expanded', $event)"
                />
                <p
                    v-if="libraryNavigationStatus"
                    role="status"
                >{{ libraryNavigationStatus }}</p>
            </div>
            <p
                v-if="isArticleWorkspaceRouteValue && workspaceStartupState !== 'started'"
                role="status"
            >{{ workspaceStartupState === 'starting' ? '正在恢复文章工作区…' : '文章工作区恢复暂不可用' }}</p>
        </template>
    </AccountRouteFrame>
</template>

<script lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import type { ArticleLibraryGroup, ArticleLibraryPresentation } from '@/components/admin/article/articleLibraryPresentation';
import ArticleLibraryRail from '@/components/admin/article/ArticleLibraryRail.vue';
import ArticleWorkspaceTabStrip from '@/components/admin/article/ArticleWorkspaceTabStrip.vue';
import { useArticleWorkspaceTabs } from '@/composables/useArticleWorkspaceTabs';
import { getAccountNavGroups } from '@/layouts/accountNav';
import { resolveAccountPageKindClass } from '@/layouts/accountPageKind';
import AccountRouteFrame from '@/layouts/AccountRouteFrame.vue';
import { resolveAccountRouteMotionPolicy } from '@/layouts/accountRouteMotion';
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext';
import {
    isAccountContentMode,
    isAccountPageKind,
    type AccountContentMode,
    type AccountPageKind
} from '@/router/accountRouteMeta';
import { retireArticleWorkspaceEditorSessions } from '@/services/authoring/articleWorkspaceEditorSessionComposition';
import { createArticleWorkspaceMountedEditorResolver, type ArticleWorkspaceMountedEditorSource } from '@/services/authoring/articleWorkspaceMountedEditorResolver';
import {
    articleWorkspaceTabRouter,
    isArticleWorkspaceRoute,
    type ArticleWorkspaceRouteLocation,
    type ArticleWorkspaceTabPresentation,
    type ArticleWorkspaceRouterReceipt
} from '@/services/authoring/articleWorkspaceTabRouter';
import { AuthoringTabGroupRegistry, type AuthoringTabGroupOptions, type AuthoringGroupCommandIdentity } from '@/services/authoring/authoringTabGroupRegistry';
import { connectAuthoringWorkspaceSessionSource, type AuthoringWorkspaceSessionSource } from '@/services/authoring/authoringWorkspaceSessionSource';
import { prepareAuthoringWorkspaceSnapshotBootstrap, bindAuthoringWorkspaceSnapshotBootstrapGroups } from '@/services/authoring/authoringWorkspaceSnapshotBootstrap';
import { applyAuthoringWorkspaceSnapshotRestore, type AuthoringWorkspaceSnapshotRestoreCommands, type AuthoringWorkspaceSnapshotRestorePlan } from '@/services/authoring/authoringWorkspaceSnapshotRestore';
import type { AuthoringWorkspaceSnapshotSync } from '@/services/authoring/authoringWorkspaceSnapshotSync';

/** Original-owner capabilities only; no null factory, local batch facts or fabricated receipts. */
export interface AdminArticleWorkspaceStartupPorts {
    readonly sync: AuthoringWorkspaceSnapshotSync;
    readonly resolutionPort: AuthoringWorkspaceSnapshotRestoreCommands['resolutionPort'];
    readonly mountedEditors: ArticleWorkspaceMountedEditorSource;
    readonly groupOptions: Omit<AuthoringTabGroupOptions, 'initialGroupId' | 'initialGroupIds'>;
    readonly createGroupIdentity: () => AuthoringGroupCommandIdentity;
    readonly operationEpoch: number;
    /** The original composition owner cancels this operation and disposes its sync/session resources. */
    readonly signal: AbortSignal;
    readonly assertRuntimeCapability: AuthoringWorkspaceSnapshotRestoreCommands['assertRuntimeCapability'];
    readonly applyShell: AuthoringWorkspaceSnapshotRestoreCommands['applyShell'];
    readonly isCurrent: AuthoringWorkspaceSnapshotRestoreCommands['isCurrent'];
}

// One original router/Registry has one startup installation, independent of route remounts.
let workspaceInstallation: {
    readonly ports: AdminArticleWorkspaceStartupPorts;
    failed: boolean;
    retirementFailure?: unknown;
    /** Preserve exact original objects for the original lifecycle owner's pending custody API. */
    readonly resources: {
        groups: AuthoringTabGroupRegistry | null;
        sessions: AuthoringWorkspaceSessionSource | null;
    };
    readonly task: Promise<{
        readonly plan: AuthoringWorkspaceSnapshotRestorePlan;
        readonly sessions: AuthoringWorkspaceSessionSource;
    }>;
} | undefined;

function requireCurrentStartup(ports: AdminArticleWorkspaceStartupPorts, plan: AuthoringWorkspaceSnapshotRestorePlan): void
{
    ports.signal.throwIfAborted();
    const state = ports.sync.getState();
    if (!ports.sync.getServerObservation() || state.dirty || state.resetting || !ports.isCurrent({
        scopeDigest: plan.scopeDigest,
        sourceDigest: plan.sourceDigest,
        serverRevision: plan.serverRevision,
        operationEpoch: plan.operationEpoch
    }))
    {
        throw new Error('article-workspace-startup-current-source-unavailable');
    }
    // The original current guard can synchronously cancel this operation.
    ports.signal.throwIfAborted();
}

async function startArticleWorkspace(
    ports: AdminArticleWorkspaceStartupPorts,
    resources: NonNullable<typeof workspaceInstallation>['resources'])
{
    const signal = ports.signal;
    signal.throwIfAborted();
    ports.assertRuntimeCapability();
    if (articleWorkspaceTabRouter.getRegistry().listEntries().length !== 0)
    {
        throw new Error('article-workspace-startup-requires-empty-registry');
    }
    if (!ports.sync.getServerObservation())
    {
        await ports.sync.start(typeof navigator !== 'undefined' && navigator.onLine);
    }
    const plan = await prepareAuthoringWorkspaceSnapshotBootstrap(ports.sync, ports.resolutionPort, ports.operationEpoch, signal);
    const groupOwner = new AuthoringTabGroupRegistry(articleWorkspaceTabRouter.getRegistry(), {
        ...ports.groupOptions,
        initialGroupId: plan.layout.activeGroupId,
        initialGroupIds: plan.layout.groups.map((group: AuthoringWorkspaceSnapshotRestorePlan['layout']['groups'][number]) => group.groupId)
    });
    resources.groups = groupOwner;
    const groupAdapter = bindAuthoringWorkspaceSnapshotBootstrapGroups(plan, articleWorkspaceTabRouter, groupOwner, ports.createGroupIdentity);
    const sessions = connectAuthoringWorkspaceSessionSource(groupOwner, createArticleWorkspaceMountedEditorResolver(ports.mountedEditors));
    resources.sessions = sessions;
    await applyAuthoringWorkspaceSnapshotRestore(plan, {
        router: articleWorkspaceTabRouter,
        resolutionPort: ports.resolutionPort,
        ...groupAdapter,
        assertRuntimeCapability: ports.assertRuntimeCapability,
        applyShell: ports.applyShell,
        isCurrent: ports.isCurrent
    }, signal);
    requireCurrentStartup(ports, plan);
    return { plan, sessions };
}

/** Sole host installer: failed/partial startup cannot be retried against a now-started Registry. */
function installArticleWorkspaceStartup(ports: AdminArticleWorkspaceStartupPorts): NonNullable<typeof workspaceInstallation>['task']
{
    const installed = workspaceInstallation;
    if (installed)
    {
        if (installed.ports !== ports)
        {
            return Promise.reject(new Error('article-workspace-startup-owner-changed'));
        }
        if (installed.failed)
        {
            return Promise.reject(new Error('article-workspace-startup-failed-custody-required'));
        }
        return installed.task.then((result) =>
        {
            requireCurrentStartup(ports, result.plan);
            return result;
        });
    }
    const resources: NonNullable<typeof workspaceInstallation>['resources'] = { groups: null, sessions: null };
    // Reserve the sole installation before any original capability callback can re-enter it.
    const task = Promise.resolve().then(() => startArticleWorkspace(ports, resources)).catch((error: unknown) =>
    {
        markWorkspaceInstallationFailed(ports);
        throw error;
    });
    workspaceInstallation = { ports, resources, failed: false, task };
    return task;
}

function markWorkspaceInstallationFailed(ports: AdminArticleWorkspaceStartupPorts): void
{
    if (workspaceInstallation?.ports === ports)
    {
        workspaceInstallation.failed = true;
        const sessions = workspaceInstallation.resources.sessions;
        if (sessions)
        {
            // The original owner revokes admission and retains its actual Host/factory; no disposal claim.
            try
            {
                retireArticleWorkspaceEditorSessions(sessions.host);
            }
            catch (error: unknown)
            {
                // Keep failure/resources observable in this installation; never reopen admission.
                workspaceInstallation.retirementFailure = error;
            }
        }
    }
}
</script>

<script setup lang="ts">
const props = defineProps<{
    /** Only the shared query owner can supply an admitted display page. */
    libraryPresentation?: ArticleLibraryPresentation;
    /** Supplied by the original snapshot/layout/retained-editor composition owners. */
    workspaceStartup?: AdminArticleWorkspaceStartupPorts;
}>();
const emit = defineEmits<{
    group: [group: ArticleLibraryGroup];
    page: [group: ArticleLibraryGroup, direction: 'previous' | 'next'];
    openArticle: [articleId: number];
    revealCurrent: [articleId: number];
    expanded: [expanded: boolean];
    navigation: [receipt: ArticleWorkspaceRouterReceipt];
    workspaceStarted: [source: AuthoringWorkspaceSessionSource];
}>();
const route = useRoute();
const workspaceStartupState = ref<'unavailable' | 'starting' | 'started'>('unavailable');
const startupPorts = props.workspaceStartup;
let mounted = true;
function markWorkspaceStartupUnavailable(): void
{
    workspaceStartupState.value = 'unavailable';
    if (startupPorts)
    {
        markWorkspaceInstallationFailed(startupPorts);
    }
}
if (startupPorts)
{
    workspaceStartupState.value = 'starting';
    startupPorts.signal.addEventListener('abort', markWorkspaceStartupUnavailable);
    void installArticleWorkspaceStartup(startupPorts).then(({ plan, sessions }) =>
    {
        if (!mounted)
        {
            return;
        }
        if (props.workspaceStartup !== startupPorts || workspaceInstallation?.ports !== startupPorts)
        {
            throw new Error('article-workspace-startup-owner-changed');
        }
        requireCurrentStartup(startupPorts, plan);
        // Recheck after the original guard callback, immediately before local publication.
        if (!mounted || props.workspaceStartup !== startupPorts || startupPorts.signal.aborted)
        {
            markWorkspaceStartupUnavailable();
            return;
        }
        workspaceStartupState.value = 'started';
        // Hand the layout owner the same original group/host, never a reconstructed projection.
        emit('workspaceStarted', sessions);
    }).catch(() =>
    {
        markWorkspaceInstallationFailed(startupPorts);
        if (mounted)
        {
            workspaceStartupState.value = 'unavailable';
        }
    });
}
onBeforeUnmount(() =>
{
    mounted = false;
    startupPorts?.signal.removeEventListener('abort', markWorkspaceStartupUnavailable);
});
const { tabs, activateTab } = useArticleWorkspaceTabs();
const libraryGroup = ref<ArticleLibraryGroup>('recent');
const libraryNavigationStatus = ref('');
const libraryPresentation = computed<ArticleLibraryPresentation>(() => props.libraryPresentation ?? {
    state: 'unconnected',
    group: libraryGroup.value
});
const articleWorkspaceRouteLocation = computed<ArticleWorkspaceRouteLocation>(() => ({
    name: typeof route.name === 'string' ? route.name : null,
    path: route.path,
    fullPath: route.fullPath
}));
const isArticleWorkspaceRouteValue = computed(() => isArticleWorkspaceRoute(articleWorkspaceRouteLocation.value));
const routeArticleId = computed<number | null>(() =>
{
    const raw = route.params.id;
    const value = Number(Array.isArray(raw) ? raw[0] : raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
});
// Registry publication, Rail state and URL query/hash changes cannot rekey the mounted editor.
const articleRouteViewKey = computed(() =>
{
    if (route.name === 'ManageWriteArticle')
    {
        return 'ManageWriteArticle';
    }
    return route.name === 'ManageEditArticle' && routeArticleId.value !== null
        ? `ManageEditArticle:${routeArticleId.value}`
        : undefined;
});
const workspaceContext = useAccountWorkspaceContext();
const navGroups = computed(() => getAccountNavGroups({
    ...workspaceContext.value,
    surface: 'manage'
}));
const pageKind = computed<AccountPageKind>(() =>
{
    if (!isAccountPageKind(route.meta.accountPageKind))
    {
        if (import.meta.env.DEV)
        {
            throw new Error(`Account route ${route.path} is missing a valid accountPageKind`);
        }
        return 'collection';
    }

    return route.meta.accountPageKind;
});
const contentMode = computed<AccountContentMode>(() => (
    isAccountContentMode(route.meta.accountContentMode)
        ? route.meta.accountContentMode
        : 'wide'
));
const pageKindClass = computed(() => resolveAccountPageKindClass('manage', pageKind.value));
const motionPolicy = computed(() => resolveAccountRouteMotionPolicy(
    'manage',
    pageKind.value,
    contentMode.value
));
const contentClasses = computed(() => [
    contentMode.value === 'takeover'
        ? 'account-frame-outlet--takeover'
        : 'account-frame-outlet--default',
    pageKindClass.value
]);

const routeArticleIdentity = computed<ArticleWorkspaceTabPresentation | null>(() =>
{
    if (!isArticleWorkspaceRouteValue.value)
    {
        return null;
    }

    const articleId = routeArticleId.value;
    if (articleId !== null)
    {
        return tabs.value.find((tab) => tab.articleId === articleId) ?? null;
    }

    const draftTabs = tabs.value.filter((tab) => tab.articleId === null);
    return draftTabs.length === 1 ? draftTabs[0] ?? null : null;
});

function selectLibraryGroup(group: ArticleLibraryGroup): void
{
    libraryGroup.value = group;
    libraryNavigationStatus.value = '';
    emit('group', group);
}

function forwardLibraryPage(group: ArticleLibraryGroup, direction: 'previous' | 'next'): void
{
    emit('page', group, direction);
}

async function openLibraryArticle(articleId: number): Promise<void>
{
    if (workspaceStartupState.value !== 'started')
    {
        libraryNavigationStatus.value = '文章工作区启动尚未完成';
        return;
    }
    const tab = tabs.value.find((item) => item.articleId === articleId);
    if (!tab)
    {
        // The original document/session owner must supply the complete new-document open input.
        libraryNavigationStatus.value = '文章打开尚未接入文档会话';
        emit('openArticle', articleId);
        return;
    }
    try
    {
        const receipt = await activateTab(tab.tabId);
        libraryNavigationStatus.value = receipt.sessionState === 'blocked'
            || receipt.resultStatus === 'blocked' || receipt.resultStatus.startsWith('rejected')
            ? '文章导航暂不可用' : '';
        emit('navigation', receipt);
    }
    catch
    {
        libraryNavigationStatus.value = '文章导航暂不可用';
    }
}

watch([() => route.fullPath, workspaceStartupState], () =>
{
    libraryNavigationStatus.value = '';
    // Missing/unsupported restore ports must not disable the existing route-owned editor flow.
    if (!isArticleWorkspaceRouteValue.value || workspaceStartupState.value === 'starting')
    {
        return;
    }

    const tab = routeArticleIdentity.value;
    void articleWorkspaceTabRouter.syncRoute({
        route: articleWorkspaceRouteLocation.value,
        identity: tab
            ? {
                articleId: tab.articleId,
                draftId: tab.draftId,
                documentId: tab.documentId
            }
            : undefined
    });
}, { immediate: true });
</script>

<style scoped lang="scss">
.admin-workspace-library
{
    // The Rail panel is out of flow; expansion does not change the outlet's inline size.
    display: flex;
    align-items: center;
    gap: var(--fsus-space-2);
}
</style>
