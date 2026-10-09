import { validateArticleDocumentContext, type ArticleDocumentContext } from './articleDocumentContext';
import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

import type { AttachmentAssetFacts, AttachmentUploadObservation, AttachmentUploadProvider } from './articleAttachmentUploadProvider';

export const articleAttachmentBusinessSchema = 'fsusblog.article-attachment-business.v1' as const;
export type AttachmentBusinessStatus = 'pending' | 'success' | 'failed' | 'cancelled' | 'stale' | 'removed' | 'recovery-required';

/** Produced by the original intent/transaction owner, never by Markdown scanning. */
export interface AttachmentBusinessNode {
    readonly intentRef: string;
    readonly nodeId: string;
    readonly transactionRef: string;
    readonly providerRef: string;
    readonly contextDigest: string;
    readonly sourceOrder: number;
    readonly sourceReferenced: boolean;
    readonly disposition: 'current' | 'cancelled' | 'removed' | 'stale' | 'failed';
    readonly sourceUrl: string | null;
}

export interface AttachmentBusinessSource {
    readonly context: ArticleDocumentContext;
    readonly nodes: readonly AttachmentBusinessNode[];
}

/** Required current reference-operation observation from the sole ledger/rights owner.
 * This is a consumer port, not an implemented server API or caller-supplied verified flag.
 */
export interface AttachmentReferenceFacts {
    readonly receiptRef: string;
    readonly contextDigest: string;
    readonly intentRef: string;
    readonly nodeId: string;
    readonly transactionRef: string;
    readonly assetId: string;
    readonly assetVersionSha256: string;
    readonly referenceLedgerSha256: string;
}

export interface AttachmentBusinessAuthority {
    verifyIntent(node: AttachmentBusinessNode, context: ArticleDocumentContext, signal?: AbortSignal): Promise<boolean>;
    observeReference(node: AttachmentBusinessNode, asset: AttachmentAssetFacts, context: ArticleDocumentContext, signal?: AbortSignal): Promise<AttachmentReferenceFacts | null>;
    observeCleanup(node: AttachmentBusinessNode, asset: AttachmentAssetFacts | null, context: ArticleDocumentContext, signal?: AbortSignal): Promise<'recorded' | 'required'>;
}

export interface AttachmentBusinessItem {
    readonly intentRef: string;
    readonly nodeId: string;
    readonly transactionRef: string;
    readonly providerRef: string;
    readonly sourceOrder: number;
    readonly sourceReferenced: boolean;
    readonly status: AttachmentBusinessStatus;
    readonly reason: string | null;
    readonly asset: AttachmentAssetFacts | null;
    readonly referenceReceiptRef: string | null;
    readonly cleanup: 'not-needed' | 'recorded' | 'required';
}

export interface AttachmentBusinessProjection {
    readonly schema: typeof articleAttachmentBusinessSchema;
    readonly context: ArticleDocumentContext;
    readonly items: readonly AttachmentBusinessItem[];
    readonly blockingNodeIds: readonly string[];
    readonly previewResources: readonly Readonly<{ nodeId: string; assetId: string; publicUrl: string; }>[];
    readonly contentDigest: string;
}

export interface AttachmentDraftRef {
    readonly intentRef: string;
    readonly nodeId: string;
    readonly transactionRef: string;
    readonly providerRef: string;
    readonly status: AttachmentBusinessStatus;
    readonly assetId: string | null;
    readonly referenceLedgerSha256: string | null;
    readonly referenceReceiptRef: string | null;
}

export interface AttachmentRevisionRef {
    readonly nodeId: string;
    readonly transactionRef: string;
    readonly assetId: string;
    readonly publicUrl: string;
    readonly assetVersionSha256: string;
    readonly referenceLedgerSha256: string;
    readonly referenceReceiptRef: string;
}

export interface AttachmentBusinessDecision {
    readonly status: 'saved' | 'allowed' | 'blocked' | 'conflict' | 'failed' | 'stay';
    readonly basisContextDigest: string;
    readonly receiptRef: string | null;
}

export interface AttachmentBusinessActionResult {
    readonly projection: AttachmentBusinessProjection;
    readonly decision: AttachmentBusinessDecision;
}

