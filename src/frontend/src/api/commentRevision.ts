import { requestBinaryOnly } from '@/composition/binaryTransport';
import type { CommentRevisionResult } from '@/contracts/binaryApi';

import { FrameType } from '@wasm/protocol/frame';

import type { ApiRequestConfig } from './requestConfig';

export function getCommentRevisions(commentId: string, config?: ApiRequestConfig): Promise<CommentRevisionResult[]>
{
    return requestBinaryOnly<CommentRevisionResult[]>({
        binaryRoute: {
            operationId: 'binary_get_author_comments_commentId_long_revisions',
            params: { commentId }
        },
        frameType: FrameType.CommentRevisionList,
        signal: config?.signal,
        requestOptions: { cache: 'no-store', }
    });
}
