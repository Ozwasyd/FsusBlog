using System.Data.Common;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IAotSeoConfigSnapshot
{
    Task<PublicAotSeoSnapshot> GetAsync(CancellationToken cancellationToken = default);

    void Invalidate();
}

public sealed class AotSeoConfigSnapshot(IServiceScopeFactory scopeFactory) : IAotSeoConfigSnapshot
{
    private static readonly TimeSpan s_aotSeoConfigSnapshotTtl = TimeSpan.FromSeconds(30);
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private PublicAotSeoSnapshot? _snapshot;
    private DateTimeOffset _expiresAtUtc;

    public async Task<PublicAotSeoSnapshot> GetAsync(CancellationToken cancellationToken = default)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        PublicAotSeoSnapshot? snapshot = Volatile.Read(ref _snapshot);
        if (snapshot is not null && now < _expiresAtUtc)
        {
            FsusObservability.RecordPublicAotBootstrapSeoSnapshot(cacheHit: true);
            return snapshot;
        }

        await _refreshGate.WaitAsync(cancellationToken);
        try
        {
            now = DateTimeOffset.UtcNow;
            snapshot = Volatile.Read(ref _snapshot);
            if (snapshot is not null && now < _expiresAtUtc)
            {
                FsusObservability.RecordPublicAotBootstrapSeoSnapshot(cacheHit: true);
                return snapshot;
            }

            using IServiceScope scope = scopeFactory.CreateScope();
            ISystemService systemService = scope.ServiceProvider.GetRequiredService<ISystemService>();
            // ISystemService and its SqlSugar client share this scope. Npgsql
            // permits only one active command per connection, so cache misses
            // must not overlap reads inside the same scope.
            SeoConfigReadModel seo = await systemService.GetSeoConfigAsync();
            SiteComplianceConfigReadModel compliance = await systemService.GetSiteComplianceConfigAsync();
            snapshot = new PublicAotSeoSnapshot(
                seo.Title,
                seo.Description,
                PublicAotBootstrapProviderBase.NormalizeBaseUrl(seo.BaseUrl),
                PublicAotBootstrapProviderBase.ToComplianceSnapshot(compliance),
                seo.Author,
                seo.SiteLogoUrl,
                seo.SiteLogoDarkUrl,
                seo.SiteWordmarkUrl,
                seo.LoginLogoUrl,
                seo.LoginIconUrl);
            Volatile.Write(ref _snapshot, snapshot);
            _expiresAtUtc = now.Add(s_aotSeoConfigSnapshotTtl);
            FsusObservability.RecordPublicAotBootstrapSeoSnapshot(cacheHit: false);
            return snapshot;
        }
        finally
        {
            _refreshGate.Release();
        }
    }

    public void Invalidate()
    {
        _expiresAtUtc = DateTimeOffset.MinValue;
    }
}

public abstract class PublicAotBootstrapProviderBase(IAotSeoConfigSnapshot seoConfigSnapshot) : IPublicAotBootstrapProvider
{
    public abstract PublicPageKind Kind
    {
        get;
    }

    public abstract Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(
        PublicAotRouteMatch match,
        CancellationToken cancellationToken = default);

    protected async Task<PublicAotSeoSnapshot> LoadSeoSnapshotAsync()
        => await seoConfigSnapshot.GetAsync();

    protected static PublicAotSeoSnapshot ToSeoSnapshot(SeoConfigReadModel seo)
        => new(
            seo.Title,
            seo.Description,
            NormalizeBaseUrl(seo.BaseUrl),
            SiteAuthor: seo.Author,
            SiteLogoUrl: seo.SiteLogoUrl,
            SiteLogoDarkUrl: seo.SiteLogoDarkUrl,
            SiteWordmarkUrl: seo.SiteWordmarkUrl,
            LoginLogoUrl: seo.LoginLogoUrl,
            LoginIconUrl: seo.LoginIconUrl);

    internal static PublicAotSiteComplianceSnapshot ToComplianceSnapshot(SiteComplianceConfigReadModel compliance)
        => new(
            compliance.Enabled,
            compliance.RegionMode,
            compliance.CopyrightOwner,
            compliance.CopyrightStartYear,
            compliance.CopyrightText,
            compliance.ContentLicenseName,
            compliance.ContentLicenseUrl,
            compliance.IcpRecordNumber,
            compliance.IcpRecordUrl,
            compliance.PoliceRecordNumber,
            compliance.PoliceRecordUrl,
            compliance.PoliceBadgeIconUrl,
            compliance.OperatorName,
            compliance.ContactEmail);

