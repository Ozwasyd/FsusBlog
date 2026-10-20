using System.Data.Common;
using System.Text.Json;

using FsusBlog.Server.Services.Articles;
using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Services;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Integrity;

public sealed record ArticleUpdateDisclosure(
    string Summary,
    string Reason,
    DateTime? EffectiveAt,
    string ConclusionImpact);

public sealed record ArticleVerificationSummary(
    string Url,
    int RevisionNo,
    string? ContentHash,
    string ProofStatus);

public sealed record ArticleResponsibilityManifestResponse(
    int SchemaVersion,
    int ArticleId,
    int RevisionNo,
    string? ResponsibilitySnapshotId,
    int ResponsibilityVersion,
    bool InheritsSiteAuthor,
    bool LegacyFallback,
    IReadOnlyList<ArticleResponsiblePerson> Authors,
    ArticleResponsiblePerson? Reviewer,
    IReadOnlyList<ArticleEvidenceSource> Sources,
    ArticleUpdateDisclosure? Update,
    string? Methodology,
    string? Applicability,
    string? Limitations,
    bool ResponsiblePersonConfirmed,
    ArticleVerificationSummary Verification);

public interface IArticleResponsibilityManifestService
{
    Task<IntegrityManifestResult> GetCurrentAsync(int articleId, CancellationToken cancellationToken = default);
    Task<IntegrityManifestResult> GetRevisionAsync(int articleId, int revisionNo, CancellationToken cancellationToken = default);
}

