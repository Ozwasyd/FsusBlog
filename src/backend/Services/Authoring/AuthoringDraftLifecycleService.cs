using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed class AuthoringDraftLifecycleService(
    ISqlSugarClient db,
    FsusBlog.Core.Services.Abstractions.IArticleCoreService articleService,
    IArticlePublicationValidator publicationValidator,
    IAuthoringAuditWriter auditWriter) : IAuthoringDraftLifecycle, IAuthoringPrepublishPolicy
{
    private const int MaxDraftKeyLength = 96;
    private const int PreviewLength = 24_000;
    private const int WarningOverrideReasonLength = 180;
    private static readonly JsonSerializerOptions s_draftRightsJsonOptions = new(JsonSerializerDefaults.Web);
    public async Task<ServerDraftResponse> SaveDraftAsync(long ownerAdminPrincipalId, ServerDraftSaveRequest request, CancellationToken cancellationToken = default)
    {
        string draftKey = NormalizeDraftKey(request.DraftKey, request.ArticleId);
        string tagIds = string.Join(',', AuthoringNormalization.NormalizeTagIds(request.TagIds));
        ArticleRightsRequest rights = NormalizeDraftRights(request.Rights);
        DateTime now = DateTime.UtcNow;
        var draft = new ArticleDraft
        {
            OwnerAdminPrincipalId = ownerAdminPrincipalId,
            DraftKey = draftKey,
            ArticleId = request.ArticleId,
            BaseRevisionId = request.BaseRevisionId,
            Title = AuthoringNormalization.Normalize(request.Title, 256),
            Summary = TextHelpers.NormalizeNullable(request.Summary, 512),
            CoverImageUrl = TextHelpers.NormalizeNullable(request.CoverImageUrl, 512),
            CategoryId = Math.Max(0, request.CategoryId),
            TagIds = tagIds,
            MarkdownContent = AuthoringNormalization.Normalize(request.Content, 200_000),
            Status = NormalizeArticleStatus(request.Status),
            RightsJson = SerializeDraftRights(rights),
            ClientRevision = TextHelpers.NormalizeNullable(request.ClientRevision, 64),
            ServerRevision = request.ExpectedServerRevision.GetValueOrDefault() + 1,
            CreatedAt = now,
            UpdatedAt = now
        };
        draft.ScheduledPublishAt = draft.Status == ArticleStatus.Scheduled ? request.ScheduledPublishAt : null;

        bool mutated = false;
        ArticleDraft? savedDraft = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            (savedDraft, mutated) = await SaveDraftWithCasAsync(
                    draft,
                    request.ExpectedServerRevision,
                    cancellationToken)
                .ConfigureAwait(false);
            if (mutated)
            {
                ArticleAssetReferenceWrite[] assetReferenceWrites = await new ArticleAssetReferenceWriteBoundary(db)
                    .ResolveAsync(draft.MarkdownContent, draft.CoverImageUrl, cancellationToken)
                    .ConfigureAwait(false);
                await new ArticleAssetReferenceStore(db)
                    .ReplaceDraftAsync(
                        draft.OwnerAdminPrincipalId,
                        draft.DraftKey,
                        draft.ArticleId,
                        assetReferenceWrites,
                        cancellationToken)
                    .ConfigureAwait(false);
            }
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is ServerDraftConflictException conflict)
            {
                throw conflict;
            }

            throw new InvalidOperationException("Server draft and asset references were not saved atomically.", transaction.ErrorException);
        }

        if (mutated)
        {
            auditWriter.Write(AuditSourceCatalog.Article, "server-draft-save", ownerAdminPrincipalId, draftKey);
        }

        return ToDraftResponse(savedDraft!);
    }

    private async Task<(ArticleDraft Draft, bool Mutated)> SaveDraftWithCasAsync(
        ArticleDraft draft,
        long? expectedServerRevision,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int affected = expectedServerRevision.HasValue
            ? await UpdateDraftWithCasAsync(draft, expectedServerRevision.Value).ConfigureAwait(false)
            : await InsertDraftAsync(draft).ConfigureAwait(false);
        if (affected == 1)
        {
            return (draft, true);
        }

        ArticleDraft? current = await db.Queryable<ArticleDraft>()
            .Where(it => it.OwnerAdminPrincipalId == draft.OwnerAdminPrincipalId && it.DraftKey == draft.DraftKey)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (current is not null && IsIdempotentRetry(current, draft))
        {
            return (current, false);
        }

        throw new ServerDraftConflictException(ToDraftConflict(current));
    }

    private Task<int> InsertDraftAsync(ArticleDraft draft)
        => db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_draft (
                owner_admin_principal_id,
                article_id,
                base_revision_id,
                draft_key,
                title,
                summary,
                cover_image_url,
                categoryid,
                tag_ids,
                markdown_content,
                client_revision,
                status,
                scheduled_publish_at,
                rights_json,
                server_revision,
                created_at,
                updated_at
            ) VALUES (
                @OwnerAdminPrincipalId,
                CAST(@ArticleId AS integer),
                CAST(@BaseRevisionId AS bigint),
                @DraftKey,
                @Title,
                @Summary,
                @CoverImageUrl,
                @CategoryId,
                @TagIds,
                @MarkdownContent,
                @ClientRevision,
                @Status,
                CAST(@ScheduledPublishAt AS timestamp),
                @RightsJson,
                @ServerRevision,
                @CreatedAt,
                @UpdatedAt
            )
            ON CONFLICT (owner_admin_principal_id, draft_key) DO NOTHING;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", draft.OwnerAdminPrincipalId),
            new SugarParameter("@ArticleId", AuthoringNormalization.DbValue(draft.ArticleId)),
            new SugarParameter("@BaseRevisionId", (object?)draft.BaseRevisionId ?? DBNull.Value),
            new SugarParameter("@DraftKey", draft.DraftKey),
            new SugarParameter("@Title", draft.Title),
            new SugarParameter("@Summary", AuthoringNormalization.DbValue(draft.Summary)),
            new SugarParameter("@CoverImageUrl", AuthoringNormalization.DbValue(draft.CoverImageUrl)),
            new SugarParameter("@CategoryId", draft.CategoryId),
            new SugarParameter("@TagIds", draft.TagIds),
            new SugarParameter("@MarkdownContent", draft.MarkdownContent),
            new SugarParameter("@ClientRevision", AuthoringNormalization.DbValue(draft.ClientRevision)),
            new SugarParameter("@Status", (int)draft.Status),
            new SugarParameter("@ScheduledPublishAt", AuthoringNormalization.DbValue(draft.ScheduledPublishAt)),
            new SugarParameter("@RightsJson", AuthoringNormalization.DbValue(draft.RightsJson)),
            new SugarParameter("@ServerRevision", draft.ServerRevision),
            new SugarParameter("@CreatedAt", draft.CreatedAt),
            new SugarParameter("@UpdatedAt", draft.UpdatedAt));

    private Task<int> UpdateDraftWithCasAsync(ArticleDraft draft, long expectedServerRevision)
        => db.Ado.ExecuteCommandAsync(
            """
            UPDATE article_draft
            SET article_id = CAST(@ArticleId AS integer),
                base_revision_id = CAST(@BaseRevisionId AS bigint),
                title = @Title,
                summary = @Summary,
                cover_image_url = @CoverImageUrl,
                categoryid = @CategoryId,
                tag_ids = @TagIds,
                markdown_content = @MarkdownContent,
                client_revision = @ClientRevision,
                status = @Status,
                scheduled_publish_at = CAST(@ScheduledPublishAt AS timestamp),
                rights_json = @RightsJson,
                server_revision = server_revision + 1,
                updated_at = @UpdatedAt
            WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
              AND draft_key = @DraftKey
              AND server_revision = @ExpectedServerRevision;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", draft.OwnerAdminPrincipalId),
            new SugarParameter("@ArticleId", AuthoringNormalization.DbValue(draft.ArticleId)),
            new SugarParameter("@BaseRevisionId", (object?)draft.BaseRevisionId ?? DBNull.Value),
            new SugarParameter("@DraftKey", draft.DraftKey),
            new SugarParameter("@Title", draft.Title),
            new SugarParameter("@Summary", AuthoringNormalization.DbValue(draft.Summary)),
            new SugarParameter("@CoverImageUrl", AuthoringNormalization.DbValue(draft.CoverImageUrl)),
            new SugarParameter("@CategoryId", draft.CategoryId),
            new SugarParameter("@TagIds", draft.TagIds),
            new SugarParameter("@MarkdownContent", draft.MarkdownContent),
            new SugarParameter("@ClientRevision", AuthoringNormalization.DbValue(draft.ClientRevision)),
            new SugarParameter("@Status", (int)draft.Status),
            new SugarParameter("@ScheduledPublishAt", AuthoringNormalization.DbValue(draft.ScheduledPublishAt)),
            new SugarParameter("@RightsJson", AuthoringNormalization.DbValue(draft.RightsJson)),
            new SugarParameter("@UpdatedAt", draft.UpdatedAt),
            new SugarParameter("@ExpectedServerRevision", expectedServerRevision));

    public async Task<ServerDraftResponse?> GetDraftAsync(long ownerAdminPrincipalId, string draftKey, CancellationToken cancellationToken = default)
    {
        string normalized = NormalizeDraftKey(draftKey, null);
        ArticleDraft? draft = await db.Queryable<ArticleDraft>()
            .Where(it => it.OwnerAdminPrincipalId == ownerAdminPrincipalId && it.DraftKey == normalized)
            .FirstAsync(cancellationToken);
        return draft is null ? null : ToDraftResponse(draft);
    }

    public async Task<bool> DiscardDraftAsync(
        long ownerAdminPrincipalId,
        string draftKey,
        long expectedServerRevision,
        CancellationToken cancellationToken = default)
    {
        string normalized = NormalizeDraftKey(draftKey, null);
        int count = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            count = await db.Ado.ExecuteCommandAsync(
                """
                DELETE FROM article_draft
                WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
                  AND draft_key = @DraftKey
                  AND server_revision = @ExpectedServerRevision;
                """,
                new SugarParameter("@OwnerAdminPrincipalId", ownerAdminPrincipalId),
                new SugarParameter("@DraftKey", normalized),
                new SugarParameter("@ExpectedServerRevision", expectedServerRevision));
            if (count > 0)
            {
                await new ArticleAssetReferenceStore(db)
                    .RemoveDraftAsync(ownerAdminPrincipalId, normalized, cancellationToken)
                    .ConfigureAwait(false);
            }
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Server draft and asset references were not discarded atomically.", transaction.ErrorException);
        }

        if (count > 0)
        {
            auditWriter.Write(AuditSourceCatalog.Article, "server-draft-discard", ownerAdminPrincipalId, normalized);
            return true;
        }

        ArticleDraft? current = await db.Queryable<ArticleDraft>()
            .Where(it => it.OwnerAdminPrincipalId == ownerAdminPrincipalId && it.DraftKey == normalized)
            .FirstAsync(cancellationToken);
        if (current is not null)
        {
            throw new ServerDraftConflictException(ToDraftConflict(current));
        }

        return false;
    }

    public async Task<IReadOnlyList<ArticleRevisionSummaryResponse>> GetRevisionsAsync(int articleId, CancellationToken cancellationToken = default)
    {
        List<ArticleRevision> revisions = await db.Queryable<ArticleRevision>()
            .Where(it => it.ArticleId == articleId)
            .OrderByDescending(it => it.RevisionNo)
            .Take(50)
            .ToListAsync(cancellationToken);
        await ArticleRevisionContentBlockStore.HydrateAsync(db, revisions, cancellationToken).ConfigureAwait(false);

        return revisions.Select(static revision => new ArticleRevisionSummaryResponse(
            revision.Id.ToString(CultureInfo.InvariantCulture),
            revision.ArticleId,
            revision.RevisionNo,
            revision.Title,
            revision.DiffSummary,
            revision.CreatedByAdminPrincipalId.ToString(CultureInfo.InvariantCulture),
            revision.CreatedAt,
            revision.RollbackSourceRevisionId?.ToString(CultureInfo.InvariantCulture),
            revision.RollbackReason)).ToArray();
    }

    public async Task<ArticleRevisionDetailResponse?> GetRevisionAsync(int articleId, long revisionId, CancellationToken cancellationToken = default)
    {
        ArticleRevision? revision = await db.Queryable<ArticleRevision>()
            .Where(it => it.ArticleId == articleId && it.Id == revisionId)
            .FirstAsync(cancellationToken);
        if (revision is null)
        {
            return null;
        }
        if (revision.ContentBlockId > 0)
        {
            revision.MarkdownContent = await ArticleRevisionContentBlockStore.LoadAsync(
                db,
                revision.ContentBlockId,
                cancellationToken).ConfigureAwait(false);
        }

        ArticleRightsSnapshot? rights = await db.Queryable<ArticleRightsSnapshot>()
            .Where(it => it.ArticleId == articleId && it.ArticleRevisionId == revisionId)
            .FirstAsync(cancellationToken);
        ArticlePublicationRecord? release = await db.Queryable<ArticlePublicationRecord>()
            .Where(it => it.ArticleId == articleId && it.ArticleRevisionId == revisionId)
            .OrderByDescending(it => it.PublicationNo)
            .FirstAsync(cancellationToken);
        ArticleResponsibilitySnapshot? responsibility = await db.Queryable<ArticleResponsibilitySnapshot>()
            .Where(it => it.ArticleId == articleId && it.ArticleRevisionId == revisionId)
            .WhereIF(release?.ResponsibilitySnapshotId is not null, it => it.Id == release!.ResponsibilitySnapshotId!.Value)
            .OrderByDescending(it => it.ResponsibilityVersion)
            .FirstAsync(cancellationToken);
        return ToRevisionDetailResponse(revision, rights, responsibility, release);
    }

    public async Task<Result<ArticleMutationResult>> RollbackRevisionAsync(
        long actorAdminPrincipalId,
        int articleId,
        long revisionId,
        ArticleRevisionRollbackRequest request,
        CancellationToken cancellationToken = default)
    {
        string reason = request.Reason?.Trim() ?? string.Empty;
        if (request.BaseRevisionId <= 0)
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.Validation, "article_base_revision_required");
        }
        if (reason.Length is < 8 or > 500)
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.Validation, "article_rollback_reason_invalid");
        }
        if (request.TargetStatus is not ((int)ArticleStatus.Draft)
            and not ((int)ArticleStatus.Published)
            and not ((int)ArticleStatus.Archived))
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.Validation, "article_rollback_status_invalid");
        }

        ArticleRevision? revision = await db.Queryable<ArticleRevision>()
            .Where(it => it.ArticleId == articleId && it.Id == revisionId)
            .FirstAsync(cancellationToken);
        if (revision is null)
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.NotFound, "revision_not_found");
        }
        if (revision.ContentBlockId > 0)
        {
            revision.MarkdownContent = await ArticleRevisionContentBlockStore.LoadAsync(
                db,
                revision.ContentBlockId,
                cancellationToken).ConfigureAwait(false);
        }

        string? summary = ArticleSummaryProjection.WasAutomaticallyGenerated(revision.DiffSummary)
            ? null
            : revision.Summary;
        var updateResult = await articleService.UpdateAsync(new FsusBlog.Core.Services.Articles.UpdateArticleCommand(
            articleId,
            new FsusBlog.Core.Mapping.Models.ArticleWriteRequestCoreModel(
                revision.Title,
                revision.MarkdownContent,
                summary,
                revision.CoverImageUrl,
                revision.CategoryId,
                AuthoringNormalization.ParseTagIds(revision.TagIds),
                request.TargetStatus,
                Rights: null,
                RightsMutation: FsusBlog.Core.Mapping.Models.ArticleRightsMutationMode.Preserve,
                BaseRevisionId: request.BaseRevisionId),
            FsusBlog.Core.Services.Articles.ArticleUpdateIntent.Rollback,
            Force: false,
            Rollback: new FsusBlog.Core.Services.Articles.ArticleRollbackMetadata(
                revisionId,
                actorAdminPrincipalId,
                reason)));
        bool updated = updateResult.IsSuccess;
        if (!updated)
        {
            return Result<ArticleMutationResult>.Failure(updateResult.Error);
        }

        ArticleRevision? createdRevision = await db.Queryable<ArticleRevision>()
            .Where(it => it.ArticleId == articleId
                && it.RollbackSourceRevisionId == revisionId
                && it.CreatedByAdminPrincipalId == actorAdminPrincipalId
                && it.RollbackReason == reason)
            .OrderByDescending(it => it.Id)
            .FirstAsync(cancellationToken);
        ArticlePublicationRecord? createdRelease = createdRevision is not null
            ? await db.Queryable<ArticlePublicationRecord>()
                .Where(it => it.ArticleId == articleId && it.ArticleRevisionId == createdRevision.Id)
                .OrderByDescending(it => it.PublicationNo)
                .FirstAsync(cancellationToken)
            : null;
        ArticleRightsSnapshot? createdRights = createdRevision is not null
            ? await db.Queryable<ArticleRightsSnapshot>()
                .Where(it => it.ArticleId == articleId && it.ArticleRevisionId == createdRevision.Id)
                .FirstAsync(cancellationToken)
            : null;
        if (createdRevision is null || createdRelease is null || createdRights is null)
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.InfraFailure, "article_rollback_coordinates_missing");
        }

        auditWriter.Write(
            AuditSourceCatalog.Article,
            "article-revision-rollback",
            actorAdminPrincipalId,
            $"{articleId}:{revisionId}->{createdRevision.Id};status={request.TargetStatus}");
        return Result<ArticleMutationResult>.Success(new ArticleMutationResult(
            articleId,
            createdRevision.Id,
            createdRevision.RevisionNo,
            createdRelease.Id,
            createdRelease.PublicationNo,
            request.TargetStatus,
            createdRights.Id,
            createdRights.RevisionNo,
            IdempotencyReplay: false,
            (byte)ErrorCode.None));
    }

    public Task<ArticlePreviewResponse> PreviewAsync(ServerDraftSaveRequest request)
    {
        PrepublishCheckResponse check = RunPrepublishCheck(request.Title, request.Content, request.Summary, request.CoverImageUrl);
        string normalizedTitle = AuthoringNormalization.Normalize(request.Title, 256);
        string normalizedMarkdownSource = AuthoringNormalization.Normalize(
            (request.Content ?? string.Empty)
                .Replace("\r\n", "\n", StringComparison.Ordinal)
                .Replace('\r', '\n'),
            200_000);
        string normalizedSummary = ArticleSummaryProjection.Resolve(request.Summary, request.Content, 180).Text;
        string? normalizedCoverImageUrl = NormalizePreviewUrl(request.CoverImageUrl);
        string plain = ArticleSummaryProjection.ToPlainText(request.Content, PreviewLength);
        string sourceIdentity = CreatePreviewSourceIdentity(
            request.Title,
            request.Content,
            request.Summary,
            request.CoverImageUrl);
        return Task.FromResult(new ArticlePreviewResponse(
            normalizedTitle,
            normalizedSummary,
            normalizedCoverImageUrl,
            normalizedMarkdownSource,
            plain,
            sourceIdentity,
            check.Issues));
    }

    public PrepublishCheckResponse RunPrepublishCheck(
        string title,
        string content,
        string? summary,
        string? coverImageUrl,
        int? actorUserId = null,
        string? draftKey = null,
        int? articleId = null,
        string? warningOverrideReason = null)
    {
        ArticlePublicationValidationResult validation = publicationValidator.ValidateContent(
            new ArticlePublicationValidationInput(
                title,
                content,
                summary,
                coverImageUrl,
                CategoryId: 0,
                TagIds: [],
                ArticleStatus.Published,
                ScheduledPublishAt: null),
            DateTime.UtcNow);
        RecordPrepublishWarningOverride(
            actorUserId,
            articleId,
            draftKey,
            warningOverrideReason,
            validation.CanPublish,
            validation.Issues);
        return validation.ToPrepublishResponse();
    }

    public async Task<PrepublishCheckResponse> RunPrepublishCheckAsync(
        ServerDraftSaveRequest request,
        int? actorUserId = null,
        CancellationToken cancellationToken = default)
    {
        var status = (ArticleStatus)(request.Status ?? (int)ArticleStatus.Published);
        ArticlePublicationValidationResult validation = await publicationValidator.ValidateAsync(
            new ArticlePublicationValidationInput(
                request.Title,
                request.Content,
                request.Summary,
                request.CoverImageUrl,
                request.CategoryId,
                request.TagIds,
                status,
                request.ScheduledPublishAt),
            DateTime.UtcNow,
            cancellationToken).ConfigureAwait(false);
        RecordPrepublishWarningOverride(
            actorUserId,
            request.ArticleId,
            request.DraftKey,
            request.WarningOverrideReason,
            validation.CanPublish,
            validation.Issues);
        return validation.ToPrepublishResponse();
    }


    private static ServerDraftResponse ToDraftResponse(ArticleDraft draft)
        => new(
            draft.DraftKey,
            draft.ArticleId,
            draft.Title,
            draft.MarkdownContent,
            draft.Summary,
            draft.CoverImageUrl,
            draft.CategoryId,
            AuthoringNormalization.ParseTagIds(draft.TagIds),
            draft.ClientRevision,
            (int)draft.Status,
            draft.ScheduledPublishAt,
            draft.UpdatedAt,
            DeserializeDraftRights(draft.RightsJson),
            draft.BaseRevisionId,
            draft.ServerRevision);

    private static bool IsIdempotentRetry(ArticleDraft current, ArticleDraft candidate)
        => !string.IsNullOrWhiteSpace(candidate.ClientRevision)
            && string.Equals(current.ClientRevision, candidate.ClientRevision, StringComparison.Ordinal)
            && current.ArticleId == candidate.ArticleId
            && current.BaseRevisionId == candidate.BaseRevisionId
            && string.Equals(current.Title, candidate.Title, StringComparison.Ordinal)
            && string.Equals(current.Summary, candidate.Summary, StringComparison.Ordinal)
            && string.Equals(current.CoverImageUrl, candidate.CoverImageUrl, StringComparison.Ordinal)
            && current.CategoryId == candidate.CategoryId
            && string.Equals(current.TagIds, candidate.TagIds, StringComparison.Ordinal)
            && string.Equals(current.MarkdownContent, candidate.MarkdownContent, StringComparison.Ordinal)
            && current.Status == candidate.Status
            && current.ScheduledPublishAt == candidate.ScheduledPublishAt
            && string.Equals(current.RightsJson, candidate.RightsJson, StringComparison.Ordinal);

    private static ServerDraftConflictResponse ToDraftConflict(ArticleDraft? current)
        => current is null
            ? new ServerDraftConflictResponse(null, null, null)
            : new ServerDraftConflictResponse(
                current.ServerRevision,
                current.UpdatedAt,
                current.Title.Length <= 12 ? current.Title : current.Title[..12]);

    private static ArticleRevisionDetailResponse ToRevisionDetailResponse(
        ArticleRevision revision,
        ArticleRightsSnapshot? rights,
        ArticleResponsibilitySnapshot? responsibility,
        ArticlePublicationRecord? release)
        => new(
            revision.Id.ToString(CultureInfo.InvariantCulture),
            revision.ArticleId,
            revision.RevisionNo,
            revision.Title,
            revision.MarkdownContent,
            revision.Summary,
            revision.CoverImageUrl,
            revision.CategoryId,
            AuthoringNormalization.ParseTagIds(revision.TagIds),
            revision.DiffSummary,
            revision.CreatedByAdminPrincipalId.ToString(CultureInfo.InvariantCulture),
            revision.CreatedAt,
            revision.RollbackSourceRevisionId?.ToString(CultureInfo.InvariantCulture),
            revision.RollbackReason,
            rights is not null && responsibility is not null,
            rights is null ? null : new ArticleRevisionRightsSnapshotResponse(
                rights.Id.ToString(CultureInfo.InvariantCulture),
                rights.Enabled,
                rights.LicenseType,
                rights.CopyrightHolder,
                rights.CopyrightYear,
                rights.RightsStatement,
                rights.AttributionTemplate,
                rights.CopyPolicy,
                rights.MaxExcerptChars,
                rights.AllowCodeCopy,
                rights.ShowPublicBadge,
                rights.ProofBindingEnabled,
                rights.CanonicalUrl,
                rights.PolicyHash,
                rights.ContentCanonicalHash,
                rights.CreatedAt),
            responsibility is null ? null : new ArticleRevisionResponsibilitySnapshotResponse(
                responsibility.Id.ToString(CultureInfo.InvariantCulture),
                responsibility.ResponsibilityVersion,
                responsibility.PreviousSnapshotId?.ToString(CultureInfo.InvariantCulture),
                responsibility.InheritSiteAuthor,
                DeserializeJsonList<ArticleResponsiblePerson>(responsibility.AuthorsJson),
                DeserializeJsonValue<ArticleResponsiblePerson>(responsibility.ReviewerJson),
                DeserializeJsonList<ArticleEvidenceSource>(responsibility.SourcesJson),
                responsibility.UpdateSummary,
                responsibility.UpdateReason,
                responsibility.EffectiveAt,
                responsibility.ConclusionImpact,
                responsibility.Methodology,
                responsibility.Applicability,
                responsibility.Limitations,
                responsibility.ResponsiblePersonConfirmed,
                responsibility.CreatedAt),
            release is null ? null : new ArticleRevisionReleaseResponse(
                release.Id.ToString(CultureInfo.InvariantCulture),
                release.PublicationNo,
                release.TransitionKind,
                release.PublishedAt));

    private static IReadOnlyList<T> DeserializeJsonList<T>(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<T[]>(json, s_draftRightsJsonOptions) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static T? DeserializeJsonValue<T>(string? json) where T : class
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<T>(json, s_draftRightsJsonOptions);
        }
        catch (JsonException)
        {
            return null;
        }
    }


    private void RecordPrepublishWarningOverride(
        int? actorUserId,
        int? articleId,
        string? draftKey,
        string? warningOverrideReason,
        bool canPublish,
        IReadOnlyList<PrepublishIssue> issues)
    {
        if (actorUserId is not > 0 || !canPublish || string.IsNullOrWhiteSpace(warningOverrideReason))
        {
            return;
        }

        string[] warnings = issues
            .Where(static issue => issue.Severity.Equals("warning", StringComparison.OrdinalIgnoreCase))
            .Select(static issue => issue.Code)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(static code => code, StringComparer.Ordinal)
            .ToArray();
        if (warnings.Length == 0)
        {
            return;
        }

        string reason = AuthoringNormalization.Normalize(warningOverrideReason, WarningOverrideReasonLength);
        if (reason.Length < 8)
        {
            return;
        }

        string target = articleId is > 0
            ? $"article:{articleId.Value}"
            : $"draft:{NormalizeDraftKey(draftKey, null)}";
        auditWriter.Write(AuditSourceCatalog.Article, "prepublish-warning-override", actorUserId.Value, $"{target};warnings={string.Join(',', warnings)};reason={reason}");
    }


    private static string NormalizeDraftKey(string? raw, int? articleId)
    {
        string fallback = articleId is > 0 ? $"edit:{articleId.Value}" : "create";
        string value = string.IsNullOrWhiteSpace(raw) ? fallback : raw.Trim();
        return value.Length > MaxDraftKeyLength ? value[..MaxDraftKeyLength] : value;
    }

    private static ArticleRightsRequest NormalizeDraftRights(ArticleRightsRequest? request)
    {
        if (request is null)
        {
            return new ArticleRightsRequest
            {
                Mode = "site",
                Enabled = true,
                LicenseType = "all-rights-reserved",
                CopyrightHolder = null,
                CopyrightYear = null,
                RightsStatement = null,
                AttributionTemplate = null,
                CopyPolicy = "append-attribution",
                MaxExcerptChars = 300,
                AllowCodeCopy = true,
                ShowPublicBadge = true,
                ProofBindingEnabled = true
            };
        }

        return new ArticleRightsRequest
        {
            Mode = string.Equals(request.Mode, "custom", StringComparison.OrdinalIgnoreCase) ? "custom" : "site",
            Enabled = request.Enabled,
            LicenseType = NormalizeDraftRightsToken(request.LicenseType, "all-rights-reserved"),
            CopyrightHolder = TextHelpers.NormalizeNullable(request.CopyrightHolder, 256),
            CopyrightYear = request.CopyrightYear,
            RightsStatement = TextHelpers.NormalizeNullable(request.RightsStatement, 4000),
            AttributionTemplate = TextHelpers.NormalizeNullable(request.AttributionTemplate, 4000),
            CopyPolicy = NormalizeDraftRightsToken(request.CopyPolicy, "append-attribution"),
            MaxExcerptChars = Math.Max(0, request.MaxExcerptChars),
            AllowCodeCopy = request.AllowCodeCopy,
            ShowPublicBadge = request.ShowPublicBadge,
            ProofBindingEnabled = request.ProofBindingEnabled
        };
    }

    private static string NormalizeDraftRightsToken(string? value, string fallback)
    {
        string normalized = AuthoringNormalization.Normalize(value, 48);
        return string.IsNullOrWhiteSpace(normalized) ? fallback : normalized;
    }

    private static string SerializeDraftRights(ArticleRightsRequest rights)
        => JsonSerializer.Serialize(rights, s_draftRightsJsonOptions);

    private static ArticleRightsRequest DeserializeDraftRights(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return NormalizeDraftRights(null);
        }

        try
        {
            return NormalizeDraftRights(JsonSerializer.Deserialize<ArticleRightsRequest>(raw, s_draftRightsJsonOptions));
        }
        catch (JsonException)
        {
            return NormalizeDraftRights(null);
        }
    }

    private static ArticleStatus NormalizeArticleStatus(int? raw)
    {
        return raw is (int)ArticleStatus.Draft
            or (int)ArticleStatus.Scheduled
            or (int)ArticleStatus.Published
            or (int)ArticleStatus.Archived
            or (int)ArticleStatus.Deleted
            ? (ArticleStatus)raw.Value
            : ArticleStatus.Published;
    }

    private static string? NormalizePreviewUrl(string? raw)
    {
        string value = TextHelpers.TrimOrEmpty(raw);
        if (value.Length == 0)
        {
            return null;
        }

        if (value.StartsWith("/", StringComparison.Ordinal)
            && !value.StartsWith("//", StringComparison.Ordinal)
            && !value.Contains('\\', StringComparison.Ordinal))
        {
            return value;
        }

        if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri))
        {
            return null;
        }

        bool acceptedScheme = uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || uri.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase);
        return acceptedScheme && string.IsNullOrEmpty(uri.UserInfo) ? uri.ToString() : null;
    }

    private static string CreatePreviewSourceIdentity(
        string? title,
        string? content,
        string? summary,
        string? coverImageUrl)
    {
        using var payload = new MemoryStream();
        payload.Write("fsusblog.article-preview.v1\0"u8);
        WriteIdentityField(payload, title);
        WriteIdentityField(payload, content);
        WriteIdentityField(payload, summary);
        WriteIdentityField(payload, coverImageUrl);
        return $"preview:sha256:{Convert.ToHexStringLower(SHA256.HashData(payload.ToArray()))}";
    }

    private static void WriteIdentityField(Stream destination, string? value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value ?? string.Empty);
        byte[] length = Encoding.ASCII.GetBytes(bytes.Length.ToString(CultureInfo.InvariantCulture));
        destination.Write(length);
        destination.WriteByte((byte)':');
        destination.Write(bytes);
        destination.WriteByte(0);
    }

}
