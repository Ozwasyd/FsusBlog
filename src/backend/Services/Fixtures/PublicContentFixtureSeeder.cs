// fixture-catalog: producer public-content
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

/// <summary>
/// Test-only public content fixture composition root (#1712).
/// Calls application/domain ports (IArticleCoreGateway, IAdminArtifactOperations)
/// and owned-namespace taxonomy inserts — never public/admin HTTP APIs, never Node SQL.
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
    JsonElement? TemporalContext = null);

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
}

public sealed class PublicContentFixtureSeeder(
    IArticleCoreGateway articles,
    ISqlSugarClient db,
    IAdminArtifactOperations artifactOperations,
    ISearchIndexService searchIndex,
    TimeProvider timeProvider) : IPublicContentFixtureSeeder
{
    private const string Strategy = "transaction-fixture";
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

        string ns = string.IsNullOrWhiteSpace(request.Namespace) ? "local" : request.Namespace.Trim();
        string runToken = string.IsNullOrWhiteSpace(request.RunId)
            ? "run"
            : new string(request.RunId.Where(static ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_').Take(24).ToArray());
        string ownerPrefix = $"fxpc:{ns}:{runToken}";

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

        Category category = await EnsureCategoryAsync($"{ownerPrefix}:category", cancellationToken).ConfigureAwait(false);
        Tag tag = await EnsureTagAsync($"{ownerPrefix}:tag", cancellationToken).ConfigureAwait(false);
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
            entityIdentities.Add(new("article", archivedId.ToString(System.Globalization.CultureInfo.InvariantCulture), row.Title, "article-archived"));
            observed.Add(StatusEntity(archivedId, "archived", "article-archived", row));
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
        AdminCacheActionResponse searchRebuild = await artifactOperations.RunCacheActionAsync(
            new AdminCacheActionRequest("search-rebuild"),
            cancellationToken).ConfigureAwait(false);
        if (!string.Equals(searchRebuild.Status, "ok", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"search-rebuild failed: {searchRebuild.Status} {searchRebuild.Detail}");
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

        List<Article> searchHits = await searchIndex.SearchAsync(searchToken).ConfigureAwait(false);
        bool searchHit = searchHits.Any(item => publishedIds.Contains(item.Id));
        if (!searchHit && capabilities.Contains("public.search.indexed", StringComparer.Ordinal))
        {
            throw new InvalidOperationException($"search token '{searchToken}' did not hit owned published article");
        }

        CorePageResult<ArticleListCoreModel> list = await articles.GetPageListAsync(
            new ArticlePageQuery(1, 10, category.Id, tag.Id, IsDeleted: false, Status: (int)ArticleStatus.Published),
            cancellationToken).ConfigureAwait(false);
        var listIds = list.Items.Select(static item => item.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray();
        foreach (int publishedId in publishedIds)
        {
            string idText = publishedId.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (!listIds.Contains(idText, StringComparer.Ordinal))
            {
                throw new InvalidOperationException($"public list missing owned published article {publishedId}");
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
            Mode = capabilities.Contains("public.article.draft", StringComparer.Ordinal) ? "public-content-lifecycle" : "public-minimal",
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
                HotOrder = hotOrder
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
                    Generation = timeProvider.GetUtcNow().ToUnixTimeMilliseconds(),
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

    private async Task CleanupOwnedAsync(string ownerPrefix, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
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
        identities.Add(new("article", id.ToString(System.Globalization.CultureInfo.InvariantCulture), plan.Title, capabilityHint));
        observed.Add(StatusEntity(id, plan.Status.ToString().ToLowerInvariant(), capabilityHint, row));
    }

    private static PublicContentObservedEntity StatusEntity(int id, string status, string capabilityHint, Article row)
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
                ["archivedAt"] = row.ArchivedAt
            }
        };

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

    public static string SerializeResult(PublicContentFixtureResult result)
        => JsonSerializer.Serialize(result, s_json);
}
