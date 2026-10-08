using System.Collections.ObjectModel;
using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>Resolved values supplied by the original shape/time authorities before factory sealing.</summary>
public sealed record ArticleScaleResolvedInput(
    int ArticleOrdinal, ArticleScaleVariant Variant,
    string Title, string MarkdownContent, string? Summary, string? CoverImageUrl,
    int CategoryId, IReadOnlyList<int> TagIds, int Views,
    IReadOnlyDictionary<string, DateTime> TemporalRoles,
    ArticleScaleArtifactBindings Artifacts, string HotnessAuthorityReference);

public sealed record ArticleScaleOrdinalAssignment(int ArticleOrdinal, ArticleScaleVariant Variant, string InputDigest);

/// <summary>
/// Small whole-plan coverage roster. This validates the existing plan's counts, not a new plan.
/// Payloads remain bounded batches; input hashes bind each payload before native allocation.
/// Producer references are opaque original-owner references, never qualified receipts.
/// </summary>
public sealed class ArticleScaleAssignmentCoverage
{
    private readonly IReadOnlyDictionary<int, ArticleScaleOrdinalAssignment> _assignments;
    public string PlanDigest
    {
        get;
    }
    public string AssignmentAuthorityReference
    {
        get;
    }
    public string CoverageDigest
    {
        get;
    }

    public ArticleScaleAssignmentCoverage(ArticleScalePlan plan, string assignmentAuthorityReference,
        IReadOnlyList<ArticleScaleOrdinalAssignment> assignments)
    {
        ArticleScalePlanValidator.Validate(plan, plan.Artifacts).ThrowIfInvalid();
        ArgumentException.ThrowIfNullOrWhiteSpace(assignmentAuthorityReference);
        if (assignmentAuthorityReference.Length > 2048 || assignments.Count != plan.ArticleCount)
        {
            throw new InvalidOperationException("resolved_assignment_coverage_bound_invalid");
        }
        var roster = new Dictionary<int, ArticleScaleOrdinalAssignment>();
        var counts = Enum.GetValues<ArticleScaleVariant>().ToDictionary(variant => variant, _ => 0);
        foreach (ArticleScaleOrdinalAssignment item in assignments)
        {
            if (item.ArticleOrdinal < plan.IdAllocation.ArticleOrdinalBase
                || (long)item.ArticleOrdinal >= (long)plan.IdAllocation.ArticleOrdinalBase + plan.ArticleCount
                || !counts.ContainsKey(item.Variant) || !IsDigest(item.InputDigest) || !roster.TryAdd(item.ArticleOrdinal, item))
            {
                throw new InvalidOperationException("resolved_assignment_ordinal_or_digest_invalid");
            }
            counts[item.Variant]++;
        }
        if (plan.StateDistribution.Any(allocation => allocation.Count != counts[allocation.Variant]))
        {
            throw new InvalidOperationException("resolved_assignment_variant_counts_mismatch");
        }
        PlanDigest = ArticleScalePlanDigest.Compute(plan);
        AssignmentAuthorityReference = assignmentAuthorityReference;
        _assignments = new ReadOnlyDictionary<int, ArticleScaleOrdinalAssignment>(roster);
        CoverageDigest = Hash(new
        {
            Schema = "fsusblog.article-scale-assignment-coverage.v1",
            PlanDigest,
            AssignmentAuthorityReference,
            Assignments = roster.Values.OrderBy(item => item.ArticleOrdinal)
        });
    }

    internal void Require(ArticleScalePlan plan, ArticleScaleResolvedInput input)
    {
        if (PlanDigest != ArticleScalePlanDigest.Compute(plan)
            || !_assignments.TryGetValue(input.ArticleOrdinal, out ArticleScaleOrdinalAssignment? assignment)
            || assignment.Variant != input.Variant || assignment.InputDigest != ComputeInputDigest(input))
        {
            throw new InvalidOperationException("resolved_input_not_bound_to_complete_assignment");
        }
    }

    public static string ComputeInputDigest(ArticleScaleResolvedInput input)
        => Hash(new
        {
            Schema = "fsusblog.article-scale-resolved-input.v1",
            input.ArticleOrdinal,
            input.Variant,
            input.Title,
            input.MarkdownContent,
            input.Summary,
            input.CoverImageUrl,
            input.CategoryId,
            TagIds = input.TagIds.Order(),
            input.Views,
            TemporalRoles = input.TemporalRoles.OrderBy(pair => pair.Key, StringComparer.Ordinal),
            input.Artifacts,
            input.HotnessAuthorityReference
        });

    private static string Hash<T>(T value)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value))).ToLowerInvariant();
    private static bool IsDigest(string value)
        => value.Length == 71 && value.StartsWith("sha256:", StringComparison.Ordinal)
            && !value.AsSpan(7).ContainsAnyExcept("0123456789abcdef");
}

