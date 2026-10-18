using FsusBlog.Server.Services.Authoring;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SqlArticleGraphAdmissionReaderTests : IDisposable
{
    private readonly List<SqlSugarClient> _ownedClients = [];

    private static readonly ArticleGraphCurrentArticleReadRequest s_request = new(
        new(1, "primary-site"), Guid.NewGuid(),
        "article:dd90413e-7d50-4264-9910-d89294ac2f18",
        "revision:aa90413e-7d50-4264-9910-d89294ac2f18");

    [Theory]
    [InlineData("article:1", "revision:aa90413e-7d50-4264-9910-d89294ac2f18")]
    [InlineData("article:DD90413E-7D50-4264-9910-D89294AC2F18", "revision:aa90413e-7d50-4264-9910-d89294ac2f18")]
    [InlineData("article:00000000-0000-0000-0000-000000000000", "revision:aa90413e-7d50-4264-9910-d89294ac2f18")]
    [InlineData("article:dd90413e-7d50-4264-9910-d89294ac2f18", "revision:1")]
    [InlineData("article:dd90413e-7d50-4264-9910-d89294ac2f18", "revision:AA90413E-7D50-4264-9910-D89294AC2F18")]
    [InlineData("article:dd90413e-7d50-4264-9910-d89294ac2f18", "revision:00000000-0000-0000-0000-000000000000")]
    public async Task InvalidPortableIdentitiesStopBeforeAnySource(string article, string revision)
    {
        var permission = new PermissionSource(_ => throw new InvalidOperationException());
        var reader = CreateReader(permission);
        Assert.Null(await reader.ReadCurrentAsync(s_request with
        {
            ArticleIdentity = article,
            RevisionIdentity = revision
        }));
        Assert.Empty(permission.Requests);
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("site")]
    [InlineData("request")]
    public async Task InvalidOwnerOrRequestStopsBeforeAnySource(string field)
    {
        var permission = new PermissionSource(_ => throw new InvalidOperationException());
        ArticleGraphCurrentArticleReadRequest request = field switch
        {
            "owner" => s_request with { Owner = new(0, "primary-site") },
            "site" => s_request with { Owner = new(1, "") },
            _ => s_request with { RequestId = Guid.Empty }
        };
        Assert.Null(await CreateReader(permission).ReadCurrentAsync(request));
        Assert.Empty(permission.Requests);
    }

    [Theory]
    [InlineData("stale")]
    [InlineData("unavailable")]
    [InlineData("owner")]
    [InlineData("site")]
    [InlineData("digest")]
    [InlineData("permission-revision")]
    [InlineData("site-revision")]
    [InlineData("session-revision")]
    [InlineData("extra-decision")]
    public async Task InvalidOriginalPreflightIsNeverBlessedByRehashing(string change)
    {
        var permission = new PermissionSource(request =>
        {
            AuthorArticlePinPermissionSnapshot snapshot = Snapshot(request);
            snapshot = change switch
            {
                "stale" => snapshot with { Status = AuthorArticlePinPermissionSnapshotStatus.Stale },
                "unavailable" => snapshot with { Status = AuthorArticlePinPermissionSnapshotStatus.Unavailable },
                "owner" => snapshot with { Owner = new(2, request.Owner.SiteScope) },
                "site" => snapshot with { Owner = new(1, "other-site") },
                "permission-revision" => snapshot with { PermissionRevision = "" },
                "site-revision" => snapshot with { SiteRevision = "" },
                "session-revision" => snapshot with { SessionRevision = "" },
                "extra-decision" => snapshot with { Decisions = [new(1, true, true, "reference")] },
                _ => snapshot with { ContentDigest = "forged" }
            };
            return change == "digest" ? snapshot : Seal(snapshot);
        });
        Assert.Null(await CreateReader(permission).ReadCurrentAsync(s_request));
        Assert.Empty(Assert.Single(permission.Requests).ArticleIds);
    }

    [Fact]
    public async Task FailedPermissionSourceReturnsNoDiagnosticOrPartialFact()
    {
        var permission = new PermissionSource(_ => throw new InvalidOperationException("private database detail"));
        Assert.Null(await CreateReader(permission).ReadCurrentAsync(s_request));
        Assert.Single(permission.Requests);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(int.MaxValue)]
    public async Task PreflightDecisionCountRefusesBeforeProviderEnumerationOrIndexing(int count)
    {
        var decisions = new DecisionList(_ => count);
        var permission = new PermissionSource(request => Snapshot(request) with { Decisions = decisions });
        Assert.Null(await CreateReader(permission).ReadCurrentAsync(s_request));
        Assert.Equal(1, decisions.CountReads);
        Assert.Equal(0, decisions.IndexReads);
        Assert.Equal(0, decisions.Enumerations);
    }

    [Fact]
    public async Task EmptyPreflightUsesRecheckedCountWithoutEnumeratingProviderDecisions()
    {
        var decisions = new DecisionList(_ => 0);
        var permission = new PermissionSource(request => Snapshot(request) with { Decisions = decisions });
        using var db = new SqlSugarClient(new ConnectionConfig
        {
            DbType = SqlSugar.DbType.Sqlite,
            ConnectionString = "Data Source=:memory:",
            InitKeyType = InitKeyType.Attribute
        });
        // The unsupported DB context refuses after permission capture; it must never be opened.
        Assert.Null(await CreateReader(permission, db).ReadCurrentAsync(s_request));
        Assert.InRange(decisions.CountReads, 2, 3);
        Assert.Equal(0, decisions.IndexReads);
        Assert.Equal(0, decisions.Enumerations);
        Assert.Equal(System.Data.ConnectionState.Closed, db.Ado.Connection.State);
    }

    [Fact]
    public async Task ChangedOrThrowingPreflightCountReturnsNoPartialFact()
    {
        foreach (bool fail in new[] { false, true })
        {
            var decisions = new DecisionList(read => read == 1 ? 0
                : fail ? throw new InvalidOperationException("private provider detail") : 1);
            var permission = new PermissionSource(request => Snapshot(request) with { Decisions = decisions });
            Assert.Null(await CreateReader(permission).ReadCurrentAsync(s_request));
            Assert.Equal(2, decisions.CountReads);
            Assert.Equal(0, decisions.IndexReads);
            Assert.Equal(0, decisions.Enumerations);
        }
    }

    [Fact]
    public async Task CallerCancellationDuringProviderCountPropagates()
    {
        using var cancellation = new CancellationTokenSource();
        var decisions = new DecisionList(_ =>
        {
            cancellation.Cancel();
            throw new InvalidOperationException("provider failed after cancellation");
        });
        var permission = new PermissionSource(request => Snapshot(request) with { Decisions = decisions });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            CreateReader(permission).ReadCurrentAsync(s_request, cancellation.Token));
        Assert.Equal(0, decisions.Enumerations);
    }

    [Fact]
    public async Task CallerCancellationDuringNormallyReturningProviderCountPropagates()
    {
        using var cancellation = new CancellationTokenSource();
        var decisions = new DecisionList(_ =>
        {
            cancellation.Cancel();
            return 1;
        });
        var permission = new PermissionSource(request => Snapshot(request) with { Decisions = decisions });

        OperationCanceledException error = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            CreateReader(permission).ReadCurrentAsync(s_request, cancellation.Token));

        Assert.Equal(cancellation.Token, error.CancellationToken);
        Assert.Equal(1, decisions.CountReads);
        Assert.Equal(0, decisions.IndexReads);
        Assert.Equal(0, decisions.Enumerations);
    }

    [Fact]
    public async Task CallerCancellationDuringEveryReturningPreflightCountStopsAtThatGetter()
    {
        foreach (int phase in new[] { 1, 2, 3 })
        {
            foreach (int returnedCount in new[] { -1, 0, 1, int.MaxValue })
            {
                using var cancellation = new CancellationTokenSource();
                var decisions = new DecisionList(read =>
                {
                    if (read == phase)
                    {
                        cancellation.Cancel();
                        return returnedCount;
                    }
                    return 0;
                });
                var permission = new PermissionSource(request => Snapshot(request) with { Decisions = decisions });

                OperationCanceledException error = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                    CreateReader(permission).ReadCurrentAsync(s_request, cancellation.Token));

                Assert.Equal(cancellation.Token, error.CancellationToken);
                Assert.Equal(phase, decisions.CountReads);
                Assert.Equal(0, decisions.IndexReads);
                Assert.Equal(0, decisions.Enumerations);
            }
        }
    }

    [Fact]
    public async Task FirstPreflightRefusalDoesNotReachLaterCancellingGetter()
    {
        foreach (string refusal in new[] { "count", "status", "digest" })
        {
            using var cancellation = new CancellationTokenSource();
            int allowedReads = refusal == "count" ? 1 : 2;
            var decisions = new DecisionList(read =>
            {
                if (read > allowedReads)
                {
                    cancellation.Cancel();
                    throw new InvalidOperationException("Getter after first refusal must not run.");
                }
                return refusal == "count" ? 1 : 0;
            });
            var permission = new PermissionSource(request => Snapshot(request) with
            {
                Decisions = decisions,
                Status = refusal == "status" ? AuthorArticlePinPermissionSnapshotStatus.Unavailable
                    : AuthorArticlePinPermissionSnapshotStatus.Current,
                ContentDigest = refusal == "digest" ? "forged" : Snapshot(request).ContentDigest
            });

            Assert.Null(await CreateReader(permission).ReadCurrentAsync(s_request, cancellation.Token));

            Assert.False(cancellation.IsCancellationRequested);
            Assert.Equal(allowedReads, decisions.CountReads);
            Assert.Equal(0, decisions.IndexReads);
            Assert.Equal(0, decisions.Enumerations);
        }
    }

    [Fact]
    public async Task UnrelatedDependencyCancellationIsAnUnavailableSource()
    {
        var permission = new PermissionSource(_ => throw new OperationCanceledException());
        Assert.Null(await CreateReader(permission).ReadCurrentAsync(s_request));
        var decisions = new DecisionList(_ => throw new OperationCanceledException());
        permission = new PermissionSource(request => Snapshot(request) with { Decisions = decisions });
        Assert.Null(await CreateReader(permission).ReadCurrentAsync(s_request));
        Assert.Equal(1, decisions.CountReads);
        Assert.Equal(0, decisions.Enumerations);
    }

    [Fact]
    public async Task CallerCancellationPropagatesBeforePreflightAndAfterDriverFailure()
    {
        using var cancellation = new CancellationTokenSource();
        var permission = new PermissionSource(_ =>
        {
            cancellation.Cancel();
            throw new InvalidOperationException("driver failure after cancellation");
        });
        var reader = CreateReader(permission);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.ReadCurrentAsync(s_request, cancellation.Token));
        Assert.Single(permission.Requests);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.ReadCurrentAsync(s_request, cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.RevalidateCurrentAsync(s_request, null!, cancellation.Token));
        Assert.Single(permission.Requests);
    }

    [Fact]
    public async Task RealCoordinateAuthorityFailureStopsBeforeMetadata()
    {
        using var db = new SqlSugarClient(new ConnectionConfig
        {
            DbType = SqlSugar.DbType.Sqlite,
            ConnectionString = "Data Source=:memory:",
            InitKeyType = InitKeyType.Attribute
        });
        var permission = new PermissionSource(Snapshot);
        Assert.Null(await CreateReader(permission, db).ReadCurrentAsync(s_request));
        Assert.Single(permission.Requests);
        Assert.Equal(System.Data.ConnectionState.Closed, db.Ado.Connection.State);
    }

    private SqlArticleGraphAdmissionReader CreateReader(PermissionSource permission, ISqlSugarClient? db = null)
    {
        if (db is null)
        {
            var client = new SqlSugarClient(new ConnectionConfig
            {
                DbType = SqlSugar.DbType.PostgreSQL,
                ConnectionString = "Host=unused.invalid;Database=unit-source-must-not-open;Username=unit",
                InitKeyType = InitKeyType.Attribute,
                IsAutoCloseConnection = true
            });
            _ownedClients.Add(client);
            db = client;
        }
        return new(db, new(), permission, new ForbiddenArticleSource());
    }

    public void Dispose()
    {
        foreach (SqlSugarClient client in _ownedClients)
        {
            client.Dispose();
        }
    }

    private static AuthorArticlePinPermissionSnapshot Snapshot(AuthorArticlePinPermissionBatchRequest request)
        => Seal(new(AuthorArticlePinPermissionSnapshotStatus.Current, request.Owner,
            "permission", "site", "session", [], ""));

    private static AuthorArticlePinPermissionSnapshot Seal(AuthorArticlePinPermissionSnapshot snapshot)
        => snapshot with
        {
            ContentDigest = AuthorArticlePinProjectionContract.ComputePermissionDigest(snapshot)
        };

    private sealed class PermissionSource(Func<AuthorArticlePinPermissionBatchRequest, AuthorArticlePinPermissionSnapshot> resolve)
        : IAuthorArticlePinPermissionProjectionProvider
    {
        public List<AuthorArticlePinPermissionBatchRequest> Requests { get; } = [];

        public Task<AuthorArticlePinPermissionSnapshot> ResolveAsync(
            AuthorArticlePinPermissionBatchRequest request, CancellationToken cancellationToken = default)
        {
            Requests.Add(request);
            return Task.FromResult(resolve(request));
        }
    }

    private sealed class ForbiddenArticleSource : IAuthorArticlePinArticleProjectionSource
    {
        public Task<IReadOnlyList<AuthorArticlePinArticleFact>> ReadCurrentBatchAsync(
            IReadOnlyList<int> articleIds, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("Metadata must not be reached.");
    }

    private sealed class DecisionList(Func<int, int> count) : IReadOnlyList<AuthorArticlePinPermissionDecision>
    {
        public int CountReads
        {
            get; private set;
        }
        public int IndexReads
        {
            get; private set;
        }
        public int Enumerations
        {
            get; private set;
        }
        public int Count => count(++CountReads);

        public AuthorArticlePinPermissionDecision this[int index]
        {
            get
            {
                IndexReads++;
                throw new InvalidOperationException("Empty preflight cannot index provider decisions.");
            }
        }

        public IEnumerator<AuthorArticlePinPermissionDecision> GetEnumerator()
        {
            Enumerations++;
            throw new InvalidOperationException("Provider enumeration must not be entered.");
        }

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
