import type { ArticlePropertyValueReadResponse } from '@/codecs/binary/articlePropertyValueReadCodecs';
import { requestBinaryOnly } from '@/composition/binaryTransport';

import { FrameType } from '@wasm/protocol/frame';

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

/** Reads persisted Server facts through the private author scope; mutation transport remains a separate contract. */
export const articlePropertyValuesApi = {
    read(articleId: number, ownerUserId: string | null = null, signal?: AbortSignal): Promise<ArticlePropertyValueReadResponse>
    {
        return requestBinaryOnly<ArticlePropertyValueReadResponse>({
            binaryUrl: propertiesPath(articleId, ownerUserId),
            privateScope: 'admin',
            frameType: FrameType.ArticlePropertyValueReadResponse,
            signal,
            requestOptions: { method: 'GET', cache: 'no-store' }
        });
    }
};
