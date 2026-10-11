using System.Data;
using System.Security.Claims;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Background;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Substituted ADO transaction/read lifecycle only; no database or fingerprint qualification.</summary>
[Trait("Category", "Unit")]
public sealed class AuthorArticleQuerySourceSnapshotTests
{
    [Fact]
    public async Task Snapshot_ReusesOriginalCoordinatesExactIdsAndFieldsInOneReadOnlyTransaction()
    {
        var fixture = new Fixture();
        int result = await fixture.ReadAsync(async (source, token) =>
        {
            AuthorArticleQuerySourceBatch first = await source.ReadCoordinatesAsync([AuthorArticleQueryStatus.Draft], token);
            Assert.Equal(new AuthorArticleQuerySourceCoordinate(7, 107, "row-7", AuthorArticleQueryStatus.Draft),
                Assert.Single(first.Coordinates));
            AuthorArticleQuerySourceBatch exact = await source.ReadCoordinatesForIdsAsync(
                [AuthorArticleQueryStatus.Draft], [7], token);
            Assert.Equal(first.Coordinates, exact.Coordinates);
            IReadOnlyList<AuthorArticleQuerySourceFields> fields = await source.ReadFieldsAsync([7], token);
            Assert.Equal(first.Coordinates[0], Assert.Single(fields).Coordinate);
            Assert.Equal("title-7", fields[0].Title);
            Assert.Equal("category", fields[0].Category);
            Assert.Equal(new[] { "tag" }, fields[0].Tags);
            Assert.Same(fixture.Transaction, fixture.SnapshotAdo.Transaction);
            Assert.Null(fixture.OriginalAdo.Transaction);
            return fields.Count;
        });
        Assert.Equal(1, result);
        Assert.Equal(new[] { "begin", "read-only", "read", "read", "read", "rollback" }, fixture.Events);
        Assert.All(fixture.Readers, static reader => Assert.True(reader.IsClosed));
        await fixture.AssertCleanAsync();
    }

