import { AuthoringWorkspaceSnapshotError, defaultWorkspaceSnapshotLayout, freezeWorkspaceSnapshot, requireWorkspaceServerObservation, validateWorkspaceSnapshotLayout, workspaceSnapshotBytes, workspaceSnapshotDigest, workspaceSnapshotExact, workspaceSnapshotId, workspaceSnapshotInteger, type AuthoringWorkspaceServerObservation, type AuthoringWorkspaceSnapshotGroup, type AuthoringWorkspaceSnapshotLayout, type AuthoringWorkspaceSnapshotScope, type AuthoringWorkspaceSnapshotTab } from '@/api/authoringWorkspaceSnapshot';

import { type ArticleWorkspaceTabRouter, verifyArticleWorkspaceRouterReceipt } from './articleWorkspaceTabRouter';

import type { ArticleDocumentContextRef, ArticleDocumentIdentity } from './openArticleDocumentRegistry';
export const workspaceSnapshotRestorePolicy = Object.freeze({
    schema: 'fsusblog.authoring-workspace-restore-plan.v1',
    resolutionSchema: 'fsusblog.authoring-workspace-resolution.v1',
    maxResolutionBytes: 131072,
    batchLimit: 100,
    reasons: ['missing', 'deleted', 'archived', 'denied', 'draft-replaced']
} as const);
type ResolutionState = 'allowed' | 'read-only' | typeof workspaceSnapshotRestorePolicy.reasons[number];
export interface AuthoringWorkspaceSnapshotResolutionFact {
    tabId: string;
    state: ResolutionState;
    currentIdentity: ArticleDocumentIdentity | null;
    documentContext: ArticleDocumentContextRef | null;
    permissionRef: string | null;
}
export interface AuthoringWorkspaceSnapshotResolution {
    schema: typeof workspaceSnapshotRestorePolicy.resolutionSchema;
    scopeDigest: string;
    sourceDigest: string;
    snapshotRevision: number;
    snapshotDigest: string;
    facts: AuthoringWorkspaceSnapshotResolutionFact[];
    contentDigest: string;
}
export interface AuthoringWorkspaceSnapshotResolutionPort {
    // The integration owner binds this to one current permission/lifecycle/draft batch query, never snapshot facts.
    resolveBatch(request: {
        scope: AuthoringWorkspaceSnapshotScope;
        sourceDigest: string;
        snapshotRevision: number;
        snapshotDigest: string;
        tabs: AuthoringWorkspaceSnapshotTab[];
    }, signal: AbortSignal): Promise<unknown>;
}
export interface AuthoringWorkspaceSnapshotRestoreTarget {
    savedTabId: string;
    identity: ArticleDocumentIdentity;
    documentContext: ArticleDocumentContextRef;
    permission: 'allowed' | 'read-only';
    permissionRef: string;
    groupId: string;
    isPinned: boolean;
}
export interface AuthoringWorkspaceSnapshotRestorePlan {
    schema: typeof workspaceSnapshotRestorePolicy.schema;
    scopeDigest: string;
    sourceDigest: string;
    serverRevision: number;
    snapshotDigest: string | null;
    resolutionDigest: string | null;
    operationEpoch: number;
    targets: AuthoringWorkspaceSnapshotRestoreTarget[];
    layout: AuthoringWorkspaceSnapshotLayout;
    summary: {
        restored: number;
        skipped: number;
        blocked: number;
        reasons: Partial<Record<typeof workspaceSnapshotRestorePolicy.reasons[number], number>>;
    };
    contentDigest: string;
}
export interface AuthoringWorkspaceSnapshotRestoreGuard {
    scopeDigest: string;
    sourceDigest: string;
    serverRevision: number;
    operationEpoch: number;
}
const preparedPlans = new WeakSet<object>();
const planObservations = new WeakMap<object, AuthoringWorkspaceServerObservation>();
export function requirePreparedWorkspaceSnapshotRestorePlan(plan: AuthoringWorkspaceSnapshotRestorePlan): void
{
    if (!preparedPlans.has(plan))
    {
        throw new AuthoringWorkspaceSnapshotError('prepared_server_plan_required');
    }
    requireWorkspaceServerObservation(planObservations.get(plan)!);
}
export async function prepareAuthoringWorkspaceSnapshotRestore(observation: AuthoringWorkspaceServerObservation, port: AuthoringWorkspaceSnapshotResolutionPort, operationEpoch: number, signal: AbortSignal): Promise<AuthoringWorkspaceSnapshotRestorePlan>
{
    requireWorkspaceServerObservation(observation);
    if (observation.status !== 'current' && observation.status !== 'missing')
    {
        throw new AuthoringWorkspaceSnapshotError('current_server_read_required');
    }
    if (observation.receipt.action !== 'read' || !workspaceSnapshotInteger(operationEpoch))
    {
        throw new AuthoringWorkspaceSnapshotError('current_server_read_required');
    }
    signal.throwIfAborted();
    const snapshot = observation.snapshot;
    const scopeDigest = workspaceSnapshotDigest(observation.receipt.scope);
    let resolution: AuthoringWorkspaceSnapshotResolution | null = null;
    if (snapshot && snapshot.layout.tabs.length > 0)
    {
        const request = freezeWorkspaceSnapshot(structuredClone({ scope: snapshot.scope,
            sourceDigest: snapshot.sourceDigest, snapshotRevision: snapshot.revision,
            snapshotDigest: snapshot.contentDigest, tabs: snapshot.layout.tabs }));
        const raw = await port.resolveBatch(request, signal);
        signal.throwIfAborted();
        resolution = validateResolution(raw, snapshot.layout.tabs, scopeDigest, snapshot.sourceDigest, snapshot.revision, snapshot.contentDigest);
    }
    requireWorkspaceServerObservation(observation);
    const plan = buildPlan(observation, resolution, operationEpoch);
    preparedPlans.add(plan);
    planObservations.set(plan, observation);
    return plan;
}
function validateResolution(value: unknown, tabs: AuthoringWorkspaceSnapshotTab[], scopeDigest: string, sourceDigest: string, revision: number, snapshotDigest: string): AuthoringWorkspaceSnapshotResolution
{
    workspaceSnapshotExact(value, ['schema', 'scopeDigest', 'sourceDigest', 'snapshotRevision', 'snapshotDigest', 'facts', 'contentDigest']);
    if (value.schema !== workspaceSnapshotRestorePolicy.resolutionSchema || value.scopeDigest !== scopeDigest
        || value.sourceDigest !== sourceDigest || value.snapshotRevision !== revision || value.snapshotDigest !== snapshotDigest
        || !Array.isArray(value.facts) || value.facts.length !== tabs.length || value.facts.length > workspaceSnapshotRestorePolicy.batchLimit
        || workspaceSnapshotBytes(value) > workspaceSnapshotRestorePolicy.maxResolutionBytes)
    {
        throw new AuthoringWorkspaceSnapshotError('resolution_binding_invalid');
    }
    const { contentDigest, ...unsigned } = value;
    if (workspaceSnapshotDigest(unsigned) !== contentDigest)
    {
        throw new AuthoringWorkspaceSnapshotError('resolution_digest_invalid');
    }
    const seen = new Set<string>();
    for (const fact of value.facts)
    {
        workspaceSnapshotExact(fact, ['tabId', 'state', 'currentIdentity', 'documentContext', 'permissionRef']);
        const requested = tabs.find(tab => tab.tabId === fact.tabId);
        if (!requested || seen.has(fact.tabId as string) || !['allowed', 'read-only', ...workspaceSnapshotRestorePolicy.reasons].includes(fact.state as ResolutionState))
        {
            throw new AuthoringWorkspaceSnapshotError('resolution_fact_invalid');
        }
        seen.add(fact.tabId as string);
        if (fact.state === 'allowed' || fact.state === 'read-only')
        {
            workspaceSnapshotExact(fact.currentIdentity, ['articleId', 'draftId', 'documentId']);
            workspaceSnapshotExact(fact.documentContext, ['documentEpoch', 'sourceRevision', 'draftRevision']);
            if (workspaceSnapshotDigest(fact.currentIdentity) !== workspaceSnapshotDigest(requested.identity)
                || !workspaceSnapshotInteger(fact.documentContext.documentEpoch, 1)
                || ![fact.documentContext.sourceRevision, fact.documentContext.draftRevision]
                    .every(revisionRef => revisionRef === null || workspaceSnapshotId(revisionRef))
                || !workspaceSnapshotId(fact.permissionRef))
            {
                throw new AuthoringWorkspaceSnapshotError('resolution_identity_or_permission_invalid');
            }
        }
        else if (fact.currentIdentity !== null || fact.documentContext !== null || fact.permissionRef !== null)
        {
            // A revoked/missing/draft-replaced reference carries a closed reason only, no freshly disclosed identities/metadata.
            throw new AuthoringWorkspaceSnapshotError('resolution_private_metadata');
        }
    }
    return freezeWorkspaceSnapshot(structuredClone(value as unknown as AuthoringWorkspaceSnapshotResolution));
}
function buildPlan(observation: AuthoringWorkspaceServerObservation, resolution: AuthoringWorkspaceSnapshotResolution | null, operationEpoch: number): AuthoringWorkspaceSnapshotRestorePlan
{
    const original = observation.snapshot?.layout ?? defaultWorkspaceSnapshotLayout();
    const layout = structuredClone(original);
    const targets: AuthoringWorkspaceSnapshotRestoreTarget[] = [];
    const summary: AuthoringWorkspaceSnapshotRestorePlan['summary'] = { restored: 0, skipped: 0, blocked: 0, reasons: {} };
    for (const group of original.groups)
    {
        for (const tabId of group.tabIds)
        {
            const tab = original.tabs.find(entry => entry.tabId === tabId)!;
            const fact = resolution!.facts.find(entry => entry.tabId === tabId)!;
            if (fact.state === 'allowed' || fact.state === 'read-only')
            {
                targets.push({ savedTabId: tab.tabId, identity: fact.currentIdentity!, documentContext: fact.documentContext!,
                    permission: fact.state, permissionRef: fact.permissionRef!, groupId: group.groupId, isPinned: tab.isPinned });
                summary.restored++;
            }
            else
            {
                if (fact.state === 'denied' || fact.state === 'draft-replaced')
                {
                    summary.blocked++;
                }
                else
                {
                    summary.skipped++;
                }
                summary.reasons[fact.state] = (summary.reasons[fact.state] ?? 0) + 1;
            }
        }
    }
    const valid = new Set(targets.map(target => target.savedTabId));
    layout.tabs = layout.tabs.filter(tab => valid.has(tab.tabId));
    for (const group of layout.groups)
    {
        group.tabIds = group.tabIds.filter(tabId => valid.has(tabId));
        if (!group.activeTabId || !valid.has(group.activeTabId))
        {
            group.activeTabId = group.tabIds[0] ?? null;
        }
    }
    const active = layout.groups.find(group => group.groupId === layout.activeGroupId)!;
    if (active.tabIds.length === 0)
    {
        layout.activeGroupId = layout.groups.find(group => group.tabIds.length > 0)?.groupId ?? layout.groups[0].groupId;
    }
    validateWorkspaceSnapshotLayout(layout);
    const unsigned: Omit<AuthoringWorkspaceSnapshotRestorePlan, 'contentDigest'> = {
        schema: workspaceSnapshotRestorePolicy.schema, scopeDigest: workspaceSnapshotDigest(observation.receipt.scope),
        sourceDigest: observation.receipt.sourceDigest, serverRevision: observation.revision,
        snapshotDigest: observation.snapshot?.contentDigest ?? null, resolutionDigest: resolution?.contentDigest ?? null,
        operationEpoch, targets, layout, summary
    };
    return freezeWorkspaceSnapshot({ ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) });
}
export function verifyAuthoringWorkspaceSnapshotRestorePlan(plan: AuthoringWorkspaceSnapshotRestorePlan, observation: AuthoringWorkspaceServerObservation, resolution: unknown): boolean
{
    try
    {
        requireWorkspaceServerObservation(observation);
        if (observation.status !== 'current' && observation.status !== 'missing')
        {
            return false;
        }
        workspaceSnapshotExact(plan, ['schema', 'scopeDigest', 'sourceDigest', 'serverRevision', 'snapshotDigest', 'resolutionDigest', 'operationEpoch', 'targets', 'layout', 'summary', 'contentDigest']);
        const tabs = observation.snapshot?.layout.tabs ?? [];
        const facts = tabs.length > 0 ? validateResolution(resolution, tabs, workspaceSnapshotDigest(observation.receipt.scope), observation.receipt.sourceDigest, observation.revision, observation.snapshot!.contentDigest) : null;
        return workspaceSnapshotDigest(buildPlan(observation, facts, plan.operationEpoch)) === workspaceSnapshotDigest(plan);
    }
    catch
    {
        return false;
    }
}
export interface AuthoringWorkspaceSnapshotRestoreCommands {
    router: Pick<ArticleWorkspaceTabRouter, 'getRevision' | 'openOrActivate' | 'activateTab' | 'getRegistry'>;
    resolutionPort: AuthoringWorkspaceSnapshotResolutionPort;
    // The original session/factory owner must throw until its real public FsusUI runtime is qualified.
    assertRuntimeCapability(): void;
    // These adapters must invoke #2298/#2299 official ownership commands and shell commands.
    // No default adapters are supplied while the two-group source capability is missing.
    applyGroups(groups: AuthoringWorkspaceSnapshotGroup[], activeGroupId: string, splitRatioPermille: number, signal: AbortSignal): Promise<string>;
    applyShell(shell: AuthoringWorkspaceSnapshotLayout['shell'], signal: AbortSignal): Promise<string>;
    isCurrent(guard: AuthoringWorkspaceSnapshotRestoreGuard): boolean;
}
export async function applyAuthoringWorkspaceSnapshotRestore(plan: AuthoringWorkspaceSnapshotRestorePlan, commands: AuthoringWorkspaceSnapshotRestoreCommands, signal: AbortSignal): Promise<{
    status: 'restored';
    planDigest: string;
    registryDigest: string;
    groupReceiptDigest: string;
    shellReceiptDigest: string;
    contentDigest: string;
}>
{
    requirePreparedWorkspaceSnapshotRestorePlan(plan);
    if (typeof commands.assertRuntimeCapability !== 'function' || typeof commands.applyGroups !== 'function'
        || typeof commands.applyShell !== 'function' || typeof commands.resolutionPort?.resolveBatch !== 'function')
    {
        throw new AuthoringWorkspaceSnapshotError('restore_runtime_capability_required');
    }
    commands.assertRuntimeCapability();
    const guard: AuthoringWorkspaceSnapshotRestoreGuard = { scopeDigest: plan.scopeDigest, sourceDigest: plan.sourceDigest,
        serverRevision: plan.serverRevision, operationEpoch: plan.operationEpoch };
    let registryRevision = commands.router.getRevision();
    const current = (): void =>
    {
        requireWorkspaceServerObservation(planObservations.get(plan)!);
        signal.throwIfAborted();
        if (!commands.isCurrent(guard) || commands.router.getRevision() !== registryRevision)
        {
            throw new AuthoringWorkspaceSnapshotError('restore_superseded');
        }
    };
    current();
    // A startup restore cannot replace sessions that a user already opened, including unsynced/risky sessions.
    if (commands.router.getRegistry().listEntries().length > 0)
    {
        throw new AuthoringWorkspaceSnapshotError('restore_requires_unstarted_workspace');
    }
    const refreshed = await prepareAuthoringWorkspaceSnapshotRestore(planObservations.get(plan)!, commands.resolutionPort, plan.operationEpoch, signal);
    current();
    if (refreshed.contentDigest !== plan.contentDigest)
    {
        throw new AuthoringWorkspaceSnapshotError('restore_resolution_changed');
    }
    const runtimeTabIds = new Map<string, string>();
    // Reuse the official router/session commands; saved tab IDs are translated to their current runtime refs.
    for (const target of plan.targets)
    {
        current();
        const expectedRegistryRevision = registryRevision + 1;
        const receipt = await commands.router.openOrActivate({ identity: target.identity, documentContext: target.documentContext,
            title: '', targetGroupId: target.groupId, tabKind: target.isPinned ? 'pinned' : 'preview', entrypoint: 'recent-restore',
            status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
                permission: target.permission, lifecycle: 'current', statusRef: target.permissionRef } });
        registryRevision = expectedRegistryRevision;
        current();
        if (!verifyArticleWorkspaceRouterReceipt(receipt) || receipt.sessionState !== 'ready' || receipt.resultStatus !== 'applied'
            || !receipt.tabId || !receipt.editorSessionRef)
        {
            throw new AuthoringWorkspaceSnapshotError('session_restore_blocked');
        }
        const entry = commands.router.getRegistry().getEntry(receipt.tabId);
        if (entry?.status.permission !== target.permission || entry.status.lifecycle !== 'current'
            || entry.status.dirty || entry.status.saving || entry.status.conflict || entry.status.recovery || entry.status.pendingAttachments
            || workspaceSnapshotDigest(entry.identity) !== workspaceSnapshotDigest(target.identity)
            || workspaceSnapshotDigest(entry.documentContext) !== workspaceSnapshotDigest(target.documentContext)
            || entry.owningGroupId !== target.groupId)
        {
            throw new AuthoringWorkspaceSnapshotError('session_binding_changed');
        }
        runtimeTabIds.set(target.savedTabId, receipt.tabId);
    }
    const groups = plan.layout.groups.map(group => ({ groupId: group.groupId,
        tabIds: group.tabIds.map(tabId => runtimeTabIds.get(tabId)!), activeTabId: group.activeTabId ? runtimeTabIds.get(group.activeTabId)! : null }));
    current();
    const groupReceiptDigest = await commands.applyGroups(groups, plan.layout.activeGroupId, plan.layout.splitRatioPermille, signal);
    current();
    const active = groups.find(group => group.groupId === plan.layout.activeGroupId)!.activeTabId;
    if (active)
    {
        const entry = commands.router.getRegistry().getEntry(active);
        if (!entry || !['allowed', 'read-only'].includes(entry.status.permission) || entry.status.lifecycle !== 'current')
        {
            throw new AuthoringWorkspaceSnapshotError('active_permission_or_lifecycle_changed');
        }
        const expectedRegistryRevision = registryRevision + 1;
        const receipt = await commands.router.activateTab(active);
        registryRevision = expectedRegistryRevision;
        current();
        if (!verifyArticleWorkspaceRouterReceipt(receipt) || receipt.sessionState !== 'ready')
        {
            throw new AuthoringWorkspaceSnapshotError('active_restore_blocked');
        }
    }
    const shellReceiptDigest = await commands.applyShell(plan.layout.shell, signal);
    current();
    if (!/^[a-f0-9]{64}$/u.test(groupReceiptDigest) || !/^[a-f0-9]{64}$/u.test(shellReceiptDigest))
    {
        throw new AuthoringWorkspaceSnapshotError('restore_owner_receipt_required');
    }
    const unsigned = { status: 'restored' as const, planDigest: plan.contentDigest,
        registryDigest: commands.router.getRegistry().exportState().contentDigest, groupReceiptDigest, shellReceiptDigest };
    return freezeWorkspaceSnapshot({ ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) });
}
