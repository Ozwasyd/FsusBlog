using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Fixtures.DataScale;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Synthetic unit-only port models exercise batching and evidence preservation.
/// No command, graph rows, proof, native delivery or canonical receipt is produced.
/// </summary>
public sealed class CommentScaleDeliveryBatchReaderTests
{
    private const string SyntheticDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string OtherSyntheticDigest = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    private static readonly DateTime s_unitTime = new(2024, 3, 1, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task ReadAsync_PreservesAllStatusesInputOrderAndOriginalObservationObjects()
    {
        CommentFixturePortBinding binding = Binding();
        CommentFixtureMutationResult[] authorities = Enum.GetValues<CommentModerationStatus>()
            .Select((status, index) => Authority(binding, 104 - index, status)).ToArray();
        CommentFixtureDeliveryObservation[] original = authorities.Select(Observation).ToArray();
        ICommentThreadFixturePort port = Port(authority => original.Single(item => ReferenceEquals(item.Authority, authority)));

        List<CommentFixtureDeliveryObservation> result = await CollectAsync(
            new CommentScaleDeliveryBatchReader(port).ReadAsync(binding, authorities));

        Assert.Equal(authorities.Select(item => item.Identity.CommentId), result.Select(item => item.Authority.Identity.CommentId));
        Assert.Equal(Enum.GetValues<CommentModerationStatus>(), result.Select(item => item.Authority.After.ModerationStatus));
        for (int index = 0; index < original.Length; index++)
        {
            Assert.Same(original[index], result[index]);
        }
        AssertOnlyDeliveryReads(port, 4);
    }

    [Theory]
    [InlineData("RunId")]
    [InlineData("Namespace")]
    [InlineData("TestSession")]
    [InlineData("Owner")]
    [InlineData("ProfileId")]
    [InlineData("Capabilities")]
    [InlineData("ArticleId")]
    [InlineData("AuthProducerResultDigest")]
    [InlineData("AuthPrepareReferenceDigests")]
    [InlineData("PublicContentProducerResultDigest")]
    [InlineData("ArticleProjectionDigest")]
    [InlineData("InventoryDigest")]
    [InlineData("CapabilityCatalogDigest")]
    [InlineData("VariantCatalogDigest")]
    [InlineData("TemporalContextDigest")]
    [InlineData("ProducerPlanDigest")]
    [InlineData("PlanDigest")]
    public async Task ReadAsync_PreflightsEveryScopeFieldIncludingAnInvalidFinalItem(string field)
    {
        CommentFixturePortBinding binding = Binding();
        CommentFixtureMutationResult first = Authority(binding, 101);
        CommentFixtureMutationResult last = Authority(DriftBinding(binding, field), 102);
        ICommentThreadFixturePort port = Port(Observation);

        await Assert.ThrowsAsync<InvalidOperationException>(() => CollectAsync(
            new CommentScaleDeliveryBatchReader(port).ReadAsync(binding, [first, last])));

        AssertOnlyDeliveryReads(port, 0);
    }

    [Fact]
    public async Task ReadAsync_UsesStructuralScopeEqualityForCopiedProvenanceLists()
    {
        CommentFixturePortBinding binding = Binding();
        CommentFixturePortBinding copied = binding with
        {
            Capabilities = binding.Capabilities.ToArray(),
            AuthPrepareReferenceDigests = binding.AuthPrepareReferenceDigests.ToArray()
        };
        ICommentThreadFixturePort port = Port(Observation);

        Assert.Single(await CollectAsync(new CommentScaleDeliveryBatchReader(port).ReadAsync(binding, [Authority(copied, 101)])));
        AssertOnlyDeliveryReads(port, 1);
    }

    [Fact]
    public async Task ReadAsync_AcceptsSessionUsingTheProductionGrammar()
    {
        CommentFixturePortBinding binding = Binding() with
        {
            TestSession = "not-a-session"
        };
        Assert.True(HttpTestSessionKeyScope.IsValidSessionId(binding.TestSession));
        ICommentThreadFixturePort port = Port(Observation);

        Assert.Single(await CollectAsync(new CommentScaleDeliveryBatchReader(port).ReadAsync(binding, [Authority(binding, 101)])));

        AssertOnlyDeliveryReads(port, 1);
    }

    [Theory]
    [InlineData("role")]
    [InlineData("identity")]
    public async Task ReadAsync_RejectsDuplicateRolesOrIdentitiesBeforeAnyRead(string duplicate)
    {
        CommentFixturePortBinding binding = Binding();
        CommentFixtureMutationResult first = Authority(binding, 101);
        CommentFixtureMutationResult second = Authority(binding, 102);
        second = duplicate == "role"
            ? second with
            {
                SemanticRole = first.SemanticRole
            }
            : second with
            {
                Identity = first.Identity
            };
        ICommentThreadFixturePort port = Port(Observation);

        await Assert.ThrowsAsync<InvalidOperationException>(() => CollectAsync(
            new CommentScaleDeliveryBatchReader(port).ReadAsync(binding, [first, second])));

        AssertOnlyDeliveryReads(port, 0);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(256)]
    public async Task ReadAsync_AllowsTheEmptyAndExactMaximumBatch(int count)
    {
        CommentFixturePortBinding binding = Binding();
        CommentFixtureMutationResult[] authorities = Enumerable.Range(1, count)
            .Select(index => Authority(binding, index)).ToArray();
        ICommentThreadFixturePort port = Port(Observation);

        List<CommentFixtureDeliveryObservation> results = await CollectAsync(
            new CommentScaleDeliveryBatchReader(port).ReadAsync(binding, authorities));

        Assert.Equal(256, CommentScaleDeliveryBatchReader.MaximumAuthoritiesPerBatch);
        Assert.Equal(count, results.Count);
        AssertOnlyDeliveryReads(port, count);
    }

    [Fact]
    public async Task ReadAsync_RejectsOversizedBatchWithoutReadingAPrefix()
    {
        CommentFixturePortBinding binding = Binding();
        CommentFixtureMutationResult[] authorities = Enumerable.Range(1, 257)
            .Select(index => Authority(binding, index)).ToArray();
        ICommentThreadFixturePort port = Port(Observation);

        await Assert.ThrowsAsync<InvalidOperationException>(() => CollectAsync(
            new CommentScaleDeliveryBatchReader(port).ReadAsync(binding, authorities)));

        AssertOnlyDeliveryReads(port, 0);
    }

    [Theory]
    [InlineData("authority")]
    [InlineData("identity")]
    [InlineData("before")]
    [InlineData("after")]
    [InlineData("id")]
    [InlineData("role")]
    [InlineData("before-version")]
    [InlineData("after-version")]
    [InlineData("before-status")]
    [InlineData("after-status")]
    [InlineData("time")]
    [InlineData("operation-digest")]
    [InlineData("actor-digest")]
    [InlineData("security-digest")]
    [InlineData("policy-digest")]
    [InlineData("command-digest")]
    [InlineData("before-content-digest")]
    [InlineData("after-content-digest")]
    [InlineData("before-revisions")]
    [InlineData("after-revisions")]
    [InlineData("before-moderation-events")]
    [InlineData("after-moderation-events")]
    [InlineData("before-outbox-ids")]
    [InlineData("after-outbox-ids")]
    [InlineData("actor-mode")]
    [InlineData("public-account")]
    [InlineData("zk-account")]
    [InlineData("capability")]
    public async Task ReadAsync_RejectsMalformedFinalAuthorityWithoutAnyReads(string mutation)
    {
        CommentFixturePortBinding binding = Binding();
        CommentFixtureMutationResult final = Authority(binding, 102);
        final = mutation switch
        {
            "authority" => null!,
            "identity" => final with { Identity = null! },
            "before" => final with { Before = null! },
            "after" => final with { After = null! },
            "id" => final with { Identity = final.Identity with { CommentId = 0 } },
            "role" => final with { SemanticRole = "invalid role" },
            "before-version" => final with { Before = final.Before with { CurrentVersion = 0 } },
            "after-version" => final with { After = final.After with { CurrentVersion = 0 } },
            "before-status" => final with { Before = final.Before with { ModerationStatus = (CommentModerationStatus)999 } },
            "after-status" => final with { After = final.After with { ModerationStatus = (CommentModerationStatus)999 } },
            "time" => final with { BusinessTimeUtc = DateTime.SpecifyKind(s_unitTime, DateTimeKind.Unspecified) },
            "operation-digest" => final with { Identity = final.Identity with { OperationPlanDigest = "invalid" } },
            "actor-digest" => final with { ActorReferenceDigest = "invalid" },
            "security-digest" => final with { SecurityReferenceDigest = "invalid" },
            "policy-digest" => final with { PolicyDigest = "invalid" },
            "command-digest" => final with { CommandDigest = "invalid" },
            "before-content-digest" => final with { Before = final.Before with { ContentDigest = "invalid" } },
            "after-content-digest" => final with { After = final.After with { ContentDigest = "invalid" } },
            "before-revisions" => final with { Before = final.Before with { Revisions = null! } },
            "after-revisions" => final with { After = final.After with { Revisions = null! } },
            "before-moderation-events" => final with { Before = final.Before with { ModerationEvents = null! } },
            "after-moderation-events" => final with { After = final.After with { ModerationEvents = null! } },
            "before-outbox-ids" => final with { Before = final.Before with { OutboxEventIds = null! } },
            "after-outbox-ids" => final with { After = final.After with { OutboxEventIds = null! } },
            "actor-mode" => final with { Identity = final.Identity with { ActorMode = "legacy-anonymous" } },
            "public-account" => final with { Identity = final.Identity with { AccountId = 0 } },
            "zk-account" => final with { Identity = final.Identity with { ActorMode = CommentAuthorModes.ZkAnonymous } },
            "capability" => final with { Identity = final.Identity with { CapabilityId = " " } },
            _ => throw new InvalidOperationException(mutation)
        };
        ICommentThreadFixturePort port = Port(Observation);

        await Assert.ThrowsAsync<InvalidOperationException>(() => CollectAsync(
            new CommentScaleDeliveryBatchReader(port).ReadAsync(binding, [Authority(binding, 101), final])));

        AssertOnlyDeliveryReads(port, 0);
    }

    [Theory]
    [InlineData("session")]
    [InlineData("profile")]
    [InlineData("capabilities")]
    [InlineData("provenance-count")]
    [InlineData("digest")]
    [InlineData("null-capabilities")]
    [InlineData("null-provenance")]
    public async Task ReadAsync_RejectsInvalidBatchBindingBeforeAnyPortCall(string mutation)
    {
        CommentFixturePortBinding binding = Binding();
        binding = mutation switch
        {
            "session" => binding with { TestSession = "invalid/session" },
            "profile" => binding with { ProfileId = "" },
            "capabilities" => binding with { Capabilities = [] },
            "provenance-count" => binding with { AuthPrepareReferenceDigests = [] },
            "digest" => binding with { PlanDigest = "invalid" },
            "null-capabilities" => binding with { Capabilities = null! },
            "null-provenance" => binding with { AuthPrepareReferenceDigests = null! },
            _ => throw new InvalidOperationException(mutation)
        };
        if (mutation == "session")
        {
            Assert.False(HttpTestSessionKeyScope.IsValidSessionId(binding.TestSession));
        }
        ICommentThreadFixturePort port = Port(Observation);

        await Assert.ThrowsAsync<InvalidOperationException>(() => CollectAsync(
            new CommentScaleDeliveryBatchReader(port).ReadAsync(binding, [Authority(binding, 101)])));

        AssertOnlyDeliveryReads(port, 0);
    }

    [Fact]
    public async Task ReadAsync_RetainsSyntheticZkIdentityWithoutChangingItsAuthority()
    {
        CommentFixturePortBinding binding = Binding();
        CommentFixtureMutationResult authority = Authority(binding, 101);
        authority = authority with
        {
            Identity = authority.Identity with
            {
                ActorMode = CommentAuthorModes.ZkAnonymous,
                AccountId = null
            }
        };
        CommentFixtureDeliveryObservation original = Observation(authority);
        ICommentThreadFixturePort port = Port(_ => original);

        CommentFixtureDeliveryObservation result = Assert.Single(await CollectAsync(
            new CommentScaleDeliveryBatchReader(port).ReadAsync(binding, [authority])));

        // This synthetic identity supplies no proof or production credential validity.
        Assert.Same(original, result);
        Assert.Same(authority, result.Authority);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, result.Authority.Identity.ActorMode);
        Assert.Null(result.Authority.Identity.AccountId);
        AssertOnlyDeliveryReads(port, 1);
    }

