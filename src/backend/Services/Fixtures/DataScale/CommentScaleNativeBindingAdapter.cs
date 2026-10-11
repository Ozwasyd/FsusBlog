using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>
/// Independent original-owner scope/artifact/role expectations, not a new native
/// allocation schema or admission token. The complete supplied binding roster must
/// come from its original authority; it is never inferred from planned statuses.
/// </summary>
public sealed record CommentScaleNativeBindingExpectation(
    string RunId,
    string RuntimeIdentity,
    string Provider,
    DataScaleNativeAllocationReference Allocation,
    CommentScaleArtifactReference BindingReference,
    IReadOnlyList<DataScaleNativeCommentRole> FactoryRoles);

/// <summary>
/// Consumes the original exact native-comment binding transport. This checks
/// structural scope/reference/role coverage only; it neither allocates identities
/// nor qualifies provenance, global uniqueness or a complete physical comment graph.
/// </summary>
public static class CommentScaleNativeBindingAdapter
{
    /// <summary>
    /// Checks an occurrence's original map scope and supplied complete role roster,
    /// including zero-comment occurrences. This allocates nothing and establishes
    /// neither role-roster provenance nor physical graph completeness/admission.
    /// </summary>
    public static void ValidateGraphBindings(
        CommentScalePlan plan,
        CommentScaleResolvedGraphIntent graph,
        ResolvedTemporalRoleContext temporal,
        DataScaleNativeCommentBindings identities,
        CommentScaleNativeBindingExpectation expected)
    {
        ArgumentNullException.ThrowIfNull(identities);
        RequireExpectations(expected);
        CommentScalePlan snapshot = ReadGraphPlan(plan, graph, temporal);
        _ = FindScenario(snapshot, graph.Occurrence);
        RequireNativeBindings(snapshot, graph, identities, expected);
    }

    /// <summary>
    /// Resolves one planned comment's initial native identity using original
    /// RequireCoverage and Resolve, then forwards supplied final comment facts.
    /// Revision/event/edge roles are supplied independently, never derived here.
    /// The PostgreSQL article sequence allocator is not a comment Snowflake allocator.
    /// Original allocation and role-roster admission remain caller responsibilities.
    /// </summary>
    public static CommentScaleInitialOutboxFacts BindInitialOutboxFacts(
        CommentScalePlan plan,
        CommentScaleResolvedGraphIntent graph,
        string commentRole,
        string entityRole,
        Comment normalizedComment,
        string occurredAtRole,
        ResolvedTemporalRoleContext temporal,
        DataScaleNativeCommentBindings identities,
        CommentScaleNativeBindingExpectation expected)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(graph);
        ArgumentNullException.ThrowIfNull(graph.Occurrence);
        ArgumentNullException.ThrowIfNull(graph.Comments);
        ArgumentNullException.ThrowIfNull(normalizedComment);
        ArgumentNullException.ThrowIfNull(temporal);
        ArgumentNullException.ThrowIfNull(identities);
        RequireExpectations(expected);
        ArgumentException.ThrowIfNullOrWhiteSpace(commentRole);
        ArgumentException.ThrowIfNullOrWhiteSpace(entityRole);
        ArgumentException.ThrowIfNullOrWhiteSpace(occurredAtRole);