    internal static string? NormalizeBaseUrl(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim().TrimEnd('/');

    protected static PublicAotArticleSummarySnapshot ToArticleSummarySnapshot(ArticleListItemReadModel item)
        => new(
            item.Id,
            item.Title,
            item.Summary ?? item.Snippet ?? string.Empty,
            item.Views,
            item.CreateTime,
            new PublicAotArticleCategorySnapshot(
                item.CategoryId,
                string.IsNullOrWhiteSpace(item.CategoryName) ? "未分类" : item.CategoryName),
            item.Tags.Select(static tag => new PublicAotArticleTagSnapshot(tag.Id, tag.Name)).ToArray())
        {
            RevisionId = item.CurrentRevisionId,
            RevisionNo = item.RevisionNo,
            PublicationId = item.CurrentPublicationId,
            PublicationNo = item.PublicationNo
        };

    protected static PublicAotFeaturedArticleSnapshot ToFeaturedArticleSnapshot(FeaturedArticleSummaryDto item)
        => new(
            item.Id,
            item.Title,
            item.CoverImageUrl,
            item.Views,
            item.CreateTime,
            new PublicAotArticleCategorySnapshot(item.Category.Id, item.Category.Name));

    protected static PublicAotHotArticleSnapshot ToHotArticleSnapshot(PopularArticleSummaryDto item)
        => new(item.Id, item.Title, item.Views);

    protected static PublicAotArticleSummarySnapshot ToArticleSummarySnapshot(ArticleListCoreModel item)
        => new(
            item.Id,
            item.Title,
            item.Summary ?? item.Snippet ?? string.Empty,
            item.Views,
            item.CreateTime,
            new PublicAotArticleCategorySnapshot(item.Category.Id, item.Category.Name),
            item.Tags.Select(static tag => new PublicAotArticleTagSnapshot(tag.Id, tag.Name)).ToArray())
        {
            RevisionId = item.CurrentRevisionId,
            RevisionNo = item.RevisionNo,
            PublicationId = item.CurrentPublicationId,
            PublicationNo = item.PublicationNo
        };

    protected static PublicAotFeaturedArticleSnapshot ToFeaturedArticleSnapshot(FeaturedArticleCoreModel item)
        => new(item.Id, item.Title, item.CoverImageUrl, item.Views, item.CreateTime,
            new PublicAotArticleCategorySnapshot(item.Category.Id, item.Category.Name));

    protected static PublicAotHotArticleSnapshot ToHotArticleSnapshot(PopularArticleCoreModel item)
        => new(item.Id, item.Title, item.Views);
}

public sealed class PublicAotHomeBootstrapProvider(
    IArticleCoreService articleService,
    IAotSeoConfigSnapshot seoConfigSnapshot) : PublicAotBootstrapProviderBase(seoConfigSnapshot)
{
    public override PublicPageKind Kind => PublicPageKind.Home;

    public override async Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(PublicAotRouteMatch match, CancellationToken cancellationToken = default)
    {
        const int PageSize = 10;
        const int FeaturedSize = 3;
        const int HotSize = 5;
        const int PageIndex = 1;
        if (!PublicRouteIdentity.AllowsStaticArtifact(match))
        {
            return Result<PublicPageSnapshot>.Failure(ErrorCode.Validation, "public_aot_cursor_required");
        }
        PublicAotSeoSnapshot seo = await LoadSeoSnapshotAsync();
        var pageResult = await articleService.GetPageListAsync(
            new ArticlePageQuery(PageIndex, PageSize, null, null, false, UseSourceCache: false),
            cancellationToken);
        if (!pageResult.IsSuccess)
        {
            return Result<PublicPageSnapshot>.Failure(pageResult.Error.Code, pageResult.Error.Message);
        }
        CorePageResult<ArticleListCoreModel> page = pageResult.Value;
        if (IsPageOutOfRange(PageIndex, PageSize, page.Total))
        {
            return Result<PublicPageSnapshot>.Failure(ErrorCode.NotFound, "public_aot_page_out_of_range");
        }
        var featuredResult = await articleService.GetFeaturedArticlesAsync(new ArticleCountQuery(FeaturedSize), cancellationToken);
        var hotResult = await articleService.GetHotArticlesAsync(new ArticleCountQuery(HotSize), cancellationToken);
        IReadOnlyList<FeaturedArticleCoreModel> featuredArticles = featuredResult.IsSuccess && featuredResult.Value is not null ? featuredResult.Value : [];
        IReadOnlyList<PopularArticleCoreModel> hotArticles = hotResult.IsSuccess && hotResult.Value is not null ? hotResult.Value : [];

        return Result<PublicPageSnapshot>.Success(new PublicHomePageSnapshot(
            seo,
            Page: PageIndex,
            PageSize,
            page.Total,
            page.Items.Select(ToArticleSummarySnapshot).ToArray(),
            featuredArticles.Select(ToFeaturedArticleSnapshot).ToArray(),
            hotArticles.Select(ToHotArticleSnapshot).ToArray())
        {
            NextCursor = page.NextCursor,
            HasMore = page.HasMore
        });
    }

    private static bool IsPageOutOfRange(int page, int pageSize, int total)
        => page > Math.Max(1, (int)Math.Ceiling(total / (double)Math.Max(1, pageSize)));
}

public sealed class PublicAotArticleDetailBootstrapProvider(
    RelatedReadingService relatedReadingService,
    IAotSeoConfigSnapshot seoConfigSnapshot,
    IArticleResponsibilityManifestService responsibilityManifestService,
    ISqlSugarClient db,
    ArticleBodyRepairQueue articleBodyRepairQueue) : PublicAotBootstrapProviderBase(seoConfigSnapshot)
{
    public override PublicPageKind Kind => PublicPageKind.ArticleDetail;

    public override async Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(PublicAotRouteMatch match, CancellationToken cancellationToken = default)
    {
        int articleId = PublicRouteIdentity.ParseArticleRouteKey(match.RouteKey);
        if (articleId <= 0)
        {
            return Result<PublicPageSnapshot>.Failure(ErrorCode.NotFound, "public_aot_article_not_found");
        }

        DateTime utcNow = DateTime.UtcNow;
        Task<PublicAotSeoSnapshot> seoTask = LoadSeoSnapshotAsync();
        Task<ArticleDetailAotProjection?> articleTask = LoadPublicArticleForAotAsync(articleId, utcNow, cancellationToken);

        ArticleDetailAotProjection? article = await articleTask;
        if (article is null)
        {
            return Result<PublicPageSnapshot>.Failure(ErrorCode.NotFound, "public_aot_article_not_found");
        }

        if (string.IsNullOrWhiteSpace(article.ArticleBodyContent))
        {
            articleBodyRepairQueue.TrySchedule(articleId, "public-aot");
            FsusObservability.RecordOperation("article_body", "public_aot", "missing", TimeSpan.Zero);
            return Result<PublicPageSnapshot>.Failure(ErrorCode.InfraFailure, "article_body_missing");
        }

        if (!HasCompleteArticleRights(article.Rights))
        {
            return Result<PublicPageSnapshot>.Failure(ErrorCode.NotFound, "public_aot_article_rights_missing");
        }

        PublicAotSeoSnapshot seo = await seoTask;
        IntegrityManifestResult responsibilityResult = await responsibilityManifestService.GetCurrentAsync(articleId, cancellationToken);
        ArticleResponsibilityManifestResponse? responsibility = responsibilityResult.Body as ArticleResponsibilityManifestResponse;
        IReadOnlyList<PublicAotResponsiblePersonSnapshot> authors = responsibility?.Authors.Count > 0
            ? responsibility.Authors.Select(static author => new PublicAotResponsiblePersonSnapshot(author.Name, author.ProfileUrl)).ToArray()
            : [new PublicAotResponsiblePersonSnapshot(ResolveArticleAuthorName(article.AuthorName, seo), null)];
        RelatedReadingResponse? relatedReading = await relatedReadingService.BuildAsync(articleId, cancellationToken);
        return Result<PublicPageSnapshot>.Success(new PublicArticlePageSnapshot(
            seo,
            article.Id,
            article.Title,
            article.Content,
            article.Summary ?? string.Empty,
            article.Views,
            authors[0].Name,
            article.CreateTime,
            new PublicAotArticleCategorySnapshot(article.CategoryId, article.CategoryName),
            article.Tags,
            ToRightsSnapshot(article.Rights),
            ToRelatedReadingSnapshot(relatedReading))
        {
            RevisionId = article.RevisionId,
            RevisionNo = article.RevisionNo,
            PublicationId = article.PublicationId,
            PublicationNo = article.PublicationNo,
            CoverImageUrl = article.CoverImageUrl ?? string.Empty,
            PublishedAt = article.PublishedAt,
            UpdatedAt = article.UpdatedAt,
            Authors = authors,
            Reviewer = responsibility?.Reviewer is { } reviewer
                ? new PublicAotResponsiblePersonSnapshot(reviewer.Name, reviewer.ProfileUrl)
                : null,
            Responsibility = responsibility
        });
    }

    private async Task<ArticleDetailAotProjection?> LoadPublicArticleForAotAsync(
        int articleId,
        DateTime utcNow,
        CancellationToken cancellationToken)
    {
        ArticleDetailAotProjection? projection = await db.Queryable<Article>()
            .InnerJoin<ArticlePublicationRecord>((a, publication) => a.CurrentPublicationId == publication.Id)
            .InnerJoin<ArticleRevision>((a, publication, revision) => publication.ArticleRevisionId == revision.Id)
            .LeftJoin<ArticleRevisionContentBlock>((a, publication, revision, block) => revision.ContentBlockId == block.Id)
            .LeftJoin<Category>((a, publication, revision, block, category) => revision.CategoryId == category.Id)
            .LeftJoin<ArticleBody>((a, publication, revision, block, category, body) => a.Id == body.ArticleId)
            .Where(a => a.Id == articleId
                && a.IsDeleted == false
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= utcNow)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= utcNow))
            .Select((a, publication, revision, block, category, body) => new ArticleDetailAotProjection
            {
                Id = a.Id,
                Title = revision.Title,
                Content = block.MarkdownContent,
                ContentBlockId = revision.ContentBlockId,
                ResolvedContentBlockId = (long?)block.Id,
                ArticleBodyContent = body.MarkdownContent,
                Summary = revision.Summary,
                CoverImageUrl = revision.CoverImageUrl,
                Views = a.Views,
                CreateTime = a.CreateTime,
                PublishedAt = a.PublishedAt,
                UpdatedAt = a.PublicUpdatedAt,
                CategoryId = revision.CategoryId,
                CategoryName = category.Name,
                RevisionId = revision.Id,
                RevisionNo = revision.RevisionNo,
                PublicationId = publication.Id,
                PublicationNo = publication.PublicationNo,
                RightsSnapshotId = publication.RightsSnapshotId,
                PublishedTagIds = revision.TagIds
            })
            .FirstAsync(cancellationToken);
        if (projection is null)
        {
            return null;
        }
        if (projection.ContentBlockId <= 0
            || projection.ResolvedContentBlockId != projection.ContentBlockId
            || projection.Content is null)
        {
            throw new InvalidOperationException(
                $"article_revision_content_block_missing:{projection.RevisionId}:{projection.ContentBlockId}");
        }

