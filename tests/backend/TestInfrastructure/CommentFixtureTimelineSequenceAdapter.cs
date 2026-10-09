using System.Text.Json;

using FsusBlog.Server.Services.Fixtures;

namespace FsusBlog.Server.Tests.TestInfrastructure;

/// <summary>Retains exact formal-port facts; does not assert public revision, delivery completion or native qualification.</summary>
public sealed record CommentFixtureTimelineStep(
    CommentFixtureMutationResult Mutation,
    CommentFixtureDeliveryObservation Delivery);

/// <summary>Caller-owned ordered timeline observations, with unmet acceptance preserved.</summary>
public sealed record CommentFixtureTimelineSequenceObservation(IReadOnlyList<CommentFixtureTimelineStep> Steps)
{
    public bool QualificationEligible => false;

    public IReadOnlyList<string> Gaps =>
    [
        "public projection exact revision",
        "outbox exact comment revision",
        "native provider and bounded delivery qualification"
    ];
}

/// <summary>Preserves the primary failure and completed or pending command facts for the owning scheduler's cleanup.</summary>
public sealed class CommentFixtureTimelineSequenceException(
    Exception primaryException,
    IReadOnlyList<CommentFixtureTimelineStep> completedSteps,
    CommentFixtureMutationResult? pendingMutation)
    : Exception("Comment fixture timeline sequence did not complete; owning scheduler cleanup remains required.", primaryException)
{
    public IReadOnlyList<CommentFixtureTimelineStep> CompletedSteps { get; } = completedSteps;

    public CommentFixtureMutationResult? PendingMutation { get; } = pendingMutation;
}

/// <summary>Consumes an admitted sequence through the existing mutation and observation ports, once per command.</summary>
public sealed class CommentFixtureTimelineSequenceAdapter(ICommentThreadFixturePort port)
{
    public async Task<CommentFixtureTimelineSequenceObservation> ObserveAsync(
        IReadOnlyList<CommentFixtureMutationPlan> plans,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(plans);
        cancellationToken.ThrowIfCancellationRequested();
        if (plans.Count == 0)
        {
            throw new ArgumentException("An explicit nonempty admitted timeline is required.", nameof(plans));
        }
        // Capture caller data before the first await. Plans may carry command tokens and are never returned as evidence.
        CommentFixtureMutationPlan[] sequence = Snapshot(plans.ToArray());
        var completed = new List<CommentFixtureTimelineStep>();
        CommentFixtureMutationResult? pending = null;
        try
        {
            foreach (CommentFixtureMutationPlan plan in sequence)
            {
                cancellationToken.ThrowIfCancellationRequested();
                RequireExact(plan.Binding, sequence[0].Binding, "same runtime binding");
                RequireExact(plan.Identity, sequence[0].Identity, "same comment identity");
                RequireExact(plan.CommandDigest, CommentThreadFixturePort.ComputeCommandDigest(plan.Command), "command digest");
                if (completed.Count > 0)
                {
                    RequireBefore(plan, completed[^1].Mutation.After);
                }
                pending = Snapshot(await port.ExecuteMutationAsync(plan, cancellationToken).ConfigureAwait(false));
                RequireExact(pending.Binding, plan.Binding, "mutation binding");
                RequireExact(pending.Identity, plan.Identity, "mutation identity");
                RequireExact(pending.SemanticRole, plan.SemanticRole, "semantic role");
                RequireExact(pending.BusinessTimeUtc, plan.BusinessTimeUtc, "business time");
                RequireExact(pending.ActorReferenceDigest, plan.ActorReferenceDigest, "actor reference");
                RequireExact(pending.SecurityReferenceDigest, plan.SecurityReferenceDigest, "security reference");
                RequireExact(pending.PolicyDigest, plan.PolicyDigest, "policy");
                RequireExact(pending.CommandDigest, plan.CommandDigest, "command");
                RequireBefore(plan, pending.Before);
                RequireContinuous(pending.After);
                if (completed.Count > 0)
                {
                    RequireExact(pending.Before, completed[^1].Mutation.After, "timeline continuity");
                }
                cancellationToken.ThrowIfCancellationRequested();
                CommentFixtureDeliveryObservation delivery = Snapshot(
                    await port.ObserveDeliveryAsync(pending, cancellationToken).ConfigureAwait(false));
                RequireExact(delivery.Authority, pending, "delivery authority");
                completed.Add(new(pending, delivery));
                pending = null;
            }
        }
        catch (Exception exception) when (completed.Count > 0 || pending is not null)
        {
            throw new CommentFixtureTimelineSequenceException(exception, completed.ToArray(), pending);
        }
        return new(completed.ToArray());
    }

    private static void RequireBefore(CommentFixtureMutationPlan plan, CommentFixtureMutationObservation before)
    {
        RequireContinuous(before);
        RequireExact(before.CurrentVersion, plan.ExpectedVersion, "expected revision");
        RequireExact(before.ModerationStatus, plan.ExpectedStatus, "expected status");
        RequireExact(before.ModerationEvents.LastOrDefault()?.Id ?? 0, plan.ExpectedLastModerationEventId, "expected timeline head");
    }

    private static void RequireContinuous(CommentFixtureMutationObservation observation)
    {
        if (!CommentFixtureTimelineVerifier.IsContinuous(observation.ModerationEvents, observation.ModerationStatus))
        {
            throw new InvalidOperationException("Comment fixture timeline is not continuous against its observed current status.");
        }
    }

    private static void RequireExact<T>(T actual, T expected, string label)
    {
        if (JsonSerializer.Serialize(actual) != JsonSerializer.Serialize(expected))
        {
            throw new InvalidOperationException($"Comment fixture {label} differs from the exact supplied authority.");
        }
    }

    private static T Snapshot<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value))!;
}
