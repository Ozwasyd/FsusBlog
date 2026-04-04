export enum FrameType {
  Unknown = 0,
  ArticleList = 1,
  ArticleDetail = 2,
  ArticleHot = 3,
  ArticleSearch = 4,
  CommentArticleCursor = 5,
  CommentUserCursor = 6,
  AdminStats = 7,
}

export const AEDS_HEADER_LENGTH = 24;
export const AEDS_MAGIC = 0x53444541;
