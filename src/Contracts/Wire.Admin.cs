namespace FsusBlog.V2.Contracts;

public sealed record AdminAppearancePackage(string Id, string Version, string Digest, bool Font);
public sealed record AdminAppearanceChange(long Revision, long HappenedUnixMs, string Actor, bool Rollback,
    string PreviousTheme, string PreviousFont, string Theme, string Font);
public sealed record AdminAppearanceHistoryPage(long NextBefore, IReadOnlyList<AdminAppearanceChange> Items);

public sealed record AdminArticleArchiveRow(int ArticleId, long Revision, long PrivateReleaseId, int PublicationNo,
    long ArchivedUnixMs, string Title);
public sealed record AdminArticleArchivePage(int NextId, IReadOnlyList<AdminArticleArchiveRow> Items);

public enum AdminArticleRollbackBlock
{
    Ready = 0,
    MissingRights = 1,
    MissingResponsibility = 2,
    PrivateAttachment = 3,
    PendingSchedule = 4,
    UnpublishedDraft = 5
}

public sealed record AdminPendingComment(int ArticleId, long CommentId, long CreatedAt, string DisplayName, string Body);
public sealed record AdminCommentQueue(IReadOnlyList<AdminPendingComment> Comments, bool HasMore);
public sealed record AdminInboxNotice(Guid Account, string Subject, string Body);
public sealed record AdminInboxRow(long Id, Guid Account, string Subject, int Status, bool System, long UpdatedAt,
    int Unread = 0);
public sealed record AdminInboxPage(IReadOnlyList<AdminInboxRow> Rows, string? Next);
public sealed record AdminInboxMessage(long Id, int Sender, bool Internal, long At, string Body);
public sealed record AdminInboxThread(AdminInboxRow Conversation, IReadOnlyList<AdminInboxMessage> Messages, string? Previous,
    string? Version = null, string? ReadSnapshot = null);

public sealed record AdminModerationBatchItem(int ArticleId, long CommentId, long CommentVersion, string ClaimToken,
    long ClaimGeneration, long ClaimVersion, int ExpectedStatus);
public sealed record AdminModerationBatchDecision(int Decision, string Reason, IReadOnlyList<AdminModerationBatchItem> Rows);
public sealed record AdminModerationBatchReceipt(long BatchId, int Count);

public sealed record SiteTrafficDay(string Date, long Views);
public sealed record SiteTrafficRegion(string Region, long Views);
public sealed record AdminSiteTraffic(bool Enabled, bool RegionsConfigured, IReadOnlyList<SiteTrafficDay> Days,
    IReadOnlyList<SiteTrafficRegion> Regions);

public sealed record AdminTagMetadataCommand(int Id, long ExpectedRevision, Guid RequestId, string Name, string Description);
public sealed record AdminTagMetadata(int Id, long Revision, string Name, string Description, bool Changed);
public sealed record AdminTaxonomyItem(int Id, string Name, int Published, int Drafts, int Scheduled, int Retracted, int Deleted,
    int RetainedArticles);
public sealed record AdminTaxonomyPage(int NextId, IReadOnlyList<AdminTaxonomyItem> Items);
public sealed record AdminTaxonomyDependencies(int Id, int ActiveArticles, int RetainedOnlyArticles, int ReservedAliases);

public static partial class Wire
{
    public const int AdminArticleArchiveStatus = 3;
    public const int AdminArticleRestoreStatus = 2;
    public const int MaxAdminInboxNoticeFrameBytes = Aeds.HeaderSize + 16 + 8 + 640 + 16000;
    public const int AdminInboxPageSize = 24;
    public const int AdminInboxThreadSize = 24;
    private const long MaxReaderUnixMs = 8_640_000_000_000_000L;

    private static bool ValidAdminReason(string reason) =>
        reason.Length is >= 8 and <= 500 && reason == reason.Trim() && !reason.Any(char.IsControl);

    private static bool AppearanceDigest(string value) =>
        value.Length == 0 || IsLowerHex(value, AdminAppearanceDigestBytes);

    private static void Validate(AdminAppearanceState value)
    {
        if (value.Revision < 0 || !AppearanceDigest(value.Theme) || !AppearanceDigest(value.Font) ||
            !AppearanceDigest(value.PreviousTheme) || !AppearanceDigest(value.PreviousFont) ||
            (value.Revision == 0 && (value.CanRollback || value.PreviousTheme.Length != 0 || value.PreviousFont.Length != 0)))
            throw new ProtocolException("Invalid appearance activation state");
    }

    private static void Validate(AdminAppearanceCommand value)
    {
        if (value.ExpectedRevision < 0 || !AppearanceDigest(value.CurrentTheme) || !AppearanceDigest(value.CurrentFont) ||
            !AppearanceDigest(value.Theme) || !AppearanceDigest(value.Font))
            throw new ProtocolException("Invalid appearance activation command");
    }

    private static void Validate(AdminAppearanceFontDetail value)
    {
        if (string.IsNullOrWhiteSpace(value.Id) || string.IsNullOrWhiteSpace(value.Version) ||
            !IsLowerHex(value.ArchiveDigest, AdminAppearanceDigestBytes) ||
            !IsLowerHex(value.FaceDigest, AdminAppearanceDigestBytes) ||
            value.LicenseName is not ("OFL-1.1" or "Apache-2.0") || string.IsNullOrWhiteSpace(value.LicenseText) ||
            value.FaceWeight != 400 || value.FaceStyle != "normal" || value.FaceBytes is < 1 or > AdminAppearanceFontAssetBytes)
            throw new ProtocolException("Invalid appearance font detail");
        if (value.SourceKind.Length == 0
            ? value.Name.Length != 0 || value.Family.Length != 0 || value.SourcePackage.Length != 0 ||
                value.SourceVersion.Length != 0 || value.SourceUpstream.Length != 0 || value.UnicodeRange.Length != 0
            : value.SourceKind is not ("local-vendored" or "npm-fontsource") ||
                string.IsNullOrWhiteSpace(value.Name) || string.IsNullOrWhiteSpace(value.Family) ||
                string.IsNullOrWhiteSpace(value.SourcePackage) || string.IsNullOrWhiteSpace(value.SourceVersion) ||
                string.IsNullOrWhiteSpace(value.SourceUpstream))
            throw new ProtocolException("Invalid appearance font source");
    }

