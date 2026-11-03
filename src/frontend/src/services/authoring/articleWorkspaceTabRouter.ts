import {
    AuthoringSessionHost,
    type AuthoringSessionLifecycleReceipt
} from './authoringSessionHost';
import {
    calculateOpenArticleDocumentDigest,
    OpenArticleDocumentRegistry,
    openArticleDocumentCommandSchema,
    type ArticleDocumentContextRef,
    type ArticleDocumentIdentity,
    type ArticleWorkspaceStatusSummary,
    type OpenArticleDocumentCommandResult,
    type OpenArticleDocumentEntry
} from './openArticleDocumentRegistry';

export type { ArticleWorkspaceStatusSummary } from './openArticleDocumentRegistry';

export const articleWorkspaceTabRouterSchema = 'fsusblog.article-workspace-tab-router.v1' as const;
export const articleWorkspaceSessionReceiptSchema = 'fsusblog.article-workspace-session-receipt.v1' as const;

const digestPattern = /^[a-f0-9]{64}$/u;
const stableIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u;

export type ArticleWorkspaceEntrypoint =
    | 'rail'
    | 'quick-switcher'
    | 'internal-link'
    | 'recent-restore'
    | 'direct-route';

export type ArticleWorkspaceSessionState = 'pending' | 'ready' | 'blocked';

export type ArticleWorkspaceRouterAction =
    | 'open-or-activate'
    | 'activate'
    | 'promote-preview'
    | 'set-pin-state'
    | 'request-close'
    | 'sync-route'
    | 'route-update'
    | 'mark-status'
    | 'stale-update';

export interface ArticleWorkspaceRouteLocation {
    name?: string | null;
    path: string;
    fullPath?: string;
    articleId?: number | null;
}

export interface ArticleWorkspaceTabPresentation {
    tabId: string;
    articleId: number | null;
    draftId: string;
    documentId: string;
    editorSessionRef: string;
    owningGroupId: string;
    title: string;
    isPreview: boolean;
    isPinned: boolean;
    isActive: boolean;
    status: ArticleWorkspaceStatusSummary;
    sessionState: ArticleWorkspaceSessionState;
    registryRevision: number;
    contentDigest: string;
}

export interface ArticleWorkspaceSessionReceipt {
    schema: typeof articleWorkspaceSessionReceiptSchema;
    receiptRef: string;
    tabId: string;
    editorSessionRef: string;
    registryRevision: number;
    status: Exclude<ArticleWorkspaceSessionState, 'pending'>;
    reason: string | null;
    contentDigest: string;
}

export interface ArticleWorkspaceRouterReceipt {
    schema: typeof articleWorkspaceTabRouterSchema;
    receiptRef: string;
    action: ArticleWorkspaceRouterAction;
    entrypoint: ArticleWorkspaceEntrypoint | 'tab' | 'router' | 'status';
    origin: 'user' | 'route' | 'registry';
    generation: number;
    registryRevision: number;
    route: string | null;
    tabId: string | null;
    editorSessionRef: string | null;
    resultStatus: OpenArticleDocumentCommandResult['status'] | 'ignored' | 'blocked' | 'stale';
    sessionState: ArticleWorkspaceSessionState | null;
    sessionReceiptRef: string | null;
    reason: string | null;
    contentDigest: string;
}

export interface ArticleWorkspaceOpenInput {
    identity: ArticleDocumentIdentity;
    documentContext: ArticleDocumentContextRef;
    title: string;
    status: ArticleWorkspaceStatusSummary;
    targetGroupId: string;
    tabKind: 'preview' | 'pinned';
    entrypoint: ArticleWorkspaceEntrypoint;
    intent?: 'workspace' | 'browser-new-tab';
    route?: string | null;
}

export interface ArticleWorkspaceNavigationPort {
    currentFullPath: string;
    push(location: string): Promise<unknown>;
}

export interface ArticleWorkspaceSessionPort {
    waitForReady(entry: OpenArticleDocumentEntry): Promise<ArticleWorkspaceSessionReceipt>;
}

export interface ArticleWorkspacePresentationUpdate {
    title?: string;
    registryRevision?: number;
}

const cleanSessionReceipt = (entry: OpenArticleDocumentEntry): ArticleWorkspaceSessionReceipt =>
{
    const base = {
        schema: articleWorkspaceSessionReceiptSchema,
        receiptRef: `session-ready:${entry.tabId}:${entry.lifecycleRevision}`,
        tabId: entry.tabId,
        editorSessionRef: entry.editorSessionRef,
        registryRevision: entry.lifecycleRevision,
        status: 'ready' as const,
        reason: null
    };
    return {
        ...base,
        contentDigest: calculateOpenArticleDocumentDigest(base)
    };
};

const immediateSessionPort: ArticleWorkspaceSessionPort = {
    waitForReady: async (entry) => cleanSessionReceipt(entry)
};

function cloneValue<T>(value: T): T
{
    return structuredClone(value);
}

function identityProjectionKey(identity: ArticleDocumentIdentity): string
{
    return identity.articleId === null
        ? `draft:${identity.draftId}`
        : `article:${identity.articleId}`;
}

