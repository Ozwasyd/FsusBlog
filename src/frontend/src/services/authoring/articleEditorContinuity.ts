import type { MarkdownAttachmentBatchIntent, MarkdownAttachmentFileConsumer, MarkdownAttachmentItemIntent, MarkdownAttachmentTerminalObservation, MarkdownAttachmentTerminalConsumer, MarkdownAttachmentTerminalRevisionIssuer, MarkdownAttachmentTerminalApplicationEndIssuer } from '@/fsusui/articleAttachments';
import type { MarkdownEditorDispatchResult, MarkdownEditorResolvedSelection, MarkdownEditorSessionExpose } from '@/fsusui/articlePositionMaps';
import type { FsusUiAuthoringCommand } from '@/fsusui/authoringCommands';

import {
    validateArticleAnchorCommand,
    validateArticleAnchorContext,
    type ArticleAnchorCaptureOptions,
    type ArticleAnchorCommand,
    type ArticleAnchorContext,
    type ArticleAnchorContextAdapter,
    type ArticleAnchorSurface,
    type ArticleAnchorTool,
    type ArticlePositionMapBinding
} from './articleAnchorContext';
import {
    createArticleDocumentContext,
    validateArticleDocumentContext,
    validateArticleDocumentTaskEnvelope,
    type ArticleDocumentContext,
    type ArticleDocumentContextAdapter,
    type ArticleDocumentTaskKind,
    type ArticleDocumentTaskLease
} from './articleDocumentContext';
import {
    validateArticleRenderReceipt,
    validateArticleRenderState,
    type ArticleRenderCache,
    type ArticleRenderReceipt,
    type ArticleRenderRefreshWork,
    type ArticleRenderState
} from './articleRenderCache';
import { calculateOpenArticleDocumentDigest as digest } from './openArticleDocumentRegistry';

export const articleEditorContinuitySchema = 'fsusblog.article-editor-continuity.v1' as const;
export const articleEditorContinuityReceiptSchema = 'fsusblog.article-editor-continuity-receipt.v1' as const;
export const articleEditorContinuityAckSchema = 'fsusblog.article-editor-continuity-ack.v1' as const;

/** The terminal belongs to the same render work, never to native restoration. */
export interface ArticleEditorContinuityRefreshWork {
    readonly renderWork: ArticleRenderRefreshWork;
    readonly receipt: Promise<ArticleEditorContinuityReceipt>;
    readonly terminal: Promise<void>;
}
export const articleEditorToolEvents = [
    'publish-preview-open', 'publish-preview-close', 'source-compare-open', 'source-compare-close'
] as const;

type Transaction = Parameters<Parameters<FsusUiAuthoringCommand['run']>[0]['dispatch']['dispatch']>[0];
type History = MarkdownEditorDispatchResult['history'];
type RestoreOptions = Parameters<ArticleAnchorContextAdapter['restore']>[2];
type Focus = 'editor' | 'outside' | 'unobserved';

/** Bind the actual exposed editor object for this session; implicit state capture and focus APIs are unavailable. */
export interface ArticleEditorContinuityPort
{
    dispatchTransaction(transaction: Transaction): MarkdownEditorDispatchResult;
    getAttachmentTerminalRevisionIssuer?(): MarkdownAttachmentTerminalRevisionIssuer;
    getAttachmentTerminalApplicationEndIssuer?(): MarkdownAttachmentTerminalApplicationEndIssuer;
    withAttachmentTerminalTransaction?(observation: MarkdownAttachmentTerminalObservation,
        consume: MarkdownAttachmentTerminalConsumer): boolean;
    /** Original mounted editor File loan; absent capability must remain unavailable. */
    withAttachmentFile?(batch: MarkdownAttachmentBatchIntent, item: MarkdownAttachmentItemIntent,
        consume: MarkdownAttachmentFileConsumer): boolean;
}

/** The actual public mounted object, with both transaction and retained session methods. */
export type ArticleEditorMountedSessionPort = ArticleEditorContinuityPort & MarkdownEditorSessionExpose;

export interface ArticleContinuityTaskRef
{
    readonly taskRef: string;
    readonly kind: ArticleDocumentTaskKind;
    readonly contextDigest: string;
    readonly envelopeDigest: string;
}

export interface ArticleContinuityTaskOwners
{
    readonly search: ArticleDocumentTaskLease | null;
    readonly outline: ArticleDocumentTaskLease | null;
    readonly attachments: readonly ArticleDocumentTaskLease[];
    readonly diagnostic: ArticleDocumentTaskLease | null;
}

export interface ArticleEditorContinuityContext
{
    readonly schema: typeof articleEditorContinuitySchema;
    readonly document: ArticleDocumentContext;
    readonly instanceRef: string;
    readonly sessionRef: string;
    readonly historyRef: string;
    readonly history: History;
    readonly anchor: ArticleAnchorContext;
    readonly focus: Focus;
    readonly stateRefs: {
        readonly search: ArticleContinuityTaskRef | null;
        readonly outline: ArticleContinuityTaskRef | null;
        readonly attachments: readonly ArticleContinuityTaskRef[];
        readonly diagnostic: ArticleContinuityTaskRef | null;
    };
    readonly render: ArticleRenderState;
    readonly contentDigest: string;
}