    public static byte[] EncodeAdminAppearanceCatalog(IReadOnlyList<AdminAppearancePackage> packages)
    {
        if (packages.Count > AdminAppearanceMaximumItems)
            throw new ProtocolException("Invalid appearance catalog size");
        return EncodeFrame(FrameType.AdminAppearanceCatalog, writer => writer.Items(packages, static (w, package) =>
        {
            if (!IsLowerHex(package.Digest, AdminAppearanceDigestBytes))
                throw new ProtocolException("Invalid appearance package digest");
            w.Text(package.Id, AdminAppearanceIdBytes).Text(package.Version, AdminAppearanceVersionBytes)
                .Text(package.Digest, AdminAppearanceDigestBytes).Bool(package.Font);
        }));
    }

    public static byte[] EncodeAdminAppearanceHistory(AdminAppearanceHistoryPage page, int limit)
    {
        if (limit is < 1 or > AdminAppearanceHistoryMaximumItems || page.Items.Count > limit || page.NextBefore < 0 ||
            page.NextBefore > 0 && (page.Items.Count != limit || page.NextBefore != page.Items[^1].Revision))
            throw new ProtocolException("Invalid appearance history page");
        return EncodeFrame(FrameType.AdminAppearanceHistory, writer =>
        {
            long? previous = null;
            writer.I64(page.NextBefore).Items(page.Items, (w, change) =>
            {
                if (change.Revision <= 0 || previous is { } priorRevision && change.Revision >= priorRevision ||
                    change.HappenedUnixMs <= 0 || !IsValidUnixMs(change.HappenedUnixMs) || !ValidAdminHandle(change.Actor) ||
                    !AppearanceDigest(change.PreviousTheme) || !AppearanceDigest(change.PreviousFont) ||
                    !AppearanceDigest(change.Theme) || !AppearanceDigest(change.Font) ||
                    change.PreviousTheme == change.Theme && change.PreviousFont == change.Font)
                    throw new ProtocolException("Invalid appearance history item");
                previous = change.Revision;
                w.I64(change.Revision).I64(change.HappenedUnixMs).Text(change.Actor, NameBytes).Bool(change.Rollback)
                    .Text(change.PreviousTheme, AdminAppearanceDigestBytes).Text(change.PreviousFont, AdminAppearanceDigestBytes)
                    .Text(change.Theme, AdminAppearanceDigestBytes).Text(change.Font, AdminAppearanceDigestBytes);
            });
        });
    }

