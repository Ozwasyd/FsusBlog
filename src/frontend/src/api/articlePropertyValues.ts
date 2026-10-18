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
        const path = propertiesPath(command.articleId, null);
        if (command.siteScope !== 'primary-site')
        {
            throw new RangeError('article_property_value_site_invalid');
        }
        const result = await requestBinaryOnly<mutationWire.ArticlePropertyValueMutationReceipt>({
            binaryUrl: path, privateScope: 'admin', frameType: FrameType.ArticlePropertyValueMutationReceipt, signal,
            requestOptions: { method: 'POST', cache: 'no-store', requiresPow: true,
                body: encodeAedsFrame(FrameType.ArticlePropertyValueMutationCommand,
                    mutationWire.encodeArticlePropertyValueMutationCommand(command)) }
        });
        if (result.requestId !== command.requestId || result.articleId !== command.articleId
            || result.definitionOwnerUserId !== command.definitionOwnerUserId || result.siteScope !== command.siteScope
            || result.expectedArticleRevisionId !== command.expectedArticleRevisionId
            || result.beforePropertyRevision !== command.expectedPropertyRevision || result.commandKind !== command.mode
            || BigInt(result.afterPropertyRevision) !== BigInt(command.expectedPropertyRevision) + 1n)
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
