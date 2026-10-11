<template>
    <AccountRouteFrame
        :area-label="workspaceContext.areaMeta.label"
        :nav-groups="navGroups"
        :content-classes="contentClasses"
        frame-class="admin-workspace-frame"
        :motion-policy="motionPolicy"
        :route-view-key="articleRouteViewKey"
        :route-outlet-enabled="!isArticleWorkspaceRouteValue || workspaceStartupState !== 'starting'"
        @route-outlet="captureRouteOutlet"
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
import { computed, onBeforeUnmount, provide, ref, shallowReadonly, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';

import { defaultWorkspaceSnapshotLayout } from '@/api/authoringWorkspaceSnapshot';
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
import { installArticleWorkspaceEditorSessions, retireArticleWorkspaceEditorSessions } from '@/services/authoring/articleWorkspaceEditorSessionComposition';
import { createArticleWorkspaceMountedEditorResolver, type ArticleWorkspaceMountedEditorSource } from '@/services/authoring/articleWorkspaceMountedEditorResolver';
import {
    articleWorkspaceTabRouter,
    isArticleWorkspaceRoute,
    type ArticleWorkspaceRouteLocation,
    type ArticleWorkspaceTabPresentation,
    type ArticleWorkspaceRouterReceipt
} from '@/services/authoring/articleWorkspaceTabRouter';
import { AuthoringTabGroupRegistry, type AuthoringTabGroupOptions, type AuthoringGroupCommandIdentity, type AuthoringTabGroupStartupCustody } from '@/services/authoring/authoringTabGroupRegistry';
import { authoringWorkspaceLayoutSourceKey, type AuthoringWorkspaceLayoutPort } from '@/services/authoring/authoringWorkspaceLayoutContext';
import type { AuthoringWorkspaceLayoutSource } from '@/services/authoring/authoringWorkspaceLayoutController';
import { connectAuthoringWorkspaceSessionSource, type AuthoringWorkspaceSessionSource } from '@/services/authoring/authoringWorkspaceSessionSource';
import { prepareAuthoringWorkspaceSnapshotBootstrap, bindAuthoringWorkspaceSnapshotBootstrapGroups } from '@/services/authoring/authoringWorkspaceSnapshotBootstrap';
import { applyAuthoringWorkspaceSnapshotRestore, type AuthoringWorkspaceSnapshotRestoreCommands, type AuthoringWorkspaceSnapshotRestorePlan } from '@/services/authoring/authoringWorkspaceSnapshotRestore';
import type { AuthoringWorkspaceSnapshotSync } from '@/services/authoring/authoringWorkspaceSnapshotSync';
import type { ArticleWorkspaceMountedEditorResolver } from '@/services/authoring/fsusUiEditorSessionFactory';

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
    /** Actual layout authority: real measurements, identities and synchronous before/after notifications. */
    readonly layout?: Omit<AuthoringWorkspaceLayoutSource, 'groups' | 'sessions' | 'mountedEditors' | 'measure'> & {
        measure(projection: Parameters<AuthoringWorkspaceLayoutSource['measure']>[0],
            mountedLayout: AuthoringWorkspaceLayoutPort): ReturnType<AuthoringWorkspaceLayoutSource['measure']>;
    };
}

