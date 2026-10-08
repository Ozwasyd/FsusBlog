using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>
/// Sole canonical comment factory. Its implemented input-resolution phase consumes
/// original-owner facts and pure policies; physical graph rows await shared original
/// production builders and native identities. No alternate row authority is supplied.
/// </summary>
public static class CanonicalCommentGraphFactory
{
    /// <summary>Bounds graph-intent count per batch, not physical rows, memory or throughput.</summary>
    public const int MaximumIntentsPerBatch = 256;

    /// <summary>
    /// Consumes observed revision facts through the production create/edit/delete
    /// constructor. Does not normalize content, derive history or allocate a row
    /// identity. Structural validation is not native or credential admission.
    /// </summary>
    public static CommentRevision ResolveRevision(
        CommentScaleRevisionFacts facts,
        ResolvedTemporalRoleContext temporal)
    {
        ArgumentNullException.ThrowIfNull(facts);
        ArgumentNullException.ThrowIfNull(temporal);
        ArgumentNullException.ThrowIfNull(facts.Coordinate);
        ArgumentNullException.ThrowIfNull(facts.Coordinate.Occurrence);
        if (string.IsNullOrWhiteSpace(facts.Coordinate.CommentRole)
            || string.IsNullOrWhiteSpace(facts.Coordinate.Occurrence.ScenarioRole)
            || string.IsNullOrWhiteSpace(facts.Coordinate.Occurrence.ArticleTargetRole)
            || facts.Coordinate.Occurrence.Repetition < 0
            || facts.ArticleId <= 0 || facts.AllocatedCommentId <= 0 || facts.Version <= 0
            || facts.Operation is not (CommentRevisionOperations.Created or CommentRevisionOperations.Edited or CommentRevisionOperations.Deleted)
            || facts.NormalizedContent is null || string.IsNullOrWhiteSpace(facts.CreatedAtRole)
            || string.IsNullOrWhiteSpace(facts.ActorMode))
        {
            throw new InvalidOperationException("comment_revision_structural_binding_invalid");
        }
        return CommentCommandService.BuildRevision(facts.AllocatedCommentId, facts.Version,
            facts.Operation, facts.NormalizedContent, temporal.RequireInstant(facts.CreatedAtRole).UtcDateTime,
            facts.ActorMode, facts.ActorAccountId, facts.ActorAdminPrincipalId);
    }

    /// <summary>
    /// Calls only the original production initial-event selector and envelope
    /// builder with supplied final comment facts, allocated ID and resolved time.
    /// Does not derive final moderation, actor, thread, recipient or privacy facts.
    /// Caller admission remains required; returned entity defaults include fresh
    /// event GUIDs, ambient NextAttemptAt and unpersisted IDs. Only OccurredAtUtc
    /// is role-bound; these are not pure deterministic graph rows or receipts.
    /// </summary>
    public static IReadOnlyList<CommentMutationOutboxEvent> ResolveInitialOutbox(
        CommentScaleInitialOutboxFacts facts,
        ResolvedTemporalRoleContext temporal)
    {
        ArgumentNullException.ThrowIfNull(facts);
        ArgumentNullException.ThrowIfNull(temporal);
        ArgumentNullException.ThrowIfNull(facts.Coordinate);
        ArgumentNullException.ThrowIfNull(facts.Coordinate.Occurrence);
        ArgumentNullException.ThrowIfNull(facts.NormalizedComment);
        if (string.IsNullOrWhiteSpace(facts.Coordinate.CommentRole)
            || string.IsNullOrWhiteSpace(facts.Coordinate.Occurrence.ScenarioRole)
            || string.IsNullOrWhiteSpace(facts.Coordinate.Occurrence.ArticleTargetRole)
            || facts.Coordinate.Occurrence.Repetition < 0
            || facts.ArticleId <= 0 || facts.NormalizedComment.ArticleId != facts.ArticleId
            || facts.AllocatedCommentId <= 0 || string.IsNullOrWhiteSpace(facts.OccurredAtRole)
            || !Enum.IsDefined(facts.NormalizedComment.ModerationStatus))
        {
            throw new InvalidOperationException("Initial outbox facts have invalid or crossed structural bindings.");
        }
        DateTime occurredAt = temporal.RequireInstant(facts.OccurredAtRole).UtcDateTime;
        Comment comment = facts.NormalizedComment;
        return Array.AsReadOnly(CommentCommandService.ResolveInitialOutboxEventTypes(
            comment.ModerationStatus, comment.ReplyToUserId).Select(eventType =>
                CommentCommandService.BuildOutboxEvent(eventType, comment,
                    facts.AllocatedCommentId, occurredAt, null, comment.ModerationStatus)).ToArray());
    }

