using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>
/// Supplied final comment facts and original native/time roles. No final actor,
/// moderation, thread, privacy, revision or identity is derived by this adapter.
/// </summary>
public sealed record CommentScaleInitialOutboxRequestFact(
    string CommentRole,
    string EntityRole,
    Comment NormalizedComment,
    string OccurredAtRole);

/// <summary>
/// One original factory occurrence's ordered final facts and original native map.
/// References and equality carry no allocation, credential or artifact admission.
/// </summary>
public sealed record CommentScaleInitialOutboxOccurrenceFacts(
    CommentScaleGraphOccurrence Occurrence,
    DataScaleNativeCommentBindings Identities,
    CommentScaleNativeBindingExpectation Expectations,
    IReadOnlyList<CommentScaleInitialOutboxRequestFact> Comments);

/// <summary>
/// One complete original initial-event group, or an empty zero-comment occurrence
/// marker with null Coordinate. Entities/defaults stay original and mutable; this
/// is unpersisted assembly, not a deterministic row plan or a graph/atomic receipt.
/// Its intent still carries unresolved revision/thread/mutation requirements.
/// </summary>
public sealed record CommentScaleInitialOutboxGraphGroup(
    CommentScaleResolvedGraphIntent Intent,
    CommentScaleRequestCoordinate? Coordinate,
    IReadOnlyList<CommentMutationOutboxEvent> Events);

/// <summary>
/// Composes the sole original intent factory, original native binding transport
/// and production-shared initial-event selector/builder. No second factory, writer,
/// event policy, deterministic GUID, revision or native allocation is introduced.
/// </summary>
public static class CommentScaleInitialOutboxGraphAdapter
{
    /// <summary>
    /// Streams exact original occurrence/comment order and detects extra/missing
    /// input only through full enumeration. A yielded prefix is not success or a
    /// complete graph. Zero-comment occurrences still validate supplied map scope.
    /// Original ef65043da Created/VisibilityChanged/conditional reply ordering is
    /// consumed through ResolveInitialOutbox, never reconstructed here.
    /// </summary>
    public static IEnumerable<CommentScaleInitialOutboxGraphGroup> ResolveStream(
        CommentScalePlan plan,
        ResolvedTemporalRoleContext temporal,
        IEnumerable<CommentScaleGraphFactBindings> graphFacts,
        IEnumerable<CommentScaleInitialOutboxOccurrenceFacts> outboxFacts)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(temporal);
        ArgumentNullException.ThrowIfNull(graphFacts);
        ArgumentNullException.ThrowIfNull(outboxFacts);
        CommentScalePlan snapshot = CommentScalePlanContract.Parse(JsonSerializer.Serialize(plan));
        using IEnumerator<CommentScaleInitialOutboxOccurrenceFacts> input = outboxFacts.GetEnumerator();
        foreach (CommentScaleResolvedGraphIntent intent in CanonicalCommentGraphFactory.ResolveIntentStream(snapshot, temporal, graphFacts))
        {
            if (!input.MoveNext())
            {
                throw new InvalidOperationException("comment_initial_outbox_occurrence_missing");
            }
            CommentScaleInitialOutboxOccurrenceFacts observed = input.Current;
            if (observed is null || observed.Occurrence != intent.Occurrence
                || observed.Comments is null || observed.Comments.Count != intent.Comments.Count)
            {
                throw new InvalidOperationException("comment_initial_outbox_occurrence_or_roster_mismatch");
            }
            ArgumentNullException.ThrowIfNull(observed.Identities);
            ArgumentNullException.ThrowIfNull(observed.Expectations);
            ArgumentNullException.ThrowIfNull(observed.Expectations.FactoryRoles);
            // Freeze supplied roster containers, not mutable original entities or
            // the authority of their facts. Allocation/map provenance is external.
            CommentScaleInitialOutboxRequestFact[] requests = observed.Comments.ToArray();
            if (requests.Length != intent.Comments.Count)
            {
                throw new InvalidOperationException("comment_initial_outbox_occurrence_or_roster_mismatch");
            }
            CommentScaleNativeBindingExpectation expected = observed.Expectations with
            {
                FactoryRoles = Array.AsReadOnly(observed.Expectations.FactoryRoles.ToArray())
            };
            CommentScaleNativeBindingAdapter.ValidateGraphBindings(snapshot, intent, temporal, observed.Identities, expected);
            for (int index = 0; index < requests.Length; index++)
            {
                if (requests[index] is null || requests[index].CommentRole != intent.Comments[index].Coordinate.CommentRole)
                {
                    throw new InvalidOperationException("comment_initial_outbox_comment_roster_mismatch");
                }
            }
            if (requests.Length == 0)
            {
                yield return new(intent, null, Array.AsReadOnly(Array.Empty<CommentMutationOutboxEvent>()));
            }
            foreach (CommentScaleInitialOutboxRequestFact request in requests)
            {
                CommentScaleInitialOutboxFacts bound = CommentScaleNativeBindingAdapter.BindInitialOutboxFacts(
                    snapshot, intent, request.CommentRole, request.EntityRole, request.NormalizedComment,
                    request.OccurredAtRole, temporal, observed.Identities, expected);
                yield return new(intent, bound.Coordinate, CanonicalCommentGraphFactory.ResolveInitialOutbox(bound, temporal));
            }
        }
        if (input.MoveNext())
        {
            throw new InvalidOperationException("comment_initial_outbox_occurrence_extra");
        }
    }

    /// <summary>
    /// Bounds retained group count and never splits a comment's original event
    /// group. This bounds groups only, not physical graph rows, bytes, CPU/RSS or
    /// transactions. Caller retention and full graph/native admission are separate.
    /// </summary>
    public static IEnumerable<IReadOnlyList<CommentScaleInitialOutboxGraphGroup>> ResolveBatches(
        CommentScalePlan plan,
        ResolvedTemporalRoleContext temporal,
        IEnumerable<CommentScaleGraphFactBindings> graphFacts,
        IEnumerable<CommentScaleInitialOutboxOccurrenceFacts> outboxFacts,
        int batchSize)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(batchSize, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(batchSize, CanonicalCommentGraphFactory.MaximumIntentsPerBatch);
        var batch = new List<CommentScaleInitialOutboxGraphGroup>(batchSize);
        foreach (CommentScaleInitialOutboxGraphGroup group in ResolveStream(plan, temporal, graphFacts, outboxFacts))
        {
            batch.Add(group);
            if (batch.Count == batchSize)
            {
                yield return batch.AsReadOnly();
                batch = new List<CommentScaleInitialOutboxGraphGroup>(batchSize);
            }
        }
        if (batch.Count > 0)
        {
            yield return batch.AsReadOnly();
        }
    }
}
