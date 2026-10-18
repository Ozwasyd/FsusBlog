using System.Collections;

using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthorArticlePinPermissionInputBoundaryTests
{
    private static readonly AuthorArticlePinOwner s_owner = new(1, "primary-site");

    [Theory]
    [InlineData(-1)]
    [InlineData(1001)]
    [InlineData(int.MaxValue)]
    public async Task Resolve_RejectsCountBeforeIndexingOrEnumerating(int count)
    {
        var source = new HostileList(() => count, _ => throw new InvalidOperationException("index accessed"));

        await AssertInvalidAsync(source);

        Assert.Equal(1, source.CountReads);
        Assert.Equal(0, source.IndexReads);
        Assert.Equal(0, source.EnumeratorCalls);
    }

    [Theory]
    [InlineData(0, false)]
    [InlineData(1000, false)]
    [InlineData(0, true)]
    [InlineData(1000, true)]
    public async Task Resolve_UsesBoundedIndicesEvenWithThrowingOrUnendingEnumerable(int count, bool unending)
    {
        var source = new HostileList(() => count, index => index + 1, unending);
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        var authority = CreateAuthority(db);

        AuthorArticlePinPermissionSnapshot result = await authority.ResolveAsync(Request(source));

        Assert.Equal("article_pin_permission_context_denied", result.ReasonCode);
        Assert.Empty(db.ReceivedCalls());
        Assert.Equal(3, source.CountReads);
        Assert.Equal(2 * count, source.IndexReads);
        Assert.Equal(0, source.EnumeratorCalls);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(1)]
    public async Task Resolve_RejectsInvalidOrDuplicateCapturedIds(int secondId)
    {
        await AssertInvalidAsync(new HostileList(() => 2, index => index == 0 ? 1 : secondId));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(3)]
    [InlineData(int.MaxValue)]
    public async Task Resolve_RejectsCountChangeAfterCapture(int changedCount)
    {
        int countReads = 0;
        var source = new HostileList(() => ++countReads == 1 ? 2 : changedCount, index => index + 1);

        await AssertInvalidAsync(source);

        Assert.Equal(2, source.IndexReads);
        Assert.Equal(0, source.EnumeratorCalls);
    }

    [Fact]
    public async Task Resolve_RejectsCountChangeAfterIdentityRecheck()
    {
        int countReads = 0;
        var source = new HostileList(() => ++countReads < 3 ? 2 : 3, index => index + 1);

        await AssertInvalidAsync(source);

        Assert.Equal(4, source.IndexReads);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Resolve_RejectsSameCountIdentityReplacementOrReorder(bool reorder)
    {
        int reads = 0;
        var source = new HostileList(() => 2, index => ++reads <= 2 ? index + 1 : reorder ? 2 - index : index + 3,
            allowEnumeration: true);

        await AssertInvalidAsync(source);

        Assert.InRange(source.IndexReads, 3, 4);
        Assert.Equal(0, source.EnumeratorCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Resolve_RejectsListThatShrinksDuringIndexRead(bool arrayException)
    {
        var source = new HostileList(() => 2, index => index == 0 ? 1
            : throw (arrayException ? new IndexOutOfRangeException() : new ArgumentOutOfRangeException(nameof(index))));

        await AssertInvalidAsync(source);
    }

    [Theory]
    [InlineData("before")]
    [InlineData("count")]
    [InlineData("capture")]
    [InlineData("recheck")]
    [InlineData("final-count")]
    [InlineData("index-failure")]
    public async Task Resolve_ObservesCancellationThroughoutBoundedCapture(string phase)
    {
        using var cancellation = new CancellationTokenSource();
        int counts = 0;
        int indices = 0;
        var source = new HostileList(() =>
        {
            counts++;
            if (phase == "count" || (phase == "final-count" && counts == 3))
            {
                cancellation.Cancel();
            }
            return 2;
        }, index =>
        {
            indices++;
            if (phase == "capture" || phase == "index-failure" || (phase == "recheck" && indices == 3))
            {
                cancellation.Cancel();
            }
            if (phase == "index-failure")
            {
                throw new ArgumentOutOfRangeException(nameof(index));
            }
            return index + 1;
        });
        if (phase == "before")
        {
            cancellation.Cancel();
        }
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();

        OperationCanceledException error = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            CreateAuthority(db).ResolveAsync(Request(source), cancellation.Token));

        Assert.Equal(cancellation.Token, error.CancellationToken);
        Assert.Empty(db.ReceivedCalls());
        Assert.Equal(0, source.EnumeratorCalls);
        Assert.InRange(source.IndexReads, 0, 4);
        if (phase == "before")
        {
            Assert.Equal(0, source.CountReads);
        }
    }

    private static async Task AssertInvalidAsync(IReadOnlyList<int> source)
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        AuthorArticlePinPermissionSnapshot result = await CreateAuthority(db).ResolveAsync(Request(source));

        Assert.Equal(AuthorArticlePinPermissionSnapshotStatus.Unavailable, result.Status);
        Assert.Equal("article_pin_permission_request_invalid", result.ReasonCode);
        Assert.Empty(result.Decisions);
        Assert.Empty(db.ReceivedCalls());
    }

    private static AuthorArticlePinPermissionBatchRequest Request(IReadOnlyList<int> source)
        => new(s_owner, Guid.CreateVersion7(), source);

    private static SqlAuthorArticlePinPermissionAuthority CreateAuthority(ISqlSugarClient db)
        => new(db, new HttpContextAccessor(), new ConfigurationBuilder().Build(), TimeProvider.System);

    private sealed class HostileList(
        Func<int> count,
        Func<int, int> item,
        bool unending = false,
        bool allowEnumeration = false) : IReadOnlyList<int>
    {
        public int CountReads
        {
            get; private set;
        }
        public int IndexReads
        {
            get; private set;
        }
        public int EnumeratorCalls
        {
            get; private set;
        }
        public int Count
        {
            get
            {
                CountReads++;
                return count();
            }
        }
        public int this[int index]
        {
            get
            {
                IndexReads++;
                return item(index);
            }
        }

        public IEnumerator<int> GetEnumerator()
        {
            EnumeratorCalls++;
            if (allowEnumeration)
            {
                return EnumerateIndices().GetEnumerator();
            }
            if (!unending)
            {
                throw new InvalidOperationException("Enumeration is forbidden.");
            }
            return GuardedUnending().GetEnumerator();
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        private IEnumerable<int> EnumerateIndices()
        {
            int length = count();
            for (int index = 0; index < length; index++)
            {
                yield return this[index];
            }
        }

        private static IEnumerable<int> GuardedUnending()
        {
            // The sentinel fails an old enumerating implementation without hanging the testhost.
            for (int index = 0; ; index++)
            {
                if (index > AuthorArticlePinContract.MaxPinsPerOwner)
                {
                    throw new InvalidOperationException("Unending enumeration exceeded the input bound.");
                }
                yield return index + 1;
            }
        }
    }
}
