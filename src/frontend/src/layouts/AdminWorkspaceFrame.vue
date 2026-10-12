<template>
    <AccountRouteFrame
        :area-label="workspaceContext.areaMeta.label"
        :nav-groups="navGroups"
        :content-classes="contentClasses"
        frame-class="admin-workspace-frame"
        :motion-policy="motionPolicy"
        :route-view-key="articleRouteViewKey"
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
import { cancelAdminArticleWorkspaceSnapshotStartup, connectAdminArticleWorkspaceSnapshotStartup, disposeAdminArticleWorkspaceSnapshotStartup, type AdminArticleWorkspaceSnapshotCaller } from '@/layouts/adminArticleWorkspaceSnapshotCaller';
import type { AdminArticleWorkspaceStartupPorts } from '@/layouts/adminArticleWorkspaceStartup';
import {
    isAccountContentMode,
    isAccountPageKind,
    type AccountContentMode,
    type AccountPageKind
} from '@/router/accountRouteMeta';
import { installArticleWorkspaceEditorSessions } from '@/services/authoring/articleWorkspaceEditorSessionComposition';
import { createArticleWorkspaceMountedEditorResolver } from '@/services/authoring/articleWorkspaceMountedEditorResolver';
import {
    articleWorkspaceTabRouter,
    isArticleWorkspaceRoute,
    type ArticleWorkspaceRouteLocation,
    type ArticleWorkspaceTabPresentation,
    type ArticleWorkspaceRouterReceipt
} from '@/services/authoring/articleWorkspaceTabRouter';
import { AuthoringTabGroupRegistry, type AuthoringTabGroupStartupCustody } from '@/services/authoring/authoringTabGroupRegistry';
import { authoringWorkspaceLayoutSourceKey, authoringWorkspacePrimaryMountOnlyKey, type AuthoringWorkspaceLayoutPort } from '@/services/authoring/authoringWorkspaceLayoutContext';
import type { AuthoringWorkspaceLayoutSource } from '@/services/authoring/authoringWorkspaceLayoutController';
import { connectAuthoringWorkspaceSessionSource, type AuthoringWorkspaceSessionSource } from '@/services/authoring/authoringWorkspaceSessionSource';
import { prepareAuthoringWorkspaceSnapshotBootstrap, bindAuthoringWorkspaceSnapshotBootstrapGroups } from '@/services/authoring/authoringWorkspaceSnapshotBootstrap';
import { applyAuthoringWorkspaceSnapshotRestore, type AuthoringWorkspaceSnapshotRestorePlan } from '@/services/authoring/authoringWorkspaceSnapshotRestore';
import type { ArticleWorkspaceMountedEditorResolver } from '@/services/authoring/fsusUiEditorSessionFactory';
import type { OpenArticleDocumentEntry } from '@/services/authoring/openArticleDocumentRegistry';

export type { AdminArticleWorkspaceStartupPorts } from '@/layouts/adminArticleWorkspaceStartup';

// One original router/Registry has one startup installation, independent of route remounts.
let workspaceInstallation: {
    readonly ports: AdminArticleWorkspaceStartupPorts;
    readonly signal: AbortSignal;
    failed: boolean;
    revoking: boolean;
    retirementFailure?: unknown;
    groupRetirementFailure?: unknown;
    layoutInvalidationFailure?: unknown;
    mountedAuthorityRevocationFailure?: unknown;
    snapshotDisposalFailure?: unknown;
    stopObservingCancellation?: () => void;
    /** Retain the exact original owners, their custody handle and the actual in-flight task. */
    readonly resources: {
        groups: AuthoringTabGroupRegistry | null;
        custody: AuthoringTabGroupStartupCustody | null;
        resolver: ArticleWorkspaceMountedEditorResolver | null;
        sessions: AuthoringWorkspaceSessionSource | null;
        readonly revokeMountedAuthority: () => void;
        readonly invalidateLayouts: Set<() => void>;
    };
    readonly task: Promise<{
        readonly plan: AuthoringWorkspaceSnapshotRestorePlan;
        readonly sessions: AuthoringWorkspaceSessionSource;
    }>;
} | undefined;

