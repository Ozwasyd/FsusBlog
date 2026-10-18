using System.Collections.Immutable;

using FsusBlog.Contracts.Articles;
using FsusBlog.Contracts.Migration;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Migration;

internal sealed record ArticlePreservationDefaultPolicyData(
    CurrentSchemaArtifactReference SourceArtifact, string FingerprintId, string SourceContentDigest,
    string SiteAuthor, int ArticleStatus, long RevisionCreatorId, int ResponsibilityVersion,
    ArticleRightsNormalizedModel Rights, ArticleResponsibilityDraft Responsibility, int InitialLiveViews, string PolicyDigest);
internal sealed record ArticlePreservationDefaultPolicyExport(
    CurrentSchemaArtifactReference Artifact, ImmutableArray<byte> Bytes, ArticlePreservationDefaultPolicyData Data);

/// <summary>
/// Prepares exact artifacts from the current compiled pure owners and an already captured source.
/// Artifact bytes and their SHA are separate from the semantic policy digest. Preparing bytes is
/// not publication, source admission, a historical human approval, or permission to write a target.
/// Publish methods use the single Migration artifact publisher and retain the exact prepared byte seal.
/// </summary>
internal static class ArticlePreservationPolicyExporter
{
    internal static async Task<ArticlePreservationSourceExport> PublishSourceAsync(
        ArticlePreservationSourceReadResult read, string absoluteOutputPath, CancellationToken cancellationToken)
    {
        ArticlePreservationSourceExport prepared = PrepareSource(read, absoluteOutputPath, cancellationToken);
        CurrentSchemaArtifactReference published = await OfflineMigrationArtifactPublisher.PublishAsync(
            absoluteOutputPath, prepared.Bytes.AsMemory(), cancellationToken).ConfigureAwait(false);
        if (published != prepared.Artifact)
            throw new InvalidOperationException("article_preservation_source_publication_binding");
        return prepared;
    }

    internal static async Task<ArticlePreservationDefaultPolicyExport> PublishDefaultPolicyAsync(
        ArticlePreservationSourceExport source, string absoluteOutputPath, CancellationToken cancellationToken)
    {
        ArticlePreservationDefaultPolicyExport prepared = PrepareDefaultPolicy(source, absoluteOutputPath, cancellationToken);
        CurrentSchemaArtifactReference published = await OfflineMigrationArtifactPublisher.PublishAsync(
            absoluteOutputPath, prepared.Bytes.AsMemory(), cancellationToken).ConfigureAwait(false);
        if (published != prepared.Artifact)
            throw new InvalidOperationException("article_preservation_policy_publication_binding");
        return prepared;
    }

    internal static async Task<ArticlePreservationCurrentPackage> PublishCurrentPackageAsync(
        ArticlePreservationSourceExport source, LegacyArticlePreservationRow row,
        ArticlePreservationDefaultPolicyExport policy, int categoryId, ImmutableArray<int> tagIds,
        ArticlePreservationGraphCoordinates coordinates, string absoluteOutputPath,
        CancellationToken cancellationToken)
    {
        ArticlePreservationCurrentPackage prepared = PrepareCurrentPackage(
            source, row, policy, categoryId, tagIds, coordinates, absoluteOutputPath, cancellationToken);
        CurrentSchemaArtifactReference published = await OfflineMigrationArtifactPublisher.PublishAsync(
            absoluteOutputPath, prepared.Bytes.AsMemory(), cancellationToken).ConfigureAwait(false);
        if (published != prepared.Artifact)
            throw new InvalidOperationException("article_preservation_package_publication_binding");
        return prepared;
    }

    internal static async Task<ArticlePreservationCurrentExport> PublishCurrentExportAsync(
        ArticlePreservationSourceExport source, ArticlePreservationDefaultPolicyExport policy,
        ImmutableArray<ArticlePreservationTaxonomyMap> categories, ImmutableArray<ArticlePreservationTaxonomyMap> tags,
        ImmutableArray<ArticlePreservationCurrentPackage> articles, string absoluteOutputPath,
        CancellationToken cancellationToken)
    {
        ArticlePreservationCurrentExport prepared = PrepareCurrentExport(
            source, policy, categories, tags, articles, absoluteOutputPath, cancellationToken);
        CurrentSchemaArtifactReference published = await OfflineMigrationArtifactPublisher.PublishAsync(
            absoluteOutputPath, prepared.Bytes.AsMemory(), cancellationToken).ConfigureAwait(false);
        if (published != prepared.Artifact)
            throw new InvalidOperationException("article_preservation_current_publication_binding");
        return prepared;
    }

    internal static ArticlePreservationSourceExport PrepareSource(
        ArticlePreservationSourceReadResult read, string artifactReference, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(read);
        cancellationToken.ThrowIfCancellationRequested();
        if (read.Data.FullSourceContentDigest != read.Observation.ContentDigest
            || read.Data.FingerprintId != OfflineMigrationSourceFingerprints.CreateRegistry().Match(read.Observation).Id
            || read.Data.ConfiguredSiteAuthor != read.ConfiguredSiteAuthor
            || read.Data.DiscardedDomains is null || read.DiscardedDomains.IsDefault
            || !read.Data.DiscardedDomains.SequenceEqual(read.DiscardedDomains))
            throw new InvalidOperationException("article_preservation_source_capture_binding");
        byte[] bytes = ArticlePreservationSemanticReceipt.Serialize(read.Data);
        return new(Reference(artifactReference, bytes), bytes.ToImmutableArray(), read.Data);
    }