function stableRef(prefix: string, value: unknown): string
{
    return `${prefix}:${calculateOpenArticleDocumentDigest(value).slice(0, 24)}`;
}

function titleFallback(entry: OpenArticleDocumentEntry): string
{
    return entry.identity.articleId === null
        ? '新文章'
        : `文章 ${entry.identity.articleId}`;
}

function statusRefFor(identity: ArticleDocumentIdentity): string
{
    return stableRef('status', identityProjectionKey(identity));
}

function sessionBindingDigest(entry: OpenArticleDocumentEntry): string
{
    return calculateOpenArticleDocumentDigest({
        identity: entry.identity,
        documentContext: entry.documentContext,
        editorSessionRef: entry.editorSessionRef,
        tabId: entry.tabId,
        owningGroupId: entry.owningGroupId,
        status: entry.status
    });
}

function makeReceiptBase(
    value: Omit<ArticleWorkspaceRouterReceipt, 'contentDigest'>
): ArticleWorkspaceRouterReceipt
{
    return {
        ...value,
        contentDigest: calculateOpenArticleDocumentDigest(value)
    };
}

function isValidSessionReceipt(value: unknown): value is ArticleWorkspaceSessionReceipt
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }

    const record = value as Record<string, unknown>;
    const keys = [
        'schema',
        'receiptRef',
        'tabId',
        'editorSessionRef',
        'registryRevision',
        'status',
        'reason',
        'contentDigest'
    ].sort();
    const actual = Object.keys(record).sort();
    if (actual.length !== keys.length || !actual.every((key, index) => key === keys[index]))
    {
        return false;
    }

    if (
        record.schema !== articleWorkspaceSessionReceiptSchema
        || typeof record.receiptRef !== 'string'
        || !stableIdPattern.test(record.receiptRef)
        || typeof record.tabId !== 'string'
        || !stableIdPattern.test(record.tabId)
        || typeof record.editorSessionRef !== 'string'
        || !stableIdPattern.test(record.editorSessionRef)
        || !Number.isSafeInteger(record.registryRevision)
        || Number(record.registryRevision) < 0
        || !['ready', 'blocked'].includes(String(record.status))
        || (record.reason !== null && typeof record.reason !== 'string')
        || typeof record.contentDigest !== 'string'
        || !digestPattern.test(record.contentDigest)
    )
    {
        return false;
    }

    const { contentDigest, ...base } = value as ArticleWorkspaceSessionReceipt;
    return calculateOpenArticleDocumentDigest(base) === contentDigest;
}

/**
 * The immediate adapter only acknowledges that the registry reference is
 * available. A real editor/session host can be installed by the composition
 * root through `setSessionPort`; this coordinator never creates an editor or
 * copies document state as a fallback.
 */
export class ArticleWorkspaceTabRouter
{
    private readonly registry: OpenArticleDocumentRegistry;
    private readonly presentationsByTabId = new Map<string, ArticleWorkspaceTabPresentation>();
    private readonly sessionReceiptsByTabId = new Map<string, ArticleWorkspaceSessionReceipt>();
    private readonly listeners = new Set<() => void>();
    private sessionPort: ArticleWorkspaceSessionPort = immediateSessionPort;
    private commandSequence = 0;
    private generation = 0;
    private pendingRoute: { generation: number; route: string; tabId: string; } | null = null;

    public constructor(registry = new OpenArticleDocumentRegistry())
    {
        this.registry = registry;
    }

