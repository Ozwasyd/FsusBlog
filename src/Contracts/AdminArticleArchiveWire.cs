namespace FsusBlog.V2.Contracts;

public sealed record AdminArticleArchiveRow(int ArticleId, long Revision, long PrivateReleaseId, int PublicationNo,
    long ArchivedUnixMs, string Title);

public sealed record AdminArticleArchivePage(int NextId, IReadOnlyList<AdminArticleArchiveRow> Items);

public static partial class Wire
{
    public const int AdminArticleArchiveStatus = 3;
    public const int AdminArticleRestoreStatus = 2;

    private static void Validate(AdminArticleArchiveIntent value)
    {
        if (value.ArticleId <= 0 || value.ExpectedRevision <= 0 || value.ExpectedReleaseId <= 0 ||
            value.SourceRevision <= 0 || value.IdempotencyKey == Guid.Empty ||
            value.Reason.Length is < 8 or > 500 || value.Reason != value.Reason.Trim() || value.Reason.Any(char.IsControl) ||
            (value.TargetStatus switch
            {
                AdminArticleArchiveStatus => value.SourceRevision >= value.ExpectedRevision,
                AdminArticleRestoreStatus => value.SourceRevision != value.ExpectedRevision,
                _ => true
            }))
            throw new ProtocolException("Invalid administrator article archive intent");
    }

    private static void Validate(AdminArticleArchiveReceipt value)
    {
        Validate(new AdminArticleArchiveRow(value.ArticleId, value.Revision, value.ReleaseId,
            value.PublicationNo, value.TransitionedUnixMs, ""));
        if (value.SourceRevision <= 0 || value.PreviousReleaseId <= 0 || value.PreviousReleaseId == value.ReleaseId ||
            value.RightsSnapshotId <= 0 || value.ResponsibilitySnapshotId <= 0 ||
            (value.TargetStatus switch
            {
                AdminArticleArchiveStatus => value.SourceRevision >= value.Revision - 1,
                AdminArticleRestoreStatus => value.SourceRevision != value.Revision - 1,
                _ => true
            }))
            throw new ProtocolException("Invalid administrator article archive receipt");
    }

    public static byte[] EncodeAdminArticleArchivePage(AdminArticleArchivePage page)
    {
        if (page.Items.Count > WireLimits.AdminArticleArchivePageSize || page.NextId < 0 ||
            page.NextId != 0 && (page.Items.Count != WireLimits.AdminArticleArchivePageSize ||
                                page.NextId != page.Items[^1].ArticleId))
            throw new ProtocolException("Invalid administrator article archive page");

        var writer = new Writer();
        writer.I32(page.NextId);
        writer.I32(page.Items.Count);
        long before = (long)int.MaxValue + 1;
        foreach (var row in page.Items)
        {
            Validate(row);
            if (row.ArticleId >= before || string.IsNullOrWhiteSpace(row.Title))
                throw new ProtocolException("Invalid administrator article archive page item");
            before = row.ArticleId;
            writer.I32(row.ArticleId);
            writer.I64(row.Revision);
            writer.I64(row.PrivateReleaseId);
            writer.I32(row.PublicationNo);
            writer.I64(row.ArchivedUnixMs);
            writer.Text(row.Title, WireLimits.TitleBytes);
        }
        return Aeds.Encode(FrameType.AdminArticleArchivePage, writer.Written);
    }

    private static void Validate(AdminArticleArchiveRow value)
    {
        if (value.ArticleId <= 0 || value.Revision <= 0 || value.PrivateReleaseId <= 0 ||
            value.PublicationNo < 2 || value.ArchivedUnixMs is <= 0 or > 253402300799999)
            throw new ProtocolException("Invalid administrator article archive coordinates");
    }
}
