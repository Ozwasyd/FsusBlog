import { calculateOpenArticleDocumentDigest, type ArticleDocumentIdentity } from '@/services/authoring/openArticleDocumentRegistry';
export const authoringWorkspaceSnapshotContract = Object.freeze({
    schemaVersion: 1,
    workspaceId: 'default',
    sourceContract: 'fsusblog.authoring-workspace-snapshot.v1',
    maxTabs: 100,
    maxGroups: 2,
    maxBytes: 65536,
    maxDepth: 8
} as const);
export interface AuthoringWorkspaceSnapshotScope {
    userId: number;
    siteId: string;
}
export interface AuthoringWorkspaceSnapshotTab {
    tabId: string;
    identity: ArticleDocumentIdentity;
    isPreview: boolean;
    isPinned: boolean;
}
export interface AuthoringWorkspaceSnapshotGroup {
    groupId: string;
    tabIds: string[];
    activeTabId: string | null;
}
export interface AuthoringWorkspaceSnapshotShell {
    libraryOpen: boolean;
    libraryView: 'all' | 'recent' | 'pinned';
    outlineOpen: boolean;
    inspectorOpen: boolean;
    inspectorView: 'publish' | 'rights' | 'check' | 'preview' | 'versions' | 'resources';
}
export interface AuthoringWorkspaceSnapshotLayout {
    tabs: AuthoringWorkspaceSnapshotTab[];
    groups: AuthoringWorkspaceSnapshotGroup[];
    activeGroupId: string;
    splitRatioPermille: number;
    shell: AuthoringWorkspaceSnapshotShell;
}
export interface AuthoringWorkspaceSnapshot {
    schemaVersion: 1;
    workspaceId: 'default';
    scope: AuthoringWorkspaceSnapshotScope;
    sourceContract: typeof authoringWorkspaceSnapshotContract.sourceContract;
    sourceDigest: string;
    revision: number;
    updatedAt: number;
    layout: AuthoringWorkspaceSnapshotLayout;
    contentDigest: string;
}
export interface AuthoringWorkspaceSnapshotReceipt {
    schema: 'fsusblog.authoring-workspace-snapshot-receipt.v1';
    action: 'read' | 'write' | 'reset';
    status: 'current' | 'missing' | 'blocked' | 'applied' | 'conflict';
    reason: string | null;
    scope: AuthoringWorkspaceSnapshotScope;
    workspaceId: 'default';
    sourceDigest: string;
    revisionBefore: number;
    revisionAfter: number;
    tabCount: number;
    byteCount: number;
    inputDigest: string;
    snapshotDigest: string | null;
    contentDigest: string;
}
export interface AuthoringWorkspaceSnapshotResult {
    status: AuthoringWorkspaceSnapshotReceipt['status'];
    revision: number;
    snapshot: AuthoringWorkspaceSnapshot | null;
    receipt: AuthoringWorkspaceSnapshotReceipt;
}
export class AuthoringWorkspaceSnapshotError extends Error
{
    public readonly reason: string;
    public constructor(reason: string)
    {
        super(reason);
        this.reason = reason;
    }
}
export const workspaceSnapshotDigest = calculateOpenArticleDocumentDigest;
export const workspaceSnapshotId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u.test(value);
export const workspaceSnapshotHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const workspaceSnapshotInteger = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
export function workspaceSnapshotExact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown>
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype
        || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)))
    {
        throw new AuthoringWorkspaceSnapshotError('unknown_or_missing_field');
    }
}
export function workspaceSnapshotBytes(value: unknown): number
{
    return new TextEncoder().encode(JSON.stringify(value)).length;
}
export function freezeWorkspaceSnapshot<T>(value: T): T
{
    if (value && typeof value === 'object')
    {
        Object.values(value).forEach(freezeWorkspaceSnapshot);
        Object.freeze(value);
    }
    return value;
}
export function validateWorkspaceSnapshotScope(scope: AuthoringWorkspaceSnapshotScope): void
{
    workspaceSnapshotExact(scope, ['userId', 'siteId']);
    if (!workspaceSnapshotInteger(scope.userId, 1) || !workspaceSnapshotId(scope.siteId))
    {
        throw new AuthoringWorkspaceSnapshotError('invalid_scope');
    }
}
export function validateWorkspaceSnapshotLayout(value: unknown): asserts value is AuthoringWorkspaceSnapshotLayout
{
    workspaceSnapshotExact(value, ['tabs', 'groups', 'activeGroupId', 'splitRatioPermille', 'shell']);
    if (!Array.isArray(value.tabs) || value.tabs.length > authoringWorkspaceSnapshotContract.maxTabs
        || !Array.isArray(value.groups) || value.groups.length < 1 || value.groups.length > authoringWorkspaceSnapshotContract.maxGroups
        || !workspaceSnapshotInteger(value.splitRatioPermille) || value.splitRatioPermille < 200 || value.splitRatioPermille > 800)
    {
        throw new AuthoringWorkspaceSnapshotError('layout_budget_or_shape');
    }
    const tabIds = new Set<string>();
    const previewTabIds = new Set<string>();
    const articles = new Set<number>();
    const drafts = new Set<string>();
    const documents = new Set<string>();
    const tabs: unknown[] = value.tabs;
    const groups: unknown[] = value.groups;
    for (const tab of tabs)
    {
        workspaceSnapshotExact(tab, ['tabId', 'identity', 'isPreview', 'isPinned']);
        workspaceSnapshotExact(tab.identity, ['articleId', 'draftId', 'documentId']);
        const identity = tab.identity;
        if (!workspaceSnapshotId(tab.tabId) || tabIds.has(tab.tabId)
            || (identity.articleId !== null && !workspaceSnapshotInteger(identity.articleId, 1))
            || (typeof identity.articleId === 'number' && identity.articleId > 2147483647)
            || !workspaceSnapshotId(identity.draftId) || !workspaceSnapshotId(identity.documentId)
            || drafts.has(identity.draftId) || documents.has(identity.documentId)
            || (identity.articleId !== null && articles.has(identity.articleId))
            || typeof tab.isPreview !== 'boolean' || typeof tab.isPinned !== 'boolean' || tab.isPreview === tab.isPinned)
        {
            throw new AuthoringWorkspaceSnapshotError('duplicate_or_invalid_tab');
        }
        tabIds.add(tab.tabId);
        if (tab.isPreview)
        {
            previewTabIds.add(tab.tabId);
        }
        drafts.add(identity.draftId);
        documents.add(identity.documentId);
        if (typeof identity.articleId === 'number')
        {
            articles.add(identity.articleId);
        }
    }
    const groupIds = new Set<string>();
    const owned = new Set<string>();
    for (const group of groups)
    {
        workspaceSnapshotExact(group, ['groupId', 'tabIds', 'activeTabId']);
        if (!workspaceSnapshotId(group.groupId) || groupIds.has(group.groupId) || !Array.isArray(group.tabIds)
            || group.tabIds.length > authoringWorkspaceSnapshotContract.maxTabs
            || (group.tabIds.length === 0 ? group.activeTabId !== null : !group.tabIds.includes(group.activeTabId)))
        {
            throw new AuthoringWorkspaceSnapshotError('invalid_group');
        }
        groupIds.add(group.groupId);
        const groupTabIds: unknown[] = group.tabIds;
        for (const tabId of groupTabIds)
        {
            if (!workspaceSnapshotId(tabId) || !tabIds.has(tabId) || owned.has(tabId))
            {
                throw new AuthoringWorkspaceSnapshotError('orphan_or_mirrored_tab');
            }
            owned.add(tabId);
        }
        if (groupTabIds.filter(tabId => typeof tabId === 'string' && previewTabIds.has(tabId)).length > 1)
        {
            throw new AuthoringWorkspaceSnapshotError('multiple_previews');
        }
    }
    if (owned.size !== tabIds.size || !groupIds.has(value.activeGroupId as string))
    {
        throw new AuthoringWorkspaceSnapshotError('orphan_or_active_group');
    }
    workspaceSnapshotExact(value.shell, ['libraryOpen', 'libraryView', 'outlineOpen', 'inspectorOpen', 'inspectorView']);
    if (typeof value.shell.libraryOpen !== 'boolean' || typeof value.shell.outlineOpen !== 'boolean'
        || typeof value.shell.inspectorOpen !== 'boolean' || !['all', 'recent', 'pinned'].includes(value.shell.libraryView as string)
        || !['publish', 'rights', 'check', 'preview', 'versions', 'resources'].includes(value.shell.inspectorView as string))
    {
        throw new AuthoringWorkspaceSnapshotError('invalid_shell');
    }
    if (workspaceSnapshotBytes(value) > authoringWorkspaceSnapshotContract.maxBytes)
    {
        throw new AuthoringWorkspaceSnapshotError('oversize');
    }
}
export function defaultWorkspaceSnapshotLayout(): AuthoringWorkspaceSnapshotLayout
{
    return {
        tabs: [], groups: [{ groupId: 'group:primary', tabIds: [], activeTabId: null }],
        activeGroupId: 'group:primary', splitRatioPermille: 500,
        shell: { libraryOpen: true, libraryView: 'all', outlineOpen: false, inspectorOpen: false, inspectorView: 'publish' }
    };
}
export function validateWorkspaceSnapshot(value: unknown, scope: AuthoringWorkspaceSnapshotScope, sourceDigest: string, now: number): asserts value is AuthoringWorkspaceSnapshot
{
    validateWorkspaceSnapshotScope(scope);
    workspaceSnapshotExact(value, ['schemaVersion', 'workspaceId', 'scope', 'sourceContract', 'sourceDigest', 'revision', 'updatedAt', 'layout', 'contentDigest']);
    if (value.schemaVersion !== authoringWorkspaceSnapshotContract.schemaVersion)
    {
        throw new AuthoringWorkspaceSnapshotError(typeof value.schemaVersion === 'number' && value.schemaVersion > 1 ? 'future_schema' : 'unsupported_schema');
    }
    validateWorkspaceSnapshotScope(value.scope as AuthoringWorkspaceSnapshotScope);
    if (value.workspaceId !== 'default' || workspaceSnapshotDigest(value.scope) !== workspaceSnapshotDigest(scope)
        || value.sourceContract !== authoringWorkspaceSnapshotContract.sourceContract || value.sourceDigest !== sourceDigest
        || !workspaceSnapshotHash(sourceDigest))
    {
        throw new AuthoringWorkspaceSnapshotError('identity_or_source_mismatch');
    }
    validateWorkspaceSnapshotLayout(value.layout);
    const { contentDigest, ...unsigned } = value;
    if (!workspaceSnapshotInteger(value.revision, 1) || !workspaceSnapshotInteger(value.updatedAt, 1)
        || value.updatedAt > now || !workspaceSnapshotHash(contentDigest) || workspaceSnapshotDigest(unsigned) !== contentDigest)
    {
        throw new AuthoringWorkspaceSnapshotError('digest_or_revision_mismatch');
    }
    if (workspaceSnapshotBytes(value) > authoringWorkspaceSnapshotContract.maxBytes)
    {
        throw new AuthoringWorkspaceSnapshotError('oversize');
    }
}
// Process-local provenance is issued only after a response from the authenticated server port is verified.
// Cache/imported JSON, a cloned observation or a recomputed hash cannot mint this capability.
const serverObservations = new WeakSet<object>();
export type AuthoringWorkspaceServerObservation = Readonly<AuthoringWorkspaceSnapshotResult>;
export function requireWorkspaceServerObservation(value: AuthoringWorkspaceServerObservation): void
{
    if (!serverObservations.has(value))
    {
        throw new AuthoringWorkspaceSnapshotError('server_observation_required');
    }
}
/// Integration owner binds this port to session/PoW-protected typed AEDS v2. There is no default/local/JSON transport.
export interface AuthoringWorkspaceSnapshotTransport {
    read(signal?: AbortSignal): Promise<unknown>;
    write(command: {
        expectedRevision: number;
        layout: AuthoringWorkspaceSnapshotLayout;
    }, signal?: AbortSignal): Promise<unknown>;
    reset(command: {
        expectedRevision: number;
        confirmationDigest: string;
    }, signal?: AbortSignal): Promise<unknown>;
}
export class AuthoringWorkspaceSnapshotApi
{
    private latestObservation: AuthoringWorkspaceServerObservation | null = null;
    private lifecycleGeneration = 0;
    private readSequence = 0;
    private readonly transport: AuthoringWorkspaceSnapshotTransport;
    private readonly now: () => number;
    public readonly scope: AuthoringWorkspaceSnapshotScope;
    public readonly sourceDigest: string;
    public constructor(transport: AuthoringWorkspaceSnapshotTransport, scope: AuthoringWorkspaceSnapshotScope, sourceDigest: string, now: () => number = Date.now)
    {
        this.transport = transport;
        this.sourceDigest = sourceDigest;
        this.now = now;
        validateWorkspaceSnapshotScope(scope);
        if (!workspaceSnapshotHash(sourceDigest))
        {
            throw new AuthoringWorkspaceSnapshotError('invalid_source_digest');
        }
        this.scope = freezeWorkspaceSnapshot(structuredClone(scope));
    }
    public async read(signal?: AbortSignal): Promise<AuthoringWorkspaceServerObservation>
    {
        const generation = this.lifecycleGeneration;
        const ticket = ++this.readSequence;
        const raw = await this.transport.read(signal);
        this.checkLifecycle(generation, signal);
        if (ticket !== this.readSequence)
        {
            // Reject an older request before verification can revoke a newer observation at the same revision.
            throw new AuthoringWorkspaceSnapshotError('server_read_superseded');
        }
        return this.verify(raw, 'read', workspaceSnapshotDigest(this.scope));
    }
    public invalidateObservations(): void
    {
        this.lifecycleGeneration++;
        this.readSequence++;
        if (this.latestObservation)
        {
            serverObservations.delete(this.latestObservation);
        }
        this.latestObservation = null;
    }
    public async write(expectedRevision: number, layout: AuthoringWorkspaceSnapshotLayout, signal?: AbortSignal): Promise<AuthoringWorkspaceServerObservation>
    {
        this.expectedRevision(expectedRevision);
        validateWorkspaceSnapshotLayout(layout);
        const command = structuredClone({ expectedRevision, layout });
        const inputDigest = workspaceSnapshotDigest(command);
        const generation = this.lifecycleGeneration;
        this.readSequence++;
        const raw = await this.transport.write(command, signal);
        this.checkLifecycle(generation, signal);
        const verified = this.verify(raw, 'write', inputDigest, expectedRevision, command.layout);
        this.readSequence++;
        return verified;
    }
    public resetConfirmation(expectedRevision: number): string
    {
        this.expectedRevision(expectedRevision);
        return workspaceSnapshotDigest({ action: 'reset-default-layout', scope: this.scope, workspaceId: 'default', expectedRevision, sourceDigest: this.sourceDigest });
    }
    public async reset(expectedRevision: number, confirmationDigest: string, signal?: AbortSignal): Promise<AuthoringWorkspaceServerObservation>
    {
        if (confirmationDigest !== this.resetConfirmation(expectedRevision))
        {
            throw new AuthoringWorkspaceSnapshotError('reset_confirmation_mismatch');
        }
        const layout = defaultWorkspaceSnapshotLayout();
        const generation = this.lifecycleGeneration;
        this.readSequence++;
        const raw = await this.transport.reset({ expectedRevision, confirmationDigest }, signal);
        this.checkLifecycle(generation, signal);
        const verified = this.verify(raw, 'reset', workspaceSnapshotDigest({ expectedRevision, layout }), expectedRevision, layout);
        this.readSequence++;
        return verified;
    }
    private expectedRevision(revision: number): void
    {
        if (!workspaceSnapshotInteger(revision) || revision === Number.MAX_SAFE_INTEGER)
        {
            throw new AuthoringWorkspaceSnapshotError('invalid_expected_revision');
        }
    }
    private checkLifecycle(generation: number, signal?: AbortSignal): void
    {
        signal?.throwIfAborted();
        if (generation !== this.lifecycleGeneration)
        {
            throw new AuthoringWorkspaceSnapshotError('server_observation_superseded');
        }
    }
    private verify(raw: unknown, action: AuthoringWorkspaceSnapshotReceipt['action'], inputDigest: string, expectedRevision?: number, requestedLayout?: AuthoringWorkspaceSnapshotLayout): AuthoringWorkspaceServerObservation
    {
        workspaceSnapshotExact(raw, ['status', 'revision', 'snapshot', 'receipt']);
        workspaceSnapshotExact(raw.receipt, ['schema', 'action', 'status', 'reason', 'scope', 'workspaceId', 'sourceDigest', 'revisionBefore', 'revisionAfter', 'tabCount', 'byteCount', 'inputDigest', 'snapshotDigest', 'contentDigest']);
        const r = raw.receipt;
        validateWorkspaceSnapshotScope(r.scope as AuthoringWorkspaceSnapshotScope);
        const result = raw as unknown as AuthoringWorkspaceSnapshotResult;
        if (r.schema !== 'fsusblog.authoring-workspace-snapshot-receipt.v1' || r.action !== action || r.status !== raw.status
            || r.workspaceId !== 'default' || r.sourceDigest !== this.sourceDigest
            || workspaceSnapshotDigest(r.scope) !== workspaceSnapshotDigest(this.scope)
            || r.inputDigest !== inputDigest || !workspaceSnapshotInteger(raw.revision)
            || r.revisionAfter !== raw.revision || !workspaceSnapshotInteger(r.revisionBefore)
            || !workspaceSnapshotInteger(r.tabCount) || !workspaceSnapshotInteger(r.byteCount)
            || !(r.reason === null || workspaceSnapshotId(r.reason)))
        {
            throw new AuthoringWorkspaceSnapshotError('invalid_server_receipt');
        }
        const { contentDigest, ...unsigned } = r;
        if (workspaceSnapshotDigest({ ...unsigned, contentDigest: '' }) !== contentDigest)
        {
            throw new AuthoringWorkspaceSnapshotError('receipt_digest_mismatch');
        }
        const snapshotRequired = raw.status === 'current' || raw.status === 'applied';
        if (snapshotRequired)
        {
            validateWorkspaceSnapshot(raw.snapshot, this.scope, this.sourceDigest, this.now());
            if (raw.snapshot.revision !== raw.revision || r.snapshotDigest !== raw.snapshot.contentDigest
                || r.tabCount !== raw.snapshot.layout.tabs.length || r.byteCount !== workspaceSnapshotBytes(raw.snapshot)
                || r.reason !== null)
            {
                throw new AuthoringWorkspaceSnapshotError('invalid_server_receipt');
            }
        }
        else if (raw.snapshot !== null || r.snapshotDigest !== null || r.tabCount !== 0 || r.byteCount !== 0)
        {
            throw new AuthoringWorkspaceSnapshotError('invalid_server_receipt');
        }
        if (action === 'read')
        {
            if (!['current', 'missing', 'blocked'].includes(result.status) || r.revisionBefore !== raw.revision
                || (raw.status === 'missing' && (raw.revision !== 0 || r.reason !== null)))
            {
                throw new AuthoringWorkspaceSnapshotError('invalid_server_receipt');
            }
        }
        else if (!['applied', 'conflict'].includes(result.status)
            || (raw.status === 'applied' && (r.revisionBefore !== expectedRevision || raw.revision !== expectedRevision + 1
                || workspaceSnapshotDigest(result.snapshot!.layout) !== workspaceSnapshotDigest(requestedLayout)))
            || (raw.status === 'conflict' && r.revisionBefore !== raw.revision))
        {
            throw new AuthoringWorkspaceSnapshotError('invalid_server_receipt');
        }
        if (this.latestObservation && result.revision < this.latestObservation.revision)
        {
            throw new AuthoringWorkspaceSnapshotError('stale_server_response');
        }
        if (this.latestObservation)
        {
            serverObservations.delete(this.latestObservation);
        }
        const verified = freezeWorkspaceSnapshot(structuredClone(result));
        serverObservations.add(verified);
        this.latestObservation = verified;
        return verified;
    }
}
