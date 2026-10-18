import { encodeAedsFrame } from '@/api/binaryFrame';
import type { ArticlePropertyValueReadResponse } from '@/codecs/binary/articlePropertyValueReadCodecs';
import * as mutationWire from '@/codecs/binary/articlePropertyValueReadWire.generated';
import { requestBinaryOnly } from '@/composition/binaryTransport';

import { FrameType } from '@wasm/protocol/frame';

function requireCurrentArticleRevisionId(revisionId: string): void
{
    if (typeof revisionId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(revisionId)
        || BigInt(revisionId) > 9223372036854775807n)
    {
        throw new RangeError('article_property_value_article_revision_id_invalid');
    }
}

function propertiesPath(articleId: number, ownerUserId: string | null): string
{
    if (!Number.isInteger(articleId) || articleId < 1 || articleId > 2147483647)
    {
        throw new RangeError('article_property_value_article_id_invalid');
    }
    const path = `/api/binary/author/articles/${articleId}/properties`;
    if (ownerUserId === null)
    {
        return path;
    }
    if (typeof ownerUserId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(ownerUserId)
        || BigInt(ownerUserId) > 9223372036854775807n)
    {
        throw new RangeError('article_property_value_owner_id_invalid');
    }
    return `${path}?ownerUserId=${ownerUserId}`;
}

/** Uses the original private author transport for persisted facts and canonical mutations. */
export const articlePropertyValuesApi = {
    async mutate(command: mutationWire.ArticlePropertyValueMutationCommand,
        signal?: AbortSignal): Promise<mutationWire.ArticlePropertyValueMutationReceipt>
    {
        propertiesPath(command.articleId, null);
        if (command.siteScope !== 'primary-site')
        {
            throw new RangeError('article_property_value_site_invalid');
        }
        const payload = mutationWire.encodeArticlePropertyValueMutationCommand(command);
        const captured = mutationWire.decodeArticlePropertyValueMutationCommand(payload);
        const result = await requestBinaryOnly<mutationWire.ArticlePropertyValueMutationReceipt>({
            binaryRoute: { operationId: 'binary_author_article_property_values_mutate', params: { articleId: captured.articleId } },
            privateScope: 'admin', frameType: FrameType.ArticlePropertyValueMutationReceipt, signal,
            requestOptions: { method: 'POST', cache: 'no-store', requiresPow: true,
                body: encodeAedsFrame(FrameType.ArticlePropertyValueMutationCommand, payload) }
        });
        if (result.requestId !== captured.requestId || result.articleId !== captured.articleId
            || result.definitionOwnerUserId !== captured.definitionOwnerUserId || result.siteScope !== captured.siteScope
            || result.expectedArticleRevisionId !== captured.expectedArticleRevisionId
            || result.beforePropertyRevision !== captured.expectedPropertyRevision || result.commandKind !== captured.mode
            || BigInt(result.afterPropertyRevision) !== BigInt(captured.expectedPropertyRevision) + 1n)
        {
            throw new Error('article_property_value_receipt_binding_invalid');
        }
        return result;
    },
    async read(articleId: number, ownerUserId: string | null = null, signal?: AbortSignal): Promise<ArticlePropertyValueReadResponse>
    {
        const result = await requestBinaryOnly<ArticlePropertyValueReadResponse>({
            binaryUrl: propertiesPath(articleId, ownerUserId),
            privateScope: 'admin',
            frameType: FrameType.ArticlePropertyValueReadResponse,
            signal,
            requestOptions: { method: 'GET', cache: 'no-store' }
        });
        if (result.articleId !== articleId || result.scope.definitionOwnerUserId !== ownerUserId
            || result.scope.siteScope !== 'primary-site')
        {
            throw new Error('article_property_value_read_scope_changed');
        }
        return result;
    },
    /** Reads exactly one persisted revision/publication. Explicit null selects unpublished history only. */
    async readHistorical(articleId: number, articleRevisionId: string, publicationId: string | null,
        ownerUserId: string | null = null, signal?: AbortSignal): Promise<mutationWire.ArticlePropertyValueHistoricalReadResponse>
    {
        requireCurrentArticleRevisionId(articleRevisionId);
        if (publicationId !== null)
        {
            requireCurrentArticleRevisionId(publicationId);
        }
        const path = propertiesPath(articleId, ownerUserId).replace('/properties', `/properties/history/${articleRevisionId}`);
        const binaryUrl = publicationId === null ? path : `${path}${path.includes('?') ? '&' : '?'}publicationId=${publicationId}`;
        const result = await requestBinaryOnly<mutationWire.ArticlePropertyValueHistoricalReadResponse>({
            binaryUrl, privateScope: 'admin', frameType: FrameType.ArticlePropertyValueHistoricalReadResponse, signal,
            requestOptions: { method: 'GET', cache: 'no-store' }
        });
        if (result.articleId !== articleId || result.articleRevisionId !== articleRevisionId || result.publicationId !== publicationId
            || result.scope.definitionOwnerUserId !== ownerUserId || result.scope.siteScope !== 'primary-site')
        {
            throw new Error('article_property_value_historical_coordinates_changed');
        }
        return result;
    },
    /** Re-read Server facts after a canonical save receipt, refusing a raced article revision. */
    async readAfterSave(articleId: number, savedArticleRevisionId: string,
        ownerUserId: string | null = null, signal?: AbortSignal): Promise<ArticlePropertyValueReadResponse>
    {
        requireCurrentArticleRevisionId(savedArticleRevisionId);
        const result = await articlePropertyValuesApi.read(articleId, ownerUserId, signal);
        if (result.currentArticleRevisionId !== savedArticleRevisionId)
        {
            throw new Error('article_property_value_save_revision_changed');
        }
        return result;
    }
};
