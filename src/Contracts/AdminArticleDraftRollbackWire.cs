namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    private static void Validate(AdminArticleDraftRollbackIntent value)
    {
        if (value.TargetStatus != 0)
            throw new ProtocolException("Invalid administrator draft rollback destination");
        Validate(new AdminArticleRollbackIntent(value.ArticleId, value.ExpectedRevision, value.ExpectedPublicationId,
            value.SourceRevision, value.IdempotencyKey, value.Reason));
    }

    private static void Validate(AdminArticleDraftRollbackReceipt value)
    {
        if (value.TargetStatus != 0)
            throw new ProtocolException("Invalid administrator draft rollback destination");
        Validate(new AdminArticleRollbackReceipt(value.ArticleId, value.Revision, value.SourceRevision,
            value.PreviousPublicationId, value.PrivateReleaseId, value.PublicationNo, value.TransitionedUnixMs,
            value.RightsSnapshotId, value.ResponsibilitySnapshotId));
    }
}
