import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/composition/binaryTransport'
import type { CommentRevisionResult } from '@/contracts/binaryApi'
import type { ApiRequestConfig } from './requestConfig'

export function getCommentRevisions(commentId: string, config?: ApiRequestConfig): Promise<CommentRevisionResult[]> {
  return requestBinaryOnly<CommentRevisionResult[]>({
    binaryRoute: {
      operationId: 'binary_get_author_comments_commentId_long_revisions',
      params: { commentId }
    },
    frameType: FrameType.CommentRevisionList,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: { method: 'GET', cache: 'no-store', credentials: 'include' }
  })
}
