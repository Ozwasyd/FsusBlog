import { encodeAedsFrame } from '@/api/binaryFrame';
import * as wire from '@/codecs/binary/articleCanvasLinkWire.generated';
import { requestBinaryOnly } from '@/composition/binaryTransport';

import { FrameType } from '@wasm/protocol/frame';

function articlePath(articleId: number): string
{
    if (!Number.isInteger(articleId) || articleId < 1 || articleId > 2147483647)
    {
        throw new RangeError('article_canvas_link_article_id_invalid');
    }
    return `/api/binary/author/articles/${articleId}/canvas-links`;
}

export const articleCanvasLinksApi = {
    convert(request: wire.ArticleCanvasLinkRequest, signal?: AbortSignal): Promise<wire.ArticleCanvasLinkReceipt>
    {
        return requestBinaryOnly<wire.ArticleCanvasLinkReceipt>({
            binaryUrl: articlePath(request.sourceArticleId), privateScope: 'admin',
            frameType: FrameType.ArticleCanvasLinkReceipt, signal,
            requestOptions: { method: 'POST', requiresPow: true,
                body: encodeAedsFrame(FrameType.ArticleCanvasLinkRequest, wire.encodeArticleCanvasLinkRequest(request)) }
        });
    },
    history(articleId: number, signal?: AbortSignal): Promise<wire.ArticleCanvasLinkHistoryResponse>
    {
        return requestBinaryOnly<wire.ArticleCanvasLinkHistoryResponse>({
            binaryUrl: articlePath(articleId) + '/history', privateScope: 'admin',
            frameType: FrameType.ArticleCanvasLinkHistoryResponse, signal
        });
    }
};