function requireStartupAdmission(ports: AdminArticleWorkspaceStartupPorts): void
{
    const installation = workspaceInstallation;
    if (installation?.ports !== ports || installation.failed || installation.revoking)
    {
        throw new Error('article-workspace-startup-owner-unavailable');
    }
    installation.signal.throwIfAborted();
}

function checkedStartupRead<Value>(ports: AdminArticleWorkspaceStartupPorts, read: () => Value): Value
{
    requireStartupAdmission(ports);
    const value = read();
    requireStartupAdmission(ports);
    return value;
}

function requireCurrentStartup(ports: AdminArticleWorkspaceStartupPorts, plan: AuthoringWorkspaceSnapshotRestorePlan): void
{
    const checked = <Value>(read: () => Value): Value => checkedStartupRead(ports, read);
    const sync = checked(() => ports.sync);
    const getState = checked(() => sync.getState.bind(sync));
    const state = checked(() => getState());
    const getObservation = checked(() => sync.getServerObservation.bind(sync));
    const observation = checked(() => getObservation());
    const dirty = checked(() => state.dirty);
    const resetting = checked(() => state.resetting);
    if (!observation || dirty || resetting)
    {
        throw new Error('article-workspace-startup-current-source-unavailable');
    }
    const isCurrent = checked(() => ports.isCurrent);
    if (!checked(() => isCurrent.call(ports, {
        scopeDigest: plan.scopeDigest,
        sourceDigest: plan.sourceDigest,
        serverRevision: plan.serverRevision,
        operationEpoch: plan.operationEpoch
    })))
    {
        throw new Error('article-workspace-startup-current-source-unavailable');
    }
    const readCurrentState = checked(() => sync.getState.bind(sync));
    const current = checked(() => readCurrentState());
    const readCurrentObservation = checked(() => sync.getServerObservation.bind(sync));
    const currentObservation = checked(() => readCurrentObservation());
    if (checked(() => ports.sync) !== sync || currentObservation !== observation
        || checked(() => current.dirty) || checked(() => current.resetting))
    {
        throw new Error('article-workspace-startup-current-source-unavailable');
    }
}

