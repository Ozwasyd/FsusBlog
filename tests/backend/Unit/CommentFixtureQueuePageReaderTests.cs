using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Fixtures;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Synthetic production-port pages verify component logic only.</summary>
public sealed class CommentFixtureQueuePageReaderTests
{
    [Fact]
    public async Task ReadAllAsync_PreservesAllPagesItemsLeasesOrderAndOpaqueCursors()
    {
        using var cancellation = new CancellationTokenSource();
        CommentModerationItemResponse first = Item("30");
        CommentModerationItemResponse target = Item("10");
        CommentModerationQueueLeaseResponse firstLease = Lease("30");
        CommentModerationQueueLeaseResponse targetLease = Lease("10");
        CommentModerationQueueResponse[] pages =
        [
            new([first], 3, 2, 1, " opaque+/= ", [firstLease]),
            new([], 2, 2, 1, "next", null),
            new([target], 1, 4, 5, null, [targetLease])
        ];
        var calls = new List<string?>();
        IAuthoringModerationQueue queue = Queue(pages, calls, cancellation.Token);

        CommentModerationQueueResponse result = await CommentFixtureQueuePageReader.ReadAllAsync(
            queue, CommentModerationStatus.Pending, 7, maxPages: 3, maxItems: 2, maxLeases: 2,
            cancellationToken: cancellation.Token);

        Assert.Equal([null, " opaque+/= ", "next"], calls);
        Assert.Collection(result.Items, item => Assert.Same(first, item), item => Assert.Same(target, item));
        Assert.Collection(result.Leases!, lease => Assert.Same(firstLease, lease), lease => Assert.Same(targetLease, lease));
        Assert.Equal((1, 4, 5), (result.PendingCount, result.RejectedCount, result.HiddenCount));
        Assert.Null(result.NextCursor);
        await queue.Received(3).ListCommentModerationQueuePageAsync(
            CommentModerationStatus.Pending, 7, Arg.Any<string?>(), cancellation.Token);
        Assert.Equal(3, queue.ReceivedCalls().Count());
    }

    [Fact]
    public async Task ReadAllAsync_PreservesEmptyTerminalAndNullableLeaseSemantics()
    {
        foreach (IReadOnlyList<CommentModerationQueueLeaseResponse>? leases in
            new IReadOnlyList<CommentModerationQueueLeaseResponse>?[] { null, [] })
        {
            var calls = new List<string?>();
            IAuthoringModerationQueue queue = Queue([new([], 0, 2, 3, null, leases)], calls);

            CommentModerationQueueResponse result = await CommentFixtureQueuePageReader.ReadAllAsync(queue);

            Assert.Empty(result.Items);
            Assert.Null(result.NextCursor);
            Assert.Equal((0, 2, 3), (result.PendingCount, result.RejectedCount, result.HiddenCount));
            Assert.Equal(leases is null, result.Leases is null);
            if (result.Leases is not null)
            {
                Assert.Empty(result.Leases);
            }
            Assert.Single(calls);
        }
    }

    [Fact]
    public async Task ReadAllAsync_RefusesCancellationBeforeReadAndAfterAnyPage()
    {
        using var preCancelled = new CancellationTokenSource();
        preCancelled.Cancel();
        IAuthoringModerationQueue untouched = Substitute.For<IAuthoringModerationQueue>();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            CommentFixtureQueuePageReader.ReadAllAsync(untouched, cancellationToken: preCancelled.Token));
        Assert.Empty(untouched.ReceivedCalls());