export interface ArticleEditorContinuityReceipt
{
    readonly schema: typeof articleEditorContinuityReceiptSchema;
    readonly requestRef: string;
    readonly action: 'surface' | typeof articleEditorToolEvents[number] | 'refresh' | 'outline' | 'search';
    readonly before: ArticleEditorContinuityContext;
    readonly after: ArticleEditorContinuityContext | null;
    readonly targetSurface: ArticleAnchorSurface;
    readonly targetTool: ArticleAnchorTool;
    readonly status: 'captured' | 'planned' | 'awaiting-ack' | 'restored' | 'paused' | 'rejected';
    readonly reason: string | null;
    readonly anchorCommand: ArticleAnchorCommand | null;
    readonly renderReceipt: ArticleRenderReceipt | null;
    readonly acknowledgement: ArticleEditorContinuityAcknowledgement | null;
    readonly focusAcknowledged: boolean;
    readonly viewportAcknowledged: boolean;
    readonly contentDigest: string;
}

/** Produced by the controlled surface/focus/viewport owners after real public events, not dispatch admission. */
export interface ArticleEditorContinuityAcknowledgement
{
    readonly schema: typeof articleEditorContinuityAckSchema;
    readonly requestRef: string;
    readonly document: ArticleDocumentContext;
    readonly instanceRef: string;
    readonly sessionRef: string;
    readonly historyRef: string;
    readonly history: History;
    readonly selection: MarkdownEditorResolvedSelection;
    readonly surface: ArticleAnchorSurface;
    readonly tool: ArticleAnchorTool;
    readonly generation: number;
    readonly focus: Focus;
    readonly focusEvent: 'focusin' | 'focusout' | 'unobserved';
    readonly viewportOffset: number | null;
    readonly contentDigest: string;
}

const contextKeys = ['schema', 'document', 'instanceRef', 'sessionRef', 'historyRef', 'history', 'anchor', 'focus', 'stateRefs', 'render', 'contentDigest'];
const receiptKeys = ['schema', 'requestRef', 'action', 'before', 'after', 'targetSurface', 'targetTool', 'status', 'reason', 'anchorCommand', 'renderReceipt', 'acknowledgement', 'focusAcknowledged', 'viewportAcknowledged', 'contentDigest'];
const ackKeys = ['schema', 'requestRef', 'document', 'instanceRef', 'sessionRef', 'historyRef', 'history', 'selection', 'surface', 'tool', 'generation', 'focus', 'focusEvent', 'viewportOffset', 'contentDigest'];
const historyKeys = ['canRedo', 'canUndo', 'redoDepth', 'retainedUnits', 'undoDepth'];
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const ref = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/u.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const surface = (value: unknown): value is ArticleAnchorSurface => value === 'live' || value === 'source';
const tool = (value: unknown): value is ArticleAnchorTool => value === 'none' || value === 'publish-preview' || value === 'source-compare';
const focus = (value: unknown): value is Focus => value === 'editor' || value === 'outside' || value === 'unobserved';
const same = (a: ArticleDocumentContext, b: ArticleDocumentContext): boolean =>
    a.documentId === b.documentId && a.documentEpoch === b.documentEpoch && a.articleId === b.articleId &&
    a.draftId === b.draftId && a.editorSessionId === b.editorSessionId && a.siteScope === b.siteScope && a.userScope === b.userScope;
const validHistory = (value: unknown): value is History => exact(value, historyKeys) &&
    typeof value.canRedo === 'boolean' && typeof value.canUndo === 'boolean' &&
    ['redoDepth', 'retainedUnits', 'undoDepth'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0) &&
    value.canRedo === (Number(value.redoDepth) > 0) && value.canUndo === (Number(value.undoDepth) > 0);
const validSelection = (value: unknown): value is MarkdownEditorResolvedSelection => exact(value, ['start', 'end', 'direction']) &&
    Number.isSafeInteger(value.start) && Number(value.start) >= 0 && Number.isSafeInteger(value.end) && Number(value.end) >= Number(value.start) &&
    typeof value.direction === 'string' && ['forward', 'backward', 'none'].includes(value.direction);