    private static void Validate(AdminArticleArchiveIntent value)
    {
        if (value.ArticleId <= 0 || value.ExpectedRevision <= 0 || value.ExpectedReleaseId <= 0 ||
            value.SourceRevision <= 0 || value.IdempotencyKey == Guid.Empty || !ValidAdminReason(value.Reason) ||
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

    private static void Validate(AdminArticleArchivePreview value)
    {
        if (value.ArticleId <= 0 || value.Revision <= 0 || value.PrivateReleaseId <= 0 || string.IsNullOrWhiteSpace(value.Title))
            throw new ProtocolException("Invalid administrator article archive preview");
    }

    public static byte[] EncodeAdminArticleArchivePage(AdminArticleArchivePage page)
    {
        if (page.Items.Count > AdminArticleArchivePageSize || page.NextId < 0 ||
            page.NextId != 0 && (page.Items.Count != AdminArticleArchivePageSize || page.NextId != page.Items[^1].ArticleId))
            throw new ProtocolException("Invalid administrator article archive page");
        return EncodeFrame(FrameType.AdminArticleArchivePage, writer =>
        {
            long before = (long)int.MaxValue + 1;
            writer.I32(page.NextId).Items(page.Items, (w, row) =>
            {
                Validate(row);
                if (row.ArticleId >= before || string.IsNullOrWhiteSpace(row.Title))
                    throw new ProtocolException("Invalid administrator article archive page item");
                before = row.ArticleId;
                w.I32(row.ArticleId).I64(row.Revision).I64(row.PrivateReleaseId).I32(row.PublicationNo)
                    .I64(row.ArchivedUnixMs).Text(row.Title, TitleBytes);
            });
        });
    }

    private static void Validate(AdminArticleArchiveRow value)
    {
        if (value.ArticleId <= 0 || value.Revision <= 0 || value.PrivateReleaseId <= 0 ||
            value.PublicationNo < 2 || value.ArchivedUnixMs <= 0 || !IsValidUnixMs(value.ArchivedUnixMs))
            throw new ProtocolException("Invalid administrator article archive coordinates");
    }

    private static void Validate(AdminArticleDraftRollbackIntent value)
    {
        if (value.TargetStatus != 0) throw new ProtocolException("Invalid administrator draft rollback destination");
        Validate(new AdminArticleRollbackIntent(value.ArticleId, value.ExpectedRevision, value.ExpectedPublicationId,
            value.SourceRevision, value.IdempotencyKey, value.Reason));
    }

    private static void Validate(AdminArticleDraftRollbackReceipt value)
    {
        if (value.TargetStatus != 0) throw new ProtocolException("Invalid administrator draft rollback destination");
        Validate(new AdminArticleRollbackReceipt(value.ArticleId, value.Revision, value.SourceRevision,
            value.PreviousPublicationId, value.PrivateReleaseId, value.PublicationNo, value.TransitionedUnixMs,
            value.RightsSnapshotId, value.ResponsibilitySnapshotId));
    }

    private static void Validate(AdminArticleRollbackIntent value)
    {
        if (value.ArticleId <= 0 || value.ExpectedRevision <= 0 || value.ExpectedPublicationId <= 0 ||
            value.SourceRevision <= 0 || value.SourceRevision >= value.ExpectedRevision || value.IdempotencyKey == Guid.Empty ||
            !ValidAdminReason(value.Reason))
            throw new ProtocolException("Invalid administrator article rollback intent");
    }

    private static void Validate(AdminArticleRollbackPreview value)
    {
        if (value.ArticleId <= 0 || value.CurrentRevision <= 0 || value.CurrentPublicationId <= 0 ||
            value.SourceRevision <= 0 || value.SourceRevision >= value.CurrentRevision || value.SourcePublicationId <= 0 ||
            string.IsNullOrWhiteSpace(value.SourceTitle) || !Enum.IsDefined((AdminArticleRollbackBlock)value.BlockingReason) ||
            value.PackageComplete != (value.BlockingReason == (int)AdminArticleRollbackBlock.Ready))
            throw new ProtocolException("Invalid administrator article rollback preview");
    }

    private static void Validate(AdminArticleRollbackReceipt value)
    {
        if (value.ArticleId <= 0 || value.Revision <= 0 || value.SourceRevision <= 0 || value.SourceRevision >= value.Revision - 1 ||
            value.PreviousPublicationId <= 0 || value.PublicationId <= 0 || value.PreviousPublicationId == value.PublicationId ||
            value.PublicationNo < 2 || value.PublishedUnixMs <= 0 || !IsValidUnixMs(value.PublishedUnixMs) ||
            value.RightsSnapshotId <= 0 || value.ResponsibilitySnapshotId <= 0)
            throw new ProtocolException("Invalid administrator article rollback receipt");
    }

    private static void Validate(AdminArticleTrashPublicationPreview preview)
    {
        ValidateTrashPublication(preview.ArticleId, preview.ExpectedRevision, preview.SourceRevision, preview.SourcePublicationId);
        if (string.IsNullOrWhiteSpace(preview.Title)) throw new ProtocolException("Invalid former publication title.");
    }

    private static void Validate(AdminArticleTrashPublicationIntent intent)
    {
        ValidateTrashPublication(intent.ArticleId, intent.ExpectedRevision, intent.SourceRevision, intent.SourcePublicationId);
        if (intent.IdempotencyKey == Guid.Empty || !ValidAdminReason(intent.Reason))
            throw new ProtocolException("Invalid trash republication approval.");
    }

    private static void Validate(AdminArticleTrashPublicationReceipt receipt)
    {
        if (receipt.Revision < 3 || receipt.PublicationId <= 0 || receipt.PublicationId == receipt.SourcePublicationId)
            throw new ProtocolException("Invalid recovered publication.");
        ValidateTrashPublication(receipt.ArticleId, receipt.Revision - 1, receipt.SourceRevision, receipt.SourcePublicationId);
    }

    private static void ValidateTrashPublication(int article, long expected, long source, long publication)
    {
        if (article <= 0 || source <= 0 || source >= expected || expected == long.MaxValue || publication <= 0)
            throw new ProtocolException("Invalid former publication coordinates.");
    }

    private static void Validate(AdminArticleTrashRestoreIntent value)
    {
        if (value.ArticleId <= 0 || value.ExpectedRevision is <= 0 or long.MaxValue || value.IdempotencyKey == Guid.Empty)
            throw new ProtocolException("Invalid administrator trash restore intent.");
    }

    private static void Validate(AdminArticleTrashRestoreReceipt value)
    {
        if (value.ArticleId <= 0 || value.Revision < 2)
            throw new ProtocolException("Invalid administrator trash restore receipt.");
    }

    internal static void Validate(AdminClusterStatus value)
    {
        if (value.Mode != 1 || value.InstanceId == Guid.Empty || !ValidClusterNodeId(value.NodeId) ||
            value.BuildVersion.Length is < 1 or > AdminClusterVersionBytes ||
            !value.BuildVersion.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '-' or '+') ||
            value.StartedAt <= 0 || !IsValidUnixMs(value.StartedAt) || value.ObservedAt <= 0 || !IsValidUnixMs(value.ObservedAt) ||
            value.LeaseAgeMs is < 0 or >= 1000)
            throw new ProtocolException("Invalid standalone deployment observation.");
    }

    public static bool ValidClusterNodeId(string value) => value.Length <= AdminClusterNodeIdBytes &&
        value.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '-' or '_');

