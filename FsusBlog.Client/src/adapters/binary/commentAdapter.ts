import type { CommentItem, CursorResult, MyCommentItem } from '@/api/comment';
import { BinaryReader, readFixedUtf8, readInt32, readInt64Number, readSliceRef, readSliceText } from './reader';
import { COMMENT_ITEM_POD_SIZE, USER_COMMENT_POD_SIZE } from './types';

export function mapCommentCursorFromPodPayload(payload: Uint8Array): CursorResult<CommentItem> {
  const reader = new BinaryReader(payload);
  const nextCursorRaw = reader.readInt64();
  const hasMore = reader.readByte() === 1;
  const count = reader.readInt32();
  if (count < 0) throw new Error('comment_cursor_count_invalid');

  const data: CommentItem[] = [];
  for (let i = 0; i < count; i++) {
    const pod = reader.readSpan(COMMENT_ITEM_POD_SIZE);
    const blob = reader.readBlob();
    data.push({
      id: String(readInt64Number(pod, 0)),
      createTime: new Date(readInt64Number(pod, 8)).toISOString(),
      userName: readFixedUtf8(pod, 16, 64),
      content: readSliceText(blob, readSliceRef(pod, 80))
    });
  }

  return {
    data,
    nextCursor: nextCursorRaw === 0 ? null : String(nextCursorRaw),
    hasMore
  };
}

export function mapUserCommentCursorFromPodPayload(payload: Uint8Array): CursorResult<MyCommentItem> {
  const reader = new BinaryReader(payload);
  const nextCursorRaw = reader.readInt64();
  const hasMore = reader.readByte() === 1;
  const count = reader.readInt32();
  if (count < 0) throw new Error('user_comment_cursor_count_invalid');

  const data: MyCommentItem[] = [];
  for (let i = 0; i < count; i++) {
    const pod = reader.readSpan(USER_COMMENT_POD_SIZE);
    const blob = reader.readBlob();
    data.push({
      id: String(readInt64Number(pod, 0)),
      articleId: readInt32(pod, 8),
      createTime: new Date(readInt64Number(pod, 12)).toISOString(),
      content: readSliceText(blob, readSliceRef(pod, 20)),
      articleTitle: readFixedUtf8(pod, 28, 256)
    });
  }

  return {
    data,
    nextCursor: nextCursorRaw === 0 ? null : String(nextCursorRaw),
    hasMore
  };
}