export interface AttachmentBusinessState {
    assess(signal?: AbortSignal): Promise<AttachmentBusinessProjection>;
    verify(candidate: unknown, signal?: AbortSignal): Promise<boolean>;
    save(signal?: AbortSignal): Promise<AttachmentBusinessActionResult>;
    leave(signal?: AbortSignal): Promise<AttachmentBusinessActionResult>;
    prepublish(signal?: AbortSignal): Promise<AttachmentBusinessActionResult>;
    revision(signal?: AbortSignal): Promise<AttachmentBusinessActionResult>;
    retry(nodeId: string, signal?: AbortSignal): Promise<AttachmentBusinessActionResult>;
    cancel(nodeId: string, signal?: AbortSignal): Promise<AttachmentBusinessActionResult>;
}

export interface AttachmentBusinessPorts {
    source(): AttachmentBusinessSource;
    provider(node: AttachmentBusinessNode): AttachmentUploadProvider | null;
    readonly authority?: AttachmentBusinessAuthority;
    /** Existing draft owner consumes refs; it still owns the sole source text and save CAS. */
    saveDraft?(this: void, context: ArticleDocumentContext, refs: readonly AttachmentDraftRef[], signal?: AbortSignal): Promise<AttachmentBusinessDecision>;
    /** Existing dirty/save/conflict guard owns confirmation. No modal is created here. */
    confirmLeave?(this: void, projection: AttachmentBusinessProjection, signal?: AbortSignal): Promise<AttachmentBusinessDecision>;
    prepublish?(this: void, context: ArticleDocumentContext, refs: readonly AttachmentRevisionRef[], signal?: AbortSignal): Promise<AttachmentBusinessDecision>;
    revisionSnapshot?(this: void, context: ArticleDocumentContext, refs: readonly AttachmentRevisionRef[], signal?: AbortSignal): Promise<AttachmentBusinessDecision>;
}

const ref = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const validAsset = (asset: AttachmentAssetFacts): boolean => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(asset.assetId)
    && typeof asset.publicUrl === 'string' && asset.publicUrl.startsWith('/uploads/illustration/')
    && digest(asset.sha256) && digest(asset.assetVersionSha256) && digest(asset.referenceLedgerSha256)
    && Number.isSafeInteger(asset.sizeBytes) && asset.sizeBytes > 0;

function readSource(ports: AttachmentBusinessPorts): AttachmentBusinessSource
{
    const source = ports.source();
    if (!validateArticleDocumentContext(source.context) || !Array.isArray(source.nodes))
    {
        throw new Error('attachment_source_projection_invalid');
    }
    const ids = new Set<string>();
    const intents = new Set<string>();
    const orders = new Set<number>();
    const nodes = source.nodes.map((node: AttachmentBusinessNode) =>
    {
        if (!ref(node.intentRef) || !ref(node.nodeId) || !ref(node.transactionRef) || !ref(node.providerRef)
            || !digest(node.contextDigest) || typeof node.sourceReferenced !== 'boolean'
            || !['current', 'cancelled', 'removed', 'stale', 'failed'].includes(node.disposition)
            || !Number.isSafeInteger(node.sourceOrder) || node.sourceOrder < 0
            || (node.sourceUrl !== null && typeof node.sourceUrl !== 'string')
            || ids.has(node.nodeId) || intents.has(node.intentRef) || orders.has(node.sourceOrder))
        {
            throw new Error('attachment_source_node_invalid');
        }
        ids.add(node.nodeId);
        intents.add(node.intentRef);
        orders.add(node.sourceOrder);
        // Caption and other editor-owned data are not read or serialized.
        return Object.freeze({ intentRef: node.intentRef, nodeId: node.nodeId, transactionRef: node.transactionRef,
            providerRef: node.providerRef, contextDigest: node.contextDigest, sourceOrder: node.sourceOrder,
            sourceReferenced: node.sourceReferenced, disposition: node.disposition, sourceUrl: node.sourceUrl });
    });
    return Object.freeze({ context: Object.freeze({ ...source.context }), nodes: Object.freeze(nodes.sort((a, b) => a.sourceOrder - b.sourceOrder)) });
}

const sourceDigest = (source: AttachmentBusinessSource): string => calculateOpenArticleDocumentDigest(source);
const decision = (status: AttachmentBusinessDecision['status'], context: ArticleDocumentContext): AttachmentBusinessDecision =>
    Object.freeze({ status, basisContextDigest: context.contextDigest, receiptRef: null });

