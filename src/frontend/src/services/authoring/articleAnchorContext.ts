import type {
    MarkdownAnchorAffinity,
    MarkdownAnchorMap,
    MarkdownEditorDispatchResult,
    MarkdownEditorResolvedSelection,
    MarkdownSourceRange
} from '@/fsusui/articlePositionMaps';

import {
    createArticleDocumentContext,
    validateArticleDocumentContext,
    type ArticleDocumentContext,
    type ArticleDocumentContextAdapter
} from './articleDocumentContext';
import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

export const articleAnchorContextSchema = 'fsusblog.article-anchor-context.v1' as const;
export const articleAnchorCommandSchema = 'fsusblog.article-anchor-command.v1' as const;
export const articleScrollIntentPolicy = Object.freeze({ idleResumeMs: 1200, syncDebounceMs: 16 });

export type ArticleAnchorSurface = 'live' | 'source';
export type ArticleAnchorTool = 'none' | 'publish-preview' | 'source-compare';
export type ArticleAnchorPane = 'source' | 'renderer';
export type ArticleAnchorOrigin = 'refresh' | 'surface' | 'tool' | 'outline' | 'search' | 'attachment' | 'typewriter' | 'sync';
export type ArticleManualScrollKind = 'wheel' | 'trackpad' | 'touch' | 'drag' | 'selection';
export type ArticleAnchorRestoreKind = 'exact' | 'rebased' | 'partial' | 'semantic-neighbor' | 'percentage';

export interface ArticleScrollIntent {
    readonly state: 'automatic' | 'manual';
    readonly pane: ArticleAnchorPane | null;
    readonly kind: ArticleManualScrollKind | null;
    readonly generation: number;
    readonly changedAt: number;
    readonly resume: 'initial' | 'input' | 'navigation' | 'idle' | null;
}

export interface ArticleAnchorContext {
    readonly schema: typeof articleAnchorContextSchema;
    readonly document: ArticleDocumentContext;
    readonly range: MarkdownSourceRange;
    readonly nodeId: string | null;
    readonly affinity: MarkdownAnchorAffinity;
    readonly direction: MarkdownEditorResolvedSelection['direction'];
    readonly viewportOffset: number;
    readonly percentage: number;
    readonly surface: ArticleAnchorSurface;
    readonly tool: ArticleAnchorTool;
    readonly intent: ArticleScrollIntent;
    readonly contentDigest: string;
}

/** The map is supplied by FsusUI, bound to the producer's document revision. */
export interface ArticlePositionMapBinding {
    readonly document: ArticleDocumentContext;
    readonly map: MarkdownAnchorMap;
}

export interface ArticleAnchorCaptureOptions {
    readonly affinity: MarkdownAnchorAffinity;
    readonly viewportOffset: number;
    readonly percentage: number;
    readonly surface: ArticleAnchorSurface;
    readonly tool: ArticleAnchorTool;
}

export interface ArticleAnchorCommand {
    readonly schema: typeof articleAnchorCommandSchema;
    readonly document: ArticleDocumentContext;
    readonly status: 'ready' | 'paused' | 'rejected' | 'unavailable';
    readonly reason: string | null;
    readonly kind: ArticleAnchorRestoreKind | null;
    readonly range: MarkdownSourceRange | null;
    readonly nodeId: string | null;
    readonly approximate: boolean;
    readonly percentage: number | null;
    readonly direction: MarkdownEditorResolvedSelection['direction'];
    readonly affinity: MarkdownAnchorAffinity;
    readonly viewportOffset: number;
    readonly behavior: 'instant' | 'smooth';
    readonly origin: ArticleAnchorOrigin;
    readonly generation: number;
    readonly intent: ArticleScrollIntent;
    readonly beforeDigest: string;
    readonly beforeAnchor: ArticleAnchorContext;
    readonly rebase: readonly ('mapped' | 'partial' | 'deleted')[];
    readonly surface: ArticleAnchorSurface;
    readonly tool: ArticleAnchorTool;
    readonly startedAt: number;
    readonly completedAt: number;
    readonly contentDigest: string;
}

