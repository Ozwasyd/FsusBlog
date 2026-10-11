using FsusBlog.Contracts.Articles;
using System.Data.Common;
using System.Text.Json;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Data;

using SqlSugar;

namespace FsusBlog.Server.Services;

public static class ArticlePublicationTransitionKinds
{
    public const string ImmediatePublish = "immediate-publish";
    public const string ScheduledPublish = "scheduled-publish";
    public const string Archive = "archive";
    public const string Restore = "restore";
    public const string Rollback = "rollback";
    public const string SaveDraft = "save-draft";
    public const string Schedule = "schedule";
    public const string CreateInbox = "create-inbox";
    public const string MoveToInbox = "move-to-inbox";
    public const string TriageInbox = "triage-inbox";
    public const string ArchiveInbox = "archive-inbox";
    public const string RestoreArchived = "restore-archived";
}

public readonly record struct ArticleVersionCoordinates(
    long RevisionId,
    int RevisionNo,
    long RightsSnapshotId,
    long? ResponsibilitySnapshotId,
    long? PublicationId,
    int? PublicationNo,
    int? ResponsibilityVersion = null)
{
    public static ArticleVersionCoordinates Revision(
        long revisionId,
        int revisionNo,
        long rightsSnapshotId,
        long? responsibilitySnapshotId = null)
        => new(revisionId, revisionNo, rightsSnapshotId, responsibilitySnapshotId, null, null);
}

public sealed record ArticlePublicationTransitionRequest(
    int ArticleId,
    ArticleVersionCoordinates Version,
    ArticleStatus TargetStatus,
    DateTime? ScheduledPublishAt,
    DateTime TransitionedAt,
    string TransitionKind,
    ArticleStatusTransitionOperation Operation);

public readonly record struct ArticlePublicationTransitionPlan(
    ArticleStatus StoredStatus,
    DateTime? ScheduledPublishAt,
    DateTime? PendingPublicationAt,
    DateTime? PublishedAt,
    DateTime? ArchivedAt,
    bool CreatePublication);

public static class ArticlePublicationTransitionWriter
{
    private static readonly JsonSerializerOptions s_outboxJsonOptions = new(JsonSerializerDefaults.Web);

