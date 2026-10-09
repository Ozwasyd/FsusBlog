import {
    type ArticleAttachmentContextAdapter,
    type ArticleAttachmentOwnedIntentObservation,
    type ArticleAttachmentPendingHandle
} from './articleAttachmentContext';
import type { ArticlePositionMapBinding } from './articleAnchorContext';
import { validateArticleDocumentContext, type ArticleDocumentContext } from './articleDocumentContext';

/** Business coordinates remain facts; only the original borrowed handle establishes ownership. */
export type ArticleAttachmentBusinessIntentNode = Pick<ArticleAttachmentOwnedIntentObservation,
    'intentRef' | 'nodeId' | 'transactionRef' | 'providerRef' | 'contextDigest' | 'sourceOrder'
    | 'sourceReferenced' | 'disposition' | 'sourceUrl'>;

export interface ArticleAttachmentBusinessIntentReaderPorts {
    readonly attachments: ArticleAttachmentContextAdapter;
    /** Original host handle lookup, not a lifecycle receipt or reconstructed handle. */
    handle(this: void, intentRef: string): ArticleAttachmentPendingHandle | null;
    /** Original host's live context and actual public position map. */
    binding(this: void): ArticlePositionMapBinding;
}

export interface ArticleAttachmentBusinessIntentReader {
    /** null sourceReferenced stays unknown; false is only the original removal observation. */
    readOwnedIntent(intentRef: string, context: ArticleDocumentContext,
        signal?: AbortSignal): ArticleAttachmentOwnedIntentObservation | null;
    /** Implements the existing business verifyIntent port, without asset/reference/cleanup grants. */
    verifyIntent(node: ArticleAttachmentBusinessIntentNode, context: ArticleDocumentContext,
        signal?: AbortSignal): Promise<boolean>;
}

/** Adapts the original WeakMap/lease/public-map reader; owns no intent store or lifecycle log. */
export function createArticleAttachmentBusinessIntentReader(
    ports: ArticleAttachmentBusinessIntentReaderPorts): ArticleAttachmentBusinessIntentReader
{
    function read(intentRef: string, context: ArticleDocumentContext, signal?: AbortSignal)
    {
        signal?.throwIfAborted();
        try
        {
            if (!validateArticleDocumentContext(context)) return null;
            const handle = ports.handle(intentRef);
            if (!handle) return null;
            const binding = ports.binding();
            if (binding.document.contextDigest !== context.contextDigest) return null;
            const observation = ports.attachments.readOwnedIntent(handle, binding);
            signal?.throwIfAborted();
            if (!observation || observation.intentRef !== intentRef) return null;
            return { handle, observation };
        }
        catch
        {
            signal?.throwIfAborted();
            return null;
        }
    }

    function matches(observation: ArticleAttachmentOwnedIntentObservation,
        node: ArticleAttachmentBusinessIntentNode, context: ArticleDocumentContext): boolean
    {
        return observation.current && observation.sourceReferenced === true
            && observation.disposition === 'current' && observation.contextDigest === context.contextDigest
            && observation.intentRef === node.intentRef && observation.nodeId === node.nodeId
            && observation.transactionRef === node.transactionRef && observation.providerRef === node.providerRef
            && observation.contextDigest === node.contextDigest && observation.sourceOrder === node.sourceOrder
            && observation.sourceReferenced === node.sourceReferenced && observation.disposition === node.disposition
            && observation.sourceUrl === node.sourceUrl;
    }

    return Object.freeze({
        readOwnedIntent(intentRef: string, context: ArticleDocumentContext, signal?: AbortSignal)
        {
            return read(intentRef, context, signal)?.observation ?? null;
        },
        async verifyIntent(node: ArticleAttachmentBusinessIntentNode, context: ArticleDocumentContext,
            signal?: AbortSignal): Promise<boolean>
        {
            signal?.throwIfAborted();
            const expected = Object.freeze({ ...node });
            const before = read(expected.intentRef, context, signal);
            if (!before || !matches(before.observation, expected, context)) return false;
            // Re-observe after the promise boundary through the same original owner.
            await Promise.resolve();
            signal?.throwIfAborted();
            const after = read(expected.intentRef, context, signal);
            return after !== null && after.handle === before.handle
                && after.observation.snapshot === before.observation.snapshot
                && after.observation.providerVersion === before.observation.providerVersion
                && matches(after.observation, expected, context);
        }
    });
}
