using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Data;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;

using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

/// <summary>
/// Production-shared lifecycle transition authority used by the canonical fixture port.
///
/// The authority deliberately keeps the article row mutation and all immutable coordinates
/// in one ambient transaction.  Fixture code can select a scenario, but it cannot write a
/// status, pointer, revision, publication, outbox, or audit row itself.
/// </summary>
public static class ArticleLifecycleTransitionWriter
{
    public const string WriterContract = "fsusblog.canonical-article-lifecycle-writer.v1";

    public sealed record CreateRequest(
        string Title,
        string Content,
        string? Summary,
        string? CoverImageUrl,
        int CategoryId,
        IReadOnlyList<int> TagIds,
        ArticleStatus TargetStatus,
        DateTime? ScheduledPublishAt,
        DateTime TransitionedAt,
        long CreatedByAdminPrincipalId,
        ArticleRightsRequestCoreModel? Rights,
        ArticleResponsibilityDraft Responsibility,
        string SemanticRole,
        string? OutboxEventType = null,
        string? TransitionKind = null,
        ArticleCreateMutationAuthority.ArticleMutationIdentityWrite? MutationIdentity = null);

    public sealed record RevisionRequest(
        int ArticleId,
        long ExpectedRevisionId,
        string Title,
        string Content,
        string? Summary,
        string? CoverImageUrl,
        int CategoryId,
        IReadOnlyList<int> TagIds,
        ArticleStatus TargetStatus,
        DateTime? ScheduledPublishAt,
        DateTime TransitionedAt,
        long CreatedByAdminPrincipalId,
        ArticleRightsRequestCoreModel? Rights,
        ArticleResponsibilityDraft? Responsibility,
        string TransitionKind,
        string SemanticRole,
        ArticleStatusTransitionOperation Operation = ArticleStatusTransitionOperation.Update,
        long? ResponsibilitySourceRevisionId = null,
        long? RollbackSourceRevisionId = null,
        string? RollbackReason = null,
        string? OutboxEventType = null);

    public sealed record DeleteRequest(
        int ArticleId,
        long ExpectedRevisionId,
        DateTime TransitionedAt,
        long DeletedByAdminPrincipalId,
        string SemanticRole,
        string? OutboxEventType = null);

    public sealed record RestoreRequest(
        int ArticleId,
        long ExpectedRevisionId,
        DateTime TransitionedAt,
        long RestoredByAdminPrincipalId,
        string SemanticRole,
        ArticleRightsRequestCoreModel? Rights = null,
        ArticleResponsibilityDraft? Responsibility = null,
        string? OutboxEventType = null);

    public sealed record RollbackRequest(
        int ArticleId,
        long ExpectedRevisionId,
        long TargetRevisionId,
        DateTime TransitionedAt,
        long RolledBackByAdminPrincipalId,
        string RollbackReason,
        string SemanticRole,
        string? OutboxEventType = null);

    public sealed record ScheduledPublishRequest(
        int ArticleId,
        long ExpectedRevisionId,
        DateTime TransitionedAt,
        long PublishedByAdminPrincipalId,
        string SemanticRole,
        string? OutboxEventType = null);

    public sealed record ArticleLifecycleCoordinates(
        ArticleStatus Status,
        bool IsDeleted,
        long? RevisionId,
        int? RevisionNo,
        long? PublicationId,
        int? PublicationNo,
        long? RightsSnapshotId,
        long? ResponsibilitySnapshotId,
        int? ResponsibilityVersion,
        DateTime? ScheduledPublishAt,
        DateTime? PendingPublicationAt,
        DateTime? DeletedAt,
        string ContentDigest,
        int? CategoryId,
        IReadOnlyList<int> TagIds);

    public sealed record Result(
        string TransitionId,
        int ArticleId,
        ArticleLifecycleCoordinates Before,
        ArticleLifecycleCoordinates After,
        ArticleVersionCoordinates Version,
        ArticleMutationOutboxEvent Outbox,
        string AuditChainId,
        string AuditRecordHash,
        string ContentDigest,
        long? RollbackSourceRevisionId = null,
        DateTime? TransitionedAtUtc = null);

    public static async Task<Result> CreateAsync(
        ISqlSugarClient db,
        IConfiguration configuration,
        CreateRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(request);
        using var callerCancellation = new ArticleCreateMutationAuthority.CallerCancellationScope(db);
        await ArticleCreateMutationAuthority.RequireSourceMutationTransactionAsync(db, cancellationToken)
            .ConfigureAwait(false);
        await RequireActiveAdminAsync(db, request.CreatedByAdminPrincipalId, cancellationToken).ConfigureAwait(false);
        ValidateCreateRequest(request);

        DateTime now = EnsureUtc(request.TransitionedAt);
        ArticleStatus target = request.TargetStatus;
        ArticleRightsNormalizedModel rights = ArticleProductionNormalizers.NormalizeArticleRights(request.Rights);
        List<int> tagIds = ArticleProductionNormalizers.NormalizeTagIds(request.TagIds);
        ArticleSummaryProjectionResult summaryProjection = ArticleSummaryProjection.Resolve(
            ArticleProductionNormalizers.NormalizeText(request.Summary, ArticleProductionNormalizers.MaxSummaryLength),
            ArticleProductionNormalizers.NormalizeText(request.Content, ArticleProductionNormalizers.MaxContentLength));
        ArticleCreateMutationAuthority.Result created = await ArticleCreateMutationAuthority.ExecuteAsync(
            db,
            new ArticleCreateMutationAuthority.Request(
                Title: request.Title,
                Content: request.Content,
                Summary: request.Summary,
                CoverImageUrl: request.CoverImageUrl,
                CategoryId: request.CategoryId,
                TagIds: tagIds,
                Status: target,
                ScheduledPublishAt: request.ScheduledPublishAt,
                PublishedAt: target == ArticleStatus.Published ? now : null,
                LastPublishedAt: target == ArticleStatus.Published ? now : null,
                PublicUpdatedAt: target == ArticleStatus.Published ? now : null,
                ArchivedAt: null,
                Now: now,
                Rights: rights,
                CreatedByAdminPrincipalId: request.CreatedByAdminPrincipalId,
                DiffSummary: ArticleSummaryProjection.AttachGenerationVersion(
                    $"fixture {request.SemanticRole} initial transition",
                    summaryProjection),
                OutboxEventType: request.OutboxEventType ?? ArticleMutationEventTypes.Created,
                TransitionKind: request.TransitionKind ?? TransitionKindFor(target),
                AfterScope: new ArticleMutationScopeSnapshot(
                    request.CategoryId,
                    tagIds.ToArray(),
                    ArticleMutationVisibility.From(target)),
                MutationIdentity: request.MutationIdentity,
                AttachResponsibilityAsync: async (articleId, revision, token) =>
                {
                    ArticleResponsibilitySnapshot built = ArticleResponsibilitySnapshotBuilder.Build(
                        articleId,
                        revision.Id,
                        revision.RevisionNo,
                        responsibilityVersion: 1,
                        previousSnapshotId: null,
                        request.Responsibility,
                        now);
                    long snapshotId = await db.Insertable(built)
                        .ExecuteReturnBigIdentityAsync()
                        .ConfigureAwait(false);
                    if (snapshotId <= 0)
                    {
                        throw new InvalidOperationException("responsibility_snapshot_insert_failed");
                    }

                    return new ArticleCreateMutationAuthority.ResponsibilityAttachResult(snapshotId, 1);
                }),
            cancellationToken).ConfigureAwait(false);

        ArticleLifecycleCoordinates before = EmptyCoordinates();
        ArticleLifecycleCoordinates after = await LoadCoordinatesAsync(
            db,
            created.ArticleId,
            created.Revision.Id,
            cancellationToken).ConfigureAwait(false);
        string contentDigest = await ComputeRevisionContentDigestAsync(
            db,
            created.Revision.Id,
            cancellationToken).ConfigureAwait(false);
        AuthoringSignedAuditWriter.ChainWrite audit = await WriteAuditAsync(
            db,
            configuration,
            created.ArticleId,
            request.CreatedByAdminPrincipalId,
            request.SemanticRole,
            "create",
            now,
            created.Version,
            created.Outbox.EventId,
            contentDigest,
            cancellationToken).ConfigureAwait(false);
        return new Result(
            created.Outbox.EventId,
            created.ArticleId,
            before,
            after,
            created.Version,
            created.Outbox,
            audit.ChainId,
            audit.RecordHash,
            contentDigest,
            TransitionedAtUtc: now);
    }

