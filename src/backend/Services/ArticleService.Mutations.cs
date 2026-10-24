using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Common;
using FsusBlog.Core.Integrity;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;

using Npgsql;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Services;

public partial class ArticleService
{
    private async Task<ArticleRightsNormalizedModel> ResolveUpdateArticleRightsAsync(
        int articleId,
        ArticleWriteRequestCoreModel request,
        ArticleRollbackMetadata? rollback)
    {
        if (rollback.HasValue)
        {
            ArticleRightsSnapshot? historical = await _db.Queryable<ArticleRightsSnapshot>()
                .Where(item => item.ArticleId == articleId
                    && item.ArticleRevisionId == rollback.Value.SourceRevisionId)
                .FirstAsync(Ct)
                .ConfigureAwait(false);
            return historical is not null
                ? ToRightsWriteModel(historical)
                : throw new ArticleWriteValidationException(
                    "article_revision_package_incomplete",
                    "The historical revision has no rights snapshot.");
        }

        ArticleRightsMutationMode mutation = ResolveRightsMutation(request);
        if (mutation == ArticleRightsMutationMode.Replace)
        {
            return request.Rights is not null
                ? NormalizeArticleRights(request.Rights)
                : throw new ArticleWriteValidationException(
                    "article_rights_payload_required",
                    "Rights replacement requires a complete payload.");
        }

        if (mutation == ArticleRightsMutationMode.Reset)
        {
            if (request.Rights is not null)
            {
                throw new ArticleWriteValidationException(
                    "article_rights_reset_payload_conflict",
                    "Rights reset cannot include a replacement payload.");
            }

            return NormalizeArticleRights(null);
        }

        if (mutation != ArticleRightsMutationMode.Preserve)
        {
            throw new ArticleWriteValidationException(
                "article_rights_mutation_invalid",
                "Rights mutation mode is invalid.");
        }

        ArticleRightsPolicy? current = await _db.Queryable<ArticleRightsPolicy>()
            .Where(item => item.ArticleId == articleId)
            .FirstAsync(Ct)
            .ConfigureAwait(false);
        return current is null ? NormalizeArticleRights(null) : ToRightsWriteModel(current);
    }

    private static ArticleRightsMutationMode ResolveRightsMutation(ArticleWriteRequestCoreModel request)
        => request.RightsMutation == ArticleRightsMutationMode.Preserve && request.Rights is not null
            ? ArticleRightsMutationMode.Replace
            : request.RightsMutation;

