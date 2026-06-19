import type { ArticleListItemResponse, FeaturedArticleItem } from '@/api/article';
import { resolveCommentAuthorView, type CommentAuthorView, type CommentReplyItem, type CommentReplyPreviewItem, type CommentThreadItem } from '@/api/comment';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { BinaryReader, readBlobText, readFixedTextNullable, readFixedUtf8, readInt32, readInt64Number, readNullableId64, readIsoDate64, readSliceRef, readSliceText } from './reader';
import { COMMENT_AUTHOR_VIEW_POD_SIZE, COMMENT_REPLY_PREVIEW_ITEM_POD_SIZE, COMMENT_THREAD_ITEM_POD_SIZE, FEATURED_ARTICLE_POD_SIZE, TAG_POD_SIZE } from './types';

type TagViewModel = ArticleListItemResponse['tags'][number];
type CategoryViewModel = ArticleListItemResponse['category'];

type CommentCore = Pick<
  CommentReplyItem,
  'id' | 'parentId' | 'rootId' | 'replyToUserId' | 'replyToCommentId' | 'depth' | 'isDeleted' | 'createTime' | 'author' | 'userName' | 'replyToUserName' | 'replyToAuthor' | 'content'
>;

type EmbeddedAuthorRead = {
  author: CommentAuthorView | null;
  nextOffset: number;
};

const textDecoder = new TextDecoder();

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

function readStrictSliceText(blob: Uint8Array, pod: Uint8Array, sliceOffset: number, errorCode: string): { text: string; nextOffset: number } {
  const slice = readSliceRef(pod, sliceOffset);
  const end = slice.offset + slice.length;
  if (slice.offset !== 0 || slice.length < 0 || end > blob.byteLength) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  return {
    text: textDecoder.decode(blob.subarray(slice.offset, end)),
    nextOffset: end
  };
}

function readEmbeddedPayload(blob: Uint8Array, offset: number, errorCode: string): { payload: Uint8Array; nextOffset: number } {
  if (offset < 0 || offset + 4 > blob.byteLength) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  const length = readInt32(blob, offset);
  const payloadOffset = offset + 4;
  const nextOffset = payloadOffset + length;
  if (length < 0 || nextOffset > blob.byteLength) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  return {
    payload: blob.subarray(payloadOffset, nextOffset),
    nextOffset
  };
}