    public static async Task<Result> UpdateAsync(
        ISqlSugarClient db,
        IConfiguration configuration,
        RevisionRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(request);
        using var callerCancellation = new ArticleCreateMutationAuthority.CallerCancellationScope(db);
        await ArticleCreateMutationAuthority.RequireSourceMutationTransactionAsync(db, cancellationToken)
            .ConfigureAwait(false);
        await RequireActiveAdminAsync(db, request.CreatedByAdminPrincipalId, cancellationToken).ConfigureAwait(false);
        ValidateRevisionRequest(request);

        DateTime now = EnsureUtc(request.TransitionedAt);
        ArticleLifecycleCoordinates before = await LoadCoordinatesAsync(
            db,
            request.ArticleId,
            expectedRevisionId: null,
            cancellationToken,
            lockArticle: true).ConfigureAwait(false);
        EnsureExpectedRevision(before, request.ExpectedRevisionId);
        ThrowIfInvalid(ArticleStatusTransitionPolicy.ValidateTransition(
            (int)before.Status,
            (int)request.TargetStatus,
            request.ScheduledPublishAt,
            now,
            request.Operation));

        ArticleRightsNormalizedModel rights = request.Rights is not null
            ? ArticleProductionNormalizers.NormalizeArticleRights(request.Rights)
            : await LoadRightsWriteModelAsync(db, request.ArticleId, before.RevisionId, cancellationToken)
                .ConfigureAwait(false);
        List<int> tagIds = ArticleProductionNormalizers.NormalizeTagIds(request.TagIds);
        string title = ArticleProductionNormalizers.NormalizeText(
            request.Title,
            ArticleProductionNormalizers.MaxTitleLength);
        string content = ArticleProductionNormalizers.NormalizeText(
            request.Content,
            ArticleProductionNormalizers.MaxContentLength);
        string summary = ArticleProductionNormalizers.NormalizeText(
            request.Summary,
            ArticleProductionNormalizers.MaxSummaryLength);
        string? coverImageUrl = ArticleProductionNormalizers.NormalizeOptionalRightsText(
            request.CoverImageUrl,
            ArticleProductionNormalizers.MaxCoverImageUrlLength);
        ArticleSummaryProjectionResult summaryProjection = ArticleSummaryProjection.Resolve(summary, content);
        string safeSummary = summaryProjection.Text;
        int categoryId = request.CategoryId > 0 ? request.CategoryId : throw new ArgumentOutOfRangeException(nameof(request.CategoryId));

        ArticleRevisionWriteResult revision = await ArticleRevisionPersistence.SaveAsync(
            db,
            request.ArticleId,
            title,
            content,
            safeSummary,
            coverImageUrl,
            categoryId,
            tagIds,
            ArticleSummaryProjection.AttachGenerationVersion(
                request.Operation == ArticleStatusTransitionOperation.Rollback
                    ? "fixture rollback"
                    : $"fixture {request.SemanticRole} transition",
                summaryProjection),
            now,
            request.CreatedByAdminPrincipalId,
            request.RollbackSourceRevisionId,
            request.RollbackReason,
            cancellationToken: cancellationToken).ConfigureAwait(false);

        await UpdateMutableArticleProjectionAsync(
            db,
            request.ArticleId,
            title,
            safeSummary,
            coverImageUrl,
            categoryId,
            content,
            tagIds,
            now,
            cancellationToken).ConfigureAwait(false);
        await ReplaceAssetReferencesAsync(
            db,
            request.ArticleId,
            revision.Id,
            content,
            coverImageUrl,
            cancellationToken).ConfigureAwait(false);

        long policyId = await ArticleRightsPolicyPersistence.UpsertAsync(
            db,
            request.ArticleId,
            rights,
            now,
            cancellationToken).ConfigureAwait(false);
        ArticleStatus hashStatus = request.TargetStatus == ArticleStatus.Scheduled && before.PublicationId.HasValue
            ? ArticleStatus.Published
            : request.TargetStatus;
        DateTime? hashSchedule = request.TargetStatus == ArticleStatus.Scheduled && before.PublicationId.HasValue
            ? null
            : request.ScheduledPublishAt;
        ArticleRightsSnapshot rightsSnapshot = ArticleRightsSnapshotBuilder.Build(
            request.ArticleId,
            revision.Id,
            revision.RevisionNo,
            policyId,
            title,
            content,
            safeSummary,
            coverImageUrl,
            categoryId,
            tagIds,
            hashStatus,
            hashStatus == ArticleStatus.Published ? now : null,
            hashSchedule,
            rights,
            now).Snapshot;
        long rightsSnapshotId = await db.Insertable(rightsSnapshot)
            .ExecuteReturnBigIdentityAsync()
            .ConfigureAwait(false);
        if (rightsSnapshotId <= 0)
        {
            throw new InvalidOperationException("rights_snapshot_insert_failed");
        }

        long sourceResponsibilityRevisionId = request.ResponsibilitySourceRevisionId
            ?? request.RollbackSourceRevisionId
            ?? before.RevisionId
            ?? throw new InvalidOperationException("responsibility_source_revision_missing");
        long responsibilitySnapshotId;
        int responsibilityVersion;
        if (request.Responsibility is not null)
        {
            ArticleResponsibilitySnapshot built = ArticleResponsibilitySnapshotBuilder.Build(
                request.ArticleId,
                revision.Id,
                revision.RevisionNo,
                responsibilityVersion: 1,
                previousSnapshotId: before.ResponsibilitySnapshotId,
                request.Responsibility,
                now);
            responsibilitySnapshotId = await db.Insertable(built)
                .ExecuteReturnBigIdentityAsync()
                .ConfigureAwait(false);
            responsibilityVersion = 1;
        }
        else
        {
            (responsibilitySnapshotId, responsibilityVersion) = await CloneResponsibilitySnapshotAsync(
                db,
                request.ArticleId,
                sourceResponsibilityRevisionId,
                revision,
                now,
                cancellationToken).ConfigureAwait(false);
        }

        ArticleVersionCoordinates version = await ArticlePublicationTransitionWriter.ApplyAsync(
            db,
            new ArticlePublicationTransitionRequest(
                request.ArticleId,
                new ArticleVersionCoordinates(
                    revision.Id,
                    revision.RevisionNo,
                    rightsSnapshotId,
                    responsibilitySnapshotId,
                    null,
                    null,
                    responsibilityVersion),
                request.TargetStatus,
                request.ScheduledPublishAt,
                now,
                request.TransitionKind,
                request.Operation),
            cancellationToken).ConfigureAwait(false);

        ArticleLifecycleCoordinates after = await LoadCoordinatesAsync(
            db,
            request.ArticleId,
            revision.Id,
            cancellationToken).ConfigureAwait(false);
        ArticleMutationOutboxEvent outbox = ArticleMutationOutboxProducer.Create(
            request.ArticleId,
            request.OutboxEventType ?? ArticleMutationEventTypes.Updated,
            version,
            Scope(before),
            Scope(after),
            now,
            after.Status == ArticleStatus.Published && !after.IsDeleted ? now : null);
        await db.Insertable(outbox).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
        await ArticleSourceGenerationAuthority.RecordMutationAsync(db, outbox.EventId, cancellationToken)
            .ConfigureAwait(false);
        string contentDigest = await ComputeRevisionContentDigestAsync(db, revision.Id, cancellationToken)
            .ConfigureAwait(false);
        AuthoringSignedAuditWriter.ChainWrite audit = await WriteAuditAsync(
            db,
            configuration,
            request.ArticleId,
            request.CreatedByAdminPrincipalId,
            request.SemanticRole,
            request.Operation == ArticleStatusTransitionOperation.Rollback ? "rollback" : "update",
            now,
            version,
            outbox.EventId,
            contentDigest,
            cancellationToken,
            request.RollbackSourceRevisionId,
            request.RollbackReason).ConfigureAwait(false);
        return new Result(
            outbox.EventId,
            request.ArticleId,
            before,
            after,
            version,
            outbox,
            audit.ChainId,
            audit.RecordHash,
            contentDigest,
            request.RollbackSourceRevisionId,
            now);
    }