const seal = <T extends object>(value: T): T & { readonly contentDigest: string; } =>
{
    const snapshot = structuredClone(value);
    const frozen = { ...snapshot, contentDigest: digest(snapshot) };
    const freeze = (item: unknown): void =>
    {
        if (item !== null && typeof item === 'object')
        {
            Object.values(item).forEach(freeze);
            Object.freeze(item);
        }
    };
    freeze(frozen);
    return frozen;
};
const sealed = (value: Record<string, unknown>): boolean =>
{
    const { contentDigest, ...unsigned } = value;
    return hash(contentDigest) && contentDigest === digest(unsigned);
};
const validTaskRef = (value: unknown, document: ArticleDocumentContext, kind: ArticleDocumentTaskKind): boolean =>
    value === null || exact(value, ['taskRef', 'kind', 'contextDigest', 'envelopeDigest']) && ref(value.taskRef) &&
    value.kind === kind &&
    value.contextDigest === document.contextDigest && hash(value.envelopeDigest);

export function validateArticleEditorContinuityContext(value: unknown): value is ArticleEditorContinuityContext
{
    if (!exact(value, contextKeys) || value.schema !== articleEditorContinuitySchema || !validateArticleDocumentContext(value.document) ||
        !ref(value.instanceRef) || value.sessionRef !== value.document.editorSessionId || !ref(value.historyRef) || !validHistory(value.history) ||
        value.historyRef !== `history:${digest({ instanceRef: value.instanceRef, sessionRef: value.sessionRef, history: value.history })}` ||
        !validateArticleAnchorContext(value.anchor) || value.anchor.document.contextDigest !== value.document.contextDigest ||
        !focus(value.focus) || !exact(value.stateRefs, ['search', 'outline', 'attachments', 'diagnostic']) ||
        !validTaskRef(value.stateRefs.search, value.document, 'search') || !validTaskRef(value.stateRefs.outline, value.document, 'outline') ||
        !validTaskRef(value.stateRefs.diagnostic, value.document, 'feature') || !Array.isArray(value.stateRefs.attachments) ||
        value.stateRefs.attachments.length > 128 || value.stateRefs.attachments.some(item => item === null || !validTaskRef(item, value.document as ArticleDocumentContext, 'attachment')) ||
        new Set(value.stateRefs.attachments.map(item => (item as ArticleContinuityTaskRef).taskRef)).size !== value.stateRefs.attachments.length ||
        !validateArticleRenderState(value.render) || value.render.currentRevision !== value.document.sourceRevision ||
        value.render.content !== null && !same(value.render.content.context, value.document))
    {
        return false;
    }
    return sealed(value);
}

export function validateArticleEditorContinuityReceipt(value: unknown): value is ArticleEditorContinuityReceipt
{
    if (!(exact(value, receiptKeys) && value.schema === articleEditorContinuityReceiptSchema && ref(value.requestRef) &&
        typeof value.action === 'string' && ['surface', ...articleEditorToolEvents, 'refresh', 'outline', 'search'].includes(value.action) &&
        validateArticleEditorContinuityContext(value.before) &&
        (value.after === null || validateArticleEditorContinuityContext(value.after) && same(value.before.document, value.after.document) &&
            value.after.instanceRef === value.before.instanceRef && value.after.sessionRef === value.before.sessionRef) &&
        surface(value.targetSurface) && tool(value.targetTool) &&
        typeof value.status === 'string' && ['captured', 'planned', 'awaiting-ack', 'restored', 'paused', 'rejected'].includes(value.status) &&
        (value.reason === null || ref(value.reason)) &&
        (value.anchorCommand === null || validateArticleAnchorCommand(value.anchorCommand) && value.anchorCommand.beforeDigest === value.before.anchor.contentDigest) &&
        (value.renderReceipt === null || validateArticleRenderReceipt(value.renderReceipt)) &&
        (value.acknowledgement === null || validateArticleEditorContinuityAcknowledgement(value.acknowledgement)) &&
        typeof value.focusAcknowledged === 'boolean' && typeof value.viewportAcknowledged === 'boolean' &&
        (value.status !== 'restored' || value.after !== null && value.focusAcknowledged === true && value.viewportAcknowledged === true &&
            (value.after).anchor.surface === value.targetSurface &&
            (value.after).anchor.tool === value.targetTool) && sealed(value)))
    {
        return false;
    }
    const receipt = value as unknown as ArticleEditorContinuityReceipt;
    const ack = receipt.acknowledgement;
    if (receipt.renderReceipt !== null && receipt.renderReceipt.task.context.contextDigest !== receipt.before.document.contextDigest)
    {
        return false;
    }
    if ((receipt.focusAcknowledged || receipt.viewportAcknowledged) &&
        (ack === null || (receipt.status !== 'awaiting-ack' && receipt.status !== 'restored')))
    {
        return false;
    }
    if (ack !== null && (ack.requestRef !== receipt.requestRef || ack.instanceRef !== receipt.before.instanceRef ||
        ack.sessionRef !== receipt.before.sessionRef || ack.surface !== receipt.targetSurface || ack.tool !== receipt.targetTool ||
        ack.document.contextDigest !== receipt.anchorCommand?.document.contextDigest ||
        ack.generation !== receipt.anchorCommand.generation || receipt.anchorCommand.range === null ||
        digest(ack.selection) !== digest({ ...receipt.anchorCommand.range, direction: receipt.anchorCommand.direction })))
    {
        return false;
    }
    if (ack !== null && (receipt.focusAcknowledged !== (ack.focus !== 'unobserved' && ack.focus === receipt.before.focus &&
        ack.focusEvent === (ack.focus === 'editor' ? 'focusin' : 'focusout')) ||
        receipt.viewportAcknowledged !== (ack.viewportOffset !== null && ack.viewportOffset === receipt.anchorCommand?.viewportOffset)))
    {
        return false;
    }
    if (receipt.status !== 'restored')
    {
        return receipt.after === null;
    }
    const after = receipt.after;
    return ack !== null && after !== null && receipt.anchorCommand?.status === 'ready' &&
        after.document.contextDigest === ack.document.contextDigest && after.document.sourceRevision >= receipt.before.document.sourceRevision && after.historyRef === ack.historyRef &&
        digest(after.history) === digest(ack.history) &&
        (receipt.before.document.contextDigest !== after.document.contextDigest || digest(receipt.before.history) === digest(ack.history)) &&
        after.focus === receipt.before.focus && after.focus === ack.focus && ack.focus !== 'unobserved' &&
        ack.focusEvent === (ack.focus === 'editor' ? 'focusin' : 'focusout') &&
        ack.viewportOffset === receipt.anchorCommand.viewportOffset && after.anchor.viewportOffset === ack.viewportOffset &&
        digest({ ...after.anchor.range, direction: after.anchor.direction }) === digest(ack.selection);
}