    public subscribe(listener: () => void): () => void
    {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public setSessionPort(port: ArticleWorkspaceSessionPort): void
    {
        this.sessionPort = port;
    }

    public getRevision(): number
    {
        return this.registry.getRevision();
    }

    public getRegistry(): OpenArticleDocumentRegistry
    {
        return this.registry;
    }

    public listTabs(): ArticleWorkspaceTabPresentation[]
    {
        return this.registry.listEntries().map((entry) => {
            const presentation = this.presentationsByTabId.get(entry.tabId);
            return {
                tabId: entry.tabId,
                articleId: entry.identity.articleId,
                draftId: entry.identity.draftId,
                documentId: entry.identity.documentId,
                editorSessionRef: entry.editorSessionRef,
                owningGroupId: entry.owningGroupId,
                title: presentation?.title || titleFallback(entry),
                isPreview: entry.isPreview,
                isPinned: entry.isPinned,
                isActive: entry.isActive,
                status: cloneValue(entry.status),
                sessionState: this.sessionReceiptsByTabId.get(entry.tabId)?.status
                    ?? presentation?.sessionState
                    ?? 'pending',
                registryRevision: this.registry.getRevision(),
                contentDigest: entry.contentDigest
            } satisfies ArticleWorkspaceTabPresentation;
        });
    }

    public getTab(tabId: string): ArticleWorkspaceTabPresentation | null
    {
        return this.listTabs().find((tab) => tab.tabId === tabId) ?? null;
    }

    public getActiveTab(): ArticleWorkspaceTabPresentation | null
    {
        return this.listTabs().find((tab) => tab.isActive) ?? null;
    }

    public async openOrActivate(input: ArticleWorkspaceOpenInput): Promise<ArticleWorkspaceRouterReceipt>
    {
        const commandNumber = ++this.commandSequence;
        const commandBase = {
            schema: openArticleDocumentCommandSchema,
            kind: 'open-or-activate' as const,
            commandId: `workspace-command:${commandNumber}`,
            idempotencyKey: `workspace-idempotency:${commandNumber}`,
            expectedRevision: this.registry.getRevision(),
            intent: input.intent ?? 'workspace',
            entrypoint: input.entrypoint,
            identity: cloneValue(input.identity),
            documentContext: cloneValue(input.documentContext),
            editorSessionRef: stableRef('session', identityProjectionKey(input.identity)),
            tabId: stableRef('tab', identityProjectionKey(input.identity)),
            targetGroupId: input.targetGroupId,
            tabKind: input.tabKind,
            status: cloneValue(input.status),
            lastActiveAnchorRef: null
        };
        const result = this.registry.execute(commandBase);
        if (result.status === 'ignored-browser-new-tab')
        {
            return this.receipt({
                action: 'open-or-activate',
                entrypoint: input.entrypoint,
                origin: 'user',
                route: input.route ?? null,
                tabId: null,
                editorSessionRef: null,
                resultStatus: result.status,
                sessionState: null,
                sessionReceiptRef: null,
                reason: 'browser-new-tab-is-not-an-application-session'
            });
        }

        const entry = result.entryAfter ?? (result.tabId ? this.registry.getEntry(result.tabId) : null);
        if (!entry || (result.status !== 'applied' && result.status !== 'activated-existing' && result.status !== 'replayed'))
        {
            return this.receipt({
                action: 'open-or-activate',
                entrypoint: input.entrypoint,
                origin: 'user',
                route: input.route ?? null,
                tabId: result.tabId,
                editorSessionRef: result.editorSessionRef,
                resultStatus: result.status,
                sessionState: result.status === 'rejected-state' ? 'blocked' : null,
                sessionReceiptRef: null,
                reason: result.reason
            });
        }

        if (result.replacedPreviewTabId)
        {
            this.presentationsByTabId.delete(result.replacedPreviewTabId);
            this.sessionReceiptsByTabId.delete(result.replacedPreviewTabId);
        }
        this.updatePresentationFromEntry(entry, input.title);
        this.notify();
        const session = await this.waitForSession(entry);
        this.notify();
        return this.receipt({
            action: 'open-or-activate',
            entrypoint: input.entrypoint,
            origin: 'user',
            route: input.route ?? null,
            tabId: entry.tabId,
            editorSessionRef: entry.editorSessionRef,
            resultStatus: result.status,
            sessionState: session.status,
            sessionReceiptRef: session.receiptRef,
            reason: session.reason
        });
    }

    /**
     * Shared entrypoint helper for Rail, Quick Switcher, internal links and
     * restore flows. The registry command remains the only identity/open
     * authority; navigation is recorded as a generated route projection.
     */
    public async openOrActivateAndNavigate(
        input: ArticleWorkspaceOpenInput,
        router: ArticleWorkspaceNavigationPort
    ): Promise<ArticleWorkspaceRouterReceipt>
    {
        const opened = await this.openOrActivate(input);
        if (
            !opened.tabId
            || opened.sessionState === 'blocked'
            || opened.resultStatus.startsWith('rejected')
            || opened.resultStatus === 'ignored-browser-new-tab'
        )
        {
            return opened;
        }

        const entry = this.registry.getEntry(opened.tabId);
        if (!entry)
        {
            return this.receipt({
                action: 'route-update',
                entrypoint: input.entrypoint,
                origin: 'user',
                route: input.route ?? null,
                tabId: opened.tabId,
                editorSessionRef: opened.editorSessionRef,
                resultStatus: 'blocked',
                sessionState: opened.sessionState,
                sessionReceiptRef: opened.sessionReceiptRef,
                reason: 'opened-tab-disappeared-before-navigation'
            });
        }

        const route = input.route ?? canonicalArticleWorkspaceRoute(entry);
        const generation = ++this.generation;
        this.pendingRoute = { generation, route, tabId: entry.tabId };
        try
        {
            await router.push(route);
        }
        catch
        {
            this.pendingRoute = null;
            return this.receipt({
                action: 'route-update',
                entrypoint: input.entrypoint,
                origin: 'user',
                generation,
                route,
                tabId: entry.tabId,
                editorSessionRef: entry.editorSessionRef,
                resultStatus: 'blocked',
                sessionState: opened.sessionState,
                sessionReceiptRef: opened.sessionReceiptRef,
                reason: 'route-navigation-failed'
            });
        }
        if (this.pendingRoute?.generation === generation)
        {
            this.pendingRoute = null;
        }
        return this.receipt({
            action: 'route-update',
            entrypoint: input.entrypoint,
            origin: 'user',
            generation,
            route,
            tabId: entry.tabId,
            editorSessionRef: entry.editorSessionRef,
            resultStatus: 'applied',
            sessionState: opened.sessionState,
            sessionReceiptRef: opened.sessionReceiptRef,
            reason: null
        });
    }

    public async activateTab(
        tabId: string,
        options: { anchorRef?: string | null; route?: string | null; origin?: 'user' | 'route'; } = {}
    ): Promise<ArticleWorkspaceRouterReceipt>
    {
        const commandNumber = ++this.commandSequence;
        const result = this.registry.execute({
            schema: openArticleDocumentCommandSchema,
            kind: 'activate',
            commandId: `workspace-command:${commandNumber}`,
            idempotencyKey: `workspace-idempotency:${commandNumber}`,
            expectedRevision: this.registry.getRevision(),
            tabId,
            lastActiveAnchorRef: options.anchorRef ?? null
        });
        const entry = result.entryAfter ?? (result.tabId ? this.registry.getEntry(result.tabId) : null);
        if (!entry || (result.status !== 'applied' && result.status !== 'replayed'))
        {
            return this.receipt({
                action: 'activate',
                entrypoint: options.origin === 'route' ? 'router' : 'tab',
                origin: options.origin ?? 'user',
                route: options.route ?? null,
                tabId: result.tabId,
                editorSessionRef: result.editorSessionRef,
                resultStatus: result.status,
                sessionState: result.status === 'rejected-state' ? 'blocked' : null,
                sessionReceiptRef: null,
                reason: result.reason
            });
        }

        this.updatePresentationFromEntry(entry);
        this.notify();
        const session = await this.waitForSession(entry);
        this.notify();
        return this.receipt({
            action: 'activate',
            entrypoint: options.origin === 'route' ? 'router' : 'tab',
            origin: options.origin ?? 'user',
            route: options.route ?? null,
            tabId: entry.tabId,
            editorSessionRef: entry.editorSessionRef,
            resultStatus: result.status,
            sessionState: session.status,
            sessionReceiptRef: session.receiptRef,
            reason: session.reason
        });
    }

    public async promotePreview(tabId: string): Promise<ArticleWorkspaceRouterReceipt>
    {
        const commandNumber = ++this.commandSequence;
        const result = this.registry.execute({
            schema: openArticleDocumentCommandSchema,
            kind: 'set-pin-state',
            commandId: `workspace-command:${commandNumber}`,
            idempotencyKey: `workspace-idempotency:${commandNumber}`,
            expectedRevision: this.registry.getRevision(),
            tabId,
            pinned: true
        });
        const entry = result.entryAfter ?? (result.tabId ? this.registry.getEntry(result.tabId) : null);
        if (entry)
        {
            this.updatePresentationFromEntry(entry);
        }
        this.notify();
        return this.receipt({
            action: 'promote-preview',
            entrypoint: 'tab',
            origin: 'user',
            route: null,
            tabId: result.tabId,
            editorSessionRef: result.editorSessionRef,
            resultStatus: result.status,
            sessionState: entry ? this.sessionReceiptsByTabId.get(entry.tabId)?.status ?? 'pending' : null,
            sessionReceiptRef: entry ? this.sessionReceiptsByTabId.get(entry.tabId)?.receiptRef ?? null : null,
            reason: result.reason
        });
    }

    public async unpinTab(tabId: string): Promise<ArticleWorkspaceRouterReceipt>
    {
        const commandNumber = ++this.commandSequence;
        const result = this.registry.execute({
            schema: openArticleDocumentCommandSchema,
            kind: 'set-pin-state',
            commandId: `workspace-command:${commandNumber}`,
            idempotencyKey: `workspace-idempotency:${commandNumber}`,
            expectedRevision: this.registry.getRevision(),
            tabId,
            pinned: false
        });
        const entry = result.entryAfter ?? (result.tabId ? this.registry.getEntry(result.tabId) : null);
        if (entry)
        {
            this.updatePresentationFromEntry(entry);
        }
        this.notify();
        return this.receipt({
            action: 'set-pin-state',
            entrypoint: 'tab',
            origin: 'user',
            route: null,
            tabId: result.tabId,
            editorSessionRef: result.editorSessionRef,
            resultStatus: result.status,
            sessionState: entry ? this.sessionReceiptsByTabId.get(entry.tabId)?.status ?? 'pending' : null,
            sessionReceiptRef: entry ? this.sessionReceiptsByTabId.get(entry.tabId)?.receiptRef ?? null : null,
            reason: result.reason
        });
    }

    /**
     * A close button can request close, but this layer intentionally never
     * detaches an entry. Confirmation/recently-closed ownership belongs to a
     * later lifecycle issue.
     */
    public requestClose(tabId: string): ArticleWorkspaceRouterReceipt
    {
        const commandNumber = ++this.commandSequence;
        const result = this.registry.execute({
            schema: openArticleDocumentCommandSchema,
            kind: 'request-close',
            commandId: `workspace-command:${commandNumber}`,
            idempotencyKey: `workspace-idempotency:${commandNumber}`,
            expectedRevision: this.registry.getRevision(),
            tabId
        });
        const entry = result.entryAfter ?? (result.tabId ? this.registry.getEntry(result.tabId) : null);
        if (entry)
        {
            this.updatePresentationFromEntry(entry);
        }
        this.notify();
        return this.receipt({
            action: 'request-close',
            entrypoint: 'tab',
            origin: 'user',
            route: null,
            tabId: result.tabId,
            editorSessionRef: result.editorSessionRef,
            resultStatus: result.status,
            sessionState: entry ? this.sessionReceiptsByTabId.get(entry.tabId)?.status ?? 'pending' : null,
            sessionReceiptRef: entry ? this.sessionReceiptsByTabId.get(entry.tabId)?.receiptRef ?? null : null,
            reason: result.reason
        });
    }

    public markStatus(tabId: string, status: ArticleWorkspaceStatusSummary): ArticleWorkspaceRouterReceipt
    {
        const commandNumber = ++this.commandSequence;
        const result = this.registry.execute({
            schema: openArticleDocumentCommandSchema,
            kind: 'mark-status',
            commandId: `workspace-command:${commandNumber}`,
            idempotencyKey: `workspace-idempotency:${commandNumber}`,
            expectedRevision: this.registry.getRevision(),
            tabId,
            status: cloneValue(status)
        });
        const entry = result.entryAfter ?? (result.tabId ? this.registry.getEntry(result.tabId) : null);
        if (entry)
        {
            this.updatePresentationFromEntry(entry);
        }
        this.notify();
        return this.receipt({
            action: 'mark-status',
            entrypoint: 'status',
            origin: 'registry',
            route: null,
            tabId: result.tabId,
            editorSessionRef: result.editorSessionRef,
            resultStatus: result.status,
            sessionState: entry ? this.sessionReceiptsByTabId.get(entry.tabId)?.status ?? 'pending' : null,
            sessionReceiptRef: entry ? this.sessionReceiptsByTabId.get(entry.tabId)?.receiptRef ?? null : null,
            reason: result.reason
        });
    }

    public updatePresentation(
        tabId: string,
        update: ArticleWorkspacePresentationUpdate
    ): ArticleWorkspaceRouterReceipt | null
    {
        const entry = this.registry.getEntry(tabId);
        if (!entry)
        {
            return null;
        }
        const current = this.presentationsByTabId.get(tabId);
        const incomingRevision = update.registryRevision ?? this.registry.getRevision();
        if (current && incomingRevision < current.registryRevision)
        {
            return this.receipt({
                action: 'stale-update',
                entrypoint: 'status',
                origin: 'registry',
                route: null,
                tabId,
                editorSessionRef: entry.editorSessionRef,
                resultStatus: 'stale',
                sessionState: this.sessionReceiptsByTabId.get(tabId)?.status ?? 'pending',
                sessionReceiptRef: this.sessionReceiptsByTabId.get(tabId)?.receiptRef ?? null,
                reason: 'presentation-revision-is-stale'
            });
        }
        const next = current ?? this.presentationFor(entry);
        this.presentationsByTabId.set(tabId, {
            ...next,
            ...(update.title !== undefined ? { title: update.title.trim() || titleFallback(entry) } : {}),
            registryRevision: incomingRevision
        });
        this.notify();
        return this.receipt({
            action: 'mark-status',
            entrypoint: 'status',
            origin: 'registry',
            route: null,
            tabId,
            editorSessionRef: entry.editorSessionRef,
            resultStatus: 'applied',
            sessionState: this.sessionReceiptsByTabId.get(tabId)?.status ?? 'pending',
            sessionReceiptRef: this.sessionReceiptsByTabId.get(tabId)?.receiptRef ?? null,
            reason: null
        });
    }

    public async activateAndNavigate(
        tabId: string,
        router: ArticleWorkspaceNavigationPort
    ): Promise<ArticleWorkspaceRouterReceipt>
    {
        const entry = this.registry.getEntry(tabId);
        if (!entry)
        {
            return this.receipt({
                action: 'route-update',
                entrypoint: 'tab',
                origin: 'user',
                route: null,
                tabId,
                editorSessionRef: null,
                resultStatus: 'rejected-not-found',
                sessionState: null,
                sessionReceiptRef: null,
                reason: 'tab-not-found'
            });
        }
        const route = canonicalArticleWorkspaceRoute(entry);
        const activation = await this.activateTab(tabId, { route, origin: 'user' });
        if (activation.sessionState === 'blocked' || activation.resultStatus.startsWith('rejected'))
        {
            return activation;
        }
        const generation = ++this.generation;
        this.pendingRoute = { generation, route, tabId };
        try
        {
            await router.push(route);
        }
        catch
        {
            this.pendingRoute = null;
            return this.receipt({
                action: 'route-update',
                entrypoint: 'tab',
                origin: 'user',
                generation,
                route,
                tabId,
                editorSessionRef: entry.editorSessionRef,
                resultStatus: 'blocked',
                sessionState: activation.sessionState,
                sessionReceiptRef: activation.sessionReceiptRef,
                reason: 'route-navigation-failed'
            });
        }
        if (this.pendingRoute?.generation === generation)
        {
            this.pendingRoute = null;
        }
        return this.receipt({
            action: 'route-update',
            entrypoint: 'tab',
            origin: 'user',
            generation,
            route,
            tabId,
            editorSessionRef: entry.editorSessionRef,
            resultStatus: 'applied',
            sessionState: activation.sessionState,
            sessionReceiptRef: activation.sessionReceiptRef,
            reason: null
        });
    }

    public async syncRoute(input: {
        route: ArticleWorkspaceRouteLocation;
        identity?: ArticleDocumentIdentity;
        documentContext?: ArticleDocumentContextRef;
        title?: string;
        status?: ArticleWorkspaceStatusSummary;
        targetGroupId?: string;
        allowCreate?: boolean;
    }): Promise<ArticleWorkspaceRouterReceipt>
    {
        const route = input.route.fullPath ?? input.route.path;
        const generation = ++this.generation;
        if (!isArticleWorkspaceRoute(input.route))
        {
            return this.receipt({
                action: 'sync-route',
                entrypoint: 'router',
                origin: 'route',
                generation,
                route,
                tabId: null,
                editorSessionRef: null,
                resultStatus: 'ignored',
                sessionState: null,
                sessionReceiptRef: null,
                reason: 'not-an-article-workspace-route'
            });
        }

        if (this.pendingRoute?.route === route)
        {
            const pending = this.pendingRoute;
            this.pendingRoute = null;
            return this.receipt({
                action: 'sync-route',
                entrypoint: 'router',
                origin: 'route',
                generation: pending.generation,
                route,
                tabId: pending.tabId,
                editorSessionRef: this.registry.getEntry(pending.tabId)?.editorSessionRef ?? null,
                resultStatus: 'replayed',
                sessionState: this.sessionReceiptsByTabId.get(pending.tabId)?.status ?? 'pending',
                sessionReceiptRef: this.sessionReceiptsByTabId.get(pending.tabId)?.receiptRef ?? null,
                reason: 'route-was-generated-by-tab-activation'
            });
        }

        if (!input.identity)
        {
            return this.receipt({
                action: 'sync-route',
                entrypoint: 'router',
                origin: 'route',
                generation,
                route,
                tabId: null,
                editorSessionRef: null,
                resultStatus: 'blocked',
                sessionState: null,
                sessionReceiptRef: null,
                reason: 'route-identity-unavailable-no-ghost-tab'
            });
        }

        const existing = this.registry.getEntryByIdentity(input.identity);
        if (existing)
        {
            const activation = existing.isActive
                ? this.receipt({
                    action: 'sync-route',
                    entrypoint: 'router',
                    origin: 'route',
                    generation,
                    route,
                    tabId: existing.tabId,
                    editorSessionRef: existing.editorSessionRef,
                    resultStatus: 'replayed',
                    sessionState: this.sessionReceiptsByTabId.get(existing.tabId)?.status ?? 'pending',
                    sessionReceiptRef: this.sessionReceiptsByTabId.get(existing.tabId)?.receiptRef ?? null,
                    reason: 'route-already-matches-active-tab'
                })
                : await this.activateTab(existing.tabId, { route, origin: 'route' });
            return activation;
        }

        if (!input.allowCreate || !input.documentContext || !input.status)
        {
            return this.receipt({
                action: 'sync-route',
                entrypoint: 'router',
                origin: 'route',
                generation,
                route,
                tabId: null,
                editorSessionRef: null,
                resultStatus: 'blocked',
                sessionState: null,
                sessionReceiptRef: null,
                reason: 'route-article-not-registered-no-ghost-tab'
            });
        }

        if (input.status.permission !== 'allowed' || input.status.lifecycle !== 'current')
        {
            return this.receipt({
                action: 'sync-route',
                entrypoint: 'router',
                origin: 'route',
                generation,
                route,
                tabId: null,
                editorSessionRef: null,
                resultStatus: 'blocked',
                sessionState: 'blocked',
                sessionReceiptRef: null,
                reason: 'route-state-blocked-no-ghost-tab'
            });
        }

        return this.openOrActivate({
            identity: input.identity,
            documentContext: input.documentContext,
            title: input.title ?? '',
            status: input.status,
            targetGroupId: input.targetGroupId ?? 'group:primary',
            tabKind: 'pinned',
            entrypoint: 'direct-route',
            route
        });
    }

    public reset(): void
    {
        this.presentationsByTabId.clear();
        this.sessionReceiptsByTabId.clear();
        this.pendingRoute = null;
        this.generation = 0;
        this.commandSequence = 0;
        this.notify();
    }

    private async waitForSession(entry: OpenArticleDocumentEntry): Promise<ArticleWorkspaceSessionReceipt>
    {
        try
        {
            const receipt = await this.sessionPort.waitForReady(cloneValue(entry));
            if (!isValidSessionReceipt(receipt) || receipt.tabId !== entry.tabId)
            {
                throw new Error('session-ready-receipt-invalid');
            }
            const current = this.registry.getEntry(entry.tabId);
            if (!current || sessionBindingDigest(current) !== sessionBindingDigest(entry))
            {
                this.sessionReceiptsByTabId.delete(entry.tabId);
                const base = {
                    schema: articleWorkspaceSessionReceiptSchema,
                    receiptRef: `session-blocked-stale:${entry.tabId}:${entry.lifecycleRevision}`,
                    tabId: entry.tabId,
                    editorSessionRef: entry.editorSessionRef,
                    registryRevision: this.registry.getRevision(),
                    status: 'blocked' as const,
                    reason: 'session-result-stale'
                };
                return {
                    ...base,
                    contentDigest: calculateOpenArticleDocumentDigest(base)
                };
            }
            if (
                receipt.editorSessionRef !== entry.editorSessionRef
                || receipt.registryRevision !== entry.lifecycleRevision
            )
            {
                throw new Error('session-ready-receipt-invalid');
            }
            this.sessionReceiptsByTabId.set(entry.tabId, cloneValue(receipt));
            return receipt;
        }
        catch (error)
        {
            const base = {
                schema: articleWorkspaceSessionReceiptSchema,
                receiptRef: `session-blocked:${entry.tabId}:${entry.lifecycleRevision}`,
                tabId: entry.tabId,
                editorSessionRef: entry.editorSessionRef,
                registryRevision: this.registry.getRevision(),
                status: 'blocked' as const,
                reason: error instanceof Error ? error.message : 'session-host-blocked'
            };
            const receipt = {
                ...base,
                contentDigest: calculateOpenArticleDocumentDigest(base)
            } satisfies ArticleWorkspaceSessionReceipt;
            this.sessionReceiptsByTabId.set(entry.tabId, receipt);
            return receipt;
        }
    }

    private updatePresentationFromEntry(entry: OpenArticleDocumentEntry, title?: string): void
    {
        const current = this.presentationsByTabId.get(entry.tabId);
        this.presentationsByTabId.set(entry.tabId, {
            ...(current ?? this.presentationFor(entry)),
            ...(title !== undefined ? { title: title.trim() || current?.title || titleFallback(entry) } : {}),
            articleId: entry.identity.articleId,
            draftId: entry.identity.draftId,
            documentId: entry.identity.documentId,
            editorSessionRef: entry.editorSessionRef,
            owningGroupId: entry.owningGroupId,
            isPreview: entry.isPreview,
            isPinned: entry.isPinned,
            isActive: entry.isActive,
            status: cloneValue(entry.status),
            registryRevision: this.registry.getRevision(),
            contentDigest: entry.contentDigest,
            sessionState: this.sessionReceiptsByTabId.get(entry.tabId)?.status ?? 'pending'
        });
    }

    private presentationFor(entry: OpenArticleDocumentEntry): ArticleWorkspaceTabPresentation
    {
        return {
            tabId: entry.tabId,
            articleId: entry.identity.articleId,
            draftId: entry.identity.draftId,
            documentId: entry.identity.documentId,
            editorSessionRef: entry.editorSessionRef,
            owningGroupId: entry.owningGroupId,
            title: titleFallback(entry),
            isPreview: entry.isPreview,
            isPinned: entry.isPinned,
            isActive: entry.isActive,
            status: cloneValue(entry.status),
            sessionState: 'pending',
            registryRevision: this.registry.getRevision(),
            contentDigest: entry.contentDigest
        };
    }

    private receipt(input: Omit<Partial<ArticleWorkspaceRouterReceipt>, 'schema' | 'receiptRef' | 'contentDigest'> & {
        action: ArticleWorkspaceRouterAction;
        entrypoint: ArticleWorkspaceRouterReceipt['entrypoint'];
        origin: ArticleWorkspaceRouterReceipt['origin'];
        route: string | null;
        tabId: string | null;
        editorSessionRef: string | null;
        resultStatus: ArticleWorkspaceRouterReceipt['resultStatus'];
        sessionState: ArticleWorkspaceSessionState | null;
        sessionReceiptRef: string | null;
        reason: string | null;
    }): ArticleWorkspaceRouterReceipt
    {
        const generation = input.generation ?? this.generation;
        return makeReceiptBase({
            schema: articleWorkspaceTabRouterSchema,
            receiptRef: `tab-router:${generation}:${this.commandSequence}`,
            action: input.action,
            entrypoint: input.entrypoint,
            origin: input.origin,
            generation,
            registryRevision: this.registry.getRevision(),
            route: input.route,
            tabId: input.tabId,
            editorSessionRef: input.editorSessionRef,
            resultStatus: input.resultStatus,
            sessionState: input.sessionState,
            sessionReceiptRef: input.sessionReceiptRef,
            reason: input.reason
        });
    }

    private notify(): void
    {
        for (const listener of this.listeners)
        {
            listener();
        }
    }
}

export interface ArticleWorkspaceSessionHostPortOptions {
    nextUsedTick?: () => number;
    isNearby?: (entry: OpenArticleDocumentEntry) => boolean;
}

function sessionReceiptFromHost(
    entry: OpenArticleDocumentEntry,
    lifecycle: AuthoringSessionLifecycleReceipt
): ArticleWorkspaceSessionReceipt
{
    const blocked = lifecycle.stateAfter === 'blocked';
    const base = {
        schema: articleWorkspaceSessionReceiptSchema,
        receiptRef: lifecycle.receiptRef,
        tabId: entry.tabId,
        editorSessionRef: entry.editorSessionRef,
        registryRevision: entry.lifecycleRevision,
        status: blocked ? 'blocked' as const : 'ready' as const,
        reason: blocked
            ? lifecycle.restoreValidation.reason ?? 'session-host-blocked'
            : null
    };
    return {
        ...base,
        contentDigest: calculateOpenArticleDocumentDigest(base)
    };
}

/**
 * Bridges the #2294 lifecycle authority to the tab router's ready/blocked
 * projection. The router does not construct editor state; the supplied host
 * remains responsible for the public FsusUI session factory and resource
 * budget.
 */
export function createArticleWorkspaceSessionPort(
    host: AuthoringSessionHost,
    options: ArticleWorkspaceSessionHostPortOptions = {}
): ArticleWorkspaceSessionPort
{
    let usedTick = 0;
    const nextUsedTick = options.nextUsedTick ?? (() => ++usedTick);
    return {
        waitForReady: async (entry) =>
        {
            const lifecycle = host.getSession(entry.editorSessionRef)
                ? host.activate(entry, nextUsedTick())
                : host.attach(entry, nextUsedTick(), options.isNearby?.(entry) ?? false);
            return sessionReceiptFromHost(entry, lifecycle);
        }
    };
}

export function canonicalArticleWorkspaceRoute(entry: OpenArticleDocumentEntry): string
{
    return entry.identity.articleId === null
        ? '/user/manage/article/write'
        : `/user/manage/article/edit/${entry.identity.articleId}`;
}

export function isArticleWorkspaceRoute(route: ArticleWorkspaceRouteLocation): boolean
{
    if (route.name === 'ManageWriteArticle' || route.name === 'ManageEditArticle')
    {
        return true;
    }

    return route.path === '/user/manage/article/write'
        || /^\/user\/manage\/article\/edit\/\d+$/u.test(route.path);
}

export function verifyArticleWorkspaceSessionReceipt(receipt: ArticleWorkspaceSessionReceipt): boolean
{
    return isValidSessionReceipt(receipt);
}

export function verifyArticleWorkspaceRouterReceipt(receipt: ArticleWorkspaceRouterReceipt): boolean
{
    const requiredKeys = [
        'schema',
        'receiptRef',
        'action',
        'entrypoint',
        'origin',
        'generation',
        'registryRevision',
        'route',
        'tabId',
        'editorSessionRef',
        'resultStatus',
        'sessionState',
        'sessionReceiptRef',
        'reason',
        'contentDigest'
    ].sort();
    const actualKeys = Object.keys(receipt).sort();
    if (actualKeys.length !== requiredKeys.length || !actualKeys.every((key, index) => key === requiredKeys[index]))
    {
        return false;
    }

    if (
        receipt.schema !== articleWorkspaceTabRouterSchema
        || !stableIdPattern.test(receipt.receiptRef)
        || ![
            'open-or-activate',
            'activate',
            'promote-preview',
            'set-pin-state',
            'request-close',
            'sync-route',
            'route-update',
            'mark-status',
            'stale-update'
        ].includes(receipt.action)
        || ![
            'rail',
            'quick-switcher',
            'internal-link',
            'recent-restore',
            'direct-route',
            'tab',
            'router',
            'status'
        ].includes(receipt.entrypoint)
        || !['user', 'route', 'registry'].includes(receipt.origin)
        || !Number.isSafeInteger(receipt.generation)
        || receipt.generation < 0
        || !Number.isSafeInteger(receipt.registryRevision)
        || receipt.registryRevision < 0
        || (receipt.route !== null && typeof receipt.route !== 'string')
        || (receipt.tabId !== null && !stableIdPattern.test(receipt.tabId))
        || (receipt.editorSessionRef !== null && !stableIdPattern.test(receipt.editorSessionRef))
        || (receipt.sessionReceiptRef !== null && !stableIdPattern.test(receipt.sessionReceiptRef))
        || (receipt.reason !== null && typeof receipt.reason !== 'string')
        || (
            receipt.sessionState !== null
            && !['pending', 'ready', 'blocked'].includes(String(receipt.sessionState))
        )
        || ![
            'applied',
            'activated-existing',
            'replayed',
            'ignored-browser-new-tab',
            'rejected-cas',
            'rejected-idempotency-conflict',
            'rejected-invalid-command',
            'rejected-not-found',
            'rejected-duplicate-identity',
            'rejected-duplicate-session',
            'rejected-preview-risk',
            'rejected-state',
            'ignored',
            'blocked',
            'stale'
        ].includes(receipt.resultStatus)
        || !digestPattern.test(receipt.contentDigest)
    )
    {
        return false;
    }

    const { contentDigest, ...base } = receipt;
    return calculateOpenArticleDocumentDigest(base) === contentDigest;
}

export const articleWorkspaceTabRouter = new ArticleWorkspaceTabRouter();

export function createArticleWorkspaceOpenInput(
    identity: ArticleDocumentIdentity,
    documentContext: ArticleDocumentContextRef,
    title: string,
    status: ArticleWorkspaceStatusSummary,
    overrides: Partial<Omit<ArticleWorkspaceOpenInput, 'identity' | 'documentContext' | 'title' | 'status'>> = {}
): ArticleWorkspaceOpenInput
{
    return {
        identity,
        documentContext,
        title,
        status: {
            ...status,
            statusRef: status.statusRef || statusRefFor(identity)
        },
        targetGroupId: 'group:primary',
        tabKind: 'pinned',
        entrypoint: 'direct-route',
        ...overrides
    };
}