    public static async Task<Result> DeleteAsync(
        ISqlSugarClient db,
        IConfiguration configuration,
        DeleteRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(request);
        using var callerCancellation = new ArticleCreateMutationAuthority.CallerCancellationScope(db);
        await ArticleCreateMutationAuthority.RequireSourceMutationTransactionAsync(db, cancellationToken)
            .ConfigureAwait(false);
        await RequireActiveAdminAsync(db, request.DeletedByAdminPrincipalId, cancellationToken).ConfigureAwait(false);
        if (request.ArticleId <= 0 || request.ExpectedRevisionId <= 0 || string.IsNullOrWhiteSpace(request.SemanticRole))
        {
            throw new ArgumentException("delete request is incomplete", nameof(request));
        }

        DateTime now = EnsureUtc(request.TransitionedAt);
        ArticleLifecycleCoordinates before = await LoadCoordinatesAsync(
            db,
            request.ArticleId,
            expectedRevisionId: null,
            cancellationToken,
            lockArticle: true).ConfigureAwait(false);
        EnsureExpectedRevision(before, request.ExpectedRevisionId);
        if (before.IsDeleted || before.RevisionId is null || before.RightsSnapshotId is null)
        {
            throw new InvalidOperationException("article_delete_source_invalid");
        }

        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE article
            SET isdeleted = true,
                status = @Status,
                deleted_at = CAST(@DeletedAt AS timestamp)
            WHERE id = @ArticleId
              AND isdeleted = false
              AND current_revision_id = @ExpectedRevisionId;
            """,
            new SugarParameter("@ArticleId", request.ArticleId),
            new SugarParameter("@Status", (int)ArticleStatus.Deleted),
            new SugarParameter("@DeletedAt", now),
            new SugarParameter("@ExpectedRevisionId", request.ExpectedRevisionId)).ConfigureAwait(false);
        if (updated != 1)
        {
            throw new ArticleWriteValidationException(
                "article_delete_stale_revision",
                "The article changed before the delete transition was committed.");
        }

        ArticleLifecycleCoordinates after = await LoadCoordinatesAsync(
            db,
            request.ArticleId,
            request.ExpectedRevisionId,
            cancellationToken).ConfigureAwait(false);
        ArticleVersionCoordinates version = ToVersion(before);
        ArticleMutationOutboxEvent outbox = ArticleMutationOutboxProducer.Create(
            request.ArticleId,
            request.OutboxEventType ?? ArticleMutationEventTypes.Deleted,
            version,
            Scope(before),
            Scope(after),
            now,
            now);
        await db.Insertable(outbox).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
        await ArticleSourceGenerationAuthority.RecordMutationAsync(db, outbox.EventId, cancellationToken)
            .ConfigureAwait(false);
        string contentDigest = await ComputeRevisionContentDigestAsync(db, request.ExpectedRevisionId, cancellationToken)
            .ConfigureAwait(false);
        AuthoringSignedAuditWriter.ChainWrite audit = await WriteAuditAsync(
            db,
            configuration,
            request.ArticleId,
            request.DeletedByAdminPrincipalId,
            request.SemanticRole,
            "delete",
            now,
            version,
            outbox.EventId,
            contentDigest,
            cancellationToken).ConfigureAwait(false);
        return new Result(
            outbox.EventId,
            request.ArticleId,
            before,
            after,
            version,
            outbox,
            audit.ChainId,
            audit.RecordHash,
            contentDigest,
            TransitionedAtUtc: now);
    }

    public static async Task<Result> RestoreAsync(
        ISqlSugarClient db,
        IConfiguration configuration,
        RestoreRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(request);
        using var callerCancellation = new ArticleCreateMutationAuthority.CallerCancellationScope(db);
        await ArticleCreateMutationAuthority.RequireSourceMutationTransactionAsync(db, cancellationToken)
            .ConfigureAwait(false);
        await RequireActiveAdminAsync(db, request.RestoredByAdminPrincipalId, cancellationToken).ConfigureAwait(false);
        if (request.ArticleId <= 0 || request.ExpectedRevisionId <= 0 || string.IsNullOrWhiteSpace(request.SemanticRole))
        {
            throw new ArgumentException("restore request is incomplete", nameof(request));
        }

        DateTime now = EnsureUtc(request.TransitionedAt);
        ArticleLifecycleCoordinates before = await LoadCoordinatesAsync(
            db,
            request.ArticleId,
            expectedRevisionId: null,
            cancellationToken,
            lockArticle: true).ConfigureAwait(false);
        EnsureExpectedRevision(before, request.ExpectedRevisionId);
        if (!before.IsDeleted || before.RevisionId is null)
        {
            throw new ArticleWriteValidationException(
                "article_restore_requires_deleted",
                "Restore requires a deleted article and never revives its old revision in place.");
        }

        ArticleRevisionSource source = await LoadRevisionSourceAsync(
            db,
            request.ArticleId,
            before.RevisionId.Value,
            cancellationToken).ConfigureAwait(false);
        int undeleted = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE article
            SET isdeleted = false,
                deleted_at = NULL
            WHERE id = @ArticleId
              AND isdeleted = true
              AND current_revision_id = @ExpectedRevisionId;
            """,
            new SugarParameter("@ArticleId", request.ArticleId),
            new SugarParameter("@ExpectedRevisionId", request.ExpectedRevisionId)).ConfigureAwait(false);
        if (undeleted != 1)
        {
            throw new ArticleWriteValidationException(
                "article_restore_stale_revision",
                "The deleted article changed before restore was committed.");
        }

