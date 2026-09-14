// fixture-catalog: producer public-content
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Background;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

/// <summary>
/// Test-only public content fixture composition root (#1712).
/// Canonical lifecycle rows call application/domain ports (IArticleCoreGateway, IAdminArtifactOperations).
/// The dedicated deep-pagination profile uses an owned, set-based PostgreSQL fixture write here,
/// then derives boundaries with the production keyset order and IArticleListCursorCodec.
/// Never public/admin HTTP APIs, never Node SQL or cursor construction.
/// </summary>
public interface IPublicContentFixtureSeeder
{
    Task<PublicContentFixtureResult> PrepareAsync(
        PublicContentFixtureRequest request,
        CancellationToken cancellationToken = default);
}

public sealed record PublicContentFixtureRequest(
    IReadOnlyList<string> Capabilities,
    string? Namespace,
    string? RunId,
    JsonElement? TemporalContext = null,
    PublicContentSecurityMatrixRequest? SecurityMatrix = null);

public sealed record PublicContentSecurityMatrixRequest(
    IReadOnlyList<PublicContentSecurityCase> Cases,
    string AboutMarkdown,
    string MetadataText,
    int? ActorUserId = null);

public sealed record PublicContentSecurityCase(
    string Id,
    string Category,
    string Markdown);

public sealed class PublicContentFixtureResult
{
    public required string Strategy
    {
        get; init;
    }
    public required string Mode
    {
        get; init;
    }
    public required IReadOnlyList<PublicContentEntityIdentity> EntityIdentities
    {
        get; init;
    }
    public required PublicContentObservations Observations
    {
        get; init;
    }
    public required PublicContentProjectionHints Projection
    {
        get; init;
    }
    public required IReadOnlyList<string> ProvidedCapabilities
    {
        get; init;
    }
    public object? TemporalObservation
    {
        get; set;
    }
}

public sealed record PublicContentEntityIdentity(
    string Kind,
    string Id,
    string? Handle = null,
    string? CapabilityHint = null);

public sealed class PublicContentObservations
{
    public string Source { get; init; } = "service";
    public PublicContentDatabaseObservation? Database
    {
        get; init;
    }
    public PublicContentRedisObservation? Redis
    {
        get; init;
    }
    public PublicContentCacheObservation? Cache
    {
        get; init;
    }
}

public sealed class PublicContentDatabaseObservation
{
    public string? Namespace
    {
        get; init;
    }
    public string SchemaIdentity { get; init; } = "public";
    public required IReadOnlyList<PublicContentObservedEntity> Entities
    {
        get; init;
    }
}

public sealed class PublicContentObservedEntity
{
    public required string Kind
    {
        get; init;
    }
    public required string Id
    {
        get; init;
    }
    public bool Owned { get; init; } = true;
    public string? CapabilityHint
    {
        get; init;
    }
    public string? Projection
    {
        get; init;
    }
    public string? PostconditionId
    {
        get; init;
    }
    public Dictionary<string, object?> Fields { get; init; } = new();
}

public sealed class PublicContentRedisObservation
{
    public string? Namespace
    {
        get; init;
    }
    public required IReadOnlyList<PublicContentRedisKey> Keys
    {
        get; init;
    }
}

public sealed record PublicContentRedisKey(
    string Domain,
    string Key,
    bool Present,
    IReadOnlyList<string>? MemberIds = null);

public sealed class PublicContentCacheObservation
{
    public string? Namespace
    {
        get; init;
    }
    public long? Generation
    {
        get; init;
    }
    public required IReadOnlyList<PublicContentCacheEntry> Entries
    {
        get; init;
    }
}

public sealed class PublicContentCacheEntry
{
    public string Domain { get; init; } = "redis.cache.public";
    public string? Endpoint
    {
        get; init;
    }
    public bool MatchesDb
    {
        get; init;
    }
    public bool RequireOwnedVisible
    {
        get; init;
    }
    public IReadOnlyList<string>? VisibleEntityIds
    {
        get; init;
    }
    public string? SearchToken
    {
        get; init;
    }
    public bool SearchHit
    {
        get; init;
    }
}

public sealed class PublicContentProjectionHints
{
    public string? ArticleId
    {
        get; init;
    }
    public string? CategoryId
    {
        get; init;
    }
    public string? TagId
    {
        get; init;
    }
    public string? ArticleTitle
    {
        get; init;
    }
    public string? SearchKeyword
    {
        get; init;
    }
    public IReadOnlyList<string> PublishedArticleIds { get; init; } = [];
    public IReadOnlyList<string> HotOrder { get; init; } = [];
    public PublicContentPaginationProjection? Pagination
    {
        get; init;
    }
}

public sealed class PublicContentPaginationProjection
{
    public string Route { get; init; } = "article/list/home";
    public string Sort { get; init; } = "latest";
    public int PageSize
    {
        get; init;
    }
    public long Generation
    {
        get; init;
    }
    public int ArticleCount
    {
        get; init;
    }
    public int OwnedArticleCount
    {
        get; init;
    }
    public required IReadOnlyList<PublicContentPaginationCursor> Cursors
    {
        get; init;
    }
}

public sealed record PublicContentPaginationCursor(
    int LogicalPage,
    string Cursor,
    PublicContentPaginationBoundaryIdentity BoundaryIdentity);

public sealed record PublicContentPaginationBoundaryIdentity(
    string ArticleId,
    DateTime CreateTimeUtc,
    long SortValue,
    int PrecedingItemCount);

internal sealed record PublicContentPaginationBoundaryRow(
    int LogicalPage,
    int ArticleId,
    DateTime CreateTimeUtc,
    long SortValue,
    int PrecedingItemCount);

