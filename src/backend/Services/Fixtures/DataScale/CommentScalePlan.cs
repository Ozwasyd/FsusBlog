using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Moderation;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>Versioned reference-only plan. It neither generates nor admits graph rows.</summary>
public sealed record CommentScalePlan(
    string Schema,
    string GraphSchema,
    string Namespace,
    string ScaleTier,
    long CommentCount,
    long ArticleCount,
    CommentScaleArtifactReference ArticlePlan,
    CommentScaleArtifactReference Content,
    CommentScaleArtifactReference Temporal,
    IReadOnlyList<CommentScaleScenario> Scenarios,
    string ContentDigest);

/// <summary>
/// A bounded template allocation over disjoint article target roles. Each repetition
/// requires a distinct target binding from the article owner. Parent and reply roles
/// are requests to the thread authority; no computed coordinates are supplied here.
/// </summary>
public sealed record CommentScaleScenario(
    string Role,
    CommentScaleThreadShape ThreadShape,
    string ArticleTargetRole,
    long Repetitions,
    IReadOnlyList<CommentScaleCommentRequest> Comments,
    CommentScaleGraphRequirements Graph);

/// <summary>
/// Comment request referencing content, actor, region and time facts. ContentRole
/// still requires a verified generated-content artifact from the content owner.
/// </summary>
public sealed record CommentScaleCommentRequest(
    string Role,
    string? ParentRole,
    string? ReplyTargetRole,
    string ActorMode,
    CommentScaleCredentialValidity CredentialValidity,
    string ActorEvidenceDigest,
    string ContentRole,
    CommentScaleArtifactReference ContentArtifact,
    string RegionEvidenceDigest,
    string CreatedAtRole,
    IReadOnlyList<CommentScaleModerationStep> Moderation);

/// <summary>
/// Planned status history. Initial decisions and full event schemas still require
/// production authority validation; subsequent transitions use the production rule.
/// </summary>
public sealed record CommentScaleModerationStep(
    CommentModerationStatus? Previous,
    CommentModerationStatus Next,
    string ReasonRole,
    string OccurredAtRole);

/// <summary>
/// Structural diagnostics only. Success is not a validated-factory token, execution
/// receipt, authenticated credential result or proof of production graph equivalence.
/// </summary>
public sealed record CommentScalePlanInspection(
    IReadOnlyList<string> Errors)
{
    public bool IsStructurallyValid => Errors.Count == 0;
}

