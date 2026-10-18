using System.Collections;
using System.Data;
using System.Runtime.CompilerServices;
using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Services.DocumentExport.Sources;

using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportSourceCatalogTests
{
    private static readonly DocumentExportJobActor s_actor = new(7, "https://example.test", "catalog-session");

    [Fact]
    public async Task InvalidOriginalCoordinates_RefuseBeforeAnySourceRead()
    {
        var (catalog, db, authoring) = CreateCatalog();
        DocumentExportSourceRequest[] invalid =
        [
            new(DocumentExportCoordinateKind.Draft, 0, "owned"),
            new(DocumentExportCoordinateKind.Draft, 1, " owned "),
            new(DocumentExportCoordinateKind.Draft, 1, "owned", RevisionId: 9),
            new(DocumentExportCoordinateKind.Revision, 1, RevisionId: 0),
            new(DocumentExportCoordinateKind.Publication, 1, RevisionId: 9),
            new((DocumentExportCoordinateKind)99, 1)
        ];
        foreach (DocumentExportSourceRequest request in invalid)
        {
            await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.CaptureAsync(s_actor, [request]));
        }
        Assert.Empty(authoring.ReceivedCalls());
        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task WrongSession_RefusesBeforeAnySourceRead()
    {
        var (catalog, db, authoring) = CreateCatalog();
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() =>
            catalog.CaptureAsync(s_actor with
            {
                SessionId = "other"
            }, [new(DocumentExportCoordinateKind.Draft, 1, "owned")]));
        Assert.Empty(authoring.ReceivedCalls());
        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task WrongConfiguredSite_RefusesBeforeAnySourceRead()
    {
        var (catalog, db, authoring) = CreateCatalog();
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() =>
            catalog.CaptureAsync(s_actor with
            {
                SiteScope = "primary"
            }, [new(DocumentExportCoordinateKind.Revision, 1, RevisionId: 9)]));
        Assert.Empty(authoring.ReceivedCalls());
        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task InvalidChoiceOrVersion_RefusesBeforeAnyBindingRead()
    {
        var (catalog, db, authoring) = CreateCatalog();
        var coordinate = new DocumentExportArticleCoordinate(DocumentExportCoordinateKind.Revision, 1, null, 9, null, 1);
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.ReadBoundAsync(s_actor, "revision-9", coordinate));
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() =>
            catalog.ReadBoundAsync(s_actor, new string('a', 64), coordinate with
            {
                SourceVersion = 0
            }));
        Assert.Empty(authoring.ReceivedCalls());
        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task CancelledRequest_RefusesBeforeAnySourceRead()
    {
        var (catalog, db, authoring) = CreateCatalog();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            catalog.CaptureAsync(s_actor, [new(DocumentExportCoordinateKind.Revision, 1, RevisionId: 9)], cancellation.Token));
        Assert.Empty(authoring.ReceivedCalls());
        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task DuplicateOrOversizeChoiceLists_RefuseBeforeAnySourceRead()
    {
        var (catalog, db, authoring) = CreateCatalog();
        var request = new DocumentExportSourceRequest(DocumentExportCoordinateKind.Revision, 1, RevisionId: 9);
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.CaptureAsync(s_actor, [request, request]));
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() =>
            catalog.CaptureAsync(s_actor, Enumerable.Range(1, 51)
                .Select(id => request with { RevisionId = id }).ToArray()));
        Assert.Empty(authoring.ReceivedCalls());
        Assert.Empty(db.ReceivedCalls());
    }

    [Theory]
    [InlineData("capture", false)]
    [InlineData("capture", true)]
    [InlineData("commit", false)]
    [InlineData("commit", true)]
    public async Task TransactionDoubleFailure_PreservesPrimaryOriginAndSafeCleanupDiagnostic(string phase, bool cancelAfterFailure)
    {
        using var previous = new CancellationTokenSource();
        using var caller = new CancellationTokenSource();
        previous.Cancel();
        var (store, ado) = CreateTransactionStore(previous.Token);
        var primary = new InvalidOperationException("synthetic-primary-failure");
        var rollbackFailure = new InvalidOperationException("synthetic-private-rollback-detail");
        IDbTransaction transaction = Substitute.For<IDbTransaction>();
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            ado.Transaction.Returns(transaction);
            try
            {
                await call.Arg<Func<Task>>()();
                ThrowTransactionFailure(primary);
            }
            catch (Exception failure)
            {
                if (cancelAfterFailure)
                {
                    caller.Cancel();
                }
                if (phase == "capture")
                {
                    throw;
                }
                return new DbResult<bool> { IsSuccess = false, ErrorException = failure };
            }
            return new DbResult<bool> { IsSuccess = true };
        });
        ado.RollbackTranAsync().Returns(_ =>
        {
            Assert.Null(ado.CancellationToken);
            return Task.FromException(rollbackFailure);
        });
        int captures = 0;

        Exception actual = await Assert.ThrowsAsync<InvalidOperationException>(() => store.InTransactionAsync(() =>
        {
            captures++;
            Assert.Equal(caller.Token, ado.CancellationToken);
            if (phase == "capture")
            {
                ThrowTransactionFailure(primary);
            }
            return Task.CompletedTask;
        }, caller.Token));

        Assert.Same(primary, actual);
        Assert.Contains(nameof(ThrowTransactionFailure), actual.StackTrace!, StringComparison.Ordinal);
        Assert.Equal("document_export_source_rollback_failed", actual.Data["DocumentExportSourceRollbackFailure"]);
        Assert.Single(actual.Data);
        Assert.DoesNotContain(rollbackFailure.Message, actual.ToString(), StringComparison.Ordinal);
        Assert.Equal(previous.Token, ado.CancellationToken);
        Assert.Equal(1, captures);
        await ado.Received(1).UseTranAsync(Arg.Any<Func<Task>>());
        await ado.Received(1).RollbackTranAsync();
        await ado.DidNotReceive().CommitTranAsync();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TransactionCancellation_PreservesCancellationAndRestoresBorrowedToken(bool rollbackFails)
    {
        using var previous = new CancellationTokenSource();
        using var caller = new CancellationTokenSource();
        var (store, ado) = CreateTransactionStore(previous.Token);
        var primary = new OperationCanceledException("synthetic-capture-cancelled", caller.Token);
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            ado.Transaction.Returns(Substitute.For<IDbTransaction>());
            await call.Arg<Func<Task>>()();
            return new DbResult<bool> { IsSuccess = true };
        });
        ado.RollbackTranAsync().Returns(_ =>
        {
            Assert.Null(ado.CancellationToken);
            return rollbackFails
                ? Task.FromException(new InvalidOperationException("synthetic-private-rollback-detail"))
                : Task.CompletedTask;
        });

        OperationCanceledException actual = await Assert.ThrowsAsync<OperationCanceledException>(() =>
            store.InTransactionAsync(() =>
            {
                caller.Cancel();
                ThrowTransactionFailure(primary);
                return Task.CompletedTask;
            }, caller.Token));

        Assert.Same(primary, actual);
        Assert.Equal(caller.Token, actual.CancellationToken);
        Assert.Contains(nameof(ThrowTransactionFailure), actual.StackTrace!, StringComparison.Ordinal);
        Assert.Equal(rollbackFails ? "document_export_source_rollback_failed" : null,
            actual.Data["DocumentExportSourceRollbackFailure"]);
        Assert.Equal(previous.Token, ado.CancellationToken);
        await ado.Received(1).UseTranAsync(Arg.Any<Func<Task>>());
        await ado.Received(1).RollbackTranAsync();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TransactionSuccess_RestoresNullOrCancelledBorrowedTokenWithoutCleanup(bool hasPreviousToken)
    {
        using var previous = new CancellationTokenSource();
        using var caller = new CancellationTokenSource();
        previous.Cancel();
        CancellationToken? borrowed = hasPreviousToken ? previous.Token : null;
        var (store, ado) = CreateTransactionStore(borrowed);
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            await call.Arg<Func<Task>>()();
            return new DbResult<bool> { IsSuccess = true };
        });
        int captures = 0;

        await store.InTransactionAsync(() =>
        {
            captures++;
            Assert.Equal(caller.Token, ado.CancellationToken);
            return Task.CompletedTask;
        }, caller.Token);

        Assert.Equal(1, captures);
        Assert.Equal(borrowed, ado.CancellationToken);
        await ado.Received(1).UseTranAsync(Arg.Any<Func<Task>>());
        await ado.DidNotReceive().RollbackTranAsync();
        await ado.DidNotReceive().CommitTranAsync();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TransactionAlreadySettledFailure_DoesNotRollBackAgain(bool resultFailure)
    {
        using var previous = new CancellationTokenSource();
        var (store, ado) = CreateTransactionStore(previous.Token);
        var primary = new InvalidOperationException("synthetic-settled-failure");
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            try
            {
                await call.Arg<Func<Task>>()();
            }
            catch (Exception failure) when (resultFailure)
            {
                return new DbResult<bool> { IsSuccess = false, ErrorException = failure };
            }
            return new DbResult<bool> { IsSuccess = true };
        });

        Exception actual = await Assert.ThrowsAsync<InvalidOperationException>(() => store.InTransactionAsync(() =>
        {
            ThrowTransactionFailure(primary);
            return Task.CompletedTask;
        }, default));

        Assert.Same(primary, actual);
        Assert.Contains(nameof(ThrowTransactionFailure), actual.StackTrace!, StringComparison.Ordinal);
        Assert.Empty(actual.Data);
        Assert.Equal(previous.Token, ado.CancellationToken);
        await ado.Received(1).UseTranAsync(Arg.Any<Func<Task>>());
        await ado.DidNotReceive().RollbackTranAsync();
    }

    [Fact]
    public async Task TransactionDiagnosticFailure_CannotReplacePrimaryOrPreventTokenRestoration()
    {
        using var previous = new CancellationTokenSource();
        var (store, ado) = CreateTransactionStore(previous.Token);
        var primary = new UnavailableDiagnosticException();
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            ado.Transaction.Returns(Substitute.For<IDbTransaction>());
            await call.Arg<Func<Task>>()();
            return new DbResult<bool> { IsSuccess = true };
        });
        ado.RollbackTranAsync().Returns(Task.FromException(new InvalidOperationException("synthetic-rollback-failure")));

        Exception actual = await Assert.ThrowsAsync<UnavailableDiagnosticException>(() => store.InTransactionAsync(() =>
        {
            ThrowTransactionFailure(primary);
            return Task.CompletedTask;
        }, default));

        Assert.Same(primary, actual);
        Assert.Contains(nameof(ThrowTransactionFailure), actual.StackTrace!, StringComparison.Ordinal);
        Assert.Equal(previous.Token, ado.CancellationToken);
        await ado.Received(1).RollbackTranAsync();
    }

    [Fact]
    public async Task TransactionCancelledBeforeAdmission_DoesNotBorrowTokenOrStartTransaction()
    {
        using var caller = new CancellationTokenSource();
        caller.Cancel();
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        var store = new DocumentExportSourceCatalogStore(db);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => store.InTransactionAsync(
            () => throw new InvalidOperationException("capture-must-not-run"), caller.Token));

        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task TransactionOwnedElsewhere_DoesNotBorrowTokenOrStartTransaction()
    {
        using var previous = new CancellationTokenSource();
        var (store, ado) = CreateTransactionStore(previous.Token);
        ado.Transaction.Returns(Substitute.For<IDbTransaction>());

        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            store.InTransactionAsync(() => throw new InvalidOperationException("capture-must-not-run"), default));

        Assert.Equal("document_export_source_transaction_owned_elsewhere", actual.Message);
        Assert.Equal(previous.Token, ado.CancellationToken);
        await ado.DidNotReceive().UseTranAsync(Arg.Any<Func<Task>>());
        await ado.DidNotReceive().RollbackTranAsync();
    }

    private static (DocumentExportSourceCatalogStore Store, IAdo Ado) CreateTransactionStore(CancellationToken? previous)
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAdo ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.Transaction.Returns((IDbTransaction?)null);
        ado.CancellationToken = previous;
        return (new DocumentExportSourceCatalogStore(db), ado);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ThrowTransactionFailure(Exception failure) => throw failure;

    private sealed class UnavailableDiagnosticException : Exception
    {
        public override IDictionary Data => throw new InvalidOperationException("synthetic-diagnostic-unavailable");
    }

    private static (DocumentExportSourceCatalog Catalog, ISqlSugarClient Db, IAuthoringDraftLifecycle Authoring) CreateCatalog()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAuthoringDraftLifecycle authoring = Substitute.For<IAuthoringDraftLifecycle>();
        var accessor = new HttpContextAccessor
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                [
                    new Claim("identity_kind", "admin_principal"),
                    new Claim("admin_id", "7"),
                    new Claim("admin_sid", s_actor.SessionId),
                    new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
                ], "test"))
            }
        };
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SITE_BASEURL"] = "https://example.test/"
        }).Build();
        var authority = new SqlAuthorRecentArticleHistoryPermissionAuthority(db, accessor, configuration, TimeProvider.System);
        return (new(db, authoring, authority, accessor, configuration, new(db)), db, authoring);
    }
}
