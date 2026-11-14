namespace FsusBlog.V2.Contracts;

public sealed record AdminPendingComment(int ArticleId, long CommentId, long CreatedAt, string DisplayName, string Body);
public sealed record AdminCommentQueue(IReadOnlyList<AdminPendingComment> Comments, bool HasMore);

public static partial class Wire
{
    public static byte[] EncodeAdminCommentQueue(AdminCommentQueue value)
    {
        if (value.Comments.Count > WireLimits.AdminCommentQueueSize || (value.HasMore && value.Comments.Count != WireLimits.AdminCommentQueueSize))
            throw new ProtocolException("Invalid comment moderation queue.");

        var writer = new Writer();
        writer.Bool(value.HasMore);
        writer.I32(value.Comments.Count);
        long previousComment = 0;
        int previousArticle = 0;
        foreach (var row in value.Comments)
        {
            if (row.CommentId <= 0 || row.ArticleId <= 0 || row.CreatedAt <= 0 || row.DisplayName.Length == 0 || row.Body.Length == 0 ||
                (row.CommentId, row.ArticleId).CompareTo((previousComment, previousArticle)) <= 0)
                throw new ProtocolException("Invalid pending comment.");
            writer.I32(row.ArticleId);
            writer.I64(row.CommentId);
            writer.I64(row.CreatedAt);
            writer.Text(row.DisplayName, WireLimits.PublicCommentHandleBytes);
            writer.Text(row.Body, WireLimits.AdminCommentQueueBodyBytes);
            (previousComment, previousArticle) = (row.CommentId, row.ArticleId);
        }
        return Aeds.Encode(FrameType.AdminCommentQueue, writer.Written);
    }
}
