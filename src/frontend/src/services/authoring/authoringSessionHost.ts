import {
    calculateOpenArticleDocumentDigest,
    type ArticleDocumentContextRef,
    type ArticleDocumentIdentity,
    type ArticleLifecycleState,
    type ArticlePermissionState,
    type OpenArticleDocumentEntry
} from './openArticleDocumentRegistry';

export const authoringSessionHostSchema = 'fsusblog.authoring-session-host.v1' as const;
export const authoringSessionSnapshotSchema = 'fsusblog.authoring-session-snapshot-refs.v1' as const;
export const authoringSessionReceiptSchema = 'fsusblog.authoring-session-lifecycle-receipt.v1' as const;
export const authoringSessionResourcePolicySchema = 'fsusblog.authoring-session-resource-policy.v1' as const;
export const authoringSessionTaskEnvelopeSchema = 'fsusblog.authoring-session-task-envelope.v1' as const;

const digestPattern = /^[a-f0-9]{64}$/u;
const stableRefPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u;

export type AuthoringSessionLifecycleState =
  | 'active'
  | 'background-retained'
  | 'suspended'
  | 'restoring'
  | 'blocked'
  | 'closing'
  | 'closed'
  | 'evicted-with-recoverable-state';

export type AuthoringSessionBlockReason =
  | 'identity-mismatch'
  | 'document-epoch-mismatch'
  | 'source-revision-mismatch'
  | 'draft-revision-mismatch'
  | 'permission-blocked'
  | 'permission-mismatch'
  | 'article-deleted'
  | 'draft-replaced'
  | 'lifecycle-blocked'
  | 'snapshot-ref-invalid'
  | 'snapshot-restore-rejected';

export type AuthoringSessionTaskKind =
  | 'render'
  | 'projection'
  | 'feature'
  | 'refresh'
  | 'attachment'
  | 'search'
  | 'outline'
  | 'preview'
  | 'compare';

export interface AuthoringSessionResourceUsage {
    editorInstances: number;
    renderers: number;
    observers: number;
    timers: number;
    backgroundTasks: number;
    networkRequests: number;
    memoryUnits: number;
}

export interface AuthoringSessionResourcePolicy {
    schema: typeof authoringSessionResourcePolicySchema;
    maxOpenSessions: 100;
    maxActiveSessions: 1;
    maxBackgroundRetainedSessions: number;
    maxSuspendedSessions: number;
    maxLiveEditorInstances: number;
    maxRenderers: number;
    maxObservers: number;
    maxTimers: number;
    maxBackgroundTasks: number;
    maxNetworkRequests: number;
    maxMemoryUnits: number;
    priorityFacts: readonly ['active', 'recovery', 'conflict', 'pending-attachment', 'saving', 'dirty', 'nearby', 'recently-used'];
    prohibitedFacts: readonly ['title', 'source-size', 'array-position', 'route'];
}

export const defaultAuthoringSessionResourcePolicy: AuthoringSessionResourcePolicy = Object.freeze<AuthoringSessionResourcePolicy>({
    schema: authoringSessionResourcePolicySchema,
    maxOpenSessions: 100,
    maxActiveSessions: 1,
    maxBackgroundRetainedSessions: 7,
    maxSuspendedSessions: 8,
    maxLiveEditorInstances: 16,
    maxRenderers: 1,
    maxObservers: 1,
    maxTimers: 1,
    maxBackgroundTasks: 1,
    maxNetworkRequests: 1,
    maxMemoryUnits: 160,
    priorityFacts: [
        'active',
        'recovery',
        'conflict',
        'pending-attachment',
        'saving',
        'dirty',
        'nearby',
        'recently-used'
    ],
    prohibitedFacts: ['title', 'source-size', 'array-position', 'route']
});

export interface AuthoringSessionSnapshotRefs {
    schema: typeof authoringSessionSnapshotSchema;
    snapshotRef: string;
    identity: ArticleDocumentIdentity;
    editorSessionRef: string;
    documentContext: ArticleDocumentContextRef;
    permission: ArticlePermissionState;
    permissionRef: string;
    selectionRef: string;
    selectionDirection: 'forward' | 'backward' | 'none';
    historyRef: string;
    activeNodeRef: string;
    scrollAnchorRef: string;
    outlineRef: string;
    searchRef: string;
    attachmentStateRef: string;
    lastValidRenderRef: string;
    draftStateRef: string;
    crashJournalRef: string;
    editorContentDigest: string;
    snapshotDigest: string;
}

export interface AuthoringSessionSnapshotContext {
    identity: ArticleDocumentIdentity;
    editorSessionRef: string;
    documentContext: ArticleDocumentContextRef;
    permission: ArticlePermissionState;
    permissionRef: string;
}

export interface AuthoringSessionRestoreProof {
    status: 'restored' | 'blocked';
    snapshotRef: string;
    snapshotDigest: string;
    identityValidated: boolean;
    refsValidated: boolean;
    reason: string | null;
}

export interface FsusUiPublicEditorSession {
    readonly editorSessionRef: string;
    captureSnapshot(context: AuthoringSessionSnapshotContext): AuthoringSessionSnapshotRefs;
    pauseResources(): AuthoringSessionResourceUsage;
    resumeResources(): AuthoringSessionResourceUsage;
    restoreSnapshot(
        snapshot: AuthoringSessionSnapshotRefs,
        context: AuthoringSessionSnapshotContext
    ): AuthoringSessionRestoreProof;
    inspectResources(): AuthoringSessionResourceUsage;
    disposeAfterSnapshot(snapshotRef: string): void;
}

export interface FsusUiPublicEditorSessionFactory {
    createSession(entry: OpenArticleDocumentEntry): FsusUiPublicEditorSession;
}

export interface AuthoringSessionRiskFacts {
    dirty: boolean;
    saving: boolean;
    conflict: boolean;
    recovery: boolean;
    pendingAttachments: boolean;
    nearby: boolean;
}

export interface AuthoringSessionRestoreValidation {
    status: 'not-required' | 'validated' | 'blocked';
    reason: AuthoringSessionBlockReason | null;
    snapshotRef: string;
    snapshotDigest: string;
    identityValidated: boolean;
    refsValidated: boolean;
}