public sealed class ArticleResponsibilityManifestService(
    ISqlSugarClient db,
    IAotSeoConfigSnapshot seoConfigSnapshot) : IArticleResponsibilityManifestService
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    public Task<IntegrityManifestResult> GetCurrentAsync(int articleId, CancellationToken cancellationToken = default)
        => BuildAsync(articleId, null, cancellationToken);

    public Task<IntegrityManifestResult> GetRevisionAsync(int articleId, int revisionNo, CancellationToken cancellationToken = default)
        => BuildAsync(articleId, revisionNo, cancellationToken);

    private async Task<IntegrityManifestResult> BuildAsync(int articleId, int? requestedRevisionNo, CancellationToken cancellationToken)
    {
        if (articleId <= 0 || requestedRevisionNo is <= 0)
        {
            return NotFound();
        }

        DateTime utcNow = DateTime.UtcNow;
        bool publiclyVisible = await db.Queryable<Article>()
            .Where(it => it.Id == articleId
                && !it.IsDeleted
                && it.Status == ArticleStatus.Published
                && (it.CurrentPublicationId != null || it.CurrentRevisionId == null)
                && (it.PublishedAt == null || it.PublishedAt <= utcNow)
                && (it.ScheduledPublishAt == null || it.ScheduledPublishAt <= utcNow))
            .AnyAsync(cancellationToken);
        if (!publiclyVisible)
        {
            return NotFound();
        }

        long? currentRevisionId = requestedRevisionNo.HasValue
            ? null
            : await db.Queryable<Article>()
                .Where(article => article.Id == articleId)
                .Select(article => article.CurrentRevisionId)
                .FirstAsync(cancellationToken);
        if (!requestedRevisionNo.HasValue && !currentRevisionId.HasValue)
        {
            PublicAotSeoSnapshot legacySite = await seoConfigSnapshot.GetAsync(cancellationToken);
            return new IntegrityManifestResult(
                StatusCodes.Status200OK,
                IntegrityVerificationCacheHeaders.PublicManifest,
                BuildPreRevisionLegacyFallback(articleId, legacySite.SiteAuthor));
        }

        ArticlePublicationRecord? currentPublication = requestedRevisionNo.HasValue
            ? null
            : await db.Queryable<Article>()
                .InnerJoin<ArticlePublicationRecord>((article, publication) => article.CurrentPublicationId == publication.Id)
                .Where(article => article.Id == articleId)
                .Select((article, publication) => publication)
                .FirstAsync(cancellationToken);
        ArticleRevision? revision = currentPublication is not null
            ? await db.Queryable<ArticleRevision>()
                .Where(it => it.Id == currentPublication.ArticleRevisionId && it.ArticleId == articleId)
                .FirstAsync(cancellationToken)
            : await db.Queryable<ArticleRevision>()
                .Where(it => it.ArticleId == articleId)
                .WhereIF(requestedRevisionNo.HasValue, it => it.RevisionNo == requestedRevisionNo)
                .OrderBy(it => it.RevisionNo, OrderByType.Desc)
                .FirstAsync(cancellationToken);
        if (revision is null)
        {
            return NotFound();
        }

        ArticlePublicationRecord? resolvedPublication = currentPublication;
        if (requestedRevisionNo.HasValue)
        {
            resolvedPublication = await db.Queryable<ArticlePublicationRecord>()
                .Where(it => it.ArticleId == articleId && it.ArticleRevisionId == revision.Id)
                .OrderBy(it => it.PublicationNo, OrderByType.Desc)
                .FirstAsync(cancellationToken);
            if (resolvedPublication is null)
            {
                return NotFound();
            }
        }

        long? currentResponsibilitySnapshotId = resolvedPublication?.ResponsibilitySnapshotId;
        ArticleResponsibilitySnapshot? snapshot = await db.Queryable<ArticleResponsibilitySnapshot>()
            .Where(it => it.ArticleId == articleId && it.ArticleRevisionId == revision.Id)
            .WhereIF(currentResponsibilitySnapshotId.HasValue, it => it.Id == currentResponsibilitySnapshotId!.Value)
            .OrderBy(it => it.ResponsibilityVersion, OrderByType.Desc)
            .FirstAsync(cancellationToken);
        if (currentResponsibilitySnapshotId.HasValue && snapshot is null)
        {
            return NotFound();
        }
        PublicAotSeoSnapshot site = await seoConfigSnapshot.GetAsync(cancellationToken);

        bool legacyFallback = snapshot is null;
        bool inheritsSiteAuthor = snapshot?.InheritSiteAuthor ?? true;
        IReadOnlyList<ArticleResponsiblePerson> authors = SanitizePeople(
            DeserializeList<ArticleResponsiblePerson>(snapshot?.AuthorsJson));
        if (authors.Count == 0 && inheritsSiteAuthor && !string.IsNullOrWhiteSpace(site.SiteAuthor))
        {
            authors = BuildSiteAuthorFallback(site.SiteAuthor);
        }

        ArticleResponsiblePerson? reviewer = SanitizePerson(
            Deserialize<ArticleResponsiblePerson>(snapshot?.ReviewerJson));
        IReadOnlyList<ArticleEvidenceSource> sources = SanitizeSources(
            DeserializeList<ArticleEvidenceSource>(snapshot?.SourcesJson));
        ArticleUpdateDisclosure? update = BuildUpdate(snapshot);

        (string? contentHash, string proofStatus) = await LoadVerificationAsync(revision.Id, cancellationToken);
        var response = new ArticleResponsibilityManifestResponse(
            1,
            articleId,
            revision.RevisionNo,
            snapshot?.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
            snapshot?.ResponsibilityVersion ?? 0,
            inheritsSiteAuthor,
            legacyFallback,
            authors,
            reviewer,
            sources,
            update,
            NullIfWhiteSpace(snapshot?.Methodology),
            NullIfWhiteSpace(snapshot?.Applicability),
            NullIfWhiteSpace(snapshot?.Limitations),
            snapshot?.ResponsiblePersonConfirmed ?? false,
            new ArticleVerificationSummary(
                $"/integrity/article/{articleId}/revisions/{revision.RevisionNo}",
                revision.RevisionNo,
                contentHash,
                proofStatus));

        return new IntegrityManifestResult(
            StatusCodes.Status200OK,
            IntegrityVerificationCacheHeaders.PublicManifest,
            response);
    }

    private async Task<(string? ContentHash, string Status)> LoadVerificationAsync(long revisionId, CancellationToken cancellationToken)
    {
        ArticlePublishProof? proof = await db.Queryable<ArticlePublishProof>()
            .Where(it => it.ArticleRevisionId == revisionId)
            .OrderBy(it => it.CreatedAt, OrderByType.Desc)
            .FirstAsync(cancellationToken);
        if (proof is null)
        {
            return (null, "unavailable");
        }

        return (NullIfWhiteSpace(proof.CanonicalHash), NormalizeProofStatus(proof.ProofStatus));
    }

    internal static string NormalizeProofStatus(string? value)
        => value?.Trim().ToLowerInvariant() switch
        {
            "ready" => "ready",
            "failed" => "failed",
            _ => "unavailable"
        };

    internal static IReadOnlyList<ArticleResponsiblePerson> BuildSiteAuthorFallback(string? siteAuthor)
        => string.IsNullOrWhiteSpace(siteAuthor)
            ? []
            : [new ArticleResponsiblePerson(siteAuthor.Trim(), null)];

    internal static ArticleResponsibilityManifestResponse BuildPreRevisionLegacyFallback(
        int articleId,
        string? siteAuthor)
        => new(
            1,
            articleId,
            0,
            null,
            0,
            true,
            true,
            BuildSiteAuthorFallback(siteAuthor),
            null,
            [],
            null,
            null,
            null,
            null,
            false,
            new ArticleVerificationSummary(
                $"/integrity/article/{articleId}",
                0,
                null,
                "unavailable"));

    private static ArticleUpdateDisclosure? BuildUpdate(ArticleResponsibilitySnapshot? snapshot)
    {
        string? summary = NullIfWhiteSpace(snapshot?.UpdateSummary);
        string? reason = NullIfWhiteSpace(snapshot?.UpdateReason);
        if (summary is null && reason is null && snapshot?.EffectiveAt is null)
        {
            return null;
        }

        return new ArticleUpdateDisclosure(
            summary ?? "未提供变更摘要",
            reason ?? "未提供变更原因",
            snapshot?.EffectiveAt,
            NormalizeConclusionImpact(snapshot?.ConclusionImpact));
    }

    private static string NormalizeConclusionImpact(string? value)
        => value?.Trim().ToLowerInvariant() switch
        {
            "none" => "none",
            "clarified" => "clarified",
            "changed" => "changed",
            _ => "unknown"
        };

    private static IReadOnlyList<ArticleResponsiblePerson> SanitizePeople(IEnumerable<ArticleResponsiblePerson> people)
        => people.Select(SanitizePerson).Where(static person => person is not null).Cast<ArticleResponsiblePerson>().Take(8).ToArray();

    private static ArticleResponsiblePerson? SanitizePerson(ArticleResponsiblePerson? person)
    {
        string? name = NullIfWhiteSpace(person?.Name);
        return name is null ? null : new ArticleResponsiblePerson(name, ArticleResponsibilityGovernance.PublicUrl(person?.ProfileUrl));
    }

    private static IReadOnlyList<ArticleEvidenceSource> SanitizeSources(IEnumerable<ArticleEvidenceSource> sources)
        => sources
            .Where(static source => source.IsPublic)
            .Select(static source => new ArticleEvidenceSource(
                NullIfWhiteSpace(source.Title) ?? string.Empty,
                ArticleResponsibilityGovernance.PublicUrl(source.Url) ?? string.Empty,
                NullIfWhiteSpace(source.SourceType) ?? "other",
                source.AccessedOn,
                NullIfWhiteSpace(source.Version),
                NullIfWhiteSpace(source.CitationNote)))
            .Where(static source => source.Title.Length > 0 && source.Url.Length > 0)
            .Take(100)
            .ToArray();

    private static T? Deserialize<T>(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
            return default;
        try
        {
            return JsonSerializer.Deserialize<T>(json, s_jsonOptions);
        }
        catch (JsonException)
        {
            return default;
        }
    }

    private static IReadOnlyList<T> DeserializeList<T>(string? json)
        => Deserialize<List<T>>(json) ?? [];

    private static string? NullIfWhiteSpace(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static IntegrityManifestResult NotFound()
        => new(
            StatusCodes.Status404NotFound,
            IntegrityVerificationCacheHeaders.NoStore,
            IntegrityPublicErrorResponse.NotFound("article_responsibility_not_found"));
}