    public static byte[] EncodeAdminCommentQueue(AdminCommentQueue value)
    {
        if (value.Comments.Count > AdminCommentQueueSize || (value.HasMore && value.Comments.Count != AdminCommentQueueSize))
            throw new ProtocolException("Invalid comment moderation queue.");
        return EncodeFrame(FrameType.AdminCommentQueue, writer =>
        {
            long previousComment = 0;
            int previousArticle = 0;
            writer.Bool(value.HasMore).Items(value.Comments, (w, row) =>
            {
                if (row.CommentId <= 0 || row.ArticleId <= 0 || row.CreatedAt <= 0 || row.DisplayName.Length == 0 || row.Body.Length == 0 ||
                    (row.CommentId, row.ArticleId).CompareTo((previousComment, previousArticle)) <= 0)
                    throw new ProtocolException("Invalid pending comment.");
                w.I32(row.ArticleId).I64(row.CommentId).I64(row.CreatedAt)
                    .Text(row.DisplayName, PublicCommentHandleBytes).Text(row.Body, AdminCommentQueueBodyBytes);
                (previousComment, previousArticle) = (row.CommentId, row.ArticleId);
            });
        });
    }

    internal static void Validate(AdminModerationIntent value)
    {
        if (value.ArticleId <= 0 || value.CommentId <= 0 || value.ExpectedStatus != 0 || value.Decision is not (1 or 2) ||
            value.Reason.Length == 0 || value.Reason != value.Reason.Trim() || value.Reason.Any(char.IsControl))
            throw new ProtocolException("Invalid pending comment moderation intent.");
    }

    internal static void Validate(AdminModerationClaimRequest value)
    {
        if (value.ArticleId <= 0 || value.CommentId <= 0) throw new ProtocolException("Invalid pending comment coordinates.");
    }

    internal static void Validate(AdminModerationClaim value)
    {
        Validate(new AdminModerationClaimRequest(value.ArticleId, value.CommentId));
        ValidateClaim(value.CommentVersion, value.ClaimGeneration, value.ClaimVersion, value.ClaimToken);
        if (value.ExpiresAt <= 0) throw new ProtocolException("Invalid comment claim expiry.");
    }

    internal static void Validate(AdminModerationDecision value)
    {
        Validate(new AdminModerationIntent(value.ArticleId, value.CommentId, value.ExpectedStatus, value.Decision, value.Reason));
        ValidateClaim(value.CommentVersion, value.ClaimGeneration, value.ClaimVersion, value.ClaimToken);
    }

    private static void ValidateClaim(long commentVersion, long generation, long version, string token)
    {
        if (commentVersion <= 0 || generation <= 0 || version <= 0 ||
            token.Length != AdminModerationClaimTokenBytes || !IsBase64Url(token))
            throw new ProtocolException("Invalid comment claim coordinates.");
    }

    internal static void Validate(AdminSessionSnapshot value)
    {
        if (value.Handle.Length is < 1 or > 64 || value.Generation <= 0 || value.ExpiresAt <= 0)
            throw new ProtocolException("Invalid administrator session.");
    }

    internal static void Validate(AdminOperationsStatus value)
    {
        if (value.PublicationWatermark < 0 || (!value.SnapshotReady && value.PublicationWatermark != 0) ||
            value.PendingPublicationEvents < 0 || value.OldestPendingAt < 0 ||
            (value.PendingPublicationEvents == 0) != (value.OldestPendingAt == 0))
            throw new ProtocolException("Invalid administrator operations status.");
    }

    public static byte[] EncodeAdminInboxNotice(AdminInboxNotice notice)
    {
        if (notice.Account == Guid.Empty) throw InvalidNotice();
        return EncodeFrame(FrameType.AdminInboxNotice,
            writer => writer.Uuid(notice.Account).Text(notice.Subject, 640).Text(notice.Body, 16000));
    }

    public static AdminInboxNotice DecodeAdminInboxNotice(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.AdminInboxNotice, frame, MaxAdminInboxNoticeFrameBytes, InvalidNotice, static (ref Reader reader) =>
        {
            var account = reader.Uuid();
            if (account == Guid.Empty) throw InvalidNotice();
            return new AdminInboxNotice(account, reader.Text(640), reader.Text(16000));
        });

    private static ProtocolException InvalidNotice() => new("Invalid administrator system notice.");

    public static byte[] EncodeAdminInboxPage(AdminInboxPage page, bool shared = false)
    {
        if (page.Rows.Count > AdminInboxPageSize || page.Next is not null && page.Rows.Count != AdminInboxPageSize)
            throw new ProtocolException("Invalid administrator inbox page.");
        return EncodeFrame(shared ? FrameType.AdminInboxSharedPage : FrameType.AdminInboxPage,
            writer => writer.Text(page.Next ?? "", 100).Items(page.Rows, (w, row) => WriteAdminInboxRow(w, row, shared)));
    }

    public static byte[] EncodeAdminInboxThread(AdminInboxThread thread, bool shared = false)
    {
        if (thread.Messages.Count is < 1 or > AdminInboxThreadSize || thread.Previous is not null && thread.Messages.Count != AdminInboxThreadSize)
            throw new ProtocolException("Invalid administrator inbox thread.");
        return EncodeFrame(shared ? FrameType.AdminInboxSharedThread : FrameType.AdminInboxThread, writer =>
        {
            WriteAdminInboxRow(writer, thread.Conversation, shared);
            long previous = 0;
            writer.Text(thread.Previous ?? "", 100).Items(thread.Messages, (w, message) =>
            {
                if (message.Id <= previous || message.At <= 0 || message.Sender is < 0 or > 2 || message.Body.Length == 0)
                    throw new ProtocolException("Invalid administrator inbox message.");
                w.I64(message.Id).I32(message.Sender).Bool(message.Internal).I64(message.At).Text(message.Body, 16000);
                previous = message.Id;
            });
        });
    }

