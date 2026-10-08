using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorArticleQueryHistoryIdentityReaderTests
{
    private static readonly AuthorRecentArticleHistoryOwner s_owner = new(7, "site-a");

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(100)]
    [InlineData(1000)]
    public async Task Identity_ConsumesOnlyCompleteOriginalVerifiedHistory(int count)
    {
        var source = new FakeHistory(count);
        var result = await new AuthorArticleQueryHistoryIdentityReader(source).ReadAsync(Request());
        Assert.Null(result.UnavailableReason);
        AuthorArticleQueryHistoryIdentity identity = Assert.IsType<AuthorArticleQueryHistoryIdentity>(result.Identity);
        Assert.Equal(s_owner, identity.Owner);
        Assert.Equal(count, identity.Ordinals.Count);
        Assert.Equal(Enumerable.Range(1, count), identity.Ordinals.Select(static ordinal => ordinal.Ordinal));
        Assert.Equal(Enumerable.Range(1, count).Reverse(), identity.Ordinals.Select(static ordinal => ordinal.ArticleId));
        Assert.Equal(count == 0 ? 1 : (count + 99) / 100, source.Requests.Count);
        foreach (var request in source.Requests.Skip(1))
        {
            Assert.Equal(11, request.ExpectedCollectionRevision);
            Assert.Equal(Hash("permission"), request.ExpectedPermissionRevision);
            Assert.Equal(Hash("site"), request.ExpectedSiteRevision);
            Assert.Equal(Hash("session"), request.ExpectedSessionRevision);
        }
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("revision")]
    [InlineData("permission")]
    [InlineData("site")]
    [InlineData("session")]
    [InlineData("digest")]
    [InlineData("reference")]
    public async Task Identity_CrossPageAuthorityChangesDiscardEveryOrdinal(string fault)
    {
        var result = await new AuthorArticleQueryHistoryIdentityReader(new FakeHistory(101) { Fault = fault })
            .ReadAsync(Request());
        Assert.Null(result.Identity);
        Assert.NotNull(result.UnavailableReason);
    }

    [Theory]
    [InlineData("entry")]
    [InlineData("duplicate")]
    [InlineData("order")]
    [InlineData("cycle")]
    [InlineData("empty-more")]
    [InlineData("unavailable")]
    public async Task Identity_InvalidOriginalProjectionCannotSupplyRankingFacts(string fault)
    {
        var result = await new AuthorArticleQueryHistoryIdentityReader(new FakeHistory(101) { Fault = fault })
            .ReadAsync(Request());
        Assert.Null(result.Identity);
        Assert.NotNull(result.UnavailableReason);
    }

    [Fact]
    public async Task Identity_CancellationStopsBeforeAnyHistoryRead()
    {
        var source = new FakeHistory(1);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new AuthorArticleQueryHistoryIdentityReader(source).ReadAsync(Request(), cancellation.Token));
        Assert.Empty(source.Requests);
    }

    private static AuthorArticleQueryRequest Request()
        => new(1, new(s_owner.AdminPrincipalId, s_owner.SiteScope), Guid.CreateVersion7(), 1, "article",
            [AuthorArticleQueryStatus.Draft], [AuthorArticleQueryBucket.Recent], "zh-CN",
            AuthorArticleQueryContract.Collation, 10, null);

    private static string Hash(string value) => AuthorRecentArticleHistoryContract.HashText(value);

    private sealed class FakeHistory : IAuthorRecentArticleHistoryProjectionService
    {
        private readonly AuthorRecentArticleHistoryEntry[] _entries;
        private readonly string _digest;
        public string? Fault
        {
            get; init;
        }
        public List<AuthorRecentArticleHistoryProjectionRequest> Requests { get; } = [];

        public FakeHistory(int count)
        {
            _entries = Enumerable.Range(1, count).Reverse().Select(id =>
            {
                var entry = new AuthorRecentArticleHistoryEntry(id, id * 10L,
                    new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMinutes(id), null, null,
                    "open", id, Hash($"entry:{id}"));
                return entry with
                {
                    ContentDigest = AuthorRecentArticleHistoryContract.ComputeEntryDigest(s_owner, entry)
                };
            }).ToArray();
            _digest = AuthorRecentArticleHistoryContract.ComputeProjectionDigest(s_owner, 11, _entries, Hash("decisions"));
        }

        public Task<AuthorRecentArticleHistoryProjectionPage> ReadAsync(
            AuthorRecentArticleHistoryProjectionRequest request, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Requests.Add(request);
            int start = (Requests.Count - 1) * 100;
            AuthorRecentArticleHistoryEntry[] entries = _entries.Skip(start).Take(100).ToArray();
            bool more = start + entries.Length < _entries.Length;
            var page = new AuthorRecentArticleHistoryProjectionPage(
                AuthorRecentArticleHistoryProjectionStatus.Current, s_owner, 1, 11, entries,
                more ? $"original-cursor-{Requests.Count}" : null, more,
                Hash("permission"), Hash("site"), Hash("session"), Hash("decisions"),
                "original-projection-reference", "original-cache-reference", _digest, null);
            if (Fault == "entry" && entries.Length > 0)
            {
                page = page with
                {
                    Entries = [entries[0] with { ContentDigest = Hash("tampered") }, .. entries.Skip(1)]
                };
            }
            if (Fault == "duplicate" && Requests.Count == 2)
            {
                page = page with
                {
                    Entries = [_entries[0]]
                };
            }
            if (Fault == "order")
            {
                page = page with
                {
                    Entries = entries.Reverse().ToArray()
                };
            }
            if (Fault == "empty-more")
            {
                page = page with
                {
                    Entries = [],
                    HasMore = true,
                    NextCursor = "original-cursor"
                };
            }
            if (Fault == "cycle")
            {
                page = page with
                {
                    HasMore = true,
                    NextCursor = "original-cursor"
                };
            }
            if (Fault == "unavailable")
            {
                page = page with
                {
                    Status = AuthorRecentArticleHistoryProjectionStatus.Unavailable
                };
            }
            if (Requests.Count == 2)
            {
                page = Fault switch
                {
                    "owner" => page with { Owner = new(7, "other-site") },
                    "revision" => page with { CollectionRevision = 12 },
                    "permission" => page with { PermissionRevision = Hash("changed") },
                    "site" => page with { SiteRevision = Hash("changed") },
                    "session" => page with { SessionRevision = Hash("changed") },
                    "digest" => page with { ContentDigest = Hash("changed") },
                    "reference" => page with { CacheReference = "other-reference" },
                    _ => page
                };
            }
            return Task.FromResult(page);
        }

        public Task<AuthorRecentArticleHistoryVerificationResult> VerifyAsync(
            AuthorRecentArticleHistoryOwner owner, CancellationToken cancellationToken = default)
            => throw new NotSupportedException("The canonical projection service performs its durable verification before ReadAsync returns.");
    }
}