    private static ArticleRightsNormalizedModel ToRightsWriteModel(ArticleRightsPolicy policy)
        => new(
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

    private static ArticleRightsNormalizedModel ToRightsWriteModel(ArticleRightsSnapshot snapshot)
        => new(
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

    private static SugarParameter NullableStringParameter(string name, string? value)
        => new(name, (object?)value ?? DBNull.Value, System.Data.DbType.String);

    private static SugarParameter NullableInt32Parameter(string name, int? value)
        => new(name, (object?)value ?? DBNull.Value, System.Data.DbType.Int32);

    private async Task<string> RecordArticleMutationOutboxAsync(
        int articleId,
        string eventType,
        ArticleVersionCoordinates version,
        DateTime createdAt,
        ArticleMutationScopeSnapshot? before = null,
        ArticleMutationScopeSnapshot? after = null)
    {
        ArticleMutationOutboxEvent outbox = ArticleMutationOutboxProducer.Create(
            articleId,
            eventType,
            version,
            before,
            after,
            createdAt);
        await _db.Insertable(outbox).ExecuteCommandAsync().ConfigureAwait(false);
        if (IsArticleVaultGroupTransaction)
        {
            (_articleVaultOutboxReferences
                ?? throw new InvalidOperationException("article_vault_outbox_capture_missing"))[articleId] = outbox.EventId;
        }
        return outbox.EventId;
    }

    private async Task RecordArticleMutationOutboxAsync(int articleId, string eventType)
    {
        ArticleVersionCoordinates version = await LoadCurrentVersionCoordinatesAsync(articleId).ConfigureAwait(false);
        ArticleMutationScopeSnapshot scope = await LoadCurrentMutationScopeAsync(articleId).ConfigureAwait(false);
        await RecordArticleMutationOutboxAsync(
                articleId,
                eventType,
                version,
                UtcNow,
                scope,
                scope)
            .ConfigureAwait(false);
    }

    private async Task RecordArticleMutationOutboxAsync(
        int articleId,
        string eventType,
        ArticleVersionCoordinates version)
    {
        ArticleMutationScopeSnapshot scope = await LoadCurrentMutationScopeAsync(articleId).ConfigureAwait(false);
        await RecordArticleMutationOutboxAsync(
                articleId,
                eventType,
                version,
                UtcNow,
                scope,
                scope)
            .ConfigureAwait(false);
    }

    private async Task<ArticleVersionCoordinates> LoadCurrentVersionCoordinatesAsync(int articleId)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT
                revision.id AS revision_id,
                revision.revision_no,
                rights.id AS rights_snapshot_id,
                responsibility.id AS responsibility_snapshot_id,
                responsibility.responsibility_version,
                publication.id AS publication_id,
                publication.publication_no
            FROM article article
            JOIN article_revision revision ON revision.id = article.current_revision_id
            LEFT JOIN article_publication publication
              ON publication.id = article.current_publication_id
            LEFT JOIN LATERAL (
                SELECT snapshot.id
                FROM article_rights_snapshot snapshot
                WHERE snapshot.article_id = article.id
                  AND snapshot.article_revision_id = revision.id
                  AND (publication.rights_snapshot_id IS NULL OR snapshot.id = publication.rights_snapshot_id)
                ORDER BY snapshot.revision_no DESC, snapshot.id DESC
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
            WHERE article.id = @ArticleId;
            """,
            new SugarParameter("@ArticleId", articleId));
        if (!await reader.ReadAsync(Ct).ConfigureAwait(false))
        {
            throw new InvalidOperationException($"Article {articleId} has no current version coordinates.");
        }

        return new ArticleVersionCoordinates(
            reader.ReadInt64("revision_id"),
            reader.ReadInt32("revision_no"),
            reader.ReadInt64("rights_snapshot_id"),
            reader.IsNull("responsibility_snapshot_id") ? null : reader.ReadInt64("responsibility_snapshot_id"),
            reader.IsNull("publication_id") ? null : reader.ReadInt64("publication_id"),
            reader.IsNull("publication_no") ? null : reader.ReadInt32("publication_no"),
            reader.IsNull("responsibility_version") ? null : reader.ReadInt32("responsibility_version"));
    }

    private async Task<ArticleMutationScopeSnapshot> LoadCurrentMutationScopeAsync(int articleId)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT revision.categoryid,
                   revision.tag_ids,
                   article.status,
                   article.isdeleted
            FROM article article
            JOIN article_revision revision ON revision.id = article.current_revision_id
            WHERE article.id = @ArticleId;
            """,
            new SugarParameter("@ArticleId", articleId));
        if (!await reader.ReadAsync(Ct).ConfigureAwait(false))
        {
            throw new InvalidOperationException($"Article {articleId} has no mutation scope.");
        }

        string tagIds = reader.IsNull("tag_ids") ? string.Empty : reader.ReadString("tag_ids");
        int[] tags = tagIds.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(static value => int.Parse(value, System.Globalization.CultureInfo.InvariantCulture))
            .Where(static value => value > 0)
            .Distinct()
            .Order()
            .ToArray();
        return new ArticleMutationScopeSnapshot(
            reader.ReadInt32("categoryid"),
            tags,
            ArticleMutationVisibility.From(
                (ArticleStatus)reader.ReadInt32("status"),
                reader.ReadBoolean("isdeleted")));
    }

    public Task<bool> UpdateAsync(int id, ArticleWriteRequestCoreModel dto, CancellationToken cancellationToken = default)
        => UpdateAsync(id, dto, transitionKind: null, force: false, rollback: null, captureExecution: null, cancellationToken);

    private async Task<bool> UpdateAsync(
        int id,
        ArticleWriteRequestCoreModel dto,
        string? transitionKind,
        bool force,
        ArticleRollbackMetadata? rollback,
        Action<ArticleUpdateExecution>? captureExecution,
        CancellationToken cancellationToken)
    {
        CancellationToken ct = ResolveCancellationToken(cancellationToken);
        ct.ThrowIfCancellationRequested();
        var state = await LoadArticleUpdateStateAsync(id);
        if (state is null)
        {
            return false;
        }

        if (!force && dto.BaseRevisionId != state.CurrentRevisionId)
        {
            throw state.ToConflictException();
        }

        var title = NormalizeText(dto.Title, MaxTitleLength);
        var content = NormalizeText(dto.Content, MaxContentLength);
        var summary = NormalizeText(dto.Summary, MaxSummaryLength);
        var coverImageUrl = NormalizeText(dto.CoverImageUrl, 512);
        var tagIds = NormalizeTagIds(dto.TagIds);
        ArticleSummaryProjectionResult summaryProjection = ArticleSummaryProjection.Resolve(summary, content);
        string safeSummary = summaryProjection.Text;
        DateTime now = UtcNow;
        ArticleStatus requestedStatus = (ArticleStatus)dto.Status;
        ValidateWriteTarget(requestedStatus, dto.ScheduledPublishAt, now);

        ArticleStatus status = requestedStatus;
        DateTime? scheduledPublishAt = status == ArticleStatus.Scheduled ? dto.ScheduledPublishAt : null;
        DateTime? publishedAt = state.PublishedAt ?? (status == ArticleStatus.Published ? now : null);
        bool metadataChanged = state.IsMetadataChanged(
            title,
            safeSummary,
            coverImageUrl,
            dto.CategoryId,
            tagIds,
            status,
            scheduledPublishAt);
        ArticleRightsNormalizedModel rights = await ResolveUpdateArticleRightsAsync(id, dto, rollback).ConfigureAwait(false);
        ArticleRightsPolicy? currentRightsPolicy = await _db.Queryable<ArticleRightsPolicy>()
            .Where(item => item.ArticleId == id)
            .FirstAsync(ct)
            .ConfigureAwait(false);
        ArticleRightsNormalizedModel currentRights = currentRightsPolicy is null
            ? NormalizeArticleRights(null)
            : ToRightsWriteModel(currentRightsPolicy);
        bool candidateNoChange = !force
            && !rollback.HasValue
            && !metadataChanged
            && string.Equals(state.MarkdownContent, content, StringComparison.Ordinal)
            && currentRights == rights;
        bool requiresPublicFence = !candidateNoChange && (ArticlePublication.IsPubliclyVisible(
                state.Status,
                isDeleted: false,
                publishedAt: state.PublishedAt,
                scheduledPublishAt: null,
                utcNow: now)
            || ArticlePublication.IsPubliclyVisible(
                status,
                isDeleted: false,
                publishedAt: publishedAt,
                scheduledPublishAt: scheduledPublishAt,
                utcNow: now));
        bool fenceEstablished = false;
        bool mutationCommitted = false;
        try
        {
            if (requiresPublicFence)
            {
                fenceEstablished = await EstablishArticlePublicMutationFenceAsync(id, ct).ConfigureAwait(false);
            }

            bool articleUpdated = false;
            ArticleVersionCoordinates? noChangeVersion = null;
            ArticleMutationTransactionResult result = await ExecuteArticleMutationTransactionAsync(async () =>
            {
                ArticlePublicationValidationResult validation = await _publicationValidator.ValidateAsync(
                    new ArticlePublicationValidationInput(
                        dto.Title,
                        dto.Content,
                        dto.Summary,
                        dto.CoverImageUrl,
                        dto.CategoryId,
                        dto.TagIds,
                        status,
                        dto.ScheduledPublishAt),
                    now,
                    ct).ConfigureAwait(false);
                validation.ThrowIfWriteBlocked();

                if (candidateNoChange)
                {
                    long lockedRevisionId = await LockCurrentRevisionAsync(id, ct).ConfigureAwait(false);
                    if (lockedRevisionId != state.CurrentRevisionId)
                    {
                        ArticleUpdateState? current = await LoadArticleUpdateStateAsync(id).ConfigureAwait(false);
                        if (current is null)
                        {
                            throw new InvalidOperationException($"Article {id} disappeared while confirming no_change.");
                        }

                        throw current.ToConflictException();
                    }

                    noChangeVersion = await LoadCurrentVersionCoordinatesAsync(id).ConfigureAwait(false);
                    return;
                }

                bool updated = await TryUpdateArticleRowAsync(
                    state,
                    id,
                    title,
                    safeSummary,
                    coverImageUrl,
                    dto.CategoryId,
                    force ? null : dto.BaseRevisionId,
                    metadataChanged,
                    now);
                if (!updated)
                {
                    ArticleUpdateState? current = await LoadArticleUpdateStateAsync(id);
                    if (current is not null)
                    {
                        throw current.ToConflictException();
                    }

                    return;
                }

                articleUpdated = true;
                await UpsertArticleBodyAsync(id, content, now);
                await ApplyArticleTagsAsync(id, tagIds);
                ArticleRevisionCoordinates revision = await SaveArticleRevisionAsync(
                    id,
                    title,
                    content,
                    safeSummary,
                    coverImageUrl,
                    dto.CategoryId,
                    tagIds,
                    ArticleSummaryProjection.AttachGenerationVersion("article updated", summaryProjection),
                    now,
                    rollback);
                ArticleAssetReferenceWrite[] assetReferenceWrites = await new ArticleAssetReferenceWriteBoundary(_db)
                    .ResolveAsync(content, coverImageUrl, ct)
                    .ConfigureAwait(false);
                var assetReferences = new ArticleAssetReferenceStore(_db);
                await assetReferences.ReplaceCurrentArticleAsync(id, assetReferenceWrites, ct).ConfigureAwait(false);
                await assetReferences.ReplaceRevisionAsync(revision.Id, id, assetReferenceWrites, ct).ConfigureAwait(false);
                long rightsSnapshotId = await SaveArticleRightsAsync(
                    id,
                    revision,
                    title,
                    content,
                    safeSummary,
                    coverImageUrl,
                    dto.CategoryId,
                    tagIds,
                    status,
                    publishedAt,
                    scheduledPublishAt,
                    rights,
                    now);
                long? responsibilitySnapshotId = rollback.HasValue
                    ? await CloneResponsibilitySnapshotAsync(id, revision, rollback.Value.SourceRevisionId).ConfigureAwait(false)
                    : await LoadResponsibilitySnapshotIdAsync(revision.Id);
                int? responsibilityVersion = await LoadResponsibilityVersionAsync(responsibilitySnapshotId);
                ArticleVersionCoordinates version = await ArticlePublicationTransitionWriter.ApplyAsync(
                    _db,
                    new ArticlePublicationTransitionRequest(
                        id,
                        new ArticleVersionCoordinates(
                            revision.Id,
                            revision.RevisionNo,
                            rightsSnapshotId,
                            responsibilitySnapshotId,
                            null,
                            null,
                            responsibilityVersion),
                        status,
                        scheduledPublishAt,
                        now,
                        transitionKind ?? TransitionKindFor(status),
                        transitionKind == ArticlePublicationTransitionKinds.Rollback
                            ? ArticleStatusTransitionOperation.Rollback
                            : ArticleStatusTransitionOperation.Update));
                captureExecution?.Invoke(new ArticleUpdateExecution(version, ArticleMutationOutcome.Applied));
                await RecordArticleMutationOutboxAsync(
                    id,
                    ArticleMutationEventTypes.Updated,
                    version,
                    now,
                    new ArticleMutationScopeSnapshot(
                        state.CategoryId,
                        state.TagIds,
                        ArticleMutationVisibility.From(state.Status)),
                    new ArticleMutationScopeSnapshot(
                        dto.CategoryId,
                        tagIds,
                        ArticleMutationVisibility.From(status)));
            });

            mutationCommitted = result.IsSuccess && articleUpdated;
            ct.ThrowIfCancellationRequested();
            if (result.IsSuccess && noChangeVersion.HasValue)
            {
                ArticleVersionCoordinates currentVersion = noChangeVersion.GetValueOrDefault();
                captureExecution?.Invoke(new ArticleUpdateExecution(
                    currentVersion,
                    ArticleMutationOutcome.NoChange));
                return true;
            }
            if (mutationCommitted && IsArticleVaultGroupTransaction)
            {
                EnqueueArticleVaultPostCommitAction(id, async () =>
                {
                    string mutationId = await InvalidateCache(id).ConfigureAwait(false);
                    await InvalidatePublicAotAsync(
                        id,
                        MergeIds([state.CategoryId], [dto.CategoryId]),
                        MergeIds(state.TagIds, tagIds),
                        "update",
                        mutationId).ConfigureAwait(false);
                    ArticleListItemResponse? realtimePreview = await LoadRealtimePreviewAsync(id)
                        .ConfigureAwait(false);
                    await _mutationSideEffects.AfterUpdatedAsync(id, realtimePreview).ConfigureAwait(false);
                });
                return true;
            }
            if (mutationCommitted)
            {
                string mutationId = await InvalidateCache(id);
                ct.ThrowIfCancellationRequested();
                await InvalidatePublicAotAsync(
                    id,
                    MergeIds([state.CategoryId], [dto.CategoryId]),
                    MergeIds(state.TagIds, tagIds),
                    "update",
                    mutationId);
                ct.ThrowIfCancellationRequested();
                ArticleListItemResponse? realtimePreview = await LoadRealtimePreviewAsync(id);
                ct.ThrowIfCancellationRequested();
                await _mutationSideEffects.AfterUpdatedAsync(id, realtimePreview);
                return true;
            }
            if (result.ErrorException is ArticleWriteValidationException validationException)
            {
                throw validationException;
            }
            if (result.ErrorException is ArticleRevisionConflictException revisionConflictException)
            {
                throw revisionConflictException;
            }
            if (result.ErrorException is not null)
            {
                throw result.ErrorException;
            }
            return false;
        }
        finally
        {
            if (fenceEstablished && !mutationCommitted && !IsArticleVaultGroupTransaction)
            {
                await RecoverAbortedPublicMutationFenceAsync(id, "article-update-fence-aborted").ConfigureAwait(false);
            }
        }
    }

    private async Task<ArticleUpdateState?> LoadArticleUpdateStateAsync(int articleId)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT a.title,
                   a.summary,
                   a.coverimageurl,
                   a.categoryid,
                   a.xmin::text AS row_version,
                   a.status,
                   a.scheduled_publish_at,
                   a.published_at,
                   a.current_revision_id,
                   revision.revision_no,
                   revision.created_at AS revision_updated_at,
                   COALESCE(content_block.markdown_content, revision.markdown_content) AS markdown_content,
                   COALESCE(
                       array_agg(at.tagid ORDER BY at.tagid)
                           FILTER (WHERE at.tagid IS NOT NULL),
                       ARRAY[]::integer[]
                   ) AS tag_ids
            FROM article a
            JOIN article_revision revision ON revision.id = a.current_revision_id
            LEFT JOIN article_revision_content_block content_block ON content_block.id = revision.content_block_id
            LEFT JOIN article_tag at ON at.articleid = a.id
            WHERE a.id = @ArticleId
              AND a.isdeleted = false
            GROUP BY a.id, a.title, a.summary, a.coverimageurl, a.categoryid, a.xmin,
                     a.status, a.scheduled_publish_at, a.published_at,
                     a.current_revision_id, revision.revision_no, revision.created_at,
                     content_block.markdown_content, revision.markdown_content;
            """,
            new SugarParameter("@ArticleId", articleId));
        if (!await reader.ReadAsync(Ct))
        {
            return null;
        }

        int categoryId = reader.ReadInt32("categoryid");
        string rowVersion = reader.ReadString("row_version");
        var status = (ArticleStatus)reader.ReadInt32("status");
        DateTime? publishedAt = reader.IsNull("published_at")
            ? null
            : NormalizeArticleListTimestampUtc(reader.ReadDateTime("published_at"));
        int[] tags = reader.ReadFieldValue<int[]>("tag_ids");
        return new ArticleUpdateState(
            reader.ReadString("title"),
            reader.IsNull("summary") ? null : reader.ReadString("summary"),
            reader.IsNull("coverimageurl") ? null : reader.ReadString("coverimageurl"),
            categoryId,
            tags.ToList(),
            rowVersion,
            status,
            reader.IsNull("scheduled_publish_at")
                ? null
                : NormalizeArticleListTimestampUtc(reader.ReadDateTime("scheduled_publish_at")),
            publishedAt,
            reader.ReadString("markdown_content"),
            reader.ReadInt64("current_revision_id"),
            reader.ReadInt32("revision_no"),
            NormalizeArticleListTimestampUtc(reader.ReadDateTime("revision_updated_at")));
    }

    private Task UpsertArticleBodyAsync(int articleId, string markdownContent, DateTime updatedAt)
        => _db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_body (article_id, markdown_content, updated_at)
            VALUES (@ArticleId, @MarkdownContent, @UpdatedAt)
            ON CONFLICT (article_id)
            DO UPDATE SET
                markdown_content = EXCLUDED.markdown_content,
                updated_at = EXCLUDED.updated_at
            WHERE article_body.markdown_content IS DISTINCT FROM EXCLUDED.markdown_content;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@MarkdownContent", markdownContent),
            new SugarParameter("@UpdatedAt", updatedAt));

    private async Task<long> LockCurrentRevisionAsync(int articleId, CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT current_revision_id
            FROM article
            WHERE id = @ArticleId
              AND isdeleted = false
            FOR UPDATE;
            """,
            new SugarParameter("@ArticleId", articleId));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return 0;
        }

        return reader.ReadInt64("current_revision_id");
    }

    private async Task<bool> TryUpdateArticleRowAsync(
        ArticleUpdateState state,
        int articleId,
        string title,
        string summary,
        string? coverImageUrl,
        int categoryId,
        long? baseRevisionId,
        bool metadataChanged,
        DateTime updatedAt)
    {
        int affectedRows = await _db.Ado.ExecuteCommandAsync(
            """
            UPDATE article
            SET title = @Title,
                summary = @Summary,
                coverimageurl = @CoverImageUrl,
                categoryid = @CategoryId,
                metadata_updated_at = CASE
                    WHEN @MetadataChanged THEN @UpdatedAt
                    ELSE metadata_updated_at
                END
            WHERE id = @ArticleId
              AND isdeleted = false
              AND (@BaseRevisionId = 0 OR current_revision_id = @BaseRevisionId)
              AND xmin::text = @RowVersion;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@RowVersion", state.RowVersion),
            new SugarParameter("@BaseRevisionId", baseRevisionId.GetValueOrDefault()),
            new SugarParameter("@Title", title),
            new SugarParameter("@Summary", summary),
            new SugarParameter("@CoverImageUrl", (object?)coverImageUrl ?? DBNull.Value),
            new SugarParameter("@CategoryId", categoryId),
            new SugarParameter("@MetadataChanged", metadataChanged),
            new SugarParameter("@UpdatedAt", updatedAt));
        return affectedRows > 0;
    }

    private async Task ApplyArticleTagsAsync(int articleId, List<int> tagIds)
    {
        var parameters = new List<SugarParameter>(tagIds.Count + 1)
        {
            new("@ArticleId", articleId)
        };
        string desiredTagsSql;
        if (tagIds.Count == 0)
        {
            desiredTagsSql = "SELECT NULL::integer AS tagid WHERE false";
        }
        else
        {
            var values = new string[tagIds.Count];
            for (int i = 0; i < tagIds.Count; i++)
            {
                string parameterName = string.Concat("@TagId", i.ToString(System.Globalization.CultureInfo.InvariantCulture));
                values[i] = string.Concat("(", parameterName, ")");
                parameters.Add(new SugarParameter(parameterName, tagIds[i]));
            }

            desiredTagsSql = string.Concat("VALUES ", string.Join(", ", values));
        }

        await _db.Ado.ExecuteCommandAsync(
            $"""
            WITH desired_tags AS (
                SELECT DISTINCT tagid
                FROM ({desiredTagsSql}) AS input(tagid)
            ),
            deleted_tags AS (
                DELETE FROM article_tag existing
                WHERE existing.articleid = @ArticleId
                  AND NOT EXISTS (
                      SELECT 1
                      FROM desired_tags desired
                      WHERE desired.tagid = existing.tagid
                  )
                RETURNING existing.tagid
            )
            INSERT INTO article_tag (articleid, tagid)
            SELECT @ArticleId, desired.tagid
            FROM desired_tags desired
            ON CONFLICT (articleid, tagid) DO NOTHING;
            """,
            parameters);
    }

    private sealed record ArticleUpdateState(
        string Title,
        string? Summary,
        string? CoverImageUrl,
        int CategoryId,
        List<int> TagIds,
        string RowVersion,
        ArticleStatus Status,
        DateTime? ScheduledPublishAt,
        DateTime? PublishedAt,
        string MarkdownContent,
        long CurrentRevisionId,
        int RevisionNo,
        DateTime UpdatedAtUtc)
    {
        public bool IsMetadataChanged(
            string title,
            string? summary,
            string? coverImageUrl,
            int categoryId,
            IReadOnlyList<int> tagIds,
            ArticleStatus status,
            DateTime? scheduledPublishAt)
            => !string.Equals(Title, title, StringComparison.Ordinal)
                || !string.Equals(Summary, summary, StringComparison.Ordinal)
                || !string.Equals(CoverImageUrl, coverImageUrl, StringComparison.Ordinal)
                || CategoryId != categoryId
                || !TagIds.SequenceEqual(tagIds)
                || Status != status
                || ScheduledPublishAt != scheduledPublishAt;

        public ArticleRevisionConflictException ToConflictException()
            => new(CurrentRevisionId, RevisionNo, (int)Status, UpdatedAtUtc);
    }

    private static string TransitionKindFor(ArticleStatus status)
        => status switch
        {
            ArticleStatus.Draft => ArticlePublicationTransitionKinds.SaveDraft,
            ArticleStatus.Scheduled => ArticlePublicationTransitionKinds.Schedule,
            ArticleStatus.Archived => ArticlePublicationTransitionKinds.Archive,
            _ => ArticlePublicationTransitionKinds.ImmediatePublish
        };

    private static void ValidateWriteTarget(
        ArticleStatus status,
        DateTime? scheduledPublishAt,
        DateTime utcNow)
    {
        ArticleStatusTransitionValidation? validation = ArticleStatusTransitionPolicy.ValidateTarget(
            (int)status,
            scheduledPublishAt,
            utcNow);
        if (validation.HasValue)
        {
            throw new ArticleStatusTransitionValidationException(validation.Value);
        }
    }

    private async Task<long?> LoadResponsibilitySnapshotIdAsync(long revisionId)
    {
        long value = await _db.Queryable<ArticleResponsibilitySnapshot>()
            .Where(snapshot => snapshot.ArticleRevisionId == revisionId)
            .OrderBy(snapshot => snapshot.ResponsibilityVersion, OrderByType.Desc)
            .Select(snapshot => snapshot.Id)
            .FirstAsync(Ct);
        return value > 0 ? value : null;
    }

    private async Task<int?> LoadResponsibilityVersionAsync(long? snapshotId)
    {
        if (!snapshotId.HasValue)
        {
            return null;
        }

        int value = await _db.Queryable<ArticleResponsibilitySnapshot>()
            .Where(snapshot => snapshot.Id == snapshotId.Value)
            .Select(snapshot => snapshot.ResponsibilityVersion)
            .FirstAsync(Ct);
        return value > 0 ? value : null;
    }

    private async Task<long> CloneResponsibilitySnapshotAsync(
        int articleId,
        ArticleRevisionCoordinates targetRevision,
        long sourceRevisionId)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            INSERT INTO article_responsibility_snapshot (
                article_id,
                article_revision_id,
                revision_no,
                responsibility_version,
                previous_snapshot_id,
                inherit_site_author,
                authors_json,
                reviewer_json,
                sources_json,
                update_summary,
                update_reason,
                effective_at,
                conclusion_impact,
                methodology,
                applicability,
                limitations,
                responsible_person_confirmed,
                created_at)
            SELECT
                @ArticleId,
                @TargetRevisionId,
                @TargetRevisionNo,
                1,
                NULL,
                inherit_site_author,
                authors_json,
                reviewer_json,
                sources_json,
                update_summary,
                update_reason,
                effective_at,
                conclusion_impact,
                methodology,
                applicability,
                limitations,
                responsible_person_confirmed,
                @CreatedAt
            FROM article_responsibility_snapshot
            WHERE article_id = @ArticleId
              AND article_revision_id = @SourceRevisionId
            ORDER BY responsibility_version DESC
            LIMIT 1
            RETURNING id;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@TargetRevisionId", targetRevision.Id),
            new SugarParameter("@TargetRevisionNo", targetRevision.RevisionNo),
            new SugarParameter("@SourceRevisionId", sourceRevisionId),
            new SugarParameter("@CreatedAt", UtcNow));
        if (await reader.ReadAsync(Ct).ConfigureAwait(false))
        {
            return reader.ReadInt64("id");
        }

        throw new ArticleWriteValidationException(
            "article_revision_package_incomplete",
            "The historical revision has no responsibility snapshot.");
    }

    private sealed record ArticleMutationState(
        List<int> CategoryIds,
        List<int> TagIds,
        string RowVersion,
        ArticleStatus Status,
        bool IsDeleted);
}