        CommentScalePlan snapshot = ReadGraphPlan(plan, graph, temporal);
        if (normalizedComment.ArticleId != graph.ArticleId
            || !Enum.IsDefined(normalizedComment.ModerationStatus))
        {
            throw new InvalidOperationException("comment_native_binding_plan_or_article_mismatch");
        }
        CommentScaleScenario scenario = FindScenario(snapshot, graph.Occurrence);
        var coordinate = new CommentScaleRequestCoordinate(graph.Occurrence, commentRole);
        if (scenario.Comments.Count(comment => comment.Role == commentRole) != 1
            || graph.Comments.Count(comment => comment is not null && comment.Coordinate == coordinate) != 1)
        {
            throw new InvalidOperationException("comment_native_binding_request_coordinate_mismatch");
        }
        CommentScalePolicyResolution policies = graph.Comments.Single(comment => comment is not null && comment.Coordinate == coordinate).Policies;
        if (policies is null || policies.AuthorMode is null || !policies.AuthorMode.Allowed
            || policies.ArticleWrite is null || !policies.ArticleWrite.Allowed || !policies.RegionCanPublish)
        {
            throw new InvalidOperationException("comment_native_binding_known_policy_refusal");
        }
        RequireNativeBindings(snapshot, graph, identities, expected);
        var role = new DataScaleNativeCommentRole(graph.Occurrence.ScenarioRole,
            graph.Occurrence.Repetition, graph.Occurrence.ArticleTargetRole,
            commentRole, DataScaleNativeCommentEntity.Comment, entityRole);
        long commentId = identities.Resolve(role);
        _ = temporal.RequireInstant(occurredAtRole);
        return new(coordinate, graph.ArticleId, commentId, normalizedComment, occurredAtRole);
    }

    private static CommentScalePlan ReadGraphPlan(
        CommentScalePlan plan,
        CommentScaleResolvedGraphIntent graph,
        ResolvedTemporalRoleContext temporal)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(graph);
        ArgumentNullException.ThrowIfNull(graph.Occurrence);
        ArgumentNullException.ThrowIfNull(graph.Comments);
        ArgumentNullException.ThrowIfNull(temporal);
        CommentScalePlan snapshot = CommentScalePlanContract.Parse(JsonSerializer.Serialize(plan));
        if (!CommentScalePlanContract.Inspect(snapshot, temporal).IsStructurallyValid
            || graph.CommentPlanDigest != snapshot.ContentDigest
            || graph.ArticlePlanDigest != snapshot.ArticlePlan.ContentDigest || graph.ArticleId <= 0)
        {
            throw new InvalidOperationException("comment_native_binding_plan_or_article_mismatch");
        }
        return snapshot;
    }

    private static CommentScaleScenario FindScenario(CommentScalePlan plan, CommentScaleGraphOccurrence occurrence)
    {
        CommentScaleScenario[] scenarios = plan.Scenarios.Where(scenario =>
            scenario.Role == occurrence.ScenarioRole && scenario.ArticleTargetRole == occurrence.ArticleTargetRole).ToArray();
        if (scenarios.Length != 1 || occurrence.Repetition < 0 || occurrence.Repetition >= scenarios[0].Repetitions)
        {
            throw new InvalidOperationException("comment_native_binding_request_coordinate_mismatch");
        }
        return scenarios[0];
    }

    private static void RequireExpectations(CommentScaleNativeBindingExpectation expected)
    {
        ArgumentNullException.ThrowIfNull(expected);
        ArgumentNullException.ThrowIfNull(expected.Allocation);
        ArgumentNullException.ThrowIfNull(expected.BindingReference);
        ArgumentNullException.ThrowIfNull(expected.FactoryRoles);
    }

    private static void RequireNativeBindings(
        CommentScalePlan snapshot,
        CommentScaleResolvedGraphIntent graph,
        DataScaleNativeCommentBindings identities,
        CommentScaleNativeBindingExpectation expected)
    {
        if (identities.RunId != expected.RunId || identities.Namespace != snapshot.Namespace
            || identities.RuntimeIdentity != expected.RuntimeIdentity || identities.Provider != expected.Provider
            || identities.CommentPlanDigest != snapshot.ContentDigest
            || identities.ArticlePlanDigest != snapshot.ArticlePlan.ContentDigest
            || identities.Allocation != expected.Allocation
            || expected.BindingReference.Schema != DataScaleNativeCommentBindings.Schema
            || expected.BindingReference.ContentDigest != identities.Digest
            || expected.FactoryRoles.Count != identities.Ids.Count)
        {
            throw new InvalidOperationException("comment_native_binding_scope_or_reference_mismatch");
        }
        // Only the original supplied roster is checked. An independently admitted
        // full factory roster is still required; equality is not its provenance proof.
        identities.RequireCoverage(Array.AsReadOnly(expected.FactoryRoles.ToArray()));
    }
}
