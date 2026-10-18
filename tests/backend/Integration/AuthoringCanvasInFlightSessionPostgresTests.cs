using System.Data;
using System.Data.Common;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthoringCanvasInFlightSessionPostgresTests(PostgresSchemaMigrationFixture fixture) : IDisposable
{
    private readonly AuthoringCanvasAuthenticatedTestScope _ambient = new();

    public void Dispose() => _ambient.Dispose();

    private static readonly AuthoringCanvasOwner s_owner = new(73, "primary-site");

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task OriginalProvider_CancelsPendingCommandAndRestoresBorrowedState(
        bool metadataRead,
        bool cancelBorrowedToken)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient blocker = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using var caller = new CancellationTokenSource();
        using var borrowed = new CancellationTokenSource();
        await db.Ado.BeginTranAsync();
        int processId = await db.Ado.GetIntAsync("SELECT pg_backend_pid();");
        IDbTransaction transaction = db.Ado.Transaction;
        db.Ado.CancellationToken = borrowed.Token;
        await blocker.Ado.BeginTranAsync();
        await blocker.Ado.ExecuteCommandAsync(metadataRead
            ? "LOCK TABLE article IN ACCESS EXCLUSIVE MODE;"
            : "LOCK TABLE admin_principal IN ACCESS EXCLUSIVE MODE;");
        var reader = new PostgresAuthoringCanvasArticleReferenceReader(db);
        Task reading = metadataRead
            ? reader.ReadBatchAsync(s_owner, AuthoringCanvasReferencePermission.ArticleRead,
                [new AuthoringCanvasReferenceTarget(Guid.CreateVersion7(), AuthoringCanvasNodeType.ArticleReference,
                    204, null, null, null, null)], caller.Token)
            : reader.ReadAuthorityAsync(s_owner, AuthoringCanvasReferencePermission.ArticleRead, caller.Token);
        try
        {
            await WaitForServerLockAsync(blocker, processId);
            Assert.False(reading.IsCompleted);
            (cancelBorrowedToken ? borrowed : caller).Cancel();
            Task completed = await Task.WhenAny(reading, Task.Delay(TimeSpan.FromSeconds(10)));
            Assert.Same(reading, completed);
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reading);
            Assert.Equal(borrowed.Token, db.Ado.CancellationToken);
            Assert.Same(transaction, db.Ado.Transaction);
        }
        finally
        {
            await blocker.Ado.RollbackTranAsync();
            await DrainAsync(reading);
            db.Ado.CancellationToken = null;
            await db.Ado.RollbackTranAsync();
        }

        Assert.True((await reader.ReadAuthorityAsync(s_owner,
            AuthoringCanvasReferencePermission.ArticleRead)).Authorized);
    }

    [Theory]
    [InlineData(false, false, "revoke")]
    [InlineData(false, true, "revoke")]
    [InlineData(true, false, "revoke")]
    [InlineData(true, true, "revoke")]
    [InlineData(false, false, "version")]
    [InlineData(true, true, "version")]
    [InlineData(false, false, "token")]
    [InlineData(true, true, "token")]
    [InlineData(false, false, "expiry")]
    [InlineData(true, false, "expiry")]
    [InlineData(false, false, "token-expiry")]
    [InlineData(true, false, "token-expiry")]
    public async Task RevokingOnlyAWhileOriginalReadIsPending_RejectsAPublicationAndPreservesB(
        bool warmCache,
        bool deliverProjectionUpdate,
        string change)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient authorityDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using SqlSugarClient otherRequestDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AdminSession));
        TimeProvider clock = TimeProvider.System;
        DateTime now = clock.GetUtcNow().UtcDateTime;
        const string SessionA = "canvas-inflight-session-a";
        const string SessionB = "canvas-inflight-session-b";
        const string TokenA = "canvas-inflight-token-a";
        const string TokenB = "canvas-inflight-token-b";
        await db.Insertable(new[]
        {
            Session(SessionA, TokenA, now),
            Session(SessionB, TokenB, now)
        }).ExecuteCommandAsync();
        AdminSessionProjectionRuntimeOptions options = AdminSessionProjectionRuntimeOptions.FromConfiguration(
            new ConfigurationBuilder().Build());
        var projection = new AdminSessionProjection(options.ProjectionLimits, clock);
        var authority = new AdminSessionProjectionAuthorityReader(authorityDb, projection, options, clock);
        Assert.True(projection.MarkReady(await authority.LoadColdStartAsync()));
        using ServiceProvider services = new ServiceCollection().BuildServiceProvider();
        using var touches = new AdminSessionTouchScheduler(services.GetRequiredService<IServiceScopeFactory>(),
            options, clock, NullLogger<AdminSessionTouchScheduler>.Instance);
        var admission = new AdminSessionValidationService(projection, touches);
        ClaimsPrincipal principalA = Principal(SessionA);
        ClaimsPrincipal principalB = Principal(SessionB);
        AdminSessionValidationResult admittedA = await admission.ValidateAsync(principalA, TokenA, CancellationToken.None);
        AdminSessionValidationResult admittedB = await admission.ValidateAsync(principalB, TokenB, CancellationToken.None);
        Assert.True(admittedA.IsValid);
        Assert.True(admittedB.IsValid);
        using AdminAuthenticatedRequestLifetime lifetimeA = Assert.IsType<AdminAuthenticatedRequestLifetime>(admittedA.RequestLifetime);
        using AdminAuthenticatedRequestLifetime lifetimeB = Assert.IsType<AdminAuthenticatedRequestLifetime>(admittedB.RequestLifetime);
        var contextA = new DefaultHttpContext { User = principalA };
        var contextB = new DefaultHttpContext { User = principalB };
        lifetimeA.BindRequest(contextA.RequestAborted);
        lifetimeB.BindRequest(contextB.RequestAborted);
        contextA.Features.Set<IAdminAuthenticatedRequestFeature>(new AdminAuthenticatedRequestFeature(lifetimeA));
        contextB.Features.Set<IAdminAuthenticatedRequestFeature>(new AdminAuthenticatedRequestFeature(lifetimeB));
        var accessorA = new RequestContextAccessor { HttpContext = contextA };
        var accessorB = new RequestContextAccessor { HttpContext = contextB };
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db);
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolver resolver = Resolver(db, cache, accessorA);
        if (warmCache)
        {
            Assert.Equal("Private summary", Assert.Single((await resolver.ResolveAsync(request)).Projections).ContextSnippet);
        }
        int entriesBeforeRead = cache.EntryCount;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int authorityReads = 0;
        db.Aop.OnLogExecuted = (sql, _) =>
        {
            bool pause = warmCache
                ? sql.Contains("WITH principal AS", StringComparison.Ordinal)
                    && Interlocked.Increment(ref authorityReads) == 1
                : sql.Contains("SELECT id, title, summary, status, isdeleted, current_revision_id", StringComparison.Ordinal);
            if (pause)
            {
                entered.TrySetResult();
                released.Task.WaitAsync(TimeSpan.FromSeconds(30)).GetAwaiter().GetResult();
            }
        };
        // Both requests borrow registrations issued by the actual frozen auth producer.
        Task<AuthoringCanvasReferenceResolutionBatch> pending = Task.Run(() => resolver.ResolveAsync(request));
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(30));
            Assert.False(pending.IsCompleted);
            if (change == "token-expiry")
            {
                var expired = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                using CancellationTokenRegistration registration = lifetimeA.Invalidated.Register(() => expired.TrySetResult());
                lifetimeA.RestrictToTokenExpiry(DateTimeOffset.UtcNow.AddMilliseconds(20));
                await expired.Task.WaitAsync(TimeSpan.FromSeconds(10));
            }
            else
            {
                string mutation = change switch
                {
                    "revoke" => "UPDATE admin_session SET revokedatutc = @Now, validationversion = 2 WHERE sessionid = @Session;",
                    "version" => "UPDATE admin_session SET validationversion = 2 WHERE sessionid = @Session;",
                    "token" => "UPDATE admin_session SET accesstokenhash = repeat('AB', 32), validationversion = 2 WHERE sessionid = @Session;",
                    "expiry" => "UPDATE admin_session SET idleexpiresatutc = @Now WHERE sessionid = @Session;",
                    _ => throw new ArgumentOutOfRangeException(nameof(change))
                };
                Assert.Equal(1, await writer.Ado.ExecuteCommandAsync(mutation,
                    new SugarParameter("@Now", now), new SugarParameter("@Session", SessionA)));
            }
            if (deliverProjectionUpdate)
            {
                AdminSessionProjectionSessionUpdate? update = await authority.ReadSessionAsync(SessionA);
                Assert.True(update.HasValue);
                DistributedInvalidationEvent invalidation = DistributedInvalidationEvent.Create(
                    Guid.CreateVersion7().ToString("N"),
                    DistributedInvalidationEventKinds.AdminSessionProjectionMutation,
                    "canvas-inflight-writer",
                    "canvas-inflight-test",
                    [],
                    [],
                    [AdminSessionProjectionEventCodec.Format(update.Value)],
                    Guid.CreateVersion7().ToString("N"),
                    clock);
                var applier = new DistributedInvalidationLocalApplier(
                    null!, null!, null!, null!, null!, null!, null!, null!,
                    NullLogger<DistributedInvalidationLocalApplier>.Instance,
                    adminSessionProjection: projection);
                Assert.NotNull(await applier.ApplyAsync(invalidation));
            }
            Assert.Equal(!deliverProjectionUpdate || change is not ("revoke" or "token"),
                await AdmissionValidAsync(admission, principalA, TokenA));
            Assert.True(await AdmissionValidAsync(admission, principalB, TokenB));
            released.TrySetResult();
            Exception? failure = await Record.ExceptionAsync(async () => await pending.WaitAsync(TimeSpan.FromSeconds(30)));
            Assert.True(failure is OperationCanceledException or AuthoringCanvasAccessDeniedException,
                $"Revoked session A published a result or failed outside authorization: {failure?.GetType().Name ?? "success"}.");
            Assert.Equal(entriesBeforeRead, cache.EntryCount);
            AuthoringCanvasReferenceResolutionBatch acceptedB = await Resolver(otherRequestDb, cache, accessorB)
                .ResolveAsync(request with
                {
                    RequestId = Guid.CreateVersion7()
                });
            Assert.Equal("Private summary", Assert.Single(acceptedB.Projections).ContextSnippet);
            Assert.True(await AdmissionValidAsync(admission, principalB, TokenB));
        }
        finally
        {
            released.TrySetResult();
            await DrainAsync(pending);
            db.Aop.OnLogExecuted = null;
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OriginalCanvasTransaction_FencesRemoteRevocationAndPreservesSameRequestEffects(bool revokeDuringCommit)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using SqlSugarClient blocker = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        foreach (SchemaMigrationStep step in AuthoringCanvasOperationJournalMigrationDefinitions.BuildMigration().Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        await AuthoringCanvasAuthenticatedTestScope.AttachAsync(db, s_owner.AdminPrincipalId);
        HttpContext context = new HttpContextAccessor().HttpContext!;
        AdminAuthenticatedRequestLifetime lifetimeA = context.Features.Get<IAdminAuthenticatedRequestFeature>()!.Lifetime;
        string sessionA = lifetimeA.RequireBinding().SessionId;
        var scope = new AuthoringCanvasRequestLifetime(db);
        var store = new AuthoringCanvasDocumentStore(db, TimeProvider.System);
        var transaction = new PostgresAuthoringCanvasOperationTransaction(db, store, TimeProvider.System, scope);
        var resolver = Resolver(db, new AuthoringCanvasReferenceProjectionCache(), new RequestContextAccessor { HttpContext = context });
        var engine = new AuthoringCanvasOperationEngine(store, transaction,
            new AuthoringCanvasOperationReferenceValidator(resolver, scope), scope);
        Guid canvasId = Guid.CreateVersion7();
        AuthoringCanvasWriteReceipt created = await store.CreateAsync(new CreateAuthoringCanvasCommand(canvasId,
            s_owner, "Commit fence fixture", new AuthoringCanvasViewport(0, 0, 1), Guid.CreateVersion7()));
        var before = new AuthoringCanvasNode(Guid.CreateVersion7(), AuthoringCanvasNodeType.PlainTextNote, 0,
            new AuthoringCanvasGeometry(0, 0, 100, 100), NoteSource: "before");
        AuthoringCanvasWriteReceipt saved = await store.PutNodeAsync(new PutAuthoringCanvasNodeCommand(canvasId,
            s_owner, created.Revision, Guid.CreateVersion7(), before));
        AuthoringCanvasHistoryWindow history = await transaction.ReadHistoryAsync(s_owner, canvasId);
        AuthoringCanvasClosedCommand command = AuthoringCanvasOperationContract.SealCommand(Guid.CreateVersion7(),
            AuthoringCanvasOperationKind.EditNote, [AuthoringCanvasOperationContract.Present(before)],
            [AuthoringCanvasOperationContract.Present(before with { NoteSource = "after" })]);
        var request = new AuthoringCanvasOperationRequest(Guid.CreateVersion7(), canvasId, s_owner,
            812, saved.Revision, saved.ContentDigest, history.HistoryDigest, [command]);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        db.CurrentConnectionConfig.IsAutoCloseConnection = false;
        await db.Ado.OpenAsync();
        int canvasProcess = await db.Ado.GetIntAsync("SELECT pg_backend_pid();");
        if (revokeDuringCommit)
        {
            await db.Ado.ExecuteCommandAsync(
                """
                CREATE FUNCTION hold_canvas_session_commit() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    PERFORM pg_advisory_xact_lock(7348301);
                    RETURN NEW;
                END;
                $$;
                CREATE CONSTRAINT TRIGGER hold_canvas_session_commit
                    AFTER INSERT ON authoring_canvas_operation_receipt
                    DEFERRABLE INITIALLY DEFERRED
                    FOR EACH ROW EXECUTE FUNCTION hold_canvas_session_commit();
                """);
            await blocker.Ado.BeginTranAsync();
            await blocker.Ado.ExecuteCommandAsync("SELECT pg_advisory_xact_lock(7348301);");
        }
        else
        {
            db.Aop.OnLogExecuted = (sql, _) =>
            {
                if (sql.Contains("INSERT INTO authoring_canvas_operation_receipt", StringComparison.Ordinal))
                {
                    entered.TrySetResult();
                    released.Task.WaitAsync(TimeSpan.FromSeconds(30)).GetAwaiter().GetResult();
                }
            };
        }
        Task<AuthoringCanvasOperationReceipt> pending = Task.Run(() => engine.ApplyAsync(request));
        Task<int>? revoking = null;
        try
        {
            if (revokeDuringCommit)
            {
                await WaitForServerLockAsync(observer, canvasProcess);
                Assert.Contains("COMMIT", await observer.Ado.GetStringAsync(
                    "SELECT query FROM pg_stat_activity WHERE pid = @Process;",
                    new SugarParameter("@Process", canvasProcess)), StringComparison.OrdinalIgnoreCase);
                await writer.Ado.BeginTranAsync();
                int writerProcess = await writer.Ado.GetIntAsync("SELECT pg_backend_pid();");
                revoking = RevokeAsync(writer, sessionA);
                await WaitForServerLockAsync(observer, writerProcess);
                Assert.False(revoking.IsCompleted);
                Assert.False(pending.IsCompleted);
                await blocker.Ado.RollbackTranAsync();
                Assert.Equal(1, await revoking);
                await writer.Ado.CommitTranAsync();
            }
            else
            {
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(30));
                Assert.Equal(1, await RevokeAsync(writer, sessionA));
                Assert.False(pending.IsCompleted);
                released.TrySetResult();
            }
            // No projection delivery occurs: the final original SQL fence must detect this.
            Assert.True(lifetimeA.IsCurrent);
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            int expectedEffects = revokeDuringCommit ? 1 : 0;
            Assert.Equal(expectedEffects, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_canvas_operation_journal;"));
            Assert.Equal(expectedEffects, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_canvas_operation_receipt;"));
            Assert.Equal(revokeDuringCommit ? "after" : "before", await observer.Ado.GetStringAsync(
                "SELECT note_source FROM authoring_canvas_node WHERE node_id = @Node;", new SugarParameter("@Node", before.Id)));
            db.Aop.OnLogExecuted = null;
            await AuthoringCanvasAuthenticatedTestScope.AttachAsync(db, s_owner.AdminPrincipalId);
            var scopeB = new AuthoringCanvasRequestLifetime(db);
            var transactionB = new PostgresAuthoringCanvasOperationTransaction(db, store, TimeProvider.System, scopeB);
            var resolverB = Resolver(db, new AuthoringCanvasReferenceProjectionCache(),
                new RequestContextAccessor { HttpContext = context });
            var engineB = new AuthoringCanvasOperationEngine(store, transactionB,
                new AuthoringCanvasOperationReferenceValidator(resolverB, scopeB), scopeB);
            AuthoringCanvasOperationReceipt acceptedB = await engineB.ApplyAsync(request);
            Assert.Equal(revokeDuringCommit ? AuthoringCanvasOperationStatus.IdempotentReplay
                : AuthoringCanvasOperationStatus.Committed, acceptedB.Status);
            Assert.Equal(1, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_canvas_operation_journal;"));
            Assert.Equal(812, await observer.Ado.GetIntAsync("SELECT actor_user_id FROM authoring_canvas_operation_journal;"));
        }
        finally
        {
            released.TrySetResult();
            if (blocker.Ado.Transaction is not null)
            {
                await blocker.Ado.RollbackTranAsync();
            }
            if (revoking is not null)
            {
                await DrainAsync(revoking);
            }
            if (writer.Ado.Transaction is not null)
            {
                await writer.Ado.RollbackTranAsync();
            }
            await DrainAsync(pending);
            db.Aop.OnLogExecuted = null;
        }
    }

    private static Task<int> RevokeAsync(SqlSugarClient db, string sessionId)
        => db.Updateable<AdminSession>()
            .SetColumns(session => new AdminSession { RevokedAtUtc = DateTime.UtcNow, ValidationVersion = 2 })
            .Where(session => session.SessionId == sessionId).ExecuteCommandAsync();

    [Fact]
    public async Task OriginalFactSource_Resolves10000TargetsInOneMetadataBatchUnderHeldAuthority()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await AuthoringCanvasAuthenticatedTestScope.AttachAsync(db, s_owner.AdminPrincipalId);
        var authority = new AuthoringCanvasRequestLifetime(db);
        var source = new AuthoringCanvasReferenceFactSource(new PostgresAuthoringCanvasArticleReferenceReader(db),
            new AuthoringCanvasCoordinateFactProvider([]), authority);
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db);
        AuthoringCanvasReferenceAuthorityCoordinate coordinate = await source.ReadAuthorityCoordinateAsync(
            s_owner, AuthoringCanvasReferencePermission.ArticleRead);
        AuthoringCanvasReferenceTarget[] targets = Enumerable.Range(0, AuthoringCanvasReferenceContract.MaxBatchSize)
            .Select(_ => new AuthoringCanvasReferenceTarget(Guid.CreateVersion7(), AuthoringCanvasNodeType.ArticleReference,
                204, null, null, null, null)).ToArray();
        int metadataReads = 0;
        int authorityReads = 0;
        db.Aop.OnLogExecuted = (sql, _) =>
        {
            if (sql.Contains("SELECT id, title, summary, status, isdeleted, current_revision_id", StringComparison.Ordinal))
            {
                metadataReads++;
            }
            if (sql.Contains("WITH principal AS", StringComparison.Ordinal))
            {
                authorityReads++;
            }
        };
        try
        {
            using AuthoringCanvasRequestLifetime.Borrow held = authority.Acquire(s_owner, CancellationToken.None);
            IReadOnlyList<AuthoringCanvasReferenceFact> facts = await authority.PublishAsync(held, token => source.ReadBatchAsync(
                new AuthoringCanvasReferenceFactQuery(request.CanvasId, request.CanvasRevision, request.CanvasContentDigest,
                    s_owner, AuthoringCanvasReferencePermission.ArticleRead, coordinate, targets), token));
            Assert.Equal(10_000, facts.Count);
            Assert.Equal(1, metadataReads);
            Assert.Equal(2, authorityReads);
            Assert.All(facts, static fact => Assert.Equal("Private summary", fact.ContextSnippet));
            Assert.Equal(targets.Select(static target => target.NodeId), facts.Select(static fact => fact.NodeId));
            held.EnsureCurrent();
        }
        finally
        {
            db.Aop.OnLogExecuted = null;
        }
    }

    [Fact]
    public async Task GenuineFeature_IsRequiredAndValidatorDigestDoesNotDisposeRequestAuthority()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await AuthoringCanvasAuthenticatedTestScope.AttachAsync(db, s_owner.AdminPrincipalId);
        HttpContext context = new HttpContextAccessor().HttpContext!;
        IAdminAuthenticatedRequestFeature original = context.Features.Get<IAdminAuthenticatedRequestFeature>()!;
        var accessor = new RequestContextAccessor { HttpContext = context };
        var authority = new AuthoringCanvasRequestLifetime(db, accessor);
        AuthoringCanvasReferenceResolver resolver = Resolver(db, new AuthoringCanvasReferenceProjectionCache(), accessor);
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db);
        context.Features.Set<IAdminAuthenticatedRequestFeature>(new ForgedFeature(original.Lifetime));
        await Assert.ThrowsAsync<AuthoringCanvasAccessDeniedException>(() => resolver.ResolveAsync(request));
        context.Features.Set(original);
        await Assert.ThrowsAsync<AuthoringCanvasAccessDeniedException>(() => resolver.ResolveAsync(request with
        {
            Owner = new AuthoringCanvasOwner(74, "primary-site")
        }));
        Assert.Equal(s_owner, request.Owner);
        AuthoringCanvasReferenceResolutionBatch batch = await resolver.ResolveAsync(request);
        AuthoringCanvasNode node = Assert.Single(request.Nodes) with
        {
            DisplayProjectionReference = Assert.Single(batch.Projections).DisplayProjectionReference,
            ReferenceState = AuthoringCanvasReferenceState.Current
        };
        string digest = await new AuthoringCanvasOperationReferenceValidator(resolver, authority).ValidateAsync(
            new AuthoringCanvasOperationReferenceValidationRequest(request.RequestId, request.CanvasId,
                request.CanvasRevision, request.CanvasContentDigest, request.Owner, [node]));
        Assert.Equal(64, digest.Length);
        Assert.True(original.Lifetime.IsCurrent);
        Assert.False(original.Lifetime.Invalidated.IsCancellationRequested);
        Assert.True((await resolver.VerifyAsync(request, batch)).Valid);
        Assert.True(original.Lifetime.IsCurrent);
        await AuthoringCanvasAuthenticatedTestScope.AttachAsync(db, s_owner.AdminPrincipalId);
        Assert.True(original.Lifetime.IsCurrent);
        await Assert.ThrowsAsync<AuthoringCanvasAccessDeniedException>(() => resolver.ResolveAsync(request));
        AuthoringCanvasReferenceResolver nextRequest = Resolver(db, new AuthoringCanvasReferenceProjectionCache(), accessor);
        Assert.Equal("Private summary", Assert.Single((await nextRequest.ResolveAsync(request)).Projections).ContextSnippet);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task GenuineRequestAbortOrCallerCancellation_StopsOriginalBlockedCommand(bool requestAbort)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient blocker = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using var cancellation = new CancellationTokenSource();
        HttpContext context = new HttpContextAccessor().HttpContext!;
        if (requestAbort)
        {
            context.RequestAborted = cancellation.Token;
        }
        await AuthoringCanvasAuthenticatedTestScope.AttachAsync(db, s_owner.AdminPrincipalId);
        AdminAuthenticatedRequestLifetime lifetime = context.Features.Get<IAdminAuthenticatedRequestFeature>()!.Lifetime;
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db);
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolver resolver = Resolver(db, cache, new RequestContextAccessor { HttpContext = context });
        db.CurrentConnectionConfig.IsAutoCloseConnection = false;
        await db.Ado.OpenAsync();
        int process = await db.Ado.GetIntAsync("SELECT pg_backend_pid();");
        await blocker.Ado.BeginTranAsync();
        await blocker.Ado.ExecuteCommandAsync("LOCK TABLE article IN ACCESS EXCLUSIVE MODE;");
        CancellationToken? previous = db.Ado.CancellationToken;
        Task<AuthoringCanvasReferenceResolutionBatch> pending = resolver.ResolveAsync(request,
            requestAbort ? CancellationToken.None : cancellation.Token);
        try
        {
            await WaitForServerLockAsync(observer, process);
            cancellation.Cancel();
            Assert.Same(pending, await Task.WhenAny(pending, Task.Delay(TimeSpan.FromSeconds(10))));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            Assert.Equal(previous, db.Ado.CancellationToken);
            Assert.Equal(0, cache.EntryCount);
            Assert.NotNull(blocker.Ado.Transaction);
            Assert.Equal(!requestAbort, lifetime.IsCurrent);
        }
        finally
        {
            await blocker.Ado.RollbackTranAsync();
            await DrainAsync(pending);
        }
    }

    private sealed record ForgedFeature(AdminAuthenticatedRequestLifetime Lifetime) : IAdminAuthenticatedRequestFeature;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SessionRevocation_JoinsOriginalNativeReaderAndCommandDisposalBeforeReturning(bool commandPhase)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await AuthoringCanvasAuthenticatedTestScope.AttachAsync(db, s_owner.AdminPrincipalId);
        HttpContext contextA = new HttpContextAccessor().HttpContext!;
        AdminAuthenticatedRequestLifetime lifetimeA = contextA.Features.Get<IAdminAuthenticatedRequestFeature>()!.Lifetime;
        var projection = (AdminSessionProjection)contextA.Items[typeof(AdminSessionProjection)]!;
        var admission = (AdminSessionValidationService)contextA.Items[typeof(AdminSessionValidationService)]!;
        var options = AdminSessionProjectionRuntimeOptions.FromConfiguration(new ConfigurationBuilder().Build());
        var authority = new AdminSessionProjectionAuthorityReader(writer, projection, options, TimeProvider.System);
        string sessionA = lifetimeA.RequireBinding().SessionId;
        const string SessionB = "disposal-session-b";
        const string TokenB = "disposal-token-b";
        await db.Insertable(Session(SessionB, TokenB, DateTime.UtcNow)).ExecuteCommandAsync();
        Assert.True(await authority.RefreshSessionAsync(SessionB));
        ClaimsPrincipal principalB = Principal(SessionB);
        AdminSessionValidationResult admittedB = await admission.ValidateAsync(principalB, TokenB, CancellationToken.None);
        Assert.True(admittedB.IsValid);
        using AdminAuthenticatedRequestLifetime lifetimeB = Assert.IsType<AdminAuthenticatedRequestLifetime>(admittedB.RequestLifetime);
        var contextB = new DefaultHttpContext { User = principalB };
        lifetimeB.BindRequest(contextB.RequestAborted);
        contextB.Features.Set<IAdminAuthenticatedRequestFeature>(new AdminAuthenticatedRequestFeature(lifetimeB));
        Assert.True(lifetimeA.IsCurrent);
        Assert.True(lifetimeB.IsCurrent);
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db);
        AuthoringCanvasNode block = Assert.Single(request.Nodes) with
        {
            Type = AuthoringCanvasNodeType.BlockReference,
            TargetBlockIdentity = "intro-block"
        };
        AuthoringCanvasWriteReceipt updated = await new AuthoringCanvasDocumentStore(db, TimeProvider.System)
            .PutNodeAsync(new PutAuthoringCanvasNodeCommand(request.CanvasId, s_owner, request.CanvasRevision,
                Guid.CreateVersion7(), block));
        request = request with
        {
            CanvasRevision = updated.Revision,
            CanvasContentDigest = updated.ContentDigest,
            Nodes = [block]
        };
        db.CurrentConnectionConfig.IsAutoCloseConnection = false;
        await db.Ado.OpenAsync();
        var nativeConnection = Assert.IsType<NpgsqlConnection>(db.Ado.Connection);
        CancellationToken? previousToken = db.Ado.CancellationToken;
        using var caller = new CancellationTokenSource();
        var io = new AuthoringCanvasReferenceFactSourceIntegrationTests.NativeIoObservation(caller, -1)
        {
            DelayCommandCleanup = true
        };
        var observed = new AuthoringCanvasReferenceFactSourceIntegrationTests.ObservedConnection(nativeConnection, io);
        db.Aop.OnLogExecuted = (sql, _) =>
        {
            if (sql.Contains("SELECT article.id, article.current_revision_id", StringComparison.Ordinal))
            {
                db.Ado.Connection = observed;
            }
        };
        var cache = new AuthoringCanvasReferenceProjectionCache();
        var scope = new AuthoringCanvasRequestLifetime(db, new RequestContextAccessor { HttpContext = contextA });
        var source = new AuthoringCanvasReferenceFactSource(new PostgresAuthoringCanvasArticleReferenceReader(db),
            new AuthoringCanvasCoordinateFactProvider([new PostgresAuthoringCanvasCoordinateAuthority(db)]), scope);
        var resolver = new AuthoringCanvasReferenceResolver(new AuthoringCanvasDocumentStore(db, TimeProvider.System),
            source, cache, TimeProvider.System, scope);
        Task<AuthoringCanvasReferenceResolutionBatch> pending = Task.Run(() => resolver.ResolveAsync(request, caller.Token));
        try
        {
            await io.CleanupEntered.Task.WaitAsync(TimeSpan.FromSeconds(30));
            if (commandPhase)
            {
                io.CleanupReleased.TrySetResult();
                await io.CommandCleanupEntered.Task.WaitAsync(TimeSpan.FromSeconds(30));
                Assert.True(io.ReaderDisposed);
            }
            else
            {
                Assert.False(io.ReaderDisposed);
            }
            Assert.False(io.CommandDisposed);
            Assert.False(pending.IsCompleted);
            Assert.Equal(1, io.EofCount);
            Assert.Equal(CommandBehavior.SequentialAccess, io.Behavior);
            Assert.Equal(1, await RevokeAsync(writer, sessionA));
            AdminSessionProjectionSessionUpdate update = (await authority.ReadSessionAsync(sessionA))!.Value;
            var invalidation = DistributedInvalidationEvent.Create(Guid.CreateVersion7().ToString("N"),
                DistributedInvalidationEventKinds.AdminSessionProjectionMutation, "disposal-writer", "disposal-test",
                [], [], [AdminSessionProjectionEventCodec.Format(update)], Guid.CreateVersion7().ToString("N"), TimeProvider.System);
            var applier = new DistributedInvalidationLocalApplier(null!, null!, null!, null!, null!, null!, null!, null!,
                NullLogger<DistributedInvalidationLocalApplier>.Instance, adminSessionProjection: projection);
            Assert.NotNull(await applier.ApplyAsync(invalidation));
            Assert.True(io.Token.IsCancellationRequested);
            Assert.False(caller.IsCancellationRequested);
            Assert.False(pending.IsCompleted);
            Assert.True(lifetimeB.IsCurrent);
            io.CleanupReleased.TrySetResult();
            io.CommandCleanupReleased.TrySetResult();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            Assert.True(io.ReaderDisposed);
            Assert.True(io.CommandDisposed);
            Assert.Equal(0, io.ConnectionCloseCount);
            Assert.Equal(0, io.ConnectionDisposeCount);
            Assert.Equal(previousToken, db.Ado.CancellationToken);
            Assert.Null(db.Ado.Transaction);
            Assert.Equal(0, cache.EntryCount);
            db.Ado.Connection = nativeConnection;
            db.Aop.OnLogExecuted = null;
            var scopeB = new AuthoringCanvasRequestLifetime(db, new RequestContextAccessor { HttpContext = contextB });
            var sourceB = new AuthoringCanvasReferenceFactSource(new PostgresAuthoringCanvasArticleReferenceReader(db),
                new AuthoringCanvasCoordinateFactProvider([new PostgresAuthoringCanvasCoordinateAuthority(db)]), scopeB);
            var resolverB = new AuthoringCanvasReferenceResolver(new AuthoringCanvasDocumentStore(db, TimeProvider.System),
                sourceB, cache, TimeProvider.System, scopeB);
            Assert.Equal("Current block", Assert.Single((await resolverB.ResolveAsync(request)).Projections).ContextSnippet);
            Assert.True(lifetimeB.IsCurrent);
        }
        finally
        {
            io.CleanupReleased.TrySetResult();
            io.CommandCleanupReleased.TrySetResult();
            await DrainAsync(pending);
            db.Aop.OnLogExecuted = null;
            db.Ado.Connection = nativeConnection;
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DisabledPrincipal_RequiresSqlRejectionDuringLagAndAuthenticationRejectionAfterDelivery(bool deliver)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        foreach (SchemaMigrationStep step in AuthoringCanvasOperationJournalMigrationDefinitions.BuildMigration().Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        await AuthoringCanvasAuthenticatedTestScope.AttachAsync(db, s_owner.AdminPrincipalId);
        HttpContext context = new HttpContextAccessor().HttpContext!;
        AdminAuthenticatedRequestLifetime lifetime = context.Features.Get<IAdminAuthenticatedRequestFeature>()!.Lifetime;
        var projection = (AdminSessionProjection)context.Items[typeof(AdminSessionProjection)]!;
        var admission = (AdminSessionValidationService)context.Items[typeof(AdminSessionValidationService)]!;
        string token = (string)context.Items["canvas-auth-fixture-token"]!;
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db);
        var cache = new AuthoringCanvasReferenceProjectionCache();
        var accessor = new RequestContextAccessor { HttpContext = context };
        AuthoringCanvasReferenceResolver resolver = Resolver(db, cache, accessor);
        var scope = new AuthoringCanvasRequestLifetime(db, accessor);
        var store = new AuthoringCanvasDocumentStore(db, TimeProvider.System);
        var transaction = new PostgresAuthoringCanvasOperationTransaction(db, store, TimeProvider.System, scope);
        var engine = new AuthoringCanvasOperationEngine(store, transaction,
            new AuthoringCanvasOperationReferenceValidator(resolver, scope), scope);
        Assert.Equal(1, await writer.Ado.ExecuteCommandAsync(
            "UPDATE admin_principal SET status = 'disabled', validationversion = 2 WHERE id = 73;"));
        Assert.True(lifetime.IsCurrent);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => resolver.ResolveAsync(request));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => engine.RecoverAsync(
            new AuthoringCanvasOperationRecoveryQuery(request.CanvasId, s_owner, Guid.CreateVersion7(), new string('a', 64))));
        Assert.Equal(0, cache.EntryCount);
        Assert.Equal(0, await writer.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_canvas_operation_journal;"));
        Assert.Equal(0, await writer.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_canvas_operation_receipt;"));
        if (deliver)
        {
            var options = AdminSessionProjectionRuntimeOptions.FromConfiguration(new ConfigurationBuilder().Build());
            var authority = new AdminSessionProjectionAuthorityReader(writer, projection, options, TimeProvider.System);
            AdminSessionProjectionPrincipalUpdate update = (await authority.ReadPrincipalAsync(s_owner.AdminPrincipalId))!.Value;
            var invalidation = DistributedInvalidationEvent.Create(Guid.CreateVersion7().ToString("N"),
                DistributedInvalidationEventKinds.AdminSessionProjectionMutation, "disabled-writer", "disabled-test",
                [], [], [AdminSessionProjectionEventCodec.Format(update)], Guid.CreateVersion7().ToString("N"), TimeProvider.System);
            var applier = new DistributedInvalidationLocalApplier(null!, null!, null!, null!, null!, null!, null!, null!,
                NullLogger<DistributedInvalidationLocalApplier>.Instance, adminSessionProjection: projection);
            Assert.NotNull(await applier.ApplyAsync(invalidation));
        }
        int canvasReads = 0;
        db.Aop.OnLogExecuting = (sql, _) =>
        {
            if (sql.Contains("authoring_canvas", StringComparison.Ordinal))
            {
                canvasReads++;
            }
        };
        try
        {
            AdminSessionValidationResult next = await admission.ValidateAsync(context.User, token, CancellationToken.None);
            using AdminAuthenticatedRequestLifetime? nextLifetime = next.RequestLifetime;
            Assert.Equal(!deliver, next.IsValid);
            if (deliver)
            {
                Assert.Equal(AdminSessionProjectionReasons.PrincipalInactive, next.Reason);
                Assert.Null(next.RequestLifetime);
                Assert.False(lifetime.IsCurrent);
            }
            Assert.Equal(0, canvasReads);
        }
        finally
        {
            db.Aop.OnLogExecuting = null;
        }
        AuthoringCanvasDocumentHeader header = (await store.GetAsync(s_owner, request.CanvasId))!;
        Assert.Equal(request.CanvasRevision, header.Revision);
        Assert.Equal(request.CanvasContentDigest, header.ContentDigest);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FinalColdOrWarmPublication_HoldsActualSessionRowsUntilPublicationCompletes(bool warmCache)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await AuthoringCanvasAuthenticatedTestScope.AttachAsync(db, s_owner.AdminPrincipalId);
        HttpContext context = new HttpContextAccessor().HttpContext!;
        AdminAuthenticatedRequestLifetime lifetimeA = context.Features.Get<IAdminAuthenticatedRequestFeature>()!.Lifetime;
        string sessionA = lifetimeA.RequireBinding().SessionId;
        var accessor = new RequestContextAccessor { HttpContext = context };
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolver resolver = Resolver(db, cache, accessor);
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db);
        if (warmCache)
        {
            await resolver.ResolveAsync(request);
        }
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int reads = 0;
        db.Aop.OnLogExecuted = (sql, _) =>
        {
            if (sql.Contains("WITH principal AS", StringComparison.Ordinal)
                && Interlocked.Increment(ref reads) == (warmCache ? 2 : 4))
            {
                entered.TrySetResult();
                released.Task.WaitAsync(TimeSpan.FromSeconds(30)).GetAwaiter().GetResult();
            }
        };
        Task<AuthoringCanvasReferenceResolutionBatch> pending = Task.Run(() => resolver.ResolveAsync(request));
        Task<int>? revoking = null;
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(30));
            await writer.Ado.BeginTranAsync();
            int writerProcess = await writer.Ado.GetIntAsync("SELECT pg_backend_pid();");
            revoking = RevokeAsync(writer, sessionA);
            await WaitForServerLockAsync(observer, writerProcess);
            Assert.False(revoking.IsCompleted);
            Assert.False(pending.IsCompleted);
            released.TrySetResult();
            AuthoringCanvasReferenceResolutionBatch publishedA = await pending;
            Assert.Equal(warmCache ? 1 : 0, publishedA.Receipt.CacheHitCount);
            Assert.Equal("Private summary", Assert.Single(publishedA.Projections).ContextSnippet);
            Assert.Equal(1, await revoking);
            await writer.Ado.CommitTranAsync();
            // The result was built while SQL excluded revocation. A later SQL commit
            // does not fabricate a synchronous update in this intentionally lagging projection.
            Assert.True(lifetimeA.IsCurrent);
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => resolver.ResolveAsync(request));
            Assert.Equal(1, cache.EntryCount);
            db.Aop.OnLogExecuted = null;
            await AuthoringCanvasAuthenticatedTestScope.AttachAsync(db, s_owner.AdminPrincipalId);
            AuthoringCanvasReferenceResolver resolverB = Resolver(db, cache, accessor);
            AuthoringCanvasReferenceResolutionBatch publishedB = await resolverB.ResolveAsync(request);
            Assert.Equal(0, publishedB.Receipt.CacheHitCount);
            Assert.NotEqual(publishedA.AuthorityCoordinate.PermissionFingerprint,
                publishedB.AuthorityCoordinate.PermissionFingerprint);
            Assert.True((await resolverB.VerifyAsync(request, publishedB)).Valid);
            AuthoringCanvasReferenceVerificationResult crossed = await resolverB.VerifyAsync(request, publishedA);
            Assert.False(crossed.Valid);
            Assert.Contains("authority_coordinate_mismatch", crossed.Reasons);
            Assert.Equal(2, cache.EntryCount);
        }
        finally
        {
            released.TrySetResult();
            if (revoking is not null)
            {
                await DrainAsync(revoking);
            }
            if (writer.Ado.Transaction is not null)
            {
                await writer.Ado.RollbackTranAsync();
            }
            await DrainAsync(pending);
            db.Aop.OnLogExecuted = null;
        }
    }

    [Fact]
    public async Task ActivePrincipalVersionDrift_RejectsOldRegistrationUntilOriginalProducerRevalidates()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await AuthoringCanvasAuthenticatedTestScope.AttachAsync(db, s_owner.AdminPrincipalId);
        HttpContext context = new HttpContextAccessor().HttpContext!;
        AdminAuthenticatedRequestLifetime original = context.Features.Get<IAdminAuthenticatedRequestFeature>()!.Lifetime;
        var projection = (AdminSessionProjection)context.Items[typeof(AdminSessionProjection)]!;
        var admission = (AdminSessionValidationService)context.Items[typeof(AdminSessionValidationService)]!;
        string token = (string)context.Items["canvas-auth-fixture-token"]!;
        var accessor = new RequestContextAccessor { HttpContext = context };
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolver resolver = Resolver(db, cache, accessor);
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db);
        Assert.Equal(1, await writer.Ado.ExecuteCommandAsync(
            "UPDATE admin_principal SET validationversion = 2 WHERE id = 73 AND status = 'active';"));
        Assert.True(original.IsCurrent);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => resolver.ResolveAsync(request));
        Assert.Equal(0, cache.EntryCount);
        var options = AdminSessionProjectionRuntimeOptions.FromConfiguration(new ConfigurationBuilder().Build());
        var authority = new AdminSessionProjectionAuthorityReader(writer, projection, options, TimeProvider.System);
        AdminSessionProjectionPrincipalUpdate update = (await authority.ReadPrincipalAsync(s_owner.AdminPrincipalId))!.Value;
        var invalidation = DistributedInvalidationEvent.Create(Guid.CreateVersion7().ToString("N"),
            DistributedInvalidationEventKinds.AdminSessionProjectionMutation, "version-writer", "version-test",
            [], [], [AdminSessionProjectionEventCodec.Format(update)], Guid.CreateVersion7().ToString("N"), TimeProvider.System);
        var applier = new DistributedInvalidationLocalApplier(null!, null!, null!, null!, null!, null!, null!, null!,
            NullLogger<DistributedInvalidationLocalApplier>.Instance, adminSessionProjection: projection);
        Assert.NotNull(await applier.ApplyAsync(invalidation));
        Assert.False(original.IsCurrent);
        AdminSessionValidationResult admitted = await admission.ValidateAsync(context.User, token, CancellationToken.None);
        Assert.True(admitted.IsValid);
        using AdminAuthenticatedRequestLifetime current = Assert.IsType<AdminAuthenticatedRequestLifetime>(admitted.RequestLifetime);
        Assert.Equal(2, current.RequireBinding().PrincipalVersion);
        current.BindRequest(context.RequestAborted);
        context.Features.Set<IAdminAuthenticatedRequestFeature>(new AdminAuthenticatedRequestFeature(current));
        await Assert.ThrowsAsync<AuthoringCanvasAccessDeniedException>(() => resolver.ResolveAsync(request));
        AuthoringCanvasReferenceResolutionBatch accepted = await Resolver(db, cache, accessor).ResolveAsync(request);
        Assert.Equal("Private summary", Assert.Single(accepted.Projections).ContextSnippet);
        Assert.Equal(0, accepted.Receipt.CacheHitCount);
        Assert.Equal(1, cache.EntryCount);
    }

    private static async Task WaitForServerLockAsync(SqlSugarClient observer, int processId)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        while (await observer.Ado.GetIntAsync(
            "SELECT COUNT(*) FROM pg_stat_activity WHERE pid = @ProcessId AND wait_event_type = 'Lock';",
            new SugarParameter("@ProcessId", processId)) == 0)
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    private static async Task DrainAsync(Task pending)
    {
        try
        {
            await pending.WaitAsync(TimeSpan.FromSeconds(30));
        }
        catch (Exception) when (pending.IsCompleted)
        {
            // The assertion observes the failure; cleanup still joins the real operation.
        }
    }

    private static AdminSession Session(string sessionId, string token, DateTime now)
        => new()
        {
            SessionId = sessionId,
            AdminPrincipalId = s_owner.AdminPrincipalId,
            AccessTokenHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))),
            ValidationVersion = 1,
            CreatedAtUtc = now.AddHours(-1),
            IdleExpiresAtUtc = now.AddHours(1),
            AbsoluteExpiresAtUtc = now.AddHours(2)
        };

    private static ClaimsPrincipal Principal(string sessionId)
        => new(new ClaimsIdentity(
        [
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", "73"),
            new Claim("admin_sid", sessionId)
        ], "task-owned-session"));

    private static AuthoringCanvasReferenceResolver Resolver(SqlSugarClient db, AuthoringCanvasReferenceProjectionCache cache,
        IHttpContextAccessor context)
    {
        var lifetime = new AuthoringCanvasRequestLifetime(db, context);
        return new AuthoringCanvasReferenceResolver(new AuthoringCanvasDocumentStore(db, TimeProvider.System),
            new AuthoringCanvasReferenceFactSource(new PostgresAuthoringCanvasArticleReferenceReader(db),
                new AuthoringCanvasCoordinateFactProvider([]), lifetime), cache, TimeProvider.System, lifetime);
    }

    private static async Task<bool> AdmissionValidAsync(AdminSessionValidationService admission,
        ClaimsPrincipal principal, string token)
    {
        AdminSessionValidationResult result = await admission.ValidateAsync(principal, token, CancellationToken.None);
        using AdminAuthenticatedRequestLifetime? lifetime = result.RequestLifetime;
        return result.IsValid;
    }

    private sealed class RequestContextAccessor : IHttpContextAccessor
    {
        public HttpContext? HttpContext
        {
            get; set;
        }
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(id bigint PRIMARY KEY, status text NOT NULL, isroot boolean NOT NULL,
                permissions text NOT NULL, validationversion bigint NOT NULL DEFAULT 1);
            INSERT INTO admin_principal VALUES (73, 'active', false, E'article.write\n', 1);
            CREATE TABLE article(id integer PRIMARY KEY, title varchar(256) NOT NULL, summary varchar(512),
                status integer NOT NULL, isdeleted boolean NOT NULL, current_revision_id bigint);
            CREATE TABLE article_revision(id bigint PRIMARY KEY, article_id integer NOT NULL, title varchar(256) NOT NULL,
                summary varchar(512), created_by_admin_principal_id bigint NOT NULL,
                markdown_content text NOT NULL DEFAULT '', content_block_id bigint);
            CREATE TABLE article_revision_content_block(id bigint PRIMARY KEY, markdown_content text NOT NULL);
            INSERT INTO article_revision_content_block VALUES (1, 'Current block ^intro-block');
            INSERT INTO article VALUES (204, 'Private title', 'Private summary', 2, false, 9002);
            INSERT INTO article_revision VALUES (9002, 204, 'Private title', 'Private summary', 73, '', 1);
            """);
        ISchemaMigrationDescriptor migration = AuthoringCanvasDocumentMigrationDefinitions.BuildMigration();
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        return db;
    }

    private static async Task<AuthoringCanvasReferenceResolutionRequest> CreateRequestAsync(SqlSugarClient db)
    {
        var store = new AuthoringCanvasDocumentStore(db, TimeProvider.System);
        Guid canvasId = Guid.CreateVersion7();
        AuthoringCanvasWriteReceipt created = await store.CreateAsync(new CreateAuthoringCanvasCommand(
            canvasId, s_owner, "In-flight session fixture", new AuthoringCanvasViewport(0, 0, 1), Guid.CreateVersion7()));
        var node = new AuthoringCanvasNode(Guid.CreateVersion7(), AuthoringCanvasNodeType.ArticleReference,
            0, new AuthoringCanvasGeometry(0, 0, 100, 100), TargetArticleId: 204,
            ReferenceState: AuthoringCanvasReferenceState.Current);
        AuthoringCanvasWriteReceipt written = await store.PutNodeAsync(new PutAuthoringCanvasNodeCommand(
            canvasId, s_owner, created.Revision, Guid.CreateVersion7(), node));
        return new AuthoringCanvasReferenceResolutionRequest(Guid.CreateVersion7(), canvasId, written.Revision,
            written.ContentDigest, s_owner, AuthoringCanvasReferencePermission.ArticleRead, [node]);
    }
}
