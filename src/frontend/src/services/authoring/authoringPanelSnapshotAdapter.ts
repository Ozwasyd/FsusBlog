import { freezeWorkspaceSnapshot, requireWorkspaceServerObservation, workspaceSnapshotDigest, workspaceSnapshotExact, workspaceSnapshotHash, workspaceSnapshotId, workspaceSnapshotInteger, type AuthoringWorkspaceServerObservation, type AuthoringWorkspaceSnapshotScope } from '@/api/authoringWorkspaceSnapshot';

import type { ArticleWorkspaceTabRouter } from './articleWorkspaceTabRouter';
import type { AuthoringWorkspaceSnapshotSync } from './authoringWorkspaceSnapshotSync';
import type { ArticleDocumentContextRef, ArticleDocumentIdentity } from './openArticleDocumentRegistry';

export const authoringPanelSnapshotBindingSchema = 'fsusblog.authoring-panel-snapshot-binding.v1' as const;

/** Content-free request; panel slot/layout admission and model rendering remain separate host gates. */
export interface AuthoringPanelSnapshotBinding {
    schema: typeof authoringPanelSnapshotBindingSchema;
    panelId: string;
    extensionId: string;
    extensionVersion: string;
    packageSha256: string;
    scope: AuthoringWorkspaceSnapshotScope;
    sourceDigest: string;
    snapshotRevision: number;
    snapshotDigest: string;
    groupId: string;
    tabId: string;
    documentIdentity: ArticleDocumentIdentity;
    documentContext: ArticleDocumentContextRef;
    requestId: string;
    grantReference: string;
    deadline: number;
}

/** The integration owner must supply real current package/read grants; server provenance is not that grant. */
export interface AuthoringPanelReadAdmission {
    isCurrent(binding: Readonly<AuthoringPanelSnapshotBinding>): boolean;
}

export interface AuthoringPanelSnapshotSession {
    readonly binding: Readonly<AuthoringPanelSnapshotBinding>;
    readonly signal: AbortSignal;
}

interface HeldSession {
    readonly session: AuthoringPanelSnapshotSession;
    readonly observation: AuthoringWorkspaceServerObservation;
    readonly abort: AbortController;
    readonly timer: ReturnType<typeof setTimeout>;
}

const fields = ['schema', 'panelId', 'extensionId', 'extensionVersion', 'packageSha256', 'scope', 'sourceDigest', 'snapshotRevision', 'snapshotDigest', 'groupId', 'tabId', 'documentIdentity', 'documentContext', 'requestId', 'grantReference', 'deadline'] as const;

function exactData(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown>
{
    workspaceSnapshotExact(value, keys);
    if (Reflect.ownKeys(value).length !== keys.length || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !descriptor.enumerable || !('value' in descriptor)))
    {
        throw new Error('authoring_panel_binding_plain_data_required');
    }
}

function capture(value: unknown, now: number): Readonly<AuthoringPanelSnapshotBinding>
{
    exactData(value, fields);
    exactData(value.scope, ['userId', 'siteId']);
    exactData(value.documentIdentity, ['articleId', 'draftId', 'documentId']);
    exactData(value.documentContext, ['documentEpoch', 'sourceRevision', 'draftRevision']);
    if (value.schema !== authoringPanelSnapshotBindingSchema
        || ![value.panelId, value.extensionId, value.groupId, value.tabId, value.requestId, value.grantReference].every(workspaceSnapshotId)
        || typeof value.extensionVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.extensionVersion) || value.extensionVersion.length > 64
        || !workspaceSnapshotHash(value.packageSha256) || !workspaceSnapshotHash(value.sourceDigest) || !workspaceSnapshotHash(value.snapshotDigest)
        || !workspaceSnapshotInteger(value.scope.userId, 1) || !workspaceSnapshotId(value.scope.siteId)
        || !workspaceSnapshotInteger(value.snapshotRevision, 1) || !workspaceSnapshotInteger(value.deadline, 1)
        || value.deadline <= now || value.deadline - now > 60_000
        || !workspaceSnapshotInteger(value.documentContext.documentEpoch)
        || ![value.documentContext.sourceRevision, value.documentContext.draftRevision].every(item => item === null || workspaceSnapshotId(item))
        || (value.documentIdentity.articleId !== null && (!workspaceSnapshotInteger(value.documentIdentity.articleId, 1) || value.documentIdentity.articleId > 2147483647))
        || !workspaceSnapshotId(value.documentIdentity.draftId) || !workspaceSnapshotId(value.documentIdentity.documentId))
    {
        throw new Error('authoring_panel_binding_invalid');
    }
    return freezeWorkspaceSnapshot(structuredClone(value)) as unknown as Readonly<AuthoringPanelSnapshotBinding>;
}

/**
 * Fences one pending read against the actual snapshot and open-document owners.
 * This adapter cannot register a slot, write a snapshot, create a group, persist a model or issue a receipt.
 */
export class AuthoringPanelSnapshotBindingAdapter
{
    private held: HeldSession | null = null;
    private generation = 0;
    private visible = true;
    private disposed = false;
    private readonly unsubscribe: readonly (() => void)[];

