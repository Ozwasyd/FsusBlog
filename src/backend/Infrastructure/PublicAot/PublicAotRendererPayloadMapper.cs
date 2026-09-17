using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotRendererPayloadMapper
{
    internal static IReadOnlyDictionary<string, object?> ToBuildEntryPayload(PublicAotRenderRequest request)
        => new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["pageKind"] = request.Match.Kind.ToString(),
            ["options"] = ToOptions(request)
        };

    internal static IReadOnlyDictionary<string, object?> ToBundlePayload(PublicAotShellBundleContract bundle)
        => new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["bundle"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["generatedAtUtc"] = bundle.GeneratedAtUtc,
                ["entries"] = bundle.Entries.Select(ToEntryPayload).ToArray()
            }
        };

    private static IReadOnlyDictionary<string, object?> ToOptions(PublicAotRenderRequest request)
    {
        Dictionary<string, object?> common = CreateCommonOptions(request.Snapshot.Seo);
        common["routeKey"] = request.Match.RouteKey;
        common["renderTimestamp"] = PublicAotUtcTime.Format(request.RenderTimestampUtc.UtcDateTime);
        common["renderLocale"] = request.Match.LocaleResolution.Locale.Code;
        common["localeCatalogDigest"] = request.Match.LocaleResolution.CatalogDigest;
        switch (request.Snapshot)
        {
            case PublicHomePageSnapshot home:
                common["pageIndex"] = home.Page;
                common["pageSize"] = home.Size;
                common["total"] = home.Total;
                common["nextCursor"] = home.NextCursor;
                common["hasMore"] = home.HasMore;
                common["articles"] = home.Items.Select(ToArticleSummaryPayload).ToArray();
                common["featuredArticles"] = home.FeaturedArticles.Select(ToFeaturedArticlePayload).ToArray();
                common["hotArticles"] = home.HotArticles.Select(ToHotArticlePayload).ToArray();
                return common;
            case PublicArticlePageSnapshot article:
                common["articleId"] = article.ArticleId;
                common["title"] = article.Title;
                common["bodyContent"] = article.Content;
                common["summary"] = article.Summary;
                common["coverImageUrl"] = article.CoverImageUrl;
                common["views"] = article.Views;
                common["authorName"] = article.AuthorName;
                common["authors"] = article.Authors.Select(ToResponsiblePersonPayload).ToArray();
                common["reviewer"] = article.Reviewer is null ? null : ToResponsiblePersonPayload(article.Reviewer);
                common["responsibility"] = article.Responsibility is null ? null : ToResponsibilityPayload(article.Responsibility);
                common["createTime"] = PublicAotUtcTime.Format(article.CreateTime);
                common["publishedAt"] = article.PublishedAt is DateTime publishedAt ? PublicAotUtcTime.Format(publishedAt) : null;
                common["updatedAt"] = article.UpdatedAt is DateTime updatedAt ? PublicAotUtcTime.Format(updatedAt) : null;
                common["categoryId"] = article.Category.Id;
                common["categoryName"] = article.Category.Name;
                common["tags"] = article.Tags.Select(ToTagPayload).ToArray();
                common["rights"] = ToRightsPayload(article.Rights);
                common["relatedReading"] = article.RelatedReading is null ? null : ToRelatedReadingPayload(article.RelatedReading);
                return common;
            case PublicFilterPageSnapshot filter:
                common["routeKey"] = filter.RouteKey;
                common["title"] = filter.Title;
                common["filter"] = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["filterType"] = filter.FilterType,
                    ["filterKey"] = filter.FilterKey,
                    ["filterId"] = filter.FilterId,
                    ["filterName"] = filter.FilterName,
                    ["description"] = filter.Description,
                    ["isInvalidTarget"] = filter.IsInvalidTarget,
                    ["pageIndex"] = filter.PageIndex,
                    ["pageSize"] = filter.PageSize,
                    ["total"] = filter.Total,
                    ["nextCursor"] = filter.NextCursor,
                    ["hasMore"] = filter.HasMore,
                    ["articles"] = filter.Articles.Select(ToArticleSummaryPayload).ToArray()
                };
                return common;
            case PublicStaticPageSnapshot page:
                common["content"] = page.Content;
                common["slug"] = page.Slug;
                common["title"] = page.Title;
                return common;
            case PublicArchivePageSnapshot archive:
                common["articles"] = archive.Articles.Select(static article => new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["id"] = article.Id,
                    ["title"] = article.Title,
                    ["createTime"] = PublicAotUtcTime.Format(article.CreateTime)
                }).ToArray();
                common["title"] = archive.Title;
                return common;
            default:
                throw new InvalidOperationException($"public_aot_snapshot_unsupported:{request.Snapshot.Kind}");
        }
    }

    private static Dictionary<string, object?> CreateCommonOptions(PublicAotSeoSnapshot seo)
        => new(StringComparer.Ordinal)
        {
            ["siteTitle"] = seo.SiteTitle,
            ["siteDescription"] = seo.SiteDescription,
            ["baseUrl"] = seo.BaseUrl,
            ["siteLogoUrl"] = seo.SiteLogoUrl,
            ["siteLogoDarkUrl"] = seo.SiteLogoDarkUrl,
            ["siteWordmarkUrl"] = seo.SiteWordmarkUrl,
            ["loginLogoUrl"] = seo.LoginLogoUrl,
            ["loginIconUrl"] = seo.LoginIconUrl,
            ["compliance"] = seo.Compliance is null ? null : ToCompliancePayload(seo.Compliance)
        };

    private static Dictionary<string, object?> ToCompliancePayload(PublicAotSiteComplianceSnapshot compliance)
        => new(StringComparer.Ordinal)
        {
            ["enabled"] = compliance.Enabled,
            ["regionMode"] = compliance.RegionMode,
            ["copyrightOwner"] = compliance.CopyrightOwner,
            ["copyrightStartYear"] = compliance.CopyrightStartYear,
            ["copyrightText"] = compliance.CopyrightText,
            ["contentLicenseName"] = compliance.ContentLicenseName,
            ["contentLicenseUrl"] = compliance.ContentLicenseUrl,
            ["icpRecordNumber"] = compliance.IcpRecordNumber,
            ["icpRecordUrl"] = compliance.IcpRecordUrl,
            ["policeRecordNumber"] = compliance.PoliceRecordNumber,
            ["policeRecordUrl"] = compliance.PoliceRecordUrl,
            ["policeBadgeIconUrl"] = compliance.PoliceBadgeIconUrl,
            ["operatorName"] = compliance.OperatorName,
            ["contactEmail"] = compliance.ContactEmail
        };

    private static Dictionary<string, object?> ToArticleSummaryPayload(PublicAotArticleSummarySnapshot article)
        => new(StringComparer.Ordinal)
        {
            ["id"] = article.Id,
            ["title"] = article.Title,
            ["summary"] = article.Summary,
            ["views"] = article.Views,
            ["createTime"] = PublicAotUtcTime.Format(article.CreateTime),
            ["category"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["id"] = article.Category.Id,
                ["name"] = article.Category.Name
            },
            ["tags"] = article.Tags.Select(ToTagPayload).ToArray()
        };

    private static Dictionary<string, object?> ToRightsPayload(PublicAotArticleRightsSnapshot rights)
        => new(StringComparer.Ordinal)
        {
            ["snapshotId"] = rights.SnapshotId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["articleRevisionId"] = rights.RevisionId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["revisionNo"] = rights.RevisionNo,
            ["enabled"] = rights.Enabled,
            ["licenseType"] = rights.LicenseType,
            ["copyrightHolder"] = rights.CopyrightHolder,
            ["copyrightYear"] = rights.CopyrightYear,
            ["rightsStatement"] = rights.RightsStatement,
            ["attributionTemplate"] = rights.AttributionTemplate,
            ["copyPolicy"] = rights.CopyPolicy,
            ["maxExcerptChars"] = rights.MaxExcerptChars,
            ["allowCodeCopy"] = rights.AllowCodeCopy,
            ["showPublicBadge"] = rights.ShowPublicBadge,
            ["proofBindingEnabled"] = rights.ProofBindingEnabled,
            ["canonicalUrl"] = rights.CanonicalUrl,
            ["policyHash"] = rights.PolicyHash,
            ["contentCanonicalHash"] = rights.ContentCanonicalHash,
            ["proofUrl"] = rights.ProofUrl,
            ["proofStatus"] = rights.ProofStatus
        };

    private static Dictionary<string, object?> ToFeaturedArticlePayload(PublicAotFeaturedArticleSnapshot article)
        => new(StringComparer.Ordinal)
        {
            ["id"] = article.Id,
            ["title"] = article.Title,
            ["coverImageUrl"] = article.CoverImageUrl,
            ["views"] = article.Views,
            ["createTime"] = PublicAotUtcTime.Format(article.CreateTime),
            ["category"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["id"] = article.Category.Id,
                ["name"] = article.Category.Name
            }
        };

    private static Dictionary<string, object?> ToHotArticlePayload(PublicAotHotArticleSnapshot article)
        => new(StringComparer.Ordinal)
        {
            ["id"] = article.Id,
            ["title"] = article.Title,
            ["views"] = article.Views
        };

    private static Dictionary<string, object?> ToTagPayload(PublicAotArticleTagSnapshot tag)
        => new(StringComparer.Ordinal)
        {
            ["id"] = tag.Id,
            ["name"] = tag.Name
        };

    private static Dictionary<string, object?> ToResponsiblePersonPayload(PublicAotResponsiblePersonSnapshot person)
        => new(StringComparer.Ordinal)
        {
            ["name"] = person.Name,
            ["profileUrl"] = person.ProfileUrl
        };

    private static Dictionary<string, object?> ToResponsibilityPayload(FsusBlog.Server.Infrastructure.Integrity.ArticleResponsibilityManifestResponse responsibility)
        => new(StringComparer.Ordinal)
        {
            ["schemaVersion"] = responsibility.SchemaVersion,
            ["articleId"] = responsibility.ArticleId,
            ["revisionNo"] = responsibility.RevisionNo,
            ["inheritsSiteAuthor"] = responsibility.InheritsSiteAuthor,
            ["legacyFallback"] = responsibility.LegacyFallback,
            ["authors"] = responsibility.Authors.Select(static person => new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["name"] = person.Name,
                ["profileUrl"] = person.ProfileUrl
            }).ToArray(),
            ["reviewer"] = responsibility.Reviewer is null ? null : new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["name"] = responsibility.Reviewer.Name,
                ["profileUrl"] = responsibility.Reviewer.ProfileUrl
            },
            ["sources"] = responsibility.Sources.Select(static source => new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["title"] = source.Title,
                ["url"] = source.Url,
                ["sourceType"] = source.SourceType,
                ["accessedOn"] = source.AccessedOn?.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                ["version"] = source.Version,
                ["citationNote"] = source.CitationNote
            }).ToArray(),
            ["update"] = responsibility.Update is null ? null : new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["summary"] = responsibility.Update.Summary,
                ["reason"] = responsibility.Update.Reason,
                ["effectiveAt"] = responsibility.Update.EffectiveAt is DateTime effectiveAt ? PublicAotUtcTime.Format(effectiveAt) : null,
                ["conclusionImpact"] = responsibility.Update.ConclusionImpact
            },
            ["methodology"] = responsibility.Methodology,
            ["applicability"] = responsibility.Applicability,
            ["limitations"] = responsibility.Limitations,
            ["responsiblePersonConfirmed"] = responsibility.ResponsiblePersonConfirmed,
            ["verification"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["url"] = responsibility.Verification.Url,
                ["revisionNo"] = responsibility.Verification.RevisionNo,
                ["contentHash"] = responsibility.Verification.ContentHash,
                ["proofStatus"] = responsibility.Verification.ProofStatus
            }
        };

    private static Dictionary<string, object?> ToRelatedReadingPayload(PublicAotRelatedReadingSnapshot reading)
        => new(StringComparer.Ordinal)
        {
            ["related"] = reading.Related.Select(ToRelatedReadingItemPayload).ToArray(),
            ["previous"] = reading.Previous is null ? null : ToRelatedReadingItemPayload(reading.Previous),
            ["next"] = reading.Next is null ? null : ToRelatedReadingItemPayload(reading.Next)
        };

    private static Dictionary<string, object?> ToRelatedReadingItemPayload(PublicAotRelatedReadingItemSnapshot item)
        => new(StringComparer.Ordinal)
        {
            ["id"] = item.Id,
            ["title"] = item.Title,
            ["summary"] = item.Summary,
            ["createTime"] = PublicAotUtcTime.Format(item.CreateTime),
            ["reason"] = item.Reason
        };

    private static Dictionary<string, object?> ToEntryPayload(PublicAotShellEntryContract entry)
        => new(StringComparer.Ordinal)
        {
            ["pageId"] = (int)entry.PageId,
            ["routeKey"] = entry.RouteKey,
            ["html"] = entry.Html,
            ["articleId"] = entry.ArticleId,
            ["bootstrapPayload"] = entry.BootstrapPayload,
            ["hydrationPropsPayload"] = entry.HydrationPropsPayload,
            ["rendererVersion"] = entry.RendererVersion,
            ["title"] = entry.Title,
            ["baseUrl"] = entry.BaseUrl
        };
}
