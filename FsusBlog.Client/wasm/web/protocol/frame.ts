export enum FrameType {
  Unknown = 0,
  ArticleList = 1,
  ArticleDetail = 2,
  ArticleHot = 3,
  ArticleSearch = 4,
  CommentArticleCursor = 5,
  CommentUserCursor = 6,
  AdminStats = 7,
  ApiEnvelope = 250,
  ApiError = 251,
}

export const AEDS_HEADER_LENGTH = 24;
export const AEDS_MAGIC = 0x53444541;
export const AEDS_VERSION = 1;

export const PUBLIC_SEO_FRAME_TYPES = new Set<FrameType>([
  FrameType.ArticleList,
  FrameType.ArticleDetail
]);

export function isPublicSeoFrameType(frameType: FrameType | undefined): boolean {
  return frameType !== undefined && PUBLIC_SEO_FRAME_TYPES.has(frameType);
}