        int[] publishedTagIds = FsusBlog.Server.Services.Authoring.AuthoringNormalization
            .ParseTagIds(projection.PublishedTagIds)
            .ToArray();
        List<ArticleTagAotProjection> tags = publishedTagIds.Length == 0
            ? []
            : await db.Queryable<Tag>()
            .Where(tag => publishedTagIds.Contains(tag.Id))
            .OrderBy(tag => tag.Id)
            .Select(tag => new ArticleTagAotProjection
            {
                Id = tag.Id,
                Name = tag.Name
            })
            .ToListAsync(cancellationToken);
        projection.Tags = tags
            .Select(static tag => new PublicAotArticleTagSnapshot(tag.Id, tag.Name))
            .ToArray();
        projection.Rights = await LoadArticleRightsForAotAsync(articleId, projection.RightsSnapshotId, cancellationToken);
        projection.AuthorName = string.Empty;
        projection.Content = string.IsNullOrWhiteSpace(projection.Content) ? projection.Summary ?? string.Empty : projection.Content;
        projection.Summary ??= string.Empty;
        projection.CategoryName = string.IsNullOrWhiteSpace(projection.CategoryName) ? "未分类" : projection.CategoryName;
        return projection;
    }


    private async Task<ArticleRightsReadModel> LoadArticleRightsForAotAsync(
        int articleId,
        long rightsSnapshotId,
        CancellationToken cancellationToken)
    {
        const string Sql = """
            SELECT
                snapshot.id AS "RightsSnapshotId",
                snapshot.article_revision_id AS "RightsArticleRevisionId",
                snapshot.revision_no AS "RightsRevisionNo",
                snapshot.enabled AS "RightsEnabled",
                snapshot.license_type AS "RightsLicenseType",
                snapshot.copyright_holder AS "RightsCopyrightHolder",
                snapshot.copyright_year AS "RightsCopyrightYear",
                snapshot.rights_statement AS "RightsStatement",
                snapshot.attribution_template AS "RightsAttributionTemplate",
                snapshot.copy_policy AS "RightsCopyPolicy",
                snapshot.max_excerpt_chars AS "RightsMaxExcerptChars",
                snapshot.allow_code_copy AS "RightsAllowCodeCopy",
                snapshot.show_public_badge AS "RightsShowPublicBadge",
                snapshot.proof_binding_enabled AS "RightsProofBindingEnabled",
                snapshot.canonical_url AS "RightsCanonicalUrl",
                snapshot.policy_hash AS "RightsPolicyHash",
                snapshot.content_canonical_hash AS "RightsContentCanonicalHash",
                CASE
                    WHEN rights_proof.id IS NULL THEN NULL
                    ELSE concat('urn:fsus:rights-proof:', rights_proof.id::text)
                END AS "RightsProofUrl",
                rights_proof.proof_status AS "RightsProofStatus"
            FROM article_rights_snapshot snapshot
            LEFT JOIN LATERAL (
                SELECT proof.*
                FROM article_rights_proof proof
                WHERE proof.article_rights_snapshot_id = snapshot.id
                ORDER BY proof.created_at DESC, proof.id DESC
                LIMIT 1
            ) rights_proof ON TRUE
            WHERE snapshot.article_id = @ArticleId
              AND snapshot.id = @RightsSnapshotId;
            """;

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            Sql,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@RightsSnapshotId", rightsSnapshotId));
        return await reader.ReadAsync(cancellationToken)
            ? ReadArticleRights(reader)
            : new ArticleRightsReadModel();
    }

    private static ArticleRightsReadModel ReadArticleRights(DbDataReader reader)
    {
        int snapshotId = reader.GetOrdinal("RightsSnapshotId");
        if (reader.IsDBNull(snapshotId))
        {
            return new ArticleRightsReadModel();
        }

        return new ArticleRightsReadModel
        {
            SnapshotId = reader.GetInt64(snapshotId),
            ArticleRevisionId = reader.GetInt64(reader.GetOrdinal("RightsArticleRevisionId")),
            RevisionNo = reader.GetInt32(reader.GetOrdinal("RightsRevisionNo")),
            Enabled = reader.GetBoolean(reader.GetOrdinal("RightsEnabled")),
            LicenseType = ReadStringOrDefault(reader, "RightsLicenseType", "all-rights-reserved"),
            CopyrightHolder = ReadNullableString(reader, "RightsCopyrightHolder"),
            CopyrightYear = ReadNullableInt32(reader, "RightsCopyrightYear"),
            RightsStatement = ReadNullableString(reader, "RightsStatement"),
            AttributionTemplate = ReadNullableString(reader, "RightsAttributionTemplate"),
            CopyPolicy = ReadStringOrDefault(reader, "RightsCopyPolicy", "append-attribution"),
            MaxExcerptChars = reader.GetInt32(reader.GetOrdinal("RightsMaxExcerptChars")),
            AllowCodeCopy = reader.GetBoolean(reader.GetOrdinal("RightsAllowCodeCopy")),
            ShowPublicBadge = reader.GetBoolean(reader.GetOrdinal("RightsShowPublicBadge")),
            ProofBindingEnabled = reader.GetBoolean(reader.GetOrdinal("RightsProofBindingEnabled")),
            CanonicalUrl = ReadNullableString(reader, "RightsCanonicalUrl"),
            PolicyHash = ReadStringOrDefault(reader, "RightsPolicyHash", string.Empty),
            ContentCanonicalHash = ReadStringOrDefault(reader, "RightsContentCanonicalHash", string.Empty),
            ProofUrl = ReadNullableString(reader, "RightsProofUrl"),
            ProofStatus = ReadNullableString(reader, "RightsProofStatus")
        };
    }

    private static bool HasCompleteArticleRights(ArticleRightsReadModel? rights)
        => rights is not null
            && rights.SnapshotId > 0
            && rights.ArticleRevisionId > 0
            && rights.RevisionNo > 0
            && !string.IsNullOrWhiteSpace(rights.LicenseType)
            && !string.IsNullOrWhiteSpace(rights.CopyPolicy)
            && !string.IsNullOrWhiteSpace(rights.PolicyHash)
            && !string.IsNullOrWhiteSpace(rights.ContentCanonicalHash);

    private static string ReadStringOrDefault(DbDataReader reader, string fieldName, string defaultValue)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? defaultValue : reader.GetString(ordinal);
    }

    private static string? ReadNullableString(DbDataReader reader, string fieldName)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static int? ReadNullableInt32(DbDataReader reader, string fieldName)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);
    }

    private static string ResolveArticleAuthorName(string? authorName, PublicAotSeoSnapshot seo)
    {
        if (!string.IsNullOrWhiteSpace(authorName))
        {
            return authorName.Trim();
        }

        return string.IsNullOrWhiteSpace(seo.SiteAuthor) ? seo.SiteTitle : seo.SiteAuthor.Trim();
    }

    private static PublicAotRelatedReadingSnapshot? ToRelatedReadingSnapshot(RelatedReadingResponse? response)
        => response is null
            ? null
            : new PublicAotRelatedReadingSnapshot(
                response.Related.Select(ToRelatedReadingItemSnapshot).ToArray(),
                response.Previous is null ? null : ToRelatedReadingItemSnapshot(response.Previous),
                response.Next is null ? null : ToRelatedReadingItemSnapshot(response.Next));

    private static PublicAotArticleRightsSnapshot ToRightsSnapshot(ArticleRightsReadModel rights)
        => new(
            rights.SnapshotId,
            rights.ArticleRevisionId,
            rights.RevisionNo,
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
            rights.ProofUrl,
            rights.ProofStatus);

    private static PublicAotRelatedReadingItemSnapshot ToRelatedReadingItemSnapshot(RelatedReadingItem item)
        => new(item.Id, item.Title, item.Summary, item.CreateTime, item.Reason);

    private sealed class ArticleDetailAotProjection
    {
        public long ContentBlockId
        {
            get; init;
        }
        public long? ResolvedContentBlockId
        {
            get; init;
        }
        public int Id
        {
            get; init;
        }
        public string Title { get; init; } = string.Empty;
        public string Content { get; set; } = string.Empty;
        public string ArticleBodyContent { get; init; } = string.Empty;
        public string? Summary
        {
            get; set;
        }
        public string? CoverImageUrl
        {
            get; set;
        }
        public int Views
        {
            get; init;
        }
        public DateTime CreateTime
        {
            get; init;
        }
        public DateTime? PublishedAt
        {
            get; init;
        }
        public DateTime? UpdatedAt
        {
            get; init;
        }
        public int CategoryId
        {
            get; init;
        }
        public string CategoryName { get; set; } = string.Empty;
        public string AuthorName { get; set; } = string.Empty;
        public IReadOnlyList<PublicAotArticleTagSnapshot> Tags { get; set; } = [];
        public ArticleRightsReadModel Rights { get; set; } = new();
        public long RevisionId
        {
            get; init;
        }
        public int RevisionNo
        {
            get; init;
        }
        public long PublicationId
        {
            get; init;
        }
        public int PublicationNo
        {
            get; init;
        }
        public long RightsSnapshotId
        {
            get; init;
        }
        public string PublishedTagIds { get; init; } = string.Empty;
    }

    private sealed class ArticleTagAotProjection
    {
        public int Id
        {
            get; init;
        }
        public string Name { get; init; } = string.Empty;
    }
}