    public static async Task<ArticleVersionCoordinates> ApplyAsync(
        ISqlSugarClient db,
        ArticlePublicationTransitionRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        Validate(request);
        if ((request.TargetStatus == ArticleStatus.Inbox
                || request.Operation is ArticleStatusTransitionOperation.TriageInbox
                    or ArticleStatusTransitionOperation.ArchiveInbox or ArticleStatusTransitionOperation.RestoreArchived)
            && db.Ado.Transaction is null)
        {
            throw new ArticleWriteValidationException("article_lifecycle_transaction_required",
                "Inbox lifecycle writes require an ambient canonical transaction.");
        }

        long? currentPublicationId = null;
        int? currentPublicationNo = null;
        ArticleStatus sourceStatus;
        int? previousEditableStatus;
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                SELECT
                    a.current_publication_id,
                    publication.publication_no,
                    a.status,
                    a.isdeleted,
                    a.previous_editable_status
                FROM article a
                LEFT JOIN article_publication publication ON publication.id = a.current_publication_id
                WHERE a.id = @ArticleId
                FOR UPDATE OF a;
                """,
                new SugarParameter("@ArticleId", request.ArticleId)))
        {
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException($"Article {request.ArticleId} was not available for publication transition.");
            }

            currentPublicationId = reader.IsNull("current_publication_id") ? null : reader.ReadInt64("current_publication_id");
            currentPublicationNo = reader.IsNull("publication_no") ? null : reader.ReadInt32("publication_no");
            sourceStatus = reader.ReadBoolean("isdeleted")
                ? ArticleStatus.Deleted
                : (ArticleStatus)reader.ReadInt32("status");
            previousEditableStatus = reader.IsNull("previous_editable_status")
                ? null : reader.ReadInt32("previous_editable_status");
        }

        ThrowIfInvalid(ArticleStatusTransitionPolicy.ValidateTransition(
            (int)sourceStatus,
            (int)request.TargetStatus,
            request.ScheduledPublishAt,
            request.TransitionedAt,
            request.Operation,
            previousEditableStatus));

        ArticlePublicationTransitionPlan plan = CreatePlan(
            currentPublicationId.HasValue,
            request.TargetStatus,
            request.ScheduledPublishAt,
            request.TransitionedAt);

        if (request.Operation == ArticleStatusTransitionOperation.Rollback && !plan.CreatePublication)
        {
            plan = plan with
            {
                CreatePublication = true,
            };
        }

        if (plan.CreatePublication)
        {
            ArticleVersionCoordinates published = await InsertPublicationAsync(db, request, cancellationToken).ConfigureAwait(false);
            await UpdateArticleStateAsync(
                    db,
                    request,
                    plan.StoredStatus,
                    plan.ScheduledPublishAt,
                    plan.PendingPublicationAt,
                    plan.PublishedAt,
                    plan.ArchivedAt,
                    published.PublicationId,
                    plan.CreatePublication,
                    cancellationToken)
                .ConfigureAwait(false);
            return published;
        }

        await UpdateArticleStateAsync(
                db,
                request,
                plan.StoredStatus,
                plan.ScheduledPublishAt,
                plan.PendingPublicationAt,
            plan.PublishedAt,
            plan.ArchivedAt,
            currentPublicationId,
            plan.CreatePublication,
            cancellationToken)
            .ConfigureAwait(false);
        return request.Version with
        {
            PublicationId = currentPublicationId,
            PublicationNo = currentPublicationNo
        };
    }

    public static ArticlePublicationTransitionPlan CreatePlan(
        bool hasCurrentPublication,
        ArticleStatus targetStatus,
        DateTime? scheduledPublishAt,
        DateTime transitionedAt)
    {
        ThrowIfInvalid(ArticleStatusTransitionPolicy.ValidateTarget(
            (int)targetStatus,
            scheduledPublishAt,
            transitionedAt));

        return targetStatus switch
        {
            ArticleStatus.Published => new(
                ArticleStatus.Published,
                ScheduledPublishAt: null,
                PendingPublicationAt: null,
                PublishedAt: transitionedAt,
                ArchivedAt: null,
                CreatePublication: true),
            ArticleStatus.Scheduled when hasCurrentPublication => new(
                ArticleStatus.Published,
                ScheduledPublishAt: null,
                PendingPublicationAt: scheduledPublishAt,
                PublishedAt: null,
                ArchivedAt: null,
                CreatePublication: false),
            ArticleStatus.Scheduled => new(
                ArticleStatus.Scheduled,
                ScheduledPublishAt: scheduledPublishAt,
                PendingPublicationAt: null,
                PublishedAt: null,
                ArchivedAt: null,
                CreatePublication: false),
            ArticleStatus.Archived => new(
                ArticleStatus.Archived,
                ScheduledPublishAt: null,
                PendingPublicationAt: null,
                PublishedAt: null,
                ArchivedAt: transitionedAt,
                CreatePublication: false),
            _ => new(
                targetStatus,
                ScheduledPublishAt: null,
                PendingPublicationAt: null,
                PublishedAt: null,
                ArchivedAt: null,
                CreatePublication: false)
        };
    }

    public static string BuildOutboxPayload(
        int articleId,
        string eventType,
        ArticleVersionCoordinates version,
        ArticleMutationScopeSnapshot? before = null,
        ArticleMutationScopeSnapshot? after = null,
        DateTime? occurredAt = null,
        DateTime? publicUpdatedAt = null)
        => JsonSerializer.Serialize(new
        {
            schemaVersion = ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion,
            articleId,
            eventType,
            articleRevisionId = version.RevisionId,
            revisionNo = version.RevisionNo,
            rightsSnapshotId = version.RightsSnapshotId,
            responsibilitySnapshotId = version.ResponsibilitySnapshotId,
            responsibilityVersion = version.ResponsibilityVersion,
            releaseId = version.PublicationId,
            releaseNo = version.PublicationNo,
            publicUpdatedAt = publicUpdatedAt ?? occurredAt,
            occurredAt,
            before,
            after
        }, s_outboxJsonOptions);

    private static async Task<ArticleVersionCoordinates> InsertPublicationAsync(
        ISqlSugarClient db,
        ArticlePublicationTransitionRequest request,
        CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            INSERT INTO article_publication (
                article_id,
                publication_no,
                article_revision_id,
                revision_no,
                rights_snapshot_id,
                responsibility_snapshot_id,
                transition_kind,
                published_at,
                created_at)
            SELECT
                @ArticleId,
                COALESCE(MAX(publication_no), 0) + 1,
                @ArticleRevisionId,
                @RevisionNo,
                @RightsSnapshotId,
                CAST(@ResponsibilitySnapshotId AS bigint),
                @TransitionKind,
                @PublishedAt,
                @PublishedAt
            FROM article_publication
            WHERE article_id = @ArticleId
            RETURNING id, publication_no;
            """,
            new SugarParameter("@ArticleId", request.ArticleId),
            new SugarParameter("@ArticleRevisionId", request.Version.RevisionId),
            new SugarParameter("@RevisionNo", request.Version.RevisionNo),
            new SugarParameter("@RightsSnapshotId", request.Version.RightsSnapshotId),
            new SugarParameter("@ResponsibilitySnapshotId", (object?)request.Version.ResponsibilitySnapshotId ?? DBNull.Value),
            new SugarParameter("@TransitionKind", request.TransitionKind),
            new SugarParameter("@PublishedAt", request.TransitionedAt));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException($"Publication record was not created for article {request.ArticleId}.");
        }

        return request.Version with
        {
            PublicationId = reader.ReadInt64("id"),
            PublicationNo = reader.ReadInt32("publication_no")
        };
    }

    private static Task<int> UpdateArticleStateAsync(
        ISqlSugarClient db,
        ArticlePublicationTransitionRequest request,
        ArticleStatus storedStatus,
        DateTime? scheduledPublishAt,
        DateTime? pendingPublicationAt,
        DateTime? publishedAt,
        DateTime? archivedAt,
        long? publicationId,
        bool createPublication,
        CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync(
            """
            UPDATE article
            SET current_revision_id = @CurrentRevisionId,
                current_publication_id = CAST(@CurrentPublicationId AS bigint),
                previous_editable_status = CASE
                    WHEN @Status = @Archived AND status IN (@Draft, @Inbox) THEN status
                    WHEN @Status = @Archived AND status = @Archived THEN previous_editable_status
                    WHEN @Status = @Archived THEN NULL
                    ELSE NULL
                END,
                status = @Status,
                scheduled_publish_at = CAST(@ScheduledPublishAt AS timestamp),
                pending_publication_at = CAST(@PendingPublicationAt AS timestamp),
                published_at = COALESCE(published_at, CAST(@PublishedAt AS timestamp)),
                last_published_at = CASE
                    WHEN @CreatePublication THEN CAST(@PublishedAt AS timestamp)
                    ELSE last_published_at
                END,
                public_updated_at = CASE
                    WHEN @CreatePublication THEN @TransitionedAt
                    ELSE public_updated_at
                END,
                archived_at = CAST(@ArchivedAt AS timestamp)
            WHERE id = @ArticleId
              AND isdeleted = false;
            """,
            new SugarParameter("@ArticleId", request.ArticleId),
            new SugarParameter("@CurrentRevisionId", request.Version.RevisionId),
            new SugarParameter("@CurrentPublicationId", (object?)publicationId ?? DBNull.Value),
            new SugarParameter("@Status", (int)storedStatus),
            new SugarParameter("@Archived", (int)ArticleStatus.Archived),
            new SugarParameter("@Draft", (int)ArticleStatus.Draft),
            new SugarParameter("@Inbox", (int)ArticleStatus.Inbox),
            new SugarParameter("@ScheduledPublishAt", (object?)scheduledPublishAt ?? DBNull.Value),
            new SugarParameter("@PendingPublicationAt", (object?)pendingPublicationAt ?? DBNull.Value),
            new SugarParameter("@PublishedAt", (object?)publishedAt ?? DBNull.Value),
            new SugarParameter("@CreatePublication", createPublication),
            new SugarParameter("@TransitionedAt", request.TransitionedAt),
            new SugarParameter("@ArchivedAt", (object?)archivedAt ?? DBNull.Value));

    private static void Validate(ArticlePublicationTransitionRequest request)
    {
        if (request.ArticleId <= 0)
            throw new ArgumentOutOfRangeException(nameof(request.ArticleId));
        if (request.Version.RevisionId <= 0)
            throw new ArgumentOutOfRangeException(nameof(request.Version.RevisionId));
        if (request.Version.RevisionNo <= 0)
            throw new ArgumentOutOfRangeException(nameof(request.Version.RevisionNo));
        if (request.Version.RightsSnapshotId <= 0)
            throw new ArgumentOutOfRangeException(nameof(request.Version.RightsSnapshotId));
        ThrowIfInvalid(ArticleStatusTransitionPolicy.ValidateTarget(
            (int)request.TargetStatus,
            request.ScheduledPublishAt,
            request.TransitionedAt));
        if (string.IsNullOrWhiteSpace(request.TransitionKind))
            throw new ArgumentException("Transition kind is required.", nameof(request));
    }

    private static void ThrowIfInvalid(ArticleStatusTransitionValidation? validation)
    {
        if (validation.HasValue)
        {
            throw new ArticleStatusTransitionValidationException(validation.Value);
        }
    }
}
