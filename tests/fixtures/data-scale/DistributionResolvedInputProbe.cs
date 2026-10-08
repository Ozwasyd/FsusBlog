using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Services.Fixtures.DataScale;
using FsusBlog.Tooling.DataScale;

namespace FsusBlog.Tests.DataScale;

/// <summary>Actual owner API controls with explicit unit values; no DB or release receipt.</summary>
internal static class DistributionResolvedInputProbe
{
    private static int s_checks;

    private static void Main()
    {
        ArticleScalePlan plan = Plan("scale-s");
        List<ArticleScaleResolvedInput> inputs = Inputs(plan);
        int deleted = inputs.FindIndex(input => input.Variant == ArticleScaleVariant.Deleted);
        inputs[0] = Input(plan, inputs[0].ArticleOrdinal, ArticleScaleVariant.Deleted);
        inputs[deleted] = Input(plan, inputs[deleted].ArticleOrdinal, ArticleScaleVariant.Published);
        ArticleScaleOrdinalAssignment[] roster = Roster(inputs);
        var coverage = new ArticleScaleAssignmentCoverage(plan, "unit-only-distribution-reference", roster);
        var prepared = Prepare(plan, coverage, [inputs[0], inputs[deleted]]);
        Check(prepared.Graphs.Count == 2, "bounded_graph_count");
        Check(prepared.Graphs[0].Variant == ArticleScaleVariant.Deleted, "reordered_lifecycle_consumed");
        ArticleScaleRowPlan article = prepared.Graphs[0].Rows.Single(row => row.Kind == ArticleScaleRowKind.Article);
        Check((string?)article.Fields["Title"] == inputs[0].Title, "resolved_title_consumed");
        Check((int?)article.Fields["Views"] == inputs[0].Views, "resolved_hotness_consumed");
        Check((int?)article.Fields["CategoryId"] == inputs[0].CategoryId, "resolved_taxonomy_consumed");
        Check(article.Fields["CoverImageUrl"] is null, "no_cover_preserved");
        Check(Prepare(plan, coverage, [inputs[0], inputs[deleted]]).Graphs[0].ArticleDigest == prepared.Graphs[0].ArticleDigest,
            "same_input_factory_digest");
        Reject(() => DistributionArticleResolvedInputAdapter.PrepareBatch(plan, coverage,
            Digest("stale-plan"), coverage.CoverageDigest, coverage.AssignmentAuthorityReference, [inputs[0]]),
            "distribution_resolved_owner_identity_mismatch");
        Reject(() => DistributionArticleResolvedInputAdapter.PrepareBatch(plan, coverage,
            coverage.PlanDigest, Digest("stale-coverage"), coverage.AssignmentAuthorityReference, [inputs[0]]),
            "distribution_resolved_owner_identity_mismatch");
        Reject(() => DistributionArticleResolvedInputAdapter.PrepareBatch(plan, coverage,
            coverage.PlanDigest, coverage.CoverageDigest, "different-authority", [inputs[0]]),
            "distribution_resolved_owner_identity_mismatch");
        Reject(() => Prepare(plan, coverage, []), "distribution_resolved_batch_bound_invalid");
        Reject(() => Prepare(plan, coverage, Enumerable.Repeat(inputs[0], 1001).ToArray()),
            "distribution_resolved_batch_bound_invalid");
        Reject(() => Prepare(plan, coverage, [inputs[0], inputs[0]]), "resolved_input_payload_bound_or_duplicate");
        Reject(() => Prepare(plan, coverage, [inputs[0] with { MarkdownContent = "changed after sealing" }]),
            "resolved_input_not_bound_to_complete_assignment");
        Reject(() => Prepare(plan, coverage, [inputs[0], inputs[deleted] with { HotnessAuthorityReference = "" }]),
            "resolved_input_authority_or_value_invalid");
        Reject(() => Prepare(plan, coverage, [inputs[0] with { TagIds = [23, 23] }]),
            "resolved_input_authority_or_value_invalid");
        Reject(() => Prepare(plan, coverage, [inputs[0] with { TemporalRoles = new Dictionary<string, DateTime>() }]),
            "resolved_input_authority_or_value_invalid");
        Reject(() => new ArticleScaleAssignmentCoverage(plan, coverage.AssignmentAuthorityReference, roster[..^1]),
            "resolved_assignment_coverage_bound_invalid");
        ArticleScaleOrdinalAssignment[] duplicate = roster.ToArray();
        duplicate[^1] = duplicate[0];
        Reject(() => new ArticleScaleAssignmentCoverage(plan, coverage.AssignmentAuthorityReference, duplicate),
            "resolved_assignment_ordinal_or_digest_invalid");
        ArticleScaleOrdinalAssignment[] outside = roster.ToArray();
        outside[^1] = outside[^1] with
        {
            ArticleOrdinal = int.MaxValue
        };
        Reject(() => new ArticleScaleAssignmentCoverage(plan, coverage.AssignmentAuthorityReference, outside),
            "resolved_assignment_ordinal_or_digest_invalid");
        ArticleScaleOrdinalAssignment[] counts = roster.ToArray();
        counts[^1] = counts[^1] with
        {
            Variant = ArticleScaleVariant.Published
        };
        Reject(() => new ArticleScaleAssignmentCoverage(plan, coverage.AssignmentAuthorityReference, counts),
            "resolved_assignment_variant_counts_mismatch");
        string before = prepared.Graphs[0].ArticleDigest;
        ((List<int>)inputs[0].TagIds).Clear();
        ((Dictionary<string, DateTime>)inputs[0].TemporalRoles).Clear();
        ArticleScaleArticleGraph replay = CanonicalArticleGraphFactory.BuildArticleGraph(plan,
            inputs[0].ArticleOrdinal, inputs[0].Variant, ArticleScaleVariantContractCatalog.Get(inputs[0].Variant),
            identities: null, resolvedBatch: prepared.ResolvedBatch);
        Check(replay.ArticleDigest == before, "owner_snapshot_survives_caller_mutation");

        // Source-only bounded roster control, not 100k graph generation or seed acceptance.
        ArticleScalePlan largePlan = Plan("scale-l-nightly");
        ArticleScaleOrdinalAssignment[] largeRoster = RosterStream(largePlan).ToArray();
        var largeCoverage = new ArticleScaleAssignmentCoverage(largePlan, "unit-only-large-roster", largeRoster);
        Check(largeRoster.Length == 100_000, "actual_owner_100k_roster_coverage");
        Check(Prepare(largePlan, largeCoverage, [Input(largePlan, 1, ArticleScaleVariant.Published)]).Graphs.Count == 1,
            "bounded_payload_with_large_roster");

        ArticleScaleResolvedInput original = Input(plan, inputs[deleted].ArticleOrdinal, ArticleScaleVariant.Published);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            Kind = "actual-owner-typed-api-unit-probe-not-db-or-release-receipt",
            ChecksPassed = s_checks,
            PlanArticleCount = plan.ArticleCount,
            LargeRosterCount = largeRoster.Length,
            LargePlanDigest = largeCoverage.PlanDigest,
            LargeCoverageDigest = largeCoverage.CoverageDigest,
            PlanDigest = coverage.PlanDigest,
            CoverageDigest = coverage.CoverageDigest,
            InputDigest = ArticleScaleAssignmentCoverage.ComputeInputDigest(original),
            Input = original,
            NativeAllocationInvoked = false,
            DatabaseWriterInvoked = false,
            ReleaseEvidenceEligible = false
        }));
    }

    private static (ArticleScaleResolvedGraphBatch ResolvedBatch, IReadOnlyList<ArticleScaleArticleGraph> Graphs) Prepare(
        ArticleScalePlan plan, ArticleScaleAssignmentCoverage coverage, IReadOnlyList<ArticleScaleResolvedInput> inputs)
        => DistributionArticleResolvedInputAdapter.PrepareBatch(plan, coverage, coverage.PlanDigest,
            coverage.CoverageDigest, coverage.AssignmentAuthorityReference, inputs);

    private static ArticleScalePlan Plan(string tier)
    {
        ArticleScaleArtifactReference Reference(string schema, string shape)
            => new(schema, "unit-only-original-typed-api-control", shape, Digest(shape));
        var artifacts = new ArticleScaleArtifactBindings(
            Reference(ArticleScaleContractIds.TemporalArtifactSchema, "data-scale.lifecycle"),
            Reference(ArticleScaleContractIds.FixtureVariantCatalogSchema, ArticleScaleContractIds.DistributionShape),
            [Reference(ArticleScaleContractIds.ContentShapeCatalogSchema, "script.zh-hans")],
            [Reference(ArticleScaleContractIds.MediaShapeCatalogSchema, "webp-landscape")],
            [Reference(ArticleScaleContractIds.FixtureVariantCatalogSchema, ArticleScaleContractIds.TaxonomyShape)]);
        return ArticleScalePlanBuilder.Create(tier, "distribution-typed-unit", artifacts);
    }

    private static List<ArticleScaleResolvedInput> Inputs(ArticleScalePlan plan)
    {
        var result = new List<ArticleScaleResolvedInput>();
        int ordinal = plan.IdAllocation.ArticleOrdinalBase;
        foreach (ArticleScaleVariantAllocation allocation in plan.StateDistribution)
        {
            for (int index = 0; index < allocation.Count; index++)
            {
                result.Add(Input(plan, ordinal++, allocation.Variant));
            }
        }
        return result;
    }

    private static IEnumerable<ArticleScaleOrdinalAssignment> RosterStream(ArticleScalePlan plan)
    {
        int ordinal = plan.IdAllocation.ArticleOrdinalBase;
        foreach (ArticleScaleVariantAllocation allocation in plan.StateDistribution)
        {
            for (int index = 0; index < allocation.Count; index++)
            {
                ArticleScaleResolvedInput input = Input(plan, ordinal++, allocation.Variant);
                yield return new(input.ArticleOrdinal, input.Variant, ArticleScaleAssignmentCoverage.ComputeInputDigest(input));
            }
        }
    }

    private static ArticleScaleOrdinalAssignment[] Roster(IEnumerable<ArticleScaleResolvedInput> inputs)
        => inputs.Select(input => new ArticleScaleOrdinalAssignment(input.ArticleOrdinal, input.Variant,
            ArticleScaleAssignmentCoverage.ComputeInputDigest(input))).ToArray();

    private static ArticleScaleResolvedInput Input(ArticleScalePlan plan, int ordinal, ArticleScaleVariant variant)
        => new(ordinal, variant, "Typed unit title", "# Typed unit content\n\nConsumed before factory sealing.",
            "Typed unit summary", null, 17, new List<int> { 23, 29 }, 1234,
            UnitTemporalMap(ordinal, variant), plan.Artifacts, "unit-only-hotness-reference");

    private static Dictionary<string, DateTime> UnitTemporalMap(int ordinal, ArticleScaleVariant variant)
    {
        // Test-only invocation of the real owner's internal fixture clock. The
        // adapter consumes typed temporal inputs and never calls this fallback.
        MethodInfo method = typeof(CanonicalArticleGraphFactory).GetMethod("ResolveTemporalMap",
            BindingFlags.Static | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("probe_owner_temporal_fixture_missing");
        var temporal = (IReadOnlyDictionary<string, DateTime>)method.Invoke(null,
            [ordinal, ArticleScaleVariantContractCatalog.Get(variant)])!;
        return new Dictionary<string, DateTime>(temporal);
    }

    private static string Digest(string value)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static void Check(bool condition, string control)
    {
        if (!condition)
        {
            throw new InvalidOperationException("probe_control_failed:" + control);
        }
        s_checks++;
    }

    private static void Reject(Action action, string code)
    {
        try
        {
            action();
        }
        catch (InvalidOperationException exception) when (exception.Message == code)
        {
            s_checks++;
            return;
        }
        throw new InvalidOperationException("probe_expected_refusal_missing:" + code);
    }
}
