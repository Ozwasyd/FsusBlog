using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

public static partial class CanonicalCommentGraphFactory
{
    /// <summary>
    /// Assesses only explicitly selected automatic transitions through the actual
    /// sealed production policy. The original plan and input resolver remain the
    /// sole roster authority. Selections must follow request/step order and match
    /// the supplied observed previous state; no-op or different decisions fail.
    /// Caller must supply stable original configuration, content, actor, region,
    /// model and identity facts for the entire enumeration. Structural equality
    /// does not authenticate them. No moderation action, CAS, event or write occurs.
    /// </summary>
    public static IEnumerable<CommentScaleResolvedAutomaticModerationGraph> ResolveAutomaticModerationStream(
        CommentScalePlan plan,
        ResolvedTemporalRoleContext temporal,
        IEnumerable<CommentScaleGraphFactBindings> facts,
        IEnumerable<CommentScaleAutomaticModerationOccurrenceFacts> automaticFacts,
        CommentModerationDispositionPolicy productionPolicy)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(temporal);
        ArgumentNullException.ThrowIfNull(facts);
        ArgumentNullException.ThrowIfNull(automaticFacts);
        ArgumentNullException.ThrowIfNull(productionPolicy);
        CommentScaleGraphFactBindings? observedBinding = null;
        IEnumerable<CommentScaleGraphFactBindings> ObserveBindings()
        {
            foreach (CommentScaleGraphFactBindings binding in facts)
            {
                observedBinding = binding;
                yield return binding;
            }
        }
        using IEnumerator<CommentScaleAutomaticModerationOccurrenceFacts> input = automaticFacts.GetEnumerator();
        foreach (CommentScaleResolvedGraphIntent intent in ResolveIntentStream(plan, temporal, ObserveBindings()))
        {
            if (observedBinding is not { } binding || binding.Occurrence != intent.Occurrence)
            {
                throw new InvalidOperationException("comment_automatic_moderation_graph_binding_invalid");
            }
            if (!input.MoveNext() || input.Current is not { } frame
                || frame.Occurrence != intent.Occurrence || frame.Assessments is null)
            {
                throw new InvalidOperationException("comment_automatic_moderation_occurrence_binding_invalid");
            }
            // Bound the roster by this existing template's noninitial step count,
            // including custom collections that misreport Count or never terminate.
            int maximumSelections = intent.Comments.Sum(request => request.Moderation.Count - 1);
            int declaredCount = frame.Assessments.Count;
            if (declaredCount < 0 || declaredCount > maximumSelections)
            {
                throw new InvalidOperationException("comment_automatic_moderation_selection_count_invalid");
            }
            var selections = new List<CommentScaleAutomaticModerationFacts>(declaredCount);
            foreach (CommentScaleAutomaticModerationFacts selection in frame.Assessments)
            {
                if (selections.Count >= declaredCount)
                {
                    throw new InvalidOperationException("comment_automatic_moderation_selection_count_invalid");
                }
                selections.Add(selection);
            }
            if (selections.Count != declaredCount)
            {
                throw new InvalidOperationException("comment_automatic_moderation_selection_count_invalid");
            }
            var resolved = new List<CommentScaleResolvedAutomaticModeration>(selections.Count);
            var observedCommentIds = new HashSet<long>();
            int previousCommentIndex = -1;
            int previousStepIndex = -1;
            long previousCommentId = 0;
            foreach (CommentScaleAutomaticModerationFacts item in selections)
            {
                if (item is null || item.Coordinate is null || item.Coordinate.Occurrence != intent.Occurrence
                    || item.CurrentComment is null || item.Region is null || item.ModelResult is null)
                {
                    throw new InvalidOperationException("comment_automatic_moderation_input_invalid");
                }
                int commentIndex = -1;
                for (int index = 0; index < intent.Comments.Count; index++)
                {
                    if (intent.Comments[index].Coordinate == item.Coordinate)
                    {
                        commentIndex = index;
                        break;
                    }
                }
                if (commentIndex < 0 || commentIndex < previousCommentIndex
                    || (commentIndex == previousCommentIndex && item.ModerationStepIndex <= previousStepIndex))
                {
                    throw new InvalidOperationException("comment_automatic_moderation_selection_order_invalid");
                }
                CommentScaleResolvedRequestIntent request = intent.Comments[commentIndex];
                if (item.ModerationStepIndex <= 0 || item.ModerationStepIndex >= request.Moderation.Count
                    || item.ContentRole != request.ContentRole || item.ContentArtifact != request.ContentArtifact
                    || item.CurrentComment.Id <= 0 || item.CurrentComment.ArticleId != intent.ArticleId
                    || !Enum.IsDefined(item.CurrentComment.ModerationStatus)
                    || item.Region != binding.Comments[commentIndex].PolicyFacts.Region
                    || item.CurrentComment.AuthorMode != binding.Comments[commentIndex].PolicyFacts.Actor.AuthorMode
                    || item.CurrentComment.UserId != binding.Comments[commentIndex].PolicyFacts.Actor.UserId
                    || item.CurrentComment.AnonymousRequiresModeration != binding.Comments[commentIndex].PolicyFacts.Actor.RequiresModeration
                    || !request.Policies.AuthorMode.Allowed || request.Policies.ArticleWrite?.Allowed != true
                    || !request.Policies.RegionCanPublish
                    || (commentIndex == previousCommentIndex && item.CurrentComment.Id != previousCommentId)
                    || (commentIndex != previousCommentIndex && !observedCommentIds.Add(item.CurrentComment.Id)))
                {
                    throw new InvalidOperationException("comment_automatic_moderation_request_binding_invalid");
                }
                CommentScaleResolvedModerationRequest step = request.Moderation[item.ModerationStepIndex];
                if (step.Request.Previous is not { } previousStatus
                    || item.CurrentComment.ModerationStatus != previousStatus)
                {
                    throw new InvalidOperationException("comment_automatic_moderation_previous_state_invalid");
                }
                CommentModerationDisposition decision = productionPolicy.Decide(
                    item.CurrentComment, item.Region, item.ModelResult);
                if (!decision.AutoApplied || decision.NextStatus != step.Request.Next)
                {
                    throw new InvalidOperationException("comment_automatic_moderation_production_decision_mismatch");
                }
                resolved.Add(new(item.Coordinate, item.ModerationStepIndex, step, decision));
                previousCommentIndex = commentIndex;
                previousStepIndex = item.ModerationStepIndex;
                previousCommentId = item.CurrentComment.Id;
            }
            yield return new(intent, resolved.AsReadOnly());
        }
        if (input.MoveNext())
        {
            throw new InvalidOperationException("comment_automatic_moderation_extra_occurrence");
        }
    }

    /// <summary>Bounds occurrence groups only; does not batch events, physical rows or writes.</summary>
    public static IEnumerable<IReadOnlyList<CommentScaleResolvedAutomaticModerationGraph>> ResolveAutomaticModerationBatches(
        CommentScalePlan plan,
        ResolvedTemporalRoleContext temporal,
        IEnumerable<CommentScaleGraphFactBindings> facts,
        IEnumerable<CommentScaleAutomaticModerationOccurrenceFacts> automaticFacts,
        CommentModerationDispositionPolicy productionPolicy,
        int batchSize)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(batchSize, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(batchSize, MaximumIntentsPerBatch);
        var batch = new List<CommentScaleResolvedAutomaticModerationGraph>(batchSize);
        foreach (CommentScaleResolvedAutomaticModerationGraph graph in ResolveAutomaticModerationStream(
            plan, temporal, facts, automaticFacts, productionPolicy))
        {
            batch.Add(graph);
            if (batch.Count == batchSize)
            {
                yield return batch.AsReadOnly();
                batch = new List<CommentScaleResolvedAutomaticModerationGraph>(batchSize);
            }
        }
        if (batch.Count > 0)
        {
            yield return batch.AsReadOnly();
        }
    }
}