async function startArticleWorkspace(
    ports: AdminArticleWorkspaceStartupPorts,
    signal: AbortSignal,
    resources: NonNullable<typeof workspaceInstallation>['resources'])
{
    const checked = <Value>(read: () => Value): Value => checkedStartupRead(ports, read);
    const mountOwner = checked(() => ports.prepareMountedEditor);
    if (typeof mountOwner !== 'function')
    {
        throw new Error('article-workspace-original-retained-mount-owner-required');
    }
    const assertCapability = checked(() => ports.assertRuntimeCapability);
    checked(() => assertCapability.call(ports));
    const getRegistry = checked(() => articleWorkspaceTabRouter.getRegistry.bind(articleWorkspaceTabRouter));
    const registry = checked(() => getRegistry());
    const requireEmptyRegistry = (): void =>
    {
        const readRegistry = checked(() => articleWorkspaceTabRouter.getRegistry.bind(articleWorkspaceTabRouter));
        const currentRegistry = checked(() => readRegistry());
        const readRevision = checked(() => registry.getRevision.bind(registry));
        const revision = checked(() => readRevision());
        const readEntries = checked(() => registry.listEntries.bind(registry));
        const entries = checked(() => readEntries());
        if (currentRegistry !== registry || revision !== 0 || entries.length !== 0)
        {
            throw new Error('article-workspace-startup-requires-empty-registry');
        }
    };
    requireEmptyRegistry();
    const sync = checked(() => ports.sync);
    const getObservation = checked(() => sync.getServerObservation.bind(sync));
    if (!checked(() => getObservation()))
    {
        const start = checked(() => sync.start.bind(sync));
        await start(typeof navigator !== 'undefined' && navigator.onLine);
        requireStartupAdmission(ports);
    }
    const readObservation = checked(() => sync.getServerObservation.bind(sync));
    const observation = checked(() => readObservation());
    const readState = checked(() => sync.getState.bind(sync));
    const state = checked(() => readState());
    if (!observation || checked(() => state.dirty) || checked(() => state.resetting))
    {
        throw new Error('article-workspace-startup-current-source-unavailable');
    }
    requireEmptyRegistry();
    // Only the authentic server layout (or the original missing-server default) supplies group IDs.
    const snapshot = checked(() => observation.snapshot);
    const layout = snapshot ? checked(() => snapshot.layout) : defaultWorkspaceSnapshotLayout();
    const groupOptions = checked(() => ports.groupOptions);
    const ratioScope = checked(() => groupOptions.ratioScope);
    const splitRatioRef = checked(() => groupOptions.splitRatioRef);
    const historyCapacity = checked(() => groupOptions.historyCapacity);
    const initialGroupId = checked(() => layout.activeGroupId);
    const groups = checked(() => layout.groups);
    const initialGroupIds = checked(() => groups.map(group => checked(() => group.groupId)));
    const groupOwner = new AuthoringTabGroupRegistry(registry, {
        ratioScope, splitRatioRef, historyCapacity, initialGroupId, initialGroupIds
    });
    resources.groups = groupOwner;
    const beginCustody = checked(() => groupOwner.beginStartupCustody.bind(groupOwner));
    resources.custody = beginCustody();
    requireStartupAdmission(ports);
    const rereadObservation = checked(() => sync.getServerObservation.bind(sync));
    if (checked(() => ports.sync) !== sync || checked(() => rereadObservation()) !== observation)
    {
        throw new Error('article-workspace-startup-current-source-unavailable');
    }
    // Claim original custody before the first asynchronous restore preparation/mutation.
    const resolutionPort = checked(() => ports.resolutionPort);
    const operationEpoch = checked(() => ports.operationEpoch);
    const plan = await prepareAuthoringWorkspaceSnapshotBootstrap(sync, resolutionPort, operationEpoch, signal);
    requireStartupAdmission(ports);
    const createIdentity = checked(() => ports.createGroupIdentity);
    const groupAdapter = checked(() => bindAuthoringWorkspaceSnapshotBootstrapGroups(plan, articleWorkspaceTabRouter, groupOwner, createIdentity));
    const mountedEditors = checked(() => ports.mountedEditors);
    const resolver = checked(() => createArticleWorkspaceMountedEditorResolver(mountedEditors));
    resources.resolver = resolver;
    const sessions = connectAuthoringWorkspaceSessionSource(groupOwner, resolver, async (entry) =>
    {
        requireStartupAdmission(ports);
        await mountOwner.call(ports, entry, signal);
        requireStartupAdmission(ports);
    });
    resources.sessions = sessions;
    requireStartupAdmission(ports);
    const assertRuntimeCapability = checked(() => ports.assertRuntimeCapability);
    const applyShell = checked(() => ports.applyShell);
    const isCurrent = checked(() => ports.isCurrent);
    await applyAuthoringWorkspaceSnapshotRestore(plan, {
        router: articleWorkspaceTabRouter,
        resolutionPort,
        ...groupAdapter,
        assertRuntimeCapability,
        applyShell,
        isCurrent
    }, signal);
    requireCurrentStartup(ports, plan);
    return { plan, sessions };
}