public sealed class PublicAotFilterBootstrapProvider(
    IArticleCoreService articleService,
    IAotSeoConfigSnapshot seoConfigSnapshot,
    ISqlSugarClient db) : PublicAotBootstrapProviderBase(seoConfigSnapshot)
{
    public override PublicPageKind Kind => PublicPageKind.Filter;

    public override async Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(PublicAotRouteMatch match, CancellationToken cancellationToken = default)
    {
        const int PageSize = 10;
        const int PageIndex = 1;
        if (!PublicRouteIdentity.AllowsStaticArtifact(match))
        {
            return Result<PublicPageSnapshot>.Failure(ErrorCode.Validation, "public_aot_cursor_required");
        }
        FilterIdentity identity = await ResolveFilterIdentityAsync(match.RouteKey, cancellationToken);
        if (identity.IsInvalidTarget)
        {
            return Result<PublicPageSnapshot>.Failure(ErrorCode.NotFound, "public_aot_filter_not_found");
        }

        Task<PublicAotSeoSnapshot> seoTask = LoadSeoSnapshotAsync();
        Task<Result<CorePageResult<ArticleListCoreModel>>> pageTask = articleService.GetPageListAsync(
            new ArticlePageQuery(PageIndex, PageSize, identity.CategoryId, identity.TagId, false, UseSourceCache: false),
            cancellationToken);
        PublicAotSeoSnapshot seo = await seoTask;
        Result<CorePageResult<ArticleListCoreModel>> pageResult = await pageTask;
        if (!pageResult.IsSuccess)
        {
            return Result<PublicPageSnapshot>.Failure(pageResult.Error.Code, pageResult.Error.Message);
        }
        CorePageResult<ArticleListCoreModel> page = pageResult.Value;
        if (!PublicTagUrlIdentity.IsNameRouteKey(match.RouteKey)
            && PageIndex > Math.Max(1, (int)Math.Ceiling(page.Total / (double)PageSize)))
        {
            return Result<PublicPageSnapshot>.Failure(ErrorCode.NotFound, "public_aot_page_out_of_range");
        }
        string title = ResolveFilterTitle(identity);

        return Result<PublicPageSnapshot>.Success(new PublicFilterPageSnapshot(
            seo,
            match.RouteKey,
            identity.FilterType,
            identity.FilterKey,
            identity.FilterId,
            identity.FilterName,
            identity.Description,
            identity.IsInvalidTarget,
            PageIndex,
            PageSize,
            page.Total,
            page.Items.Select(ToArticleSummarySnapshot).ToArray(),
            title)
        {
            NextCursor = page.NextCursor,
            HasMore = page.HasMore
        });
    }

    private async Task<FilterIdentity> ResolveFilterIdentityAsync(string routeKey, CancellationToken cancellationToken)
    {
        PublicRouteIdentity.ParsedFilterRouteIdentity parsed = PublicRouteIdentity.ParseFilterRouteKey(routeKey);

        if (parsed.CategoryId is >= 0 && string.Equals(parsed.FilterType, "category", StringComparison.Ordinal))
        {
            FilterTaxonomyAotProjection? taxonomy = parsed.CategoryId > 0
                ? await db.Queryable<Category>()
                    .Where(category => category.Id == parsed.CategoryId)
                    .Select(category => new FilterTaxonomyAotProjection
                    {
                        Name = category.Name,
                        Description = category.Description
                    })
                    .FirstAsync(cancellationToken)
                : null;
            string? name = taxonomy?.Name;
            return new FilterIdentity(
                parsed.FilterType,
                parsed.FilterKey,
                parsed.FilterId,
                name,
                NormalizeFilterDescription(taxonomy?.Description),
                parsed.CategoryId,
                null,
                string.IsNullOrWhiteSpace(name));
        }

        if (parsed.TagId is >= 0 && string.Equals(parsed.FilterType, "tag", StringComparison.Ordinal) && string.IsNullOrWhiteSpace(parsed.FilterName))
        {
            FilterTaxonomyAotProjection? taxonomy = parsed.TagId > 0
                ? await db.Queryable<Tag>()
                    .Where(tag => tag.Id == parsed.TagId)
                    .Select(tag => new FilterTaxonomyAotProjection
                    {
                        Name = tag.Name,
                        Description = tag.Description
                    })
                    .FirstAsync(cancellationToken)
                : null;
            string? name = taxonomy?.Name;
            return new FilterIdentity(
                parsed.FilterType,
                parsed.FilterKey,
                parsed.FilterId,
                name,
                NormalizeFilterDescription(taxonomy?.Description),
                null,
                parsed.TagId,
                string.IsNullOrWhiteSpace(name));
        }

        if (string.Equals(parsed.FilterType, "tag", StringComparison.Ordinal) && !string.IsNullOrWhiteSpace(parsed.FilterName))
        {
            ResolvedTagIdentity resolved = await ResolveTagIdByNameAsync(parsed.FilterName, cancellationToken);
            return new FilterIdentity(
                parsed.FilterType,
                parsed.FilterKey,
                resolved.TagId ?? 0,
                parsed.FilterName,
                resolved.Description,
                null,
                resolved.TagId,
                resolved.TagId is not > 0);
        }

        return new FilterIdentity(parsed.FilterType, parsed.FilterKey, parsed.FilterId, parsed.FilterName, null, parsed.CategoryId, parsed.TagId, true);
    }

    private async Task<ResolvedTagIdentity> ResolveTagIdByNameAsync(string tagName, CancellationToken cancellationToken)
    {
        CanonicalTagIdentity resolved = await PublicTagUrlIdentity.ResolveCanonicalTagIdentityAsync(db, tagName, cancellationToken);
        return new ResolvedTagIdentity(resolved.TagId, NormalizeFilterDescription(resolved.Description));
    }


    private static string? NormalizeFilterDescription(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string ResolveFilterTitle(FilterIdentity identity)
        => identity.FilterType switch
        {
            "category" when !string.IsNullOrWhiteSpace(identity.FilterName) => identity.FilterName!,
            "category" => "未发现分类",
            "tag" when !string.IsNullOrWhiteSpace(identity.FilterName) => identity.FilterName!,
            "tag" => "未发现标签",
            _ => "筛选"
        };

    private sealed record FilterIdentity(
        string FilterType,
        string FilterKey,
        int FilterId,
        string? FilterName,
        string? Description,
        int? CategoryId,
        int? TagId,
        bool IsInvalidTarget);

    private sealed record ResolvedTagIdentity(int? TagId, string? Description);

    private sealed class FilterTaxonomyAotProjection
    {
        public int Id
        {
            get; init;
        }

        public string Name { get; init; } = string.Empty;

        public string? Description
        {
            get; init;
        }
    }
}

public abstract class PublicAotStaticPageBootstrapProvider : PublicAotBootstrapProviderBase
{
    private readonly ISystemService _systemService;
    private readonly PublicPageKind _kind;
    private readonly string _title;

    protected PublicAotStaticPageBootstrapProvider(
        ISystemService systemService,
        IAotSeoConfigSnapshot seoConfigSnapshot,
        PublicPageKind kind,
        string title) : base(seoConfigSnapshot)
    {
        _systemService = systemService;
        _kind = kind;
        _title = title;
    }

    public override PublicPageKind Kind => _kind;

    public override async Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(PublicAotRouteMatch match, CancellationToken cancellationToken = default)
    {
        Task<PublicAotSeoSnapshot> seoTask = LoadSeoSnapshotAsync();
        Task<PageContentReadModel> pageTask = _systemService.GetPageContentAsync(PublicAotPageIdentity.GetCanonicalSlug(_kind));

        PublicAotSeoSnapshot seo = await seoTask;
        PageContentReadModel page = await pageTask;
        return Result<PublicPageSnapshot>.Success(new PublicStaticPageSnapshot(
            _kind,
            seo,
            page.Content ?? string.Empty,
            page.Slug ?? string.Empty,
            _title));
    }
}

public sealed class PublicAotAboutBootstrapProvider(ISystemService systemService, IAotSeoConfigSnapshot seoConfigSnapshot)
    : PublicAotStaticPageBootstrapProvider(systemService, seoConfigSnapshot, PublicPageKind.About, "关于");

public sealed class PublicAotPrivacyBootstrapProvider(ISystemService systemService, IAotSeoConfigSnapshot seoConfigSnapshot)
    : PublicAotStaticPageBootstrapProvider(systemService, seoConfigSnapshot, PublicPageKind.Privacy, "隐私政策");

public sealed class PublicAotGuidelinesBootstrapProvider(ISystemService systemService, IAotSeoConfigSnapshot seoConfigSnapshot)
    : PublicAotStaticPageBootstrapProvider(systemService, seoConfigSnapshot, PublicPageKind.Guidelines, "用户守则");

public sealed class PublicAotCopyrightBootstrapProvider(ISystemService systemService, IAotSeoConfigSnapshot seoConfigSnapshot)
    : PublicAotStaticPageBootstrapProvider(systemService, seoConfigSnapshot, PublicPageKind.Copyright, "版权声明");

public sealed class PublicAotArchiveBootstrapProvider(
    IAotSeoConfigSnapshot seoConfigSnapshot,
    ISqlSugarClient db) : PublicAotBootstrapProviderBase(seoConfigSnapshot)
{
    public override PublicPageKind Kind => PublicPageKind.Archive;

    public override async Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(PublicAotRouteMatch match, CancellationToken cancellationToken = default)
    {
        Task<PublicAotSeoSnapshot> seoTask = LoadSeoSnapshotAsync();
        Task<List<ArchiveArticleAotProjection>> articlesTask = ListPublicArchiveArticlesAsync(cancellationToken);

        PublicAotSeoSnapshot seo = await seoTask;
        IReadOnlyList<ArchiveArticleAotProjection> articles = await articlesTask;
        return Result<PublicPageSnapshot>.Success(new PublicArchivePageSnapshot(
            seo,
            articles.Select(static article => new PublicArchiveArticleSnapshot(article.Id, article.Title, article.CreateTime)).ToArray(),
            "归档"));
    }

    private async Task<List<ArchiveArticleAotProjection>> ListPublicArchiveArticlesAsync(CancellationToken cancellationToken)
    {
        DateTime utcNow = DateTime.UtcNow;
        return await db.Queryable<Article>()
            .Where(article => article.IsDeleted == false
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= utcNow)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= utcNow))
            .OrderBy(article => article.CreateTime, OrderByType.Desc)
            .OrderBy(article => article.Id, OrderByType.Desc)
            .Select(article => new ArchiveArticleAotProjection
            {
                Id = article.Id,
                Title = article.Title,
                CreateTime = article.CreateTime
            })
            .ToListAsync(cancellationToken);
    }

    private sealed class ArchiveArticleAotProjection
    {
        public int Id
        {
            get; init;
        }
        public string Title { get; init; } = string.Empty;
        public DateTime CreateTime
        {
            get; init;
        }
    }
}