const contextKeys = [
    'schema', 'document', 'range', 'nodeId', 'affinity', 'direction', 'viewportOffset',
    'percentage', 'surface', 'tool', 'intent', 'contentDigest'
];
const intentKeys = ['state', 'pane', 'kind', 'generation', 'changedAt', 'resume'];
const commandKeys = [
    'schema', 'document', 'status', 'reason', 'kind', 'range', 'nodeId', 'approximate',
    'percentage', 'direction', 'affinity', 'viewportOffset', 'behavior', 'origin',
    'generation', 'intent', 'beforeDigest', 'beforeAnchor', 'rebase', 'surface', 'tool', 'startedAt',
    'completedAt', 'contentDigest'
];
const manualKinds: readonly ArticleManualScrollKind[] = ['wheel', 'trackpad', 'touch', 'drag', 'selection'];
const origins: readonly ArticleAnchorOrigin[] = ['refresh', 'surface', 'tool', 'outline', 'search', 'attachment', 'typewriter', 'sync'];
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const member = (value: unknown, values: readonly string[]): boolean =>
    typeof value === 'string' && values.includes(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validRange = (value: unknown): value is MarkdownSourceRange =>
    exactKeys(value, ['start', 'end']) && Number.isSafeInteger(value.start)
    && Number.isSafeInteger(value.end) && Number(value.start) >= 0 && Number(value.end) >= Number(value.start);
const validIntent = (value: unknown): value is ArticleScrollIntent =>
    exactKeys(value, intentKeys) && member(value.state, ['automatic', 'manual'])
    && (value.pane === null || member(value.pane, ['source', 'renderer']))
    && (value.kind === null || manualKinds.includes(value.kind as ArticleManualScrollKind))
    && Number.isSafeInteger(value.generation) && Number(value.generation) >= 0
    && finite(value.changedAt) && value.changedAt >= 0
    && (value.state === 'manual'
        ? value.pane !== null && value.kind !== null && value.resume === null
        : member(value.resume, ['initial', 'input', 'navigation', 'idle']));

function sameDocument(left: ArticleDocumentContext, right: ArticleDocumentContext): boolean
{
    return left.documentId === right.documentId && left.documentEpoch === right.documentEpoch
        && left.articleId === right.articleId && left.draftId === right.draftId
        && left.editorSessionId === right.editorSessionId && left.userScope === right.userScope
        && left.siteScope === right.siteScope;
}

function seal<T extends object>(value: T): Readonly<T & { contentDigest: string; }>
{
    const frozen = { ...value, contentDigest: calculateOpenArticleDocumentDigest(value) };
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
}

function validSeal(value: Record<string, unknown>): boolean
{
    const { contentDigest, ...body } = value;
    return contentDigest === calculateOpenArticleDocumentDigest(body);
}

export function validateArticleAnchorContext(value: unknown): value is ArticleAnchorContext
{
    return exactKeys(value, contextKeys) && value.schema === articleAnchorContextSchema
        && validateArticleDocumentContext(value.document) && validRange(value.range)
        && (value.nodeId === null || typeof value.nodeId === 'string' && value.nodeId.length > 0)
        && member(value.affinity, ['before', 'after'])
        && member(value.direction, ['forward', 'backward', 'none'])
        && finite(value.viewportOffset) && finite(value.percentage) && value.percentage >= 0 && value.percentage <= 1
        && member(value.surface, ['live', 'source'])
        && member(value.tool, ['none', 'publish-preview', 'source-compare'])
        && validIntent(value.intent) && validSeal(value);
}

export function validateArticleAnchorCommand(value: unknown): value is ArticleAnchorCommand
{
    if (!exactKeys(value, commandKeys) || value.schema !== articleAnchorCommandSchema
        || !validateArticleDocumentContext(value.document) || !validIntent(value.intent) || !validSeal(value))
    {
        return false;
    }
    const ready = value.status === 'ready';
    const percentage = value.kind === 'percentage';
    return member(value.status, ['ready', 'paused', 'rejected', 'unavailable'])
        && (ready ? value.reason === null : typeof value.reason === 'string')
        && (ready ? member(value.kind, ['exact', 'rebased', 'partial', 'semantic-neighbor', 'percentage']) : value.kind === null)
        && (ready && !percentage ? validRange(value.range) && typeof value.nodeId === 'string' : value.range === null && value.nodeId === null)
        && value.approximate === (ready && percentage)
        && (percentage ? finite(value.percentage) && value.percentage >= 0 && value.percentage <= 1 : value.percentage === null)
        && member(value.direction, ['forward', 'backward', 'none'])
        && member(value.affinity, ['before', 'after']) && finite(value.viewportOffset) && value.viewportOffset >= 0
        && member(value.behavior, ['instant', 'smooth']) && origins.includes(value.origin as ArticleAnchorOrigin)
        && Number.isSafeInteger(value.generation) && Number(value.generation) > 0
        && validateArticleAnchorContext(value.beforeAnchor) && value.beforeDigest === value.beforeAnchor.contentDigest
        && Array.isArray(value.rebase) && value.rebase.every(kind => member(kind, ['mapped', 'partial', 'deleted']))
        && member(value.surface, ['live', 'source']) && member(value.tool, ['none', 'publish-preview', 'source-compare'])
        && finite(value.startedAt) && finite(value.completedAt) && value.startedAt >= 0 && value.completedAt >= value.startedAt;
}

/** Consumes public maps only. Surface/tool owners execute the returned commands. */
export class ArticleAnchorContextAdapter
{
    private readonly owner: ArticleDocumentContextAdapter;
    private intent: ArticleScrollIntent;
    private intentDocument: ArticleDocumentContext;
    private sequence = 0;
    private synchronizationEnabled = false;
    private lastSyncAt = -Infinity;
    private readonly log: ArticleAnchorCommand[] = [];

    public constructor(owner: ArticleDocumentContextAdapter)
    {
        this.owner = owner;
        this.intentDocument = owner.context;
        this.intent = Object.freeze({ state: 'automatic', pane: null, kind: null, generation: 0, changedAt: 0, resume: 'initial' });
    }

    public get receipts(): readonly ArticleAnchorCommand[]
    {
        this.resetForDocument();
        return this.log.map(value => structuredClone(value));
    }

    public get userIntent(): ArticleScrollIntent
    {
        this.resetForDocument();
        return this.intent;
    }

    /** Read-only admission through the original owner; anchorless effects need the same map checks as restore/capture. */
    public isCurrentPositionBinding(binding: ArticlePositionMapBinding): boolean
    {
        const current = this.owner.context;
        try
        {
            this.assertBinding(binding);
            return this.owner.context === current && this.owner.isCurrentContext(current);
        }
        catch
        {
            return false;
        }
    }

    public manual(kind: ArticleManualScrollKind, pane: ArticleAnchorPane, now: number): void
    {
        this.resetForDocument();
        this.assertTime(now);
        if (!manualKinds.includes(kind) || !['source', 'renderer'].includes(pane))
        {
            throw new Error('article-anchor-manual-intent-invalid');
        }
        this.intent = Object.freeze({ state: 'manual', pane, kind, generation: ++this.sequence, changedAt: now, resume: null });
    }

    public resume(reason: 'input' | 'navigation' | 'idle', now: number): boolean
    {
        this.resetForDocument();
        this.assertTime(now);
        if (!['input', 'navigation', 'idle'].includes(reason))
        {
            throw new Error('article-anchor-resume-invalid');
        }
        if (reason === 'idle' && now - this.intent.changedAt < articleScrollIntentPolicy.idleResumeMs)
        {
            return false;
        }
        this.intent = Object.freeze({ ...this.intent, state: 'automatic', generation: ++this.sequence, changedAt: now, resume: reason });
        return true;
    }

    public setSynchronization(enabled: boolean): void
    {
        if (typeof enabled !== 'boolean')
        {
            throw new Error('article-anchor-sync-invalid');
        }
        this.synchronizationEnabled = enabled;
    }

    public capture(binding: ArticlePositionMapBinding, selection: MarkdownEditorResolvedSelection, options: ArticleAnchorCaptureOptions): ArticleAnchorContext
    {
        this.resetForDocument();
        this.assertBinding(binding);
        if (!exactKeys(options, ['affinity', 'viewportOffset', 'percentage', 'surface', 'tool'])
            || !exactKeys(selection, ['start', 'end', 'direction'])
            || !validRange({ start: selection.start, end: selection.end })
            || !['before', 'after'].includes(options.affinity) || !finite(options.viewportOffset)
            || !finite(options.percentage) || options.percentage < 0 || options.percentage > 1
            || !['live', 'source'].includes(options.surface) || !['none', 'publish-preview', 'source-compare'].includes(options.tool)
            || !['forward', 'backward', 'none'].includes(selection.direction))
        {
            throw new Error('article-anchor-capture-invalid');
        }
        const visual = binding.map.sourceSelectionToVisual({
            anchor: selection.direction === 'backward' ? selection.end : selection.start,
            focus: selection.direction === 'backward' ? selection.start : selection.end
        });
        const source = binding.map.visualAnchorToSourceSelection(visual);
        const point = binding.map.sourcePositionToVisual({ offset: source.focus, affinity: options.affinity });
        return seal({
            schema: articleAnchorContextSchema,
            document: binding.document,
            range: Object.freeze({ start: Math.min(source.anchor, source.focus), end: Math.max(source.anchor, source.focus) }),
            nodeId: binding.map.syntax.some(node => node.id === point.anchorId) ? point.anchorId : null,
            direction: selection.direction,
            ...options,
            intent: this.intent
        });
    }

    public restore(
        saved: ArticleAnchorContext,
        binding: ArticlePositionMapBinding,
        options: { origin: ArticleAnchorOrigin; now: number; viewportHeight: number; reducedMotion: boolean; transactions?: readonly MarkdownEditorDispatchResult[]; }
    ): ArticleAnchorCommand
    {
        this.resetForDocument();
        this.assertTime(options.now);
        if (!validateArticleAnchorContext(saved) || !origins.includes(options.origin)
            || !finite(options.viewportHeight) || options.viewportHeight <= 0 || typeof options.reducedMotion !== 'boolean')
        {
            throw new Error('article-anchor-restore-input-invalid');
        }
        const traces: ('mapped' | 'partial' | 'deleted')[] = [];
        const command = (
            status: ArticleAnchorCommand['status'], reason: string | null,
            kind: ArticleAnchorRestoreKind | null = null, range: MarkdownSourceRange | null = null, nodeId: string | null = null
        ): ArticleAnchorCommand =>
        {
            const result = seal({
                schema: articleAnchorCommandSchema, document: this.owner.context, status, reason, kind, range, nodeId,
                approximate: kind === 'percentage', percentage: kind === 'percentage' ? saved.percentage : null,
                direction: saved.direction, affinity: saved.affinity,
                viewportOffset: Math.min(options.viewportHeight, Math.max(0, saved.viewportOffset)),
                behavior: options.reducedMotion ? 'instant' as const : 'smooth' as const,
                origin: options.origin, generation: ++this.sequence, intent: this.intent,
                beforeDigest: saved.contentDigest, beforeAnchor: structuredClone(saved), rebase: Object.freeze([...traces]),
                surface: saved.surface, tool: saved.tool, startedAt: options.now, completedAt: options.now
            });
            this.log.push(result);
            if (this.log.length > 64)
            {
                this.log.shift();
            }
            return result;
        };
        if (!sameDocument(saved.document, this.owner.context))
        {
            return command('rejected', 'document-mismatch');
        }
        try
        {
            this.assertBinding(binding);
        }
        catch
        {
            return command('rejected', 'map-binding-invalid');
        }
        if (this.intent.state === 'manual')
        {
            return command('paused', 'user-scroll-priority');
        }
        let range: MarkdownSourceRange | null = saved.range;
        let point = saved.direction === 'backward' ? saved.range.start : saved.range.end;
        let revision = saved.document.sourceRevision;
        const transactions = options.transactions ?? [];
        if (revision === binding.document.sourceRevision && saved.document.contextDigest !== binding.document.contextDigest)
        {
            return command('rejected', 'source-context-mismatch');
        }
        for (const transaction of transactions)
        {
            if (!transaction.accepted || !transaction.positionMap || transaction.beforeRevision !== revision
                || typeof transaction.positionMap.map !== 'function' || typeof transaction.positionMap.mapRange !== 'function'
                || transaction.revision <= revision || transaction.revision > binding.document.sourceRevision
                || transaction.documentIdentity?.id !== binding.document.documentId
                || transaction.documentIdentity?.epoch !== binding.document.documentEpoch)
            {
                return command('rejected', 'transaction-chain-invalid');
            }
            try
            {
                const collapsed = range?.start === range?.end && range !== null;
                if (range)
                {
                    const outcome = transaction.positionMap.mapRange(range);
                    if (typeof outcome.deleted !== 'boolean' || typeof outcome.partiallyDeleted !== 'boolean')
                    {
                        return command('rejected', 'mapped-range-invalid');
                    }
                    if (outcome.deleted)
                    {
                        range = null;
                        traces.push('deleted');
                    }
                    else if (!outcome.range || !validRange(outcome.range) || outcome.range.end > transaction.value.length)
                    {
                        return command('rejected', 'mapped-range-invalid');
                    }
                    else
                    {
                        range = outcome.range;
                        traces.push(outcome.partiallyDeleted ? 'partial' : 'mapped');
                    }
                }
                point = transaction.positionMap.map(point, saved.affinity === 'before' ? -1 : 1);
                if (!Number.isSafeInteger(point) || point < 0 || point > transaction.value.length)
                {
                    return command('rejected', 'mapped-point-invalid');
                }
                // A collapsed caret must retain the public point association too.
                if (range && collapsed)
                {
                    range = { start: point, end: point };
                }
            }
            catch
            {
                return command('rejected', 'public-position-map-invalid');
            }
            revision = transaction.revision;
        }
        if (revision !== binding.document.sourceRevision
            || transactions.length > 0 && transactions[transactions.length - 1]?.value !== binding.map.source)
        {
            return command('rejected', 'source-revision-unmapped');
        }
        try
        {
            if (range)
            {
                if (traces.length === 0 && saved.nodeId !== null
                    && binding.map.syntax.some(node => node.id === saved.nodeId))
                {
                    binding.map.reveal({ anchorId: saved.nodeId });
                    return command('ready', null, 'exact', range, saved.nodeId);
                }
                const reveal = binding.map.sourceRangeToReveal(range);
                const nodeId = reveal.reveal.anchorId;
                if (binding.map.syntax.some(node => node.id === nodeId))
                {
                    return command('ready', null, traces.includes('partial') ? 'partial' : traces.length > 0 ? 'rebased' : 'exact', range, nodeId);
                }
            }
            const neighbor = binding.map.sourcePositionToVisual({ offset: point, affinity: saved.affinity });
            if (binding.map.syntax.some(node => node.id === neighbor.anchorId))
            {
                const reveal = binding.map.reveal({ anchorId: neighbor.anchorId });
                return command('ready', null, 'semantic-neighbor', reveal.range, neighbor.anchorId);
            }
        }
        catch
        {
            return command('rejected', 'public-map-outcome-invalid');
        }
        return command('ready', null, 'percentage');
    }

    public synchronize(
        event: { document: ArticleDocumentContext; pane: ArticleAnchorPane; generation: number | null; now: number; },
        saved: ArticleAnchorContext, binding: ArticlePositionMapBinding,
        viewport: { height: number; reducedMotion: boolean; }
    ): { target: ArticleAnchorPane; command: ArticleAnchorCommand; } | null
    {
        this.resetForDocument();
        this.assertTime(event.now);
        if (!this.synchronizationEnabled || !this.owner.isCurrentContext(event.document)
            || !['source', 'renderer'].includes(event.pane) || event.generation !== null
            || this.intent.state === 'manual' || this.intent.pane !== null && this.intent.pane !== event.pane
            || event.now - this.lastSyncAt < articleScrollIntentPolicy.syncDebounceMs)
        {
            return null;
        }
        const result = this.restore(saved, binding, {
            origin: 'sync', now: event.now, viewportHeight: viewport.height, reducedMotion: viewport.reducedMotion
        });
        if (result.status !== 'ready')
        {
            return null;
        }
        this.lastSyncAt = event.now;
        return { target: event.pane === 'source' ? 'renderer' : 'source', command: result };
    }

    private assertBinding(binding: ArticlePositionMapBinding): void
    {
        if (!this.owner.isCurrentContext(binding.document)
            || binding.map.documentIdentity.id !== binding.document.documentId
            || binding.map.documentIdentity.epoch !== binding.document.documentEpoch
            || createArticleDocumentContext({ ...binding.document, content: binding.map.source }).contentDigest !== binding.document.contentDigest)
        {
            throw new Error('article-anchor-map-binding-invalid');
        }
    }

    private assertTime(now: number): void
    {
        if (!finite(now) || now < this.intent.changedAt || now < 0)
        {
            throw new Error('article-anchor-time-invalid');
        }
    }

    private resetForDocument(): void
    {
        if (!sameDocument(this.intentDocument, this.owner.context))
        {
            this.intentDocument = this.owner.context;
            this.intent = Object.freeze({ state: 'automatic', pane: null, kind: null, generation: ++this.sequence, changedAt: 0, resume: 'initial' });
            this.lastSyncAt = -Infinity;
            this.synchronizationEnabled = false;
            this.log.length = 0;
        }
    }
}