public sealed class PublicContentFixtureSeeder(
    IArticleCoreGateway articles,
    ISqlSugarClient db,
    ICacheStringReader cacheReader,
    IArticleListCursorCodec articleListCursorCodec,
    ICacheInvalidationDispatcher cacheInvalidation,
    IAdminArtifactOperations artifactOperations,
    ISearchIndexService searchIndex,
    ICommentCommandService comments,
    ISystemService system,
    PublicArtifactRevocationRegistry publicArtifactRevocations,
    IPublicArtifactRevocationStateStore publicArtifactRevocationState,
    IPublicHotArtifactObligationStore publicHotObligations,
    TimeProvider timeProvider,
    ArticleMutationOutboxDispatcher articleOutboxDispatcher,
    IActiveReleaseFence? activeReleaseFence,
    IActiveReleaseExecutionContextAccessor? releaseExecutionContext,
    IConfiguration configuration) : IPublicContentFixtureSeeder
{
    private const string Strategy = "transaction-fixture";
    internal const int PaginationArticleCount = 10_020;
    internal const int PaginationPageSize = 10;
    private static readonly int[] s_paginationLogicalPages = [10, 100, 1_000];
    private const int MaxOutboxDrainPasses = 16;
    private static readonly TimeSpan s_outboxDrainPassDelay = TimeSpan.FromMilliseconds(200);
    private static readonly TimeSpan s_securityMatrixConvergenceTimeout = TimeSpan.FromMinutes(6);
    private static readonly TimeSpan s_securityMatrixConvergencePollInterval = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan s_securityMatrixHandoffQuietPeriod = TimeSpan.FromSeconds(10);
    internal const string RevisionHistoryFixtureAppendix = "\n\nSecond edition body for history checks.";
    private static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public async Task<PublicContentFixtureResult> PrepareAsync(
        PublicContentFixtureRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        IReadOnlyList<string> capabilities = (request.Capabilities ?? [])
            .Select(static item => item.Trim())
            .Where(static item => item.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static item => item, StringComparer.Ordinal)
            .ToArray();
        bool requiresDeepPagination = capabilities.Contains(
            "public.article.pagination-deep",
            StringComparer.Ordinal);

        string ns = string.IsNullOrWhiteSpace(request.Namespace) ? "local" : request.Namespace.Trim();
        string runToken = string.IsNullOrWhiteSpace(request.RunId)
            ? "run"
            : new string(request.RunId.Where(static ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_').Take(24).ToArray());
        string ownerPrefix = $"fxpc:{ns}:{runToken}";

        if (request.SecurityMatrix is not null)
        {
            return await PrepareSecurityMatrixAsync(
                    request.SecurityMatrix,
                    capabilities,
                    ns,
                    ownerPrefix,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        if (capabilities.Contains("public.empty", StringComparer.Ordinal))
        {
            if (capabilities.Count != 1)
            {
                throw new InvalidOperationException("public.empty cannot mix with content capabilities in one prepare");
            }

            await EnsureEmptyOwnedNamespaceAsync(ownerPrefix, cancellationToken).ConfigureAwait(false);
            return BuildEmptyResult(ns, capabilities);
        }

        if (!capabilities.Contains("public.article.published", StringComparer.Ordinal)
            && !capabilities.Any(static id => id.StartsWith("public.", StringComparison.Ordinal)))
        {
            throw new InvalidOperationException("public-content producer requires public capabilities");
        }

        // Rerun ownership: remove only previously owned entities for this owner prefix.
        await CleanupOwnedAsync(ownerPrefix, cancellationToken).ConfigureAwait(false);

        (Category category, Tag tag) = await EnsureTaxonomyAsync(
                EnsureCategoryAsync,
                EnsureTagAsync,
                cacheInvalidation,
                ownerPrefix,
                cancellationToken)
            .ConfigureAwait(false);
        string taxonomyCapabilityHint = capabilities.Contains(
            "public.taxonomy.category-tag",
            StringComparer.Ordinal)
            ? "taxonomy-category-tag"
            : "article-published";

        var entityIdentities = new List<PublicContentEntityIdentity>
        {
            new(
                "category",
                category.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                category.Name,
                taxonomyCapabilityHint),
            new(
                "tag",
                tag.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                tag.Name,
                taxonomyCapabilityHint)
        };
        var observed = new List<PublicContentObservedEntity>
        {
            new()
            {
                Kind = "category",
                Id = category.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                CapabilityHint = taxonomyCapabilityHint,
                Fields = new Dictionary<string, object?> { ["name"] = category.Name }
            },
            new()
            {
                Kind = "tag",
                Id = tag.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                CapabilityHint = taxonomyCapabilityHint,
                Fields = new Dictionary<string, object?> { ["name"] = tag.Name }
            }
        };

        // public-minimal: exactly 3 published articles, stable relative order, mixed cover, distinct views.
        var publishedPlan = new[]
        {
            new SeedArticlePlan(
                Role: "published-primary",
                Title: $"{ownerPrefix}:published:primary",
                Summary: "Fixture primary published article with cover.",
                Markdown: "# Fixture Primary\n\nSearchable token FXPC_PRIMARY_BODY for public.search.indexed.\n\nStable hydration paragraph.",
                CoverImageUrl: "/fixtures/acceptance-cover-primary.svg",
                Views: 42,
                Status: ArticleStatus.Published),
            new SeedArticlePlan(
                Role: "published-focus",
                Title: $"{ownerPrefix}:published:focus",
                Summary: "Fixture focus published article with cover.",
                Markdown: "# Fixture Focus\n\nSearchable token FXPC_FOCUS_BODY.",
                CoverImageUrl: "/fixtures/acceptance-cover-focus.svg",
                Views: 30,
                Status: ArticleStatus.Published),
            new SeedArticlePlan(
                Role: "published-plain",
                Title: $"{ownerPrefix}:published:plain",
                Summary: "Fixture plain published article without cover.",
                Markdown: "# Fixture Plain\n\nSearchable token FXPC_PLAIN_BODY.",
                CoverImageUrl: null,
                Views: 18,
                Status: ArticleStatus.Published)
        };

        var publishedIds = new List<int>();
        string searchToken = "FXPC_PRIMARY_BODY";
        foreach (SeedArticlePlan plan in publishedPlan)
        {
            int articleId = await CreateArticleAsync(plan, category.Id, tag.Id, cancellationToken).ConfigureAwait(false);
            await SetViewsAsync(articleId, plan.Views, cancellationToken).ConfigureAwait(false);
            publishedIds.Add(articleId);
            entityIdentities.Add(new("article", articleId.ToString(System.Globalization.CultureInfo.InvariantCulture), plan.Title, "article-published"));
            Article? row = await LoadArticleAsync(articleId, cancellationToken).ConfigureAwait(false)
                ?? throw new InvalidOperationException($"owned article {articleId} missing after create");
            List<long> revisionIds = await LoadRevisionIdsAsync(articleId, cancellationToken).ConfigureAwait(false);
            observed.Add(new PublicContentObservedEntity
            {
                Kind = "article",
                Id = articleId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                CapabilityHint = "article-published",
                Projection = "featured-hot",
                Fields = new Dictionary<string, object?>
                {
                    ["status"] = "published",
                    ["deleted"] = false,
                    ["isDeleted"] = false,
                    ["currentPublicationId"] = row.CurrentPublicationId,
                    ["currentRevisionId"] = row.CurrentRevisionId,
                    ["revisionIds"] = revisionIds.Select(static id => id.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray(),
                    ["publicDetailReadable"] = true,
                    ["featured"] = plan.CoverImageUrl is not null,
                    ["hot"] = true,
                    ["views"] = plan.Views,
                    ["coverImageUrl"] = plan.CoverImageUrl,
                    ["title"] = plan.Title,
                    ["hasCover"] = plan.CoverImageUrl is not null
                }
            });
        }

        if (requiresDeepPagination)
        {
            foreach (PublicContentObservedEntity article in observed
                .Where(static item => item.Kind == "article"
                    && item.CapabilityHint == "article-published")
                .ToArray())
            {
                observed.Add(new PublicContentObservedEntity
                {
                    Kind = article.Kind,
                    Id = article.Id,
                    Owned = article.Owned,
                    CapabilityHint = "article-pagination-deep",
                    Projection = article.Projection,
                    Fields = new Dictionary<string, object?>(article.Fields)
                });
            }

            // Replay the three domain-created articles before adding the set-based
            // pagination rows. Otherwise each search edge scans all 10,020 rows
            // even though deep-pagination fixtures intentionally have no bodies.
            await DrainArticleMutationOutboxAsync(cancellationToken).ConfigureAwait(false);
            await SeedDeepPaginationArticlesAsync(
                    ownerPrefix,
                    category.Id,
                    tag.Id,
                    publishedIds[0],
                    cancellationToken)
                .ConfigureAwait(false);
            await cacheInvalidation.InvalidateArticleMutationAsync(
                    articleId: null,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        if (capabilities.Contains("public.article.draft", StringComparer.Ordinal))
        {
            await SeedLifecycleArticleAsync(
                new SeedArticlePlan(
                    "draft",
                    $"{ownerPrefix}:draft",
                    "Draft lifecycle fixture",
                    "# Draft body",
                    null,
                    0,
                    ArticleStatus.Draft),
                category.Id,
                tag.Id,
                entityIdentities,
                observed,
                "article-draft",
                cancellationToken).ConfigureAwait(false);
        }

        if (capabilities.Contains("public.article.scheduled", StringComparer.Ordinal))
        {
            await SeedLifecycleArticleAsync(
                new SeedArticlePlan(
                    "scheduled",
                    $"{ownerPrefix}:scheduled",
                    "Scheduled lifecycle fixture",
                    "# Scheduled body",
                    null,
                    0,
                    ArticleStatus.Scheduled,
                    ScheduledPublishAt: timeProvider.GetUtcNow().UtcDateTime.AddDays(7)),
                category.Id,
                tag.Id,
                entityIdentities,
                observed,
                "article-scheduled",
                cancellationToken).ConfigureAwait(false);
        }

        if (capabilities.Contains("public.article.archived", StringComparer.Ordinal))
        {
            int archivedId = await CreateArticleAsync(
                new SeedArticlePlan(
                    "archived",
                    $"{ownerPrefix}:archived",
                    "Archived lifecycle fixture",
                    "# Archived body",
                    null,
                    1,
                    ArticleStatus.Published),
                category.Id,
                tag.Id,
                cancellationToken).ConfigureAwait(false);
            long archivedBaseRevisionId = await RequireCurrentRevisionIdAsync(
                archivedId,
                cancellationToken).ConfigureAwait(false);
            bool archived = await articles.UpdateAsync(
                new UpdateArticleCommand(
                    archivedId,
                    BuildWriteRequest(
                        $"{ownerPrefix}:archived",
                        "# Archived body",
                        "Archived lifecycle fixture",
                        null,
                        category.Id,
                        tag.Id,
                        ArticleStatus.Archived,
                        baseRevisionId: archivedBaseRevisionId)),
                cancellationToken).ConfigureAwait(false);
            if (!archived)
            {
                throw new InvalidOperationException("failed to archive lifecycle article via domain port");
            }

            Article row = await LoadArticleAsync(archivedId, cancellationToken).ConfigureAwait(false)
                ?? throw new InvalidOperationException("archived article missing");
            List<long> archivedRevisionIds = await LoadRevisionIdsAsync(archivedId, cancellationToken).ConfigureAwait(false);
            entityIdentities.Add(new("article", archivedId.ToString(System.Globalization.CultureInfo.InvariantCulture), row.Title, "article-archived"));
            observed.Add(StatusEntity(archivedId, "archived", "article-archived", row, archivedRevisionIds));
        }

        if (capabilities.Contains("public.article.deleted", StringComparer.Ordinal))
        {
            int deletedId = await CreateArticleAsync(
                new SeedArticlePlan(
                    "deleted",
                    $"{ownerPrefix}:deleted",
                    "Deleted lifecycle fixture",
                    "# Deleted body",
                    null,
                    1,
                    ArticleStatus.Published),
                category.Id,
                tag.Id,
                cancellationToken).ConfigureAwait(false);
            bool deleted = await articles.DeleteAsync(new ArticleIdCommand(deletedId), cancellationToken).ConfigureAwait(false);
            if (!deleted)
            {
                throw new InvalidOperationException("failed to delete lifecycle article via domain port");
            }

            Article row = await LoadArticleAsync(deletedId, includeDeleted: true, cancellationToken).ConfigureAwait(false)
                ?? throw new InvalidOperationException("deleted article missing");
            entityIdentities.Add(new("article", deletedId.ToString(System.Globalization.CultureInfo.InvariantCulture), row.Title, "article-deleted"));
            observed.Add(new PublicContentObservedEntity
            {
                Kind = "article",
                Id = deletedId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                CapabilityHint = "article-deleted",
                Fields = new Dictionary<string, object?>
                {
                    ["status"] = "deleted",
                    ["deleted"] = true,
                    ["isDeleted"] = true,
                    ["currentPublicationId"] = row.CurrentPublicationId,
                    ["currentRevisionId"] = row.CurrentRevisionId
                }
            });
        }

        int multiRevisionId = 0;
        if (capabilities.Contains("public.article.multiple-revisions", StringComparer.Ordinal)
            || capabilities.Contains("public.article.revision-history", StringComparer.Ordinal))
        {
            multiRevisionId = publishedIds[0];
            long multiRevisionBaseRevisionId = await RequireCurrentRevisionIdAsync(
                multiRevisionId,
                cancellationToken).ConfigureAwait(false);
            bool updated = await articles.UpdateAsync(
                new UpdateArticleCommand(
                    multiRevisionId,
                    BuildWriteRequest(
                        publishedPlan[0].Title,
                        publishedPlan[0].Markdown + RevisionHistoryFixtureAppendix,
                        publishedPlan[0].Summary,
                        publishedPlan[0].CoverImageUrl,
                        category.Id,
                        tag.Id,
                        ArticleStatus.Published,
                        baseRevisionId: multiRevisionBaseRevisionId)),
                cancellationToken).ConfigureAwait(false);
            if (!updated)
            {
                throw new InvalidOperationException("failed to create second revision via domain port");
            }

            List<long> revisionIds = await LoadRevisionIdsAsync(multiRevisionId, cancellationToken).ConfigureAwait(false);
            if (revisionIds.Count < 2 && capabilities.Contains("public.article.multiple-revisions", StringComparer.Ordinal))
            {
                throw new InvalidOperationException("multiple-revisions postcondition requires >=2 revisions");
            }

            PublicContentObservedEntity? existing = observed.FirstOrDefault(item => item.Kind == "article" && item.Id == multiRevisionId.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (existing is not null)
            {
                existing.Fields["revisionIds"] = revisionIds.Select(static id => id.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray();
                existing.Fields["currentRevisionId"] = revisionIds.DefaultIfEmpty().Max();
            }

            if (capabilities.Contains("public.article.multiple-revisions", StringComparer.Ordinal))
            {
                observed.Add(new PublicContentObservedEntity
                {
                    Kind = "article",
                    Id = multiRevisionId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    CapabilityHint = "article-multiple-revisions",
                    PostconditionId = "article-multiple-revisions",
                    Fields = new Dictionary<string, object?>
                    {
                        ["status"] = "published",
                        ["revisionCount"] = revisionIds.Count,
                        ["revisionIds"] = revisionIds.Select(static id => id.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray(),
                        ["multipleRevisions"] = revisionIds.Count >= 2
                    }
                });
            }
        }

        if (capabilities.Contains("public.article.multiple-publications", StringComparer.Ordinal))
        {
            int multiPubId = publishedIds[1];
            long archiveBaseRevisionId = await RequireCurrentRevisionIdAsync(
                multiPubId,
                cancellationToken).ConfigureAwait(false);
            bool archived = await articles.UpdateAsync(
                new UpdateArticleCommand(
                    multiPubId,
                    BuildWriteRequest(
                        publishedPlan[1].Title,
                        publishedPlan[1].Markdown,
                        publishedPlan[1].Summary,
                        publishedPlan[1].CoverImageUrl,
                        category.Id,
                        tag.Id,
                        ArticleStatus.Archived,
                        baseRevisionId: archiveBaseRevisionId)),
                cancellationToken).ConfigureAwait(false);
            if (!archived)
            {
                throw new InvalidOperationException("failed to archive for multi-publication");
            }

            // Re-publish through domain update (creates another publication transition).
            long republishBaseRevisionId = await RequireCurrentRevisionIdAsync(
                multiPubId,
                cancellationToken).ConfigureAwait(false);
            bool republished = await articles.UpdateAsync(
                new UpdateArticleCommand(
                    multiPubId,
                    BuildWriteRequest(
                        publishedPlan[1].Title,
                        publishedPlan[1].Markdown,
                        publishedPlan[1].Summary,
                        publishedPlan[1].CoverImageUrl,
                        category.Id,
                        tag.Id,
                        ArticleStatus.Published,
                        baseRevisionId: republishBaseRevisionId)),
                cancellationToken).ConfigureAwait(false);
            if (!republished)
            {
                throw new InvalidOperationException("failed to republish for multi-publication");
            }

            long publicationCount = await db.Queryable<ArticlePublicationRecord>()
                .Where(item => item.ArticleId == multiPubId)
                .CountAsync()
                .ConfigureAwait(false);
            if (publicationCount < 2)
            {
                throw new InvalidOperationException("multiple-publications postcondition requires >=2 publications");
            }

            observed.Add(new PublicContentObservedEntity
            {
                Kind = "article",
                Id = multiPubId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                CapabilityHint = "article-multiple-publications",
                PostconditionId = "article-multiple-publications",
                Fields = new Dictionary<string, object?>
                {
                    ["status"] = "published",
                    ["publicationCount"] = publicationCount,
                    ["multiplePublications"] = publicationCount >= 2
                }
            });
        }

        // Cache / search / hot rebuild via domain ports — fail closed if degraded.
        await DrainArticleMutationOutboxAsync(cancellationToken).ConfigureAwait(false);

        bool requiresSearch = capabilities.Contains("public.search.indexed", StringComparer.Ordinal);
        if (!requiresDeepPagination || requiresSearch)
        {
            AdminCacheActionResponse searchRebuild = await artifactOperations.RunCacheActionAsync(
                new AdminCacheActionRequest("search-rebuild"),
                cancellationToken).ConfigureAwait(false);
            if (!string.Equals(searchRebuild.Status, "ok", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException($"search-rebuild failed: {searchRebuild.Status} {searchRebuild.Detail}");
            }
        }

        AdminCacheActionResponse hotRebuild = await artifactOperations.RunCacheActionAsync(
            new AdminCacheActionRequest("public-hot-rebuild"),
            cancellationToken).ConfigureAwait(false);
        if (hotRebuild.Status is "degraded" or "failed")
        {
            throw new InvalidOperationException($"public-hot-rebuild failed: {hotRebuild.Status} {hotRebuild.Detail}");
        }

        // Observe real read ports.
        IReadOnlyList<PopularArticleCoreModel> hot = await articles.GetHotArticlesAsync(new ArticleCountQuery(5), cancellationToken)
            .ConfigureAwait(false);
        IReadOnlyList<FeaturedArticleCoreModel> featured = await articles.GetFeaturedArticlesAsync(new ArticleCountQuery(3), cancellationToken)
            .ConfigureAwait(false);
        var publishedIdSet = publishedIds.Select(static id => id.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToHashSet(StringComparer.Ordinal);
        var hotOwned = hot.Where(item => publishedIdSet.Contains(item.Id.ToString(System.Globalization.CultureInfo.InvariantCulture))).ToArray();
        if (hotOwned.Length == 0)
        {
            throw new InvalidOperationException("hot read model did not converge on owned published articles");
        }

        // Featured requires cover; at least primary/focus should appear when hot seed includes them.
        foreach (int publishedId in publishedIds)
        {
            ArticleDetailCoreModel? detail = await articles.GetByIdAsync(new ArticleDetailQuery(publishedId), cancellationToken)
                .ConfigureAwait(false);
            if (detail is null)
            {
                throw new InvalidOperationException($"public detail not readable for owned article {publishedId}");
            }
        }

        List<Article> searchHits = requiresDeepPagination && !requiresSearch
            ? []
            : await searchIndex.SearchAsync(searchToken).ConfigureAwait(false);
        bool searchHit = searchHits.Any(item => publishedIds.Contains(item.Id));
        if (!searchHit && capabilities.Contains("public.search.indexed", StringComparer.Ordinal))
        {
            throw new InvalidOperationException($"search token '{searchToken}' did not hit owned published article");
        }

        CorePageResult<ArticleListCoreModel> list = await articles.GetPageListAsync(
            new ArticlePageQuery(1, 10, category.Id, tag.Id, IsDeleted: false, Status: (int)ArticleStatus.Published),
            cancellationToken).ConfigureAwait(false);
        var listIds = list.Items.Select(static item => item.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray();
        if (!requiresDeepPagination)
        {
            foreach (int publishedId in publishedIds)
            {
                string idText = publishedId.ToString(System.Globalization.CultureInfo.InvariantCulture);
                if (!listIds.Contains(idText, StringComparer.Ordinal))
                {
                    throw new InvalidOperationException($"public list missing owned published article {publishedId}");
                }
            }
        }

        // Ensure archived/deleted are not in public list.
        foreach (PublicContentObservedEntity entity in observed.Where(static item =>
            item.CapabilityHint is "article-archived" or "article-deleted" or "article-draft" or "article-scheduled"))
        {
            if (listIds.Contains(entity.Id, StringComparer.Ordinal))
            {
                throw new InvalidOperationException($"non-public article {entity.Id} leaked into public list");
            }
        }

        string[] hotOrder = hot.Select(static item => item.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray();
        string[] featuredIds = featured.Select(static item => item.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray();
        PublicContentPaginationProjection? paginationProjection = requiresDeepPagination
            ? await ReadDeepPaginationProjectionAsync(ownerPrefix, cancellationToken).ConfigureAwait(false)
            : null;
        if (paginationProjection is not null)
        {
            foreach (PublicContentPaginationCursor pageCursor in paginationProjection.Cursors)
            {
                AddPaginationBoundaryEvidence(
                    entityIdentities,
                    observed,
                    ownerPrefix,
                    pageCursor);
            }
            entityIdentities.Add(new(
                "pagination-keyset",
                "article/list/home:latest:size=10",
                ownerPrefix,
                "article-pagination-deep"));
            observed.Add(new PublicContentObservedEntity
            {
                Kind = "pagination-keyset",
                Id = "article/list/home:latest:size=10",
                CapabilityHint = "article-pagination-deep",
                PostconditionId = "article-pagination-deep",
                Fields = new Dictionary<string, object?>
                {
                    ["route"] = paginationProjection.Route,
                    ["sort"] = paginationProjection.Sort,
                    ["pageSize"] = paginationProjection.PageSize,
                    ["generation"] = paginationProjection.Generation,
                    ["articleCount"] = paginationProjection.ArticleCount,
                    ["ownedArticleCount"] = paginationProjection.OwnedArticleCount,
                    ["cursors"] = paginationProjection.Cursors
                }
            });
        }

        var redisKeys = new List<PublicContentRedisKey>
        {
            new("redis.cache.public", "blog:top_articles", Present: hot.Count > 0, MemberIds: hotOrder),
            new("redis.cache.public", "featured-hot", Present: featured.Count > 0 || hot.Count > 0, MemberIds: featuredIds)
        };

        var cacheEntries = new List<PublicContentCacheEntry>
        {
            new()
            {
                Domain = "home",
                Endpoint = "article/hot",
                MatchesDb = true,
                RequireOwnedVisible = true,
                VisibleEntityIds = publishedIds.Select(static id => id.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray()
            },
            new()
            {
                Domain = "home",
                Endpoint = "article/featured",
                MatchesDb = true,
                RequireOwnedVisible = false,
                VisibleEntityIds = featuredIds
            },
            new()
            {
                Domain = "search",
                Endpoint = "search",
                MatchesDb = searchHit,
                SearchToken = searchToken,
                SearchHit = searchHit,
                VisibleEntityIds = searchHits.Select(static item => item.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray()
            },
            new()
            {
                Domain = "list",
                Endpoint = "article/list/home",
                MatchesDb = true,
                RequireOwnedVisible = true,
                VisibleEntityIds = listIds
            }
        };

        return new PublicContentFixtureResult
        {
            Strategy = Strategy,
            Mode = requiresDeepPagination
                ? "runtime-cache-pagination"
                : capabilities.Contains("public.article.draft", StringComparer.Ordinal) ? "public-content-lifecycle" : "public-minimal",
            EntityIdentities = entityIdentities,
            ProvidedCapabilities = capabilities,
            Projection = new PublicContentProjectionHints
            {
                ArticleId = publishedIds[0].ToString(System.Globalization.CultureInfo.InvariantCulture),
                CategoryId = category.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                TagId = tag.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ArticleTitle = publishedPlan[0].Title,
                SearchKeyword = searchToken,
                PublishedArticleIds = publishedIds.Select(static id => id.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray(),
                HotOrder = hotOrder,
                Pagination = paginationProjection
            },
            Observations = new PublicContentObservations
            {
                Source = "service",
                Database = new PublicContentDatabaseObservation
                {
                    Namespace = ns,
                    Entities = observed
                },
                Redis = new PublicContentRedisObservation
                {
                    Namespace = ns,
                    Keys = redisKeys
                },
                Cache = new PublicContentCacheObservation
                {
                    Namespace = ns,
                    Generation = paginationProjection?.Generation ?? timeProvider.GetUtcNow().ToUnixTimeMilliseconds(),
                    Entries = cacheEntries
                }
            }
        };
    }

    private static PublicContentFixtureResult BuildEmptyResult(string ns, IReadOnlyList<string> capabilities)
        => new()
        {
            Strategy = Strategy,
            Mode = "public-empty",
            EntityIdentities = [],
            ProvidedCapabilities = capabilities,
            Projection = new PublicContentProjectionHints(),
            Observations = new PublicContentObservations
            {
                Source = "service",
                Database = new PublicContentDatabaseObservation
                {
                    Namespace = ns,
                    Entities = []
                },
                Redis = new PublicContentRedisObservation
                {
                    Namespace = ns,
                    Keys =
                    [
                        new("redis.cache.public", "blog:top_articles", Present: false),
                        new("redis.cache.public", "featured-hot", Present: false)
                    ]
                },
                Cache = new PublicContentCacheObservation
                {
                    Namespace = ns,
                    Generation = 0,
                    Entries =
                    [
                        new()
                        {
                            Domain = "home",
                            Endpoint = "article/list/home",
                            MatchesDb = true,
                            VisibleEntityIds = []
                        }
                    ]
                }
            }
        };

    private async Task EnsureEmptyOwnedNamespaceAsync(string ownerPrefix, CancellationToken cancellationToken)
    {
        await CleanupOwnedAsync(ownerPrefix, cancellationToken).ConfigureAwait(false);
        // Also clear hot seed so empty profile has no residual public hot projection for owned data.
        await artifactOperations.RunCacheActionAsync(new AdminCacheActionRequest("public-hot-rebuild"), cancellationToken)
            .ConfigureAwait(false);
        await artifactOperations.RunCacheActionAsync(new AdminCacheActionRequest("search-rebuild"), cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task SeedDeepPaginationArticlesAsync(
        string ownerPrefix,
        int categoryId,
        int tagId,
        int sourceArticleId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Article sourceArticle = await LoadArticleAsync(sourceArticleId, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("pagination fixture source article is missing");
        long sourceRevisionId = sourceArticle.CurrentRevisionId
            ?? throw new InvalidOperationException("pagination fixture source article has no revision");
        long sourcePublicationId = sourceArticle.CurrentPublicationId
            ?? throw new InvalidOperationException("pagination fixture source article has no publication");
        ArticleRevision sourceRevision = await db.Queryable<ArticleRevision>()
            .InSingleAsync(sourceRevisionId)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("pagination fixture source revision is missing");
        ArticleBody sourceBody = await db.Queryable<ArticleBody>()
            .InSingleAsync(sourceArticleId)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("pagination fixture source article body is missing");
        ArticlePublicationRecord sourcePublication = await db.Queryable<ArticlePublicationRecord>()
            .InSingleAsync(sourcePublicationId)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("pagination fixture source publication is missing");
        DateTime baseTimeUtc = timeProvider.GetUtcNow().UtcDateTime;

        int inserted = await InsertDeepPaginationRowsAsync(
            db,
            ownerPrefix,
            categoryId,
            tagId,
            sourceRevision.ContentBlockId,
            sourceRevision.CreatedByAdminPrincipalId,
            sourcePublication.RightsSnapshotId,
            sourceBody.MarkdownContent,
            baseTimeUtc,
            cancellationToken).ConfigureAwait(false);
        if (inserted != PaginationArticleCount)
        {
            throw new InvalidOperationException(
                $"pagination fixture inserted {inserted} articles; expected {PaginationArticleCount}");
        }
    }

    internal static Task<int> InsertDeepPaginationRowsAsync(
        ISqlSugarClient fixtureDb,
        string ownerPrefix,
        int categoryId,
        int tagId,
        long contentBlockId,
        long createdByAdminPrincipalId,
        long rightsSnapshotId,
        string markdownContent,
        DateTime baseTimeUtc,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return fixtureDb.Ado.ExecuteCommandAsync(
            """
            WITH generated AS MATERIALIZED (
                SELECT
                    source.ordinal,
                    nextval(pg_get_serial_sequence('article', 'id'))::integer AS article_id,
                    nextval(pg_get_serial_sequence('article_revision', 'id'))::bigint AS revision_id,
                    nextval(pg_get_serial_sequence('article_publication', 'id'))::bigint AS publication_id,
                    @BaseTimeUtc - ((source.ordinal - 1) * interval '1 microsecond') AS created_at
                FROM generate_series(1, @ArticleCount) AS source(ordinal)
            ), inserted_revisions AS (
                INSERT INTO article_revision (
                    id, article_id, revision_no, title, summary, cover_image_url, categoryid,
                    tag_ids, content_block_id, markdown_content, diff_summary,
                    created_by_admin_principal_id, rollback_source_revision_id, rollback_reason, created_at)
                SELECT
                    generated.revision_id,
                    generated.article_id,
                    1,
                    @OwnerPrefix || ':pagination:' || lpad(generated.ordinal::text, 5, '0'),
                    'Deep latest-keyset pagination fixture',
                    NULL,
                    @CategoryId,
                    CAST(@TagId AS text),
                    @ContentBlockId,
                    '',
                    'authoritative deep pagination fixture',
                    @CreatedByAdminPrincipalId,
                    NULL,
                    NULL,
                    generated.created_at
                FROM generated
                RETURNING id
            ), inserted_publications AS (
                INSERT INTO article_publication (
                    id, article_id, publication_no, article_revision_id, revision_no,
                    rights_snapshot_id, responsibility_snapshot_id, transition_kind,
                    published_at, created_at)
                SELECT
                    generated.publication_id,
                    generated.article_id,
                    1,
                    generated.revision_id,
                    1,
                    @RightsSnapshotId,
                    NULL,
                    'fixture-pagination',
                    generated.created_at,
                    generated.created_at
                FROM generated
                JOIN inserted_revisions ON inserted_revisions.id = generated.revision_id
                RETURNING id
            ), inserted_articles AS (
                INSERT INTO article (
                    id, title, summary, coverimageurl, categoryid, views, createtime,
                    metadata_updated_at, status, scheduled_publish_at, published_at,
                    last_published_at, public_updated_at, current_revision_id,
                    current_publication_id, pending_publication_at, archived_at, deleted_at, isdeleted)
                SELECT
                    generated.article_id,
                    @OwnerPrefix || ':pagination:' || lpad(generated.ordinal::text, 5, '0'),
                    'Deep latest-keyset pagination fixture',
                    NULL,
                    @CategoryId,
                    0,
                    generated.created_at,
                    generated.created_at,
                    2,
                    NULL,
                    generated.created_at,
                    generated.created_at,
                    generated.created_at,
                    generated.revision_id,
                    generated.publication_id,
                    NULL,
                    NULL,
                    NULL,
                    false
                FROM generated
                JOIN inserted_publications ON inserted_publications.id = generated.publication_id
                RETURNING id
            )
            INSERT INTO article_body (article_id, markdown_content, updated_at)
            SELECT id, @MarkdownContent, @BaseTimeUtc
            FROM inserted_articles;
            """,
            new SugarParameter("@ArticleCount", PaginationArticleCount),
            new SugarParameter("@OwnerPrefix", ownerPrefix),
            new SugarParameter("@CategoryId", categoryId),
            new SugarParameter("@TagId", tagId),
            new SugarParameter("@ContentBlockId", contentBlockId),
            new SugarParameter("@CreatedByAdminPrincipalId", createdByAdminPrincipalId),
            new SugarParameter("@RightsSnapshotId", rightsSnapshotId),
            new SugarParameter("@MarkdownContent", markdownContent),
            new SugarParameter("@BaseTimeUtc", baseTimeUtc));
    }

    private async Task<PublicContentPaginationProjection> ReadDeepPaginationProjectionAsync(
        string ownerPrefix,
        CancellationToken cancellationToken)
    {
        string? rawGeneration = await cacheReader.GetStringAsync(
                CachePolicyId.ArticleListVersion,
                "main",
                cancellationToken)
            .ConfigureAwait(false);
        if (!long.TryParse(
                rawGeneration,
                System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture,
                out long generation)
            || generation < 0)
        {
            throw new InvalidOperationException("pagination fixture article-list generation is unavailable");
        }

        int[] precedingItemCounts = s_paginationLogicalPages
            .Select(static page => checked((page - 1) * PaginationPageSize))
            .ToArray();
        var rows = new List<PublicContentPaginationBoundaryRow>(s_paginationLogicalPages.Length);
        int articleCount = 0;
        int ownedArticleCount = 0;
        using (var reader = (System.Data.Common.DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH visible AS (
                SELECT
                    article.id,
                    article.createtime,
                    row_number() OVER (ORDER BY article.createtime DESC, article.id DESC) AS ordinal,
                    count(*) OVER () AS article_count,
                    count(*) FILTER (
                        WHERE left(article.title, length(@OwnerPrefix)) = @OwnerPrefix
                    ) OVER () AS owned_article_count
                FROM article
                JOIN article_publication publication
                  ON publication.id = article.current_publication_id
                JOIN article_revision revision
                  ON revision.id = publication.article_revision_id
                WHERE article.isdeleted = false
                  AND article.status = @PublishedStatus
                  AND article.current_publication_id IS NOT NULL
                  AND (article.published_at IS NULL OR article.published_at <= @NowUtc)
                  AND (article.scheduled_publish_at IS NULL OR article.scheduled_publish_at <= @NowUtc)
            )
            SELECT id, createtime, ordinal, article_count, owned_article_count
            FROM visible
            WHERE ordinal IN (@Page10Boundary, @Page100Boundary, @Page1000Boundary)
            ORDER BY ordinal;
            """,
            new SugarParameter("@OwnerPrefix", ownerPrefix),
            new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published),
            new SugarParameter("@NowUtc", timeProvider.GetUtcNow().UtcDateTime),
            new SugarParameter("@Page10Boundary", precedingItemCounts[0]),
            new SugarParameter("@Page100Boundary", precedingItemCounts[1]),
            new SugarParameter("@Page1000Boundary", precedingItemCounts[2])))
        {
            int index = 0;
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                if (index >= s_paginationLogicalPages.Length)
                {
                    throw new InvalidOperationException("pagination fixture returned unexpected boundary rows");
                }
                articleCount = checked(Convert.ToInt32(reader.GetInt64(reader.GetOrdinal("article_count"))));
                ownedArticleCount = checked(Convert.ToInt32(reader.GetInt64(reader.GetOrdinal("owned_article_count"))));
                int precedingItemCount = checked(Convert.ToInt32(reader.GetInt64(reader.GetOrdinal("ordinal"))));
                rows.Add(new PublicContentPaginationBoundaryRow(
                    s_paginationLogicalPages[index],
                    reader.GetInt32(reader.GetOrdinal("id")),
                    NormalizeUtc(reader.GetDateTime(reader.GetOrdinal("createtime"))),
                    SortValue: 0,
                    precedingItemCount));
                index++;
            }
        }

        if (ownedArticleCount < PaginationArticleCount)
        {
            throw new InvalidOperationException(
                $"pagination fixture exposes {ownedArticleCount} owned public latest rows; expected at least {PaginationArticleCount}");
        }
        return BuildPaginationProjection(
            generation,
            articleCount,
            ownedArticleCount,
            rows,
            articleListCursorCodec);
    }

    internal static PublicContentPaginationProjection BuildPaginationProjection(
        long generation,
        int articleCount,
        int ownedArticleCount,
        IReadOnlyList<PublicContentPaginationBoundaryRow> rows,
        IArticleListCursorCodec cursorCodec)
    {
        ArgumentNullException.ThrowIfNull(rows);
        ArgumentNullException.ThrowIfNull(cursorCodec);
        if (generation < 0 || articleCount < PaginationArticleCount || ownedArticleCount < PaginationArticleCount)
        {
            throw new InvalidOperationException("deep pagination projection requires a current generation and at least 10,020 visible owned articles");
        }
        if (rows.Count != s_paginationLogicalPages.Length)
        {
            throw new InvalidOperationException("deep pagination projection requires page 10/100/1000 boundaries");
        }

        var cursors = new List<PublicContentPaginationCursor>(rows.Count);
        for (int index = 0; index < rows.Count; index++)
        {
            PublicContentPaginationBoundaryRow row = rows[index];
            int expectedPage = s_paginationLogicalPages[index];
            int expectedPreceding = checked((expectedPage - 1) * PaginationPageSize);
            if (row.LogicalPage != expectedPage
                || row.PrecedingItemCount != expectedPreceding
                || row.ArticleId <= 0
                || row.SortValue != 0)
            {
                throw new InvalidOperationException($"deep pagination boundary {index} is not the canonical latest-keyset boundary");
            }

            string cursor = cursorCodec.Encode(
                new ArticleListCursorPosition(row.CreateTimeUtc, row.ArticleId, row.SortValue),
                categoryId: null,
                tagId: null,
                normalizedKeyword: string.Empty,
                pageSize: PaginationPageSize,
                queryVersion: generation,
                sort: ArticleListSortMode.Latest);
            cursors.Add(new PublicContentPaginationCursor(
                row.LogicalPage,
                cursor,
                new PublicContentPaginationBoundaryIdentity(
                    row.ArticleId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    row.CreateTimeUtc,
                    row.SortValue,
                    row.PrecedingItemCount)));
        }

        return new PublicContentPaginationProjection
        {
            PageSize = PaginationPageSize,
            Generation = generation,
            ArticleCount = articleCount,
            OwnedArticleCount = ownedArticleCount,
            Cursors = cursors
        };
    }

    internal static void AddPaginationBoundaryEvidence(
        List<PublicContentEntityIdentity> identities,
        List<PublicContentObservedEntity> observations,
        string ownerPrefix,
        PublicContentPaginationCursor pageCursor)
    {
        ArgumentNullException.ThrowIfNull(identities);
        ArgumentNullException.ThrowIfNull(observations);
        ArgumentException.ThrowIfNullOrWhiteSpace(ownerPrefix);
        ArgumentNullException.ThrowIfNull(pageCursor);
        string articleId = pageCursor.BoundaryIdentity.ArticleId;
        if (!identities.Any(item => item.Kind == "article" && item.Id == articleId))
        {
            identities.Add(new(
                "article",
                articleId,
                $"{ownerPrefix}:pagination-boundary:{pageCursor.LogicalPage}",
                "article-pagination-deep"));
        }
        if (!observations.Any(item => item.Kind == "article"
            && item.Id == articleId
            && item.CapabilityHint == "article-pagination-deep"))
        {
            observations.Add(new PublicContentObservedEntity
            {
                Kind = "article",
                Id = articleId,
                CapabilityHint = "article-pagination-deep",
                Fields = new Dictionary<string, object?>
                {
                    ["status"] = "published",
                    ["deleted"] = false,
                    ["logicalPage"] = pageCursor.LogicalPage,
                    ["boundaryIdentity"] = pageCursor.BoundaryIdentity
                }
            });
        }
    }

    private static DateTime NormalizeUtc(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };

    private async Task CleanupOwnedAsync(string ownerPrefix, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            WITH deep_articles AS (
                SELECT id
                FROM article
                WHERE left(title, length(@DeepPrefix)) = @DeepPrefix
            ), deleted_publications AS (
                DELETE FROM article_publication
                WHERE article_id IN (SELECT id FROM deep_articles)
            ), deleted_revisions AS (
                DELETE FROM article_revision
                WHERE article_id IN (SELECT id FROM deep_articles)
            ), deleted_tags AS (
                DELETE FROM article_tag
                WHERE articleid IN (SELECT id FROM deep_articles)
            ), deleted_bodies AS (
                DELETE FROM article_body
                WHERE article_id IN (SELECT id FROM deep_articles)
            )
            DELETE FROM article
            WHERE id IN (SELECT id FROM deep_articles);
            """,
            new SugarParameter("@DeepPrefix", $"{ownerPrefix}:pagination:")).ConfigureAwait(false);
        List<Article> owned = await db.Queryable<Article>()
            .Where(item => item.Title.StartsWith(ownerPrefix))
            .ToListAsync()
            .ConfigureAwait(false);
        foreach (Article article in owned)
        {
            if (!article.IsDeleted)
            {
                await articles.DeleteAsync(new ArticleIdCommand(article.Id), cancellationToken).ConfigureAwait(false);
            }

            await articles.PermanentlyDeleteArticleAsync(new ArticleIdCommand(article.Id), cancellationToken).ConfigureAwait(false);
        }

        List<Category> categories = await db.Queryable<Category>()
            .Where(item => item.Name.StartsWith(ownerPrefix))
            .ToListAsync()
            .ConfigureAwait(false);
        foreach (Category category in categories)
        {
            await db.Deleteable<Category>().Where(item => item.Id == category.Id).ExecuteCommandAsync()
                .ConfigureAwait(false);
        }

        List<Tag> tags = await db.Queryable<Tag>()
            .Where(item => item.Name.StartsWith(ownerPrefix))
            .ToListAsync()
            .ConfigureAwait(false);
        foreach (Tag tag in tags)
        {
            await db.Deleteable<Tag>().Where(item => item.Id == tag.Id).ExecuteCommandAsync()
                .ConfigureAwait(false);
        }
    }

    private async Task SeedLifecycleArticleAsync(
        SeedArticlePlan plan,
        int categoryId,
        int tagId,
        List<PublicContentEntityIdentity> identities,
        List<PublicContentObservedEntity> observed,
        string capabilityHint,
        CancellationToken cancellationToken)
    {
        int id = await CreateArticleAsync(plan, categoryId, tagId, cancellationToken).ConfigureAwait(false);
        Article row = await LoadArticleAsync(id, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"{plan.Role} article missing");
        List<long> revisionIds = await LoadRevisionIdsAsync(id, cancellationToken).ConfigureAwait(false);
        identities.Add(new("article", id.ToString(System.Globalization.CultureInfo.InvariantCulture), plan.Title, capabilityHint));
        observed.Add(StatusEntity(id, plan.Status.ToString().ToLowerInvariant(), capabilityHint, row, revisionIds));
    }

    private static PublicContentObservedEntity StatusEntity(int id, string status, string capabilityHint, Article row, List<long> revisionIds)
        => new()
        {
            Kind = "article",
            Id = id.ToString(System.Globalization.CultureInfo.InvariantCulture),
            CapabilityHint = capabilityHint,
            Fields = new Dictionary<string, object?>
            {
                ["status"] = status,
                ["deleted"] = row.IsDeleted,
                ["isDeleted"] = row.IsDeleted,
                ["currentPublicationId"] = row.CurrentPublicationId,
                ["currentRevisionId"] = row.CurrentRevisionId,
                ["scheduledPublishAt"] = row.ScheduledPublishAt,
                ["archivedAt"] = row.ArchivedAt,
                ["revisionIds"] = revisionIds.Select(static revisionId => revisionId.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray()
            }
        };

    private async Task DrainArticleMutationOutboxAsync(CancellationToken cancellationToken)
    {
        for (int pass = 0; pass < MaxOutboxDrainPasses; pass++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int pending = await db.Queryable<ArticleMutationOutboxEvent>()
                .Where(item => item.Status == "pending" || item.Status == "processing")
                .CountAsync(cancellationToken).ConfigureAwait(false);
            if (pending == 0)
            {
                return;
            }
            if (await db.Queryable<ArticleMutationOutboxEvent>()
                    .Where(item => item.Status == "poison")
                    .AnyAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException("Article mutation outbox did not reach exact processed state.");
            }
            // Rows may be in-flight under the hosted dispatcher's claim lease; give the
            // current claim owner a bounded window to commit before the next pass.
            await Task.Delay(s_outboxDrainPassDelay, cancellationToken).ConfigureAwait(false);
            await RunDispatcherPassAsync(cancellationToken).ConfigureAwait(false);
        }
        throw new InvalidOperationException("Article mutation outbox did not converge within the bounded worker drain.");
    }

    private async Task RunDispatcherPassAsync(CancellationToken cancellationToken)
    {
        // The dispatcher's commit guard requires an ambient release execution ticket,
        // which the hosted fenced lease supplies per iteration; replicate that context.
        if (activeReleaseFence is null || releaseExecutionContext is null)
        {
            await articleOutboxDispatcher.ProcessPendingAsync(cancellationToken).ConfigureAwait(false);
            return;
        }
        ActiveReleaseExecutionTicket? ticket = await activeReleaseFence
            .TryCaptureExecutionTicketAsync(cancellationToken).ConfigureAwait(false);
        if (ticket is null)
        {
            throw new InvalidOperationException("Article mutation outbox drain requires an active release execution ticket.");
        }
        using IDisposable executionScope = releaseExecutionContext.Push(ticket);
        await articleOutboxDispatcher.ProcessPendingAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<int> CreateArticleAsync(
        SeedArticlePlan plan,
        int categoryId,
        int tagId,
        CancellationToken cancellationToken)
    {
        int id = await articles.CreateAsync(
            new CreateArticleCommand(
                BuildWriteRequest(
                    plan.Title,
                    plan.Markdown,
                    plan.Summary,
                    plan.CoverImageUrl,
                    categoryId,
                    tagId,
                    plan.Status,
                    plan.ScheduledPublishAt)),
            cancellationToken).ConfigureAwait(false);
        if (id <= 0)
        {
            throw new InvalidOperationException($"domain CreateAsync failed for {plan.Role}");
        }

        return id;
    }

    private static ArticleWriteRequestCoreModel BuildWriteRequest(
        string title,
        string markdown,
        string? summary,
        string? coverImageUrl,
        int categoryId,
        int tagId,
        ArticleStatus status,
        DateTime? scheduledPublishAt = null,
        long? baseRevisionId = null)
        => new(
            title,
            markdown,
            summary,
            coverImageUrl,
            categoryId,
            new[] { tagId },
            (int)status,
            scheduledPublishAt,
            BaseRevisionId: baseRevisionId);

    private async Task<long> RequireCurrentRevisionIdAsync(
        int articleId,
        CancellationToken cancellationToken)
    {
        Article row = await LoadArticleAsync(articleId, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"owned article {articleId} missing before update");
        return row.CurrentRevisionId
            ?? throw new InvalidOperationException($"owned article {articleId} has no current revision before update");
    }

    private async Task SetViewsAsync(int articleId, int views, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Updateable<Article>()
            .SetColumns(item => item.Views == views)
            .Where(item => item.Id == articleId)
            .ExecuteCommandAsync()
            .ConfigureAwait(false);
    }

    internal static async Task<(Category Category, Tag Tag)> EnsureTaxonomyAsync(
        Func<string, CancellationToken, Task<Category>> ensureCategory,
        Func<string, CancellationToken, Task<Tag>> ensureTag,
        ICacheInvalidationDispatcher cacheInvalidation,
        string ownerPrefix,
        CancellationToken cancellationToken)
    {
        Category category = await ensureCategory(
                $"{ownerPrefix}:category",
                cancellationToken)
            .ConfigureAwait(false);
        Tag tag = await ensureTag(
                $"{ownerPrefix}:tag",
                cancellationToken)
            .ConfigureAwait(false);
        await cacheInvalidation.InvalidateCategoryTagAsync(cancellationToken).ConfigureAwait(false);
        return (category, tag);
    }

    private async Task<Category> EnsureCategoryAsync(string name, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        List<Category> existing = await db.Queryable<Category>()
            .Where(item => item.Name == name)
            .Take(1)
            .ToListAsync()
            .ConfigureAwait(false);
        if (existing.Count > 0)
        {
            return existing[0];
        }

        int id = await db.Insertable(new Category { Name = name }).ExecuteReturnIdentityAsync()
            .ConfigureAwait(false);
        return await db.Queryable<Category>().InSingleAsync(id).ConfigureAwait(false)
            ?? throw new InvalidOperationException("category insert failed");
    }

    private async Task<Tag> EnsureTagAsync(string name, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        List<Tag> existing = await db.Queryable<Tag>()
            .Where(item => item.Name == name)
            .Take(1)
            .ToListAsync()
            .ConfigureAwait(false);
        if (existing.Count > 0)
        {
            return existing[0];
        }

        int id = await db.Insertable(new Tag { Name = name }).ExecuteReturnIdentityAsync()
            .ConfigureAwait(false);
        return await db.Queryable<Tag>().InSingleAsync(id).ConfigureAwait(false)
            ?? throw new InvalidOperationException("tag insert failed");
    }

    private Task<Article?> LoadArticleAsync(int id, CancellationToken cancellationToken)
        => LoadArticleAsync(id, includeDeleted: false, cancellationToken);

    private async Task<Article?> LoadArticleAsync(int id, bool includeDeleted, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _ = includeDeleted;
        List<Article> rows = await db.Queryable<Article>()
            .Where(item => item.Id == id)
            .Take(1)
            .ToListAsync()
            .ConfigureAwait(false);
        return rows.Count > 0 ? rows[0] : null;
    }

    private async Task<List<long>> LoadRevisionIdsAsync(int articleId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        List<ArticleRevision> revisions = await db.Queryable<ArticleRevision>()
            .Where(item => item.ArticleId == articleId)
            .OrderBy(item => item.RevisionNo)
            .ToListAsync()
            .ConfigureAwait(false);
        return revisions.Select(static item => item.Id).ToList();
    }

    private sealed record SeedArticlePlan(
        string Role,
        string Title,
        string Summary,
        string Markdown,
        string? CoverImageUrl,
        int Views,
        ArticleStatus Status,
        DateTime? ScheduledPublishAt = null);

    private async Task<PublicContentFixtureResult> PrepareSecurityMatrixAsync(
        PublicContentSecurityMatrixRequest matrix,
        IReadOnlyList<string> capabilities,
        string ns,
        string ownerPrefix,
        CancellationToken cancellationToken)
    {
        if (matrix.Cases is null || matrix.Cases.Count is < 1 or > 256)
        {
            throw new InvalidOperationException("security matrix requires between 1 and 256 cases");
        }

        PublicContentSecurityCase[] cases = matrix.Cases
            .Select(static item => item with
            {
                Id = item.Id?.Trim() ?? string.Empty,
                Category = item.Category?.Trim() ?? string.Empty,
                Markdown = item.Markdown ?? string.Empty
            })
            .ToArray();
        if (cases.Any(static item =>
                !System.Text.RegularExpressions.Regex.IsMatch(
                    item.Id,
                    "^mxss-[a-z0-9]+(?:-[a-z0-9]+)*$",
                    System.Text.RegularExpressions.RegexOptions.CultureInvariant)
                || item.Category.Length == 0
                || item.Markdown.Length == 0
                || item.Markdown.Length > 64 * 1024)
            || cases.Select(static item => item.Id).Distinct(StringComparer.Ordinal).Count() != cases.Length)
        {
            throw new InvalidOperationException("security matrix cases are invalid or duplicated");
        }

        await CleanupOwnedAsync(ownerPrefix, cancellationToken).ConfigureAwait(false);

        string metadata = matrix.MetadataText?.Trim() ?? string.Empty;
        if (metadata.Length == 0 || metadata.IndexOf('\0') >= 0)
        {
            throw new InvalidOperationException("security matrix metadata probe is missing or contains NUL");
        }

        static string Fit(string value) => value.Length <= 128 ? value : value[..128];
        var category = new Category { Name = Fit($"{ownerPrefix}:category:{metadata}") };
        category.Id = await db.Insertable(category).ExecuteReturnIdentityAsync(cancellationToken).ConfigureAwait(false);
        var tag = new Tag { Name = Fit($"{ownerPrefix}:tag:{metadata}") };
        tag.Id = await db.Insertable(tag).ExecuteReturnIdentityAsync(cancellationToken).ConfigureAwait(false);

        int actorUserId = matrix.ActorUserId.GetValueOrDefault();
        if (actorUserId <= 0)
        {
            actorUserId = await db.Queryable<User>()
                .Where(static user => user.PublicHandle != null)
                .OrderBy(static user => user.Id)
                .Select(static user => user.Id)
                .FirstAsync(cancellationToken)
                .ConfigureAwait(false);
        }
        if (actorUserId <= 0)
        {
            throw new InvalidOperationException("security matrix requires a prepared public account fixture");
        }

        bool aboutPrepared = await system.UpdatePageContentAsync(new UpdatePageContentRequest
        {
            Slug = "about",
            Content = matrix.AboutMarkdown
        }).ConfigureAwait(false);
        if (!aboutPrepared)
        {
            throw new InvalidOperationException("security matrix failed to prepare the about page through the system service");
        }

        var identities = new List<PublicContentEntityIdentity>
        {
            new("category", category.Id.ToString(System.Globalization.CultureInfo.InvariantCulture), "metadata:category", "security-xss"),
            new("tag", tag.Id.ToString(System.Globalization.CultureInfo.InvariantCulture), "metadata:tag", "security-xss")
        };
        var observed = new List<PublicContentObservedEntity>();
        var publishedIds = new List<string>();

        for (int caseIndex = 0; caseIndex < cases.Length; caseIndex++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            PublicContentSecurityCase securityCase = cases[caseIndex];
            string title = $"{ownerPrefix}:matrix:{caseIndex + 1}";
            string summary = metadata.Length <= 512 ? metadata : metadata[..512];
            string safeMarkdown = $"# Security fixture placeholder {caseIndex + 1}.";
            int articleId;
            try
            {
                articleId = await CreateArticleAsync(
                        new SeedArticlePlan(
                            $"security-{securityCase.Id}",
                            title,
                            "Pending security fixture metadata injection.",
                            safeMarkdown,
                            null,
                            1,
                            ArticleStatus.Published),
                        category.Id,
                        tag.Id,
                        cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    $"security matrix article preparation failed for {securityCase.Id}: {ex.Message}",
                    ex);
            }
            Article article = await LoadArticleAsync(articleId, cancellationToken).ConfigureAwait(false)
                ?? throw new InvalidOperationException($"security matrix article missing for {securityCase.Id}");
            ArticleRevision revision = await db.Queryable<ArticleRevision>()
                .Where(item => item.Id == article.CurrentRevisionId)
                .FirstAsync(cancellationToken)
                .ConfigureAwait(false)
                ?? throw new InvalidOperationException($"security matrix revision missing for {securityCase.Id}");
            revision.ContentBlockId = await FsusBlog.Server.Services.Articles.ArticleRevisionContentBlockStore.GetOrCreateAsync(
                    db,
                    securityCase.Markdown,
                    timeProvider.GetUtcNow().UtcDateTime,
                    cancellationToken)
                .ConfigureAwait(false);
            revision.MarkdownContent = string.Empty;
            revision.Summary = summary;
            await db.Updateable(revision)
                .UpdateColumns(static item => new { item.ContentBlockId, item.MarkdownContent, item.Summary })
                .ExecuteCommandAsync(cancellationToken)
                .ConfigureAwait(false);
            await SetViewsAsync(articleId, 1, cancellationToken).ConfigureAwait(false);

            bool rootCreated = await comments.CreateCommentAsync(actorUserId, new CommentDto
            {
                ArticleId = articleId,
                Content = $"Security fixture comment {caseIndex + 1}",
                AuthorMode = "public",
                PublicSendExplicitlySelected = true,
                DisplayLanguage = "auto"
            }).ConfigureAwait(false);
            if (!rootCreated)
            {
                throw new InvalidOperationException($"security matrix comment seed failed for {securityCase.Id}");
            }

            Comment? rootComment = await db.Queryable<Comment>()
                .Where(item => item.ArticleId == articleId && item.UserId == actorUserId && item.ParentId == null)
                .OrderBy(static item => item.Id, OrderByType.Desc)
                .FirstAsync(cancellationToken)
                .ConfigureAwait(false);
            if (rootComment is null)
            {
                throw new InvalidOperationException($"security matrix comment observation missing for {securityCase.Id}");
            }
            rootComment.Content = securityCase.Markdown;
            rootComment.ModerationStatus = CommentModerationStatus.Approved;
            await db.Updateable(rootComment)
                .UpdateColumns(static item => new { item.Content, item.ModerationStatus })
                .ExecuteCommandAsync(cancellationToken)
                .ConfigureAwait(false);

            bool replyCreated = await comments.CreateCommentAsync(actorUserId, new CommentDto
            {
                ArticleId = articleId,
                Content = $"Security fixture reply {caseIndex + 1}",
                ParentId = rootComment.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                RootId = rootComment.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ReplyToCommentId = rootComment.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                AuthorMode = "public",
                PublicSendExplicitlySelected = true,
                DisplayLanguage = "auto"
            }).ConfigureAwait(false);
            if (!replyCreated)
            {
                throw new InvalidOperationException($"security matrix reply seed failed for {securityCase.Id}");
            }

            Comment? reply = await db.Queryable<Comment>()
                .Where(item => item.ArticleId == articleId && item.ParentId == rootComment.Id)
                .OrderBy(static item => item.Id, OrderByType.Desc)
                .FirstAsync(cancellationToken)
                .ConfigureAwait(false);
            if (reply is null)
            {
                throw new InvalidOperationException($"security matrix reply observation missing for {securityCase.Id}");
            }
            reply.Content = securityCase.Markdown;
            reply.ModerationStatus = CommentModerationStatus.Approved;
            await db.Updateable(reply)
                .UpdateColumns(static item => new { item.Content, item.ModerationStatus })
                .ExecuteCommandAsync(cancellationToken)
                .ConfigureAwait(false);
            await cacheInvalidation.InvalidateArticleMutationAsync(articleId, cancellationToken)
                .ConfigureAwait(false);
            await cacheInvalidation.InvalidateCommentMutationAsync(
                    new CommentCacheInvalidationScope(
                        ArticleId: articleId,
                        RootId: rootComment.Id,
                        AccountId: actorUserId,
                        PublicArticleChanged: true,
                        UserCommentsChanged: true),
                    cancellationToken)
                .ConfigureAwait(false);

            string articleIdText = articleId.ToString(System.Globalization.CultureInfo.InvariantCulture);
            string rootIdText = rootComment.Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
            string replyIdText = reply.Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
            publishedIds.Add(articleIdText);
            identities.Add(new("article", articleIdText, $"{securityCase.Id}:article", "security-xss"));
            identities.Add(new("comment", rootIdText, $"{securityCase.Id}:comment", "security-xss"));
            identities.Add(new("comment", replyIdText, $"{securityCase.Id}:reply", "security-xss"));
            observed.Add(new PublicContentObservedEntity
            {
                Kind = "article",
                Id = articleIdText,
                CapabilityHint = "security-xss",
                Fields = new Dictionary<string, object?>
                {
                    ["caseId"] = securityCase.Id,
                    ["category"] = securityCase.Category,
                    ["status"] = "published",
                    ["commentId"] = rootIdText,
                    ["replyId"] = replyIdText,
                    ["title"] = title
                }
            });
        }

        int[] publishedArticleIds = publishedIds.Select(static id => int.Parse(
            id,
            System.Globalization.CultureInfo.InvariantCulture)).ToArray();
        if (OwnsSecurityMatrixOutbox(configuration))
        {
            await DiscardOwnedSecurityMatrixOutboxAsync(publishedArticleIds, cancellationToken)
                .ConfigureAwait(false);
        }
        else
        {
            await AwaitSecurityMatrixPublicationConvergenceAsync(
                    publishedArticleIds,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        return new PublicContentFixtureResult
        {
            Strategy = Strategy,
            Mode = "security-xss-matrix",
            EntityIdentities = identities,
            Observations = new PublicContentObservations
            {
                Database = new PublicContentDatabaseObservation
                {
                    Namespace = ns,
                    Entities = observed
                }
            },
            Projection = new PublicContentProjectionHints
            {
                ArticleId = publishedIds[0],
                CategoryId = category.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                TagId = tag.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                PublishedArticleIds = publishedIds
            },
            ProvidedCapabilities = capabilities
        };
    }

    internal static bool OwnsSecurityMatrixOutbox(IConfiguration configuration)
        => configuration.GetValue<bool?>("PublicContentFixture:SecurityMatrixOwnsOutbox") == true
            && configuration.GetValue<bool?>("ArticleMutationOutbox:Enabled") == false;

    private async Task DiscardOwnedSecurityMatrixOutboxAsync(
        IReadOnlyCollection<int> articleIds,
        CancellationToken cancellationToken)
    {
        int[] selectedArticleIds = articleIds.ToArray();
        List<long> outboxIds = await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(item => selectedArticleIds.Contains(item.AggregateId))
            .Select(static item => item.Id)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (outboxIds.Count > 0)
        {
            await db.Deleteable<ArticleMutationOutboxEdge>()
                .Where(item => outboxIds.Contains(item.OutboxEventId))
                .ExecuteCommandAsync(cancellationToken)
                .ConfigureAwait(false);
            await db.Deleteable<ArticleMutationOutboxEvent>()
                .Where(item => selectedArticleIds.Contains(item.AggregateId))
                .ExecuteCommandAsync(cancellationToken)
                .ConfigureAwait(false);
        }

        await AwaitSecurityMatrixOwnedOutboxHandoffAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task AwaitSecurityMatrixOwnedOutboxHandoffAsync(CancellationToken cancellationToken)
    {
        long startedAt = timeProvider.GetTimestamp();
        IReadOnlyList<PublicArtifactTombstone> tombstones = [];
        IReadOnlyList<PublicArtifactTombstone> durableTombstones = [];
        PublicHotArtifactObligation? obligation = null;
        long? readySince = null;
        while (timeProvider.GetElapsedTime(startedAt) < s_securityMatrixConvergenceTimeout)
        {
            cancellationToken.ThrowIfCancellationRequested();
            tombstones = publicArtifactRevocations.Snapshot();
            durableTombstones = await publicArtifactRevocationState.LoadActiveAsync(cancellationToken)
                .ConfigureAwait(false);
            obligation = await publicHotObligations.GetActiveAsync(cancellationToken).ConfigureAwait(false);
            if (IsSecurityMatrixOwnedOutboxHandoffReady(tombstones, durableTombstones, obligation))
            {
                readySince ??= timeProvider.GetTimestamp();
                if (timeProvider.GetElapsedTime(readySince.Value) >= s_securityMatrixHandoffQuietPeriod)
                {
                    return;
                }
            }
            else
            {
                readySince = null;
            }

            await Task.Delay(s_securityMatrixConvergencePollInterval, cancellationToken).ConfigureAwait(false);
        }

        tombstones = publicArtifactRevocations.Snapshot();
        string activeTombstones = string.Join(
            ",",
            tombstones
                .Select(static item => $"{item.ArticleId}:{item.Generation}")
                .Order(StringComparer.Ordinal));
        string durableActiveTombstones = string.Join(
            ",",
            durableTombstones
                .Select(static item => $"{item.ArticleId}:{item.Generation}")
                .Order(StringComparer.Ordinal));
        throw new TimeoutException(
            "security matrix owned outbox handoff did not reach a published public artifact obligation "
            + $"(obligation={obligation?.ObligationId ?? "<none>"}:{obligation?.State.ToString() ?? "<none>"}:"
            + $"{obligation?.TargetGeneration.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "<none>"}, "
            + $"tombstones=[{activeTombstones}], durableTombstones=[{durableActiveTombstones}])");
    }

    internal static bool IsSecurityMatrixOwnedOutboxHandoffReady(
        IReadOnlyCollection<PublicArtifactTombstone> tombstones,
        IReadOnlyCollection<PublicArtifactTombstone> durableTombstones,
        PublicHotArtifactObligation? obligation)
        => tombstones.Count == 0
            && durableTombstones.Count == 0
            && obligation is null or { State: PublicHotArtifactObligationState.Published };

    private async Task AwaitSecurityMatrixPublicationConvergenceAsync(
        IReadOnlyCollection<int> articleIds,
        CancellationToken cancellationToken)
    {
        long startedAt = timeProvider.GetTimestamp();
        IReadOnlyList<ArticleMutationOutboxEvent> outboxEvents = [];
        IReadOnlyList<PublicArtifactTombstone> tombstones = [];
        int[] selectedArticleIds = articleIds.ToArray();

        while (timeProvider.GetElapsedTime(startedAt) < s_securityMatrixConvergenceTimeout)
        {
            cancellationToken.ThrowIfCancellationRequested();
            outboxEvents = await db.Queryable<ArticleMutationOutboxEvent>()
                .Where(item => selectedArticleIds.Contains(item.AggregateId))
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            tombstones = publicArtifactRevocations.Snapshot();
            if (IsSecurityMatrixPublicationConverged(selectedArticleIds, outboxEvents, tombstones))
            {
                return;
            }

            await Task.Delay(s_securityMatrixConvergencePollInterval, cancellationToken).ConfigureAwait(false);
        }

        string pendingEvents = string.Join(
            ",",
            outboxEvents
                .Where(item => !string.Equals(item.Status, "processed", StringComparison.Ordinal))
                .Select(static item => $"{item.AggregateId}:{item.EventType}:{item.Status}")
                .Order(StringComparer.Ordinal));
        string activeTombstones = string.Join(
            ",",
            tombstones
                .Select(static item => $"{item.ArticleId}:{item.Generation}")
                .Order(StringComparer.Ordinal));
        throw new TimeoutException(
            "security matrix publication did not converge before fixture handoff "
            + $"(articles={selectedArticleIds.Length}, events={outboxEvents.Count}, "
            + $"pending=[{pendingEvents}], tombstones=[{activeTombstones}])");
    }

    internal static bool IsSecurityMatrixPublicationConverged(
        IReadOnlyCollection<int> articleIds,
        IReadOnlyCollection<ArticleMutationOutboxEvent> outboxEvents,
        IReadOnlyCollection<PublicArtifactTombstone> tombstones)
    {
        if (articleIds.Count == 0 || tombstones.Count > 0)
        {
            return false;
        }

        var articlesWithEvents = new HashSet<int>();
        foreach (ArticleMutationOutboxEvent item in outboxEvents)
        {
            articlesWithEvents.Add(item.AggregateId);
            if (!string.Equals(item.Status, "processed", StringComparison.Ordinal))
            {
                return false;
            }
        }

        return articleIds.All(articlesWithEvents.Contains);
    }

    public static string SerializeResult(PublicContentFixtureResult result)
        => JsonSerializer.Serialize(result, s_json);
}