    [Theory]
    [InlineData("revision")]
    [InlineData("content")]
    [InlineData("timeline")]
    [InlineData("outbox")]
    [InlineData("history")]
    [InlineData("binding")]
    public async Task ReadAsync_RejectsChangedReturnedAuthorityWithoutYieldingIt(string change)
    {
        CommentFixturePortBinding binding = Binding();
        CommentFixtureMutationResult authority = Authority(binding, 101);
        CommentFixtureMutationResult changed = change switch
        {
            "revision" => authority with { After = authority.After with { CurrentVersion = 2 } },
            "content" => authority with { After = authority.After with { ContentDigest = OtherSyntheticDigest } },
            "timeline" => authority with { After = authority.After with { ModerationEvents = [] } },
            "outbox" => authority with { After = authority.After with { OutboxEventIds = ["different-unit-event"] } },
            "history" => authority with { After = authority.After with { Revisions = [] } },
            "binding" => authority with { Binding = DriftBinding(binding, "PlanDigest") },
            _ => throw new InvalidOperationException(change)
        };
        ICommentThreadFixturePort port = Port(_ => Observation(changed));
        var yielded = new List<CommentFixtureDeliveryObservation>();

        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await foreach (CommentFixtureDeliveryObservation item in new CommentScaleDeliveryBatchReader(port)
                .ReadAsync(binding, [authority]))
            {
                yielded.Add(item);
            }
        });

        Assert.Empty(yielded);
        AssertOnlyDeliveryReads(port, 1);
    }

    [Fact]
    public async Task ReadAsync_RejectsNullPortObservationWithoutPromotingAVerdict()
    {
        CommentFixturePortBinding binding = Binding();
        ICommentThreadFixturePort port = Port(_ => null!);

        await Assert.ThrowsAsync<InvalidOperationException>(() => CollectAsync(
            new CommentScaleDeliveryBatchReader(port).ReadAsync(binding, [Authority(binding, 101)])));

        AssertOnlyDeliveryReads(port, 1);
    }

    [Fact]
    public async Task ReadAsync_PropagatesMidBatchPortFailureAndPreservesOnlyTheReadPrefix()
    {
        CommentFixturePortBinding binding = Binding();
        CommentFixtureMutationResult[] authorities = Enumerable.Range(101, 3).Select(id => Authority(binding, id)).ToArray();
        CommentFixtureDeliveryObservation first = Observation(authorities[0]);
        var failure = new InvalidOperationException("synthetic-unit-port-failure");
        ICommentThreadFixturePort port = Substitute.For<ICommentThreadFixturePort>();
        port.ObserveDeliveryAsync(Arg.Any<CommentFixtureMutationResult>(), Arg.Any<CancellationToken>())
            .Returns(call => call.Arg<CommentFixtureMutationResult>().Identity.CommentId == 101
                ? Task.FromResult(first) : Task.FromException<CommentFixtureDeliveryObservation>(failure));
        port.ClearReceivedCalls();
        var yielded = new List<CommentFixtureDeliveryObservation>();

        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await foreach (CommentFixtureDeliveryObservation item in new CommentScaleDeliveryBatchReader(port)
                .ReadAsync(binding, authorities))
            {
                yielded.Add(item);
            }
        });

        Assert.Same(failure, actual);
        Assert.Same(first, Assert.Single(yielded));
        AssertOnlyDeliveryReads(port, 2);
    }

    [Fact]
    public async Task ReadAsync_CancellationBeforeEnumerationPerformsZeroReads()
    {
        CommentFixturePortBinding binding = Binding();
        ICommentThreadFixturePort port = Port(Observation);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => CollectAsync(
            new CommentScaleDeliveryBatchReader(port).ReadAsync(binding, [Authority(binding, 101)], cancellation.Token)));

        AssertOnlyDeliveryReads(port, 0);
    }

    [Fact]
    public async Task ReadAsync_CancellationAfterAPortReadPreventsYieldingItsObservation()
    {
        CommentFixturePortBinding binding = Binding();
        using var cancellation = new CancellationTokenSource();
        ICommentThreadFixturePort port = Port(authority =>
        {
            cancellation.Cancel();
            return Observation(authority);
        });
        var yielded = new List<CommentFixtureDeliveryObservation>();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            await foreach (CommentFixtureDeliveryObservation item in new CommentScaleDeliveryBatchReader(port)
                .ReadAsync(binding, [Authority(binding, 101)], cancellation.Token))
            {
                yielded.Add(item);
            }
        });

        Assert.Empty(yielded);
        AssertOnlyDeliveryReads(port, 1);
    }

    [Fact]
    public async Task ReadAsync_CancellationAfterAPrefixStopsBeforeTheNextRead()
    {
        CommentFixturePortBinding binding = Binding();
        ICommentThreadFixturePort port = Port(Observation);
        using var cancellation = new CancellationTokenSource();
        await using IAsyncEnumerator<CommentFixtureDeliveryObservation> iterator = new CommentScaleDeliveryBatchReader(port)
            .ReadAsync(binding, [Authority(binding, 101), Authority(binding, 102)], cancellation.Token).GetAsyncEnumerator();

        Assert.True(await iterator.MoveNextAsync());
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            await iterator.MoveNextAsync();
        });

        AssertOnlyDeliveryReads(port, 1);
    }

    [Theory]
    [InlineData("pending")]
    [InlineData("missing")]
    [InlineData("failed")]
    [InlineData("poison")]
    [InlineData("duplicate")]
    public async Task ReadAsync_PreservesIncompleteOrConflictingDeliveryEvidenceByIdentity(string kind)
    {
        CommentFixturePortBinding binding = Binding();
        CommentFixtureMutationResult authority = Authority(binding, 101);
        var consumer = new CommentFixtureConsumerObservation("unit-consumer", kind, 3, 4, null, null, null, "unit-failure");
        var outbox = new CommentFixtureOutboxObservation("unit-event", CommentMutationEventTypes.Created,
            kind, 3, 4, null, s_unitTime, null, ["unit-consumer"],
            kind == "missing" ? ["unit-consumer"] : [],
            kind == "missing" ? [] : kind == "duplicate" ? [consumer, consumer] : [consumer]);
        var absent = new CommentFixtureReplyNoticeObservation("unit-event", 201, null, "", null, false, false, []);
        CommentFixtureDeliveryObservation original = Observation(authority) with
        {
            AdminQueueFirstPage = new([], [], true),
            CacheGeneration = null,
            RootCacheGeneration = null,
            Outbox = [outbox],
            ReplyNotices = [absent, absent]
        };
        ICommentThreadFixturePort port = Port(_ => original);

        CommentFixtureDeliveryObservation result = Assert.Single(await CollectAsync(
            new CommentScaleDeliveryBatchReader(port).ReadAsync(binding, [authority])));

        Assert.Same(original, result);
        Assert.Same(original.Outbox, result.Outbox);
        Assert.Same(outbox, Assert.Single(result.Outbox));
        Assert.Same(original.ReplyNotices, result.ReplyNotices);
        Assert.Same(absent, result.ReplyNotices[0]);
        Assert.Same(absent, result.ReplyNotices[1]);
        Assert.True(result.AdminQueueFirstPage.HasNextPage);
        Assert.Null(result.CacheGeneration);
        Assert.Null(result.RootCacheGeneration);
        AssertOnlyDeliveryReads(port, 1);
    }

    private static ICommentThreadFixturePort Port(Func<CommentFixtureMutationResult, CommentFixtureDeliveryObservation> observe)
    {
        ICommentThreadFixturePort port = Substitute.For<ICommentThreadFixturePort>();
        port.ObserveDeliveryAsync(Arg.Any<CommentFixtureMutationResult>(), Arg.Any<CancellationToken>())
            .Returns(call => Task.FromResult(observe(call.Arg<CommentFixtureMutationResult>())));
        port.ClearReceivedCalls();
        return port;
    }

    private static async Task<List<CommentFixtureDeliveryObservation>> CollectAsync(
        IAsyncEnumerable<CommentFixtureDeliveryObservation> observations)
    {
        var result = new List<CommentFixtureDeliveryObservation>();
        await foreach (CommentFixtureDeliveryObservation observation in observations)
        {
            result.Add(observation);
        }
        return result;
    }

    private static void AssertOnlyDeliveryReads(ICommentThreadFixturePort port, int count)
    {
        string[] calls = port.ReceivedCalls().Select(call => call.GetMethodInfo().Name).ToArray();
        Assert.Equal(count, calls.Length);
        Assert.All(calls, method => Assert.Equal(nameof(ICommentThreadFixturePort.ObserveDeliveryAsync), method));
    }

    private static CommentFixturePortBinding Binding()
        => new("synthetic-run", "synthetic-namespace", "fx-0123456789abcdef01234567", "synthetic-owner",
            "synthetic-profile", ["comment.threaded"], 42, SyntheticDigest,
            [SyntheticDigest, "sha256:" + new string('b', 64), "sha256:" + new string('c', 64)],
            SyntheticDigest, SyntheticDigest, SyntheticDigest, SyntheticDigest, SyntheticDigest,
            SyntheticDigest, SyntheticDigest, SyntheticDigest);

    private static CommentFixturePortBinding DriftBinding(CommentFixturePortBinding binding, string field)
        => field switch
        {
            "RunId" => binding with { RunId = "different-unit-run" },
            "Namespace" => binding with { Namespace = "different-unit-namespace" },
            "TestSession" => binding with { TestSession = "fx-1123456789abcdef01234567" },
            "Owner" => binding with { Owner = "different-unit-owner" },
            "ProfileId" => binding with { ProfileId = "different-unit-profile" },
            "Capabilities" => binding with { Capabilities = ["comment.moderation-matrix"] },
            "ArticleId" => binding with { ArticleId = 43 },
            "AuthProducerResultDigest" => binding with { AuthProducerResultDigest = OtherSyntheticDigest },
            "AuthPrepareReferenceDigests" => binding with { AuthPrepareReferenceDigests = [SyntheticDigest, "sha256:" + new string('b', 64), OtherSyntheticDigest] },
            "PublicContentProducerResultDigest" => binding with { PublicContentProducerResultDigest = OtherSyntheticDigest },
            "ArticleProjectionDigest" => binding with { ArticleProjectionDigest = OtherSyntheticDigest },
            "InventoryDigest" => binding with { InventoryDigest = OtherSyntheticDigest },
            "CapabilityCatalogDigest" => binding with { CapabilityCatalogDigest = OtherSyntheticDigest },
            "VariantCatalogDigest" => binding with { VariantCatalogDigest = OtherSyntheticDigest },
            "TemporalContextDigest" => binding with { TemporalContextDigest = OtherSyntheticDigest },
            "ProducerPlanDigest" => binding with { ProducerPlanDigest = OtherSyntheticDigest },
            "PlanDigest" => binding with { PlanDigest = OtherSyntheticDigest },
            _ => throw new InvalidOperationException(field)
        };

    private static CommentFixtureMutationResult Authority(
        CommentFixturePortBinding binding,
        long id,
        CommentModerationStatus status = CommentModerationStatus.Pending)
    {
        var revision = new CommentRevisionResult(1, "synthetic unit content", new string('a', 64),
            CommentRevisionOperations.Created, s_unitTime, CommentAuthorModes.Public);
        var timeline = new CommentFixtureModerationEventObservation(301, "synthetic-unit-event", null, status,
            "account", "unit-reason", null, null, "synthetic-unit-only", null, null, s_unitTime);
        var snapshot = new CommentFixtureMutationObservation(1, status, false, SyntheticDigest,
            [revision], [timeline], ["synthetic-unit-event"]);
        return new(binding, "unit-role-" + id,
            new(id, 7, CommentAuthorModes.Public, SyntheticDigest, "comment.thread.root"),
            s_unitTime, SyntheticDigest, SyntheticDigest, SyntheticDigest, SyntheticDigest,
            snapshot, snapshot, null, null);
    }

    private static CommentFixtureDeliveryObservation Observation(CommentFixtureMutationResult authority)
        => new(authority, SyntheticDigest,
            new("hidden", null, null, [], null, [], false, false),
            new([], [], false), "article:42", null, "article:42:root:101", null, [], []);
}