/// <summary>
/// Checks closed plan shape, reference identity and request continuity before a
/// canonical owner resolves business semantics. Missing authorities fail inspection.
/// </summary>
public static class CommentScalePlanContract
{
    public const string Schema = "fsusblog.comment-scale-plan.v1";
    public const string GraphSchema = "fsusblog.comment-scale-graph-requirements.v1";
    private static readonly JsonSerializerOptions s_json = new()
    {
        RespectRequiredConstructorParameters = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    /// <summary>Binds every plan declaration, including provenance and request order.</summary>
    public static string ComputeDigest(CommentScalePlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(plan with
        {
            ContentDigest = string.Empty
        }, s_json);
        return "sha256:" + Convert.ToHexStringLower(SHA256.HashData(bytes));
    }

    /// <summary>Rejects missing, duplicate and unknown members at the closed JSON boundary.</summary>
    public static CommentScalePlan Parse(string json)
    {
        ArgumentNullException.ThrowIfNull(json);
        if (json.Length > 1024 * 1024)
        {
            throw new InvalidOperationException("comment_scale_plan_size_limit");
        }
        using JsonDocument document = JsonDocument.Parse(json);
        RejectDuplicateMembers(document.RootElement);
        return JsonSerializer.Deserialize<CommentScalePlan>(json, s_json)
            ?? throw new JsonException("comment_scale_plan_missing");
    }

    /// <summary>
    /// Binds time requests to the existing resolved-role consumer. It never calculates
    /// offsets or reads a business clock. Artifact digest equality is ingress binding.
    /// </summary>
    public static CommentScalePlanInspection Inspect(
        CommentScalePlan plan,
        ResolvedTemporalRoleContext temporal)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(temporal);
        var errors = new List<string>();
        Require(plan.Schema == Schema, "plan_schema", errors);
        Require(plan.GraphSchema == GraphSchema, "graph_schema", errors);
        Require(IsRole(plan.Namespace) && IsRole(plan.ScaleTier), "plan_identity", errors);
        Require(plan.CommentCount >= 0 && plan.ArticleCount >= 0, "plan_counts", errors);
        Require(IsArtifact(plan.ArticlePlan, ArticleScaleContractIds.PlanSchema), "article_artifact", errors);
        Require(IsArtifact(plan.Content, ArticleScaleContractIds.ContentShapeCatalogSchema), "content_artifact", errors);
        Require(IsArtifact(plan.Temporal, ArticleScaleContractIds.TemporalArtifactSchema)
            && plan.Temporal.ContentDigest == temporal.ContentDigest, "temporal_artifact", errors);
        Require(IsDigest(plan.ContentDigest) && plan.ContentDigest == ComputeDigest(plan), "plan_digest", errors);
        if (plan.Scenarios is null)
        {
            errors.Add("scenarios_missing");
            return new CommentScalePlanInspection(errors.AsReadOnly());
        }

        long comments = 0;
        long articles = 0;
        var scenarioRoles = new HashSet<string>(StringComparer.Ordinal);
        var articleRoles = new HashSet<string>(StringComparer.Ordinal);
        foreach (CommentScaleScenario scenario in plan.Scenarios)
        {
            if (scenario is null)
            {
                errors.Add("scenario_missing");
                continue;
            }
            Require(IsRole(scenario.Role) && scenarioRoles.Add(scenario.Role), "scenario_role", errors);
            Require(IsRole(scenario.ArticleTargetRole) && articleRoles.Add(scenario.ArticleTargetRole), "article_target_role", errors);
            Require(Enum.IsDefined(scenario.ThreadShape), "thread_shape", errors);
            Require(scenario.Repetitions > 0, "scenario_repetitions", errors);
            if (scenario.Comments is null)
            {
                errors.Add("comments_missing");
                continue;
            }
            try
            {
                articles = checked(articles + scenario.Repetitions);
                comments = checked(comments + scenario.Repetitions * scenario.Comments.Count);
            }
            catch (OverflowException)
            {
                errors.Add("allocation_overflow");
            }
            Require((scenario.ThreadShape == CommentScaleThreadShape.ZeroCommentArticle)
                == (scenario.Comments.Count == 0), "zero_comment_allocation", errors);
            InspectGraph(scenario.Graph, errors);
            InspectRequests(scenario.Comments, temporal, errors);
        }
        Require(comments == plan.CommentCount && articles == plan.ArticleCount, "allocation_counts", errors);
        return new CommentScalePlanInspection(errors.AsReadOnly());
    }

    private static void InspectGraph(CommentScaleGraphRequirements graph, List<string> errors)
    {
        if (graph?.Relations is null || graph.Authorities is null)
        {
            errors.Add("graph_requirements_missing");
            return;
        }
        Require(graph.Relations.Count == Enum.GetValues<CommentScaleRelation>().Length
            && graph.Relations.All(Enum.IsDefined)
            && graph.Relations.Distinct().Count() == graph.Relations.Count, "graph_relations", errors);
        Require(graph.Authorities.Count == Enum.GetValues<CommentScaleAuthority>().Length
            && graph.Authorities.All(reference => reference is not null
                && Enum.IsDefined(reference.Authority)
                && IsCommit(reference.SourceCommit)
                && IsDigest(reference.ContractDigest))
            && graph.Authorities.Where(reference => reference is not null)
                .Select(reference => reference.Authority).Distinct().Count() == graph.Authorities.Count,
            "graph_authorities", errors);
    }