    private static void WriteAdminInboxRow(Writer writer, AdminInboxRow row, bool shared)
    {
        if (row.Id <= 0 || row.Account == Guid.Empty || row.Subject.Length == 0 || row.Status is < 0 or > 2 || row.UpdatedAt <= 0)
            throw new ProtocolException("Invalid administrator inbox conversation.");
        writer.I64(row.Id).Uuid(row.Account).Text(row.Subject, 640).I32(row.Status).Bool(row.System).I64(row.UpdatedAt);
        if (shared)
        {
            if (row.Unread < 0) throw new ProtocolException("Invalid administrator unread count.");
            writer.I32(row.Unread);
        }
    }

    public static byte[] EncodeAdminModerationBatchTargets(IReadOnlyList<AdminModerationClaimRequest> targets) =>
        EncodeBatch(FrameType.AdminModerationBatchTargets, targets, static (w, seen, target) =>
        {
            BatchTarget(seen, target.ArticleId, target.CommentId);
            w.I32(target.ArticleId).I64(target.CommentId);
        });

    public static IReadOnlyList<AdminModerationClaimRequest> DecodeAdminModerationBatchTargets(ReadOnlySpan<byte> frame) =>
        DecodeBatch(FrameType.AdminModerationBatchTargets, frame, static (ref Reader reader, HashSet<(int, long)> seen) =>
        {
            var target = new AdminModerationClaimRequest(reader.I32(), reader.I64());
            BatchTarget(seen, target.ArticleId, target.CommentId);
            return target;
        });

    public static byte[] EncodeAdminModerationBatchClaims(IReadOnlyList<AdminModerationClaim> claims) =>
        EncodeBatch(FrameType.AdminModerationBatchClaims, claims, static (w, seen, claim) =>
        {
            BatchTarget(seen, claim.ArticleId, claim.CommentId);
            Validate(claim);
            WriteBatchClaim(w, claim.ArticleId, claim.CommentId, claim.CommentVersion, claim.ClaimToken,
                claim.ClaimGeneration, claim.ClaimVersion).I64(claim.ExpiresAt);
        });

    public static IReadOnlyList<AdminModerationClaim> DecodeAdminModerationBatchClaims(ReadOnlySpan<byte> frame) =>
        DecodeBatch(FrameType.AdminModerationBatchClaims, frame, static (ref Reader reader, HashSet<(int, long)> seen) =>
        {
            var claim = new AdminModerationClaim(reader.I32(), reader.I64(), reader.I64(),
                reader.Text(AdminModerationClaimTokenBytes), reader.I64(), reader.I64(), reader.I64());
            BatchTarget(seen, claim.ArticleId, claim.CommentId);
            Validate(claim);
            return claim;
        });

    public static byte[] EncodeAdminModerationBatchDecision(AdminModerationBatchDecision value)
    {
        ValidateBatchDecision(value.Decision, value.Reason);
        return EncodeFrame(FrameType.AdminModerationBatchDecision, writer =>
        {
            writer.I32(value.Decision).Text(value.Reason, AdminModerationReasonBytes);
            WriteBatchItems(writer, value.Rows, static (w, seen, row) =>
            {
                BatchDecisionTarget(seen, row);
                WriteBatchClaim(w, row.ArticleId, row.CommentId, row.CommentVersion, row.ClaimToken,
                    row.ClaimGeneration, row.ClaimVersion).I32(row.ExpectedStatus);
            });
        });
    }

    public static AdminModerationBatchDecision DecodeAdminModerationBatchDecision(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.AdminModerationBatchDecision, frame, static (ref Reader reader) =>
        {
            var decision = reader.I32();
            var reason = reader.Text(AdminModerationReasonBytes);
            ValidateBatchDecision(decision, reason);
            var rows = ReadBatchItems(ref reader, static (ref Reader r, HashSet<(int, long)> seen) =>
            {
                var row = new AdminModerationBatchItem(r.I32(), r.I64(), r.I64(),
                    r.Text(AdminModerationClaimTokenBytes), r.I64(), r.I64(), r.I32());
                BatchDecisionTarget(seen, row);
                return row;
            });
            return new AdminModerationBatchDecision(decision, reason, rows);
        });

    public static byte[] EncodeAdminModerationBatchReceipt(AdminModerationBatchReceipt value) =>
        EncodeFrame(FrameType.AdminModerationBatchReceipt,
            writer => writer.I64(BatchId(value.BatchId)).I32(BatchCount(value.Count)));

    public static AdminModerationBatchReceipt DecodeAdminModerationBatchReceipt(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.AdminModerationBatchReceipt, frame,
            static (ref Reader reader) => new AdminModerationBatchReceipt(BatchId(reader.I64()), BatchCount(reader.I32())));

    private delegate T ReadBatchItem<T>(ref Reader reader, HashSet<(int, long)> seen);

    private static byte[] EncodeBatch<T>(FrameType type, IReadOnlyList<T> items, Action<Writer, HashSet<(int, long)>, T> write) =>
        EncodeFrame(type, writer => WriteBatchItems(writer, items, write));

    private static T[] DecodeBatch<T>(FrameType type, ReadOnlySpan<byte> frame, ReadBatchItem<T> read) =>
        DecodeFrame(type, frame, (ref Reader reader) => ReadBatchItems(ref reader, read));

    private static void WriteBatchItems<T>(Writer writer, IReadOnlyList<T> items, Action<Writer, HashSet<(int, long)>, T> write)
    {
        writer.I32(BatchCount(items.Count));
        var seen = new HashSet<(int, long)>();
        foreach (var item in items) write(writer, seen, item);
    }

    private static T[] ReadBatchItems<T>(ref Reader reader, ReadBatchItem<T> read)
    {
        var items = new T[BatchCount(reader.I32())];
        var seen = new HashSet<(int, long)>();
        for (var i = 0; i < items.Length; i++) items[i] = read(ref reader, seen);
        return items;
    }

