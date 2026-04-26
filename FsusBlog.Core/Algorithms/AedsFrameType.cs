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
    CommentThreadReplyCursor = 8,
    UploadInit = 20,
    UploadStatus = 21,
    UploadPartAck = 22,
    UploadComplete = 23,
    UploadPartMap = 24,
    ApiEnvelope = 250,
    ApiError = 251
}