function readRequiredEmbeddedAuthorView(blob: Uint8Array, offset: number, errorCode: string): EmbeddedAuthorRead {
  const result = readEmbeddedPayload(blob, offset, errorCode);
  if (result.payload.byteLength === 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  return {
    author: readCommentAuthorViewPayload(result.payload, errorCode),
    nextOffset: result.nextOffset
  };
}

function readOptionalEmbeddedAuthorView(blob: Uint8Array, offset: number, errorCode: string): EmbeddedAuthorRead {
  const result = readEmbeddedPayload(blob, offset, errorCode);
  return {
    author: result.payload.byteLength === 0 ? null : readCommentAuthorViewPayload(result.payload, errorCode),
    nextOffset: result.nextOffset
  };
}

function readCommentAuthorViewPayload(payload: Uint8Array, errorCode: string): CommentAuthorView {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(COMMENT_AUTHOR_VIEW_POD_SIZE);
  const blob = reader.readBlob();
  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  return resolveCommentAuthorView({
    author: {
      mode: decodeCommentAuthorMode(pod[0] ?? 0, errorCode),
      displayName: readSliceText(blob, readSliceRef(pod, 4)),
      displayLanguage: readSliceText(blob, readSliceRef(pod, 12)),
      badge: nullableAuthorField(readSliceText(blob, readSliceRef(pod, 20))),
      scopeLabel: nullableAuthorField(readSliceText(blob, readSliceRef(pod, 28))),
      credentialLevel: decodeCommentCredentialLevel(pod[1] ?? 0, errorCode)
    }
  });
}

function decodeCommentAuthorMode(raw: number, errorCode: string): CommentAuthorView['mode'] {
  if (raw === 0 || raw === 1) return 'anonymous';
  if (raw === 3) return 'public';
  if (raw === 4) return 'zk_anonymous';
  throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
}

function decodeCommentCredentialLevel(raw: number, errorCode: string): string | null {
  if (raw === 0) return null;
  if (raw === 1) return 'basic';
  if (raw === 2) return 'trusted';
  if (raw === 3) return 'strong_anonymous';
  throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
}

function nullableAuthorField(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readCommentCore(pod: Uint8Array, blob: Uint8Array): CommentCore {
  const userName = readFixedUtf8(pod, 52, 64);
  const replyToUserName = readFixedTextNullable(pod, 116, 64);
  const content = readStrictSliceText(blob, pod, 180, 'comment_content_slice_invalid');
  const author = readRequiredEmbeddedAuthorView(blob, content.nextOffset, 'comment_author_contract_missing');
  const replyToAuthor = readOptionalEmbeddedAuthorView(blob, author.nextOffset, 'comment_reply_author_contract_missing');
  validateReplyAuthorContract(replyToUserName, replyToAuthor.author, replyToAuthor.nextOffset, blob.byteLength);

  return {
    id: String(readInt64Number(pod, 0)),
    parentId: readNullableId64(pod, 8),
    rootId: String(readInt64Number(pod, 16)),
    replyToUserId: (pod[41] ?? 0) === 1 ? readInt32(pod, 24) : null,
    replyToCommentId: readNullableId64(pod, 28),
    depth: readInt32(pod, 36),
    isDeleted: (pod[40] ?? 0) === 1,
    createTime: readIsoDate64(pod, 44),
    author: author.author!,
    userName,
    replyToUserName,
    replyToAuthor: replyToAuthor.author,
    content: content.text
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
  const content = readStrictSliceText(blob, pod, 148, 'comment_preview_content_slice_invalid');
  const author = readRequiredEmbeddedAuthorView(blob, content.nextOffset, 'comment_author_contract_missing');
  const replyToAuthor = readOptionalEmbeddedAuthorView(blob, author.nextOffset, 'comment_reply_author_contract_missing');
  validateReplyAuthorContract(replyToUserName, replyToAuthor.author, replyToAuthor.nextOffset, blob.byteLength);

  return {
    id: String(readInt64Number(pod, 0)),
    isDeleted: (pod[8] ?? 0) === 1,
    createTime: readIsoDate64(pod, 12),
    author: author.author!,
    userName,
    replyToUserName,
    replyToAuthor: replyToAuthor.author,
    content: content.text
  };
}

export function readThreadItemFromReader(reader: BinaryReader): CommentThreadItem {
  const pod = reader.readSpan(COMMENT_THREAD_ITEM_POD_SIZE);
  const blob = reader.readBlob();
  const previewReplyCount = pod[193] ?? 0;
  const repliesPreview: CommentReplyPreviewItem[] = [];
  const userName = readFixedUtf8(pod, 52, 64);
  const content = readStrictSliceText(blob, pod, 180, 'comment_content_slice_invalid');
  const author = readRequiredEmbeddedAuthorView(blob, content.nextOffset, 'comment_author_contract_missing');
  const replyToAuthor = readOptionalEmbeddedAuthorView(blob, author.nextOffset, 'comment_reply_author_contract_missing');
  validateReplyAuthorContract(null, replyToAuthor.author, replyToAuthor.nextOffset, blob.byteLength);

  for (let i = 0; i < previewReplyCount; i++) {
    repliesPreview.push(readReplyPreviewItemFromReader(reader));
  }

  return {
    id: String(readInt64Number(pod, 0)),
    content: content.text,
    createTime: readIsoDate64(pod, 44),
    author: author.author!,
    userName,
    rootId: String(readInt64Number(pod, 16)),
    isDeleted: (pod[40] ?? 0) === 1,
    replyCount: readInt32(pod, 188),
    hasMoreReplies: (pod[192] ?? 0) === 1,
    repliesPreview
  };
}

function validateReplyAuthorContract(
  replyToUserName: string | null,
  replyToAuthor: CommentAuthorView | null,
  nextOffset: number,
  blobLength: number
): void {
  if (nextOffset !== blobLength) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'comment_author_trailing_payload_invalid');
  }

  if (replyToUserName && !replyToAuthor) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'comment_reply_author_contract_missing');
  }

  if (!replyToUserName && replyToAuthor) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'comment_reply_author_contract_unexpected');
  }
}
