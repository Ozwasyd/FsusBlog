import type { MarkdownEditorDispatchResult, MarkdownEditorResolvedSelection } from '@/fsusui/articlePositionMaps';

import {
    validateArticleAnchorContext,
    validateArticleAnchorCommand,
    type ArticleAnchorCaptureOptions,
    type ArticleAnchorCommand,
    type ArticleAnchorContext,
    type ArticleAnchorContextAdapter,
    type ArticlePositionMapBinding
} from './articleAnchorContext';
import { articleDocumentContextSchema, validateArticleDocumentContext, type ArticleDocumentContextAdapter } from './articleDocumentContext';
import {
    AuthoringNavigationHistory,
    authoringNavigationCommandSchema,
    authoringNavigationVisitCauses,
    calculateAuthoringNavigationDigest,
    observeAuthoringNavigationTarget,
    verifyAuthoringNavigationTransition,
    type AuthoringNavigationAnchor,
    type AuthoringNavigationCommand,
    type AuthoringNavigationEntry,
    type AuthoringNavigationHistoryState,
    type AuthoringNavigationRecentRestoreRef,
    type AuthoringNavigationScope,
    type AuthoringNavigationTransition,
    type AuthoringNavigationValidity,
    type AuthoringNavigationVisitCause
} from './authoringNavigationHistory';
import { calculateOpenArticleDocumentDigest, openArticleDocumentCommandSchema, verifyOpenArticleDocumentResult } from './openArticleDocumentRegistry';

import type { ArticleEditorMountedSessionPort } from './articleEditorContinuity';
import type { AuthoringTabGroupRegistry } from './authoringTabGroupRegistry';
import type {
    ArticleDocumentIdentity,
    OpenArticleDocumentCommandResult,
    OpenArticleDocumentEntry,
    OpenArticleDocumentRegistry,
    OpenOrActivateArticleCommand
} from './openArticleDocumentRegistry';

export const authoringNavigationEntrypointSchema = 'fsusblog.authoring-navigation-entrypoint.v1' as const;

export type AuthoringNavigationEntrypoint = AuthoringNavigationVisitCause | 'direct-route';

/** Explicit activations only. URLs, titles, query text and browser history positions are not identities. */
export interface AuthoringNavigationIntent {
    schema: typeof authoringNavigationEntrypointSchema;
    requestId: string;
    sequence: number;
    initiatedAt: number;
    entrypoint: AuthoringNavigationEntrypoint;
    identity: ArticleDocumentIdentity;
    anchor: AuthoringNavigationAnchor | null;
    targetGroupId: string | null;
    routePolicy: 'push' | 'replace' | 'none';
    recentRestore: AuthoringNavigationRecentRestoreRef | null;
    contentDigest: string;
}

/** Borrow the original mounted owner. Implementations must not reconstruct a session or map from history. */
export interface AuthoringNavigationMountedEditor {
    readonly document: ArticleDocumentContextAdapter;
    readonly anchors: ArticleAnchorContextAdapter;
    readonly editor: ArticleEditorMountedSessionPort;
    binding(): ArticlePositionMapBinding;
    selection(): MarkdownEditorResolvedSelection;
    captureOptions(): ArticleAnchorCaptureOptions;
    /** Resolve the original full capture in its issuing owner; the node-bound history projection is insufficient. */
    resolveAnchor(anchor: AuthoringNavigationAnchor): ArticleAnchorContext | null;
    transactions(anchor: ArticleAnchorContext): readonly MarkdownEditorDispatchResult[];
    viewport(): { height: number; reducedMotion: boolean; };
    /** The focus/viewport owner must check admission immediately before each side effect and acknowledge real events. */
    reveal(command: ArticleAnchorCommand | null, signal: AbortSignal, admit: () => void): Promise<{
        focusAcknowledged: boolean;
        viewportAcknowledged: boolean;
    }>;
}

export interface AuthoringNavigationMountedPort {
    current(entry: OpenArticleDocumentEntry): AuthoringNavigationMountedEditor | null;
    wait(entry: OpenArticleDocumentEntry, signal: AbortSignal): Promise<AuthoringNavigationMountedEditor | null>;
}

/** Composition port for the original server selection/revalidation and recent-closed owners, never a local open detector. */
export interface AuthoringNavigationSelectionPort {
    resolveUnopened(identity: ArticleDocumentIdentity, signal: AbortSignal): Promise<OpenOrActivateArticleCommand | null>;
    verifyRecentRestore(ref: AuthoringNavigationRecentRestoreRef, entry: OpenArticleDocumentEntry): boolean;
}

/** Opaque process-local route loan. A serialized copy is not an origin token. */
export interface AuthoringNavigationRouteOrigin {
    readonly requestId: string;
    readonly sequence: number;
    readonly origin: 'activation' | 'history-navigation';
}

export interface AuthoringNavigationRoutePort {
    /** Derive the canonical location from current route projection; attach the exact token to the route observation. */
    update(entry: OpenArticleDocumentEntry, policy: 'push' | 'replace', token: AuthoringNavigationRouteOrigin,
        signal: AbortSignal, admit: () => void): Promise<void>;
}

export interface AuthoringNavigationEntrypointReceipt {
    schema: typeof authoringNavigationEntrypointSchema;
    requestId: string;
    sequence: number;
    entrypoint: AuthoringNavigationEntrypoint | 'back' | 'forward' | 'route';
    status: 'completed' | 'disabled' | 'invalid' | 'cancelled' | 'stale' | 'ignored';
    reason: string | null;
    sourceAnchorDigest: string | null;
    observation: AuthoringNavigationValidity | null;
    open: OpenArticleDocumentCommandResult | null;
    anchor: ArticleAnchorCommand | null;
    history: readonly AuthoringNavigationTransition[];
    commands: readonly AuthoringNavigationCommand[];
    groupFallback: boolean;
    contentDigest: string;
}

