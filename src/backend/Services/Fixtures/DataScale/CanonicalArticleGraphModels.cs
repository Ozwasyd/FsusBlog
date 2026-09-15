using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

public sealed record ArticleScaleRowPlan(
    ArticleScaleRowKind Kind,
    string SemanticId,
    IReadOnlyDictionary<string, object?> Fields);

public sealed record ArticleScaleRelationPlan(
    ArticleScaleRelationKind Kind,
    string SourceSemanticId,
    string TargetSemanticId);

public sealed record ArticleScalePointerPlan(
    ArticleScalePointerKind Kind,
    string TargetSemanticId);

public sealed record ArticleScaleEdgeObligationPlan(
    string OutboxSemanticId,
    string EdgeName);

public sealed record ArticleScaleArticleGraph(
    string SemanticArticleId,
    int ArticleOrdinal,
    ArticleScaleVariant Variant,
    IReadOnlyList<ArticleScaleRowPlan> Rows,
    IReadOnlyList<ArticleScaleRelationPlan> Relations,
    IReadOnlyList<ArticleScalePointerPlan> Pointers,
    IReadOnlyList<ArticleScaleEdgeObligationPlan> EdgeObligations,
    string ArticleDigest);

public sealed record ArticleScaleGraphReceipt(
    string Schema,
    string PlanSchema,
    string PlanDigest,
    string FactoryId,
    IReadOnlyDictionary<string, string> ProductionContractVersions,
    IReadOnlyDictionary<string, int> VariantCounts,
    IReadOnlyDictionary<string, long> RowCounts,
    long EdgeCount,
    string SemanticGraphDigest,
    long ElapsedMilliseconds,
    long PeakMemoryBytes,
    string ContentDigest);

public sealed record CanonicalArticleGraphVerificationResult(
    bool IsValid,
    IReadOnlyList<string> Violations)
{
    public void ThrowIfInvalid()
    {
        if (!IsValid)
        {
            throw new InvalidOperationException(
                $"canonical_article_graph_verification_failed: {string.Join("; ", Violations)}");
        }
    }
}
