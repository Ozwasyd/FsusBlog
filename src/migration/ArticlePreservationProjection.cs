using System.Collections.Immutable;
using System.Security.Cryptography;

using FsusBlog.Contracts.Articles;

namespace FsusBlog.Migration;

/// <summary>
/// Lossless source projection using the actual current pure article rules. Artifact integrity and
/// this computation cannot replace independent source admission, publication or native writers.
/// </summary>
internal static class ArticlePreservationProjection
{
    internal static ArticlePreservationWritePlan Project(
        ArticlePreservationSourceExport source, ArticlePreservationCurrentExport current,
        ArticleMediaInventory media, ArticlePreservationLimits limits, ArticleMediaLimits mediaLimits,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(current);
        ArgumentNullException.ThrowIfNull(media);
        ArgumentNullException.ThrowIfNull(limits);
        cancellationToken.ThrowIfCancellationRequested();
        if (limits.MaximumArticles <= 0 || limits.MaximumTaxonomyRows <= 0 || limits.MaximumMetadataBytes <= 0)
            Reject("resource_budget");
        ArticlePreservationSourceData data = source.Data;
        if (data is null || data.FingerprintId != OfflineMigrationSourceFingerprints.LegacyId
            || !ArticlePreservationSemanticReceipt.IsDigest(data.FullSourceContentDigest)
            || data.Articles.IsDefault || data.Categories.IsDefault || data.Tags.IsDefault
            || data.ExpectedArticleCount != data.Articles.Length || data.ExpectedCategoryCount != data.Categories.Length
            || data.ExpectedTagCount != data.Tags.Length || data.Articles.Length > limits.MaximumArticles
            || (long)data.Categories.Length + data.Tags.Length > limits.MaximumTaxonomyRows
            || current.Articles.IsDefault || current.Articles.Length != data.Articles.Length
            || data.Articles.Any(static row => row is null))
            Reject("source_scope_or_count");
        if (data.OriginArtifact is null || string.IsNullOrWhiteSpace(data.OriginArtifact.Reference)
            || !ArticlePreservationSemanticReceipt.IsDigest(data.OriginArtifact.Sha256)
            || data.DocumentBase is null || !data.DocumentBase.IsAbsoluteUri)
            Reject("source_origin");
        ArticlePreservationSemanticReceipt.RequireArtifact(source.Artifact, source.Bytes, data);
        ArticlePreservationSemanticReceipt.RequireArtifact(current.Artifact, current.Bytes,
            new
            {
                current.Categories,
                current.Tags,
                current.Articles,
                current.DefaultPolicy
            });
        if (current.DefaultPolicy is not null)
            ArticlePreservationPolicyExporter.RequireDefaultPolicy(source, current.DefaultPolicy);
        long metadataBytes = checked((long)source.Bytes.Length + current.Bytes.Length);
        if (metadataBytes > limits.MaximumMetadataBytes)
            Reject("metadata_budget");

        ImmutableArray<ArticlePreservationTaxonomyMap> categories = MapTaxonomy(data.Categories, current.Categories);
        ImmutableArray<ArticlePreservationTaxonomyMap> tags = MapTaxonomy(data.Tags, current.Tags);
        Dictionary<int, int> categoryMap = categories.ToDictionary(static map => map.SourceId, static map => map.TargetId);
        Dictionary<int, int> tagMap = tags.ToDictionary(static map => map.SourceId, static map => map.TargetId);
        var packages = new Dictionary<int, ArticlePreservationCurrentPackage>();
        foreach (ArticlePreservationCurrentPackage package in current.Articles)
        {
            if (package?.Data is null || !packages.TryAdd(package.Data.SourceArticleId, package))
                Reject("current_package_identity");
        }
        var sourceIds = new HashSet<int>();
        var revisionIds = new HashSet<long>();
        var contentByBlockId = new Dictionary<long, string>();
        var blockIdByContent = new Dictionary<string, long>(StringComparer.Ordinal);
        var rightsPolicyIds = new HashSet<long>();
        var rightsSnapshotIds = new HashSet<long>();
        var responsibilityIds = new HashSet<long>();
        var publicationIds = new HashSet<long>();
        var articles = ImmutableArray.CreateBuilder<ArticlePreservationArticleWritePlan>(data.Articles.Length);
        using var documents = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (LegacyArticlePreservationRow row in data.Articles.OrderBy(static article => article.Id))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (row.Id <= 0 || !sourceIds.Add(row.Id) || row.Title is null || row.Markdown is null
                || row.TagIds.IsDefault || row.TagIds.Distinct().Count() != row.TagIds.Length)
                Reject("source_article_or_current_package");
            if (!packages.TryGetValue(row.Id, out ArticlePreservationCurrentPackage? package))
                Reject("source_article_or_current_package");
            if (!categoryMap.TryGetValue(row.CategoryId, out int categoryId))
                Reject("source_article_or_current_package");
            ArticlePreservationCurrentData target = package!.Data;
            ArticlePreservationSemanticReceipt.RequireArtifact(package.Artifact, package.Bytes, target);
            int[] targetTags = row.TagIds.Select(id => tagMap.TryGetValue(id, out int mapped)
                ? mapped : throw new InvalidOperationException("article_preservation_tag_mapping")).Order().ToArray();
            ArticleCanonicalInput article = target.Article;
            if (article is null || article.ArticleId != row.Id || article.ArticleRevisionId is not > 0
                || article.RevisionNo is not > 0 || article.PublicRouteKey != $"article:{row.Id}"
                || article.Title != row.Title || article.Summary != row.Summary || article.MarkdownContent != row.Markdown
                || article.CoverImageUrl is not null || article.CategoryId != categoryId || article.TagIds is null
                || !article.TagIds.SequenceEqual(targetTags) || !ArticleStatusTransitionPolicy.IsDefined(article.Status)
                || row.IsDeleted != (article.Status == ArticleStatusValues.Deleted))
                Reject("current_metadata_or_source_loss");
            ArticlePreservationGraphCoordinates graph = target.Coordinates;
            if (graph is null || target.Rights is null || target.Responsibility is null
                || graph.ContentBlockId <= 0 || graph.RightsPolicyId <= 0 || graph.RightsSnapshotId <= 0
                || graph.ResponsibilitySnapshotId <= 0 || graph.ResponsibilityVersion <= 0
                || graph.PublicationId <= 0 || graph.PublicationNo <= 0 || graph.CreatedByAdminPrincipalId < 0
                || string.IsNullOrWhiteSpace(graph.DiffSummary) || string.IsNullOrWhiteSpace(graph.PublicationTransitionKind)
                || target.Responsibility.Authors is null || target.Responsibility.Sources is null
                || target.Responsibility.InheritSiteAuthor && string.IsNullOrWhiteSpace(target.ConfiguredSiteAuthor))
                Reject("required_current_graph_or_policy");
            if (target.DefaultPolicyArtifact is not null)
            {
                ArticlePreservationDefaultPolicyExport? policy = current.DefaultPolicy;
                if (policy is null || target.DefaultPolicyArtifact != policy.Artifact
                    || graph.CreatedByAdminPrincipalId != policy.Data.RevisionCreatorId
                    || graph.ResponsibilityVersion != policy.Data.ResponsibilityVersion
                    || graph.PublicationTime != row.CreateTime || article.PublishedAt != row.CreateTime
                    || article.ScheduledPublishAt is not null
                    || article.Status != (row.IsDeleted ? ArticleStatusValues.Deleted : policy.Data.ArticleStatus)
                    || target.ConfiguredSiteAuthor != policy.Data.SiteAuthor
                    || !ArticlePreservationSemanticReceipt.Serialize(target.Rights).AsSpan().SequenceEqual(
                        ArticlePreservationSemanticReceipt.Serialize(policy.Data.Rights))
                    || !ArticlePreservationSemanticReceipt.Serialize(target.Responsibility).AsSpan().SequenceEqual(
                        ArticlePreservationSemanticReceipt.Serialize(policy.Data.Responsibility)))
                    Reject("stored_default_policy_binding");
            }
            else if (ArticleResponsibilityGovernance.Evaluate(target.Responsibility).Any(static issue => issue.Severity == "error"))
                Reject("responsibility_policy");
            // Deleted historical rows require a separate, explicit deletion-flow write obligation;
            // they are not admitted as ordinary current authoring creates or updates.
            if (!row.IsDeleted && ArticleStatusTransitionPolicy.ValidateTarget(
                    article.Status, article.ScheduledPublishAt, graph.PublicationTime).HasValue)
                Reject("current_status_policy");
            // Production content blocks are globally content-addressed, not article-owned.
            // Preserve sharing, while rejecting either direction of a conflicting allocation.
            if (contentByBlockId.TryGetValue(graph.ContentBlockId, out string? storedContent) && storedContent != row.Markdown
                || blockIdByContent.TryGetValue(row.Markdown, out long storedBlockId) && storedBlockId != graph.ContentBlockId)
                Reject("content_block_identity_collision");
            contentByBlockId[graph.ContentBlockId] = row.Markdown;
            blockIdByContent[row.Markdown] = graph.ContentBlockId;
            if (!revisionIds.Add(article.ArticleRevisionId.Value)
                || !rightsPolicyIds.Add(graph.RightsPolicyId) || !rightsSnapshotIds.Add(graph.RightsSnapshotId)
                || !responsibilityIds.Add(graph.ResponsibilitySnapshotId) || !publicationIds.Add(graph.PublicationId))
                Reject("graph_identity_collision");
            // Freeze mutable collection interfaces before hashing or handing data to a writer.
            target = target with
            {
                Article = article with
                {
                    TagIds = targetTags.ToImmutableArray()
                },
                Responsibility = target.Responsibility with
                {
                    Authors = target.Responsibility.Authors.ToImmutableArray(),
                    Sources = target.Responsibility.Sources.ToImmutableArray()
                }
            };
            ArticleRightsCanonicalBinding canonical = ArticleRightsCanonicalBinding.Build(target.Article, target.Rights);
            string markdownDigest = ArticlePreservationSemanticReceipt.HashMarkdown(row.Markdown);
            string responsibilityDigest = ArticlePreservationSemanticReceipt.Digest(
                "article-preservation-responsibility-v1", new
                {
                    target.Responsibility,
                    target.ConfiguredSiteAuthor
                });
            string semanticDigest = ArticlePreservationSemanticReceipt.Digest(
                "article-preservation-article-v1", new
                {
                    Source = row,
                    Current = target,
                    canonical,
                    markdownDigest,
                    responsibilityDigest
                });
            articles.Add(new(row, target, package.Artifact, canonical, markdownDigest, responsibilityDigest, semanticDigest,
                ArticleRevisionContentAddress.Compute(row.Markdown)));
            ArticleMediaPreservation.AppendSourceDocument(documents, new(row.Id, null, row.Markdown, data.DocumentBase));
        }
        ArticleMediaPreservation.ValidateInventory(media, mediaLimits);
        if (Convert.ToHexString(documents.GetHashAndReset()).ToLowerInvariant() != media.SourceDocumentsDigest
            || media.Files.Any(file => file.Aliases.Any(alias =>
                alias.ArticleId is <= 0 or > int.MaxValue || !sourceIds.Contains((int)alias.ArticleId))))
            Reject("media_source_binding");
        var plan = new ArticlePreservationWritePlan(source.Artifact, data.FullSourceContentDigest,
            current.Artifact, categories, tags, articles.ToImmutable(), media, string.Empty);
        return plan with
        {
            ContentDigest = ArticlePreservationSemanticReceipt.ComputePlanDigest(plan)
        };
    }

    private static ImmutableArray<ArticlePreservationTaxonomyMap> MapTaxonomy(
        ImmutableArray<LegacyArticlePreservationTaxonomy> source, ImmutableArray<ArticlePreservationTaxonomyMap> maps)
    {
        if (maps.IsDefault || maps.Length != source.Length || source.Any(static row => row is null))
            Reject("taxonomy_count");
        var sourceIds = new HashSet<int>();
        var targetIds = new HashSet<int>();
        var targetNames = new HashSet<string>(StringComparer.Ordinal);
        var mapsBySourceId = new Dictionary<int, ArticlePreservationTaxonomyMap>(maps.Length);
        foreach (ArticlePreservationTaxonomyMap map in maps)
            if (map is null || !mapsBySourceId.TryAdd(map.SourceId, map))
                Reject("taxonomy_explicit_mapping");
        var result = ImmutableArray.CreateBuilder<ArticlePreservationTaxonomyMap>(source.Length);
        foreach (LegacyArticlePreservationTaxonomy row in source.OrderBy(static row => row.Id))
        {
            if (row is null || row.Id <= 0 || row.Name is null || !sourceIds.Add(row.Id))
                Reject("taxonomy_source_identity");
            if (!mapsBySourceId.TryGetValue(row.Id, out ArticlePreservationTaxonomyMap? map)
                || map.SourceName != row.Name || map.TargetId <= 0
                || string.IsNullOrWhiteSpace(map.TargetName) || !targetIds.Add(map.TargetId)
                || !targetNames.Add(map.TargetName))
                Reject("taxonomy_explicit_mapping");
            result.Add(map);
        }
        return result.ToImmutable();
    }

    [System.Diagnostics.CodeAnalysis.DoesNotReturn]
    private static void Reject(string code) => throw new InvalidOperationException("article_preservation_" + code);
}