    /// <summary>
    /// Resolves the exact scenario/repetition roster from the one closed plan.
    /// Facts must arrive in plan order, including zero-comment article occurrences.
    /// Missing, crossed or extra facts fail; a yielded prefix is not a complete graph.
    /// Caller admission must verify the original article map, credential/content facts
    /// and Node temporal artifact. Digest equality here is structural binding only.
    /// </summary>
    public static IEnumerable<CommentScaleResolvedGraphIntent> ResolveIntentStream(
        CommentScalePlan plan,
        ResolvedTemporalRoleContext temporal,
        IEnumerable<CommentScaleGraphFactBindings> facts)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(temporal);
        ArgumentNullException.ThrowIfNull(facts);
        // Freeze the bounded template through its existing closed parser before
        // consuming caller facts. Do not create another plan or private ID/time map.
        CommentScalePlan snapshot = CommentScalePlanContract.Parse(JsonSerializer.Serialize(plan));
        CommentScalePlanInspection inspection = CommentScalePlanContract.Inspect(snapshot, temporal);
        if (!inspection.IsStructurallyValid)
        {
            throw new InvalidOperationException("Comment graph input plan failed structural inspection: "
                + string.Join(",", inspection.Errors));
        }

        using IEnumerator<CommentScaleGraphFactBindings> input = facts.GetEnumerator();
        foreach (CommentScaleScenario scenario in snapshot.Scenarios)
        {
            var requirements = new CommentScaleGraphRequirements(
                Array.AsReadOnly(scenario.Graph.Relations.ToArray()),
                Array.AsReadOnly(scenario.Graph.Authorities.ToArray()));
            var mutations = Array.AsReadOnly(scenario.Mutations.Select(step => new CommentScaleResolvedMutationRequest(
                step, temporal.RequireInstant(step.OccurredAtRole).UtcDateTime)).ToArray());
            for (long repetition = 0; repetition < scenario.Repetitions; repetition++)
            {
                var occurrence = new CommentScaleGraphOccurrence(scenario.Role, repetition, scenario.ArticleTargetRole);
                if (!input.MoveNext())
                {
                    throw new InvalidOperationException("Comment graph occurrence facts are missing.");
                }
                CommentScaleGraphFactBindings binding = input.Current;
                if (binding is null || binding.Occurrence != occurrence
                    || binding.Namespace != snapshot.Namespace || binding.CommentPlanDigest != snapshot.ContentDigest
                    || binding.ArticlePlanDigest != snapshot.ArticlePlan.ContentDigest
                    || string.IsNullOrWhiteSpace(binding.ArticleSemanticRole) || binding.ArticleId <= 0
                    || binding.NativeArticleBinding is null
                    || binding.NativeArticleBinding.Schema != ArticleScaleGraphIdentityBindings.Schema
                    || !CommentScalePlanContract.IsDigest(binding.NativeArticleBinding.ContentDigest)
                    || binding.Comments is null || binding.Comments.Count != scenario.Comments.Count)
                {
                    throw new InvalidOperationException("Comment graph occurrence bindings do not match the original plan references.");
                }

                var resolved = new List<CommentScaleResolvedRequestIntent>(scenario.Comments.Count);
                for (int index = 0; index < scenario.Comments.Count; index++)
                {
                    CommentScaleCommentRequest request = scenario.Comments[index];
                    CommentScaleRequestFactBinding item = binding.Comments[index];
                    if (item is null || item.CommentRole != request.Role || item.ContentRole != request.ContentRole
                        || item.ContentArtifact != request.ContentArtifact || item.PolicyFacts is null
                        || item.PolicyFacts.ArticleId != binding.ArticleId)
                    {
                        throw new InvalidOperationException("Comment graph request facts are missing, reordered or crossed.");
                    }
                    CommentScalePolicyResolution policies = CommentScalePolicyResolver.Resolve(
                        request, item.PolicyFacts, snapshot.Temporal, temporal);
                    resolved.Add(new CommentScaleResolvedRequestIntent(
                        new(occurrence, request.Role),
                        request.ParentRole is null ? null : new(occurrence, request.ParentRole),
                        request.ReplyTargetRole is null ? null : new(occurrence, request.ReplyTargetRole),
                        request.ContentRole, request.ContentArtifact, policies,
                        Array.AsReadOnly(request.Moderation.Select(step => new CommentScaleResolvedModerationRequest(
                            step, temporal.RequireInstant(step.OccurredAtRole).UtcDateTime)).ToArray())));
                }
                yield return new(occurrence, snapshot.ContentDigest, binding.ArticlePlanDigest,
                    binding.ArticleSemanticRole, binding.ArticleId, binding.NativeArticleBinding,
                    requirements, resolved.AsReadOnly())
                {
                    Mutations = mutations
                };
            }
        }
        if (input.MoveNext())
        {
            throw new InvalidOperationException("Comment graph occurrence facts contain an unexpected extra occurrence.");
        }
    }

    /// <summary>Groups only resolved intents; it does not write or batch physical rows.</summary>
    public static IEnumerable<IReadOnlyList<CommentScaleResolvedGraphIntent>> ResolveIntentBatches(
        CommentScalePlan plan,
        ResolvedTemporalRoleContext temporal,
        IEnumerable<CommentScaleGraphFactBindings> facts,
        int batchSize)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(batchSize, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(batchSize, MaximumIntentsPerBatch);
        var batch = new List<CommentScaleResolvedGraphIntent>(batchSize);
        foreach (CommentScaleResolvedGraphIntent intent in ResolveIntentStream(plan, temporal, facts))
        {
            batch.Add(intent);
            if (batch.Count == batchSize)
            {
                yield return batch.AsReadOnly();
                batch = new List<CommentScaleResolvedGraphIntent>(batchSize);
            }
        }
        if (batch.Count > 0)
        {
            yield return batch.AsReadOnly();
        }
    }
}