export function validateArticleEditorContinuityAcknowledgement(value: unknown): value is ArticleEditorContinuityAcknowledgement
{
    return exact(value, ackKeys) && value.schema === articleEditorContinuityAckSchema && ref(value.requestRef) &&
        validateArticleDocumentContext(value.document) && ref(value.instanceRef) && value.sessionRef === value.document.editorSessionId &&
        validHistory(value.history) && value.historyRef === `history:${digest({ instanceRef: value.instanceRef, sessionRef: value.sessionRef, history: value.history })}` &&
        validSelection(value.selection) && surface(value.surface) && tool(value.tool) && Number.isSafeInteger(value.generation) && Number(value.generation) >= 0 &&
        focus(value.focus) && typeof value.focusEvent === 'string' && ['focusin', 'focusout', 'unobserved'].includes(value.focusEvent) &&
        (value.viewportOffset === null || typeof value.viewportOffset === 'number' && Number.isFinite(value.viewportOffset)) && sealed(value);
}

export function createArticleEditorContinuityAcknowledgement(
    value: Omit<ArticleEditorContinuityAcknowledgement, 'schema' | 'contentDigest'>
): ArticleEditorContinuityAcknowledgement
{
    if (!exact(value, ackKeys.filter(key => key !== 'schema' && key !== 'contentDigest')))
    {
        throw new Error('continuity-ack-input-invalid');
    }
    const acknowledgement = seal({ schema: articleEditorContinuityAckSchema, ...value });
    if (!validateArticleEditorContinuityAcknowledgement(acknowledgement))
    {
        throw new Error('continuity-ack-input-invalid');
    }
    return acknowledgement;
}

let instanceSequence = 0;

/** Owns continuity commands and evidence; the existing editor, document, anchor and render owners retain their state. */
export class ArticleEditorContinuityAdapter
{
    public readonly instanceRef = `editor-instance:${++instanceSequence}`;
    private observation: { document: ArticleDocumentContext; history: History; selection: MarkdownEditorResolvedSelection; sourceLength: number; } | null = null;
    private focusState: Focus = 'unobserved';
    private sequence = 0;
    private currentSurface: ArticleAnchorSurface;
    private currentTool: ArticleAnchorTool = 'none';
    private taskOwners: ArticleContinuityTaskOwners = { search: null, outline: null, attachments: [], diagnostic: null };
    private bookmark: ArticleEditorContinuityContext | null = null;
    private pending: { receipt: ArticleEditorContinuityReceipt; binding: ArticlePositionMapBinding; options: ArticleAnchorCaptureOptions; } | null = null;
    private readonly log: ArticleEditorContinuityReceipt[] = [];
    private readonly unsubscribe: () => void;
    private disposed = false;
    private refreshing = false;
    private readonly owner: ArticleDocumentContextAdapter;
    private readonly anchors: ArticleAnchorContextAdapter;
    private readonly cache: ArticleRenderCache;
    private readonly editor: ArticleEditorContinuityPort;