/// <summary>Immutable, prevalidated resolved payloads for at most 1,000 existing factory graphs.</summary>
public sealed class ArticleScaleResolvedGraphBatch
{
    private readonly IReadOnlyDictionary<int, ArticleScaleResolvedInput> _inputs;
    public ArticleScaleAssignmentCoverage Coverage
    {
        get;
    }
    public IReadOnlyList<int> ArticleOrdinals
    {
        get;
    }

    public ArticleScaleResolvedGraphBatch(ArticleScalePlan plan, ArticleScaleAssignmentCoverage coverage,
        IReadOnlyList<ArticleScaleResolvedInput> inputs)
    {
        if (inputs.Count is < 1 or > 1000)
        {
            throw new InvalidOperationException("resolved_input_batch_bound_invalid");
        }
        Coverage = coverage;
        var frozen = new Dictionary<int, ArticleScaleResolvedInput>();
        long payloadBytes = 0;
        foreach (ArticleScaleResolvedInput input in inputs)
        {
            ValidateResolvedInput(plan, input);
            var snapshot = input with
            {
                TagIds = Array.AsReadOnly(input.TagIds.ToArray()),
                TemporalRoles = new ReadOnlyDictionary<string, DateTime>(new Dictionary<string, DateTime>(input.TemporalRoles, StringComparer.Ordinal)),
                Artifacts = input.Artifacts with
                {
                    Content = Array.AsReadOnly(input.Artifacts.Content.ToArray()),
                    Media = Array.AsReadOnly(input.Artifacts.Media.ToArray()),
                    Taxonomy = Array.AsReadOnly(input.Artifacts.Taxonomy.ToArray())
                }
            };
            payloadBytes += JsonSerializer.SerializeToUtf8Bytes(snapshot).LongLength;
            if (payloadBytes > 64 * 1024 * 1024 || !frozen.TryAdd(snapshot.ArticleOrdinal, snapshot))
            {
                throw new InvalidOperationException("resolved_input_payload_bound_or_duplicate");
            }
            ValidateResolvedInput(plan, snapshot);
            coverage.Require(plan, snapshot);
        }
        _inputs = new ReadOnlyDictionary<int, ArticleScaleResolvedInput>(frozen);
        ArticleOrdinals = Array.AsReadOnly(frozen.Keys.Order().ToArray());
    }

    internal ArticleScaleResolvedInput Resolve(ArticleScalePlan plan, int ordinal, ArticleScaleVariant variant)
    {
        if (!_inputs.TryGetValue(ordinal, out ArticleScaleResolvedInput? input) || input.Variant != variant)
        {
            throw new InvalidOperationException("resolved_batch_article_or_variant_mismatch");
        }
        Coverage.Require(plan, input);
        return input;
    }

    internal static void ValidateResolvedInput(ArticleScalePlan plan, ArticleScaleResolvedInput input)
    {
        if (!Enum.IsDefined(input.Variant) || string.IsNullOrWhiteSpace(input.Title) || input.Title.Length > 192
            || input.MarkdownContent is null || input.MarkdownContent.Length > 1_048_576
            || input.Summary?.Length > 512 || input.CoverImageUrl?.Length > 512
            || input.CategoryId <= 0 || input.Views < 0 || input.TagIds.Count > 256
            || input.TagIds.Any(id => id <= 0) || input.TagIds.Distinct().Count() != input.TagIds.Count
            || string.IsNullOrWhiteSpace(input.HotnessAuthorityReference) || input.HotnessAuthorityReference.Length > 2048
            || input.Artifacts.Content.Count != plan.Artifacts.Content.Count
            || input.Artifacts.Media.Count != plan.Artifacts.Media.Count
            || input.Artifacts.Taxonomy.Count != plan.Artifacts.Taxonomy.Count
            || JsonSerializer.Serialize(plan.Artifacts) != JsonSerializer.Serialize(input.Artifacts)
            || !ArticleScaleTemporalRoles.All.SetEquals(input.TemporalRoles.Keys)
            || input.TemporalRoles.Values.Any(time => time.Kind != DateTimeKind.Utc || time.Ticks % 10 != 0))
        {
            throw new InvalidOperationException("resolved_input_authority_or_value_invalid");
        }
        foreach (ArticleScaleTemporalOrderRequirement order in ArticleScaleVariantContractCatalog.Get(input.Variant).TemporalOrder)
        {
            int comparison = DateTime.Compare(input.TemporalRoles[order.EarlierRoleId], input.TemporalRoles[order.LaterRoleId]);
            if (order.Order == ArticleScaleTemporalOrder.SameInstant && comparison != 0
                || order.Order == ArticleScaleTemporalOrder.SameOrBefore && comparison > 0
                || order.Order == ArticleScaleTemporalOrder.StrictlyBefore && comparison >= 0)
            {
                throw new InvalidOperationException("resolved_input_temporal_order_invalid");
            }
        }
    }
}
