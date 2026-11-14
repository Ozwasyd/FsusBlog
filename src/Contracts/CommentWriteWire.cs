namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(PublicCommentEligibility eligibility)
    {
        if (eligibility.ArticleId <= 0 || eligibility.Publication <= 0 || string.IsNullOrWhiteSpace(eligibility.DisplayName))
            throw new ProtocolException("Invalid public comment eligibility response");
    }

    internal static void Validate(PublicCommentSubmission submission)
    {
        if (submission.ArticleId <= 0 || submission.Publication <= 0 || submission.IdempotencyKey == Guid.Empty ||
            !submission.ExplicitPublic || string.IsNullOrWhiteSpace(submission.DisplayName))
            throw new ProtocolException("Invalid authenticated public comment coordinates");
    }

    internal static void Validate(PublicCommentSubmissionResult result)
    {
        if (result.ArticleId <= 0 || result.CommentId <= 0 || result.ModerationStatus is < 0 or > 3)
            throw new ProtocolException("Invalid public comment submission result");
    }
}