    public constructor(
        owner: ArticleDocumentContextAdapter,
        anchors: ArticleAnchorContextAdapter,
        cache: ArticleRenderCache,
        editor: ArticleEditorContinuityPort,
        initialSurface: ArticleAnchorSurface
    )
    {
        this.owner = owner;
        this.anchors = anchors;
        this.cache = cache;
        this.editor = editor;
        if (!surface(initialSurface) || typeof editor.dispatchTransaction !== 'function')
        {
            throw new Error('continuity-input-invalid');
        }
        this.currentSurface = initialSurface;
        let previous = owner.context;
        this.unsubscribe = owner.subscribeContext(document =>
        {
            this.observation = null;
            this.pending = null;
            if (document === null || !same(previous, document))
            {
                this.bookmark = null;
                this.currentTool = 'none';
                this.focusState = 'unobserved';
                this.taskOwners = { search: null, outline: null, attachments: [], diagnostic: null };
            }
            if (document?.userScope !== previous.userScope)
            {
                this.log.length = 0;
            }
            if (document !== null)
            {
                previous = document;
            }
            else
            {
                this.disposed = true;
            }
        });
    }

    public get receipts(): readonly ArticleEditorContinuityReceipt[]
    {
        return this.log.slice();
    }
    public get renderState(): ArticleRenderState
    {
        const state = this.cache.state;
        if (!validateArticleRenderState(state) || state.currentRevision !== this.owner.context.sourceRevision ||
            state.content !== null && !same(state.content.context, this.owner.context))
        {
            throw new Error('continuity-render-owner-mismatch');
        }
        return state;
    }

    public observeTransaction(instance: ArticleEditorContinuityPort, result: MarkdownEditorDispatchResult): boolean
    {
        const document = this.owner.context;
        if (this.disposed || instance !== this.editor || !result.accepted || typeof result.value !== 'string' ||
            !Number.isSafeInteger(result.beforeRevision) || result.beforeRevision < 0 || !validHistory(result.history) || !validSelection(result.selection) ||
            result.documentIdentity?.id !== document.documentId || result.documentIdentity.epoch !== document.documentEpoch ||
            result.revision !== document.sourceRevision || result.beforeRevision > result.revision || result.selection.end > result.value.length)
        {
            return false;
        }
        try
        {
            if (createArticleDocumentContext({ ...document, content: result.value }).contextDigest !== document.contextDigest)
            {
                return false;
            }
        }
        catch
        {
            return false;
        }
        this.observation = { document, history: structuredClone(result.history), selection: structuredClone(result.selection), sourceLength: result.value.length };
        return true;
    }

    public observeSelection(instance: ArticleEditorContinuityPort, event: {
        document: ArticleDocumentContext; revision: number; selection: MarkdownEditorResolvedSelection;
    }): boolean
    {
        if (instance !== this.editor || !exact(event, ['document', 'revision', 'selection']) || !this.owner.isCurrentContext(event.document) ||
            event.revision !== event.document.sourceRevision || !validSelection(event.selection) ||
            this.observation?.document.contextDigest !== event.document.contextDigest || event.selection.end > this.observation.sourceLength)
        {
            return false;
        }
        this.observation.selection = structuredClone(event.selection);
        return true;
    }

    public observeFocus(instance: ArticleEditorContinuityPort, event: { document: ArticleDocumentContext; event: 'focusin' | 'focusout'; }): boolean
    {
        if (this.disposed || instance !== this.editor || !exact(event, ['document', 'event']) ||
            !this.owner.isCurrentContext(event.document) || !['focusin', 'focusout'].includes(event.event))
        {
            return false;
        }
        this.focusState = event.event === 'focusin' ? 'editor' : 'outside';
        return true;
    }

    public setTaskOwners(tasks: ArticleContinuityTaskOwners): void
    {
        if (!exact(tasks, ['search', 'outline', 'attachments', 'diagnostic']) || !Array.isArray(tasks.attachments) || tasks.attachments.length > 128)
        {
            throw new Error('continuity-task-input-invalid');
        }
        if (new Set(tasks.attachments).size !== tasks.attachments.length)
        {
            throw new Error('continuity-task-input-invalid');
        }
        const previous = this.taskOwners;
        this.taskOwners = { ...tasks, attachments: tasks.attachments.map((lease: ArticleDocumentTaskLease) => lease) };
        try
        {
            this.stateRefs();
        }
        catch (error)
        {
            this.taskOwners = previous;
            throw error;
        }
    }

    /** Update the borrowed search lease without replacing outline, attachment or diagnostic owners. */
    public setSearchTaskOwner(lease: ArticleDocumentTaskLease | null): void
    {
        this.setTaskOwners({ ...this.taskOwners, search: lease });
    }

    public capture(binding: ArticlePositionMapBinding, options: ArticleAnchorCaptureOptions): ArticleEditorContinuityContext
    {
        if (this.disposed || this.observation?.document.contextDigest !== this.owner.context.contextDigest ||
            options.surface !== this.currentSurface || options.tool !== this.currentTool)
        {
            throw new Error('continuity-observation-required');
        }
        const anchor = this.anchors.capture(binding, this.observation.selection, options);
        const history = this.observation.history;
        return seal({ schema: articleEditorContinuitySchema, document: this.owner.context, instanceRef: this.instanceRef,
            sessionRef: this.owner.context.editorSessionId,
            historyRef: `history:${digest({ instanceRef: this.instanceRef, sessionRef: this.owner.context.editorSessionId, history })}`,
            history, anchor, focus: this.focusState, stateRefs: this.stateRefs(), render: this.renderState });
    }