        foreach (string? nextCursor in new string?[] { "next", null })
        {
            foreach (int precedingPages in new[] { 0, 1 })
            {
                using var cancellation = new CancellationTokenSource();
                IAuthoringModerationQueue queue = Substitute.For<IAuthoringModerationQueue>();
                int readCount = 0;
                queue.ListCommentModerationQueuePageAsync(null, 100, Arg.Any<string?>(), cancellation.Token).Returns(_ =>
                {
                    readCount++;
                    if (readCount > precedingPages)
                    {
                        cancellation.Cancel();
                    }
                    return Task.FromResult(new CommentModerationQueueResponse([], 1, 0, 0,
                        readCount > precedingPages ? nextCursor : "first-cursor"));
                });

                await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                    CommentFixtureQueuePageReader.ReadAllAsync(queue, cancellationToken: cancellation.Token));
                Assert.Equal(precedingPages + 1, queue.ReceivedCalls().Count());
            }
        }
    }

    [Fact]
    public async Task ReadAllAsync_RefusesRepeatedAndCyclicCursors()
    {
        foreach (string[] cursors in new[] { new[] { "a", "a" }, new[] { "a", "b", "a" } })
        {
            CommentModerationQueueResponse[] pages = cursors
                .Select(cursor => new CommentModerationQueueResponse([], 0, 0, 0, cursor)).ToArray();
            var calls = new List<string?>();
            IAuthoringModerationQueue queue = Queue(pages, calls);

            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                CommentFixtureQueuePageReader.ReadAllAsync(queue));

            Assert.Contains("repeated cursor", error.Message, StringComparison.Ordinal);
            Assert.Equal(cursors.Length, calls.Count);
        }
    }

    [Fact]
    public async Task ReadAllAsync_RefusesRepeatedOrMissingItemIdentities()
    {
        CommentModerationQueueResponse[][] scenarios =
        [
            [new([Item("1"), Item("1")], 0, 0, 0)],
            [new([Item("1")], 0, 0, 0, "next"), new([Item("1")], 0, 0, 0)],
            [new([Item(" ")], 0, 0, 0)]
        ];
        foreach (CommentModerationQueueResponse[] pages in scenarios)
        {
            var calls = new List<string?>();
            IAuthoringModerationQueue queue = Queue(pages, calls);

            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                CommentFixtureQueuePageReader.ReadAllAsync(queue));

            Assert.Contains("item identity", error.Message, StringComparison.Ordinal);
            Assert.Equal(pages.Length, calls.Count);
        }
    }

    [Fact]
    public async Task ReadAllAsync_RefusesExhaustedReadBudgetsAndInvalidLimits()
    {
        var pageCalls = new List<string?>();
        IAuthoringModerationQueue pages = Queue([new([], 0, 0, 0, "next")], pageCalls);
        InvalidOperationException pageError = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CommentFixtureQueuePageReader.ReadAllAsync(pages, maxPages: 1));
        Assert.Contains("page read budget", pageError.Message, StringComparison.Ordinal);
        Assert.Single(pageCalls);

        foreach (bool leaseBudget in new[] { false, true })
        {
            var calls = new List<string?>();
            CommentModerationQueueResponse[] responses = leaseBudget
                ? [new([], 0, 0, 0, "next", [Lease("1")]), new([], 0, 0, 0, null, [Lease("2")])]
                : [new([Item("1")], 0, 0, 0, "next"), new([Item("2")], 0, 0, 0)];
            IAuthoringModerationQueue queue = Queue(responses, calls);
            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                CommentFixtureQueuePageReader.ReadAllAsync(queue, maxItems: 1, maxLeases: 1));
            Assert.Contains("item or lease read budget", error.Message, StringComparison.Ordinal);
            Assert.Equal(2, calls.Count);
        }

        IAuthoringModerationQueue untouched = Substitute.For<IAuthoringModerationQueue>();
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => CommentFixtureQueuePageReader.ReadAllAsync(untouched, pageSize: 0));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => CommentFixtureQueuePageReader.ReadAllAsync(untouched, pageSize: 101));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => CommentFixtureQueuePageReader.ReadAllAsync(untouched, maxPages: 0));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => CommentFixtureQueuePageReader.ReadAllAsync(untouched, maxItems: 0));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => CommentFixtureQueuePageReader.ReadAllAsync(untouched, maxLeases: 0));
        Assert.Empty(untouched.ReceivedCalls());
    }

    private static IAuthoringModerationQueue Queue(
        IReadOnlyList<CommentModerationQueueResponse> pages,
        ICollection<string?> calls,
        CancellationToken cancellationToken = default)
    {
        IAuthoringModerationQueue queue = Substitute.For<IAuthoringModerationQueue>();
        int index = 0;
        queue.ListCommentModerationQueuePageAsync(
            Arg.Any<CommentModerationStatus?>(), Arg.Any<int>(), Arg.Any<string?>(), cancellationToken).Returns(call =>
        {
            calls.Add(call.ArgAt<string?>(2));
            Assert.True(index < pages.Count, "The reader requested a page beyond the supplied terminal/refusal boundary.");
            return Task.FromResult(pages[index++]);
        });
        return queue;
    }

    private static CommentModerationItemResponse Item(string id)
        => new(
            Id: id, ArticleId: 42, ArticleTitle: "article", AuthorDisplayName: "author", Content: $"content-{id}",
            CreateTime: new DateTime(2026, 10, 8, 0, 0, 0, DateTimeKind.Utc), Status: CommentModerationStatus.Pending,
            Reason: null, ModeratedByAdminPrincipalId: null, ModeratedAt: null, AutoModerated: false,
            ModerationActor: "pending", HitReasons: [], SubmitRegion: null, SubmitRegionConfidence: null,
            BlockedRegions: [], RegionPolicyVersion: null, RegionDecisionReason: null, RegionCanPublish: false,
            RegionRequiresManualReview: true, RegionHideUntilReviewed: true, ModelSignals: [], ModelLabel: null,
            ModelConfidence: null, ModelPrimaryReason: null, ModelProvider: null, ModelUnavailable: false,
            AuthorMode: null, AnonymousDisplayLanguage: null, ModerationSubjectHash: null, NullifierHash: null,
            NullifierStatusLabel: null, AnonymousScope: null, RateClass: null, RequiresModeration: null,
            AnonymousCredentialId: null, CanBlockAnonymousNullifier: false, CanRevokeAnonymousCredential: false);

    private static CommentModerationQueueLeaseResponse Lease(string id)
        => new(id, $"row-{id}", 1, 2, new DateTime(2026, 10, 8, 0, 0, 0, DateTimeKind.Utc),
            91, "active", null, null, null, $"note-{id}", null, 3, $"claim-{id}");
}