export interface AuthoringSessionTaskDescriptor {
    taskRef: string;
    kind: AuthoringSessionTaskKind;
    documentEpoch: number;
    sourceRevision: string | null;
    abortController: AbortController;
}

export interface AuthoringSessionTaskEnvelope {
    schema: typeof authoringSessionTaskEnvelopeSchema;
    taskRef: string;
    editorSessionRef: string;
    documentEpoch: number;
    sourceRevision: string | null;
    producerRef: string;
    editorContentDigest: string;
}

export interface AuthoringSessionRecordState {
    registryEntryDigest: string;
    identity: ArticleDocumentIdentity;
    editorSessionRef: string;
    tabId: string;
    owningGroupId: string;
    documentContext: ArticleDocumentContextRef;
    permission: ArticlePermissionState;
    lifecycle: ArticleLifecycleState;
    permissionRef: string;
    lifecycleState: AuthoringSessionLifecycleState;
    blockReason: AuthoringSessionBlockReason | null;
    risk: AuthoringSessionRiskFacts;
    snapshot: AuthoringSessionSnapshotRefs;
    resources: AuthoringSessionResourceUsage;
    taskRefs: string[];
    lastUsedTick: number;
    restoreValidation: AuthoringSessionRestoreValidation;
    contentDigest: string;
}

export interface AuthoringSessionLifecycleReceipt {
    schema: typeof authoringSessionReceiptSchema;
    receiptRef: string;
    action: 'attach' | 'activate' | 'retain' | 'suspend' | 'restore' | 'block' | 'evict' | 'group-ownership' | 'closing' | 'closed';
    registryEntryDigest: string;
    editorSessionRef: string;
    documentId: string;
    documentEpoch: number;
    snapshotRef: string;
    resourceBefore: AuthoringSessionResourceUsage;
    resourceAfter: AuthoringSessionResourceUsage;
    taskRefsBefore: string[];
    taskRefsAfter: string[];
    stateBefore: AuthoringSessionLifecycleState;
    stateAfter: AuthoringSessionLifecycleState;
    restoreValidation: AuthoringSessionRestoreValidation;
    editorContentDigest: string;
    authorityRef: string | null;
    contentDigest: string;
}

export interface AuthoringSessionHostState {
    schema: typeof authoringSessionHostSchema;
    revision: number;
    resourcePolicy: AuthoringSessionResourcePolicy;
    sessions: AuthoringSessionRecordState[];
    receipts: AuthoringSessionLifecycleReceipt[];
    aggregateResources: AuthoringSessionResourceUsage;
    contentDigest: string;
}

interface HostedSession {
    state: AuthoringSessionRecordState;
    bridge: FsusUiPublicEditorSession | null;
    tasks: Map<string, AuthoringSessionTaskDescriptor>;
}

const zeroResources = (): AuthoringSessionResourceUsage => ({
    editorInstances: 0,
    renderers: 0,
    observers: 0,
    timers: 0,
    backgroundTasks: 0,
    networkRequests: 0,
    memoryUnits: 0
});

const cloneValue = <T>(value: T): T => structuredClone(value);

function withoutDigest<T extends { contentDigest: string; }>(value: T): Omit<T, 'contentDigest'>
{
    const copy: Partial<T> = { ...value };
    delete copy.contentDigest;
    return copy as Omit<T, 'contentDigest'>;
}

function isStableRef(value: unknown): value is string
{
    return typeof value === 'string' && stableRefPattern.test(value);
}

function isDigest(value: unknown): value is string
{
    return typeof value === 'string' && digestPattern.test(value);
}