    public transitionSurface(target: ArticleAnchorSurface, binding: ArticlePositionMapBinding, capture: ArticleAnchorCaptureOptions, restore: RestoreOptions): ArticleEditorContinuityReceipt
    {
        if (!surface(target))
        {
            throw new Error('continuity-surface-invalid');
        }
        return this.plan('surface', this.capture(binding, capture), target, this.currentTool, binding, capture, restore);
    }

    public toolLifecycle(event: typeof articleEditorToolEvents[number], binding: ArticlePositionMapBinding, capture: ArticleAnchorCaptureOptions, restore: RestoreOptions): ArticleEditorContinuityReceipt
    {
        if (!articleEditorToolEvents.includes(event))
        {
            throw new Error('continuity-tool-event-invalid');
        }
        const target = event.startsWith('publish-preview') ? 'publish-preview' : 'source-compare';
        if (event.endsWith('-open'))
        {
            if (this.currentTool !== 'none' || this.pending !== null)
            {
                throw new Error('continuity-tool-already-active');
            }
            const before = this.capture(binding, capture);
            this.bookmark = before;
            this.currentTool = target;
            return this.record({ action: event, before, targetSurface: this.currentSurface, targetTool: target,
                status: 'captured', reason: null, anchorCommand: null, renderReceipt: null, after: null });
        }
        if (this.currentTool !== target || this.bookmark === null)
        {
            throw new Error('continuity-tool-not-active');
        }
        const before = this.bookmark;
        const receipt = this.plan(event, before, before.anchor.surface, 'none', binding, { ...capture, tool: 'none' }, restore);
        this.currentTool = 'none';
        this.bookmark = null;
        return receipt;
    }