    public constructor(private readonly snapshots: Pick<AuthoringWorkspaceSnapshotSync, 'getServerObservation' | 'subscribe'>,
        private readonly tabs: Pick<ArticleWorkspaceTabRouter, 'getRegistry' | 'getActiveTab' | 'subscribe'>,
        private readonly admission: AuthoringPanelReadAdmission, private readonly now: () => number = Date.now)
    {
        if (!admission || typeof admission.isCurrent !== 'function')
        {
            throw new Error('authoring_panel_read_admission_required');
        }
        const snapshotSubscription = snapshots.subscribe(() => this.reconcile());
        try
        {
            this.unsubscribe = [snapshotSubscription, tabs.subscribe(() => this.reconcile())];
        }
        catch (error)
        {
            snapshotSubscription();
            throw error;
        }
    }

    public begin(value: unknown): AuthoringPanelSnapshotSession
    {
        const generation = ++this.generation;
        this.clear();
        const binding = capture(value, this.now());
        const observation = this.snapshots.getServerObservation();
        if (!observation || !this.matches(binding, observation) || generation !== this.generation)
        {
            throw new Error('authoring_panel_snapshot_not_current');
        }
        const abort = new AbortController();
        const session = Object.freeze({ binding, signal: abort.signal });
        const held: HeldSession = { session, observation, abort, timer: setTimeout(() =>
        {
            if (this.held === held)
            {
                this.cancel();
            }
        }, binding.deadline - this.now()) };
        this.held = held;
        return session;
    }

    public get current(): AuthoringPanelSnapshotSession | null
    {
        this.reconcile();
        return this.held?.session ?? null;
    }

    public isCurrent(session: AuthoringPanelSnapshotSession): boolean
    {
        return this.current === session && !session.signal.aborted;
    }

    public setVisible(visible: boolean): void
    {
        this.visible = visible;
        if (!visible)
        {
            this.cancel();
        }
    }

    public cancel(): void
    {
        ++this.generation;
        this.clear();
    }

    public dispose(): void
    {
        if (this.disposed)
        {
            return;
        }
        this.disposed = true;
        for (const unsubscribe of this.unsubscribe)
        {
            unsubscribe();
        }
        this.cancel();
    }

    private reconcile(): void
    {
        const held = this.held;
        if (!held)
        {
            return;
        }
        try
        {
            if (!this.matches(held.session.binding, held.observation) && this.held === held)
            {
                this.cancel();
            }
        }
        catch
        {
            if (this.held === held)
            {
                this.cancel();
            }
        }
    }

    private matches(binding: Readonly<AuthoringPanelSnapshotBinding>, observation: AuthoringWorkspaceServerObservation): boolean
    {
        if (this.disposed || !this.visible || this.now() >= binding.deadline)
        {
            return false;
        }
        requireWorkspaceServerObservation(observation);
        const snapshot = observation.snapshot;
        if (observation.status !== 'current' || observation.receipt.action !== 'read' || !snapshot
            || this.snapshots.getServerObservation() !== observation || snapshot.workspaceId !== 'default'
            || workspaceSnapshotDigest(snapshot.scope) !== workspaceSnapshotDigest(binding.scope)
            || snapshot.sourceDigest !== binding.sourceDigest || snapshot.revision !== binding.snapshotRevision
            || snapshot.contentDigest !== binding.snapshotDigest || snapshot.layout.groups.length !== 1)
        {
            return false;
        }
        const group = snapshot.layout.groups.find(item => item.groupId === binding.groupId);
        const tab = snapshot.layout.tabs.find(item => item.tabId === binding.tabId);
        const entry = this.tabs.getRegistry().getEntry(binding.tabId);
        if (!group?.tabIds.includes(binding.tabId) || !tab || !entry || this.tabs.getActiveTab()?.tabId !== binding.tabId
            || entry.owningGroupId !== binding.groupId || entry.status.lifecycle !== 'current'
            || !['allowed', 'read-only'].includes(entry.status.permission)
            || workspaceSnapshotDigest(tab.identity) !== workspaceSnapshotDigest(binding.documentIdentity)
            || workspaceSnapshotDigest(entry.identity) !== workspaceSnapshotDigest(binding.documentIdentity)
            || workspaceSnapshotDigest(entry.documentContext) !== workspaceSnapshotDigest(binding.documentContext))
        {
            return false;
        }
        const admitted = this.admission.isCurrent(binding);
        // Host callbacks may revoke provenance, switch documents, hide or dispose this adapter.
        requireWorkspaceServerObservation(observation);
        return admitted && !this.disposed && this.visible && this.now() < binding.deadline
            && this.snapshots.getServerObservation() === observation
            && this.tabs.getActiveTab()?.tabId === binding.tabId
            && workspaceSnapshotDigest(this.tabs.getRegistry().getEntry(binding.tabId)) === workspaceSnapshotDigest(entry);
    }

    private clear(): void
    {
        const held = this.held;
        this.held = null;
        if (held)
        {
            clearTimeout(held.timer);
            held.abort.abort();
        }
    }
}