    [Fact]
    public async Task Snapshot_PrimaryEntryCancellationCannotCreateClient()
    {
        var fixture = new Fixture();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ((IAuthorArticleQuerySourceReader)fixture.Owner)
            .ReadInSnapshotAsync((_, _) => Task.FromResult(1), new CancellationToken(true)));
        _ = fixture.OriginalDb.DidNotReceive().CopyNew();
        Assert.Empty(fixture.Events);
    }

    [Theory]
    [InlineData("provider")]
    [InlineData("ambient")]
    public async Task Snapshot_PrimaryEntryRefusesInvalidOwnerBeforeClientCreation(string fault)
    {
        var fixture = new Fixture();
        if (fault == "provider")
        {
            fixture.OriginalDb.CurrentConnectionConfig.Returns(new ConnectionConfig { DbType = SqlSugar.DbType.MySql });
        }
        else
        {
            fixture.OriginalAdo.Transaction.Returns(fixture.Transaction);
        }
        Exception error = await Assert.ThrowsAnyAsync<Exception>(() => ((IAuthorArticleQuerySourceReader)fixture.Owner)
            .ReadInSnapshotAsync((_, _) => Task.FromResult(1), default));
        Assert.Equal(fault == "provider" ? "author_article_query_source_snapshot_provider_unavailable"
            : "author_article_query_source_snapshot_requires_fresh_transaction", error.Message);
        _ = fixture.OriginalDb.DidNotReceive().CopyNew();
        Assert.Empty(fixture.Events);
    }

    [Fact]
    public async Task Snapshot_ClassifiedTimeoutCannotCreateClientOrTransaction()
    {
        var gate = new TimeoutGate();
        var fixture = new Fixture(gate);
        TimeoutException error = await Assert.ThrowsAsync<TimeoutException>(() => ((IAuthorArticleQuerySourceReader)fixture.Owner)
            .ReadInSnapshotAsync((_, _) => Task.FromResult(1), default));
        Assert.Equal("db-gate-timeout:author-article-query-source-snapshot", error.Message);
        Assert.Equal(DbWorkloadClass.AdminHeavyRead, gate.Workload);
        Assert.Equal("author-article-query-source-snapshot", gate.Operation);
        _ = fixture.OriginalDb.DidNotReceive().CopyNew();
        Assert.Empty(fixture.Events);
    }

    [Fact]
    public async Task Snapshot_RollbackFailureCannotReturnSuccessfulData()
    {
        var fixture = new Fixture();
        var expected = new InvalidOperationException("rollback-failed");
        bool callbackVisited = false;
        fixture.BeforeRollback = () => throw expected;
        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync((_, _) =>
        {
            callbackVisited = true;
            return Task.FromResult(1);
        }));
        Assert.Same(expected, actual);
        Assert.True(callbackVisited);
        Assert.Equal(fixture.PreviousCancellation, fixture.SnapshotAdo.CancellationToken);
        Assert.Null(fixture.OriginalAdo.Transaction);
        await fixture.SnapshotAdo.DidNotReceive().CommitTranAsync();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(1000)]
    [InlineData(1001)]
    [InlineData(10000)]
    public async Task Snapshot_TracesEverySparsePageOnOneOriginalTransaction(int count)
    {
        var fixture = new Fixture { Ids = Enumerable.Range(0, count).Select(static i => 7 + i * 3).ToArray() };
        int observed = await fixture.ReadAsync(async (source, token) =>
        {
            var ids = new List<int>();
            int position = 0;
            while (true)
            {
                AuthorArticleQuerySourceBatch page = await source.ReadCoordinatesAfterAsync(
                    [AuthorArticleQueryStatus.Draft], position, token);
                Assert.InRange(page.Coordinates.Count, 0, 1000);
                Assert.Same(fixture.Transaction, fixture.SnapshotAdo.Transaction);
                ids.AddRange(page.Coordinates.Select(static coordinate => coordinate.ArticleId));
                if (!page.HasMore)
                {
                    break;
                }
                Assert.True(page.NextAfterArticleId > position);
                position = page.NextAfterArticleId!.Value;
            }
            Assert.Equal(fixture.Ids, ids);
            return ids.Count;
        });
        Assert.Equal(count, observed);
        Assert.Equal(1, fixture.Events.Count(static value => value == "begin"));
        Assert.Equal(Math.Max(1, (count + 999) / 1000), fixture.Events.Count(static value => value == "read"));
        Assert.All(fixture.CoordinateLimits, static limit => Assert.Equal(1001, limit));
        Assert.All(fixture.Readers, static reader => Assert.True(reader.IsClosed));
        await fixture.AssertCleanAsync();
    }

    [Theory]
    [InlineData("provider")]
    [InlineData("original-transaction")]
    [InlineData("snapshot-transaction")]
    [InlineData("shared-client")]
    [InlineData("shared-connection")]
    public async Task Snapshot_InvalidOwnerCannotBeginOrRead(string fault)
    {
        var fixture = new Fixture();
        ISqlSugarClient target = fixture.SnapshotDb;
        switch (fault)
        {
            case "provider":
                fixture.SnapshotDb.CurrentConnectionConfig.Returns(new ConnectionConfig { DbType = SqlSugar.DbType.MySql });
                break;
            case "original-transaction":
                fixture.OriginalAdo.Transaction.Returns(fixture.Transaction);
                break;
            case "snapshot-transaction":
                fixture.ActiveTransaction = fixture.Transaction;
                break;
            case "shared-client":
                target = fixture.OriginalDb;
                break;
            case "shared-connection":
                fixture.SnapshotAdo.Connection.Returns(fixture.OriginalConnection);
                break;
        }
        await Assert.ThrowsAnyAsync<Exception>(() => fixture.Owner.ReadQuerySnapshotCoreAsync(target,
            (_, _) => Task.FromException<int>(new InvalidOperationException("callback-must-not-run")), default));
        Assert.Empty(fixture.Events);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("isolation")]
    [InlineData("connection")]
    public async Task Snapshot_InvalidActualTransactionCannotEnterCallback(string fault)
    {
        var fixture = new Fixture();
        fixture.AfterBegin = () =>
        {
            if (fault == "missing")
            {
                fixture.ActiveTransaction = null;
            }
            else if (fault == "isolation")
            {
                fixture.Transaction.IsolationLevel.Returns(IsolationLevel.ReadCommitted);
            }
            else
            {
                fixture.Transaction.Connection.Returns(fixture.OriginalConnection);
            }
        };
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync(
            (_, _) => Task.FromException<int>(new InvalidOperationException("callback-must-not-run"))));
        Assert.Equal("author_article_query_source_snapshot_transaction_invalid", error.Message);
        Assert.Equal(new[] { "begin", "rollback" }, fixture.Events);
        await fixture.AssertCleanAsync();
    }

    [Theory]
    [InlineData("begin")]
    [InlineData("read-only")]
    [InlineData("callback")]
    public async Task Snapshot_FailureRollsBackAndRestoresOriginalCancellation(string stage)
    {
        var fixture = new Fixture();
        var expected = new InvalidOperationException("expected-failure");
        if (stage == "begin")
        {
            fixture.AfterBegin = () => throw expected;
        }
        else if (stage == "read-only")
        {
            fixture.AfterReadOnly = () => throw expected;
        }
        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync<int>(
            (_, _) => throw expected));
        Assert.Same(expected, actual);
        await fixture.AssertCleanAsync();
    }

    [Theory]
    [InlineData("before")]
    [InlineData("begin")]
    [InlineData("read-only")]
    [InlineData("reader")]
    [InlineData("callback")]
    public async Task Snapshot_CancellationNeverReturnsDataOrSkipsCleanup(string stage)
    {
        var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        if (stage == "before")
        {
            cancellation.Cancel();
        }
        fixture.AfterBegin = () =>
        {
            if (stage == "begin")
            {
                cancellation.Cancel();
            }
        };
        fixture.AfterReadOnly = () =>
        {
            if (stage == "read-only")
            {
                cancellation.Cancel();
            }
        };
        fixture.BeforeReader = () =>
        {
            if (stage == "reader")
            {
                cancellation.Cancel();
            }
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.ReadAsync(async (source, token) =>
        {
            _ = await source.ReadCoordinatesAsync([AuthorArticleQueryStatus.Draft], token);
            if (stage == "callback")
            {
                cancellation.Cancel();
            }
            return 1;
        }, cancellation.Token));
        Assert.All(fixture.Readers, static reader => Assert.True(reader.IsClosed));
        if (stage == "before")
        {
            Assert.Empty(fixture.Events);
        }
        else
        {
            await fixture.AssertCleanAsync();
        }
    }

    [Theory]
    [InlineData("scope", false)]
    [InlineData("read", false)]
    [InlineData("scope", true)]
    [InlineData("read", true)]
    public async Task Snapshot_EachReadPreservesBothCancellationOwners(string owner, bool duringRead)
    {
        var fixture = new Fixture { BlockReader = duringRead };
        using var scopeCancellation = new CancellationTokenSource();
        using var readCancellation = new CancellationTokenSource();
        void Cancel()
        {
            if (owner == "scope")
                scopeCancellation.Cancel();
            else
                readCancellation.Cancel();
        }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.ReadAsync(async (source, token) =>
        {
            if (!duringRead)
                Cancel();
            Task<AuthorArticleQuerySourceBatch> pending = source.ReadCoordinatesAsync(
                [AuthorArticleQueryStatus.Draft], readCancellation.Token);
            if (duringRead)
            {
                await fixture.ReaderWaitStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
                Cancel();
            }
            _ = await pending;
            return 1;
        }, scopeCancellation.Token));
        Assert.Equal(duringRead, fixture.Events.Contains("read"));
        Assert.Equal(duringRead, fixture.ReaderWaitFinished);
        await fixture.AssertCleanAsync();
    }

    [Theory]
    [InlineData("transaction")]
    [InlineData("connection")]
    [InlineData("isolation")]
    public async Task Snapshot_TransactionDriftDiscardsReadData(string fault)
    {
        var fixture = new Fixture();
        fixture.BeforeReader = () =>
        {
            if (fault == "transaction")
                fixture.ActiveTransaction = null;
            else if (fault == "connection")
                fixture.SnapshotAdo.Connection.Returns(fixture.OriginalConnection);
            else
                fixture.Transaction.IsolationLevel.Returns(IsolationLevel.ReadCommitted);
        };
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync(
            (source, token) => source.ReadCoordinatesAsync([AuthorArticleQueryStatus.Draft], token)));
        Assert.Equal("author_article_query_source_snapshot_transaction_changed", error.Message);
        Assert.All(fixture.Readers, static reader => Assert.True(reader.IsClosed));
        await fixture.AssertCleanAsync();
    }

    [Fact]
    public async Task Snapshot_LeaseCannotOutliveCallbackOrStartNestedSnapshot()
    {
        var fixture = new Fixture();
        IAuthorArticleQuerySourceReader? escaped = null;
        _ = await fixture.ReadAsync(async (source, token) =>
        {
            escaped = source;
            await Assert.ThrowsAsync<NotSupportedException>(() => source.ReadInSnapshotAsync(
                (_, _) => Task.FromResult(1), token));
            return 1;
        });
        await Assert.ThrowsAsync<ObjectDisposedException>(() => escaped!.ReadCoordinatesAsync(
            [AuthorArticleQueryStatus.Draft], default));
        await fixture.AssertCleanAsync();
    }

    [Fact]
    public async Task Snapshot_UnawaitedReadIsCancelledAndDrainedBeforeRollback()
    {
        var fixture = new Fixture { BlockReader = true };
        Task<AuthorArticleQuerySourceBatch>? pending = null;
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync((source, token) =>
        {
            pending = source.ReadCoordinatesAsync([AuthorArticleQueryStatus.Draft], token);
            Assert.False(pending.IsCompleted);
            return Task.FromResult(1);
        }));
        Assert.Equal("author_article_query_source_snapshot_read_not_awaited", error.Message);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending!);
        Assert.True(fixture.ReaderWaitFinished);
        await fixture.AssertCleanAsync();
    }

    [Theory]
    [InlineData("status")]
    [InlineData("cancel")]
    [InlineData("drift")]
    public async Task Snapshot_CompletedReadFailureCannotReturnCallbackSuccess(string fault)
    {
        var fixture = new Fixture();
        if (fault == "drift")
            fixture.BeforeReader = () => fixture.ActiveTransaction = null;
        Task<AuthorArticleQuerySourceBatch>? discarded = null;
        Exception error = await Assert.ThrowsAnyAsync<Exception>(() => fixture.ReadAsync((source, token) =>
        {
            discarded = source.ReadCoordinatesAsync(
                [fault == "status" ? (AuthorArticleQueryStatus)4 : AuthorArticleQueryStatus.Draft],
                fault == "cancel" ? new CancellationToken(true) : token);
            Assert.True(discarded.IsCompleted);
            Assert.Equal(fault == "cancel", discarded.IsCanceled);
            Assert.Equal(fault != "cancel", discarded.IsFaulted);
            return Task.FromResult(1);
        }));
        if (fault == "status")
            Assert.IsType<ArgumentException>(error);
        else if (fault == "cancel")
            Assert.IsAssignableFrom<OperationCanceledException>(error);
        else
            Assert.Equal("author_article_query_source_snapshot_transaction_changed", error.Message);
        Assert.NotNull(discarded);
        await fixture.AssertCleanAsync();
    }

    [Fact]
    public async Task Snapshot_EarlierCompletedFailureCannotBeHiddenByLaterSuccessfulRead()
    {
        var fixture = new Fixture();
        ArgumentException? first = null;
        ArgumentException error = await Assert.ThrowsAsync<ArgumentException>(() => fixture.ReadAsync(async (source, token) =>
        {
            first = await Assert.ThrowsAsync<ArgumentException>(() => source.ReadCoordinatesAsync(
                [(AuthorArticleQueryStatus)4], token));
            Assert.Single((await source.ReadCoordinatesAsync([AuthorArticleQueryStatus.Draft], token)).Coordinates);
            return 1;
        }));
        Assert.Same(first, error);
        Assert.Equal(1, fixture.Events.Count(static entry => entry == "read"));
        await fixture.AssertCleanAsync();
    }

    [Theory]
    [InlineData("primary")]
    [InlineData("core")]
    public async Task Snapshot_RealAmbientTransactionRefusesBeforeClientOrAdo(string entry)
    {
        var fixture = new Fixture();
        System.Transactions.Transaction? previous = System.Transactions.Transaction.Current;
        using (var ambient = new System.Transactions.TransactionScope(
            System.Transactions.TransactionScopeOption.Required, System.Transactions.TransactionScopeAsyncFlowOption.Enabled))
        {
            await Task.Yield();
            Assert.NotNull(System.Transactions.Transaction.Current);
            Assert.Null(fixture.OriginalAdo.Transaction);
            Assert.Null(fixture.SnapshotAdo.Transaction);
            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => entry == "primary"
                ? ((IAuthorArticleQuerySourceReader)fixture.Owner).ReadInSnapshotAsync((_, _) => Task.FromResult(1), default)
                : fixture.ReadAsync((_, _) => Task.FromResult(1)));
            Assert.Equal("author_article_query_source_snapshot_ambient_transaction_unavailable", error.Message);
            _ = fixture.OriginalDb.DidNotReceive().CopyNew();
            await fixture.OriginalAdo.DidNotReceive().BeginTranAsync(Arg.Any<IsolationLevel>());
            await fixture.SnapshotAdo.DidNotReceive().BeginTranAsync(Arg.Any<IsolationLevel>());
            Assert.Empty(fixture.Events);
            Assert.Equal(fixture.PreviousCancellation, fixture.SnapshotAdo.CancellationToken);
        }
        Assert.Same(previous, System.Transactions.Transaction.Current);
    }

    [Fact]
    public async Task Snapshot_SuppressedManagedAmbientCanReadWithoutEnlisting()
    {
        var fixture = new Fixture();
        System.Transactions.Transaction? previous = System.Transactions.Transaction.Current;
        using (var ambient = new System.Transactions.TransactionScope(
            System.Transactions.TransactionScopeOption.Required, System.Transactions.TransactionScopeAsyncFlowOption.Enabled))
        {
            await Task.Yield();
            System.Transactions.Transaction outer = Assert.IsAssignableFrom<System.Transactions.Transaction>(
                System.Transactions.Transaction.Current);
            using (var suppressed = new System.Transactions.TransactionScope(
                System.Transactions.TransactionScopeOption.Suppress, System.Transactions.TransactionScopeAsyncFlowOption.Enabled))
            {
                await Task.Yield();
                Assert.Null(System.Transactions.Transaction.Current);
                Assert.Single((await fixture.ReadAsync((source, token) => source.ReadCoordinatesAsync(
                    [AuthorArticleQueryStatus.Draft], token))).Coordinates);
                await fixture.AssertCleanAsync();
            }
            Assert.Same(outer, System.Transactions.Transaction.Current);
        }
        Assert.Same(previous, System.Transactions.Transaction.Current);
    }

    [Fact]
    public async Task Snapshot_ConcurrentReadCannotShareOneDataTransaction()
    {
        var fixture = new Fixture { BlockReader = true };
        _ = await fixture.ReadAsync(async (source, token) =>
        {
            Task<AuthorArticleQuerySourceBatch> first = source.ReadCoordinatesAsync([AuthorArticleQueryStatus.Draft], token);
            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => source.ReadFieldsAsync([7], token));
            Assert.Equal("author_article_query_source_snapshot_concurrent_read", error.Message);
            fixture.ReleaseReader.SetResult();
            _ = await first;
            return 1;
        });
        Assert.Equal(1, fixture.Events.Count(static value => value == "read"));
        await fixture.AssertCleanAsync();
    }

    [Fact]
    public async Task Snapshot_RepeatedFlowsOwnDifferentTransactionsAndClosedLeases()
    {
        var fixture = new Fixture();
        var transactions = new List<IDbTransaction>();
        for (int i = 0; i < 2; i++)
        {
            _ = await fixture.ReadAsync(async (source, token) =>
                (await source.ReadCoordinatesAsync([AuthorArticleQueryStatus.Draft], token)).Coordinates.Count);
            transactions.Add(fixture.Transaction);
            Assert.Null(fixture.ActiveTransaction);
        }
        Assert.Equal(2, fixture.Events.Count(static value => value == "begin"));
        Assert.Equal(2, fixture.Events.Count(static value => value == "rollback"));
        Assert.NotSame(transactions[0], transactions[1]);
        Assert.All(fixture.Readers, static reader => Assert.True(reader.IsClosed));
        await fixture.AssertCleanAsync(2);
    }

    [Fact]
    public async Task Snapshot_LivePermissionAuthorityRetainsItsOriginalClient()
    {
        var fixture = new Fixture();
        var permission = new SqlAuthorRecentArticleHistoryPermissionAuthority(fixture.OriginalDb, fixture.Context,
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["SITE_BASEURL"] = "site-a" }).Build(),
            new FixedClock());
        var request = new AuthorRecentArticleHistoryPermissionRequest(new(7, "site-a"), Guid.CreateVersion7(), []);
        Assert.Equal(AuthorRecentArticleHistoryPermissionSnapshotStatus.Current,
            (await permission.ResolveAsync(request, default)).Status);
        _ = await fixture.ReadAsync(async (source, token) =>
        {
            _ = await source.ReadCoordinatesAsync([AuthorArticleQueryStatus.Draft], token);
            fixture.PermissionRevoked = true;
            Assert.Same(fixture.Transaction, fixture.SnapshotAdo.Transaction);
            Assert.Null(fixture.OriginalAdo.Transaction);
            return 1;
        });
        Assert.Equal(AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable,
            (await permission.ResolveAsync(request, default)).Status);
        Assert.Equal(2, fixture.PermissionReads);
        await fixture.OriginalAdo.DidNotReceive().BeginTranAsync(Arg.Any<IsolationLevel>());
        await fixture.AssertCleanAsync();
    }

    [Theory]
    [InlineData("slug")]
    [InlineData("archived")]
    [InlineData("cursor")]
    public async Task Snapshot_OriginalQueryRefusalsCannotBecomeFingerprintOrGrant(string fault)
    {
        var fixture = new Fixture { Ids = [] };
        var permission = Substitute.For<IAuthorRecentArticleHistoryPermissionProjectionProvider>();
        permission.ResolveAsync(Arg.Any<AuthorRecentArticleHistoryPermissionRequest>(), Arg.Any<CancellationToken>()).Returns(call =>
        {
            var request = call.ArgAt<AuthorRecentArticleHistoryPermissionRequest>(0);
            var snapshot = new AuthorRecentArticleHistoryPermissionSnapshot(AuthorRecentArticleHistoryPermissionSnapshotStatus.Current,
                request.Owner, AuthorRecentArticleHistoryContract.HashText("permission"), AuthorRecentArticleHistoryContract.HashText("site"),
                AuthorRecentArticleHistoryContract.HashText("session"), [], string.Empty);
            return Task.FromResult(snapshot with
            {
                ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
            });
        });
        AuthorArticleQuerySourceInspectionResult result = await fixture.ReadAsync((source, token) =>
        {
            var request = new AuthorArticleQueryRequest(1, new(7, "site-a"), Guid.CreateVersion7(), 1, string.Empty,
                [fault == "archived" ? AuthorArticleQueryStatus.Archived : AuthorArticleQueryStatus.Draft],
                [fault == "archived" ? AuthorArticleQueryBucket.Archived : AuthorArticleQueryBucket.Draft],
                "zh-CN", AuthorArticleQueryContract.Collation, 10, fault == "cursor" ? "cursor" : null);
            return new AuthorArticleQuerySourceInspection(permission, source).InspectAsync(request, token);
        });
        Assert.Equal(fault switch
        {
            "archived" => AuthorArticleQuerySourceUnavailableReason.ArchivedReadGrantUnavailable,
            "cursor" => AuthorArticleQuerySourceUnavailableReason.QueryCursorUnavailable,
            _ => AuthorArticleQuerySourceUnavailableReason.SlugUnavailable
        }, result.UnavailableReason);
        Assert.Empty(result.ObservedFields);
        Assert.Null(result.NextAfterArticleId);
        Assert.Null(result.HistoryIdentity);
        await fixture.AssertCleanAsync();
    }

    private sealed class FixedClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => new(new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
    }

    private sealed class TimeoutGate : IClassifiedDbConcurrencyGate
    {
        public DbWorkloadClass? Workload
        {
            get; private set;
        }
        public string? Operation
        {
            get; private set;
        }
        public Task<T> ExecuteClassifiedAsync<T>(DbWorkloadClass workload, string operation,
            Func<CancellationToken, Task<T>> action, Func<CancellationToken, Task<T>> onTimeout,
            CancellationToken cancellationToken = default)
        {
            Workload = workload;
            Operation = operation;
            return onTimeout(cancellationToken);
        }
        public Task<T> ExecuteAsync<T>(string operation, Func<CancellationToken, Task<T>> action,
            Func<CancellationToken, Task<T>> onTimeout, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("classification-required");
        public DbConcurrencyGateSnapshot GetSnapshot() => new(1, 0, 0);
        public DbConcurrencyGateDiagnostics GetDiagnostics() => new(1, 1, new Dictionary<string, DbWorkloadGateSnapshot>());
    }

    private sealed class Fixture
    {
        public ISqlSugarClient OriginalDb { get; } = Substitute.For<ISqlSugarClient>();
        public IAdo OriginalAdo { get; } = Substitute.For<IAdo>();
        public ISqlSugarClient SnapshotDb { get; } = Substitute.For<ISqlSugarClient>();
        public IAdo SnapshotAdo { get; } = Substitute.For<IAdo>();
        public IDbConnection OriginalConnection { get; } = Substitute.For<IDbConnection>();
        public IDbConnection SnapshotConnection { get; } = Substitute.For<IDbConnection>();
        public IDbTransaction Transaction { get; private set; } = Substitute.For<IDbTransaction>();
        public IDbTransaction? ActiveTransaction
        {
            get; set;
        }
        public ArticleService Owner
        {
            get;
        }
        public HttpContextAccessor Context { get; } = new() { HttpContext = new DefaultHttpContext() };
        public List<string> Events { get; } = [];
        public List<DataTableReader> Readers { get; } = [];
        public List<int> CoordinateLimits { get; } = [];
        public int[] Ids { get; set; } = [7];
        public Action? AfterBegin
        {
            get; set;
        }
        public Action? AfterReadOnly
        {
            get; set;
        }
        public Action? BeforeReader
        {
            get; set;
        }
        public Action? BeforeRollback
        {
            get; set;
        }
        public bool BlockReader
        {
            get; set;
        }
        public bool ReaderWaitFinished
        {
            get; private set;
        }
        public bool PermissionRevoked
        {
            get; set;
        }
        public int PermissionReads
        {
            get; private set;
        }
        public TaskCompletionSource ReleaseReader { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource ReaderWaitStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public CancellationToken PreviousCancellation { get; } = new(true);

        public Fixture(IDbConcurrencyGate? gate = null)
        {
            OriginalDb.Ado.Returns(OriginalAdo);
            SnapshotDb.Ado.Returns(SnapshotAdo);
            OriginalAdo.Transaction.Returns((IDbTransaction?)null);
            OriginalDb.CurrentConnectionConfig.Returns(new ConnectionConfig { DbType = SqlSugar.DbType.PostgreSQL });
            SnapshotDb.CurrentConnectionConfig.Returns(new ConnectionConfig { DbType = SqlSugar.DbType.PostgreSQL });
            OriginalAdo.Connection.Returns(OriginalConnection);
            SnapshotAdo.Connection.Returns(SnapshotConnection);
            Transaction.Connection.Returns(SnapshotConnection);
            Transaction.IsolationLevel.Returns(IsolationLevel.RepeatableRead);
            SnapshotAdo.Transaction.Returns(_ => ActiveTransaction);
            SnapshotAdo.CancellationToken = PreviousCancellation;
            SnapshotAdo.BeginTranAsync(Arg.Any<IsolationLevel>()).Returns(call =>
            {
                Assert.Equal(IsolationLevel.RepeatableRead, call.ArgAt<IsolationLevel>(0));
                Events.Add("begin");
                Transaction = Substitute.For<IDbTransaction>();
                Transaction.Connection.Returns(SnapshotConnection);
                Transaction.IsolationLevel.Returns(IsolationLevel.RepeatableRead);
                ActiveTransaction = Transaction;
                AfterBegin?.Invoke();
                return Task.CompletedTask;
            });
            SnapshotAdo.ExecuteCommandAsync(Arg.Any<string>()).Returns(call =>
            {
                Assert.Equal("SET TRANSACTION READ ONLY;", call.ArgAt<string>(0));
                Events.Add("read-only");
                AfterReadOnly?.Invoke();
                return Task.FromResult(0);
            });
            SnapshotAdo.RollbackTranAsync().Returns(_ =>
            {
                Assert.Null(SnapshotAdo.CancellationToken);
                Events.Add("rollback");
                BeforeRollback?.Invoke();
                ActiveTransaction = null;
                return Task.CompletedTask;
            });
            SnapshotAdo.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(async call =>
            {
                Events.Add("read");
                BeforeReader?.Invoke();
                if (BlockReader)
                {
                    ReaderWaitStarted.SetResult();
                    try
                    {
                        await ReleaseReader.Task.WaitAsync(SnapshotAdo.CancellationToken!.Value);
                    }
                    finally
                    {
                        ReaderWaitFinished = true;
                    }
                }
                string sql = call.ArgAt<string>(0);
                SugarParameter[] parameters = call.ArgAt<SugarParameter[]>(1);
                bool fields = sql.Contains("SELECT a.id", StringComparison.Ordinal);
                int[] ids = parameters.FirstOrDefault(static p => p.ParameterName == "@ArticleIds")?.Value as int[] ?? Ids;
                int position = parameters.FirstOrDefault(static p => p.ParameterName == "@AfterArticleId")?.Value as int? ?? 0;
                int limit = parameters.FirstOrDefault(static p => p.ParameterName == "@Limit")?.Value as int? ?? 1001;
                if (!fields)
                    CoordinateLimits.Add(limit);
                DataTable rows = SourceRows(fields);
                foreach (int id in Ids.Where(id => id > position && ids.Contains(id)).Take(limit))
                {
                    object[] values = [id, (long)id + 100, $"row-{id}", 0];
                    if (fields)
                        values = [.. values, $"title-{id}", "category", new[] { "tag" }];
                    rows.Rows.Add(values);
                }
                DataTableReader reader = rows.CreateDataReader();
                Readers.Add(reader);
                return (IDataReader)reader;
            });
            OriginalAdo.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(call =>
            {
                Assert.Contains("FROM admin_principal", call.ArgAt<string>(0));
                Assert.Null(OriginalAdo.Transaction);
                PermissionReads++;
                DataTable rows = PermissionRows();
                DataTableReader reader = rows.CreateDataReader();
                Readers.Add(reader);
                return Task.FromResult((IDataReader)reader);
            });
            Context.HttpContext!.User = new ClaimsPrincipal(new ClaimsIdentity(new[]
            {
                new Claim("identity_kind", "admin_principal"), new Claim("admin_id", "7"), new Claim("admin_sid", "session-a"),
                new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
            }, "test"));
            Owner = new ArticleService(OriginalDb, Substitute.For<ISearchIndexService>(), Substitute.For<IRedisOperationExecutor>(),
                Substitute.For<ICacheTypedReader>(), Substitute.For<ICacheRawWriter>(), Substitute.For<ICacheStringReader>(),
                Substitute.For<ICacheStringWriter>(), Substitute.For<ICacheMissCoordinator>(), gate ?? new ImmediateDbConcurrencyGate(),
                Substitute.For<IRuntimeKeyScope>(), Context, NullLogger<ArticleService>.Instance,
                Substitute.For<IPublicAotInvalidationService>(), Substitute.For<ICacheInvalidationDispatcher>(),
                Substitute.For<IArticlePublicMutationFence>(), Substitute.For<IArticleMutationSideEffectCoordinator>(),
                Substitute.For<IArticleViewWriteBuffer>(), ArticlePublicationValidatorTestFactory.CreateAllowing(), new ArticleBodyRepairQueue());
        }

        public Task<TResult> ReadAsync<TResult>(Func<IAuthorArticleQuerySourceReader, CancellationToken, Task<TResult>> read,
            CancellationToken cancellationToken = default)
            => Owner.ReadQuerySnapshotCoreAsync(SnapshotDb, read, cancellationToken);

        public async Task AssertCleanAsync(int rollbacks = 1)
        {
            Assert.Null(ActiveTransaction);
            Assert.Equal(PreviousCancellation, SnapshotAdo.CancellationToken);
            Assert.Equal(rollbacks, Events.Count(static value => value == "rollback"));
            Assert.All(Readers, static reader => Assert.True(reader.IsClosed));
            await SnapshotAdo.DidNotReceive().CommitTranAsync();
            await OriginalAdo.DidNotReceive().RollbackTranAsync();
        }

        private static DataTable SourceRows(bool fields)
        {
            var rows = new DataTable();
            rows.Columns.Add("id", typeof(int));
            rows.Columns.Add("current_revision_id", typeof(long));
            rows.Columns.Add("row_version", typeof(string));
            rows.Columns.Add("status", typeof(int));
            if (fields)
            {
                rows.Columns.Add("title", typeof(string));
                rows.Columns.Add("category", typeof(string));
                rows.Columns.Add("tags", typeof(string[]));
            }
            return rows;
        }

        private DataTable PermissionRows()
        {
            var rows = new DataTable();
            rows.Columns.Add("principal_status", typeof(string));
            rows.Columns.Add("isroot", typeof(bool));
            rows.Columns.Add("permissions", typeof(string));
            rows.Columns.Add("principal_row_version", typeof(string));
            rows.Columns.Add("revokedatutc", typeof(DateTime));
            rows.Columns.Add("idleexpiresatutc", typeof(DateTime));
            rows.Columns.Add("absoluteexpiresatutc", typeof(DateTime));
            rows.Columns.Add("session_row_version", typeof(string));
            DateTime now = new FixedClock().GetUtcNow().UtcDateTime;
            rows.Rows.Add(AdminPrincipalStatus.Active, false, AdminPermissions.ArticleWrite, "principal-1",
                PermissionRevoked ? now : DBNull.Value, now.AddHours(1), now.AddHours(2), "session-1");
            return rows;
        }
    }
}