type NavigationPayload<Command> = Command extends AuthoringNavigationCommand
    ? Omit<Command, 'schema' | 'scope' | 'commandId' | 'idempotencyKey' | 'commandSequence' | 'expectedRevision'> : never;

/** Integrity and independent history replay only; digests do not authenticate mounted/server owners. */
export function verifyAuthoringNavigationEntrypointReceipt(value: unknown, before: AuthoringNavigationHistoryState): boolean
{
    try
    {
        calculateAuthoringNavigationDigest(value);
        if (!keysAre(value, ['schema', 'requestId', 'sequence', 'entrypoint', 'status', 'reason', 'sourceAnchorDigest',
            'observation', 'open', 'anchor', 'history', 'commands', 'groupFallback', 'contentDigest']))
        {
            return false;
        }
        if (!Array.isArray(value.commands) || !Array.isArray(value.history))
        {
            return false;
        }
        const receipt = value as unknown as AuthoringNavigationEntrypointReceipt;
        const { contentDigest, ...body } = receipt;
        if (contentDigest !== calculateAuthoringNavigationDigest(body) || receipt.schema !== authoringNavigationEntrypointSchema
            || !['completed', 'disabled', 'invalid', 'cancelled', 'stale', 'ignored'].includes(receipt.status)
            || receipt.commands.length !== receipt.history.length
            || receipt.open !== null && !verifyOpenArticleDocumentResult(receipt.open)
            || receipt.anchor !== null && !validateArticleAnchorCommand(receipt.anchor))
        {
            return false;
        }
        let state = before;
        for (let index = 0; index < receipt.commands.length; index += 1)
        {
            if (!verifyAuthoringNavigationTransition(state, receipt.commands[index], receipt.history[index]))
            {
                return false;
            }
            state = receipt.history[index].state;
        }
        if (receipt.status === 'completed')
        {
            const last = receipt.commands.at(-1);
            const transition = receipt.history.at(-1);
            if (!last || !transition || !['applied', 'coalesced'].includes(transition.receipt.status)
                || !receipt.open || !['applied', 'activated-existing', 'replayed'].includes(receipt.open.status)
                || receipt.observation?.status !== 'current'
                || receipt.anchor !== null && (receipt.anchor.status !== 'ready' || !['exact', 'rebased'].includes(receipt.anchor.kind ?? '')))
            {
                return false;
            }
            if (last.kind === 'append' || last.kind === 'coalesce')
            {
                return last.visit.userActionId === receipt.requestId && last.visit.userSequence === receipt.sequence
                    && last.visit.cause === (receipt.entrypoint === 'direct-route' ? 'internal-link' : receipt.entrypoint);
            }
            return last.kind === 'settle-navigation' && last.outcome === 'completed'
                && receipt.commands[0].kind === receipt.entrypoint && ['back', 'forward'].includes(receipt.entrypoint);
        }
        return true;
    }
    catch
    {
        return false;
    }
}

interface Request {
    requestId: string;
    sequence: number;
    controller: AbortController;
    pendingRef: string | null;
    receipt: AuthoringNavigationEntrypointReceipt | null;
    groupRevision: number | null;
    acknowledgedAdmission: (() => void) | null;
}

const owners = new WeakSet<OpenArticleDocumentRegistry>();
const reference = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u;
const same = (left: unknown, right: unknown): boolean =>
    calculateAuthoringNavigationDigest(left) === calculateAuthoringNavigationDigest(right);
const keysAre = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const digestIs = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

function anchorIs(value: unknown): boolean
{
    if (!keysAre(value, ['nodeId', 'range', 'affinity', 'document', 'anchorContextDigest'])
        || typeof value.nodeId !== 'string' || value.nodeId.length === 0 || !digestIs(value.anchorContextDigest)
        || !['before', 'after'].includes(String(value.affinity)) || !keysAre(value.range, ['start', 'end'])
        || !Number.isSafeInteger(value.range.start) || !Number.isSafeInteger(value.range.end)
        || Number(value.range.start) < 0 || Number(value.range.end) < Number(value.range.start))
    {
        return false;
    }
    const document = value.document;
    return keysAre(document, ['articleId', 'draftId', 'documentId', 'documentEpoch', 'sourceRevision', 'draftRevision',
        'siteScope', 'userScope', 'sourceIdentityDigest', 'contentDigest', 'contextDigest'])
        && (document.articleId === null || Number.isSafeInteger(document.articleId) && Number(document.articleId) > 0)
        && ['draftId', 'documentId', 'siteScope', 'userScope'].every(key => typeof document[key] === 'string' && reference.test(document[key]))
        && Number.isSafeInteger(document.documentEpoch) && Number(document.documentEpoch) >= 0
        && Number.isSafeInteger(document.sourceRevision) && Number(document.sourceRevision) >= 0
        && (document.draftRevision === null || typeof document.draftRevision === 'string')
        && ['sourceIdentityDigest', 'contentDigest', 'contextDigest'].every(key => digestIs(document[key]));
}

function seal<T extends object>(value: T): T & { contentDigest: string; }
{
    return { ...value, contentDigest: calculateAuthoringNavigationDigest(value) };
}

