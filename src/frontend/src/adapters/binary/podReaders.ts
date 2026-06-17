import type { ArticleListItemResponse, FeaturedArticleItem } from '@/api/article';
import { resolveCommentAuthorView, type CommentReplyItem, type CommentReplyPreviewItem, type CommentThreadItem } from '@/api/comment';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { BinaryReader, readBlobText, readFixedTextNullable, readFixedUtf8, readInt32, readInt64Number, readNullableId64, readIsoDate64 } from './reader';
import { COMMENT_REPLY_PREVIEW_ITEM_POD_SIZE, COMMENT_THREAD_ITEM_POD_SIZE, FEATURED_ARTICLE_POD_SIZE, TAG_POD_SIZE } from './types';

type TagViewModel = ArticleListItemResponse['tags'][number];
type CategoryViewModel = ArticleListItemResponse['category'];

type CommentCore = Pick<
  CommentReplyItem,
  'id' | 'parentId' | 'rootId' | 'replyToUserId' | 'replyToCommentId' | 'depth' | 'isDeleted' | 'createTime' | 'author' | 'userName' | 'replyToUserName' | 'replyToAuthor' | 'content'
>;

function readTagPod(span: Uint8Array): TagViewModel {
  return {
    id: readInt32(span, 0),
    name: readFixedUtf8(span, 4, 128)
  };
}

export function readCategoryPod(
  pod: Uint8Array,
  idOffset: number,
  nameOffset: number,
  nameLength: number
): CategoryViewModel {
  return {
    id: readInt32(pod, idOffset),
    name: readFixedUtf8(pod, nameOffset, nameLength)
  };
}

export function readTagList(reader: BinaryReader): TagViewModel[] {
  const tagCount = reader.readInt32();
  if (tagCount < 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'tag_count_invalid');
  }

  const tags: TagViewModel[] = [];
  for (let i = 0; i < tagCount; i++) {
    tags.push(readTagPod(reader.readSpan(TAG_POD_SIZE)));
  }

  return tags;
}

export function readFeaturedArticleItem(reader: BinaryReader): FeaturedArticleItem {
  const pod = reader.readSpan(FEATURED_ARTICLE_POD_SIZE);
  const payload = reader.readBlob();

  return {
    id: readInt32(pod, 0),
    views: readInt32(pod, 4),
    createTime: readIsoDate64(pod, 8),
    category: readCategoryPod(pod, 16, 20, 128),
    title: readFixedUtf8(pod, 148, 256),
    coverImageUrl: readBlobText(pod, payload, 404)
  };
}

function readCommentCore(pod: Uint8Array, blob: Uint8Array): CommentCore {
  const userName = readFixedUtf8(pod, 52, 64);
  const replyToUserName = readFixedTextNullable(pod, 116, 64);

  return {
    id: String(readInt64Number(pod, 0)),
    parentId: readNullableId64(pod, 8),
    rootId: String(readInt64Number(pod, 16)),
    replyToUserId: (pod[41] ?? 0) === 1 ? readInt32(pod, 24) : null,
    replyToCommentId: readNullableId64(pod, 28),
    depth: readInt32(pod, 36),
    isDeleted: (pod[40] ?? 0) === 1,
    createTime: readIsoDate64(pod, 44),
    author: resolveCommentAuthorView({ userName }),
    userName,
    replyToUserName,
    replyToAuthor: replyToUserName ? resolveCommentAuthorView({ userName: replyToUserName }) : null,
    content: readBlobText(pod, blob, 180)
  };
}

export function readReplyItem(pod: Uint8Array, blob: Uint8Array): CommentReplyItem {
  return readCommentCore(pod, blob);
}

function readReplyPreviewItemFromReader(reader: BinaryReader): CommentReplyPreviewItem {
  const pod = reader.readSpan(COMMENT_REPLY_PREVIEW_ITEM_POD_SIZE);
  const blob = reader.readBlob();
  const userName = readFixedUtf8(pod, 20, 64);
  const replyToUserName = readFixedTextNullable(pod, 84, 64);

  return {
    id: String(readInt64Number(pod, 0)),
    isDeleted: (pod[8] ?? 0) === 1,
    createTime: readIsoDate64(pod, 12),
    author: resolveCommentAuthorView({ userName }),
    userName,
    replyToUserName,
    replyToAuthor: replyToUserName ? resolveCommentAuthorView({ userName: replyToUserName }) : null,
    content: readBlobText(pod, blob, 148)
  };
}

export function readThreadItemFromReader(reader: BinaryReader): CommentThreadItem {
  const pod = reader.readSpan(COMMENT_THREAD_ITEM_POD_SIZE);
  const blob = reader.readBlob();
  const previewReplyCount = pod[193] ?? 0;
  const repliesPreview: CommentReplyPreviewItem[] = [];
  const userName = readFixedUtf8(pod, 52, 64);

  for (let i = 0; i < previewReplyCount; i++) {
    repliesPreview.push(readReplyPreviewItemFromReader(reader));
  }

  return {
    id: String(readInt64Number(pod, 0)),
    content: readBlobText(pod, blob, 180),
    createTime: readIsoDate64(pod, 44),
    author: resolveCommentAuthorView({ userName }),
    userName,
    rootId: String(readInt64Number(pod, 16)),
    isDeleted: (pod[40] ?? 0) === 1,
    replyCount: readInt32(pod, 188),
    hasMoreReplies: (pod[192] ?? 0) === 1,
    repliesPreview
  };
}
