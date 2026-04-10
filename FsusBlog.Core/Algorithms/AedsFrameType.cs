namespace FsusBlog.Core.Algorithms;

public enum AedsFrameType : ushort
{
    Unknown = 0,
    ArticleList = 1,
    ArticleDetail = 2,
    ArticleHot = 3,
    ArticleSearch = 4,
    CommentArticleCursor = 5,
    CommentUserCursor = 6,
    AdminStats = 7,
    ApiEnvelope = 250,
    ApiError = 251
}