    private static Writer WriteBatchClaim(Writer writer, int article, long comment, long commentVersion, string token,
        long generation, long version) =>
        writer.I32(article).I64(comment).I64(commentVersion).Text(token, AdminModerationClaimTokenBytes)
            .I64(generation).I64(version);

    private static void BatchDecisionTarget(HashSet<(int, long)> seen, AdminModerationBatchItem row)
    {
        BatchTarget(seen, row.ArticleId, row.CommentId);
        if (row.ExpectedStatus != 0) throw new ProtocolException("Invalid pending comment status for moderation batch.");
        ValidateClaim(row.CommentVersion, row.ClaimGeneration, row.ClaimVersion, row.ClaimToken);
    }

    private static void BatchTarget(HashSet<(int, long)> seen, int article, long comment)
    {
        if (article <= 0 || comment <= 0 || !seen.Add((article, comment)))
            throw new ProtocolException("Invalid or duplicate moderation batch target.");
    }

    private static void ValidateBatchDecision(int decision, string reason)
    {
        if (decision is not (1 or 2) || reason.Length == 0 || reason != reason.Trim() || reason.Any(char.IsControl))
            throw new ProtocolException("Invalid comment moderation batch decision.");
    }

    private static int BatchCount(int count) => count is >= AdminModerationBatchMinimum and <= AdminModerationBatchCount
        ? count : throw new ProtocolException("Invalid comment moderation batch size.");

    private static long BatchId(long id) => id > 0 ? id : throw new ProtocolException("Invalid comment moderation batch receipt.");

    internal static void Validate(AdminReaderAccountPage value)
    {
        if (value is null || value.Items is null ||
            value.Total < 0 || value.EnabledTotal < 0 || value.DisabledTotal < 0 ||
            value.Total > value.EnabledTotal + value.DisabledTotal ||
            value.Items.Count > AdminReaderPageSize || value.NextCursorAccountId < 0 ||
            (value.HasMore ? value.NextCursorUserId == Guid.Empty || value.Items.Count == 0
                : value.NextCursorAccountId != 0 || value.NextCursorUserId != Guid.Empty))
            throw new ProtocolException("Invalid administrator reader account page.");

        foreach (var item in value.Items)
        {
            if (item is null || item.UserId == Guid.Empty || item.AccountId < 0 ||
                string.IsNullOrEmpty(item.Name) || item.Generation <= 0 ||
                item.PasskeyCount < 0 || item.ActiveSessionCount < 0 || item.CommentCount < 0 ||
                item.RegisteredAtUnixMs is < 0 or > MaxReaderUnixMs ||
                item.LastUsedAtUnixMs is < 0 or > MaxReaderUnixMs ||
                item.LastGovernanceAtUnixMs is < 0 or > MaxReaderUnixMs ||
                (item.LastGovernanceAtUnixMs == 0
                    ? item.LastGovernanceActor.Length > 0 || item.LastGovernanceReason.Length > 0
                    : item.LastGovernanceActor.Length == 0 || item.LastGovernanceReason.Length == 0))
                throw new ProtocolException("Invalid administrator reader account entry.");
        }
    }

    internal static void Validate(AdminReaderStatusCommand value)
    {
        if (value is null || value.UserId == Guid.Empty || value.ExpectedGeneration <= 0 ||
            value.IdempotencyKey == Guid.Empty || value.Reason.Length is 0 or > AdminReaderReasonChars)
            throw new ProtocolException("Invalid administrator reader status command.");
    }

    internal static void Validate(AdminReaderStatusReceipt value)
    {
        if (value is null || value.UserId == Guid.Empty || value.Generation <= 1 ||
            value.RevokedSessionCount < 0 || value.HappenedAtUnixMs is <= 0 or > MaxReaderUnixMs)
            throw new ProtocolException("Invalid administrator reader status receipt.");
    }

    internal static void Validate(AdminRiskReadiness value)
    {
        if (value.PublicReadMode != 1 || value.RootWriteMode is < 0 or > 1 ||
            value.ReplyWriteMode is < 0 or > 2 || (value.RootWriteMode == 0 && value.ReplyWriteMode != 0) ||
            value.ForwardingMode is < 0 or > 1 || value.DynamicRisk != 0 || value.StrongAnonymous != 0)
            throw new ProtocolException("Invalid installed risk controls.");
    }

    private static void Validate(AdminSiteConfigState value)
    {
        if (value.Revision < 0 || !IsLowerHex(value.Digest, AdminSiteConfigDigestBytes) || value.Origin.Contains('\0'))
            throw new ProtocolException("Invalid administrator site configuration state");
        ValidateSiteConfigFields(value.RegionMode, value.CopyrightStartYear,
            value.Title, value.Description, value.Author, value.OgImage, value.FaviconSvgUrl, value.FaviconIcoUrl,
            value.FaviconPngUrl, value.AppleTouchIconUrl, value.ManifestName, value.ManifestShortName,
            value.PwaIcon192Url, value.PwaIcon512Url, value.PwaMaskableIconUrl, value.ThemeColor,
            value.BackgroundColor, value.SiteLogoUrl, value.SiteLogoDarkUrl, value.SiteWordmarkUrl,
            value.CopyrightOwner, value.CopyrightText, value.ContentLicenseName, value.ContentLicenseUrl,
            value.IcpRecordNumber, value.IcpRecordUrl, value.PoliceRecordNumber, value.PoliceRecordUrl,
            value.PoliceBadgeIconUrl, value.OperatorName, value.ContactEmail);
    }

