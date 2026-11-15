namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(PublicCommentEligibility eligibility)
    {
        if (eligibility.ArticleId <= 0 || eligibility.Publication <= 0 || string.IsNullOrWhiteSpace(eligibility.DisplayName))
            throw new ProtocolException("Invalid public comment eligibility response");
    }

    internal static void Validate(PublicCommentSubmission submission) => ValidatePublicCommentCoordinates(submission.ArticleId,
        submission.Publication, submission.IdempotencyKey, submission.ExplicitPublic, submission.DisplayName);

    internal static void Validate(PublicCommentReply reply)
    {
        if (reply.ParentId <= 0) throw new ProtocolException("Invalid authenticated public comment reply target");
        ValidatePublicCommentCoordinates(reply.ArticleId, reply.Publication, reply.IdempotencyKey, reply.ExplicitPublic, reply.DisplayName);
    }

    private static void ValidatePublicCommentCoordinates(int article, long publication, Guid id, bool explicitPublic, string display)
    {
        if (article <= 0 || publication <= 0 || id == Guid.Empty || !explicitPublic || string.IsNullOrWhiteSpace(display))
            throw new ProtocolException("Invalid authenticated public comment coordinates");
    }

    internal static void Validate(PublicCommentSubmissionResult result)
    {
        if (result.ArticleId <= 0 || result.CommentId <= 0 || result.ModerationStatus is < 0 or > 3)
            throw new ProtocolException("Invalid public comment submission result");
    }
}
