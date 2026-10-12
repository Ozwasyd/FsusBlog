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
        shell: { libraryOpen: true, libraryView: 'all', outlineOpen: true, inspectorOpen: false, inspectorView: 'publish' }
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
const serverObservations = new WeakMap<object, () => void>();
export type AuthoringWorkspaceServerObservation = Readonly<AuthoringWorkspaceSnapshotResult>;
export function requireWorkspaceServerObservation(value: AuthoringWorkspaceServerObservation): void
{
    const assertCurrent = serverObservations.get(value);
    if (!assertCurrent)
    {
        throw new AuthoringWorkspaceSnapshotError('server_observation_required');
    }
    assertCurrent();
    if (serverObservations.get(value) !== assertCurrent)
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
    readonly #readTransport: AuthoringWorkspaceSnapshotTransport['read'];
    readonly #writeTransport: AuthoringWorkspaceSnapshotTransport['write'];
    readonly #resetTransport: AuthoringWorkspaceSnapshotTransport['reset'];
    readonly #scope: AuthoringWorkspaceSnapshotScope;
    readonly #sourceDigest: string;
    readonly #now: () => number;
    readonly #assertConnection: (() => void) | undefined;
    #latestObservation: AuthoringWorkspaceServerObservation | null = null;
    #lifecycleGeneration = 0;
    #readSequence = 0;
    #closed = false;
    public constructor(transport: AuthoringWorkspaceSnapshotTransport, scope: AuthoringWorkspaceSnapshotScope, sourceDigest: string, now: () => number = Date.now, assertConnection?: () => void)
    {
        if (new.target !== AuthoringWorkspaceSnapshotApi)
        {
            throw new AuthoringWorkspaceSnapshotError('workspace_snapshot_api_owner_required');
        }
        this.#assertConnection = assertConnection;
        const generation = this.#lifecycleGeneration;
        this.#checkLifecycle(generation);
        this.#external(() => validateWorkspaceSnapshotScope(scope), generation);
        if (!workspaceSnapshotHash(sourceDigest))
        {
            throw new AuthoringWorkspaceSnapshotError('invalid_source_digest');
        }
        this.#scope = this.#external(() => freezeWorkspaceSnapshot(structuredClone(scope)), generation);
        this.#sourceDigest = sourceDigest;
        this.#now = now;
        this.#readTransport = this.#external(() => transport.read.bind(transport), generation);
        this.#writeTransport = this.#external(() => transport.write.bind(transport), generation);
        this.#resetTransport = this.#external(() => transport.reset.bind(transport), generation);
        Object.freeze(this);
        this.#checkLifecycle(generation);
    }
    public get scope(): AuthoringWorkspaceSnapshotScope
    {
        return this.#scope;
    }
    public get sourceDigest(): string
    {
        return this.#sourceDigest;
    }
    public async read(signal?: AbortSignal): Promise<AuthoringWorkspaceServerObservation>
    {
        const generation = this.#lifecycleGeneration;
        const ticket = ++this.#readSequence;
        const raw = await this.#request(() => this.#readTransport(signal), generation, signal, ticket);
        return this.#verify(raw, 'read', workspaceSnapshotDigest(this.#scope), generation, signal, ticket);
    }
    public invalidateObservations(): void
    {
        this.#revoke();
    }
    public close(): void
    {
        this.#close();
    }
    #close(): void
    {
        if (!this.#closed)
        {
            this.#closed = true;
            this.#revoke();
        }
    }
    public async write(expectedRevision: number, layout: AuthoringWorkspaceSnapshotLayout, signal?: AbortSignal): Promise<AuthoringWorkspaceServerObservation>
    {
        const generation = this.#lifecycleGeneration;
        this.#checkLifecycle(generation, signal);
        this.#expectedRevision(expectedRevision);
        this.#external(() => validateWorkspaceSnapshotLayout(layout), generation, signal);
        const command = this.#external(() => structuredClone({ expectedRevision, layout }), generation, signal);
        // Validate the owned copy too: caller accessors cannot change the validated proposal during cloning.
        this.#external(() => validateWorkspaceSnapshotLayout(command.layout), generation, signal);
        const inputDigest = workspaceSnapshotDigest(command);
        const raw = await this.#request(() =>
        {
            // Admission has completed; no callback separates this barrier from actual dispatch.
            this.#readSequence++;
            return this.#writeTransport(command, signal);
        }, generation, signal);
        const verified = this.#verify(raw, 'write', inputDigest, generation, signal, undefined, expectedRevision, command.layout);
        // Reads started before this verified CAS settlement must refresh after the barrier.
        this.#readSequence++;
        return verified;
    }
    public resetConfirmation(expectedRevision: number): string
    {
        const generation = this.#lifecycleGeneration;
        const ticket = this.#readSequence;
        this.#checkLifecycle(generation, undefined, ticket);
        this.#expectedRevision(expectedRevision);
        const result = workspaceSnapshotDigest({ action: 'reset-default-layout', scope: this.#scope, workspaceId: 'default', expectedRevision, sourceDigest: this.#sourceDigest });
        this.#checkLifecycle(generation, undefined, ticket);
        return result;
    }
    public async reset(expectedRevision: number, confirmationDigest: string, signal?: AbortSignal): Promise<AuthoringWorkspaceServerObservation>
    {
        const generation = this.#lifecycleGeneration;
        this.#checkLifecycle(generation, signal);
        this.#expectedRevision(expectedRevision);
        const expectedConfirmation = workspaceSnapshotDigest({ action: 'reset-default-layout', scope: this.#scope, workspaceId: 'default', expectedRevision, sourceDigest: this.#sourceDigest });
        if (confirmationDigest !== expectedConfirmation)
        {
            throw new AuthoringWorkspaceSnapshotError('reset_confirmation_mismatch');
        }
        const layout = defaultWorkspaceSnapshotLayout();
        const raw = await this.#request(() =>
        {
            // Rejected input/confirmation/cancellation cannot disturb unrelated pending reads.
            this.#readSequence++;
            return this.#resetTransport({ expectedRevision, confirmationDigest }, signal);
        }, generation, signal);
        const verified = this.#verify(raw, 'reset', workspaceSnapshotDigest({ expectedRevision, layout }), generation, signal, undefined, expectedRevision, layout);
        // Reads started before this verified CAS settlement must refresh after the barrier.
        this.#readSequence++;
        return verified;
    }
    #revoke(): void
    {
        this.#lifecycleGeneration++;
        this.#readSequence++;
        if (this.#latestObservation)
        {
            serverObservations.delete(this.#latestObservation);
        }
        this.#latestObservation = null;
    }
    #expectedRevision(revision: number): void
    {
        if (!workspaceSnapshotInteger(revision) || revision === Number.MAX_SAFE_INTEGER)
        {
            throw new AuthoringWorkspaceSnapshotError('invalid_expected_revision');
        }
    }
    #requireLifecycle(generation: number, ticket?: number): void
    {
        if (this.#closed)
        {
            throw new AuthoringWorkspaceSnapshotError('workspace_snapshot_connection_closed');
        }
        if (generation !== this.#lifecycleGeneration)
        {
            throw new AuthoringWorkspaceSnapshotError('server_observation_superseded');
        }
        if (ticket !== undefined && ticket !== this.#readSequence)
        {
            throw new AuthoringWorkspaceSnapshotError('server_read_superseded');
        }
    }
    #checkLifecycle(generation: number, signal?: AbortSignal, ticket?: number): void
    {
        this.#requireLifecycle(generation, ticket);
        signal?.throwIfAborted();
        this.#requireLifecycle(generation, ticket);
        try
        {
            this.#assertConnection?.();
        }
        catch (error)
        {
            this.#close();
            throw error;
        }
        this.#requireLifecycle(generation, ticket);
        signal?.throwIfAborted();
        this.#requireLifecycle(generation, ticket);
    }
    #external<T>(operation: () => T, generation: number, signal?: AbortSignal, ticket?: number): T
    {
        this.#checkLifecycle(generation, signal, ticket);
        let result: T;
        try
        {
            result = operation();
        }
        catch (error)
        {
            this.#checkLifecycle(generation, signal, ticket);
            throw error;
        }
        this.#checkLifecycle(generation, signal, ticket);
        return result;
    }
    async #request(operation: () => Promise<unknown>, generation: number, signal: AbortSignal | undefined, ticket?: number): Promise<unknown>
    {
        const pending = this.#external(operation, generation, signal, ticket);
        let raw: unknown;
        try
        {
            raw = await pending;
        }
        catch (error)
        {
            this.#checkLifecycle(generation, signal, ticket);
            throw error;
        }
        this.#checkLifecycle(generation, signal, ticket);
        return raw;
    }
    #verify(raw: unknown, action: AuthoringWorkspaceSnapshotReceipt['action'], inputDigest: string, generation: number, signal: AbortSignal | undefined, ticket: number | undefined, expectedRevision?: number, requestedLayout?: AuthoringWorkspaceSnapshotLayout): AuthoringWorkspaceServerObservation
    {
        const result = this.#external(() => this.#validate(raw, action, inputDigest, generation, signal, ticket, expectedRevision, requestedLayout), generation, signal, ticket);
        const verified = this.#external(() => freezeWorkspaceSnapshot(structuredClone(result)), generation, signal, ticket);
        // Recheck the owned copy; neither accessors nor cloning can substitute an unvalidated receipt.
        this.#external(() => this.#validate(verified, action, inputDigest, generation, signal, ticket, expectedRevision, requestedLayout), generation, signal, ticket);
        this.#checkLifecycle(generation, signal, ticket);
        if (this.#latestObservation && verified.revision < this.#latestObservation.revision)
        {
            throw new AuthoringWorkspaceSnapshotError('stale_server_response');
        }
        // No callbacks/await occur between the final live check and original custody publication.
        if (this.#latestObservation)
        {
            serverObservations.delete(this.#latestObservation);
        }
        serverObservations.set(verified, () => this.#checkLifecycle(generation));
        this.#latestObservation = verified;
        return verified;
    }
    #validate(raw: unknown, action: AuthoringWorkspaceSnapshotReceipt['action'], inputDigest: string, generation: number, signal: AbortSignal | undefined, ticket: number | undefined, expectedRevision?: number, requestedLayout?: AuthoringWorkspaceSnapshotLayout): AuthoringWorkspaceSnapshotResult
    {
        workspaceSnapshotExact(raw, ['status', 'revision', 'snapshot', 'receipt']);
        workspaceSnapshotExact(raw.receipt, ['schema', 'action', 'status', 'reason', 'scope', 'workspaceId', 'sourceDigest', 'revisionBefore', 'revisionAfter', 'tabCount', 'byteCount', 'inputDigest', 'snapshotDigest', 'contentDigest']);
        const r = raw.receipt;
        validateWorkspaceSnapshotScope(r.scope as AuthoringWorkspaceSnapshotScope);
        const result = raw as unknown as AuthoringWorkspaceSnapshotResult;
        if (r.schema !== 'fsusblog.authoring-workspace-snapshot-receipt.v1' || r.action !== action || r.status !== raw.status
            || r.workspaceId !== 'default' || r.sourceDigest !== this.#sourceDigest
            || workspaceSnapshotDigest(r.scope) !== workspaceSnapshotDigest(this.#scope)
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
            validateWorkspaceSnapshot(raw.snapshot, this.#scope, this.#sourceDigest, this.#external(this.#now, generation, signal, ticket));
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
        return result;
    }
}
Object.freeze(AuthoringWorkspaceSnapshotApi.prototype);