    private static void Validate(AdminSiteConfigCommand value)
    {
        if (value.ExpectedRevision < 0 || !IsLowerHex(value.ExpectedDigest, AdminSiteConfigDigestBytes))
            throw new ProtocolException("Invalid administrator site configuration command");
        ValidateSiteConfigFields(value.RegionMode, value.CopyrightStartYear,
            value.Title, value.Description, value.Author, value.OgImage, value.FaviconSvgUrl, value.FaviconIcoUrl,
            value.FaviconPngUrl, value.AppleTouchIconUrl, value.ManifestName, value.ManifestShortName,
            value.PwaIcon192Url, value.PwaIcon512Url, value.PwaMaskableIconUrl, value.ThemeColor,
            value.BackgroundColor, value.SiteLogoUrl, value.SiteLogoDarkUrl, value.SiteWordmarkUrl,
            value.CopyrightOwner, value.CopyrightText, value.ContentLicenseName, value.ContentLicenseUrl,
            value.IcpRecordNumber, value.IcpRecordUrl, value.PoliceRecordNumber, value.PoliceRecordUrl,
            value.PoliceBadgeIconUrl, value.OperatorName, value.ContactEmail);
    }

    private static void ValidateSiteConfigFields(string regionMode, int copyrightStartYear, params ReadOnlySpan<string> texts)
    {
        if (regionMode is not ("global" or "mainland-cn"))
            throw new ProtocolException("Invalid site configuration region mode");
        if (copyrightStartYear is < 0 or > 9999)
            throw new ProtocolException("Invalid site configuration copyright year");
        foreach (var text in texts)
            if (text is null || text.Contains('\0'))
                throw new ProtocolException("Invalid site configuration text");
    }

    private static void Validate(AdminSitePages value)
    {
        if (value.ConfiguredMask is < 0 or > 15)
            throw new ProtocolException("Invalid site page configuration states");
    }

    private static void Validate(AdminSitePageRevision value) =>
        ValidatePageEditor(value.Slug, value.Revision, value.Digest, value.Markdown);

    private static void Validate(AdminSitePagePublish value) =>
        ValidatePageEditor(value.Slug, value.ExpectedRevision, value.ExpectedDigest, value.Markdown);

    private static void ValidatePageEditor(string slug, long revision, string digest, string markdown)
    {
        if (slug is not ("about" or "privacy" or "guidelines" or "copyright") ||
            revision < 0 || !IsLowerHex(digest, AdminSitePageDigestBytes) ||
            markdown.Length > PageContentChars || markdown.Contains('\0'))
            throw new ProtocolException("Invalid site page revision or content");
    }

    public static byte[] EncodeAdminSiteTraffic(AdminSiteTraffic value)
    {
        const long maxSafeInteger = 9_007_199_254_740_991;
        if (value.Days.Count > 30 || value.Regions.Count > 30 ||
            (!value.Enabled && (value.RegionsConfigured || value.Days.Count != 0)) ||
            (!value.RegionsConfigured && value.Regions.Count != 0))
            throw new ProtocolException("Invalid site traffic snapshot.");
        return EncodeFrame(FrameType.AdminSiteTraffic, writer =>
        {
            string? previous = null;
            var keys = new HashSet<string>(StringComparer.Ordinal);
            writer.Bool(value.Enabled).Bool(value.RegionsConfigured)
                .Items(value.Days, (w, day) =>
                {
                    if (!DateOnly.TryParseExact(day.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _) ||
                        day.Views is < 0 or > maxSafeInteger || previous is not null && string.CompareOrdinal(previous, day.Date) >= 0)
                        throw new ProtocolException("Invalid site traffic day.");
                    w.Text(day.Date, 10).I64(day.Views);
                    previous = day.Date;
                })
                .Items(value.Regions, (w, region) =>
                {
                    if (!IsSiteTrafficRegion(region.Region) || region.Views is <= 0 or > maxSafeInteger || !keys.Add(region.Region))
                        throw new ProtocolException("Invalid site traffic region.");
                    w.Text(region.Region, 7).I64(region.Views);
                });
        });
    }

    public static bool IsSiteTrafficRegion(string value) =>
        value == "unknown" || value.Length is 2 or >= 4 and <= 6 &&
        char.IsAsciiLetterUpper(value[0]) && char.IsAsciiLetterUpper(value[1]) &&
        (value.Length == 2 || value[2] == '-' && value[3..].All(c => char.IsAsciiLetterUpper(c) || char.IsAsciiDigit(c)));

    public static byte[] EncodeAdminTagMetadataCommand(AdminTagMetadataCommand value) => EncodeTaxonomyCommand(value, FrameType.AdminTagMetadataCommand);
    public static byte[] EncodeAdminTagCreateCommand(AdminTagMetadataCommand value) => EncodeTaxonomyCommand(value, FrameType.AdminTagCreateCommand);
    public static byte[] EncodeAdminCategoryMetadataCommand(AdminTagMetadataCommand value) => EncodeTaxonomyCommand(value, FrameType.AdminCategoryMetadataCommand);
    public static AdminTagMetadataCommand DecodeAdminTagMetadataCommand(ReadOnlySpan<byte> frame) => DecodeTaxonomyCommand(frame, FrameType.AdminTagMetadataCommand);
    public static AdminTagMetadataCommand DecodeAdminTagCreateCommand(ReadOnlySpan<byte> frame) => DecodeTaxonomyCommand(frame, FrameType.AdminTagCreateCommand);
    public static AdminTagMetadataCommand DecodeAdminCategoryMetadataCommand(ReadOnlySpan<byte> frame) => DecodeTaxonomyCommand(frame, FrameType.AdminCategoryMetadataCommand);
    public static byte[] EncodeAdminTagMetadata(AdminTagMetadata value) => EncodeTaxonomyMetadata(value, FrameType.AdminTagMetadata);
    public static byte[] EncodeAdminCategoryMetadata(AdminTagMetadata value) => EncodeTaxonomyMetadata(value, FrameType.AdminCategoryMetadata);
    public static AdminTagMetadata DecodeAdminTagMetadata(ReadOnlySpan<byte> frame) => DecodeTaxonomyMetadata(frame, FrameType.AdminTagMetadata);
    public static AdminTagMetadata DecodeAdminCategoryMetadata(ReadOnlySpan<byte> frame) => DecodeTaxonomyMetadata(frame, FrameType.AdminCategoryMetadata);

