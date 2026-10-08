import {
    markdownLiveCapabilities,
    readMarkdownLiveCapability
} from '@ozwasyd/element-plus';


import {
    readArticleEditorSurfacePreference,
    type ArticleEditorSurface,
    type ArticleEditorSurfacePreference
} from './articleEditorSurface';
import { calculateOpenArticleDocumentDigest as digest } from './openArticleDocumentRegistry';

import type { ArticleDocumentContext, ArticleDocumentContextAdapter, ArticleDocumentTaskLease } from './articleDocumentContext';
import type { MarkdownLiveCapability, MarkdownLiveCapabilityResult } from '@ozwasyd/element-plus';

export interface ArticleLiveCapabilityEnvironment
{
    readonly rendererVersion: string;
    readonly projectionVersion: string;
    readonly featureDigest: string;
    readonly runtimeIdentity: string;
    readonly platformIdentity: string;
}

export interface ArticleLiveCapabilityRequest
{
    readonly document: ArticleDocumentContext;
    readonly environment: ArticleLiveCapabilityEnvironment;
    readonly signal: AbortSignal;
}

export interface ArticleLiveCapabilityState
{
    readonly capability: MarkdownLiveCapability | null;
    readonly effectiveSurface: ArticleEditorSurface;
    readonly preference: ArticleEditorSurfacePreference;
    readonly reason: 'capability-pending' | 'invalid-capability' | MarkdownLiveCapability | null;
    readonly localEscape: MarkdownLiveCapabilityResult | null;
    readonly recovery: 'request-current-capability' | 'source-escape' | 'none';
}

const environmentKeys = ['rendererVersion', 'projectionVersion', 'featureDigest', 'runtimeIdentity', 'platformIdentity'];
const capabilityKeys = ['capability', 'documentIdentity', 'revision', 'reason', 'affectedRange', 'nodeId', 'stale', 'aborted'];

function validPublicCapability(value: unknown): value is MarkdownLiveCapabilityResult
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some(key => !capabilityKeys.includes(key))
        || !markdownLiveCapabilities.includes(item.capability as MarkdownLiveCapability)
        || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0
        || item.documentIdentity === null || typeof item.documentIdentity !== 'object')
    {
        return false;
    }
    const identity = item.documentIdentity as Record<string, unknown>;
    if (Array.isArray(identity) || Object.keys(identity).length !== 2 || typeof identity.id !== 'string' || !identity.id
        || !Number.isSafeInteger(identity.epoch) || Number(identity.epoch) < 1)
    {
        return false;
    }
    if (item.reason !== undefined && typeof item.reason !== 'string'
        || item.nodeId !== undefined && (typeof item.nodeId !== 'string' || !item.nodeId)
        || item.stale !== undefined && typeof item.stale !== 'boolean'
        || item.aborted !== undefined && typeof item.aborted !== 'boolean')
    {
        return false;
    }
    if (item.affectedRange !== undefined)
    {
        if (item.affectedRange === null || typeof item.affectedRange !== 'object')
        {
            return false;
        }
        const range = item.affectedRange as Record<string, unknown>;
        if (Array.isArray(range) || Object.keys(range).length !== 2 || !Number.isSafeInteger(range.start) || Number(range.start) < 0
            || !Number.isSafeInteger(range.end) || Number(range.end) < Number(range.start))
        {
            return false;
        }
    }
    return true;
}

/**
 * Product policy over the real public typed capability. The document owner supplies cancellation
 * and revision isolation. No editor, content, persistence, retry command or capability producer is created here.
 */
export class ArticleLiveCapabilitySession
{
    private request: ArticleLiveCapabilityRequest | null = null;
    private lease: ArticleDocumentTaskLease | null = null;
    private decision: { document: ArticleDocumentContext; environment: ArticleLiveCapabilityEnvironment; result: MarkdownLiveCapabilityResult | null; invalid: boolean; } | null = null;

    public constructor(private readonly owner: ArticleDocumentContextAdapter)
    {
    }

    public begin(environment: ArticleLiveCapabilityEnvironment): ArticleLiveCapabilityRequest
    {
        if (Object.keys(environment).length !== environmentKeys.length
            || !environmentKeys.every(key => typeof environment[key as keyof ArticleLiveCapabilityEnvironment] === 'string'
                && environment[key as keyof ArticleLiveCapabilityEnvironment].length > 0)
            || !/^[a-f0-9]{64}$/u.test(environment.featureDigest))
        {
            throw new Error('article-live-capability-environment-invalid');
        }
        if (this.decision !== null && digest(this.decision.environment) !== digest(environment))
        {
            this.decision = null;
        }
        this.cancel();
        this.lease = this.owner.beginTask('feature', 'article-live-capability', 'v1.0');
        this.request = Object.freeze({ document: this.owner.context, environment: Object.freeze({ ...environment }), signal: this.lease.signal });
        return this.request;
    }

    public commit(request: ArticleLiveCapabilityRequest, value: unknown): 'accepted' | 'invalid' | 'stale'
    {
        if (request !== this.request || !this.lease?.isCurrent() || request.signal.aborted
            || !this.owner.isCurrentContext(request.document))
        {
            return 'stale';
        }
        if (!validPublicCapability(value))
        {
            this.decision = { document: request.document, environment: request.environment, result: null, invalid: true };
            this.lease.complete(request.document.sourceRevision);
            return 'invalid';
        }
        try
        {
            readMarkdownLiveCapability(value, { documentIdentity: this.owner.documentIdentity, revision: this.owner.context.sourceRevision });
        }
        catch
        {
            return 'stale';
        }
        const result = Object.freeze({
            ...value,
            documentIdentity: Object.freeze({ ...value.documentIdentity }),
            ...(value.affectedRange === undefined ? {} : { affectedRange: Object.freeze({ ...value.affectedRange }) })
        });
        if (!this.lease.accept(result).accepted)
        {
            return 'stale';
        }
        this.decision = { document: request.document, environment: request.environment, result, invalid: false };
        return 'accepted';
    }

    public state(preference: unknown): ArticleLiveCapabilityState
    {
        const current = this.owner.context;
        const resolved = readArticleEditorSurfacePreference(preference, current);
        // A capability survives edits as session policy; node/range escapes require the exact revision.
        const decision = this.decision?.document.documentId === current.documentId
            && this.decision.document.documentEpoch === current.documentEpoch
            && this.decision.document.editorSessionId === current.editorSessionId
            && this.decision.document.siteScope === current.siteScope && this.decision.document.userScope === current.userScope
            ? this.decision
            : null;
        const capability = decision?.result?.capability ?? null;
        const live = capability === 'supported' || capability === 'feature-degraded';
        return Object.freeze({
            capability,
            effectiveSurface: resolved.surface === 'source' || !live ? 'source' : 'live',
            preference: resolved,
            reason: decision?.invalid ? 'invalid-capability' : capability === 'supported' ? null : capability ?? 'capability-pending',
            localEscape: capability === 'feature-degraded' && decision?.document.sourceRevision === current.sourceRevision ? decision.result : null,
            recovery: live ? capability === 'feature-degraded' ? 'source-escape' : 'none' : 'request-current-capability'
        });
    }

    public cancel(): void
    {
        this.lease?.cancel('capability-canceled');
        this.lease = null;
        this.request = null;
    }
}