        ArticleRightsNormalizedModel rights = request.Rights is null
            ? await LoadRightsWriteModelAsync(db, request.ArticleId, source.Id, cancellationToken).ConfigureAwait(false)
            : ArticleProductionNormalizers.NormalizeArticleRights(request.Rights);
        List<int> tagIds = ParseTagIds(source.TagIds);
        ArticleRevisionWriteResult revision = await ArticleRevisionPersistence.SaveAsync(
            db,
            request.ArticleId,
            source.Title,
            source.Content,
            source.Summary,
            source.CoverImageUrl,
            source.CategoryId,
            tagIds,
            "fixture restore",
            now,
            request.RestoredByAdminPrincipalId,
            cancellationToken: cancellationToken).ConfigureAwait(false);
        await UpdateMutableArticleProjectionAsync(
            db,
            request.ArticleId,
            source.Title,
            source.Summary ?? string.Empty,
            source.CoverImageUrl,
            source.CategoryId,
            source.Content,
            tagIds,
            now,
            cancellationToken).ConfigureAwait(false);
        await ReplaceAssetReferencesAsync(
            db,
            request.ArticleId,
            revision.Id,
            source.Content,
            source.CoverImageUrl,
            cancellationToken).ConfigureAwait(false);
        long policyId = await ArticleRightsPolicyPersistence.UpsertAsync(
            db,
            request.ArticleId,
            rights,
            now,
            cancellationToken).ConfigureAwait(false);
        ArticleRightsSnapshot rightsSnapshot = ArticleRightsSnapshotBuilder.Build(
            request.ArticleId,
            revision.Id,
            revision.RevisionNo,
            policyId,
            source.Title,
            source.Content,
            source.Summary,
            source.CoverImageUrl,
            source.CategoryId,
            tagIds,
            ArticleStatus.Published,
            now,
            null,
            rights,
            now).Snapshot;
        long rightsSnapshotId = await db.Insertable(rightsSnapshot).ExecuteReturnBigIdentityAsync().ConfigureAwait(false);
        (long responsibilitySnapshotId, int responsibilityVersion) = request.Responsibility is null
            ? await CloneResponsibilitySnapshotAsync(
                db,
                request.ArticleId,
                source.Id,
                revision,
                now,
                cancellationToken).ConfigureAwait(false)
            : await InsertResponsibilitySnapshotAsync(
                db,
                request.ArticleId,
                revision,
                request.Responsibility,
                before.ResponsibilitySnapshotId,
                now,
                cancellationToken).ConfigureAwait(false);