    private static byte[] EncodeTaxonomyCommand(AdminTagMetadataCommand value, FrameType type)
    {
        ValidateTaxonomyCommand(value, type);
        return EncodeFrame(type, writer => writer.I32(value.Id).I64(value.ExpectedRevision).Uuid(value.RequestId)
            .Text(value.Name, type == FrameType.AdminCategoryMetadataCommand ? AdminCategoryNameBytes : AdminTagNameBytes)
            .Text(value.Description, TaxonomyDescriptionBytes));
    }

    private static AdminTagMetadataCommand DecodeTaxonomyCommand(ReadOnlySpan<byte> frame, FrameType type)
    {
        var nameLimit = type == FrameType.AdminCategoryMetadataCommand ? AdminCategoryNameBytes : AdminTagNameBytes;
        var value = DecodeFrame(type, frame, (ref Reader reader) => new AdminTagMetadataCommand(
            reader.I32(), reader.I64(), reader.Uuid(), reader.Text(nameLimit), reader.Text(TaxonomyDescriptionBytes)));
        ValidateTaxonomyCommand(value, type);
        return value;
    }

    private static byte[] EncodeTaxonomyMetadata(AdminTagMetadata value, FrameType type) =>
        EncodeFrame(type, writer => writer.I32(value.Id).I64(value.Revision)
            .Text(value.Name, TaxonomyNameBytes).Text(value.Description, TaxonomyDescriptionBytes).Bool(value.Changed));

    private static AdminTagMetadata DecodeTaxonomyMetadata(ReadOnlySpan<byte> frame, FrameType type)
    {
        var value = DecodeFrame(type, frame, static (ref Reader reader) => new AdminTagMetadata(
            reader.I32(), reader.I64(), reader.Text(TaxonomyNameBytes), reader.Text(TaxonomyDescriptionBytes), reader.Bool()));
        if (value.Id <= 0 || value.Revision < 0 || value.Name.Length == 0)
            throw InvalidTaxonomyMetadata(type == FrameType.AdminCategoryMetadata);
        return value;
    }

    private static void ValidateTaxonomyCommand(AdminTagMetadataCommand value, FrameType type)
    {
        var valid = type switch
        {
            FrameType.AdminTagCreateCommand => value.Id == 0 && value.ExpectedRevision == 0,
            FrameType.AdminTagMetadataCommand => value.Id > 0 && value.ExpectedRevision >= 0,
            FrameType.AdminCategoryMetadataCommand => value.Id >= 0 && value.ExpectedRevision >= 0 &&
                (value.Id > 0 || value.ExpectedRevision == 0),
            _ => false,
        };
        if (!valid || value.RequestId == Guid.Empty) throw InvalidTaxonomyMetadata(type == FrameType.AdminCategoryMetadataCommand);
    }

    private static ProtocolException InvalidTaxonomyMetadata(bool category) =>
        new(category ? "Invalid administrator category metadata." : "Invalid administrator tag metadata.");

    public static byte[] EncodeAdminTaxonomyDependencies(AdminTaxonomyDependencies value)
    {
        if (value.Id <= 0 || value.ActiveArticles < 0 || value.RetainedOnlyArticles < 0 || value.ReservedAliases < 0)
            throw new ProtocolException("Invalid administrator taxonomy dependencies.");
        return EncodeFrame(FrameType.AdminTaxonomyDependencies,
            writer => writer.I32(value.Id).I32(value.ActiveArticles).I32(value.RetainedOnlyArticles).I32(value.ReservedAliases));
    }

    public static byte[] EncodeAdminTaxonomyPage(AdminTaxonomyPage page)
    {
        if (page.Items.Count > AdminTaxonomyPageSize || page.NextId < 0 ||
            page.NextId > 0 && (page.Items.Count != AdminTaxonomyPageSize || page.Items[^1].Id != page.NextId))
            throw new ProtocolException("Invalid administrator taxonomy page.");
        return EncodeFrame(FrameType.AdminTaxonomyPage, writer =>
        {
            var previous = 0;
            writer.I32(page.NextId).Items(page.Items, (w, item) =>
            {
                if (item.Id <= previous || string.IsNullOrEmpty(item.Name) || item.Published < 0 || item.Drafts < 0 || item.Scheduled < 0 ||
                    item.Retracted < 0 || item.Deleted < 0 || item.RetainedArticles < item.Published ||
                    item.RetainedArticles < (long)item.Drafts + item.Scheduled + item.Retracted + item.Deleted)
                    throw new ProtocolException("Invalid administrator taxonomy item.");
                w.I32(item.Id).Text(item.Name, TaxonomyNameBytes).I32(item.Published).I32(item.Drafts)
                    .I32(item.Scheduled).I32(item.Retracted).I32(item.Deleted).I32(item.RetainedArticles);
                previous = item.Id;
            });
        });
    }
}