public sealed record ArticleResponsibilitySaveResponse(
    bool Saved,
    bool VersionConflict,
    int ArticleId,
    string ArticleRevisionId,
    int RevisionNo,
    string? ResponsibilitySnapshotId,
    int ResponsibilityVersion,
    string? PreviousSnapshotId,
    string? ArticlePublicationId,
    int? PublicationNo,
    IReadOnlyList<PrepublishIssue> Issues);

public sealed record ArticleResponsibilityVersionResponse(
    string Id,
    int ArticleId,
    string ArticleRevisionId,
    int RevisionNo,
    int ResponsibilityVersion,
    string? PreviousSnapshotId,
    bool InheritSiteAuthor,
    IReadOnlyList<ArticleResponsiblePerson> Authors,
    ArticleResponsiblePerson? Reviewer,
    IReadOnlyList<ArticleEvidenceSource> Sources,
    string? UpdateSummary,
    string? UpdateReason,
    DateTime? EffectiveAt,
    string? ConclusionImpact,
    string? Methodology,
    string? Applicability,
    string? Limitations,
    bool ResponsiblePersonConfirmed,
    DateTime CreatedAt);

public interface IArticleResponsibilityAuthoringService
{
    Task<ArticleResponsibilitySaveResponse?> SaveAsync(
        int articleId,
        long articleRevisionId,
        ArticleResponsibilityDraft draft,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<ArticleResponsibilityVersionResponse>?> GetHistoryAsync(
        int articleId,
        long articleRevisionId,
        CancellationToken cancellationToken = default);
}

public sealed class ArticleResponsibilityAuthoringService(
    ISqlSugarClient db,
    TimeProvider? timeProvider = null) : IArticleResponsibilityAuthoringService
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);
    private const string ResponsibilityUpdatedEventType = "responsibility-updated";
    private const string ResponsibilityUpdatedTransitionKind = "responsibility-updated";
    private DateTime UtcNow => (timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime;

    public async Task<ArticleResponsibilitySaveResponse?> SaveAsync(
        int articleId,
        long articleRevisionId,
        ArticleResponsibilityDraft draft,
        CancellationToken cancellationToken = default)
    {
        IReadOnlyList<PrepublishIssue> issues = ArticleResponsibilityGovernance.Evaluate(draft);
        if (issues.Any(static issue => string.Equals(issue.Severity, "error", StringComparison.OrdinalIgnoreCase)))
        {
            ArticleRevision? rejectedRevision = await db.Queryable<ArticleRevision>()
                .Where(it => it.ArticleId == articleId && it.Id == articleRevisionId)
                .FirstAsync(cancellationToken);
            return rejectedRevision is null
                ? null
                : new ArticleResponsibilitySaveResponse(
                    false,
                    false,
                    articleId,
                    articleRevisionId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    rejectedRevision.RevisionNo,
                    null,
                    draft.ExpectedVersion,
                    null,
                    null,
                    null,
                    issues);
        }

        ArticleResponsibilitySaveResponse? response = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db, cancellationToken).ConfigureAwait(false);
            ResponsibilityWriteCoordinates? coordinates = await LockCoordinatesAsync(articleId, articleRevisionId, cancellationToken);
            if (coordinates is null)
            {
                return;
            }

            ArticleResponsibilitySnapshot? previous = await db.Queryable<ArticleResponsibilitySnapshot>()
                .Where(it => it.ArticleId == articleId && it.ArticleRevisionId == articleRevisionId)
                .OrderBy(it => it.ResponsibilityVersion, OrderByType.Desc)
                .FirstAsync(cancellationToken);
            int currentVersion = previous?.ResponsibilityVersion ?? 0;
            if (draft.ExpectedVersion != currentVersion)
            {
                response = new ArticleResponsibilitySaveResponse(
                    false,
                    true,
                    articleId,
                    articleRevisionId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    coordinates.RevisionNo,
                    previous?.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    currentVersion,
                    previous?.PreviousSnapshotId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    coordinates.CurrentPublicationId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    coordinates.CurrentPublicationNo,
                    issues);
                return;
            }

            int nextVersion = checked(currentVersion + 1);
            DateTime createdAt = UtcNow;
            ArticleResponsibilitySnapshot built = ArticleResponsibilitySnapshotBuilder.Build(
                articleId,
                articleRevisionId,
                coordinates.RevisionNo,
                nextVersion,
                previous?.Id,
                draft,
                createdAt);
            long snapshotId = await InsertSnapshotAsync(
                articleId,
                articleRevisionId,
                coordinates.RevisionNo,
                nextVersion,
                previous?.Id,
                draft,
                built.AuthorsJson,
                built.ReviewerJson,
                built.SourcesJson,
                createdAt,
                cancellationToken);

            (long? publicationId, int? publicationNo) = await CreatePublicationReferenceIfCurrentAsync(
                coordinates,
                snapshotId,
                createdAt,
                cancellationToken);
            await InsertOutboxAsync(
                articleId,
                articleRevisionId,
                coordinates.RevisionNo,
                snapshotId,
                nextVersion,
                previous?.Id,
                publicationId,
                publicationNo,
                coordinates.RightsSnapshotId,
                createdAt,
                cancellationToken);

            response = new ArticleResponsibilitySaveResponse(
                true,
                false,
                articleId,
                articleRevisionId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                coordinates.RevisionNo,
                snapshotId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                nextVersion,
                previous?.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                publicationId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                publicationNo,
                issues);
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Responsibility snapshot and mutation outbox were not saved atomically.", transaction.ErrorException);
        }

        return response;
    }

    public async Task<IReadOnlyList<ArticleResponsibilityVersionResponse>?> GetHistoryAsync(
        int articleId,
        long articleRevisionId,
        CancellationToken cancellationToken = default)
    {
        bool revisionExists = await db.Queryable<ArticleRevision>()
            .Where(it => it.ArticleId == articleId && it.Id == articleRevisionId)
            .AnyAsync(cancellationToken);
        if (!revisionExists)
        {
            return null;
        }

        List<ArticleResponsibilitySnapshot> snapshots = await db.Queryable<ArticleResponsibilitySnapshot>()
            .Where(it => it.ArticleId == articleId && it.ArticleRevisionId == articleRevisionId)
            .OrderBy(it => it.ResponsibilityVersion, OrderByType.Desc)
            .ToListAsync(cancellationToken);
        return snapshots.Select(ToVersionResponse).ToArray();
    }

    private async Task<ResponsibilityWriteCoordinates?> LockCoordinatesAsync(
        int articleId,
        long articleRevisionId,
        CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT
                revision.revision_no,
                article.status,
                publication.id,
                publication.publication_no,
                publication.article_revision_id,
                publication.rights_snapshot_id,
                publication.published_at
            FROM article_revision revision
            JOIN article article ON article.id = revision.article_id AND article.isdeleted = false
            LEFT JOIN article_publication publication ON publication.id = article.current_publication_id
            WHERE revision.article_id = @ArticleId
              AND revision.id = @ArticleRevisionId
            FOR UPDATE OF article, revision;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@ArticleRevisionId", articleRevisionId));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new ResponsibilityWriteCoordinates(
            articleId,
            articleRevisionId,
            reader.GetInt32(0),
            (ArticleStatus)reader.GetInt32(1),
            reader.IsDBNull(2) ? null : reader.GetInt64(2),
            reader.IsDBNull(3) ? null : reader.GetInt32(3),
            reader.IsDBNull(4) ? null : reader.GetInt64(4),
            reader.IsDBNull(5) ? null : reader.GetInt64(5),
            reader.IsDBNull(6)
                ? null
                : DateTime.SpecifyKind(reader.GetDateTime(6), DateTimeKind.Utc));
    }

    private async Task<long> InsertSnapshotAsync(
        int articleId,
        long articleRevisionId,
        int revisionNo,
        int responsibilityVersion,
        long? previousSnapshotId,
        ArticleResponsibilityDraft draft,
        string authorsJson,
        string? reviewerJson,
        string sourcesJson,
        DateTime createdAt,
        CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            INSERT INTO article_responsibility_snapshot (
                article_id, article_revision_id, revision_no, responsibility_version, previous_snapshot_id,
                inherit_site_author, authors_json, reviewer_json, sources_json, update_summary, update_reason,
                effective_at, conclusion_impact, methodology, applicability, limitations,
                responsible_person_confirmed, created_at)
            VALUES (
                @ArticleId, @ArticleRevisionId, @RevisionNo, @ResponsibilityVersion, CAST(@PreviousSnapshotId AS bigint),
                @InheritSiteAuthor, @AuthorsJson, @ReviewerJson, @SourcesJson, @UpdateSummary, @UpdateReason,
                CAST(@EffectiveAt AS timestamp), @ConclusionImpact, @Methodology, @Applicability, @Limitations,
                @ResponsiblePersonConfirmed, @CreatedAt)
            RETURNING id;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@ArticleRevisionId", articleRevisionId),
            new SugarParameter("@RevisionNo", revisionNo),
            new SugarParameter("@ResponsibilityVersion", responsibilityVersion),
            new SugarParameter("@PreviousSnapshotId", (object?)previousSnapshotId ?? DBNull.Value),
            new SugarParameter("@InheritSiteAuthor", draft.InheritSiteAuthor),
            new SugarParameter("@AuthorsJson", authorsJson),
            new SugarParameter("@ReviewerJson", (object?)reviewerJson ?? DBNull.Value),
            new SugarParameter("@SourcesJson", sourcesJson),
            new SugarParameter("@UpdateSummary", (object?)draft.UpdateSummary?.Trim() ?? DBNull.Value),
            new SugarParameter("@UpdateReason", (object?)draft.UpdateReason?.Trim() ?? DBNull.Value),
            new SugarParameter("@EffectiveAt", (object?)draft.EffectiveAt ?? DBNull.Value),
            new SugarParameter("@ConclusionImpact", (object?)draft.ConclusionImpact?.Trim() ?? DBNull.Value),
            new SugarParameter("@Methodology", (object?)draft.Methodology?.Trim() ?? DBNull.Value),
            new SugarParameter("@Applicability", (object?)draft.Applicability?.Trim() ?? DBNull.Value),
            new SugarParameter("@Limitations", (object?)draft.Limitations?.Trim() ?? DBNull.Value),
            new SugarParameter("@ResponsiblePersonConfirmed", draft.ResponsiblePersonConfirmed),
            new SugarParameter("@CreatedAt", createdAt));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("Responsibility snapshot insert returned no identity.");
        }

        return reader.GetInt64(0);
    }

    private async Task<(long? PublicationId, int? PublicationNo)> CreatePublicationReferenceIfCurrentAsync(
        ResponsibilityWriteCoordinates coordinates,
        long responsibilitySnapshotId,
        DateTime createdAt,
        CancellationToken cancellationToken)
    {
        if (coordinates.Status != ArticleStatus.Published
            || coordinates.CurrentPublicationId is null
            || coordinates.CurrentPublicationRevisionId != coordinates.ArticleRevisionId
            || coordinates.RightsSnapshotId is null
            || coordinates.CurrentPublishedAt is null)
        {
            return (null, null);
        }

        long publicationId;
        int publicationNo;
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                   """
                   INSERT INTO article_publication (
                       article_id, publication_no, article_revision_id, revision_no, rights_snapshot_id,
                       responsibility_snapshot_id, transition_kind, published_at, created_at)
                   SELECT
                       @ArticleId, COALESCE(MAX(publication_no), 0) + 1, @ArticleRevisionId, @RevisionNo,
                       @RightsSnapshotId, @ResponsibilitySnapshotId, @TransitionKind, @PublishedAt, @CreatedAt
                   FROM article_publication
                   WHERE article_id = @ArticleId
                   RETURNING id, publication_no;
                   """,
                   new SugarParameter("@ArticleId", coordinates.ArticleId),
                   new SugarParameter("@ArticleRevisionId", coordinates.ArticleRevisionId),
                   new SugarParameter("@RevisionNo", coordinates.RevisionNo),
                   new SugarParameter("@RightsSnapshotId", coordinates.RightsSnapshotId.Value),
                   new SugarParameter("@ResponsibilitySnapshotId", responsibilitySnapshotId),
                   new SugarParameter("@TransitionKind", ResponsibilityUpdatedTransitionKind),
                   new SugarParameter("@PublishedAt", coordinates.CurrentPublishedAt.Value),
                   new SugarParameter("@CreatedAt", createdAt)))
        {
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException("Responsibility publication reference was not created.");
            }

            publicationId = reader.GetInt64(0);
            publicationNo = reader.GetInt32(1);
        }

        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE article
            SET current_publication_id = @PublicationId,
                public_updated_at = @PublicUpdatedAt
            WHERE id = @ArticleId
              AND current_publication_id = @ExpectedPublicationId;
            """,
            new SugarParameter("@PublicationId", publicationId),
            new SugarParameter("@PublicUpdatedAt", createdAt),
            new SugarParameter("@ArticleId", coordinates.ArticleId),
            new SugarParameter("@ExpectedPublicationId", coordinates.CurrentPublicationId.Value));
        if (updated != 1)
        {
            throw new InvalidOperationException("Responsibility publication pointer compare-and-set failed.");
        }

        return (publicationId, publicationNo);
    }

    private async Task<int> InsertOutboxAsync(
        int articleId,
        long articleRevisionId,
        int revisionNo,
        long responsibilitySnapshotId,
        int responsibilityVersion,
        long? previousSnapshotId,
        long? publicationId,
        int? publicationNo,
        long? rightsSnapshotId,
        DateTime createdAt,
        CancellationToken cancellationToken)
    {
        _ = previousSnapshotId;
        if (rightsSnapshotId is null)
        {
            throw new InvalidOperationException("Responsibility mutation requires an exact rights snapshot coordinate.");
        }

        var version = new ArticleVersionCoordinates(
            articleRevisionId,
            revisionNo,
            rightsSnapshotId.Value,
            responsibilitySnapshotId,
            publicationId,
            publicationNo,
            responsibilityVersion);
        ArticleMutationOutboxEvent outboxEvent = await ArticleMutationOutboxProducer.CreateForVersionAsync(
                db,
                articleId,
                ResponsibilityUpdatedEventType,
                version,
                createdAt,
                cancellationToken)
            .ConfigureAwait(false);
        int inserted = await db.Insertable(outboxEvent).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
        await ArticleSourceGenerationAuthority.RecordMutationAsync(db, outboxEvent.EventId, cancellationToken).ConfigureAwait(false);
        return inserted;
    }

    private static ArticleResponsibilityVersionResponse ToVersionResponse(ArticleResponsibilitySnapshot snapshot)
        => new(
            snapshot.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
            snapshot.ArticleId,
            snapshot.ArticleRevisionId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            snapshot.RevisionNo,
            snapshot.ResponsibilityVersion,
            snapshot.PreviousSnapshotId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
            snapshot.InheritSiteAuthor,
            DeserializeList<ArticleResponsiblePerson>(snapshot.AuthorsJson),
            Deserialize<ArticleResponsiblePerson>(snapshot.ReviewerJson),
            DeserializeList<ArticleEvidenceSource>(snapshot.SourcesJson),
            snapshot.UpdateSummary,
            snapshot.UpdateReason,
            snapshot.EffectiveAt,
            snapshot.ConclusionImpact,
            snapshot.Methodology,
            snapshot.Applicability,
            snapshot.Limitations,
            snapshot.ResponsiblePersonConfirmed,
            snapshot.CreatedAt);

    private static T? Deserialize<T>(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return default;
        }

        try
        {
            return JsonSerializer.Deserialize<T>(json, s_jsonOptions);
        }
        catch (JsonException)
        {
            return default;
        }
    }

    private static IReadOnlyList<T> DeserializeList<T>(string? json)
        => Deserialize<T[]>(json) ?? [];

    private sealed record ResponsibilityWriteCoordinates(
        int ArticleId,
        long ArticleRevisionId,
        int RevisionNo,
        ArticleStatus Status,
        long? CurrentPublicationId,
        int? CurrentPublicationNo,
        long? CurrentPublicationRevisionId,
        long? RightsSnapshotId,
        DateTime? CurrentPublishedAt);
}
