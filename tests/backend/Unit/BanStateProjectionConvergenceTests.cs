using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Security;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BanStateProjectionConvergenceTests
{
    private const string Subject = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public void BanUnbanBan_OutOfOrderAndDuplicateDeliveryConvergesAcrossTwoNodes()
    {
        var nodeA = new BanStateProjection(new MissingSource());
        var nodeB = new BanStateProjection(new MissingSource());
        BanStateProjectionUpdate[] updates =
        [
            new(Subject, BanStateProjectionStatus.Banned, BanStateProjectionFacts.ManualReasonCode, 1),
            new(Subject, BanStateProjectionStatus.Normal, null, 2),
            new(Subject, BanStateProjectionStatus.Banned, BanStateProjectionFacts.ManualReasonCode, 3)
        ];

        foreach (BanStateProjectionUpdate update in updates)
        {
            Assert.Equal(BanStateProjectionApplyResult.Applied, nodeA.Apply(update));
        }

        Assert.Equal(BanStateProjectionApplyResult.Applied, nodeB.Apply(updates[2]));
        Assert.Equal(BanStateProjectionApplyResult.RejectedStale, nodeB.Apply(updates[0]));
        Assert.Equal(BanStateProjectionApplyResult.RejectedStale, nodeB.Apply(updates[1]));
        Assert.Equal(BanStateProjectionApplyResult.RejectedDuplicate, nodeB.Apply(updates[2]));

        Assert.Equal(nodeA.Read(Subject), nodeB.Read(Subject));
        Assert.Equal(BanStateProjectionStatus.Banned, nodeB.Read(Subject).Status);
        Assert.Equal(3, nodeB.Read(Subject).Generation);
    }

    [Fact]
    public async Task PreparedEvent_IsDurableBeforePublish_AndDegradedPublishRemainsTrackable()
    {
        var options = new DistributedInvalidationOptions
        {
            RuntimeMode = RuntimeModeKind.StaticRole,
            NodeId = "node-a",
            Topology = DistributedInvalidationTopologyManifest.Create("ban-events", ["node-a", "node-b"])
        };
        var runtimeScope = Substitute.For<IRuntimeKeyScope>();
        runtimeScope.ScopeToken.Returns("test-scope");
        var factory = new DistributedInvalidationEventFactory(options, runtimeScope, TimeProvider.System);
        var ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        ledger.PrepareOutboxAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<DistributedInvalidationTopologyManifest>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        var publisher = Substitute.For<IDistributedInvalidationPublisher>();
        publisher.PublishPreparedAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<CancellationToken>())
            .Returns(_ => Task.FromException<DistributedInvalidationPublishResult>(
                new IOException("transport_failed")));
        var projection = new BanStateProjection(new MissingSource());
        var runtime = new BanStateProjectionRuntimeState();
        var coordinator = new BanStateProjectionObligationCoordinator(
            factory,
            options,
            ledger,
            publisher,
            projection,
            runtime);
        BanStateProjectionUpdate update = new(
            Subject,
            BanStateProjectionStatus.Banned,
            BanStateProjectionFacts.ManualReasonCode,
            9);

        DistributedInvalidationEvent? prepared = await coordinator.PrepareAsync([update]);
        Assert.NotNull(prepared);
        await ledger.Received(1).PrepareOutboxAsync(
            prepared!,
            options.Topology!,
            Arg.Any<CancellationToken>());

        DistributedInvalidationPublishResult? result = await coordinator
            .ApplyLocalAndPublishPreparedAsync(prepared, [update]);

        Assert.Equal(DistributedInvalidationPublishStatus.Degraded, result?.Status);
        Assert.Equal(BanStateProjectionStatus.Banned, projection.Read(Subject).Status);
        Assert.Equal(1, runtime.Snapshot().DurableEventsPrepared);
        Assert.Equal(1, runtime.Snapshot().DurablePublishFailures);
    }

    [Fact]
    public void DurableTarget_RoundTripsBoundedReasonCodeAndCanReplayAfterRestart()
    {
        BanStateProjectionUpdate update = new(
            Subject,
            BanStateProjectionStatus.Banned,
            BanStateProjectionFacts.ManualReasonCode,
            17);
        string target = DistributedInvalidationTargetResolver.FormatBanStateProjectionTarget(update);
        Assert.True(DistributedInvalidationTargetResolver.TryParseBanStateProjectionTarget(
            target,
            out DistributedBanStateProjectionTarget parsed));
        Assert.Equal(update.AccountSubjectHash, parsed.AccountSubjectHash);
        Assert.Equal(update.Status, parsed.Status);
        Assert.Equal(update.ReasonCode, parsed.ReasonCode);
        Assert.Equal(update.Generation, parsed.Generation);

        var restartedNode = new BanStateProjection(new MissingSource());
        Assert.Equal(
            BanStateProjectionApplyResult.Applied,
            restartedNode.Apply(new BanStateProjectionUpdate(
                parsed.AccountSubjectHash,
                parsed.Status,
                parsed.ReasonCode,
                parsed.Generation)));
        Assert.Equal(update.Generation, restartedNode.Read(Subject).Generation);
    }

    private sealed class MissingSource : IBanStateProjectionSource
    {
        public ValueTask<BanStateProjectionUpdate?> LoadAsync(
            int accountId,
            string accountSubjectHash,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<BanStateProjectionUpdate?>(null);
    }
}