function revisionRefs(projection: AttachmentBusinessProjection): readonly AttachmentRevisionRef[]
{
    return Object.freeze(projection.items.filter(item => item.status === 'success').map(item => Object.freeze({
        nodeId: item.nodeId, transactionRef: item.transactionRef, assetId: item.asset!.assetId,
        publicUrl: item.asset!.publicUrl, assetVersionSha256: item.asset!.assetVersionSha256,
        referenceLedgerSha256: item.asset!.referenceLedgerSha256, referenceReceiptRef: item.referenceReceiptRef!
    })));
}

/** Stateless contribution to original save/leave/prepublish/revision owners. No body, ledger or history store. */
export function createArticleAttachmentBusinessState(ports: AttachmentBusinessPorts): AttachmentBusinessState
{
    async function assess(signal?: AbortSignal): Promise<AttachmentBusinessProjection>
    {
        signal?.throwIfAborted();
        const source = readSource(ports);
        const items: AttachmentBusinessItem[] = [];
        for (const node of source.nodes)
        {
            let observation: AttachmentUploadObservation = { status: 'recovery-required', reason: 'provider_missing' };
            let status: AttachmentBusinessStatus = 'recovery-required';
            let reason: string | null = ports.authority ? 'unverified_attachment_intent' : 'intent_authority_missing';
            let asset: AttachmentAssetFacts | null = null;
            let referenceReceiptRef: string | null = null;
            let cleanup: AttachmentBusinessItem['cleanup'] = 'not-needed';
            try
            {
                const provider = ports.provider(node);
                if (provider)
                {
                    observation = await provider.observe(signal);
                }
                signal?.throwIfAborted();
                if (!['pending', 'committed', 'cancelled', 'failed', 'recovery-required'].includes(observation.status)
                    || (observation.status === 'pending' && (!Number.isSafeInteger(observation.uploadedBytes)
                        || !Number.isSafeInteger(observation.totalBytes) || observation.uploadedBytes < 0
                        || observation.uploadedBytes > observation.totalBytes || observation.totalBytes <= 0)))
                {
                    observation = { status: 'recovery-required', reason: 'provider_observation_invalid' };
                }
                if (observation.status === 'committed' && validAsset(observation.asset))
                {
                    asset = Object.freeze({ assetId: observation.asset.assetId, publicUrl: observation.asset.publicUrl,
                        sha256: observation.asset.sha256, assetVersionSha256: observation.asset.assetVersionSha256,
                        referenceLedgerSha256: observation.asset.referenceLedgerSha256, sizeBytes: observation.asset.sizeBytes });
                }
                if (node.contextDigest !== source.context.contextDigest)
                {
                    status = 'stale';
                    reason = 'source_context_changed';
                }
                else if (ports.authority && await ports.authority.verifyIntent(node, source.context, signal))
                {
                    if (node.disposition !== 'current' || !node.sourceReferenced)
                    {
                        status = node.disposition === 'current' ? 'removed' : node.disposition;
                        reason = node.sourceReferenced ? 'inactive_attachment_still_referenced' : null;
                        cleanup = await ports.authority.observeCleanup(node, asset, source.context, signal);
                        if (cleanup !== 'recorded')
                        {
                            cleanup = 'required';
                            reason = 'cleanup_obligation_unconfirmed';
                        }
                    }
                    else if (observation.status === 'committed' && asset)
                    {
                        const reference = await ports.authority.observeReference(node, asset, source.context, signal);
                        if (reference && ref(reference.receiptRef) && reference.contextDigest === source.context.contextDigest
                            && reference.intentRef === node.intentRef && reference.nodeId === node.nodeId
                            && reference.transactionRef === node.transactionRef && reference.assetId === asset.assetId
                            && reference.assetVersionSha256 === asset.assetVersionSha256
                            && reference.referenceLedgerSha256 === asset.referenceLedgerSha256
                            && node.sourceUrl === asset.publicUrl)
                        {
                            status = 'success';
                            reason = null;
                            referenceReceiptRef = reference.receiptRef;
                        }
                        else
                        {
                            reason = 'current_resource_reference_authority_missing_or_changed';
                        }
                    }
                    else
                    {
                        status = observation.status === 'committed' ? 'recovery-required' : observation.status;
                        reason = observation.status === 'pending' ? 'upload_pending' : 'upload_not_verified';
                    }
                }
                if (asset && status !== 'success' && cleanup === 'not-needed')
                {
                    cleanup = ports.authority ? await ports.authority.observeCleanup(node, asset, source.context, signal) : 'required';
                    if (cleanup !== 'recorded')
                    {
                        cleanup = 'required';
                    }
                }
            }
            catch
            {
                signal?.throwIfAborted();
                status = 'recovery-required';
                reason = 'attachment_authority_observation_failed';
                cleanup = asset ? 'required' : cleanup;
            }
            items.push(Object.freeze({ intentRef: node.intentRef, nodeId: node.nodeId, transactionRef: node.transactionRef,
                providerRef: node.providerRef, sourceOrder: node.sourceOrder, sourceReferenced: node.sourceReferenced,
                status, reason, asset, referenceReceiptRef, cleanup }));
        }
        signal?.throwIfAborted();
        if (sourceDigest(readSource(ports)) !== sourceDigest(source))
        {
            for (const [i, item] of items.entries())
            {
                let cleanup = item.cleanup;
                if (item.asset)
                {
                    cleanup = 'required';
                    try
                    {
                        if (ports.authority && await ports.authority.observeCleanup(source.nodes[i], item.asset, source.context, signal) === 'recorded')
                        {
                            cleanup = 'recorded';
                        }
                    }
                    catch
                    {
                        signal?.throwIfAborted();
                    }
                }
                items[i] = Object.freeze({ ...item, status: 'stale', reason: 'source_changed_during_observation',
                    referenceReceiptRef: null, cleanup });
            }
        }
        const body = { schema: articleAttachmentBusinessSchema, context: source.context, items: Object.freeze(items),
            blockingNodeIds: Object.freeze(items.filter(item => item.status !== 'success'
                && !(item.sourceReferenced === false && ['cancelled', 'removed'].includes(item.status) && item.cleanup === 'recorded'))
                .map(item => item.nodeId)),
            previewResources: Object.freeze(items.filter(item => item.status === 'success').map(item => Object.freeze({
                nodeId: item.nodeId, assetId: item.asset!.assetId, publicUrl: item.asset!.publicUrl }))) };
        return Object.freeze({ ...body, contentDigest: calculateOpenArticleDocumentDigest(body) });
    }

    async function run(action: 'save' | 'leave' | 'prepublish' | 'revision', signal?: AbortSignal): Promise<AttachmentBusinessActionResult>
    {
        const basis = readSource(ports);
        const projection = await assess(signal);
        if (sourceDigest(basis) !== sourceDigest(readSource(ports)))
        {
            return { projection, decision: decision('conflict', projection.context) };
        }
        if ((action === 'prepublish' || action === 'revision') && projection.blockingNodeIds.length > 0)
        {
            return { projection, decision: decision('blocked', projection.context) };
        }
        const callback = action === 'save' ? ports.saveDraft : action === 'leave' ? ports.confirmLeave
            : action === 'prepublish' ? ports.prepublish : ports.revisionSnapshot;
        if (!callback)
        {
            return { projection, decision: decision('blocked', projection.context) };
        }
        let result: AttachmentBusinessDecision;
        try
        {
            result = action === 'save'
                ? await ports.saveDraft!(projection.context, Object.freeze(projection.items.map(item => Object.freeze({
                intentRef: item.intentRef, nodeId: item.nodeId, transactionRef: item.transactionRef, providerRef: item.providerRef,
                status: item.status, assetId: item.status === 'success' ? item.asset!.assetId : null,
                referenceLedgerSha256: item.status === 'success' ? item.asset!.referenceLedgerSha256 : null,
                referenceReceiptRef: item.referenceReceiptRef }))), signal)
                : action === 'leave' ? await ports.confirmLeave!(projection, signal)
                : await (action === 'prepublish' ? ports.prepublish! : ports.revisionSnapshot!)(projection.context, revisionRefs(projection), signal);
        }
        catch
        {
            signal?.throwIfAborted();
            return { projection, decision: decision('failed', projection.context) };
        }
        signal?.throwIfAborted();
        // Original owners may update draftRevision after save, but never change the source coordinates unnoticed.
        const current = readSource(ports);
        const { contextDigest: _beforeDigest, sourceIdentityDigest: _beforeIdentity, draftRevision: _beforeDraft, ...before } = projection.context;
        const { contextDigest: _afterDigest, sourceIdentityDigest: _afterIdentity, draftRevision: _afterDraft, ...after } = current.context;
        void _beforeIdentity;
        void _afterIdentity;
        void _beforeDigest;
        void _beforeDraft;
        void _afterDigest;
        void _afterDraft;
        const withoutContextDigest = (nodes: readonly AttachmentBusinessNode[]) => nodes.map(({ contextDigest: _digest, ...node }) =>
        {
            void _digest;
            return node;
        });
        if ((action !== 'save' && projection.context.contextDigest !== current.context.contextDigest)
            || calculateOpenArticleDocumentDigest(before) !== calculateOpenArticleDocumentDigest(after)
            || calculateOpenArticleDocumentDigest(withoutContextDigest(basis.nodes)) !== calculateOpenArticleDocumentDigest(withoutContextDigest(current.nodes))
            || result.basisContextDigest !== projection.context.contextDigest)
        {
            return { projection, decision: decision('conflict', projection.context) };
        }
        if (action === 'leave' && result.status === 'allowed' && projection.items.some(item =>
            item.status !== 'success' && !(item.sourceReferenced === false && item.cleanup === 'recorded')))
        {
            return { projection, decision: decision('blocked', projection.context) };
        }
        const allowedStatuses = action === 'save' ? ['saved', 'conflict', 'failed'] : ['allowed', 'blocked', 'conflict', 'failed', 'stay'];
        if (!allowedStatuses.includes(result.status) || (['saved', 'allowed'].includes(result.status) && !ref(result.receiptRef)))
        {
            return { projection, decision: decision('blocked', projection.context) };
        }
        return { projection, decision: Object.freeze({ status: result.status, basisContextDigest: result.basisContextDigest, receiptRef: result.receiptRef }) };
    }

    async function providerAction(action: 'cancel' | 'retry', nodeId: string, signal?: AbortSignal): Promise<AttachmentBusinessActionResult>
    {
        signal?.throwIfAborted();
        const source = readSource(ports);
        const node = source.nodes.find(item => item.nodeId === nodeId);
        if (!node || (action === 'retry' && (!ports.authority || node.disposition !== 'current'
            || !node.sourceReferenced || node.contextDigest !== source.context.contextDigest
            || !await ports.authority.verifyIntent(node, source.context, signal))))
        {
            return { projection: await assess(signal), decision: decision('blocked', source.context) };
        }
        const provider = ports.provider(node);
        if (!provider || sourceDigest(readSource(ports)) !== sourceDigest(source))
        {
            return { projection: await assess(signal), decision: decision('conflict', source.context) };
        }
        if (action === 'cancel')
        {
            await provider.cancel(signal);
        }
        else
        {
            await provider.retryCommit(signal);
        }
        const projection = await assess(signal);
        return { projection, decision: decision(projection.blockingNodeIds.length === 0 ? 'allowed' : 'blocked', projection.context) };
    }

    async function verify(candidate: unknown, signal?: AbortSignal): Promise<boolean>
    {
        try
        {
            if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)
                || Object.keys(candidate).sort().join(',') !== 'blockingNodeIds,contentDigest,context,items,previewResources,schema')
            {
                return false;
            }
            const { contentDigest, ...body } = candidate as AttachmentBusinessProjection;
            if (contentDigest !== calculateOpenArticleDocumentDigest(body))
            {
                return false;
            }
            return contentDigest === (await assess(signal)).contentDigest;
        }
        catch
        {
            signal?.throwIfAborted();
            return false;
        }
    }

    return Object.freeze({ assess, verify, save: (signal?: AbortSignal) => run('save', signal),
        leave: (signal?: AbortSignal) => run('leave', signal), prepublish: (signal?: AbortSignal) => run('prepublish', signal),
        revision: (signal?: AbortSignal) => run('revision', signal),
        retry: (nodeId: string, signal?: AbortSignal) => providerAction('retry', nodeId, signal),
        cancel: (nodeId: string, signal?: AbortSignal) => providerAction('cancel', nodeId, signal) });
}
