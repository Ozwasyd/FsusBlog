using NSubstitute;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Ordinary typed-port sequence controls, without DB, delivery or provider qualification.</summary>
public sealed class CommentFixtureTimelineSequenceAdapterTests
{
    private const string Digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task OrderedMutations_PreserveContinuityAndPendingDeliveryFacts()
    {
        var (port, plans, results) = Setup();
        var order = new List<string>();
        port.ExecuteMutationAsync(Arg.Any<CommentFixtureMutationPlan>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                int index = call.Arg<CommentFixtureMutationPlan>().ExpectedVersion - 1;
                order.Add($"mutation-{index}");
                return results[index];
            });
        port.ObserveDeliveryAsync(Arg.Any<CommentFixtureMutationResult>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                CommentFixtureMutationResult authority = call.Arg<CommentFixtureMutationResult>();
                order.Add($"delivery-{authority.Before.CurrentVersion - 1}");
                return Delivery(authority);
            });
        CommentFixtureTimelineSequenceObservation observation = await new CommentFixtureTimelineSequenceAdapter(port).ObserveAsync(plans);
        Assert.Equal(["mutation-0", "delivery-0", "mutation-1", "delivery-1"], order);
        Assert.Equal(2, observation.Steps.Count);
        Assert.Equal(3, observation.Steps[^1].Mutation.After.CurrentVersion);
        Assert.Equal(30, Assert.Single(observation.Steps[^1].Mutation.After.ModerationEvents).Id);
        Assert.Equal("pending", Assert.Single(observation.Steps[^1].Delivery.Outbox).Status);
        Assert.Equal(["cache"], Assert.Single(observation.Steps[^1].Delivery.Outbox).MissingConsumers);
        Assert.False(observation.QualificationEligible);
        Assert.Contains("public projection exact revision", observation.Gaps);
    }

    [Fact]
    public async Task ObservationFailure_RetainsSuccessfulCommandAndPrimaryFailureForOwnerCleanup()
    {
        var (port, plans, results) = Setup();
        port.ExecuteMutationAsync(Arg.Any<CommentFixtureMutationPlan>(), Arg.Any<CancellationToken>()).Returns(results[0]);
        var primary = new IOException("read port unavailable");
        port.ObserveDeliveryAsync(Arg.Any<CommentFixtureMutationResult>(), Arg.Any<CancellationToken>())
            .Returns(_ => Task.FromException<CommentFixtureDeliveryObservation>(primary));
        CommentFixtureTimelineSequenceException exception = await Assert.ThrowsAsync<CommentFixtureTimelineSequenceException>(
            () => new CommentFixtureTimelineSequenceAdapter(port).ObserveAsync(plans));
        Assert.Same(primary, exception.InnerException);
        Assert.Empty(exception.CompletedSteps);
        Assert.Equal(2, exception.PendingMutation!.After.CurrentVersion);
        Assert.Single(port.ReceivedCalls(), call => call.GetMethodInfo().Name == "ExecuteMutationAsync");
    }

    [Fact]
    public async Task CallerCancellationBeforeSequence_PerformsNoPortOperation()
    {
        var (port, plans, _) = Setup();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new CommentFixtureTimelineSequenceAdapter(port)
            .ObserveAsync(plans, cancellation.Token));
        Assert.Empty(port.ReceivedCalls());
    }

    private static (ICommentThreadFixturePort Port, CommentFixtureMutationPlan[] Plans, CommentFixtureMutationResult[] Results) Setup()
    {
        var binding = new CommentFixturePortBinding("run-1", "namespace", "fx-0123456789abcdef01234567", "comment-moderation",
            "comments-moderation", ["comment.threaded"], 42, Digest, [Digest, $"sha256:{new string('b', 64)}", $"sha256:{new string('c', 64)}"],
            Digest, Digest, Digest, Digest, Digest, Digest, Digest, Digest);
        var identity = new CommentThreadFixtureObservationIdentity(41, 11, "public", Digest, "comment.thread.root");
        var now = new DateTime(2026, 10, 8, 0, 0, 0, DateTimeKind.Utc);
        var plans = new CommentFixtureMutationPlan[2];
        var results = new CommentFixtureMutationResult[2];
        for (int index = 0; index < plans.Length; index++)
        {
            var command = new CommentFixtureEdit($"content-{index}");
            plans[index] = new(binding, "root", identity, index + 1, CommentModerationStatus.Approved, 30, now.AddSeconds(index),
                Digest, Digest, Digest, CommentThreadFixturePort.ComputeCommandDigest(command), command);
            results[index] = new(binding, "root", identity, plans[index].BusinessTimeUtc, Digest, Digest, Digest,
                plans[index].CommandDigest, State(index + 1), State(index + 2), null, null);
        }
        return (Substitute.For<ICommentThreadFixturePort>(), plans, results);
    }

    private static CommentFixtureMutationObservation State(int version)
        => new(version, CommentModerationStatus.Approved, false, Digest, [],
            [new(30, "create", null, CommentModerationStatus.Approved, "system", null, null, null,
                "ordinary-port-model", null, null, new DateTime(2026, 10, 8, 0, 0, 0, DateTimeKind.Utc))], [$"event-{version}"]);

    private static CommentFixtureDeliveryObservation Delivery(CommentFixtureMutationResult authority)
        => new(authority, Digest, new("hidden", null, null, [], null, [], false, false), new([], [], false),
            "article:42", "11", "article:42:root:41", "11",
            [new(authority.After.OutboxEventIds[0], "edited", "pending", 0, 0, null, authority.BusinessTimeUtc,
                null, ["cache"], ["cache"], [])], []);
}