        // The existing publication writer intentionally rejects Deleted as a normal source
        // status.  The restore authority has already validated and locked Deleted, clears only
        // the soft-delete marker above, and invokes the same production publication writer as a
        // state update.  It therefore creates a fresh publication while retaining every old row.
        ArticleVersionCoordinates version = await ArticlePublicationTransitionWriter.ApplyAsync(
            db,
            new ArticlePublicationTransitionRequest(
                request.ArticleId,
                new ArticleVersionCoordinates(
                    revision.Id,
                    revision.RevisionNo,
                    rightsSnapshotId,
                    responsibilitySnapshotId,
                    null,
                    null,
                    responsibilityVersion),
                ArticleStatus.Published,
                null,
                now,
                ArticlePublicationTransitionKinds.Restore,
                ArticleStatusTransitionOperation.Restore),
            cancellationToken).ConfigureAwait(false);
        ArticleLifecycleCoordinates after = await LoadCoordinatesAsync(
            db,
            request.ArticleId,
            revision.Id,
            cancellationToken).ConfigureAwait(false);
        ArticleMutationOutboxEvent outbox = ArticleMutationOutboxProducer.Create(
            request.ArticleId,
            request.OutboxEventType ?? ArticleMutationEventTypes.Restored,
            version,
            Scope(before),
            Scope(after),
            now,
            now);
        await db.Insertable(outbox).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
        await ArticleSourceGenerationAuthority.RecordMutationAsync(db, outbox.EventId, cancellationToken)
            .ConfigureAwait(false);
        string contentDigest = await ComputeRevisionContentDigestAsync(db, revision.Id, cancellationToken)
            .ConfigureAwait(false);
        AuthoringSignedAuditWriter.ChainWrite audit = await WriteAuditAsync(
            db,
            configuration,
            request.ArticleId,
            request.RestoredByAdminPrincipalId,
            request.SemanticRole,
            "restore",
            now,
            version,
            outbox.EventId,
            contentDigest,
            cancellationToken).ConfigureAwait(false);
        return new Result(
            outbox.EventId,
            request.ArticleId,
            before,
            after,
            version,
            outbox,
            audit.ChainId,
            audit.RecordHash,
            contentDigest,
            TransitionedAtUtc: now);
    }

    public static async Task<Result> RollbackAsync(
        ISqlSugarClient db,
        IConfiguration configuration,
        RollbackRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(request);
        using var callerCancellation = new ArticleCreateMutationAuthority.CallerCancellationScope(db);
        await ArticleCreateMutationAuthority.RequireSourceMutationTransactionAsync(db, cancellationToken)
            .ConfigureAwait(false);
        if (request.TargetRevisionId <= 0 || string.IsNullOrWhiteSpace(request.RollbackReason))
        {
            throw new ArgumentException("rollback target and reason are required", nameof(request));
        }
        await RequireActiveAdminAsync(db, request.RolledBackByAdminPrincipalId, cancellationToken).ConfigureAwait(false);

        ArticleLifecycleCoordinates before = await LoadCoordinatesAsync(
            db,
            request.ArticleId,
            expectedRevisionId: null,
            cancellationToken,
            lockArticle: true).ConfigureAwait(false);
        EnsureExpectedRevision(before, request.ExpectedRevisionId);
        if (before.IsDeleted || before.RevisionId is null)
        {
            throw new ArticleWriteValidationException(
                "article_rollback_requires_active",
                "Rollback requires an active article.");
        }
        ArticleRevisionSource target = await LoadRevisionSourceAsync(
            db,
            request.ArticleId,
            request.TargetRevisionId,
            cancellationToken).ConfigureAwait(false);
        if (target.Id == before.RevisionId.Value)
        {
            throw new ArticleWriteValidationException(
                "article_rollback_target_must_be_historical",
                "Rollback target must be a historical revision, not the current row.");
        }

        DateTime now = EnsureUtc(request.TransitionedAt);
        ArticleRightsNormalizedModel rights = await LoadRightsWriteModelAsync(
            db,
            request.ArticleId,
            target.Id,
            cancellationToken).ConfigureAwait(false);
        ArticleStatus targetStatus = ArticleStatus.Published;
        List<int> tagIds = ParseTagIds(target.TagIds);
        ArticleRevisionWriteResult revision = await ArticleRevisionPersistence.SaveAsync(
            db,
            request.ArticleId,
            target.Title,
            target.Content,
            target.Summary,
            target.CoverImageUrl,
            target.CategoryId,
            tagIds,
            "fixture rollback",
            now,
            request.RolledBackByAdminPrincipalId,
            request.TargetRevisionId,
            request.RollbackReason,
            cancellationToken: cancellationToken).ConfigureAwait(false);
        await UpdateMutableArticleProjectionAsync(
            db,
            request.ArticleId,
            target.Title,
            target.Summary ?? string.Empty,
            target.CoverImageUrl,
            target.CategoryId,
            target.Content,
            tagIds,
            now,
            cancellationToken).ConfigureAwait(false);
        await ReplaceAssetReferencesAsync(
            db,
            request.ArticleId,
            revision.Id,
            target.Content,
            target.CoverImageUrl,
            cancellationToken).ConfigureAwait(false);
        long policyId = await ArticleRightsPolicyPersistence.UpsertAsync(
            db,
            request.ArticleId,
            rights,
            now,
            cancellationToken).ConfigureAwait(false);
        ArticleRightsSnapshot rightsSnapshot = ArticleRightsSnapshotBuilder.Build(
            request.ArticleId,
            revision.Id,
            revision.RevisionNo,
            policyId,
            target.Title,
            target.Content,
            target.Summary,
            target.CoverImageUrl,
            target.CategoryId,
            tagIds,
            targetStatus,
            now,
            null,
            rights,
            now).Snapshot;
        long rightsSnapshotId = await db.Insertable(rightsSnapshot).ExecuteReturnBigIdentityAsync().ConfigureAwait(false);
        (long responsibilitySnapshotId, int responsibilityVersion) = await CloneResponsibilitySnapshotAsync(
            db,
            request.ArticleId,
            target.Id,
            revision,
            now,
            cancellationToken).ConfigureAwait(false);
        ArticleVersionCoordinates version = await ArticlePublicationTransitionWriter.ApplyAsync(
            db,
            new ArticlePublicationTransitionRequest(
                request.ArticleId,
                new ArticleVersionCoordinates(
                    revision.Id,
                    revision.RevisionNo,
                    rightsSnapshotId,
                    responsibilitySnapshotId,
                    null,
                    null,
                    responsibilityVersion),
                targetStatus,
                null,
                now,
                ArticlePublicationTransitionKinds.Rollback,
                ArticleStatusTransitionOperation.Rollback),
            cancellationToken).ConfigureAwait(false);
        ArticleLifecycleCoordinates after = await LoadCoordinatesAsync(
            db,
            request.ArticleId,
            revision.Id,
            cancellationToken).ConfigureAwait(false);
        ArticleMutationOutboxEvent outbox = ArticleMutationOutboxProducer.Create(
            request.ArticleId,
            request.OutboxEventType ?? ArticleMutationEventTypes.Updated,
            version,
            Scope(before),
            Scope(after),
            now,
            now);
        await db.Insertable(outbox).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
        await ArticleSourceGenerationAuthority.RecordMutationAsync(db, outbox.EventId, cancellationToken)
            .ConfigureAwait(false);
        string contentDigest = await ComputeRevisionContentDigestAsync(db, revision.Id, cancellationToken)
            .ConfigureAwait(false);
        AuthoringSignedAuditWriter.ChainWrite audit = await WriteAuditAsync(
            db,
            configuration,
            request.ArticleId,
            request.RolledBackByAdminPrincipalId,
            request.SemanticRole,
            "rollback",
            now,
            version,
            outbox.EventId,
            contentDigest,
            cancellationToken,
            request.TargetRevisionId,
            request.RollbackReason).ConfigureAwait(false);
        return new Result(
            outbox.EventId,
            request.ArticleId,
            before,
            after,
            version,
            outbox,
            audit.ChainId,
            audit.RecordHash,
            contentDigest,
            request.TargetRevisionId,
            now);
    }

    public static async Task<Result> PublishScheduledAsync(
        ISqlSugarClient db,
        IConfiguration configuration,
        ScheduledPublishRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(request);
        using var callerCancellation = new ArticleCreateMutationAuthority.CallerCancellationScope(db);
        await ArticleCreateMutationAuthority.RequireSourceMutationTransactionAsync(db, cancellationToken)
            .ConfigureAwait(false);
        await RequireActiveAdminAsync(db, request.PublishedByAdminPrincipalId, cancellationToken).ConfigureAwait(false);
        if (request.ArticleId <= 0 || request.ExpectedRevisionId <= 0 || string.IsNullOrWhiteSpace(request.SemanticRole))
        {
            throw new ArgumentException("scheduled publish request is incomplete", nameof(request));
        }

        DateTime now = EnsureUtc(request.TransitionedAt);
        ArticleLifecycleCoordinates before = await LoadCoordinatesAsync(
            db,
            request.ArticleId,
            expectedRevisionId: null,
            cancellationToken,
            lockArticle: true).ConfigureAwait(false);
        EnsureExpectedRevision(before, request.ExpectedRevisionId);
        DateTime dueAt = before.PendingPublicationAt ?? before.ScheduledPublishAt
            ?? throw new ArticleWriteValidationException(
                "article_schedule_missing",
                "Scheduled publish requires a stored business-clock due time.");
        if (now < dueAt)
        {
            throw new ArticleStatusTransitionValidationException(new ArticleStatusTransitionValidation(
                ArticleStatusTransitionErrorCodes.ScheduledAtMustBeFuture,
                "Scheduled publication cannot run before its business-clock due time."));
        }
        if (before.IsDeleted || before.RevisionId is null || before.RightsSnapshotId is null)
        {
            throw new ArticleWriteValidationException(
                "article_schedule_source_invalid",
                "Scheduled publication source is incomplete or deleted.");
        }

        // A scheduled update deliberately keeps the old publication as the current public
        // coordinate until the due transition.  Resolve policy/responsibility from the pending
        // revision itself here; using the old publication's snapshots would publish the new
        // revision with stale rights and responsibility coordinates.
        ArticleVersionCoordinates requestedVersion = await LoadRevisionVersionAsync(
            db,
            request.ArticleId,
            before.RevisionId.Value,
            before.RevisionNo!.Value,
            cancellationToken).ConfigureAwait(false);
        ArticleVersionCoordinates version = await ArticlePublicationTransitionWriter.ApplyAsync(
            db,
            new ArticlePublicationTransitionRequest(
                request.ArticleId,
                requestedVersion,
                ArticleStatus.Published,
                null,
                now,
                ArticlePublicationTransitionKinds.ScheduledPublish,
                ArticleStatusTransitionOperation.ScheduledPublish),
            cancellationToken).ConfigureAwait(false);
        ArticleLifecycleCoordinates after = await LoadCoordinatesAsync(
            db,
            request.ArticleId,
            request.ExpectedRevisionId,
            cancellationToken).ConfigureAwait(false);
        ArticleMutationOutboxEvent outbox = ArticleMutationOutboxProducer.Create(
            request.ArticleId,
            request.OutboxEventType ?? ArticleMutationEventTypes.ScheduledPublished,
            version,
            Scope(before),
            Scope(after),
            now,
            now);
        await db.Insertable(outbox).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
        await ArticleSourceGenerationAuthority.RecordMutationAsync(db, outbox.EventId, cancellationToken)
            .ConfigureAwait(false);
        string contentDigest = await ComputeRevisionContentDigestAsync(db, request.ExpectedRevisionId, cancellationToken)
            .ConfigureAwait(false);
        AuthoringSignedAuditWriter.ChainWrite audit = await WriteAuditAsync(
            db,
            configuration,
            request.ArticleId,
            request.PublishedByAdminPrincipalId,
            request.SemanticRole,
            "scheduled-publish",
            now,
            version,
            outbox.EventId,
            contentDigest,
            cancellationToken).ConfigureAwait(false);
        return new Result(
            outbox.EventId,
            request.ArticleId,
            before,
            after,
            version,
            outbox,
            audit.ChainId,
            audit.RecordHash,
            contentDigest,
            TransitionedAtUtc: now);
    }

    private static async Task RequireActiveAdminAsync(
        ISqlSugarClient db,
        long adminPrincipalId,
        CancellationToken cancellationToken)
    {
        if (adminPrincipalId <= 0)
        {
            throw new ArticleWriteValidationException(
                "active_admin_required",
                "A positive active admin principal is required for every lifecycle transition.");
        }

        AdminPrincipal? principal = await db.Queryable<AdminPrincipal>()
            .Where(item => item.Id == adminPrincipalId && item.Status == AdminPrincipalStatus.Active)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (principal is null)
        {
            throw new ArticleWriteValidationException(
                "active_admin_required",
                $"Admin principal {adminPrincipalId} is not active.");
        }
        string[] permissions = principal.Permissions
            .Split(['\r', '\n', ',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (!principal.IsRoot
            && !permissions.Contains(AdminPermissions.ArticleWrite, StringComparer.Ordinal))
        {
            throw new ArticleWriteValidationException(
                "article_write_permission_required",
                $"Admin principal {adminPrincipalId} does not have {AdminPermissions.ArticleWrite}.");
        }
    }

    private static void ValidateCreateRequest(CreateRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.SemanticRole))
            throw new ArgumentException("Semantic role is required.", nameof(request));
        if (request.CategoryId <= 0)
            throw new ArgumentOutOfRangeException(nameof(request.CategoryId));
        if (request.Responsibility is null)
            throw new ArticleWriteValidationException("responsibility_required", "Lifecycle fixtures require explicit responsibility facts.");
        if (request.TargetStatus == ArticleStatus.Deleted)
            throw new ArticleStatusTransitionValidationException(new ArticleStatusTransitionValidation(
                ArticleStatusTransitionErrorCodes.DeletedRequiresDeleteFlow,
                "Deleted can only be reached through the dedicated delete flow."));
        ThrowIfInvalid(ArticleStatusTransitionPolicy.ValidateTarget(
            (int)request.TargetStatus,
            request.ScheduledPublishAt,
            EnsureUtc(request.TransitionedAt)));
    }

    private static void ValidateRevisionRequest(RevisionRequest request)
    {
        if (request.ArticleId <= 0 || request.ExpectedRevisionId <= 0)
            throw new ArgumentException("Article and expected revision are required.", nameof(request));
        if (string.IsNullOrWhiteSpace(request.SemanticRole) || string.IsNullOrWhiteSpace(request.TransitionKind))
            throw new ArgumentException("Semantic role and transition kind are required.", nameof(request));
        if (request.TargetStatus == ArticleStatus.Deleted)
            throw new ArticleStatusTransitionValidationException(new ArticleStatusTransitionValidation(
                ArticleStatusTransitionErrorCodes.DeletedRequiresDeleteFlow,
                "Deleted can only be reached through the dedicated delete flow."));
        ThrowIfInvalid(ArticleStatusTransitionPolicy.ValidateTarget(
            (int)request.TargetStatus,
            request.ScheduledPublishAt,
            EnsureUtc(request.TransitionedAt)));
    }

    private static async Task<ArticleLifecycleCoordinates> LoadCoordinatesAsync(
        ISqlSugarClient db,
        int articleId,
        long? expectedRevisionId,
        CancellationToken cancellationToken,
        bool lockArticle = false)
    {
        string lockClause = lockArticle ? "FOR UPDATE OF article" : string.Empty;
        ArticleLifecycleCoordinates? coordinates = null;
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT article.status,
                   article.isdeleted,
                   article.current_revision_id,
                   revision.revision_no,
                   revision.categoryid,
                   revision.tag_ids,
                   article.current_publication_id,
                   publication.publication_no,
                   article.scheduled_publish_at,
                   article.pending_publication_at,
                   article.deleted_at,
                   COALESCE(publication.rights_snapshot_id, rights.id) AS rights_snapshot_id,
                   COALESCE(publication.responsibility_snapshot_id, responsibility.id) AS responsibility_snapshot_id,
                   responsibility.responsibility_version
            FROM article
            LEFT JOIN article_revision revision
                ON revision.id = article.current_revision_id
            LEFT JOIN article_publication publication
                ON publication.id = article.current_publication_id
            LEFT JOIN LATERAL (
                SELECT snapshot.id
                FROM article_rights_snapshot snapshot
                WHERE snapshot.article_id = article.id
                  AND snapshot.article_revision_id = revision.id
                ORDER BY snapshot.id DESC
                LIMIT 1
            ) rights ON TRUE
            LEFT JOIN LATERAL (
                SELECT snapshot.id, snapshot.responsibility_version
                FROM article_responsibility_snapshot snapshot
                WHERE snapshot.article_id = article.id
                  AND snapshot.article_revision_id = revision.id
                  AND (
                      publication.responsibility_snapshot_id IS NULL
                      OR snapshot.id = publication.responsibility_snapshot_id
                  )
                ORDER BY snapshot.responsibility_version DESC, snapshot.id DESC
                LIMIT 1
            ) responsibility ON TRUE
            WHERE article.id = @ArticleId
            {lockClause};
            """,
            new SugarParameter("@ArticleId", articleId)).ConfigureAwait(false))
        {
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new ArticleWriteValidationException(
                    "article_not_found",
                    $"Article {articleId} does not exist.");
            }

            long? revisionId = reader.IsNull("current_revision_id") ? null : reader.ReadInt64("current_revision_id");
            int? revisionNo = reader.IsNull("revision_no") ? null : reader.ReadInt32("revision_no");
            if (expectedRevisionId.HasValue && revisionId != expectedRevisionId)
            {
                throw new ArticleRevisionConflictException(
                    revisionId ?? 0,
                    revisionNo ?? 0,
                    reader.ReadInt32("status"),
                    DateTime.UtcNow);
            }
            coordinates = new ArticleLifecycleCoordinates(
                (ArticleStatus)reader.ReadInt32("status"),
                reader.ReadBoolean("isdeleted"),
                revisionId,
                revisionNo,
                reader.IsNull("current_publication_id") ? null : reader.ReadInt64("current_publication_id"),
                reader.IsNull("publication_no") ? null : reader.ReadInt32("publication_no"),
                reader.IsNull("rights_snapshot_id") ? null : reader.ReadInt64("rights_snapshot_id"),
                reader.IsNull("responsibility_snapshot_id") ? null : reader.ReadInt64("responsibility_snapshot_id"),
                reader.IsNull("responsibility_version") ? null : reader.ReadInt32("responsibility_version"),
                ReadUtcNullable(reader, "scheduled_publish_at"),
                ReadUtcNullable(reader, "pending_publication_at"),
                ReadUtcNullable(reader, "deleted_at"),
                string.Empty,
                reader.IsNull("categoryid") ? null : reader.ReadInt32("categoryid"),
                ParseTagIds(reader.IsNull("tag_ids") ? string.Empty : reader.ReadString("tag_ids")));
        }

        ArticleLifecycleCoordinates resolved = coordinates!;
        return resolved with
        {
            ContentDigest = resolved.RevisionId.HasValue
                ? await ComputeRevisionContentDigestAsync(db, resolved.RevisionId.Value, cancellationToken).ConfigureAwait(false)
                : string.Empty
        };
    }

    private static async Task<ArticleRevisionSource> LoadRevisionSourceAsync(
        ISqlSugarClient db,
        int articleId,
        long revisionId,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT revision.id,
                   revision.title,
                   revision.summary,
                   revision.cover_image_url,
                   revision.categoryid,
                   revision.tag_ids,
                   COALESCE(content_block.markdown_content, revision.markdown_content) AS content
            FROM article_revision revision
            LEFT JOIN article_revision_content_block content_block
                ON content_block.id = revision.content_block_id
            WHERE revision.article_id = @ArticleId
              AND revision.id = @RevisionId;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@RevisionId", revisionId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new ArticleWriteValidationException(
                "article_revision_not_found",
                $"Revision {revisionId} is not a revision of article {articleId}.");
        }

        return new ArticleRevisionSource(
            reader.ReadInt64("id"),
            reader.ReadString("title"),
            reader.IsNull("summary") ? null : reader.ReadString("summary"),
            reader.IsNull("cover_image_url") ? null : reader.ReadString("cover_image_url"),
            reader.ReadInt32("categoryid"),
            reader.IsNull("tag_ids") ? string.Empty : reader.ReadString("tag_ids"),
            reader.IsNull("content") ? string.Empty : reader.ReadString("content"));
    }

    private static async Task<ArticleRightsNormalizedModel> LoadRightsWriteModelAsync(
        ISqlSugarClient db,
        int articleId,
        long? revisionId,
        CancellationToken cancellationToken)
    {
        if (!revisionId.HasValue)
        {
            return ArticleProductionNormalizers.NormalizeArticleRights(null);
        }

        ArticleRightsSnapshot? snapshot = await db.Queryable<ArticleRightsSnapshot>()
            .Where(item => item.ArticleId == articleId && item.ArticleRevisionId == revisionId.Value)
            .OrderBy(item => item.Id, OrderByType.Desc)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (snapshot is null)
        {
            ArticleRightsPolicy? policy = await db.Queryable<ArticleRightsPolicy>()
                .Where(item => item.ArticleId == articleId)
                .FirstAsync(cancellationToken)
                .ConfigureAwait(false);
            return policy is null
                ? ArticleProductionNormalizers.NormalizeArticleRights(null)
                : new ArticleRightsNormalizedModel(
                    policy.Enabled,
                    policy.LicenseType,
                    policy.CopyrightHolder,
                    policy.CopyrightYear,
                    policy.RightsStatement,
                    policy.AttributionTemplate,
                    policy.CopyPolicy,
                    policy.MaxExcerptChars,
                    policy.AllowCodeCopy,
                    policy.ShowPublicBadge,
                    policy.ProofBindingEnabled);
        }

        return new ArticleRightsNormalizedModel(
            snapshot.Enabled,
            snapshot.LicenseType,
            snapshot.CopyrightHolder,
            snapshot.CopyrightYear,
            snapshot.RightsStatement,
            snapshot.AttributionTemplate,
            snapshot.CopyPolicy,
            snapshot.MaxExcerptChars,
            snapshot.AllowCodeCopy,
            snapshot.ShowPublicBadge,
            snapshot.ProofBindingEnabled);
    }

    private static async Task UpdateMutableArticleProjectionAsync(
        ISqlSugarClient db,
        int articleId,
        string title,
        string summary,
        string? coverImageUrl,
        int categoryId,
        string content,
        IReadOnlyList<int> tagIds,
        DateTime updatedAt,
        CancellationToken cancellationToken)
    {
        _ = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE article
            SET title = @Title,
                summary = @Summary,
                coverimageurl = @CoverImageUrl,
                categoryid = @CategoryId,
                metadata_updated_at = @UpdatedAt
            WHERE id = @ArticleId
              AND isdeleted = false;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@Title", title),
            new SugarParameter("@Summary", summary),
            new SugarParameter("@CoverImageUrl", (object?)coverImageUrl ?? DBNull.Value),
            new SugarParameter("@CategoryId", categoryId),
            new SugarParameter("@UpdatedAt", updatedAt)).ConfigureAwait(false);

        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_body (article_id, markdown_content, updated_at)
            VALUES (@ArticleId, @Content, @UpdatedAt)
            ON CONFLICT (article_id)
            DO UPDATE SET markdown_content = EXCLUDED.markdown_content,
                          updated_at = EXCLUDED.updated_at;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@Content", content),
            new SugarParameter("@UpdatedAt", updatedAt)).ConfigureAwait(false);

        await db.Deleteable<ArticleTag>().Where(item => item.ArticleId == articleId).ExecuteCommandAsync(cancellationToken)
            .ConfigureAwait(false);
        if (tagIds.Count > 0)
        {
            await db.Insertable(tagIds.Distinct().Select(tagId => new ArticleTag
            {
                ArticleId = articleId,
                TagId = tagId
            }).ToArray()).ExecuteCommandAsync().ConfigureAwait(false);
        }
    }

    private static async Task ReplaceAssetReferencesAsync(
        ISqlSugarClient db,
        int articleId,
        long revisionId,
        string content,
        string? coverImageUrl,
        CancellationToken cancellationToken)
    {
        ArticleAssetReferenceWrite[] writes = await new ArticleAssetReferenceWriteBoundary(db)
            .ResolveAsync(content, coverImageUrl, cancellationToken)
            .ConfigureAwait(false);
        var references = new ArticleAssetReferenceStore(db);
        await references.ReplaceCurrentArticleAsync(articleId, writes, cancellationToken).ConfigureAwait(false);
        await references.ReplaceRevisionAsync(revisionId, articleId, writes, cancellationToken).ConfigureAwait(false);
    }

    private static async Task<(long SnapshotId, int Version)> InsertResponsibilitySnapshotAsync(
        ISqlSugarClient db,
        int articleId,
        ArticleRevisionWriteResult revision,
        ArticleResponsibilityDraft draft,
        long? previousSnapshotId,
        DateTime createdAt,
        CancellationToken cancellationToken)
    {
        ArticleResponsibilitySnapshot built = ArticleResponsibilitySnapshotBuilder.Build(
            articleId,
            revision.Id,
            revision.RevisionNo,
            1,
            previousSnapshotId,
            draft,
            createdAt);
        long id = await db.Insertable(built).ExecuteReturnBigIdentityAsync().ConfigureAwait(false);
        if (id <= 0)
        {
            throw new InvalidOperationException("responsibility_snapshot_insert_failed");
        }

        return (id, 1);
    }

    private static async Task<(long SnapshotId, int Version)> CloneResponsibilitySnapshotAsync(
        ISqlSugarClient db,
        int articleId,
        long sourceRevisionId,
        ArticleRevisionWriteResult targetRevision,
        DateTime createdAt,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            INSERT INTO article_responsibility_snapshot (
                article_id, article_revision_id, revision_no, responsibility_version,
                previous_snapshot_id, inherit_site_author, authors_json, reviewer_json,
                sources_json, update_summary, update_reason, effective_at, conclusion_impact,
                methodology, applicability, limitations, responsible_person_confirmed, created_at)
            SELECT
                @ArticleId, @TargetRevisionId, @TargetRevisionNo, 1,
                source.id, source.inherit_site_author, source.authors_json, source.reviewer_json,
                source.sources_json, source.update_summary, source.update_reason, source.effective_at,
                source.conclusion_impact, source.methodology, source.applicability, source.limitations,
                source.responsible_person_confirmed, @CreatedAt
            FROM article_responsibility_snapshot source
            WHERE source.article_id = @ArticleId
              AND source.article_revision_id = @SourceRevisionId
            ORDER BY source.responsibility_version DESC, source.id DESC
            LIMIT 1
            RETURNING id;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@TargetRevisionId", targetRevision.Id),
            new SugarParameter("@TargetRevisionNo", targetRevision.RevisionNo),
            new SugarParameter("@SourceRevisionId", sourceRevisionId),
            new SugarParameter("@CreatedAt", createdAt)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new ArticleWriteValidationException(
                "article_revision_package_incomplete",
                "The source revision has no responsibility snapshot.");
        }

        return (reader.ReadInt64("id"), 1);
    }

    private static async Task<string> ComputeRevisionContentDigestAsync(
        ISqlSugarClient db,
        long revisionId,
        CancellationToken cancellationToken)
    {
        string? content = await db.Queryable<ArticleRevision>()
            .LeftJoin<ArticleRevisionContentBlock>((revision, block) => revision.ContentBlockId == block.Id)
            .Where((revision, block) => revision.Id == revisionId)
            .Select((revision, block) => block.MarkdownContent)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        content ??= await db.Queryable<ArticleRevision>()
            .Where(item => item.Id == revisionId)
            .Select(item => item.MarkdownContent)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false) ?? string.Empty;
        return ComputeDigest(content);
    }

    private static async Task<AuthoringSignedAuditWriter.ChainWrite> WriteAuditAsync(
        ISqlSugarClient db,
        IConfiguration configuration,
        int articleId,
        long adminPrincipalId,
        string semanticRole,
        string operation,
        DateTime occurredAt,
        ArticleVersionCoordinates version,
        string outboxEventId,
        string contentDigest,
        CancellationToken cancellationToken,
        long? rollbackSourceRevisionId = null,
        string? rollbackReason = null)
    {
        string eventInfo = ComputeDigest(FormattableString.Invariant(
            $"article:{articleId}|operation:{operation}|revision:{version.RevisionId}:{version.RevisionNo}|publication:{version.PublicationId}:{version.PublicationNo}|rights:{version.RightsSnapshotId}|responsibility:{version.ResponsibilitySnapshotId}:{version.ResponsibilityVersion}|outbox:{outboxEventId}|content:{contentDigest}|rollback:{rollbackSourceRevisionId}:{rollbackReason}"));
        byte[]? tamperKey = AuditTamperEvidence.ResolveKey(configuration);
        return await AuthoringSignedAuditWriter.InsertAsync(
            db,
            tamperKey,
            new AuditRecord(
                Source: AuditSourceCatalog.Article,
                Type: AuditTypeCatalog.Business,
                OccurredAtUtc: occurredAt,
                EventInfo: eventInfo,
                ContextPayload: null,
                Action: AdminPermissions.ArticleWrite,
                Outcome: AuditOutcomeCatalog.Success,
                Severity: AuditSeverityCatalog.Info,
                ActorType: AuditActorTypeCatalog.Admin,
                ActorId: adminPrincipalId.ToString(CultureInfo.InvariantCulture),
                ActorRole: "admin",
                TargetType: "article-canonical-lifecycle",
                TargetId: articleId.ToString(CultureInfo.InvariantCulture),
                IsHighValue: true,
                ReasonCode: $"canonical-lifecycle-{operation}",
                ContextJson: System.Text.Json.JsonSerializer.Serialize(new
                {
                    semanticRole,
                    articleId,
                    revisionId = version.RevisionId,
                    publicationId = version.PublicationId,
                    outboxEventId,
                    contentDigest,
                    rollbackSourceRevisionId,
                    rollbackReason
                })),
            cancellationToken).ConfigureAwait(false);
    }

    private static ArticleMutationScopeSnapshot Scope(ArticleLifecycleCoordinates coordinates)
        => new(
            coordinates.CategoryId,
            coordinates.TagIds,
            Visibility: ArticleMutationVisibility.From(coordinates.Status, coordinates.IsDeleted));

    private static ArticleVersionCoordinates ToVersion(ArticleLifecycleCoordinates coordinates)
        => new(
            coordinates.RevisionId ?? throw new InvalidOperationException("current revision coordinate missing"),
            coordinates.RevisionNo ?? throw new InvalidOperationException("current revision number missing"),
            coordinates.RightsSnapshotId ?? throw new InvalidOperationException("current rights coordinate missing"),
            coordinates.ResponsibilitySnapshotId,
            coordinates.PublicationId,
            coordinates.PublicationNo,
            coordinates.ResponsibilityVersion);

    private static async Task<ArticleVersionCoordinates> LoadRevisionVersionAsync(
        ISqlSugarClient db,
        int articleId,
        long revisionId,
        int revisionNo,
        CancellationToken cancellationToken)
    {
        ArticleRightsSnapshot? rights = (await db.Queryable<ArticleRightsSnapshot>()
            .ClearFilter()
            .Where(item => item.ArticleId == articleId && item.ArticleRevisionId == revisionId)
            .OrderBy(item => item.Id, OrderByType.Desc)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false))
            .FirstOrDefault();
        if (rights is null)
        {
            throw new ArticleWriteValidationException(
                "article_revision_package_incomplete",
                $"Revision {revisionId} has no rights snapshot.");
        }

        ArticleResponsibilitySnapshot? responsibility = (await db.Queryable<ArticleResponsibilitySnapshot>()
            .ClearFilter()
            .Where(item => item.ArticleId == articleId && item.ArticleRevisionId == revisionId)
            .OrderBy(item => item.ResponsibilityVersion, OrderByType.Desc)
            .OrderBy(item => item.Id, OrderByType.Desc)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false))
            .FirstOrDefault();
        return new ArticleVersionCoordinates(
            revisionId,
            revisionNo,
            rights.Id,
            responsibility?.Id,
            null,
            null,
            responsibility?.ResponsibilityVersion);
    }

    private static void EnsureExpectedRevision(ArticleLifecycleCoordinates coordinates, long expectedRevisionId)
    {
        if (coordinates.RevisionId != expectedRevisionId)
        {
            throw new ArticleRevisionConflictException(
                coordinates.RevisionId ?? 0,
                coordinates.RevisionNo ?? 0,
                (int)coordinates.Status,
                DateTime.UtcNow);
        }
    }

    private static ArticleLifecycleCoordinates EmptyCoordinates()
        => new(
            ArticleStatus.Draft,
            false,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            string.Empty,
            null,
            []);

    private static string TransitionKindFor(ArticleStatus status)
        => status switch
        {
            ArticleStatus.Draft => ArticlePublicationTransitionKinds.SaveDraft,
            ArticleStatus.Scheduled => ArticlePublicationTransitionKinds.Schedule,
            ArticleStatus.Published => ArticlePublicationTransitionKinds.ImmediatePublish,
            ArticleStatus.Archived => ArticlePublicationTransitionKinds.Archive,
            _ => throw new ArgumentOutOfRangeException(nameof(status))
        };

    private static DateTime EnsureUtc(DateTime value)
        => value.Kind == DateTimeKind.Utc
            ? value
            : DateTime.SpecifyKind(value, DateTimeKind.Utc);

    private static DateTime? ReadUtcNullable(DbDataReader reader, string name)
        => reader.IsNull(name) ? null : DateTime.SpecifyKind(reader.ReadDateTime(name), DateTimeKind.Utc);

    private static void ThrowIfInvalid(ArticleStatusTransitionValidation? validation)
    {
        if (validation.HasValue)
        {
            throw new ArticleStatusTransitionValidationException(validation.Value);
        }
    }

    private static List<int> ParseTagIds(string value)
        => value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(item => int.TryParse(item, NumberStyles.Integer, CultureInfo.InvariantCulture, out int id) ? id : 0)
            .Where(static id => id > 0)
            .Distinct()
            .Order()
            .ToList();

    private static string ComputeDigest(string value)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private sealed record ArticleRevisionSource(
        long Id,
        string Title,
        string? Summary,
        string? CoverImageUrl,
        int CategoryId,
        string TagIds,
        string Content);
}
