using System.Collections.Immutable;

using FsusBlog.Contracts.Articles;
using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

// Historical rows remain Migration-owned. Current defaults have a separate compiled-owner export.
// These artifact inputs need independent source/current-owner admission; byte seals are integrity,
// not provenance. No production exporter, native operation or database authority is fabricated.
internal sealed record LegacyArticlePreservationRow(
    int Id, string Title, string? Markdown, string? Summary, int CategoryId,
    ImmutableArray<int> TagIds, int Views, DateTime CreateTime, bool IsDeleted);
internal sealed record LegacyArticlePreservationTaxonomy(int Id, string Name);
internal sealed record ArticlePreservationSourceData(
    string FingerprintId, string FullSourceContentDigest, CurrentSchemaArtifactReference OriginArtifact,
    Uri DocumentBase, int ExpectedArticleCount, int ExpectedCategoryCount, int ExpectedTagCount,
    ImmutableArray<LegacyArticlePreservationRow> Articles,
    ImmutableArray<LegacyArticlePreservationTaxonomy> Categories,
    ImmutableArray<LegacyArticlePreservationTaxonomy> Tags,
    string? ConfiguredSiteAuthor = null,
    IReadOnlyList<ArticlePreservationDiscardedDomain>? DiscardedDomains = null);
internal sealed record ArticlePreservationSourceExport(
    CurrentSchemaArtifactReference Artifact, ImmutableArray<byte> Bytes, ArticlePreservationSourceData Data);

// Explicit operator/current-owner mapping, never name-based first-match lookup.
internal sealed record ArticlePreservationTaxonomyMap(int SourceId, string SourceName, int TargetId, string TargetName);
internal sealed record ArticlePreservationGraphCoordinates(
    long ContentBlockId, long RightsPolicyId, long RightsSnapshotId, long ResponsibilitySnapshotId,
    int ResponsibilityVersion, long PublicationId, int PublicationNo, long CreatedByAdminPrincipalId,
    string DiffSummary, string PublicationTransitionKind, DateTime PublicationTime);
internal sealed record ArticlePreservationCurrentData(
    int SourceArticleId, ArticleCanonicalInput Article, ArticleRightsNormalizedModel Rights,
    ArticleResponsibilityDraft Responsibility, string? ConfiguredSiteAuthor,
    ArticlePreservationGraphCoordinates Coordinates,
    CurrentSchemaArtifactReference? DefaultPolicyArtifact = null);
internal sealed record ArticlePreservationCurrentPackage(
    CurrentSchemaArtifactReference Artifact, ImmutableArray<byte> Bytes, ArticlePreservationCurrentData Data);
internal sealed record ArticlePreservationCurrentExport(
    CurrentSchemaArtifactReference Artifact, ImmutableArray<byte> Bytes,
    ImmutableArray<ArticlePreservationTaxonomyMap> Categories,
    ImmutableArray<ArticlePreservationTaxonomyMap> Tags,
    ImmutableArray<ArticlePreservationCurrentPackage> Articles,
    ArticlePreservationDefaultPolicyExport? DefaultPolicy = null);

internal sealed record ArticlePreservationLimits(int MaximumArticles, int MaximumTaxonomyRows, long MaximumMetadataBytes);
internal sealed record ArticlePreservationArticleWritePlan(
    LegacyArticlePreservationRow Source, ArticlePreservationCurrentData Current,
    CurrentSchemaArtifactReference CurrentArtifact, ArticleRightsCanonicalBinding Canonical,
    string RawMarkdownSha256, string ResponsibilityDigest, string SemanticDigest,
    ArticleRevisionContentAddress ContentAddress);
/// <summary>
/// Pure immutable write input and content-addressed obligations, not a grant, database commit,
/// physical media verification, or current-schema receipt.
/// </summary>
internal sealed record ArticlePreservationWritePlan(
    CurrentSchemaArtifactReference SourceArtifact, string FullSourceContentDigest,
    CurrentSchemaArtifactReference CurrentArtifact,
    ImmutableArray<ArticlePreservationTaxonomyMap> Categories,
    ImmutableArray<ArticlePreservationTaxonomyMap> Tags,
    ImmutableArray<ArticlePreservationArticleWritePlan> Articles,
    ArticleMediaInventory Media, string ContentDigest);

// Values must come from the current owner's real envelope producer. Migration
// never synthesizes an EventId, event time, payload, media or source generation.
// Retain this exact batch across commit-unknown recovery; a new batch is not replay.
internal sealed record ArticlePreservationOutboxEnvelope(
    int ArticleId, string EventId, string PayloadJson, DateTime OccurredAt);
internal sealed record ArticlePreservationOutboxBatch(
    string PlanDigest, ImmutableArray<ArticlePreservationOutboxEnvelope> Events);
internal sealed record ArticlePreservationOutboxReceipt(
    int ArticleId, long OutboxId, string EventId);