    internal static ArticlePreservationDefaultPolicyExport PrepareDefaultPolicy(
        ArticlePreservationSourceExport source, string artifactReference, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(source);
        cancellationToken.ThrowIfCancellationRequested();
        ArticlePreservationSemanticReceipt.RequireArtifact(source.Artifact, source.Bytes, source.Data);
        ArticlePreservationDefaultPolicyData policy = CurrentDefaults(source);
        byte[] bytes = ArticlePreservationSemanticReceipt.Serialize(policy);
        return new(Reference(artifactReference, bytes), bytes.ToImmutableArray(), policy);
    }

    internal static void RequireDefaultPolicy(
        ArticlePreservationSourceExport source, ArticlePreservationDefaultPolicyExport policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        ArticlePreservationSemanticReceipt.RequireArtifact(policy.Artifact, policy.Bytes, policy.Data);
        if (!policy.Bytes.AsSpan().SequenceEqual(ArticlePreservationSemanticReceipt.Serialize(CurrentDefaults(source))))
            throw new InvalidOperationException("article_preservation_current_default_policy");
    }

    internal static ArticlePreservationCurrentExport PrepareCurrentExport(
        ArticlePreservationSourceExport source, ArticlePreservationDefaultPolicyExport policy,
        ImmutableArray<ArticlePreservationTaxonomyMap> categories, ImmutableArray<ArticlePreservationTaxonomyMap> tags,
        ImmutableArray<ArticlePreservationCurrentPackage> articles, string artifactReference,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RequireDefaultPolicy(source, policy);
        if (categories.IsDefault || tags.IsDefault || articles.IsDefault || articles.Length != source.Data.ExpectedArticleCount)
            throw new InvalidOperationException("article_preservation_complete_current_collection_required");
        byte[] bytes = ArticlePreservationSemanticReceipt.Serialize(
            new
            {
                Categories = categories,
                Tags = tags,
                Articles = articles,
                DefaultPolicy = policy
            });
        return new(Reference(artifactReference, bytes), bytes.ToImmutableArray(), categories, tags, articles, policy);
    }

    internal static ArticlePreservationCurrentPackage PrepareCurrentPackage(
        ArticlePreservationSourceExport source, LegacyArticlePreservationRow row,
        ArticlePreservationDefaultPolicyExport policy, int categoryId, ImmutableArray<int> tagIds,
        ArticlePreservationGraphCoordinates coordinates, string artifactReference,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RequireDefaultPolicy(source, policy);
        if (row is null || row.Markdown is null || coordinates is null || categoryId <= 0 || tagIds.IsDefault)
            throw new InvalidOperationException("article_preservation_source_row_required");
        var article = new ArticleCanonicalInput(row.Id, row.Id, 1, $"article:{row.Id}", row.Title,
            row.Summary, null, categoryId, tagIds.Order().ToImmutableArray(),
            row.IsDeleted ? ArticleStatusValues.Deleted : policy.Data.ArticleStatus,
            row.CreateTime, null, row.Markdown);
        var data = new ArticlePreservationCurrentData(row.Id, article, policy.Data.Rights,
            policy.Data.Responsibility, policy.Data.SiteAuthor, coordinates, policy.Artifact);
        byte[] bytes = ArticlePreservationSemanticReceipt.Serialize(data);
        return new(Reference(artifactReference, bytes), bytes.ToImmutableArray(), data);
    }

    private static ArticlePreservationDefaultPolicyData CurrentDefaults(ArticlePreservationSourceExport source)
    {
        if (source.Data.FingerprintId != OfflineMigrationSourceFingerprints.LegacyId
            || !ArticlePreservationSemanticReceipt.IsDigest(source.Data.FullSourceContentDigest))
            throw new InvalidOperationException("article_preservation_default_policy_source_profile");
        var policy = new ArticlePreservationDefaultPolicyData(source.Artifact, source.Data.FingerprintId,
            source.Data.FullSourceContentDigest, PublicSiteAuthorPolicy.Resolve(source.Data.ConfiguredSiteAuthor),
            ArticleCurrentPolicyDefaults.Status, ArticleCurrentPolicyDefaults.UnattributedCreatorId,
            ArticleCurrentPolicyDefaults.ResponsibilityVersion,
            ArticleProductionNormalizers.NormalizeArticleRights(null),
            ArticleCurrentPolicyDefaults.ResponsibilityDraft(), ArticleCurrentPolicyDefaults.InitialLiveViews, string.Empty);
        return policy with
        {
            PolicyDigest = ArticlePreservationSemanticReceipt.Digest("article-current-stored-defaults-v1", policy)
        };
    }

    private static CurrentSchemaArtifactReference Reference(string reference, byte[] bytes)
    {
        if (string.IsNullOrWhiteSpace(reference))
            throw new ArgumentException("An explicit artifact reference is required.", nameof(reference));
        return new(reference, ArticlePreservationSemanticReceipt.HashBytes(bytes));
    }
}