    /** Dispatch admission preserves the real history but remains pending until owner acknowledgements arrive. */
    public apply(requestRef: string): ArticleEditorContinuityReceipt
    {
        const pending = this.pending;
        if (this.disposed || pending?.receipt.requestRef !== requestRef || pending.receipt.status !== 'planned' ||
            !pending.receipt.anchorCommand || !this.owner.isCurrentContext(pending.receipt.anchorCommand.document))
        {
            throw new Error('continuity-plan-not-current');
        }
        const command = pending.receipt.anchorCommand;
        if (this.anchors.userIntent.state === 'manual' || this.anchors.userIntent.generation !== command.intent.generation)
        {
            return this.update(pending.receipt, { status: 'paused', reason: 'user-scroll-priority' });
        }
        if (command.range === null)
        {
            return this.update(pending.receipt, { status: 'rejected', reason: 'continuity-approximate-requires-owner' });
        }
        const previous = this.observation;
        let result: MarkdownEditorDispatchResult;
        try
        {
            result = this.editor.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic',
                documentIdentity: this.owner.documentIdentity, expectedRevision: command.document.sourceRevision,
                selection: { ...command.range, direction: command.direction },
                metadata: { continuityRequest: requestRef, origin: command.origin, generation: command.generation } });
        }
        catch
        {
            return this.update(pending.receipt, { status: 'rejected', reason: 'continuity-dispatch-failed' });
        }
        if (!this.observeTransaction(this.editor, result) || result.beforeRevision !== result.revision ||
            previous === null || digest(previous.history) !== digest(result.history) ||
            digest(result.selection) !== digest({ ...command.range, direction: command.direction }))
        {
            return this.update(pending.receipt, { status: 'rejected', reason: 'continuity-dispatch-invalid' });
        }
        return this.update(pending.receipt, { status: 'awaiting-ack', reason: 'continuity-owner-ack-required' });
    }

    public acknowledge(instance: ArticleEditorContinuityPort, input: unknown): ArticleEditorContinuityReceipt | null
    {
        const pending = this.pending;
        if (this.disposed || instance !== this.editor || pending?.receipt.status !== 'awaiting-ack' || !validateArticleEditorContinuityAcknowledgement(input) ||
            !this.owner.isCurrentContext(input.document) || input.requestRef !== pending.receipt.requestRef || input.instanceRef !== this.instanceRef ||
            input.sessionRef !== this.owner.context.editorSessionId || input.surface !== pending.receipt.targetSurface || input.tool !== pending.receipt.targetTool ||
            !validSelection(input.selection) || !validHistory(input.history) || !focus(input.focus) ||
            !['focusin', 'focusout', 'unobserved'].includes(input.focusEvent) ||
            input.generation !== pending.receipt.anchorCommand?.generation ||
            this.anchors.userIntent.state === 'manual' || this.anchors.userIntent.generation !== pending.receipt.anchorCommand.intent.generation ||
            this.observation?.document.contextDigest !== this.owner.context.contextDigest ||
            input.focus !== 'unobserved' && input.focus !== this.focusState ||
            digest(input.selection) !== digest(this.observation.selection) || digest(input.history) !== digest(this.observation.history) ||
            digest(input.selection) !== digest({ ...pending.receipt.anchorCommand.range, direction: pending.receipt.anchorCommand.direction }))
        {
            return null;
        }
        const historyRef = `history:${digest({ instanceRef: this.instanceRef, sessionRef: this.owner.context.editorSessionId, history: this.observation.history })}`;
        if (input.historyRef !== historyRef)
        {
            return null;
        }
        const focusAcknowledged = input.focus !== 'unobserved' && input.focus === pending.receipt.before.focus &&
            input.focusEvent === (input.focus === 'editor' ? 'focusin' : 'focusout');
        const viewportAcknowledged = typeof input.viewportOffset === 'number' && Number.isFinite(input.viewportOffset) &&
            input.viewportOffset === pending.receipt.anchorCommand.viewportOffset;
        if (!focusAcknowledged || !viewportAcknowledged)
        {
            return this.update(pending.receipt, { focusAcknowledged, viewportAcknowledged, acknowledgement: input });
        }
        this.currentSurface = input.surface;
        this.currentTool = input.tool;
        this.focusState = input.focus;
        const after = this.capture(pending.binding, { ...pending.options, surface: this.currentSurface, tool: this.currentTool,
            viewportOffset: pending.receipt.anchorCommand.viewportOffset });
        return this.update(pending.receipt, { after, status: 'restored', reason: null, focusAcknowledged, viewportAcknowledged, acknowledgement: input });
    }

    public async refresh(binding: ArticlePositionMapBinding, capture: ArticleAnchorCaptureOptions, restore: RestoreOptions): Promise<ArticleEditorContinuityReceipt>
    {
        return this.startRefresh(binding, capture, restore).receipt;
    }

    public get pendingRefreshWork(): readonly ArticleRenderRefreshWork[]
    {
        return this.cache.pendingRefreshWork;
    }

    public startRefresh(binding: ArticlePositionMapBinding, capture: ArticleAnchorCaptureOptions, restore: RestoreOptions): ArticleEditorContinuityRefreshWork
    {
        if (this.pending !== null || this.refreshing)
        {
            throw new Error('continuity-transition-pending');
        }
        const before = this.capture(binding, capture);
        this.refreshing = true;
        let renderWork: ArticleRenderRefreshWork;
        try
        {
            renderWork = this.cache.startRefresh();
        }
        catch (error)
        {
            this.refreshing = false;
            throw error;
        }
        const receipt = this.consumeRefresh(renderWork, before, binding, capture, restore);
        return Object.freeze({ renderWork, receipt, terminal: renderWork.terminal });
    }

    private async consumeRefresh(work: ArticleRenderRefreshWork, before: ArticleEditorContinuityContext,
        binding: ArticlePositionMapBinding, capture: ArticleAnchorCaptureOptions, restore: RestoreOptions): Promise<ArticleEditorContinuityReceipt>
    {
        let renderReceipt: ArticleRenderReceipt;
        try
        {
            renderReceipt = await work.receipt;
        }
        finally
        {
            this.refreshing = false;
        }
        if (this.disposed || !validateArticleRenderReceipt(renderReceipt) || !this.owner.isCurrentContext(before.document) ||
            renderReceipt.task.context.contextDigest !== before.document.contextDigest)
        {
            return this.record({ action: 'refresh', before, targetSurface: before.anchor.surface, targetTool: before.anchor.tool,
                status: 'rejected', reason: 'continuity-refresh-context-invalid', anchorCommand: null,
                renderReceipt: validateArticleRenderReceipt(renderReceipt) ? renderReceipt : null, after: null });
        }
        return this.plan('refresh', before, before.anchor.surface, before.anchor.tool, binding, capture,
            { ...restore, origin: 'refresh' }, renderReceipt);
    }

    public cancelRefresh(): void
    {
        this.cache.cancel();
    }

    /** Withdraw a plan without claiming that public asynchronous focus or viewport work completed. */
    public cancelRestoration(requestRef: string): ArticleEditorContinuityReceipt | null
    {
        const pending = this.pending;
        if (this.disposed || pending?.receipt.requestRef !== requestRef)
        {
            return null;
        }
        return this.update(pending.receipt, { status: 'rejected', reason: 'continuity-restoration-canceled',
            acknowledgement: null, focusAcknowledged: false, viewportAcknowledged: false });
    }

    /** Admission only: the tool producer remains responsible for verifying its actual result. */
    public inspectToolResult(lease: ArticleDocumentTaskLease, input: unknown): 'eligible' | 'stale' | 'invalid'
    {
        if (!exact(input, ['tool', 'taskRef', 'contextDigest', 'resultRef', 'resultDigest']) ||
            (input.tool !== 'publish-preview' && input.tool !== 'source-compare') || !ref(input.taskRef) ||
            !hash(input.contextDigest) || !ref(input.resultRef) || !hash(input.resultDigest) ||
            !validateArticleDocumentTaskEnvelope(lease.envelope) || input.taskRef !== lease.taskRef ||
            lease.envelope.kind !== (input.tool === 'publish-preview' ? 'preview' : 'compare'))
        {
            return 'invalid';
        }
        if (this.disposed || this.currentTool !== input.tool || input.contextDigest !== this.owner.context.contextDigest ||
            !this.owner.isTaskCurrent(lease as Parameters<ArticleDocumentContextAdapter['isTaskCurrent']>[0]))
        {
            return 'stale';
        }
        return 'eligible';
    }
    public dispose(): void
    {
        this.disposed = true;
        this.pending = null;
        this.observation = null;
        this.bookmark = null;
        this.taskOwners = { search: null, outline: null, attachments: [], diagnostic: null };
        this.log.length = 0;
        this.unsubscribe();
    }

    private stateRefs(): ArticleEditorContinuityContext['stateRefs']
    {
        const task = (lease: ArticleDocumentTaskLease | null, kind: ArticleDocumentTaskKind): ArticleContinuityTaskRef | null =>
        {
            if (lease === null)
            {
                return null;
            }
            const envelope = lease.envelope;
            if (!validateArticleDocumentTaskEnvelope(envelope) || envelope.kind !== kind)
            {
                throw new Error('continuity-task-owner-invalid');
            }
            // The document owner checks the real registered lease object, not a caller-supplied ref or isCurrent callback.
            if (!this.owner.isTaskCurrent(lease as Parameters<ArticleDocumentContextAdapter['isTaskCurrent']>[0]))
            {
                return null;
            }
            return { taskRef: envelope.taskRef, kind, contextDigest: envelope.context.contextDigest, envelopeDigest: envelope.envelopeDigest };
        };
        return { search: task(this.taskOwners.search, 'search'), outline: task(this.taskOwners.outline, 'outline'),
            attachments: this.taskOwners.attachments.map(lease => task(lease, 'attachment')).filter(value => value !== null),
            diagnostic: task(this.taskOwners.diagnostic, 'feature') };
    }

    private plan(
        action: ArticleEditorContinuityReceipt['action'], before: ArticleEditorContinuityContext, targetSurface: ArticleAnchorSurface,
        targetTool: ArticleAnchorTool, binding: ArticlePositionMapBinding, capture: ArticleAnchorCaptureOptions,
        restore: RestoreOptions, renderReceipt: ArticleRenderReceipt | null = null
    ): ArticleEditorContinuityReceipt
    {
        if (this.pending !== null)
        {
            throw new Error('continuity-transition-pending');
        }
        if (!validateArticleEditorContinuityContext(before) || before.instanceRef !== this.instanceRef || !same(before.document, this.owner.context))
        {
            throw new Error('continuity-before-invalid');
        }
        const origin = action === 'surface' ? 'surface' : action === 'refresh' ? 'refresh' : action === 'outline' || action === 'search' ? action : 'tool';
        const anchorCommand = this.anchors.restore(before.anchor, binding, { ...restore, origin });
        const receipt = this.record({ action, before, targetSurface, targetTool, status: anchorCommand.status === 'ready' ? 'planned' :
            anchorCommand.status === 'paused' ? 'paused' : 'rejected', reason: anchorCommand.reason, anchorCommand, renderReceipt, after: null });
        if (receipt.status === 'planned')
        {
            this.pending = { receipt, binding, options: capture };
        }
        return receipt;
    }

    private record(value: Omit<ArticleEditorContinuityReceipt, 'schema' | 'requestRef' | 'contentDigest' | 'focusAcknowledged' | 'viewportAcknowledged' | 'acknowledgement'>): ArticleEditorContinuityReceipt
    {
        const receipt = seal({ schema: articleEditorContinuityReceiptSchema, requestRef: `continuity:${++this.sequence}`,
            focusAcknowledged: false, viewportAcknowledged: false, acknowledgement: null, ...value });
        if (!this.disposed && receipt.before.document.userScope === this.owner.context.userScope)
        {
            this.log.push(receipt);
        }
        if (this.log.length > 64)
        {
            this.log.shift();
        }
        return receipt;
    }

    private update(receipt: ArticleEditorContinuityReceipt, changes: Partial<Omit<ArticleEditorContinuityReceipt, 'contentDigest'>>): ArticleEditorContinuityReceipt
    {
        const { contentDigest: previousDigest, ...unsigned } = receipt;
        void previousDigest;
        const next = seal({ ...unsigned, ...changes });
        this.log.push(next);
        if (this.log.length > 64)
        {
            this.log.shift();
        }
        if (this.pending?.receipt.requestRef === receipt.requestRef)
        {
            if (next.status === 'awaiting-ack' || next.status === 'planned')
            {
                this.pending.receipt = next;
            }
            else
            {
                this.pending = null;
            }
        }
        return next;
    }
}
