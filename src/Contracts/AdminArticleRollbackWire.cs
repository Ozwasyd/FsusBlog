namespace FsusBlog.V2.Contracts;

public enum AdminArticleRollbackBlock
{
    Ready = 0,
    MissingRights = 1,
    MissingResponsibility = 2,
    PrivateAttachment = 3,
    PendingSchedule = 4,
    UnpublishedDraft = 5
}

public static partial class Wire
{
    private static void Validate(AdminArticleRollbackIntent value)
    {
        if (value.ArticleId <= 0 || value.ExpectedRevision <= 0 || value.ExpectedPublicationId <= 0 ||
            value.SourceRevision <= 0 || value.SourceRevision >= value.ExpectedRevision || value.IdempotencyKey == Guid.Empty ||
            value.Reason.Length is < 8 or > 500 || value.Reason != value.Reason.Trim() || value.Reason.Any(char.IsControl))
            throw new ProtocolException("Invalid administrator article rollback intent");
    }

    private static void Validate(AdminArticleRollbackPreview value)
    {
        if (value.ArticleId <= 0 || value.CurrentRevision <= 0 || value.CurrentPublicationId <= 0 ||
            value.SourceRevision <= 0 || value.SourceRevision >= value.CurrentRevision || value.SourcePublicationId <= 0 ||
            string.IsNullOrWhiteSpace(value.SourceTitle) ||
            !Enum.IsDefined((AdminArticleRollbackBlock)value.BlockingReason) ||
            value.PackageComplete != (value.BlockingReason == (int)AdminArticleRollbackBlock.Ready))
            throw new ProtocolException("Invalid administrator article rollback preview");
    }

    private static void Validate(AdminArticleRollbackReceipt value)
    {
        if (value.ArticleId <= 0 || value.Revision <= 0 || value.SourceRevision <= 0 || value.SourceRevision >= value.Revision - 1 ||
            value.PreviousPublicationId <= 0 || value.PublicationId <= 0 || value.PreviousPublicationId == value.PublicationId ||
            value.PublicationNo < 2 || value.PublishedUnixMs is <= 0 or > 253402300799999 ||
            value.RightsSnapshotId <= 0 || value.ResponsibilitySnapshotId <= 0)
            throw new ProtocolException("Invalid administrator article rollback receipt");
    }
}