/** Sole host installer: failed/partial startup cannot be retried against a now-started Registry. */
function installArticleWorkspaceStartup(ports: AdminArticleWorkspaceStartupPorts, signal: AbortSignal,
                                        revokeMountedAuthority: () => void): NonNullable<typeof workspaceInstallation>['task']
{
    const installed = workspaceInstallation;
    if (installed)
    {
        if (installed.ports !== ports || installed.signal !== signal
            || installed.resources.revokeMountedAuthority !== revokeMountedAuthority)
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
        revokeMountedAuthority,
        invalidateLayouts: new Set()
    };
    // Reserve the sole installation before any original capability callback can re-enter it.
    const task = Promise.resolve().then(() => startArticleWorkspace(ports, signal, resources)).catch((error: unknown) =>
    {
        markWorkspaceInstallationFailed(ports);
        throw error;
    });
    workspaceInstallation = { ports, signal, resources, failed: false, revoking: false, task };
    // Observe the original operation lifetime even after its current view unmounts.
    const onCancellation = () => markWorkspaceInstallationFailed(ports);
    signal.addEventListener('abort', onCancellation, { once: true });
    workspaceInstallation.stopObservingCancellation = () => signal.removeEventListener('abort', onCancellation);
    if (signal.aborted)
    {
        markWorkspaceInstallationFailed(ports);
    }
    return task;
}

function revokeStartupMountedAuthority(installation: NonNullable<typeof workspaceInstallation>): void
{
    try
    {
        installation.resources.revokeMountedAuthority();
    }
    catch (error: unknown)
    {
        // A failed original revoker cannot skip the same session source's retirement.
        installation.mountedAuthorityRevocationFailure = error;
    }
}