function registryEntrypoint(entrypoint: AuthoringNavigationEntrypoint): OpenOrActivateArticleCommand['entrypoint']
{
    switch (entrypoint)
    {
        case 'rail': return 'rail';
        case 'quick-switcher':
        case 'global-search': return 'quick-switcher';
        case 'recent-closed-restore': return 'recent-restore';
        case 'direct-route': return 'direct-route';
        default: return 'internal-link';
    }
}

/** No property getters run during intent validation; the existing history canonicalizer rejects executable data. */
export function verifyAuthoringNavigationIntent(value: unknown): value is AuthoringNavigationIntent
{
    try
    {
        calculateAuthoringNavigationDigest(value);
        if (!value || typeof value !== 'object' || Array.isArray(value))
        {
            return false;
        }
        const intent = value as AuthoringNavigationIntent;
        const keys = ['schema', 'requestId', 'sequence', 'initiatedAt', 'entrypoint', 'identity', 'anchor',
            'targetGroupId', 'routePolicy', 'recentRestore', 'contentDigest'];
        const { contentDigest, ...body } = intent;
        return Object.keys(intent).length === keys.length && keys.every(key => Object.hasOwn(intent, key))
            && intent.schema === authoringNavigationEntrypointSchema && typeof intent.requestId === 'string'
            && reference.test(intent.requestId) && intent.requestId.length <= 110
            && Number.isSafeInteger(intent.sequence) && intent.sequence > 0
            && Number.isSafeInteger(intent.initiatedAt) && intent.initiatedAt >= 0
            && [...authoringNavigationVisitCauses, 'direct-route'].includes(intent.entrypoint)
            && ['push', 'replace', 'none'].includes(intent.routePolicy)
            && (intent.targetGroupId === null || reference.test(intent.targetGroupId))
            && Object.keys(intent.identity).length === 3
            && ['articleId', 'draftId', 'documentId'].every(key => Object.hasOwn(intent.identity, key))
            && (intent.identity.articleId === null || Number.isSafeInteger(intent.identity.articleId) && intent.identity.articleId > 0)
            && reference.test(intent.identity.draftId) && reference.test(intent.identity.documentId)
            && (intent.anchor === null || anchorIs(intent.anchor))
            && (intent.entrypoint === 'recent-closed-restore' ? intent.recentRestore !== null : intent.recentRestore === null)
            && (intent.recentRestore === null || keysAre(intent.recentRestore, ['entryRef', 'restoreReceiptRef', 'restoreReceiptDigest'])
                && reference.test(intent.recentRestore.entryRef) && reference.test(intent.recentRestore.restoreReceiptRef)
                && digestIs(intent.recentRestore.restoreReceiptDigest))
            && contentDigest === calculateAuthoringNavigationDigest(body);
    }
    catch
    {
        return false;
    }
}

export function createAuthoringNavigationIntent(input: Omit<AuthoringNavigationIntent, 'schema' | 'contentDigest'>): AuthoringNavigationIntent
{
    calculateAuthoringNavigationDigest(input);
    const intent = seal({ schema: authoringNavigationEntrypointSchema, ...structuredClone(input) });
    if (!verifyAuthoringNavigationIntent(intent))
    {
        throw new Error('authoring-navigation-intent-invalid');
    }
    return intent;
}

/** Explicitly project the node-bound subset. Never cast this value back into ArticleAnchorContext. */
export function projectAuthoringNavigationAnchor(anchor: ArticleAnchorContext): AuthoringNavigationAnchor
{
    if (!validateArticleAnchorContext(anchor) || anchor.nodeId === null)
    {
        throw new Error('authoring-navigation-node-anchor-unavailable');
    }
    const document = anchor.document;
    return structuredClone({ nodeId: anchor.nodeId, range: anchor.range, affinity: anchor.affinity,
        document: { articleId: document.articleId, draftId: document.draftId, documentId: document.documentId,
            documentEpoch: document.documentEpoch, sourceRevision: document.sourceRevision, draftRevision: document.draftRevision,
            siteScope: document.siteScope, userScope: document.userScope, sourceIdentityDigest: document.sourceIdentityDigest,
            contentDigest: document.contentDigest, contextDigest: document.contextDigest }, anchorContextDigest: anchor.contentDigest });
}

/** One adapter per canonical Registry. Only the original history owns entries/cursor; this map is a bounded request replay window. */
export class AuthoringNavigationEntrypoints
{
    public readonly history: AuthoringNavigationHistory;
    readonly #registry: OpenArticleDocumentRegistry;
    readonly #groups: AuthoringTabGroupRegistry;
    readonly #mounted: AuthoringNavigationMountedPort | null;
    readonly #selection: AuthoringNavigationSelectionPort | null;
    readonly #route: AuthoringNavigationRoutePort | null;
    readonly #requests = new Map<string, { digest: string; result: Promise<AuthoringNavigationEntrypointReceipt>; }>();
    readonly #origins = new WeakMap<AuthoringNavigationRouteOrigin, Request>();
    #active: Request | null = null;
    #sequence = 0;
    #commandSequence = 0;

    public constructor(options: {
        registry: OpenArticleDocumentRegistry;
        groups: AuthoringTabGroupRegistry;
        scope: AuthoringNavigationScope;
        mounted?: AuthoringNavigationMountedPort;
        selection?: AuthoringNavigationSelectionPort;
        route?: AuthoringNavigationRoutePort;
    })
    {
        if (owners.has(options.registry) || !options.groups.verifyBinding(options.registry))
        {
            throw new Error('authoring-navigation-owner-binding-invalid');
        }
        this.#registry = options.registry;
        this.#groups = options.groups;
        this.#mounted = options.mounted ?? null;
        this.#selection = options.selection ?? null;
        this.#route = options.route ?? null;
        this.history = new AuthoringNavigationHistory(options.registry, options.scope);
        owners.add(options.registry);
    }