    private static void InspectRequests(
        IReadOnlyList<CommentScaleCommentRequest> comments,
        ResolvedTemporalRoleContext temporal,
        List<string> errors)
    {
        var previousRoles = new HashSet<string>(StringComparer.Ordinal);
        foreach (CommentScaleCommentRequest request in comments)
        {
            if (request is null)
            {
                errors.Add("comment_request_missing");
                continue;
            }
            Require(IsRole(request.Role) && !previousRoles.Contains(request.Role), "comment_role", errors);
            Require(request.ParentRole is null || previousRoles.Contains(request.ParentRole), "parent_role", errors);
            Require(request.ReplyTargetRole is null || previousRoles.Contains(request.ReplyTargetRole), "reply_target_role", errors);
            Require((request.ParentRole is null) == (request.ReplyTargetRole is null), "reply_request", errors);
            previousRoles.Add(request.Role);
            bool publicActor = request.ActorMode == CommentAuthorModes.Public;
            Require(publicActor || request.ActorMode == CommentAuthorModes.ZkAnonymous, "actor_mode", errors);
            Require(Enum.IsDefined(request.CredentialValidity)
                && (publicActor
                    ? request.CredentialValidity == CommentScaleCredentialValidity.PublicAuthenticated
                    : request.CredentialValidity is CommentScaleCredentialValidity.VerifiedTestCredential
                        or CommentScaleCredentialValidity.ScaleSyntheticTestOnly), "credential_class", errors);
            Require(IsDigest(request.ActorEvidenceDigest) && IsDigest(request.RegionEvidenceDigest), "evidence_digest", errors);
            Require(IsRole(request.ContentRole), "content_role", errors);
            Require(IsArtifact(request.ContentArtifact, "fsusblog.generated-content-shape.v1"), "generated_content_artifact", errors);
            DateTimeOffset? created = RequireInstant(request.CreatedAtRole, temporal, errors);
            if (request.Moderation is null || request.Moderation.Count == 0)
            {
                errors.Add("moderation_missing");
                continue;
            }
            CommentModerationStatus? previous = null;
            DateTimeOffset? previousInstant = created;
            foreach (CommentScaleModerationStep step in request.Moderation)
            {
                if (step is null)
                {
                    errors.Add("moderation_step_missing");
                    continue;
                }
                Require(step.Previous == previous && Enum.IsDefined(step.Next), "moderation_continuity", errors);
                if (previous.HasValue)
                {
                    Require(CommentModerationTransitions.IsAllowed(previous.Value, step.Next), "moderation_transition", errors);
                }
                Require(IsRole(step.ReasonRole), "moderation_reason_role", errors);
                DateTimeOffset? instant = RequireInstant(step.OccurredAtRole, temporal, errors);
                Require(previousInstant.HasValue && instant.HasValue && previousInstant <= instant, "moderation_time_order", errors);
                previous = step.Next;
                previousInstant = instant;
            }
        }
    }

    private static DateTimeOffset? RequireInstant(
        string role,
        ResolvedTemporalRoleContext temporal,
        List<string> errors)
    {
        if (IsRole(role))
        {
            try
            {
                return temporal.RequireInstant(role);
            }
            catch (InvalidOperationException)
            {
                errors.Add("temporal_role_missing");
                return null;
            }
        }
        errors.Add("temporal_role_invalid");
        return null;
    }

    private static bool IsArtifact(CommentScaleArtifactReference reference, string schema)
        => reference is not null && reference.Schema == schema && IsDigest(reference.ContentDigest);

    private static void RejectDuplicateMembers(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    throw new JsonException($"comment_scale_duplicate_member: {property.Name}");
                }
                RejectDuplicateMembers(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicateMembers(item);
            }
        }
    }

    private static bool IsDigest(string value)
        => value is not null && value.Length == 71 && value.StartsWith("sha256:", StringComparison.Ordinal)
            && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private static bool IsCommit(string value)
        => value is not null && value.Length == 40 && value.AsSpan().IndexOfAnyExcept("0123456789abcdef") < 0;

    private static bool IsRole(string value)
        => !string.IsNullOrWhiteSpace(value) && value.Length <= 128
            && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '.' or '_' or ':');

    private static void Require(bool condition, string error, List<string> errors)
    {
        if (!condition)
        {
            errors.Add(error);
        }
    }
}