function createMountedAuthorityRevoker(ports: AdminArticleWorkspaceStartupPorts): () => void
{
    const original = ports.beforeMountedAuthorityChange;
    if (typeof original !== 'function')
    {
        throw new Error('article-workspace-original-mounted-authority-revoker-required');
    }
    const operation = original.bind(ports);
    let revoking = false;
    return () =>
    {
        if (revoking)
        {
            return;
        }
        revoking = true;
        try
        {
            operation();
        }
        finally
        {
            revoking = false;
        }
    };
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
        revokeStartupMountedAuthority(installation);
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
                custody.retire(installation.signal.aborted ? 'restore-cancelled' : 'restore-failed');
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
                revokeStartupMountedAuthority(installation);
                sessions.retire();
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
    /** Actual original caller resources; Root connects them, with no default provider. */
    workspaceSnapshotCaller?: AdminArticleWorkspaceSnapshotCaller;
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
const snapshotCaller = props.workspaceSnapshotCaller;
let viewStartupPorts = props.workspaceStartup;
let viewMountedAuthorityChange = viewStartupPorts ? createMountedAuthorityRevoker(viewStartupPorts) : undefined;
let viewStartupSignal = viewStartupPorts?.signal;
let viewLayoutPorts = viewStartupPorts?.layout;
if (snapshotCaller && viewStartupPorts)
{
    throw new Error('article-workspace-exact-one-startup-source-required');
}
function readCurrentStartupPorts(): AdminArticleWorkspaceStartupPorts | undefined
{
    return snapshotCaller
        ? props.workspaceSnapshotCaller === snapshotCaller && props.workspaceStartup === undefined ? viewStartupPorts : undefined
        : props.workspaceStartup;
}
const workspaceLayoutSource = shallowRef<AuthoringWorkspaceLayoutSource | null>(null);
// Keep original owner objects unproxied while preventing descendants from replacing the ref.
provide(authoringWorkspaceLayoutSourceKey, shallowReadonly(workspaceLayoutSource));
provide(authoringWorkspacePrimaryMountOnlyKey, computed(() => isArticleWorkspaceRouteValue.value && workspaceStartupState.value === 'starting'));
const layoutInvalidationListeners = new Set<() => void>();
const routeOutletInstance = shallowRef<unknown>(null);
let mounted = true;
let snapshotPreparationFailure: unknown;
let layoutRevoking = false;
let layoutRevoked = false;
let layoutEpoch = 0;
function notifyWorkspaceLayoutInvalidation(): void
{
    revokeViewMountedAuthority();
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
            if (installation && installation.ports === viewStartupPorts)
            {
                installation.layoutInvalidationFailure = error;
            }
        }
    }
}
function revokeViewMountedAuthority(): void
{
    try
    {
        viewMountedAuthorityChange?.();
    }
    catch (error: unknown)
    {
        snapshotPreparationFailure = error;
        layoutRevoked = true;
        layoutEpoch++;
        if (viewStartupPorts)
        {
            markWorkspaceInstallationFailed(viewStartupPorts);
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
        revokeViewMountedAuthority();
        if (layoutEpoch === capturedEpoch)
        {
            routeOutletInstance.value = instance;
        }
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

/** Borrow only the actual current routed Writer's public physical preparation operation. */
async function prepareCurrentPrimaryMountedEditor(entry: Readonly<OpenArticleDocumentEntry>, signal: AbortSignal): Promise<void>
{
    const instance = routeOutletInstance.value;
    const epoch = layoutEpoch;
    const verify = (): void =>
    {
        signal.throwIfAborted();
        if (!mounted || layoutRevoking || layoutRevoked || layoutEpoch !== epoch
            || routeOutletInstance.value !== instance || !viewStartupPorts || viewStartupSignal !== signal
            || readCurrentStartupPorts() !== viewStartupPorts)
        {
            throw new Error('article-workspace-primary-mount-view-owner-unavailable');
        }
        requireStartupAdmission(viewStartupPorts);
    };
    verify();
    if (!instance || typeof instance !== 'object')
    {
        throw new Error('article-workspace-primary-writer-not-mounted');
    }
    const hasGetter = 'getArticleWorkspacePrimaryMountPort' in instance;
    verify();
    if (!hasGetter)
    {
        throw new Error('article-workspace-primary-mount-port-unavailable');
    }
    const getter = instance.getArticleWorkspacePrimaryMountPort;
    verify();
    if (typeof getter !== 'function')
    {
        throw new Error('article-workspace-primary-mount-port-unavailable');
    }
    const port: unknown = getter.call(instance);
    verify();
    if (!port || typeof port !== 'object')
    {
        throw new Error('article-workspace-primary-mount-port-unavailable');
    }
    const hasPrepare = 'prepareMountedEditor' in port;
    verify();
    if (!hasPrepare)
    {
        throw new Error('article-workspace-primary-mount-operation-unavailable');
    }
    const prepare = port.prepareMountedEditor;
    verify();
    if (typeof prepare !== 'function')
    {
        throw new Error('article-workspace-primary-mount-operation-unavailable');
    }
    await prepare.call(port, entry, signal);
    verify();
    const current: unknown = getter.call(instance);
    verify();
    if (current !== port)
    {
        throw new Error('article-workspace-primary-mount-port-changed');
    }
}

defineExpose({ prepareMountedEditor: prepareCurrentPrimaryMountedEditor,
               readSnapshotPreparationFailure: () => snapshotPreparationFailure });

function hasPublicWorkspaceLayout(value: unknown, verify: () => void): value is { getAuthoringWorkspaceLayoutPort(): unknown; }
{
    if (!value || typeof value !== 'object')
    {
        return false;
    }
    const present = 'getAuthoringWorkspaceLayoutPort' in value;
    verify();
    if (!present)
    {
        return false;
    }
    const getter = value.getAuthoringWorkspaceLayoutPort;
    verify();
    return typeof getter === 'function';
}
function isPublicWorkspaceLayoutPort(value: unknown, verify: () => void): value is AuthoringWorkspaceLayoutPort
{
    if (!value || typeof value !== 'object')
    {
        return false;
    }
    const hasRefresh = 'refresh' in value;
    verify();
    if (!hasRefresh)
    {
        return false;
    }
    const refresh = value.refresh;
    verify();
    if (typeof refresh !== 'function')
    {
        return false;
    }
    const hasInvalidate = 'invalidate' in value;
    verify();
    if (!hasInvalidate)
    {
        return false;
    }
    const invalidate = value.invalidate;
    verify();
    if (typeof invalidate !== 'function')
    {
        return false;
    }
    const hasFrame = 'readFrameRect' in value;
    verify();
    if (!hasFrame)
    {
        return false;
    }
    const frame = value.readFrameRect;
    verify();
    if (typeof frame !== 'function')
    {
        return false;
    }
    const hasSeparator = 'readSeparatorRect' in value;
    verify();
    if (!hasSeparator)
    {
        return false;
    }
    const separator = value.readSeparatorRect;
    verify();
    return typeof separator === 'function';
}
function readMountedWorkspaceLayout(verify: () => void): AuthoringWorkspaceLayoutPort
{
    verify();
    const outlet = routeOutletInstance.value;
    if (!hasPublicWorkspaceLayout(outlet, verify))
    {
        throw new Error('article-workspace-layout-public-mount-unavailable');
    }
    const getPort = outlet.getAuthoringWorkspaceLayoutPort.bind(outlet);
    verify();
    const port = getPort();
    verify();
    if (routeOutletInstance.value !== outlet || !isPublicWorkspaceLayoutPort(port, verify))
    {
        throw new Error('article-workspace-layout-public-mount-unavailable');
    }
    return port;
}

function createWorkspaceLayoutSource(sessions: AuthoringWorkspaceSessionSource, verifyStartup: () => void): AuthoringWorkspaceLayoutSource | null
{
    if (!viewStartupPorts || !viewLayoutPorts)
    {
        return null;
    }
    const ports = viewStartupPorts;
    const layout = viewLayoutPorts;
    const requireOwner = (expectedEpoch: number): void =>
    {
        const requireLocal = (): void =>
        {
            if (!mounted || layoutRevoking || layoutRevoked || layoutEpoch !== expectedEpoch
                || readCurrentStartupPorts() !== ports || workspaceInstallation?.ports !== ports
                || workspaceInstallation.failed || workspaceInstallation.resources.sessions !== sessions)
            {
                throw new Error('article-workspace-layout-original-source-unavailable');
            }
        };
        requireLocal();
        const signal = ports.signal;
        requireLocal();
        if (signal !== viewStartupSignal)
        {
            throw new Error('article-workspace-layout-original-signal-changed');
        }
        signal.throwIfAborted();
        requireLocal();
        const currentLayout = ports.layout;
        requireLocal();
        if (currentLayout !== layout)
        {
            throw new Error('article-workspace-layout-original-source-unavailable');
        }
    };
    const checkedRead = <Value>(expectedEpoch: number, read: () => Value): Value =>
    {
        requireOwner(expectedEpoch);
        const value = read();
        requireOwner(expectedEpoch);
        return value;
    };
    verifyStartup();
    const groups = sessions.groups;
    verifyStartup();
    const mountedEditors = ports.mountedEditors;
    verifyStartup();
    return Object.freeze<AuthoringWorkspaceLayoutSource>({
        groups,
        sessions,
        mountedEditors,
        reserveOperationIdentity: (projection) =>
        {
            const expectedEpoch = layoutEpoch;
            requireOwner(expectedEpoch);
            const reserve = checkedRead(expectedEpoch, () => layout.reserveOperationIdentity.bind(layout));
            return checkedRead(expectedEpoch, () => reserve(projection));
        },
        measure: (projection) =>
        {
            const expectedEpoch = layoutEpoch;
            const checked = <Value>(read: () => Value): Value => checkedRead(expectedEpoch, read);
            const verify = (): void => requireOwner(expectedEpoch);
            const port = checked(() => readMountedWorkspaceLayout(verify));
            const readFrame = checked(() => port.readFrameRect.bind(port));
            const frame = checked(() => readFrame());
            const readSeparator = checked(() => port.readSeparatorRect.bind(port));
            const separator = checked(() => readSeparator());
            const measure = checked(() => layout.measure.bind(layout));
            const measured = checked(() => measure(projection, port));
            const readCurrentFrame = checked(() => port.readFrameRect.bind(port));
            const currentFrame = checked(() => readCurrentFrame());
            const readCurrentSeparator = checked(() => port.readSeparatorRect.bind(port));
            const currentSeparator = checked(() => readCurrentSeparator());
            if (checked(() => readMountedWorkspaceLayout(verify)) !== port
                || !frame || !separator || !currentFrame || !currentSeparator)
            {
                throw new Error('article-workspace-layout-current-measurement-unavailable');
            }
            const measuredFrame = checked(() => measured.frame);
            if (checked(() => frame.left) !== checked(() => currentFrame.left)
                || checked(() => frame.top) !== checked(() => currentFrame.top)
                || checked(() => frame.width) !== checked(() => currentFrame.width)
                || checked(() => frame.height) !== checked(() => currentFrame.height)
                || checked(() => separator.left) !== checked(() => currentSeparator.left)
                || checked(() => separator.top) !== checked(() => currentSeparator.top)
                || checked(() => separator.width) !== checked(() => currentSeparator.width)
                || checked(() => separator.height) !== checked(() => currentSeparator.height)
                || checked(() => measuredFrame.left) !== checked(() => frame.left)
                || checked(() => measuredFrame.top) !== checked(() => frame.top)
                || checked(() => measuredFrame.width) !== checked(() => frame.width)
                || checked(() => measuredFrame.height) !== checked(() => frame.height)
                || checked(() => measured.splitterFootprintCssPx) !== checked(() => separator.width))
            {
                throw new Error('article-workspace-layout-current-measurement-unavailable');
            }
            verify();
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
                const subscribe = checkedRead(expectedEpoch, () => layout.subscribeInvalidation.bind(layout));
                // Record the actual release even when the call revokes, so real cleanup remains possible.
                release = subscribe(listener);
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
    if (viewStartupPorts)
    {
        markWorkspaceInstallationFailed(viewStartupPorts);
    }
    invalidateWorkspaceLayout();
    workspaceStartupState.value = 'unavailable';
}
function startWorkspaceFromPorts(selectedPorts: AdminArticleWorkspaceStartupPorts): void
{
    const mountedRevoker = selectedPorts === viewStartupPorts && viewMountedAuthorityChange
        ? viewMountedAuthorityChange : createMountedAuthorityRevoker(selectedPorts);
    revokeViewMountedAuthority();
    if (!mounted || layoutRevoked)
    {
        throw new Error('article-workspace-mounted-authority-source-revoked');
    }
    viewStartupPorts = selectedPorts;
    viewMountedAuthorityChange = mountedRevoker;
    viewStartupSignal = selectedPorts.signal;
    viewLayoutPorts = selectedPorts.layout;
    const startupPorts = selectedPorts;
    const startupSignal = selectedPorts.signal;
    workspaceStartupState.value = 'starting';
    startupSignal.addEventListener('abort', markWorkspaceStartupUnavailable);
    void Promise.resolve().then(() => installArticleWorkspaceStartup(startupPorts, startupSignal, mountedRevoker)).then(({ plan, sessions }) =>
    {
        if (!mounted)
        {
            return;
        }
        if (readCurrentStartupPorts() !== startupPorts || workspaceInstallation?.ports !== startupPorts
            || workspaceInstallation.failed)
        {
            throw new Error('article-workspace-startup-owner-changed');
        }
        const publicationEpoch = layoutEpoch;
        const requireViewOwner = (): void =>
        {
            requireStartupAdmission(startupPorts);
            if (!mounted || layoutRevoking || layoutRevoked || layoutEpoch !== publicationEpoch
                || readCurrentStartupPorts() !== startupPorts)
            {
                throw new Error('article-workspace-startup-publication-revoked');
            }
        };
        const checkedViewRead = <Value>(read: () => Value): Value =>
        {
            requireViewOwner();
            const value = read();
            requireViewOwner();
            return value;
        };
        const layoutSource = createWorkspaceLayoutSource(sessions, requireViewOwner);
        checkedViewRead(() => requireCurrentStartup(startupPorts, plan));
        const assertCapability = checkedViewRead(() => startupPorts.assertRuntimeCapability);
        checkedViewRead(() => assertCapability.call(startupPorts));
        const resources = workspaceInstallation.resources;
        if (!resources.custody || !resources.groups || !resources.resolver || resources.sessions !== sessions
            || checkedViewRead(() => sessions.groups) !== resources.groups)
        {
            throw new Error('article-workspace-startup-original-session-owner-unavailable');
        }
        const groupOwner = resources.groups;
        const verifyBinding = checkedViewRead(() => groupOwner.verifyBinding.bind(groupOwner));
        const getRegistry = checkedViewRead(() => articleWorkspaceTabRouter.getRegistry.bind(articleWorkspaceTabRouter));
        const registry = checkedViewRead(() => getRegistry());
        if (!checkedViewRead(() => verifyBinding(registry)))
        {
            throw new Error('article-workspace-startup-original-session-owner-unavailable');
        }
        const host = checkedViewRead(() => sessions.host);
        const resolver = resources.resolver;
        if (checkedViewRead(() => installArticleWorkspaceEditorSessions(resolver)) !== host)
        {
            throw new Error('article-workspace-startup-original-session-owner-unavailable');
        }
        checkedViewRead(() => requireCurrentStartup(startupPorts, plan));
        const custody = resources.custody;
        const seal = checkedViewRead(() => custody.sealHandoff.bind(custody));
        checkedViewRead(() => seal());
        workspaceInstallation.stopObservingCancellation?.();
        workspaceLayoutSource.value = layoutSource;
        const requirePublishedSource = (): void =>
        {
            const requireLocalPublication = (): void =>
            {
                if (!mounted || layoutRevoking || layoutRevoked || layoutEpoch !== publicationEpoch
                    || startupSignal.aborted || readCurrentStartupPorts() !== startupPorts
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
watch([() => props.workspaceStartup, () => props.workspaceSnapshotCaller], () =>
{
    if (readCurrentStartupPorts() !== viewStartupPorts || props.workspaceSnapshotCaller !== snapshotCaller)
    {
        markWorkspaceStartupUnavailable();
        if (snapshotCaller)
        {
            void cancelAdminArticleWorkspaceSnapshotStartup(snapshotCaller)?.catch((error: unknown) =>
            {
                snapshotPreparationFailure = error;
            });
        }
    }
}, { flush: 'sync' });
onBeforeUnmount(() =>
{
    mounted = false;
    revokeViewMountedAuthority();
    invalidateWorkspaceLayout();
    if (snapshotCaller)
    {
        void cancelAdminArticleWorkspaceSnapshotStartup(snapshotCaller)?.catch((error: unknown) =>
        {
            snapshotPreparationFailure = error;
        });
    }
    workspaceInstallation?.resources.invalidateLayouts.delete(invalidateWorkspaceLayout);
    viewStartupSignal?.removeEventListener('abort', markWorkspaceStartupUnavailable);
    if (viewStartupPorts)
    {
        void disposeAdminArticleWorkspaceSnapshotStartup(viewStartupPorts)?.catch((error: unknown) =>
        {
            const current = workspaceInstallation;
            if (current && current.ports === viewStartupPorts)
            {
                current.snapshotDisposalFailure = error;
            }
        });
    }
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
if (viewStartupPorts && viewStartupSignal)
{
    startWorkspaceFromPorts(viewStartupPorts);
}
else if (snapshotCaller && isArticleWorkspaceRouteValue.value)
{
    workspaceStartupState.value = 'starting';
    void connectAdminArticleWorkspaceSnapshotStartup(snapshotCaller).then((ports) =>
    {
        if (!mounted || props.workspaceSnapshotCaller !== snapshotCaller || props.workspaceStartup !== undefined
            || layoutRevoked || workspaceStartupState.value !== 'starting')
        {
            return disposeAdminArticleWorkspaceSnapshotStartup(ports);
        }
        startWorkspaceFromPorts(ports);
    }).catch((error: unknown) =>
    {
        snapshotPreparationFailure = error;
        if (mounted)
        {
            markWorkspaceStartupUnavailable();
        }
    });
}
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
