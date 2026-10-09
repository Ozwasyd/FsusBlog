using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Finite plan plus backend-only observed property provenance; no package or write admission.</summary>
public sealed record ArticlePackageCurrentPropertyPlanResult(
    bool IsValid,
    string? ReasonCode,
    ArticlePackageManifestCandidatePlan? Plan,
    IReadOnlyList<ArticlePackageCurrentPropertyProjection>? Sources);

public static partial class ArticlePackageManifestCandidatePlanner
{
    /// <summary>
    /// Replaces asserted property snapshots with actual authorized reads before using the sole
    /// finite planner. Other supplied metadata/bytes remain candidates, not persisted facts.
    /// Per-article repeat reads are not a group transaction or an atomic export fence.
    /// </summary>
    public static async Task<ArticlePackageCurrentPropertyPlanResult> ReadCurrentPropertiesAndCreateCandidatePlanAsync(
        long actorAdminPrincipalId,
        IReadOnlyList<ArticlePackageManifestCandidateInput> inputs,
        ArticlePackageCurrentPropertyReader properties,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(inputs);
        ArgumentNullException.ThrowIfNull(properties);
        cancellationToken.ThrowIfCancellationRequested();
        int count = inputs.Count;
        if (count is < 1 or > ArticlePackageManifestCandidateCodec.MaxArticles)
        {
            return new(false, "article_package_manifest_article_budget_exceeded", null, null);
        }
        var held = new ArticlePackageManifestCandidateInput[count];
        long sourceBytes = 0;
        for (int index = 0; index < count; index++)
        {
            ArticlePackageManifestCandidateInput input = inputs[index];
            if (input is null || input.Article is null || input.TitleBinding is null || input.PropertyBindings is null)
            {
                return new(false, "article_package_manifest_input_invalid", null, null);
            }
            sourceBytes += input.SourceBytes.Length;
            if (sourceBytes > MaxTotalSourceBytes)
            {
                return new(false, "article_package_manifest_source_byte_budget_exceeded", null, null);
            }
            held[index] = input;
        }
        var rebound = new ArticlePackageManifestCandidateInput[count];
        var sources = new ArticlePackageCurrentPropertyProjection[count];
        for (int index = 0; index < count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticlePackageManifestCandidateInput input = held[index];
            ArticlePackageCurrentPropertyReadResult read = await properties.ReadAndMapAsync(actorAdminPrincipalId,
                input.PropertyBindings, cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!read.IsValid)
            {
                return new(false, read.ReasonCode, null, null);
            }
            ArticlePackageCurrentPropertyProjection source = read.Projection!;
            sources[index] = source;
            rebound[index] = new(input.Article, input.TitleBinding, source.Source.Snapshot,
                input.PropertyBindings, input.SourceBytes);
            ArticlePackageManifestCandidateResult preflight = Preflight(rebound.Take(index + 1).ToArray());
            if (!preflight.IsValid)
            {
                return new(false, preflight.ReasonCode, null, null);
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        ArticlePackageManifestCandidateResult result = TryCreateCandidatePlan(rebound, out var plan);
        return result.IsValid
            ? new(true, null, plan, Array.AsReadOnly(sources))
            : new(false, result.ReasonCode, null, null);
    }
}