function isNullableStableRef(value: unknown): value is string | null
{
    return value === null || isStableRef(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown>
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    const expected = [...keys].sort();
    const actual = Object.keys(value).sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function verifyRegistryEntryDigest(entry: OpenArticleDocumentEntry): boolean
{
    return isDigest(entry.contentDigest)
        && entry.contentDigest === calculateOpenArticleDocumentDigest({
            ...entry,
            contentDigest: undefined
        });
}

function sameIdentity(left: ArticleDocumentIdentity, right: ArticleDocumentIdentity): boolean
{
    return left.articleId === right.articleId
        && left.draftId === right.draftId
        && left.documentId === right.documentId;
}

function sameContext(left: ArticleDocumentContextRef, right: ArticleDocumentContextRef): boolean
{
    return left.documentEpoch === right.documentEpoch
        && left.sourceRevision === right.sourceRevision
        && left.draftRevision === right.draftRevision;
}

function identityAuthorityKey(identity: ArticleDocumentIdentity): string
{
    return identity.articleId === null ? `draft:${identity.draftId}` : `article:${identity.articleId}`;
}

function contextFromEntry(entry: OpenArticleDocumentEntry): AuthoringSessionSnapshotContext
{
    return {
        identity: cloneValue(entry.identity),
        editorSessionRef: entry.editorSessionRef,
        documentContext: cloneValue(entry.documentContext),
        permission: entry.status.permission,
        permissionRef: entry.status.statusRef
    };
}

function riskFromEntry(entry: OpenArticleDocumentEntry, nearby: boolean): AuthoringSessionRiskFacts
{
    return {
        dirty: entry.status.dirty,
        saving: entry.status.saving,
        conflict: entry.status.conflict,
        recovery: entry.status.recovery,
        pendingAttachments: entry.status.pendingAttachments,
        nearby
    };
}

function isCritical(risk: AuthoringSessionRiskFacts): boolean
{
    return risk.dirty
        || risk.saving
        || risk.conflict
        || risk.recovery
        || risk.pendingAttachments;
}

function validateResourceUsage(usage: AuthoringSessionResourceUsage): void
{
    for (const value of Object.values(usage))
    {
        if (!Number.isSafeInteger(value) || value < 0)
        {
            throw new Error('session-resource-usage-invalid');
        }
    }
}

function verifyResourcePolicy(policy: AuthoringSessionResourcePolicy): boolean
{
    const numericValues = [
        policy.maxOpenSessions,
        policy.maxActiveSessions,
        policy.maxBackgroundRetainedSessions,
        policy.maxSuspendedSessions,
        policy.maxLiveEditorInstances,
        policy.maxRenderers,
        policy.maxObservers,
        policy.maxTimers,
        policy.maxBackgroundTasks,
        policy.maxNetworkRequests,
        policy.maxMemoryUnits
    ];
    return policy.schema === authoringSessionResourcePolicySchema
        && policy.maxOpenSessions === 100
        && policy.maxActiveSessions === 1
        && numericValues.every(value => Number.isSafeInteger(value) && value >= 0)
        && policy.maxLiveEditorInstances <= policy.maxOpenSessions
        && calculateOpenArticleDocumentDigest(policy.priorityFacts)
            === calculateOpenArticleDocumentDigest(defaultAuthoringSessionResourcePolicy.priorityFacts)
        && calculateOpenArticleDocumentDigest(policy.prohibitedFacts)
            === calculateOpenArticleDocumentDigest(defaultAuthoringSessionResourcePolicy.prohibitedFacts);
}

function isPausedUsage(usage: AuthoringSessionResourceUsage): boolean
{
    return usage.renderers === 0
        && usage.observers === 0
        && usage.timers === 0
        && usage.backgroundTasks === 0
        && usage.networkRequests === 0;
}

function snapshotDigest(snapshot: Omit<AuthoringSessionSnapshotRefs, 'snapshotDigest'>): string
{
    return calculateOpenArticleDocumentDigest(snapshot);
}

export function sealAuthoringSessionSnapshot(
    snapshot: Omit<AuthoringSessionSnapshotRefs, 'snapshotDigest'>
): AuthoringSessionSnapshotRefs
{
    return {
        ...cloneValue(snapshot),
        snapshotDigest: snapshotDigest(snapshot)
    };
}

export function verifyAuthoringSessionSnapshot(snapshot: AuthoringSessionSnapshotRefs): boolean
{
    return hasExactKeys(snapshot, [
        'schema',
        'snapshotRef',
        'identity',
        'editorSessionRef',
        'documentContext',
        'permission',
        'permissionRef',
        'selectionRef',
        'selectionDirection',
        'historyRef',
        'activeNodeRef',
        'scrollAnchorRef',
        'outlineRef',
        'searchRef',
        'attachmentStateRef',
        'lastValidRenderRef',
        'draftStateRef',
        'crashJournalRef',
        'editorContentDigest',
        'snapshotDigest'
    ])
        && hasExactKeys(snapshot.identity, ['articleId', 'draftId', 'documentId'])
        && hasExactKeys(snapshot.documentContext, ['documentEpoch', 'sourceRevision', 'draftRevision'])
        && snapshot.schema === authoringSessionSnapshotSchema
        && isStableRef(snapshot.snapshotRef)
        && (snapshot.identity.articleId === null
            || (Number.isSafeInteger(snapshot.identity.articleId) && Number(snapshot.identity.articleId) > 0))
        && isStableRef(snapshot.identity.draftId)
        && isStableRef(snapshot.identity.documentId)
        && isStableRef(snapshot.editorSessionRef)
        && Number.isSafeInteger(snapshot.documentContext.documentEpoch)
        && snapshot.documentContext.documentEpoch > 0
        && isNullableStableRef(snapshot.documentContext.sourceRevision)
        && isNullableStableRef(snapshot.documentContext.draftRevision)
        && ['allowed', 'read-only', 'denied', 'revoked'].includes(snapshot.permission)
        && [
            snapshot.permissionRef,
            snapshot.selectionRef,
            snapshot.historyRef,
            snapshot.activeNodeRef,
            snapshot.scrollAnchorRef,
            snapshot.outlineRef,
            snapshot.searchRef,
            snapshot.attachmentStateRef,
            snapshot.lastValidRenderRef,
            snapshot.draftStateRef,
            snapshot.crashJournalRef
        ].every(isStableRef)
        && ['forward', 'backward', 'none'].includes(snapshot.selectionDirection)
        && isDigest(snapshot.editorContentDigest)
        && isDigest(snapshot.snapshotDigest)
        && snapshot.snapshotDigest === snapshotDigest({
            ...snapshot,
            snapshotDigest: undefined
        } as unknown as Omit<AuthoringSessionSnapshotRefs, 'snapshotDigest'>);
}

function validateSnapshotForEntry(
    snapshot: AuthoringSessionSnapshotRefs,
    entry: OpenArticleDocumentEntry
): AuthoringSessionBlockReason | null
{
    if (!verifyAuthoringSessionSnapshot(snapshot))
    {
        return 'snapshot-ref-invalid';
    }
    if (entry.status.permission === 'denied' || entry.status.permission === 'revoked')
    {
        return 'permission-blocked';
    }
    if (entry.status.lifecycle === 'deleted')
    {
        return 'article-deleted';
    }
    if (entry.status.lifecycle === 'draft-replaced')
    {
        return 'draft-replaced';
    }
    if (entry.status.lifecycle !== 'current')
    {
        return 'lifecycle-blocked';
    }
    if (!sameIdentity(snapshot.identity, entry.identity) || snapshot.editorSessionRef !== entry.editorSessionRef)
    {
        return 'identity-mismatch';
    }
    if (snapshot.documentContext.documentEpoch !== entry.documentContext.documentEpoch)
    {
        return 'document-epoch-mismatch';
    }
    if (snapshot.documentContext.sourceRevision !== entry.documentContext.sourceRevision)
    {
        return 'source-revision-mismatch';
    }
    if (snapshot.documentContext.draftRevision !== entry.documentContext.draftRevision)
    {
        return 'draft-revision-mismatch';
    }
    if (snapshot.permission !== entry.status.permission)
    {
        return 'permission-mismatch';
    }
    return null;
}

function notRequiredValidation(snapshot: AuthoringSessionSnapshotRefs): AuthoringSessionRestoreValidation
{
    return {
        status: 'not-required',
        reason: null,
        snapshotRef: snapshot.snapshotRef,
        snapshotDigest: snapshot.snapshotDigest,
        identityValidated: true,
        refsValidated: true
    };
}

function recordDigest(record: Omit<AuthoringSessionRecordState, 'contentDigest'>): string
{
    return calculateOpenArticleDocumentDigest(record);
}

function withRecordDigest(record: Omit<AuthoringSessionRecordState, 'contentDigest'>): AuthoringSessionRecordState
{
    return { ...record, contentDigest: recordDigest(record) };
}

function receiptDigest(receipt: Omit<AuthoringSessionLifecycleReceipt, 'contentDigest'>): string
{
    return calculateOpenArticleDocumentDigest(receipt);
}

function aggregateResources(records: Iterable<AuthoringSessionRecordState>): AuthoringSessionResourceUsage
{
    const aggregate = zeroResources();
    for (const record of records)
    {
        for (const key of Object.keys(aggregate) as (keyof AuthoringSessionResourceUsage)[])
        {
            aggregate[key] += record.resources[key];
        }
    }
    return aggregate;
}

export const authoringSessionLifecycleTransitions: Readonly<Record<AuthoringSessionLifecycleState, readonly AuthoringSessionLifecycleState[]>> = Object.freeze({
    active: ['background-retained', 'suspended', 'blocked', 'closing'],
    'background-retained': ['active', 'suspended', 'blocked', 'closing', 'evicted-with-recoverable-state'],
    suspended: ['restoring', 'blocked', 'closing', 'evicted-with-recoverable-state'],
    restoring: ['active', 'blocked'],
    blocked: ['restoring', 'closing'],
    closing: ['closed', 'active', 'background-retained'],
    closed: [],
    'evicted-with-recoverable-state': ['restoring', 'blocked', 'closing']
});

export class AuthoringSessionHost
{
    private sessionsByRef = new Map<string, HostedSession>();
    private receipts: AuthoringSessionLifecycleReceipt[] = [];
    private revision = 0;
    private readonly factory: FsusUiPublicEditorSessionFactory;
    private readonly policy: AuthoringSessionResourcePolicy;

    public constructor(
        factory: FsusUiPublicEditorSessionFactory,
        policy: AuthoringSessionResourcePolicy = defaultAuthoringSessionResourcePolicy
    )
    {
        this.factory = factory;
        this.policy = policy;
        if (!verifyResourcePolicy(policy))
        {
            throw new Error('session-resource-policy-invalid');
        }
    }

    public attach(entry: OpenArticleDocumentEntry, lastUsedTick: number, nearby = false): AuthoringSessionLifecycleReceipt
    {
        this.assertTick(lastUsedTick);
        if (!verifyRegistryEntryDigest(entry))
        {
            throw new Error('registry-entry-digest-invalid');
        }
        const existing = this.sessionsByRef.get(entry.editorSessionRef);
        if (existing)
        {
            if (!sameIdentity(existing.state.identity, entry.identity))
            {
                throw new Error('registry-session-ref-reused');
            }
            return this.synchronizeRegistryEntry(entry, lastUsedTick, nearby);
        }
        if (this.sessionsByRef.size >= this.policy.maxOpenSessions)
        {
            throw new Error('session-open-budget-exceeded');
        }
        if ([...this.sessionsByRef.values()].some(session => (
            identityAuthorityKey(session.state.identity) === identityAuthorityKey(entry.identity)
        )))
        {
            throw new Error('registry-identity-has-second-session');
        }

        if (entry.isActive)
        {
            this.deactivateCurrent(entry.editorSessionRef, lastUsedTick);
        }

        const bridge = this.factory.createSession(entry);
        if (bridge.editorSessionRef !== entry.editorSessionRef)
        {
            throw new Error('editor-session-ref-mismatch');
        }
        const snapshot = bridge.captureSnapshot(contextFromEntry(entry));
        const snapshotFailure = validateSnapshotForEntry(snapshot, entry);
        if (snapshotFailure)
        {
            bridge.disposeAfterSnapshot(snapshot.snapshotRef);
            throw new Error(`editor-snapshot-invalid:${snapshotFailure}`);
        }

        let resources = bridge.inspectResources();
        validateResourceUsage(resources);
        const lifecycleState: AuthoringSessionLifecycleState = entry.isActive ? 'active' : 'background-retained';
        if (!entry.isActive)
        {
            resources = bridge.pauseResources();
            validateResourceUsage(resources);
            if (!isPausedUsage(resources))
            {
                throw new Error('inactive-session-resources-not-paused');
            }
        }

        const hosted: HostedSession = {
            bridge,
            tasks: new Map(),
            state: withRecordDigest({
                registryEntryDigest: entry.contentDigest,
                identity: cloneValue(entry.identity),
                editorSessionRef: entry.editorSessionRef,
                tabId: entry.tabId,
                owningGroupId: entry.owningGroupId,
                documentContext: cloneValue(entry.documentContext),
                permission: entry.status.permission,
                lifecycle: entry.status.lifecycle,
                permissionRef: entry.status.statusRef,
                lifecycleState,
                blockReason: null,
                risk: riskFromEntry(entry, nearby),
                snapshot,
                resources,
                taskRefs: [],
                lastUsedTick,
                restoreValidation: notRequiredValidation(snapshot)
            })
        };
        this.sessionsByRef.set(entry.editorSessionRef, hosted);
        const receipt = this.recordReceipt('attach', null, hosted, lifecycleState, zeroResources(), null);
        this.reconcileResources();
        return receipt;
    }

    public activate(entry: OpenArticleDocumentEntry, lastUsedTick: number): AuthoringSessionLifecycleReceipt
    {
        this.assertTick(lastUsedTick);
        if (!verifyRegistryEntryDigest(entry))
        {
            throw new Error('registry-entry-digest-invalid');
        }
        const hosted = this.requireSession(entry.editorSessionRef);
        this.deactivateCurrent(entry.editorSessionRef, lastUsedTick);
        const stateBefore = hosted.state.lifecycleState;
        const resourcesBefore = cloneValue(hosted.state.resources);
        const tasksBefore = [...hosted.tasks.keys()].sort();
        const validationFailure = validateSnapshotForEntry(hosted.state.snapshot, entry);
        if (validationFailure)
        {
            return this.blockSession(hosted, entry, validationFailure, stateBefore, resourcesBefore, tasksBefore);
        }

        let bridge = hosted.bridge;
        if (!bridge)
        {
            bridge = this.factory.createSession(entry);
            if (bridge.editorSessionRef !== entry.editorSessionRef)
            {
                throw new Error('editor-session-ref-mismatch');
            }
            hosted.bridge = bridge;
        }

        let restoreValidation = notRequiredValidation(hosted.state.snapshot);
        if (stateBefore === 'suspended' || stateBefore === 'evicted-with-recoverable-state' || stateBefore === 'blocked')
        {
            this.updateHosted(hosted, {
                ...hosted.state,
                lifecycleState: 'restoring'
            });
            const proof = bridge.restoreSnapshot(hosted.state.snapshot, contextFromEntry(entry));
            const proofValid = proof.status === 'restored'
                && proof.snapshotRef === hosted.state.snapshot.snapshotRef
                && proof.snapshotDigest === hosted.state.snapshot.snapshotDigest
                && proof.identityValidated
                && proof.refsValidated;
            restoreValidation = {
                status: proofValid ? 'validated' : 'blocked',
                reason: proofValid ? null : 'snapshot-restore-rejected',
                snapshotRef: proof.snapshotRef,
                snapshotDigest: proof.snapshotDigest,
                identityValidated: proof.identityValidated,
                refsValidated: proof.refsValidated
            };
            if (!proofValid)
            {
                return this.blockSession(
                    hosted,
                    entry,
                    'snapshot-restore-rejected',
                    stateBefore,
                    resourcesBefore,
                    tasksBefore,
                    restoreValidation
                );
            }
        }

        const resources = bridge.resumeResources();
        validateResourceUsage(resources);
        this.updateHosted(hosted, {
            ...hosted.state,
            registryEntryDigest: entry.contentDigest,
            identity: cloneValue(entry.identity),
            tabId: entry.tabId,
            owningGroupId: entry.owningGroupId,
            documentContext: cloneValue(entry.documentContext),
            permission: entry.status.permission,
            lifecycle: entry.status.lifecycle,
            permissionRef: entry.status.statusRef,
            lifecycleState: 'active',
            blockReason: null,
            risk: riskFromEntry(entry, false),
            resources,
            lastUsedTick,
            restoreValidation
        });
        const receipt = this.recordReceipt(
            restoreValidation.status === 'validated' ? 'restore' : 'activate',
            stateBefore,
            hosted,
            'active',
            resourcesBefore,
            null,
            tasksBefore
        );
        this.reconcileResources();
        return receipt;
    }

    public synchronizeRegistryEntry(
        entry: OpenArticleDocumentEntry,
        lastUsedTick: number,
        nearby = false
    ): AuthoringSessionLifecycleReceipt
    {
        this.assertTick(lastUsedTick);
        if (!verifyRegistryEntryDigest(entry))
        {
            throw new Error('registry-entry-digest-invalid');
        }
        const hosted = this.requireSession(entry.editorSessionRef);
        const stateBefore = hosted.state.lifecycleState;
        const resourcesBefore = cloneValue(hosted.state.resources);
        const tasksBefore = [...hosted.tasks.keys()].sort();

        if (entry.status.lifecycle === 'deleted')
        {
            return this.blockSession(hosted, entry, 'article-deleted', stateBefore, resourcesBefore, tasksBefore);
        }
        if (entry.status.lifecycle === 'draft-replaced')
        {
            return this.blockSession(hosted, entry, 'draft-replaced', stateBefore, resourcesBefore, tasksBefore);
        }
        if (!sameIdentity(hosted.state.identity, entry.identity))
        {
            return this.blockSession(hosted, entry, 'identity-mismatch', stateBefore, resourcesBefore, tasksBefore);
        }
        if (hosted.state.documentContext.documentEpoch !== entry.documentContext.documentEpoch)
        {
            return this.blockSession(hosted, entry, 'document-epoch-mismatch', stateBefore, resourcesBefore, tasksBefore);
        }

        const groupOnly = sameContext(hosted.state.documentContext, entry.documentContext)
            && hosted.state.permission === entry.status.permission
            && hosted.state.lifecycle === entry.status.lifecycle
            && hosted.state.permissionRef === entry.status.statusRef
            && hosted.state.owningGroupId !== entry.owningGroupId;

        if (
            hosted.state.lifecycleState !== 'active'
            && (!sameContext(hosted.state.documentContext, entry.documentContext)
                || hosted.state.permission !== entry.status.permission
                || entry.status.lifecycle !== 'current')
        )
        {
            const reason = validateSnapshotForEntry(hosted.state.snapshot, entry) ?? 'lifecycle-blocked';
            return this.blockSession(hosted, entry, reason, stateBefore, resourcesBefore, tasksBefore);
        }

        if (hosted.state.lifecycleState === 'active' && hosted.bridge)
        {
            const nextSnapshot = hosted.bridge.captureSnapshot(contextFromEntry(entry));
            const failure = validateSnapshotForEntry(nextSnapshot, entry);
            if (failure)
            {
                return this.blockSession(hosted, entry, failure, stateBefore, resourcesBefore, tasksBefore);
            }
            hosted.state.snapshot = nextSnapshot;
        }

        this.updateHosted(hosted, {
            ...hosted.state,
            registryEntryDigest: entry.contentDigest,
            tabId: entry.tabId,
            owningGroupId: entry.owningGroupId,
            documentContext: cloneValue(entry.documentContext),
            permission: entry.status.permission,
            lifecycle: entry.status.lifecycle,
            permissionRef: entry.status.statusRef,
            risk: riskFromEntry(entry, nearby),
            lastUsedTick
        });
        const receipt = this.recordReceipt(
            groupOnly ? 'group-ownership' : 'retain',
            stateBefore,
            hosted,
            hosted.state.lifecycleState,
            resourcesBefore,
            groupOnly ? entry.owningGroupId : null,
            tasksBefore
        );
        this.reconcileResources();
        return receipt;
    }

    public registerTask(editorSessionRef: string, descriptor: AuthoringSessionTaskDescriptor): boolean
    {
        const hosted = this.sessionsByRef.get(editorSessionRef);
        if (!hosted)
        {
            descriptor.abortController.abort();
            return false;
        }
        if (
            hosted.state.lifecycleState !== 'active'
            || descriptor.documentEpoch !== hosted.state.documentContext.documentEpoch
            || descriptor.sourceRevision !== hosted.state.documentContext.sourceRevision
            || !isStableRef(descriptor.taskRef)
            || hosted.tasks.has(descriptor.taskRef)
        )
        {
            descriptor.abortController.abort();
            return false;
        }
        hosted.tasks.set(descriptor.taskRef, descriptor);
        this.updateHosted(hosted, {
            ...hosted.state,
            taskRefs: [...hosted.tasks.keys()].sort()
        });
        return true;
    }

    public acceptTaskResult(envelope: AuthoringSessionTaskEnvelope): boolean
    {
        const hosted = this.sessionsByRef.get(envelope.editorSessionRef);
        const task = hosted?.tasks.get(envelope.taskRef);
        if (
            !hosted
            || !task
            || envelope.schema !== authoringSessionTaskEnvelopeSchema
            || hosted.state.lifecycleState !== 'active'
            || task.abortController.signal.aborted
            || envelope.documentEpoch !== hosted.state.documentContext.documentEpoch
            || envelope.sourceRevision !== hosted.state.documentContext.sourceRevision
            || !isStableRef(envelope.producerRef)
            || !isDigest(envelope.editorContentDigest)
        )
        {
            return false;
        }
        hosted.tasks.delete(envelope.taskRef);
        this.updateHosted(hosted, {
            ...hosted.state,
            taskRefs: [...hosted.tasks.keys()].sort()
        });
        return true;
    }

    public applyCloseAuthority(
        editorSessionRef: string,
        state: 'closing' | 'closed',
        authorityRef: string
    ): AuthoringSessionLifecycleReceipt
    {
        if (!isStableRef(authorityRef))
        {
            throw new Error('close-authority-ref-invalid');
        }
        const hosted = this.requireSession(editorSessionRef);
        const before = hosted.state.lifecycleState;
        if (!authoringSessionLifecycleTransitions[before].includes(state))
        {
            throw new Error('session-close-transition-invalid');
        }
        const resourcesBefore = cloneValue(hosted.state.resources);
        const tasksBefore = [...hosted.tasks.keys()].sort();
        this.cancelTasks(hosted);
        if (hosted.bridge)
        {
            const snapshot = hosted.bridge.captureSnapshot({
                identity: cloneValue(hosted.state.identity),
                editorSessionRef,
                documentContext: cloneValue(hosted.state.documentContext),
                permission: hosted.state.permission,
                permissionRef: hosted.state.permissionRef
            });
            if (!verifyAuthoringSessionSnapshot(snapshot))
            {
                throw new Error('close-snapshot-invalid');
            }
            hosted.state.snapshot = snapshot;
            const paused = hosted.bridge.pauseResources();
            validateResourceUsage(paused);
            hosted.state.resources = paused;
            if (state === 'closed')
            {
                hosted.bridge.disposeAfterSnapshot(snapshot.snapshotRef);
                hosted.bridge = null;
                hosted.state.resources = zeroResources();
            }
        }
        this.updateHosted(hosted, {
            ...hosted.state,
            lifecycleState: state,
            blockReason: null
        });
        return this.recordReceipt(state, before, hosted, state, resourcesBefore, authorityRef, tasksBefore);
    }

    public getSession(editorSessionRef: string): AuthoringSessionRecordState | null
    {
        const hosted = this.sessionsByRef.get(editorSessionRef);
        return hosted ? cloneValue(hosted.state) : null;
    }

    public listSessions(): AuthoringSessionRecordState[]
    {
        return [...this.sessionsByRef.values()]
            .map(hosted => cloneValue(hosted.state))
            .sort((left, right) => left.editorSessionRef.localeCompare(right.editorSessionRef));
    }

    public exportState(): AuthoringSessionHostState
    {
        const sessions = this.listSessions();
        const base = {
            schema: authoringSessionHostSchema,
            revision: this.revision,
            resourcePolicy: cloneValue(this.policy),
            sessions,
            receipts: cloneValue(this.receipts),
            aggregateResources: aggregateResources(sessions)
        };
        return {
            ...base,
            contentDigest: calculateOpenArticleDocumentDigest(base)
        };
    }

    private deactivateCurrent(exceptSessionRef: string, lastUsedTick: number): void
    {
        for (const hosted of this.sessionsByRef.values())
        {
            if (hosted.state.editorSessionRef === exceptSessionRef || hosted.state.lifecycleState !== 'active')
            {
                continue;
            }
            const before = cloneValue(hosted.state.resources);
            const tasksBefore = [...hosted.tasks.keys()].sort();
            this.captureAndPause(hosted);
            this.updateHosted(hosted, {
                ...hosted.state,
                lifecycleState: 'background-retained',
                lastUsedTick: Math.min(hosted.state.lastUsedTick, lastUsedTick),
                restoreValidation: notRequiredValidation(hosted.state.snapshot)
            });
            this.recordReceipt('retain', 'active', hosted, 'background-retained', before, null, tasksBefore);
        }
    }

    private reconcileResources(): void
    {
        const inactive = [...this.sessionsByRef.values()]
            .filter(hosted => !['active', 'blocked', 'closing', 'closed'].includes(hosted.state.lifecycleState))
            .sort((left, right) =>
            {
                const criticalDelta = Number(isCritical(right.state.risk)) - Number(isCritical(left.state.risk));
                if (criticalDelta !== 0)
                {
                    return criticalDelta;
                }
                const nearbyDelta = Number(right.state.risk.nearby) - Number(left.state.risk.nearby);
                if (nearbyDelta !== 0)
                {
                    return nearbyDelta;
                }
                return right.state.lastUsedTick - left.state.lastUsedTick
                    || left.state.editorSessionRef.localeCompare(right.state.editorSessionRef);
            });

        inactive.forEach((hosted, index) =>
        {
            if (index < this.policy.maxBackgroundRetainedSessions && hosted.bridge)
            {
                this.moveInactive(hosted, 'background-retained');
            }
            else if (
                index < this.policy.maxBackgroundRetainedSessions + this.policy.maxSuspendedSessions
                && hosted.bridge
            )
            {
                this.moveInactive(hosted, 'suspended');
            }
            else
            {
                this.moveInactive(hosted, 'evicted-with-recoverable-state');
            }
        });
        this.assertAggregateBudget();
    }

    private moveInactive(
        hosted: HostedSession,
        target: 'background-retained' | 'suspended' | 'evicted-with-recoverable-state'
    ): void
    {
        if (hosted.state.lifecycleState === target)
        {
            return;
        }
        const beforeState = hosted.state.lifecycleState;
        const resourcesBefore = cloneValue(hosted.state.resources);
        const tasksBefore = [...hosted.tasks.keys()].sort();
        if (hosted.bridge)
        {
            this.captureAndPause(hosted);
        }
        if (target === 'evicted-with-recoverable-state' && hosted.bridge)
        {
            hosted.bridge.disposeAfterSnapshot(hosted.state.snapshot.snapshotRef);
            hosted.bridge = null;
            hosted.state.resources = zeroResources();
        }
        this.updateHosted(hosted, {
            ...hosted.state,
            lifecycleState: target,
            restoreValidation: notRequiredValidation(hosted.state.snapshot)
        });
        this.recordReceipt(
            target === 'background-retained' ? 'retain' : target === 'suspended' ? 'suspend' : 'evict',
            beforeState,
            hosted,
            target,
            resourcesBefore,
            null,
            tasksBefore
        );
    }

    private captureAndPause(hosted: HostedSession): void
    {
        if (!hosted.bridge)
        {
            return;
        }
        const context: AuthoringSessionSnapshotContext = {
            identity: cloneValue(hosted.state.identity),
            editorSessionRef: hosted.state.editorSessionRef,
            documentContext: cloneValue(hosted.state.documentContext),
            permission: hosted.state.permission,
            permissionRef: hosted.state.permissionRef
        };
        const snapshot = hosted.bridge.captureSnapshot(context);
        if (!verifyAuthoringSessionSnapshot(snapshot))
        {
            throw new Error('editor-snapshot-invalid');
        }
        this.cancelTasks(hosted);
        const resources = hosted.bridge.pauseResources();
        validateResourceUsage(resources);
        if (!isPausedUsage(resources))
        {
            throw new Error('inactive-session-resources-not-paused');
        }
        hosted.state.snapshot = snapshot;
        hosted.state.resources = resources;
    }

    private cancelTasks(hosted: HostedSession): void
    {
        for (const task of hosted.tasks.values())
        {
            task.abortController.abort();
        }
        hosted.tasks.clear();
        hosted.state.taskRefs = [];
    }

    private blockSession(
        hosted: HostedSession,
        entry: OpenArticleDocumentEntry,
        reason: AuthoringSessionBlockReason,
        stateBefore: AuthoringSessionLifecycleState,
        resourcesBefore: AuthoringSessionResourceUsage,
        tasksBefore: string[],
        restoreValidation: AuthoringSessionRestoreValidation = {
            status: 'blocked',
            reason,
            snapshotRef: hosted.state.snapshot.snapshotRef,
            snapshotDigest: hosted.state.snapshot.snapshotDigest,
            identityValidated: reason !== 'identity-mismatch',
            refsValidated: reason !== 'snapshot-ref-invalid'
        }
    ): AuthoringSessionLifecycleReceipt
    {
        this.cancelTasks(hosted);
        if (hosted.bridge)
        {
            const paused = hosted.bridge.pauseResources();
            validateResourceUsage(paused);
            if (!isPausedUsage(paused))
            {
                throw new Error('blocked-session-resources-not-paused');
            }
            hosted.state.resources = paused;
        }
        this.updateHosted(hosted, {
            ...hosted.state,
            registryEntryDigest: entry.contentDigest,
            tabId: entry.tabId,
            owningGroupId: entry.owningGroupId,
            permission: entry.status.permission,
            lifecycle: entry.status.lifecycle,
            permissionRef: entry.status.statusRef,
            risk: riskFromEntry(entry, false),
            lifecycleState: 'blocked',
            blockReason: reason,
            restoreValidation
        });
        return this.recordReceipt('block', stateBefore, hosted, 'blocked', resourcesBefore, entry.status.statusRef, tasksBefore);
    }

    private updateHosted(hosted: HostedSession, state: AuthoringSessionRecordState): void
    {
        hosted.state = withRecordDigest(withoutDigest(state));
    }

    private recordReceipt(
        action: AuthoringSessionLifecycleReceipt['action'],
        stateBefore: AuthoringSessionLifecycleState | null,
        hosted: HostedSession,
        stateAfter: AuthoringSessionLifecycleState,
        resourceBefore: AuthoringSessionResourceUsage,
        authorityRef: string | null,
        taskRefsBefore: string[] = []
    ): AuthoringSessionLifecycleReceipt
    {
        this.revision += 1;
        const base = {
            schema: authoringSessionReceiptSchema,
            receiptRef: `session-receipt:${this.revision}`,
            action,
            registryEntryDigest: hosted.state.registryEntryDigest,
            editorSessionRef: hosted.state.editorSessionRef,
            documentId: hosted.state.identity.documentId,
            documentEpoch: hosted.state.documentContext.documentEpoch,
            snapshotRef: hosted.state.snapshot.snapshotRef,
            resourceBefore: cloneValue(resourceBefore),
            resourceAfter: cloneValue(hosted.state.resources),
            taskRefsBefore: [...taskRefsBefore].sort(),
            taskRefsAfter: [...hosted.tasks.keys()].sort(),
            stateBefore: stateBefore ?? stateAfter,
            stateAfter,
            restoreValidation: cloneValue(hosted.state.restoreValidation),
            editorContentDigest: hosted.state.snapshot.editorContentDigest,
            authorityRef
        };
        const receipt = {
            ...base,
            contentDigest: receiptDigest(base)
        };
        this.receipts.push(receipt);
        return cloneValue(receipt);
    }

    private assertAggregateBudget(): void
    {
        const aggregate = aggregateResources([...this.sessionsByRef.values()].map(hosted => hosted.state));
        const activeCount = [...this.sessionsByRef.values()]
            .filter(hosted => hosted.state.lifecycleState === 'active').length;
        if (
            activeCount > this.policy.maxActiveSessions
            || aggregate.editorInstances > this.policy.maxLiveEditorInstances
            || aggregate.renderers > this.policy.maxRenderers
            || aggregate.observers > this.policy.maxObservers
            || aggregate.timers > this.policy.maxTimers
            || aggregate.backgroundTasks > this.policy.maxBackgroundTasks
            || aggregate.networkRequests > this.policy.maxNetworkRequests
            || aggregate.memoryUnits > this.policy.maxMemoryUnits
        )
        {
            throw new Error('session-resource-budget-exceeded');
        }
    }

    private requireSession(editorSessionRef: string): HostedSession
    {
        const hosted = this.sessionsByRef.get(editorSessionRef);
        if (!hosted)
        {
            throw new Error('session-not-hosted');
        }
        return hosted;
    }

    private assertTick(tick: number): void
    {
        if (!Number.isSafeInteger(tick) || tick < 0)
        {
            throw new Error('session-recency-tick-invalid');
        }
    }
}

export function verifyAuthoringSessionHostState(state: AuthoringSessionHostState): boolean
{
    if (
        !hasExactKeys(state, [
            'schema',
            'revision',
            'resourcePolicy',
            'sessions',
            'receipts',
            'aggregateResources',
            'contentDigest'
        ])
        || !hasExactKeys(state.resourcePolicy, [
            'schema',
            'maxOpenSessions',
            'maxActiveSessions',
            'maxBackgroundRetainedSessions',
            'maxSuspendedSessions',
            'maxLiveEditorInstances',
            'maxRenderers',
            'maxObservers',
            'maxTimers',
            'maxBackgroundTasks',
            'maxNetworkRequests',
            'maxMemoryUnits',
            'priorityFacts',
            'prohibitedFacts'
        ])
        || !hasExactKeys(state.aggregateResources, [
            'editorInstances',
            'renderers',
            'observers',
            'timers',
            'backgroundTasks',
            'networkRequests',
            'memoryUnits'
        ])
        || state.schema !== authoringSessionHostSchema
        || !Number.isSafeInteger(state.revision)
        || state.revision < 0
        || state.revision !== state.receipts.length
        || !verifyResourcePolicy(state.resourcePolicy)
        || state.sessions.length > state.resourcePolicy.maxOpenSessions
        || !isDigest(state.contentDigest)
        || state.contentDigest !== calculateOpenArticleDocumentDigest(withoutDigest(state))
    )
    {
        return false;
    }

    const sessionRefs = new Set<string>();
    const identities = new Set<string>();
    let activeCount = 0;
    for (const session of state.sessions)
    {
        if (
            !hasExactKeys(session, [
                'registryEntryDigest',
                'identity',
                'editorSessionRef',
                'tabId',
                'owningGroupId',
                'documentContext',
                'permission',
                'lifecycle',
                'permissionRef',
                'lifecycleState',
                'blockReason',
                'risk',
                'snapshot',
                'resources',
                'taskRefs',
                'lastUsedTick',
                'restoreValidation',
                'contentDigest'
            ])
            || !hasExactKeys(session.identity, ['articleId', 'draftId', 'documentId'])
            || !hasExactKeys(session.documentContext, ['documentEpoch', 'sourceRevision', 'draftRevision'])
            || !hasExactKeys(session.risk, [
                'dirty',
                'saving',
                'conflict',
                'recovery',
                'pendingAttachments',
                'nearby'
            ])
            || !hasExactKeys(session.resources, [
                'editorInstances',
                'renderers',
                'observers',
                'timers',
                'backgroundTasks',
                'networkRequests',
                'memoryUnits'
            ])
            || !hasExactKeys(session.restoreValidation, [
                'status',
                'reason',
                'snapshotRef',
                'snapshotDigest',
                'identityValidated',
                'refsValidated'
            ])
            || !isDigest(session.registryEntryDigest)
            || !isStableRef(session.editorSessionRef)
            || sessionRefs.has(session.editorSessionRef)
            || identities.has(identityAuthorityKey(session.identity))
            || !verifyAuthoringSessionSnapshot(session.snapshot)
            || session.snapshot.editorSessionRef !== session.editorSessionRef
            || !sameIdentity(session.snapshot.identity, session.identity)
            || !isDigest(session.contentDigest)
            || session.contentDigest !== recordDigest(withoutDigest(session))
            || !Number.isSafeInteger(session.lastUsedTick)
            || session.lastUsedTick < 0
        )
        {
            return false;
        }
        sessionRefs.add(session.editorSessionRef);
        identities.add(identityAuthorityKey(session.identity));
        activeCount += Number(session.lifecycleState === 'active');
        if (
            session.lifecycleState !== 'active'
            && !isPausedUsage(session.resources)
        )
        {
            return false;
        }
        if (
            (session.lifecycleState === 'evicted-with-recoverable-state' || session.lifecycleState === 'closed')
            && Object.values(session.resources).some(value => value !== 0)
        )
        {
            return false;
        }
    }

    for (const receipt of state.receipts)
    {
        if (
            !hasExactKeys(receipt, [
                'schema',
                'receiptRef',
                'action',
                'registryEntryDigest',
                'editorSessionRef',
                'documentId',
                'documentEpoch',
                'snapshotRef',
                'resourceBefore',
                'resourceAfter',
                'taskRefsBefore',
                'taskRefsAfter',
                'stateBefore',
                'stateAfter',
                'restoreValidation',
                'editorContentDigest',
                'authorityRef',
                'contentDigest'
            ])
            || !hasExactKeys(receipt.resourceBefore, [
                'editorInstances',
                'renderers',
                'observers',
                'timers',
                'backgroundTasks',
                'networkRequests',
                'memoryUnits'
            ])
            || !hasExactKeys(receipt.resourceAfter, [
                'editorInstances',
                'renderers',
                'observers',
                'timers',
                'backgroundTasks',
                'networkRequests',
                'memoryUnits'
            ])
            || !hasExactKeys(receipt.restoreValidation, [
                'status',
                'reason',
                'snapshotRef',
                'snapshotDigest',
                'identityValidated',
                'refsValidated'
            ])
            || receipt.schema !== authoringSessionReceiptSchema
            || !isStableRef(receipt.receiptRef)
            || !isDigest(receipt.registryEntryDigest)
            || !isDigest(receipt.editorContentDigest)
            || !isDigest(receipt.contentDigest)
            || receipt.contentDigest !== receiptDigest(withoutDigest(receipt))
        )
        {
            return false;
        }
    }

    const aggregate = aggregateResources(state.sessions);
    return activeCount <= state.resourcePolicy.maxActiveSessions
        && calculateOpenArticleDocumentDigest(aggregate) === calculateOpenArticleDocumentDigest(state.aggregateResources)
        && aggregate.editorInstances <= state.resourcePolicy.maxLiveEditorInstances
        && aggregate.renderers <= state.resourcePolicy.maxRenderers
        && aggregate.observers <= state.resourcePolicy.maxObservers
        && aggregate.timers <= state.resourcePolicy.maxTimers
        && aggregate.backgroundTasks <= state.resourcePolicy.maxBackgroundTasks
        && aggregate.networkRequests <= state.resourcePolicy.maxNetworkRequests
        && aggregate.memoryUnits <= state.resourcePolicy.maxMemoryUnits;
}
