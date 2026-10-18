using System.Data;
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

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthoringCanvasInFlightSessionPostgresTests(PostgresSchemaMigrationFixture fixture)
{
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
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task RevokingOnlyAWhileOriginalReadIsPending_RejectsAPublicationAndPreservesB(
        bool warmCache,
        bool deliverProjectionUpdate)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient authorityDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using SqlSugarClient otherRequestDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AdminSession));
        TimeProvider clock = TestTemporalContext.FromEnvironment().BusinessClock;
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
        Assert.True((await admission.ValidateAsync(principalA, TokenA, CancellationToken.None)).IsValid);
        Assert.True((await admission.ValidateAsync(principalB, TokenB, CancellationToken.None)).IsValid);
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db);
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolver resolver = Resolver(db, cache);
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
                    && Interlocked.Increment(ref authorityReads) == 2
                : sql.Contains("SELECT id, title, summary, status, isdeleted, current_revision_id", StringComparison.Ordinal);
            if (pause)
            {
                entered.TrySetResult();
                released.Task.WaitAsync(TimeSpan.FromSeconds(30)).GetAwaiter().GetResult();
            }
        };
        // Admission above is genuine; the frozen auth producer must supply its actual
        // request lifetime here. This regression intentionally exposes the current gap.
        Task<AuthoringCanvasReferenceResolutionBatch> pending = Task.Run(() => resolver.ResolveAsync(request));
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(30));
            Assert.False(pending.IsCompleted);
            Assert.Equal(1, await writer.Updateable<AdminSession>()
                .SetColumns(session => new AdminSession { RevokedAtUtc = now, ValidationVersion = 2 })
                .Where(session => session.SessionId == SessionA).ExecuteCommandAsync());
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
            Assert.Equal(!deliverProjectionUpdate,
                (await admission.ValidateAsync(principalA, TokenA, CancellationToken.None)).IsValid);
            Assert.True((await admission.ValidateAsync(principalB, TokenB, CancellationToken.None)).IsValid);
            released.TrySetResult();
            Exception? failure = await Record.ExceptionAsync(async () => await pending.WaitAsync(TimeSpan.FromSeconds(30)));
            Assert.True(failure is OperationCanceledException or AuthoringCanvasAccessDeniedException,
                $"Revoked session A published a result or failed outside authorization: {failure?.GetType().Name ?? "success"}.");
            Assert.Equal(entriesBeforeRead, cache.EntryCount);
            AuthoringCanvasReferenceResolutionBatch acceptedB = await Resolver(otherRequestDb, cache)
                .ResolveAsync(request with
                {
                    RequestId = Guid.CreateVersion7()
                });
            Assert.Equal("Private summary", Assert.Single(acceptedB.Projections).ContextSnippet);
            Assert.True((await admission.ValidateAsync(principalB, TokenB, CancellationToken.None)).IsValid);
        }
        finally
        {
            released.TrySetResult();
            await DrainAsync(pending);
            db.Aop.OnLogExecuted = null;
        }
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

    private static AuthoringCanvasReferenceResolver Resolver(SqlSugarClient db, AuthoringCanvasReferenceProjectionCache cache)
        => new(new AuthoringCanvasDocumentStore(db, TimeProvider.System),
            new AuthoringCanvasReferenceFactSource(new PostgresAuthoringCanvasArticleReferenceReader(db),
                new AuthoringCanvasCoordinateFactProvider([])), cache, TimeProvider.System);

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
                summary varchar(512), created_by_admin_principal_id bigint NOT NULL);
            INSERT INTO article VALUES (204, 'Private title', 'Private summary', 2, false, 9002);
            INSERT INTO article_revision VALUES (9002, 204, 'Private title', 'Private summary', 73);
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