    public inspectAvailability(): { enabled: boolean; missing: readonly string[]; }
    {
        return { enabled: this.#mounted !== null, missing: this.#mounted ? [] : [
            'ArticleWriteEditor.getAuthoringEditorPort', 'mounted-session-capture', 'current-public-anchor-map',
            'owner-issued-full-anchor-resolution', 'focus-and-viewport-acknowledgement'
        ] };
    }

    /** Same application origin is consumed by reference, including synchronous router reentry. Unknown/serialized tokens refuse. */
    public observeRoute(token: AuthoringNavigationRouteOrigin): AuthoringNavigationEntrypointReceipt
    {
        const request = this.#origins.get(token);
        if (!request)
        {
            return this.#receipt('unissued-route-origin', 0, 'route', 'invalid', 'route-origin-not-issued');
        }
        return this.#receipt(request.requestId, request.sequence, 'route',
            request === this.#active && !request.controller.signal.aborted ? 'ignored' : 'stale', 'origin-already-handled');
    }

    /** Browser back/forward or a direct URL supplies a fresh explicit route intent; it never invokes authoring back. */
    public navigate(intent: AuthoringNavigationIntent, signal?: AbortSignal): Promise<AuthoringNavigationEntrypointReceipt>
    {
        if (!verifyAuthoringNavigationIntent(intent))
        {
            return Promise.resolve(this.#receipt('invalid-request', 0, 'route', 'invalid', 'intent-invalid'));
        }
        const frozen = structuredClone(intent);
        return this.#run(frozen.requestId, frozen.sequence, frozen.entrypoint, frozen.contentDigest,
            signal, request => this.#visit(request, frozen));
    }

    public traverse(direction: 'back' | 'forward', requestId: string, sequence: number,
        signal?: AbortSignal): Promise<AuthoringNavigationEntrypointReceipt>
    {
        if (!['back', 'forward'].includes(direction) || !reference.test(requestId) || !Number.isSafeInteger(sequence) || sequence <= 0)
        {
            return Promise.resolve(this.#receipt('invalid-request', 0, 'route', 'invalid', 'intent-invalid'));
        }
        return this.#run(requestId, sequence, direction, calculateAuthoringNavigationDigest({ direction, requestId, sequence }),
            signal, request => this.#traverse(request, direction));
    }

    public cancel(): void
    {
        const active = this.#active;
        if (!active)
        {
            return;
        }
        active.controller.abort();
        this.#settle(active, 'cancelled');
    }

    #run(requestId: string, sequence: number, entrypoint: AuthoringNavigationEntrypointReceipt['entrypoint'], digest: string,
        signal: AbortSignal | undefined, action: (request: Request) => Promise<AuthoringNavigationEntrypointReceipt>
    ): Promise<AuthoringNavigationEntrypointReceipt>
    {
        const existing = this.#requests.get(requestId);
        if (existing)
        {
            return existing.digest === digest ? existing.result
                : Promise.resolve(this.#receipt(requestId, sequence, entrypoint, 'invalid', 'request-id-conflict'));
        }
        if (sequence <= this.#sequence)
        {
            return Promise.resolve(this.#receipt(requestId, sequence, entrypoint, 'stale', 'older-intent'));
        }
        if (!this.#mounted)
        {
            return Promise.resolve(this.#receipt(requestId, sequence, entrypoint, 'disabled', 'mounted-editor-port-unavailable'));
        }
        if (signal?.aborted)
        {
            return Promise.resolve(this.#receipt(requestId, sequence, entrypoint, 'cancelled', 'caller-aborted'));
        }
        this.cancel();
        const request: Request = { requestId, sequence, controller: new AbortController(), pendingRef: null, receipt: null,
            groupRevision: null, acknowledgedAdmission: null };
        this.#active = request;
        this.#sequence = sequence;
        const abort = (): void =>
        {
            request.controller.abort();
            this.#settle(request, 'cancelled');
        };
        signal?.addEventListener('abort', abort, { once: true });
        // Publish the promise before any owner callback can reenter this adapter.
        const result = Promise.resolve().then(() => action(request)).catch((error: unknown) =>
        {
            this.#settle(request, request.controller.signal.aborted ? 'cancelled' : 'failed');
            const receipt = request.receipt ?? this.#receipt(requestId, sequence, entrypoint, 'invalid', null);
            return this.#finish(receipt, request.controller.signal.aborted ? 'cancelled' : 'invalid',
                request.controller.signal.aborted ? 'request-cancelled-or-superseded'
                    : error instanceof Error ? error.message : 'owner-operation-failed');
        }).finally(() => signal?.removeEventListener('abort', abort));
        this.#requests.set(requestId, { digest, result });
        if (this.#requests.size > 128)
        {
            this.#requests.delete(this.#requests.keys().next().value!);
        }
        return result;
    }

    #admit(request: Request): void
    {
        request.controller.signal.throwIfAborted();
        if (this.#active !== request)
        {
            throw new Error('authoring-navigation-superseded');
        }
        if (request.groupRevision !== null && this.#groups.exportState().revision !== request.groupRevision)
        {
            throw new Error('authoring-navigation-group-publication-changed');
        }
    }

    #command(request: Request, input: NavigationPayload<AuthoringNavigationCommand>): AuthoringNavigationTransition
    {
        const state = this.history.exportState();
        const sequence = ++this.#commandSequence;
        const command: AuthoringNavigationCommand = { schema: authoringNavigationCommandSchema, scope: state.scope,
            commandId: `navigation-command:${sequence}`, idempotencyKey: `navigation-command:${sequence}`,
            commandSequence: Math.max(sequence, state.lastCommandSequence + 1), expectedRevision: state.revision,
            ...input };
        const transition = this.history.execute(command);
        if (request.receipt)
        {
            request.receipt.commands = [...request.receipt.commands, command];
            request.receipt.history = [...request.receipt.history, transition];
        }
        return transition;
    }

    #settle(request: Request, outcome: 'completed' | 'cancelled' | 'failed'): AuthoringNavigationTransition | null
    {
        if (request.pendingRef === null)
        {
            return null;
        }
        const pending = this.history.exportState().pending;
        if (pending?.intentRef !== request.pendingRef)
        {
            return null;
        }
        request.pendingRef = null;
        return this.#command(request, { kind: 'settle-navigation', intentRef: pending.intentRef, outcome });
    }

    #entryCurrent(entry: OpenArticleDocumentEntry): void
    {
        if (!same(this.#registry.getEntry(entry.tabId), entry))
        {
            throw new Error('authoring-navigation-entry-changed');
        }
    }

    #editor(entry: OpenArticleDocumentEntry, mounted: AuthoringNavigationMountedEditor): ArticlePositionMapBinding
    {
        this.#entryCurrent(entry);
        if (this.#mounted?.current(entry) !== mounted)
        {
            throw new Error('authoring-navigation-mounted-loan-retired');
        }
        const document = mounted.document.context;
        const scope = this.history.exportState().scope;
        if (!validateArticleDocumentContext(document) || !mounted.document.isCurrentContext(document)
            || document.articleId !== entry.identity.articleId
            || document.draftId !== entry.identity.draftId || document.documentId !== entry.identity.documentId
            || document.documentEpoch !== entry.documentContext.documentEpoch || document.editorSessionId !== entry.editorSessionRef
            || document.userScope !== scope.userScope || document.siteScope !== scope.siteScope)
        {
            throw new Error('authoring-navigation-mounted-document-mismatch');
        }
        const editor = mounted.editor;
        const session = editor.getSession(entry.editorSessionRef);
        const native = session.inspectContentDigest(value =>
            // This is the original native source loan, not a history body or an adapter-owned copy.
            mounted.document.context.contentDigest === document.contentDigest
                ? calculateOpenArticleDocumentDigest({ schema: articleDocumentContextSchema, content: value }) : '');
        if (native.documentIdentity.id !== document.documentId || native.documentIdentity.epoch !== document.documentEpoch
            || native.revision !== document.sourceRevision || native.editorContentDigest !== document.contentDigest)
        {
            throw new Error('authoring-navigation-native-session-mismatch');
        }
        const binding = mounted.binding();
        if (binding.document.contextDigest !== document.contextDigest || !mounted.anchors.isCurrentPositionBinding(binding))
        {
            throw new Error('authoring-navigation-public-map-stale');
        }
        // Recheck custody after every producer read above; matching metadata cannot keep a retired loan live.
        this.#entryCurrent(entry);
        if (this.#mounted?.current(entry) !== mounted || mounted.editor !== editor
            || editor.getSession(entry.editorSessionRef) !== session || mounted.document.context !== document
            || !mounted.document.isCurrentContext(document))
        {
            throw new Error('authoring-navigation-mounted-loan-changed');
        }
        return binding;
    }

    #capture(entry: OpenArticleDocumentEntry, mounted: AuthoringNavigationMountedEditor): ArticleAnchorContext
    {
        const binding = this.#editor(entry, mounted);
        const selection = mounted.selection();
        const options = mounted.captureOptions();
        if (this.#editor(entry, mounted).document.contextDigest !== binding.document.contextDigest)
        {
            throw new Error('authoring-navigation-context-changed');
        }
        const captured = mounted.anchors.capture(binding, selection, options);
        if (this.#editor(entry, mounted).document.contextDigest !== captured.document.contextDigest)
        {
            throw new Error('authoring-navigation-context-changed');
        }
        return captured;
    }

    #observe(entry: OpenArticleDocumentEntry, anchor: AuthoringNavigationAnchor | null,
        subject?: AuthoringNavigationEntry, anchorStatus: 'current' | 'missing' = 'current'): AuthoringNavigationValidity
    {
        const groups = this.#groups.exportState();
        const group = groups.groups.find(value => value.groupId === entry.owningGroupId);
        const candidate: AuthoringNavigationEntry = subject ?? seal({ entryId: `observation:${this.#sequence}`,
            identity: entry.identity, documentContext: entry.documentContext, owningGroupId: entry.owningGroupId,
            targetGroupId: entry.owningGroupId, anchor, cause: 'internal-link' as const,
            userActionId: `observation:${this.#sequence}`, userSequence: this.#sequence,
            userInitiatedAt: 0, recordedAt: 0, recentRestore: null,
            validity: { status: 'unknown' as const, statusRef: entry.status.statusRef, registryRevision: this.#registry.getRevision(),
                groupRegistryRevision: groups.revision, groupRevision: group?.revision ?? null,
                observationRef: `navigation-observation:${this.#sequence}:${this.#registry.getRevision()}` } });
        return observeAuthoringNavigationTarget(candidate, {
            current: { identity: entry.identity, documentContext: entry.documentContext, owningGroupId: entry.owningGroupId, status: entry.status },
            absence: 'unknown', group: group ? { groupId: group.groupId, revision: group.revision } : null,
            groupRegistry: { revision: groups.revision, articleRegistryRevision: groups.articleRegistryRevision },
            anchorStatus: anchor === null ? 'unknown' : anchorStatus, anchorDocument: anchor?.document ?? null,
            registryRevision: this.#registry.getRevision(), observationRef: `navigation-observation:${this.#sequence}:${this.#registry.getRevision()}`
        });
    }

    async #reveal(request: Request, entry: OpenArticleDocumentEntry, mounted: AuthoringNavigationMountedEditor,
        anchor: AuthoringNavigationAnchor | null): Promise<ArticleAnchorCommand | null>
    {
        const binding = this.#editor(entry, mounted);
        const documentOwner = mounted.document;
        const anchors = mounted.anchors;
        const editor = mounted.editor;
        const session = editor.getSession(entry.editorSessionRef);
        const contextDigest = binding.document.contextDigest;
        const admit = (): void =>
        {
            this.#admit(request);
            const current = this.#editor(entry, mounted);
            if (mounted.document !== documentOwner || mounted.anchors !== anchors || mounted.editor !== editor
                || editor.getSession(entry.editorSessionRef) !== session || current.document.contextDigest !== contextDigest)
            {
                throw new Error('authoring-navigation-context-changed');
            }
            this.#admit(request);
        };
        admit();
        let command: ArticleAnchorCommand | null = null;
        if (anchor)
        {
            const saved = mounted.resolveAnchor(anchor);
            if (!saved || !validateArticleAnchorContext(saved) || !same(projectAuthoringNavigationAnchor(saved), anchor))
            {
                throw new Error('authoring-navigation-original-anchor-unavailable');
            }
            const viewport = mounted.viewport();
            const transactions = mounted.transactions(saved);
            admit();
            command = mounted.anchors.restore(saved, binding, { origin: 'outline', now: request.sequence,
                viewportHeight: viewport.height, reducedMotion: viewport.reducedMotion, transactions });
            admit();
            if (command.status !== 'ready' || command.kind !== 'exact' && command.kind !== 'rebased')
            {
                return command;
            }
        }
        admit();
        const acknowledgement = await mounted.reveal(command, request.controller.signal, admit);
        admit();
        if (!acknowledgement.focusAcknowledged || !acknowledgement.viewportAcknowledged)
        {
            throw new Error('authoring-navigation-focus-or-viewport-unacknowledged');
        }
        request.acknowledgedAdmission = admit;
        return command;
    }

    async #updateRoute(request: Request, entry: OpenArticleDocumentEntry, policy: AuthoringNavigationIntent['routePolicy'],
        origin: AuthoringNavigationRouteOrigin['origin']): Promise<void>
    {
        const admit = request.acknowledgedAdmission;
        if (!admit)
        {
            throw new Error('authoring-navigation-acknowledgement-unavailable');
        }
        admit();
        if (policy === 'none')
        {
            return;
        }
        if (!this.#route)
        {
            throw new Error('authoring-navigation-route-port-unavailable');
        }
        const token = Object.freeze({ requestId: request.requestId, sequence: request.sequence, origin });
        this.#origins.set(token, request);
        await this.#route.update(entry, policy, token, request.controller.signal, () =>
        {
            admit();
        });
        admit();
    }

    async #visit(request: Request, intent: AuthoringNavigationIntent): Promise<AuthoringNavigationEntrypointReceipt>
    {
        this.#admit(request);
        const receipt = this.#receipt(request.requestId, request.sequence, intent.entrypoint, 'invalid', null);
        request.receipt = receipt;
        const active = this.#registry.listEntries().find(entry => entry.isActive);
        if (active)
        {
            const source = this.#mounted!.current(active);
            if (!source)
            {
                return this.#finish(receipt, 'disabled', 'source-mounted-editor-unavailable');
            }
            receipt.sourceAnchorDigest = this.#capture(active, source).contentDigest;
        }
        let entry = this.#registry.getEntryByIdentity(intent.identity);
        if (entry && !same(entry.identity, intent.identity))
        {
            return this.#finish(receipt, 'invalid', 'same-id-document-recreated');
        }
        let open: OpenOrActivateArticleCommand;
        if (intent.entrypoint === 'recent-closed-restore')
        {
            if (!entry || !this.#selection || !intent.recentRestore
                || !this.#selection.verifyRecentRestore(intent.recentRestore, entry))
            {
                return this.#finish(receipt, 'invalid', 'recent-restore-owner-not-completed');
            }
        }
        if (entry)
        {
            receipt.observation = this.#observe(entry, null);
            if (receipt.observation.status !== 'current')
            {
                return this.#finish(receipt, 'invalid', receipt.observation.status);
            }
            open = { schema: openArticleDocumentCommandSchema, kind: 'open-or-activate', commandId: request.requestId,
                idempotencyKey: request.requestId, expectedRevision: this.#registry.getRevision(), intent: 'workspace',
                entrypoint: registryEntrypoint(intent.entrypoint), identity: entry.identity, documentContext: entry.documentContext,
                editorSessionRef: entry.editorSessionRef, tabId: entry.tabId, targetGroupId: entry.owningGroupId,
                tabKind: entry.isPinned ? 'pinned' : 'preview', status: entry.status, lastActiveAnchorRef: entry.lastActiveAnchorRef };
        }
        else
        {
            if (!this.#selection)
            {
                return this.#finish(receipt, 'disabled', 'server-selection-revalidation-port-unavailable');
            }
            const revision = this.#registry.getRevision();
            const selected = await this.#selection.resolveUnopened(intent.identity, request.controller.signal);
            this.#admit(request);
            if (!selected || !same(selected.identity, intent.identity) || selected.expectedRevision !== revision
                || revision !== this.#registry.getRevision() || selected.status.permission !== 'allowed'
                || selected.status.lifecycle !== 'current')
            {
                return this.#finish(receipt, 'invalid', 'server-selection-not-current');
            }
            open = structuredClone(selected);
        }
        const groups = this.#groups.exportState();
        const target = intent.targetGroupId ?? groups.activeGroupId;
        const targetGroupId = groups.groups.some(group => group.groupId === target) ? target : groups.activeGroupId;
        receipt.groupFallback = targetGroupId !== target;
        this.#admit(request);
        // An existing tab retains its actual group; openOrActivate alone owns identity detection and activation.
        receipt.open = this.#registry.openOrActivate({ ...open, commandId: request.requestId, idempotencyKey: request.requestId,
            expectedRevision: this.#registry.getRevision(), entrypoint: registryEntrypoint(intent.entrypoint),
            targetGroupId: entry?.owningGroupId ?? targetGroupId });
        this.#admit(request);
        if (!['applied', 'activated-existing', 'replayed'].includes(receipt.open.status) || !receipt.open.tabId)
        {
            return this.#finish(receipt, 'invalid', receipt.open.reason ?? receipt.open.status);
        }
        entry = this.#registry.getEntry(receipt.open.tabId);
        if (!entry || !same(entry.identity, intent.identity))
        {
            return this.#finish(receipt, 'invalid', 'opened-identity-mismatch');
        }
        request.groupRevision = this.#groups.exportState().revision;
        const mounted = await this.#mounted!.wait(entry, request.controller.signal);
        this.#admit(request);
        if (!mounted)
        {
            return this.#finish(receipt, 'disabled', 'target-mounted-editor-unavailable');
        }
        receipt.anchor = await this.#reveal(request, entry, mounted, intent.anchor);
        this.#admit(request);
        if (receipt.anchor && (receipt.anchor.status !== 'ready' || !['exact', 'rebased'].includes(receipt.anchor.kind ?? '')))
        {
            return this.#finish(receipt, 'invalid', receipt.anchor.reason ?? `anchor-${receipt.anchor.kind}`);
        }
        const captured = this.#capture(entry, mounted);
        const anchor = captured.nodeId === null ? null : projectAuthoringNavigationAnchor(captured);
        receipt.observation = this.#observe(entry, anchor);
        if (receipt.observation.status !== 'current')
        {
            return this.#finish(receipt, 'invalid', receipt.observation.status);
        }
        await this.#updateRoute(request, entry, intent.routePolicy, 'activation');
        this.#admit(request);
        if (this.#capture(entry, mounted).document.contextDigest !== captured.document.contextDigest)
        {
            return this.#finish(receipt, 'invalid', 'mounted-context-changed-before-append');
        }
        request.acknowledgedAdmission?.();
        const transition = this.#command(request, { kind: 'append', visit: {
            entryId: `visit:${request.requestId}`, identity: entry.identity, documentContext: entry.documentContext,
            anchor, owningGroupId: entry.owningGroupId, targetGroupId: entry.owningGroupId,
            cause: intent.entrypoint === 'direct-route' ? 'internal-link' : intent.entrypoint,
            userActionId: request.requestId, userSequence: request.sequence, userInitiatedAt: intent.initiatedAt,
            recordedAt: intent.initiatedAt, validity: receipt.observation, recentRestore: intent.recentRestore
        } });
        return this.#finish(receipt, ['applied', 'coalesced'].includes(transition.receipt.status) ? 'completed' : 'invalid',
            ['applied', 'coalesced'].includes(transition.receipt.status) ? null : transition.receipt.status);
    }

    async #traverse(request: Request, direction: 'back' | 'forward'): Promise<AuthoringNavigationEntrypointReceipt>
    {
        this.#admit(request);
        const receipt = this.#receipt(request.requestId, request.sequence, direction, 'invalid', null);
        request.receipt = receipt;
        const before = this.history.exportState();
        const target = before.entries[before.cursor + (direction === 'back' ? -1 : 1)];
        if (!target)
        {
            return this.#finish(receipt, 'invalid', 'history-boundary');
        }
        const sourceEntry = this.#registry.listEntries().find(value => value.isActive);
        if (sourceEntry)
        {
            const source = this.#mounted!.current(sourceEntry);
            if (!source)
            {
                return this.#finish(receipt, 'disabled', 'source-mounted-editor-unavailable');
            }
            receipt.sourceAnchorDigest = this.#capture(sourceEntry, source).contentDigest;
        }
        let entry = this.#registry.getEntryByIdentity(target.identity);
        if (entry && !same(entry.identity, target.identity))
        {
            return this.#finish(receipt, 'invalid', 'same-id-document-recreated');
        }
        // An absent Registry entry is unknown. Only the original server selection/revalidation port may reopen it.
        if (!entry)
        {
            if (!this.#selection)
            {
                return this.#finish(receipt, 'disabled', 'history-target-requires-server-selection-revalidation');
            }
            const revision = this.#registry.getRevision();
            const selected = await this.#selection.resolveUnopened(target.identity, request.controller.signal);
            this.#admit(request);
            if (!same(before, this.history.exportState()) || revision !== this.#registry.getRevision())
            {
                return this.#finish(receipt, 'stale', 'history-or-registry-changed-during-selection');
            }
            if (selected?.expectedRevision !== revision || !same(selected.identity, target.identity)
                || !same(selected.documentContext, target.documentContext) || selected.status.permission !== 'allowed'
                || selected.status.lifecycle !== 'current')
            {
                return this.#finish(receipt, 'invalid', 'server-selection-not-current');
            }
            const groups = this.#groups.exportState();
            if (!groups.groups.some(group => group.groupId === target.owningGroupId))
            {
                return this.#finish(receipt, 'invalid', 'group-missing');
            }
            receipt.open = this.#registry.openOrActivate({ ...selected, commandId: request.requestId, idempotencyKey: request.requestId,
                expectedRevision: revision, targetGroupId: target.owningGroupId });
            this.#admit(request);
            entry = receipt.open.tabId ? this.#registry.getEntry(receipt.open.tabId) : null;
            if (!entry || !['applied', 'activated-existing', 'replayed'].includes(receipt.open.status))
            {
                return this.#finish(receipt, 'invalid', receipt.open.reason ?? receipt.open.status);
            }
            request.groupRevision = this.#groups.exportState().revision;
        }
        const mounted = this.#mounted!.current(entry) ?? await this.#mounted!.wait(entry, request.controller.signal);
        this.#admit(request);
        if (!mounted)
        {
            return this.#finish(receipt, 'disabled', 'target-mounted-editor-unavailable');
        }
        const captured = this.#capture(entry, mounted);
        const binding = this.#editor(entry, mounted);
        const anchorStatus = target.anchor && !binding.map.syntax.some(node => node.id === target.anchor?.nodeId) ? 'missing' : 'current';
        const observed = this.#observe(entry, captured.nodeId === null ? null : projectAuthoringNavigationAnchor(captured), target, anchorStatus);
        receipt.observation = observed;
        if (!same(target.documentContext, entry.documentContext) || !same(target.identity, entry.identity))
        {
            receipt.observation = { ...observed, status: 'stale-revision' };
        }
        else if (target.owningGroupId !== entry.owningGroupId)
        {
            receipt.observation = { ...observed, status: 'group-missing' };
        }
        const transition = this.#command(request, { kind: direction, entryId: target.entryId,
            expectedEntryDigest: target.contentDigest, validity: receipt.observation });
        if (!transition.state.pending || !transition.target || transition.receipt.status !== 'applied')
        {
            return this.#finish(receipt, 'invalid', receipt.observation.status === 'current' ? transition.receipt.status : receipt.observation.status);
        }
        request.pendingRef = transition.target.intentRef;
        this.#admit(request);
        receipt.open ??= this.#registry.openOrActivate({ schema: openArticleDocumentCommandSchema, kind: 'open-or-activate',
            commandId: request.requestId, idempotencyKey: request.requestId, expectedRevision: this.#registry.getRevision(),
            intent: 'workspace', entrypoint: 'direct-route', identity: entry.identity, documentContext: entry.documentContext,
            editorSessionRef: entry.editorSessionRef, tabId: entry.tabId, targetGroupId: entry.owningGroupId,
            tabKind: entry.isPinned ? 'pinned' : 'preview', status: entry.status, lastActiveAnchorRef: entry.lastActiveAnchorRef });
        this.#admit(request);
        const opened = receipt.open.tabId ? this.#registry.getEntry(receipt.open.tabId) : null;
        if (!opened || !['applied', 'activated-existing', 'replayed'].includes(receipt.open.status))
        {
            this.#settle(request, 'failed');
            return this.#finish(receipt, 'invalid', receipt.open.reason ?? receipt.open.status);
        }
        request.groupRevision = this.#groups.exportState().revision;
        const currentMounted = await this.#mounted!.wait(opened, request.controller.signal);
        this.#admit(request);
        if (!currentMounted)
        {
            this.#settle(request, 'failed');
            return this.#finish(receipt, 'disabled', 'target-mounted-editor-unavailable');
        }
        receipt.anchor = await this.#reveal(request, opened, currentMounted, target.anchor);
        this.#admit(request);
        if (receipt.anchor && (receipt.anchor.status !== 'ready' || !['exact', 'rebased'].includes(receipt.anchor.kind ?? '')))
        {
            this.#settle(request, 'failed');
            return this.#finish(receipt, 'invalid', receipt.anchor.reason ?? `anchor-${receipt.anchor.kind}`);
        }
        await this.#updateRoute(request, opened, 'replace', 'history-navigation');
        this.#admit(request);
        request.acknowledgedAdmission?.();
        const settled = this.#settle(request, 'completed');
        if (!settled)
        {
            return this.#finish(receipt, 'stale', 'history-pending-changed');
        }
        return this.#finish(receipt, settled.receipt.status === 'applied' ? 'completed' : 'invalid',
            settled.receipt.status === 'applied' ? null : settled.receipt.status);
    }

    #receipt(requestId: string, sequence: number, entrypoint: AuthoringNavigationEntrypointReceipt['entrypoint'],
        status: AuthoringNavigationEntrypointReceipt['status'], reason: string | null): AuthoringNavigationEntrypointReceipt
    {
        return seal({ schema: authoringNavigationEntrypointSchema, requestId, sequence, entrypoint, status, reason,
            sourceAnchorDigest: null, observation: null, open: null, anchor: null, history: [], commands: [], groupFallback: false });
    }

    #finish(receipt: AuthoringNavigationEntrypointReceipt, status: AuthoringNavigationEntrypointReceipt['status'],
        reason: string | null): AuthoringNavigationEntrypointReceipt
    {
        const body = { ...receipt };
        Reflect.deleteProperty(body, 'contentDigest');
        return seal({ ...body, status, reason });
    }
}
