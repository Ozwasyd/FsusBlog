using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Tools.DataScale;

/// <summary>
/// A reference projection of an independently validated owner plan. This carries no
/// native allocation, graph generation, database execution or release qualification.
/// </summary>
public sealed class DistributionArticlePlanCompilerInput
{
    public const string SchemaId = "fsusblog.distribution-article-plan-compiler-input.v1";

    private DistributionArticlePlanCompilerInput(ArticleScalePlan plan)
    {
        OwnerPlanDigest = plan.ContentDigest;
        ScaleTier = plan.ScaleTier;
        Namespace = plan.Namespace;
        ArticleCount = plan.ArticleCount;
        ArticleOrdinalBase = plan.IdAllocation.ArticleOrdinalBase;
        VariantAllocations = Array.AsReadOnly(plan.StateDistribution
            .Select(static allocation => new DistributionArticleVariantAllocation(
                allocation.Variant.ToString(), allocation.Count))
            .ToArray());
        ArtifactBindings = CopyArtifacts(plan.Artifacts);
    }

    [JsonPropertyName("schema")]
    public string Schema => SchemaId;

    [JsonPropertyName("purpose")]
    public string Purpose => "owner-plan-reference-projection-only";

    [JsonPropertyName("ownerPlanDigest")]
    public string OwnerPlanDigest
    {
        get;
    }

    [JsonPropertyName("scaleTier")]
    public string ScaleTier
    {
        get;
    }

    [JsonPropertyName("namespace")]
    public string Namespace
    {
        get;
    }

    [JsonPropertyName("articleCount")]
    public int ArticleCount
    {
        get;
    }

    [JsonPropertyName("articleOrdinalBase")]
    public int ArticleOrdinalBase
    {
        get;
    }

    [JsonPropertyName("variantAllocations")]
    public ReadOnlyCollection<DistributionArticleVariantAllocation> VariantAllocations
    {
        get;
    }

    [JsonPropertyName("artifactBindings")]
    public ArticleScaleArtifactBindings ArtifactBindings
    {
        get;
    }

    /// <summary>
    /// Validate a defensive typed snapshot with the existing owner validator and
    /// exact expected digest. The caller supplies independent artifact authorities;
    /// this export cannot authenticate their provenance or create a producer receipt.
    /// </summary>
    public static DistributionArticlePlanCompilerInput Export(
        ArticleScalePlan plan,
        ArticleScaleArtifactBindings authoritativeArtifacts,
        string expectedPlanDigest)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(authoritativeArtifacts);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedPlanDigest);

        // Snapshot all nested owner contracts before validation so later caller edits
        // cannot change the exported reference identities or allocation counts.
        ArticleScalePlan snapshot = Snapshot(plan);
        ArticleScaleArtifactBindings authorities = Snapshot(authoritativeArtifacts);
        ArticleScalePlanValidator.Validate(snapshot, authorities).ThrowIfInvalid();
        string actualDigest = ArticleScalePlanDigest.Compute(snapshot);
        if (!string.Equals(actualDigest, expectedPlanDigest, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Expected owner plan digest does not match the validated plan.");
        }

        return new DistributionArticlePlanCompilerInput(snapshot);
    }

    private static T Snapshot<T>(T value)
        => JsonSerializer.Deserialize<T>(JsonSerializer.SerializeToUtf8Bytes(value))
            ?? throw new InvalidOperationException("Owner contract snapshot could not be deserialized.");

    private static ArticleScaleArtifactBindings CopyArtifacts(ArticleScaleArtifactBindings artifacts)
        => new(
            artifacts.Temporal with
            {
            },
            artifacts.Distribution with
            {
            },
            Array.AsReadOnly(artifacts.Content.Select(static reference => reference with { }).ToArray()),
            Array.AsReadOnly(artifacts.Media.Select(static reference => reference with { }).ToArray()),
            Array.AsReadOnly(artifacts.Taxonomy.Select(static reference => reference with { }).ToArray()));
}

/// <summary>A count and enum name copied from the canonical allocation, without status semantics.</summary>
public sealed record DistributionArticleVariantAllocation(
    [property: JsonPropertyName("variant")] string Variant,
    [property: JsonPropertyName("count")] int Count);