// One original router/Registry has one startup installation, independent of route remounts.
let workspaceInstallation: {
    readonly ports: AdminArticleWorkspaceStartupPorts;
    failed: boolean;
    revoking: boolean;
    retirementFailure?: unknown;
    groupRetirementFailure?: unknown;
    layoutInvalidationFailure?: unknown;
    stopObservingCancellation?: () => void;
    /** Retain the exact original owners, their custody handle and the actual in-flight task. */
    readonly resources: {
        groups: AuthoringTabGroupRegistry | null;
        custody: AuthoringTabGroupStartupCustody | null;
        resolver: ArticleWorkspaceMountedEditorResolver | null;
        sessions: AuthoringWorkspaceSessionSource | null;
        readonly invalidateLayouts: Set<() => void>;
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
    const observation = ports.sync.getServerObservation();
    if (!observation || state.dirty || state.resetting || !ports.isCurrent({
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
    const current = ports.sync.getState();
    if (ports.sync.getServerObservation() !== observation || current.dirty || current.resetting)
    {
        throw new Error('article-workspace-startup-current-source-unavailable');
    }
}

async function startArticleWorkspace(
    ports: AdminArticleWorkspaceStartupPorts,
    resources: NonNullable<typeof workspaceInstallation>['resources'])
{
    const signal = ports.signal;
    signal.throwIfAborted();
    ports.assertRuntimeCapability();
    signal.throwIfAborted();
    const registry = articleWorkspaceTabRouter.getRegistry();
    if (registry.getRevision() !== 0 || registry.listEntries().length !== 0)
    {
        throw new Error('article-workspace-startup-requires-empty-registry');
    }
    if (!ports.sync.getServerObservation())
    {
        await ports.sync.start(typeof navigator !== 'undefined' && navigator.onLine);
    }
    signal.throwIfAborted();
    const observation = ports.sync.getServerObservation();
    const state = ports.sync.getState();
    if (!observation || state.dirty || state.resetting)
    {
        throw new Error('article-workspace-startup-current-source-unavailable');
    }
    if (articleWorkspaceTabRouter.getRegistry() !== registry || registry.getRevision() !== 0 || registry.listEntries().length !== 0)
    {
        throw new Error('article-workspace-startup-requires-empty-registry');
    }
    // Only the authentic server layout (or the original missing-server default) supplies group IDs.
    const layout = observation.snapshot?.layout ?? defaultWorkspaceSnapshotLayout();
    const groupOwner = new AuthoringTabGroupRegistry(registry, {
        ...ports.groupOptions,
        initialGroupId: layout.activeGroupId,
        initialGroupIds: layout.groups.map(group => group.groupId)
    });
    resources.groups = groupOwner;
    resources.custody = groupOwner.beginStartupCustody();
    signal.throwIfAborted();
    if (ports.sync.getServerObservation() !== observation)
    {
        throw new Error('article-workspace-startup-current-source-unavailable');
    }
    // Claim original custody before the first asynchronous restore preparation/mutation.
    const plan = await prepareAuthoringWorkspaceSnapshotBootstrap(ports.sync, ports.resolutionPort, ports.operationEpoch, signal);
    const groupAdapter = bindAuthoringWorkspaceSnapshotBootstrapGroups(plan, articleWorkspaceTabRouter, groupOwner, ports.createGroupIdentity);
    const resolver = createArticleWorkspaceMountedEditorResolver(ports.mountedEditors);
    resources.resolver = resolver;
    const sessions = connectAuthoringWorkspaceSessionSource(groupOwner, resolver);
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
    const resources: NonNullable<typeof workspaceInstallation>['resources'] = {
        groups: null,
        custody: null,
        resolver: null,
        sessions: null,
        invalidateLayouts: new Set()
    };
    // Reserve the sole installation before any original capability callback can re-enter it.
    const task = Promise.resolve().then(() => startArticleWorkspace(ports, resources)).catch((error: unknown) =>
    {
        markWorkspaceInstallationFailed(ports);
        throw error;
    });
    workspaceInstallation = { ports, resources, failed: false, revoking: false, task };
    // Observe the original operation lifetime even after its current view unmounts.
    const onCancellation = () => markWorkspaceInstallationFailed(ports);
    ports.signal.addEventListener('abort', onCancellation, { once: true });
    workspaceInstallation.stopObservingCancellation = () => ports.signal.removeEventListener('abort', onCancellation);
    if (ports.signal.aborted)
    {
        markWorkspaceInstallationFailed(ports);
    }
    return task;
}

function markWorkspaceInstallationFailed(ports: AdminArticleWorkspaceStartupPorts): void
{
    const installation = workspaceInstallation;
    if (installation?.ports !== ports)
    {
        return;
    }
    // Close admission before any subscriber can re-enter this installation.
    installation.failed = true;
    if (installation.revoking)
    {
        return;
    }
    installation.revoking = true;
    try
    {
        for (const invalidate of [...installation.resources.invalidateLayouts])
        {
            try
            {
                invalidate();
            }
            catch (error: unknown)
            {
                installation.layoutInvalidationFailure = error;
            }
        }
        const custody = installation.resources.custody;
        if (custody?.inspect().status === 'handed-off')
        {
            // Successful startup transferred admission custody; do not retire its ongoing owner.
            return;
        }
        if (custody)
        {
            try
            {
                custody.retire(ports.signal.aborted ? 'restore-cancelled' : 'restore-failed');
            }
            catch (error: unknown)
            {
                installation.groupRetirementFailure = error;
            }
        }
        const sessions = installation.resources.sessions;
        if (sessions)
        {
            // The original owner revokes admission and retains its actual Host/factory; no disposal claim.
            try
            {
                retireArticleWorkspaceEditorSessions(sessions.host);
            }
            catch (error: unknown)
            {
                installation.retirementFailure = error;
            }
        }
    }
    finally
    {
        installation.revoking = false;
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
const layoutPorts = startupPorts?.layout;
const workspaceLayoutSource = shallowRef<AuthoringWorkspaceLayoutSource | null>(null);
// Keep original owner objects unproxied while preventing descendants from replacing the ref.
provide(authoringWorkspaceLayoutSourceKey, shallowReadonly(workspaceLayoutSource));
const layoutInvalidationListeners = new Set<() => void>();
const routeOutletInstance = shallowRef<unknown>(null);
let mounted = true;
let layoutRevoking = false;
let layoutRevoked = false;
let layoutEpoch = 0;
function notifyWorkspaceLayoutInvalidation(): void
{
    // These are visual revocation subscribers only, never another group/session authority.
    for (const listener of [...layoutInvalidationListeners])
    {
        try
        {
            listener();
        }
        catch (error: unknown)
        {
            const installation = workspaceInstallation;
            if (installation && installation.ports === startupPorts)
            {
                installation.layoutInvalidationFailure = error;
            }
        }
    }
}
function invalidateWorkspaceLayout(): void
{
    layoutRevoked = true;
    layoutEpoch++;
    if (layoutRevoking)
    {
        // Reentrant revocation may clear the ref, but never recursively notifies subscribers.
        workspaceLayoutSource.value = null;
        return;
    }
    layoutRevoking = true;
    try
    {
        notifyWorkspaceLayoutInvalidation();
        workspaceLayoutSource.value = null;
        notifyWorkspaceLayoutInvalidation();
    }
    finally
    {
        layoutRevoking = false;
    }
}
function captureRouteOutlet(instance: unknown): void
{
    if (routeOutletInstance.value === instance)
    {
        return;
    }
    const capturedEpoch = ++layoutEpoch;
    if (layoutRevoking)
    {
        routeOutletInstance.value = instance;
        return;
    }
    layoutRevoking = true;
    try
    {
        notifyWorkspaceLayoutInvalidation();
        if (layoutEpoch === capturedEpoch)
        {
            routeOutletInstance.value = instance;
        }
        notifyWorkspaceLayoutInvalidation();
    }
    finally
    {
        layoutRevoking = false;
    }
}

function hasPublicWorkspaceLayout(value: unknown): value is { getAuthoringWorkspaceLayoutPort(): unknown; }
{
    return !!value && typeof value === 'object' && 'getAuthoringWorkspaceLayoutPort' in value
        && typeof value.getAuthoringWorkspaceLayoutPort === 'function';
}
function isPublicWorkspaceLayoutPort(value: unknown): value is AuthoringWorkspaceLayoutPort
{
    return !!value && typeof value === 'object' && 'refresh' in value && typeof value.refresh === 'function'
        && 'invalidate' in value && typeof value.invalidate === 'function'
        && 'readFrameRect' in value && typeof value.readFrameRect === 'function'
        && 'readSeparatorRect' in value && typeof value.readSeparatorRect === 'function';
}
function readMountedWorkspaceLayout(): AuthoringWorkspaceLayoutPort
{
    const outlet = routeOutletInstance.value;
    const port = hasPublicWorkspaceLayout(outlet) ? outlet.getAuthoringWorkspaceLayoutPort() : null;
    if (routeOutletInstance.value !== outlet || !isPublicWorkspaceLayoutPort(port))
    {
        throw new Error('article-workspace-layout-public-mount-unavailable');
    }
    return port;
}
function createWorkspaceLayoutSource(sessions: AuthoringWorkspaceSessionSource): AuthoringWorkspaceLayoutSource | null
{
    if (!startupPorts || !layoutPorts)
    {
        return null;
    }
    const ports = startupPorts;
    const layout = layoutPorts;
    const requireOwner = (expectedEpoch: number): void =>
    {
        ports.signal.throwIfAborted();
        if (!mounted || layoutRevoking || layoutRevoked || layoutEpoch !== expectedEpoch
            || props.workspaceStartup !== ports || ports.layout !== layout
            || workspaceInstallation?.ports !== ports || workspaceInstallation.failed
            || workspaceInstallation.resources.sessions !== sessions)
        {
            throw new Error('article-workspace-layout-original-source-unavailable');
        }
    };
    return Object.freeze<AuthoringWorkspaceLayoutSource>({
        groups: sessions.groups,
        sessions,
        mountedEditors: ports.mountedEditors,
        reserveOperationIdentity: (projection) =>
        {
            const expectedEpoch = layoutEpoch;
            requireOwner(expectedEpoch);
            const identity = layout.reserveOperationIdentity(projection);
            requireOwner(expectedEpoch);
            return identity;
        },
        measure: (projection) =>
        {
            const expectedEpoch = layoutEpoch;
            requireOwner(expectedEpoch);
            const port = readMountedWorkspaceLayout();
            const frame = port.readFrameRect();
            const separator = port.readSeparatorRect();
            const measured = layout.measure(projection, port);
            requireOwner(expectedEpoch);
            const currentFrame = port.readFrameRect();
            const currentSeparator = port.readSeparatorRect();
            if (readMountedWorkspaceLayout() !== port || !frame || !separator || !currentFrame || !currentSeparator
                || frame.left !== currentFrame.left || frame.top !== currentFrame.top
                || frame.width !== currentFrame.width || frame.height !== currentFrame.height
                || separator.left !== currentSeparator.left || separator.top !== currentSeparator.top
                || separator.width !== currentSeparator.width || separator.height !== currentSeparator.height
                || measured.frame.left !== frame.left || measured.frame.top !== frame.top
                || measured.frame.width !== frame.width || measured.frame.height !== frame.height
                || measured.splitterFootprintCssPx !== separator.width)
            {
                throw new Error('article-workspace-layout-current-measurement-unavailable');
            }
            requireOwner(expectedEpoch);
            return measured;
        },
        subscribeInvalidation: (listener) =>
        {
            const expectedEpoch = layoutEpoch;
            requireOwner(expectedEpoch);
            layoutInvalidationListeners.add(listener);
            let release: (() => void) | undefined;
            try
            {
                // The original owner must notify before mutations and again after publication.
                release = layout.subscribeInvalidation(listener);
                requireOwner(expectedEpoch);
            }
            catch (error: unknown)
            {
                layoutInvalidationListeners.delete(listener);
                release?.();
                throw error;
            }
            const releaseOriginal = release;
            return () =>
            {
                layoutInvalidationListeners.delete(listener);
                releaseOriginal();
            };
        }
    });
}
function markWorkspaceStartupUnavailable(): void
{
    if (startupPorts)
    {
        markWorkspaceInstallationFailed(startupPorts);
    }
    invalidateWorkspaceLayout();
    workspaceStartupState.value = 'unavailable';
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
        if (props.workspaceStartup !== startupPorts || workspaceInstallation?.ports !== startupPorts
            || workspaceInstallation.failed)
        {
            throw new Error('article-workspace-startup-owner-changed');
        }
        const publicationEpoch = layoutEpoch;
        const layoutSource = createWorkspaceLayoutSource(sessions);
        requireCurrentStartup(startupPorts, plan);
        startupPorts.assertRuntimeCapability();
        const resources = workspaceInstallation.resources;
        if (!resources.custody || !resources.groups || !resources.resolver || resources.sessions !== sessions
            || sessions.groups !== resources.groups || !resources.groups.verifyBinding(articleWorkspaceTabRouter.getRegistry())
            || installArticleWorkspaceEditorSessions(resources.resolver) !== sessions.host)
        {
            throw new Error('article-workspace-startup-original-session-owner-unavailable');
        }
        requireCurrentStartup(startupPorts, plan);
        // Recheck after the original guard callback, immediately before local publication.
        if (!mounted || layoutRevoking || layoutRevoked || layoutEpoch !== publicationEpoch
            || props.workspaceStartup !== startupPorts || startupPorts.signal.aborted || workspaceInstallation.failed)
        {
            markWorkspaceStartupUnavailable();
            return;
        }
        resources.custody.sealHandoff();
        workspaceInstallation.stopObservingCancellation?.();
        workspaceLayoutSource.value = layoutSource;
        const requirePublishedSource = (): void =>
        {
            const requireLocalPublication = (): void =>
            {
                if (!mounted || layoutRevoking || layoutRevoked || layoutEpoch !== publicationEpoch
                    || startupPorts.signal.aborted || props.workspaceStartup !== startupPorts
                    || workspaceInstallation?.ports !== startupPorts || workspaceInstallation.failed
                    || workspaceLayoutSource.value !== layoutSource)
                {
                    throw new Error('article-workspace-startup-publication-revoked');
                }
            };
            requireLocalPublication();
            requireCurrentStartup(startupPorts, plan);
            requireLocalPublication();
        };
        // Both ref setters can synchronously invoke original consumers and cancel/revoke this operation.
        requirePublishedSource();
        workspaceStartupState.value = 'started';
        requirePublishedSource();
        // Hand the layout owner the same original group/host, never a reconstructed projection.
        emit('workspaceStarted', sessions);
    }).catch(() =>
    {
        markWorkspaceInstallationFailed(startupPorts);
        invalidateWorkspaceLayout();
        if (mounted)
        {
            workspaceStartupState.value = 'unavailable';
        }
    });
    workspaceInstallation?.resources.invalidateLayouts.add(invalidateWorkspaceLayout);
}
watch(() => props.workspaceStartup, () =>
{
    if (props.workspaceStartup !== startupPorts)
    {
        markWorkspaceStartupUnavailable();
    }
}, { flush: 'sync' });
onBeforeUnmount(() =>
{
    mounted = false;
    invalidateWorkspaceLayout();
    workspaceInstallation?.resources.invalidateLayouts.delete(invalidateWorkspaceLayout);
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
