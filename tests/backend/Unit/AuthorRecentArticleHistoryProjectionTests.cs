using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.DataProtection;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorRecentArticleHistoryProjectionTests
{
    private static readonly AuthorRecentArticleHistoryOwner s_owner = new(7, "site-a");

    [Fact]
    public async Task Projection_FiltersPermissionBeforeReturningStableServerFacts()
    {
        AuthorRecentArticleHistoryEntry visible = CreateEntry(2, 22, 2);
        AuthorRecentArticleHistoryEntry hidden = CreateEntry(1, 11, 1);
        var store = new FakeStore(CreateSnapshot([visible, hidden]));
        var permission = new FakePermission(
            [
                new(visible.ArticleId, true, true, Hash("decision-visible")),
                new(hidden.ArticleId, false, false, Hash("decision-hidden"))
            ]);
        var cache = new RecordingProjectionCache();
        var service = CreateService(store, permission, cache);

        AuthorRecentArticleHistoryProjectionPage page = await service.ReadAsync(
            new AuthorRecentArticleHistoryProjectionRequest(s_owner, Guid.CreateVersion7(), 10));

        AssertCanonicalEmptyPage(page, AuthorRecentArticleHistoryProjectionStatus.Unavailable,
            "author_recent_history_permission_unavailable");
        Assert.Equal(0, cache.PublicationCount);
    }

    [Fact]
    public async Task Projection_CursorIsBoundAndPermissionRevisionMismatchIsStale()
    {
        AuthorRecentArticleHistoryEntry first = CreateEntry(2, 22, 2);
        AuthorRecentArticleHistoryEntry second = CreateEntry(1, 11, 1);
        var permission = new FakePermission(
            [
                new(first.ArticleId, true, true, Hash("decision-first")),
                new(second.ArticleId, true, true, Hash("decision-second"))
            ]);
        var service = CreateService(
            new FakeStore(CreateSnapshot([first, second])),
            permission);
        AuthorRecentArticleHistoryProjectionPage firstPage = await service.ReadAsync(
            new AuthorRecentArticleHistoryProjectionRequest(s_owner, Guid.CreateVersion7(), 1));
        Assert.NotNull(firstPage.NextCursor);

        AuthorRecentArticleHistoryProjectionPage secondPage = await service.ReadAsync(
            new AuthorRecentArticleHistoryProjectionRequest(
                s_owner,
                Guid.CreateVersion7(),
                1,
                firstPage.NextCursor));
        Assert.Single(secondPage.Entries);
        Assert.Equal(second.ArticleId, secondPage.Entries[0].ArticleId);

        AuthorRecentArticleHistoryProjectionPage stale = await service.ReadAsync(
            new AuthorRecentArticleHistoryProjectionRequest(
                s_owner,
                Guid.CreateVersion7(),
                1,
                null,
                null,
                Hash("new-permission")));
        Assert.Equal(AuthorRecentArticleHistoryProjectionStatus.Stale, stale.Status);
        Assert.Empty(stale.Entries);
    }

    [Fact]
    public async Task Projection_CachePublicationFailureFailsClosed()
    {
        AuthorRecentArticleHistoryEntry visible = CreateEntry(2, 22, 2);
        var service = CreateService(
            new FakeStore(CreateSnapshot([visible])),
            new FakePermission(
                [new(visible.ArticleId, true, true, Hash("decision-visible"))]),
            new RejectingProjectionCache());

        AuthorRecentArticleHistoryProjectionPage page = await service.ReadAsync(
            new AuthorRecentArticleHistoryProjectionRequest(s_owner, Guid.CreateVersion7(), 10));

        Assert.Equal(AuthorRecentArticleHistoryProjectionStatus.Unavailable, page.Status);
        Assert.Empty(page.Entries);
        Assert.Equal("author_recent_history_projection_cache_unavailable", page.ReasonCode);
    }

    [Theory]
    [InlineData("revision")]
    [InlineData("item-count")]
    [InlineData("content-digest")]
    public async Task Projection_RejectsVerificationForADifferentAuthoritySnapshot(string dimension)
    {
        AuthorRecentArticleHistoryEntry visible = CreateEntry(2, 22, 2);
        AuthorRecentArticleHistoryCollectionSnapshot snapshot = CreateSnapshot([visible]);
        var verified = new AuthorRecentArticleHistoryVerificationResult(
            true,
            [],
            snapshot.Revision,
            snapshot.ItemCount,
            snapshot.ContentDigest);
        AuthorRecentArticleHistoryVerificationResult mismatched = dimension switch
        {
            "revision" => verified with { Revision = snapshot.Revision + 1 },
            "item-count" => verified with { ItemCount = snapshot.ItemCount + 1 },
            "content-digest" => verified with { ContentDigest = Hash("another-authority-snapshot") },
            _ => throw new ArgumentOutOfRangeException(nameof(dimension))
        };
        var cache = new RecordingProjectionCache();
        var service = CreateService(
            new FakeStore(snapshot, mismatched),
            new FakePermission([new(visible.ArticleId, true, true, Hash("decision-visible"))]),
            cache);

        AuthorRecentArticleHistoryProjectionPage page = await service.ReadAsync(
            new AuthorRecentArticleHistoryProjectionRequest(s_owner, Guid.CreateVersion7(), 10));

        Assert.Equal(AuthorRecentArticleHistoryProjectionStatus.Unavailable, page.Status);
        Assert.Empty(page.Entries);
        Assert.Null(page.NextCursor);
        Assert.Equal("author_recent_history_durable_projection_invalid", page.ReasonCode);
        Assert.Equal(0, cache.PublicationCount);
        AssertEmptyVerification(
            await service.VerifyAsync(s_owner),
            "author_recent_history_authority_verification_mismatch");
    }

    [Theory]
    [InlineData(AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable, "current")]
    [InlineData(AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable, "mismatch")]
    [InlineData(AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable, "invalid")]
    [InlineData(AuthorRecentArticleHistoryPermissionSnapshotStatus.Stale, "current")]
    [InlineData(AuthorRecentArticleHistoryPermissionSnapshotStatus.Stale, "mismatch")]
    [InlineData(AuthorRecentArticleHistoryPermissionSnapshotStatus.Stale, "invalid")]
    public async Task Verifier_DeniedOrStalePermissionHidesAllAuthorityFacts(
        AuthorRecentArticleHistoryPermissionSnapshotStatus status,
        string authorityState)
    {
        AuthorRecentArticleHistoryEntry entry = CreateEntry(2, 22, 2);
        AuthorRecentArticleHistoryCollectionSnapshot snapshot = CreateSnapshot([entry]);
        var verified = new AuthorRecentArticleHistoryVerificationResult(
            true, [], snapshot.Revision, snapshot.ItemCount, snapshot.ContentDigest);
        AuthorRecentArticleHistoryVerificationResult authority = authorityState switch
        {
            "current" => verified,
            "mismatch" => verified with { Revision = snapshot.Revision + 1 },
            "invalid" => verified with { Valid = false, Reasons = [$"receipt_digest_mismatch:{Guid.CreateVersion7():D}"] },
            _ => throw new ArgumentOutOfRangeException(nameof(authorityState))
        };
        var store = new FakeStore(snapshot, authority);
        var permission = new FakePermission(
            [new(entry.ArticleId, true, true, Hash("decision"))], status);

        AssertEmptyVerification(
            await CreateService(store, permission).VerifyAsync(s_owner),
            "author_recent_history_permission_verification_failed");
        Assert.Equal(1, permission.ResolveCount);
        Assert.Equal(0, store.VerificationCount);
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("content-digest")]
    [InlineData("decisions")]
    public async Task Verifier_InvalidCurrentPermissionHidesAllAuthorityFacts(string dimension)
    {
        AuthorRecentArticleHistoryEntry entry = CreateEntry(2, 22, 2);
        var store = new FakeStore(CreateSnapshot([entry]));
        var permission = new FakePermission(
            [new(entry.ArticleId, true, true, Hash("decision"))],
            transform: snapshot => dimension switch
            {
                "owner" => snapshot with { Owner = new(8, "site-a") },
                "content-digest" => snapshot with { ContentDigest = Hash("invalid-permission") },
                "decisions" => snapshot with
                {
                    Decisions = [],
                    ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(
                        snapshot with { Decisions = [], ContentDigest = string.Empty })
                },
                _ => throw new ArgumentOutOfRangeException(nameof(dimension))
            });

        AssertEmptyVerification(
            await CreateService(store, permission).VerifyAsync(s_owner),
            "author_recent_history_permission_verification_failed");
        Assert.Equal(1, permission.ResolveCount);
        Assert.Equal(0, store.VerificationCount);
    }

    [Fact]
    public async Task Verifier_InvalidAuthorityHidesFactsAndRequestSpecificReasons()
    {
        AuthorRecentArticleHistoryEntry entry = CreateEntry(2, 22, 2);
        AuthorRecentArticleHistoryCollectionSnapshot snapshot = CreateSnapshot([entry]);
        var store = new FakeStore(snapshot, new(
            false, [$"receipt_digest_mismatch:{Guid.CreateVersion7():D}"],
            snapshot.Revision, snapshot.ItemCount, snapshot.ContentDigest));
        var permission = new FakePermission([new(entry.ArticleId, true, true, Hash("decision"))]);

        AssertEmptyVerification(
            await CreateService(store, permission).VerifyAsync(s_owner),
            "author_recent_history_authority_verification_mismatch");
        Assert.Equal(1, permission.ResolveCount);
        Assert.Equal(1, store.VerificationCount);
    }

    [Fact]
    public async Task Verifier_CurrentPermissionPreservesAuthorizedReceiptFacts()
    {
        AuthorRecentArticleHistoryCollectionSnapshot snapshot = CreateSnapshot(
            [CreateEntry(2, 22, 2), CreateEntry(1, 11, 1)]);
        var store = new FakeStore(snapshot);
        var permission = new FakePermission(
            [new(2, true, true, Hash("first")), new(1, true, true, Hash("second"))]);

        AuthorRecentArticleHistoryVerificationResult result =
            await CreateService(store, permission).VerifyAsync(s_owner);

        Assert.True(result.Valid);
        Assert.Empty(result.Reasons);
        Assert.Equal(snapshot.Revision, result.Revision);
        Assert.Equal(snapshot.ItemCount, result.ItemCount);
        Assert.Equal(2, result.VisibleItemCount);
        AuthorRecentArticleHistoryPermissionSnapshot resolved = Assert.IsType<AuthorRecentArticleHistoryPermissionSnapshot>(
            permission.LastSnapshot);
        Assert.Equal(AuthorRecentArticleHistoryContract.ComputeProjectionDigest(
            s_owner, snapshot.Revision, snapshot.Entries, resolved),
            result.ContentDigest);
        Assert.Equal(snapshot.ContentDigest, result.AuthorityContentDigest);
        Assert.Equal(resolved.ContentDigest, result.PermissionContentDigest);
        Assert.Equal(1, permission.ResolveCount);
        Assert.Equal(1, store.VerificationCount);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Verifier_PartialOrAllDeniedArticlesHideCollectionFacts(bool firstVisible)
    {
        var store = new FakeStore(CreateSnapshot([CreateEntry(2, 22, 2), CreateEntry(1, 11, 1)]));
        var permission = new FakePermission(
            [new(2, firstVisible, firstVisible, Hash("first")), new(1, false, false, Hash("second"))]);

        AssertEmptyVerification(
            await CreateService(store, permission).VerifyAsync(s_owner),
            "author_recent_history_permission_verification_failed");
        Assert.Equal(1, permission.ResolveCount);
        Assert.Equal(0, store.VerificationCount);
    }

    [Fact]
    public async Task Verifier_EmptyCurrentCollectionRemainsValid()
    {
        AuthorRecentArticleHistoryCollectionSnapshot snapshot = CreateSnapshot([]);
        var store = new FakeStore(snapshot);
        var permission = new FakePermission([]);

        AuthorRecentArticleHistoryVerificationResult result =
            await CreateService(store, permission).VerifyAsync(s_owner);

        Assert.True(result.Valid);
        Assert.Empty(result.Reasons);
        Assert.Equal(0, result.Revision);
        Assert.Equal(0, result.ItemCount);
        Assert.Equal(0, result.VisibleItemCount);
        Assert.Equal(snapshot.ContentDigest, result.AuthorityContentDigest);
        AuthorRecentArticleHistoryPermissionSnapshot resolved =
            Assert.IsType<AuthorRecentArticleHistoryPermissionSnapshot>(permission.LastSnapshot);
        Assert.Equal(resolved.ContentDigest, result.PermissionContentDigest);
        Assert.Equal(AuthorRecentArticleHistoryContract.ComputeProjectionDigest(
            s_owner, 0, [], resolved), result.ContentDigest);
        Assert.Equal(1, store.VerificationCount);
    }

    [Theory]
    [InlineData("stale-permission")]
    [InlineData("stale-invalid-permission")]
    [InlineData("invalid-permission")]
    [InlineData("partial-collection-stale")]
    [InlineData("partial-permission-stale")]
    [InlineData("partial-site-stale")]
    [InlineData("partial-session-stale")]
    [InlineData("partial-invalid-cursor")]
    [InlineData("partial-cursor-stale")]
    public async Task Projection_UnprovenOrPartialPermissionTerminalHidesCollectionFacts(string scenario)
    {
        AuthorRecentArticleHistoryCollectionSnapshot snapshot = CreateSnapshot(
            [CreateEntry(2, 22, 2), CreateEntry(1, 11, 1)]);
        bool stale = scenario.StartsWith("stale-", StringComparison.Ordinal);
        bool invalid = scenario.Contains("invalid-permission", StringComparison.Ordinal);
        bool partial = scenario.StartsWith("partial-", StringComparison.Ordinal);
        var permission = new FakePermission(
            [new(2, true, true, Hash("first")), new(1, !partial, !partial, Hash("second"))],
            stale ? AuthorRecentArticleHistoryPermissionSnapshotStatus.Stale : AuthorRecentArticleHistoryPermissionSnapshotStatus.Current,
            invalid ? value => value with { ContentDigest = Hash("invalid-permission") } : null);
        var codec = new AuthorRecentArticleHistoryCursorCodec(new EphemeralDataProtectionProvider());
        var cache = new RecordingProjectionCache();
        var service = new AuthorRecentArticleHistoryProjectionService(new FakeStore(snapshot), permission, codec, cache);
        var request = new AuthorRecentArticleHistoryProjectionRequest(s_owner, Guid.CreateVersion7(), 10);
        request = scenario switch
        {
            "partial-collection-stale" => request with { ExpectedCollectionRevision = snapshot.Revision + 1 },
            "partial-permission-stale" => request with { ExpectedPermissionRevision = Hash("changed") },
            "partial-site-stale" => request with { ExpectedSiteRevision = Hash("changed") },
            "partial-session-stale" => request with { ExpectedSessionRevision = Hash("changed") },
            "partial-invalid-cursor" => request with { Cursor = "not-a-protected-cursor" },
            "partial-cursor-stale" => request with
            {
                Cursor = codec.Encode(new(
                    s_owner, snapshot.Revision + 1, snapshot.ContentDigest, Hash("permission-digest"),
                    Hash("site"), Hash("session"), RecentArticleHistoryOrdering.LatestFactAtUtc(snapshot.Entries[0]), 2))
            },
            _ => request
        };

        AuthorRecentArticleHistoryProjectionPage page = await service.ReadAsync(request);

        AuthorRecentArticleHistoryProjectionStatus expectedStatus = scenario switch
        {
            "invalid-permission" => AuthorRecentArticleHistoryProjectionStatus.Unavailable,
            "partial-invalid-cursor" => AuthorRecentArticleHistoryProjectionStatus.InvalidCursor,
            _ => AuthorRecentArticleHistoryProjectionStatus.Stale
        };
        string expectedReason = scenario switch
        {
            "invalid-permission" => "author_recent_history_permission_invalid",
            "partial-collection-stale" => "author_recent_history_collection_stale",
            "partial-site-stale" => "author_recent_history_site_stale",
            "partial-session-stale" => "author_recent_history_session_stale",
            "partial-invalid-cursor" => "author_recent_history_cursor_invalid",
            "partial-cursor-stale" => "author_recent_history_cursor_stale",
            _ => "author_recent_history_permission_stale"
        };
        if (partial)
        {
            expectedStatus = AuthorRecentArticleHistoryProjectionStatus.Unavailable;
            expectedReason = "author_recent_history_permission_unavailable";
        }
        AssertCanonicalEmptyPage(page, expectedStatus, expectedReason);
        Assert.Equal(0, cache.PublicationCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Projection_AllVisibleCurrentTerminalPreservesAuthorizedMetadata(bool invalidCursor)
    {
        AuthorRecentArticleHistoryCollectionSnapshot snapshot = CreateSnapshot([CreateEntry(2, 22, 2)]);
        var permission = new FakePermission([new(2, true, true, Hash("decision"))]);
        var cache = new RecordingProjectionCache();
        var request = new AuthorRecentArticleHistoryProjectionRequest(
            s_owner, Guid.CreateVersion7(), 10,
            invalidCursor ? "not-a-protected-cursor" : null,
            invalidCursor ? null : snapshot.Revision + 1);

        AuthorRecentArticleHistoryProjectionPage page =
            await CreateService(new FakeStore(snapshot), permission, cache).ReadAsync(request);

        Assert.Equal(invalidCursor ? AuthorRecentArticleHistoryProjectionStatus.InvalidCursor
            : AuthorRecentArticleHistoryProjectionStatus.Stale, page.Status);
        Assert.Equal(invalidCursor ? "author_recent_history_cursor_invalid"
            : "author_recent_history_collection_stale", page.ReasonCode);
        Assert.Equal(snapshot.Revision, page.CollectionRevision);
        Assert.Equal(snapshot.ContentDigest, page.ContentDigest);
        Assert.Equal($"author-recent-history:{s_owner.AdminPrincipalId}:{s_owner.SiteScope}:r{snapshot.Revision}",
            page.ProjectionReference);
        AuthorRecentArticleHistoryPermissionSnapshot resolved =
            Assert.IsType<AuthorRecentArticleHistoryPermissionSnapshot>(permission.LastSnapshot);
        Assert.Equal(resolved.PermissionRevision, page.PermissionRevision);
        Assert.Equal(resolved.SiteRevision, page.SiteRevision);
        Assert.Equal(resolved.SessionRevision, page.SessionRevision);
        Assert.Equal(resolved.ContentDigest, page.PermissionContentDigest);
        Assert.Empty(page.Entries);
        Assert.Null(page.NextCursor);
        Assert.False(page.HasMore);
        Assert.Empty(page.CacheReference);
        Assert.Equal(0, cache.PublicationCount);
    }

    private static void AssertCanonicalEmptyPage(
        AuthorRecentArticleHistoryProjectionPage page,
        AuthorRecentArticleHistoryProjectionStatus status,
        string reason)
    {
        AuthorRecentArticleHistoryProjectionPage empty = AuthorRecentArticleHistoryProjectionPage.Empty(s_owner, status, reason);
        Assert.Equal(empty.Owner, page.Owner);
        Assert.Equal(empty.SchemaVersion, page.SchemaVersion);
        Assert.Equal(empty.Status, page.Status);
        Assert.Equal(empty.ReasonCode, page.ReasonCode);
        Assert.Equal(0, page.CollectionRevision);
        Assert.Empty(page.Entries);
        Assert.Null(page.NextCursor);
        Assert.False(page.HasMore);
        Assert.Empty(page.PermissionRevision);
        Assert.Empty(page.SiteRevision);
        Assert.Empty(page.SessionRevision);
        Assert.Empty(page.PermissionContentDigest);
        Assert.Empty(page.ProjectionReference);
        Assert.Empty(page.CacheReference);
        Assert.Equal(empty.ContentDigest, page.ContentDigest);
    }

    private static void AssertEmptyVerification(
        AuthorRecentArticleHistoryVerificationResult result,
        string reason)
    {
        Assert.False(result.Valid);
        Assert.Equal(reason, Assert.Single(result.Reasons));
        Assert.Equal(0, result.Revision);
        Assert.Equal(0, result.ItemCount);
        Assert.Equal(0, result.VisibleItemCount);
        Assert.Empty(result.ContentDigest);
        Assert.Empty(result.AuthorityContentDigest);
        Assert.Empty(result.PermissionContentDigest);
    }

    private static AuthorRecentArticleHistoryCollectionSnapshot CreateSnapshot(
        IReadOnlyList<AuthorRecentArticleHistoryEntry> entries)
    {
        var normalized = entries.Select(entry => entry with
        {
            ContentDigest = AuthorRecentArticleHistoryContract.ComputeEntryDigest(s_owner, entry)
        }).ToArray();
        long collectionRevision = normalized.Length == 0 ? 0 : normalized.Max(static entry => entry.EntryRevision);
        return new(
            s_owner,
            AuthorRecentArticleHistoryContract.SchemaVersion,
            collectionRevision,
            normalized.Length,
            normalized,
            normalized.Length == 0 ? DateTime.SpecifyKind(DateTime.MinValue, DateTimeKind.Utc)
                : normalized.Max(RecentArticleHistoryOrdering.LatestFactAtUtc),
            AuthorRecentArticleHistoryContract.ComputeCollectionDigest(
                s_owner,
                collectionRevision,
                normalized));
    }

    private static AuthorRecentArticleHistoryEntry CreateEntry(int articleId, long revision, int seconds)
    {
        DateTime timestamp = DateTime.SpecifyKind(
            new DateTime(2026, 9, 15, 12, 0, seconds),
            DateTimeKind.Utc);
        return new(
            articleId,
            revision,
            timestamp,
            null,
            null,
            "open",
            seconds,
            Hash($"entry:{articleId}"));
    }

    private static string Hash(string value)
        => AuthorRecentArticleHistoryContract.HashText(value);

    private static AuthorRecentArticleHistoryProjectionService CreateService(
        IAuthorRecentArticleHistoryStore store,
        IAuthorRecentArticleHistoryPermissionProjectionProvider permission,
        IAuthorRecentArticleHistoryProjectionCache? cache = null)
        => new(
            store,
            permission,
            new AuthorRecentArticleHistoryCursorCodec(new EphemeralDataProtectionProvider()),
            cache ?? new DirectAuthorRecentArticleHistoryProjectionCache());

    private sealed class FakeStore(
        AuthorRecentArticleHistoryCollectionSnapshot snapshot,
        AuthorRecentArticleHistoryVerificationResult? verification = null)
        : IAuthorRecentArticleHistoryStore
    {
        public int VerificationCount
        {
            get;
            private set;
        }

        public Task<AuthorRecentArticleHistoryReceipt> RecordOpenedAsync(
            AuthorRecentArticleHistoryOwner owner,
            int articleId,
            long serverRevision,
            long expectedCollectionRevision,
            Guid requestId,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthorRecentArticleHistoryReceipt> RecordEditedAsync(
            AuthorRecentArticleHistoryOwner owner,
            int articleId,
            long serverRevision,
            long expectedCollectionRevision,
            Guid requestId,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthorRecentArticleHistoryReceipt> RecordActivatedAsync(
            AuthorRecentArticleHistoryOwner owner,
            int articleId,
            long serverRevision,
            long expectedCollectionRevision,
            Guid requestId,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthorRecentArticleHistoryCollectionSnapshot> GetAuthoritySnapshotAsync(
            AuthorRecentArticleHistoryOwner owner,
            CancellationToken cancellationToken = default)
            => Task.FromResult(snapshot);

        public Task<AuthorRecentArticleHistoryVerificationResult> VerifyAsync(
            AuthorRecentArticleHistoryOwner owner,
            CancellationToken cancellationToken = default)
        {
            VerificationCount++;
            return Task.FromResult(verification ?? new AuthorRecentArticleHistoryVerificationResult(
                true,
                [],
                snapshot.Revision,
                snapshot.ItemCount,
                snapshot.ContentDigest));
        }
    }

    private sealed class RecordingProjectionCache : IAuthorRecentArticleHistoryProjectionCache
    {
        public int PublicationCount
        {
            get;
            private set;
        }

        public Task<bool> PublishAsync(
            AuthorRecentArticleHistoryProjectionPage page,
            IReadOnlyList<AuthorRecentArticleHistoryEntry> authoritativeEntries,
            CancellationToken cancellationToken = default)
        {
            PublicationCount++;
            return Task.FromResult(true);
        }
    }

    private sealed class FakePermission(
        IReadOnlyList<AuthorRecentArticleHistoryPermissionDecision> decisions,
        AuthorRecentArticleHistoryPermissionSnapshotStatus status = AuthorRecentArticleHistoryPermissionSnapshotStatus.Current,
        Func<AuthorRecentArticleHistoryPermissionSnapshot, AuthorRecentArticleHistoryPermissionSnapshot>? transform = null)
        : IAuthorRecentArticleHistoryPermissionProjectionProvider
    {
        private readonly string _permissionRevision = Hash("permission");
        private readonly string _siteRevision = Hash("site");
        private readonly string _sessionRevision = Hash("session");

        public int ResolveCount
        {
            get;
            private set;
        }

        public AuthorRecentArticleHistoryPermissionSnapshot? LastSnapshot
        {
            get;
            private set;
        }

        public Task<AuthorRecentArticleHistoryPermissionSnapshot> ResolveAsync(
            AuthorRecentArticleHistoryPermissionRequest request,
            CancellationToken cancellationToken = default)
        {
            ResolveCount++;
            var snapshot = new AuthorRecentArticleHistoryPermissionSnapshot(
                status,
                request.Owner,
                _permissionRevision,
                _siteRevision,
                _sessionRevision,
                decisions,
                string.Empty);
            snapshot = snapshot with
            {
                ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
            };
            AuthorRecentArticleHistoryPermissionSnapshot resolved =
                transform is null ? snapshot : transform(snapshot);
            LastSnapshot = resolved;
            return Task.FromResult(resolved);
        }
    }

    private sealed class RejectingProjectionCache : IAuthorRecentArticleHistoryProjectionCache
    {
        public Task<bool> PublishAsync(
            AuthorRecentArticleHistoryProjectionPage page,
            IReadOnlyList<AuthorRecentArticleHistoryEntry> authoritativeEntries,
            CancellationToken cancellationToken = default)
            => Task.FromResult(false);
    }
}
