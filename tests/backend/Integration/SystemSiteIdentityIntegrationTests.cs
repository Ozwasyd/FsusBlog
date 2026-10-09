using System.Data;
using System.Data.Common;

using Npgsql;

using SqlSugar;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class SystemSiteIdentityIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string Scope = "https://installation.example";

    [Fact]
    public async Task OrdinaryRead_IsZeroWriteAndFreshInitializationPersistsAcrossRestart()
    {
        string connection = await EmptyDatabaseAsync();
        string identity;
        using (SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection))
        {
            SystemService service = SystemSiteIdentityTests.CreateService(db);
            Assert.Equal(SystemSiteIdentityState.Absent, (await service.ReadCurrentSiteIdentityAsync()).State);
            Assert.Equal(0, await db.Queryable<SystemConfig>().CountAsync());
            SystemSiteIdentityReadModel result = await CommitAsync(db, () => service.InitializeSiteIdentityAsync(Guid.NewGuid(), Scope));
            identity = result.Identity!;
            Assert.Matches("^fsus-site:[0-9a-f]{64}$", identity);
            Assert.Equal(2, await db.Queryable<SystemConfig>().CountAsync());
            Assert.All(await db.Queryable<SystemConfig>().ToListAsync(), row =>
            {
                Assert.InRange(row.Key.Length, 1, 64);
                Assert.InRange(row.Value.Length, 1, 512);
            });
        }
        using SqlSugarClient restarted = PostgresSqlSugarTestClient.Create(connection);
        SystemSiteIdentityReadModel read = await SystemSiteIdentityTests.CreateService(restarted).ReadCurrentSiteIdentityAsync();
        Assert.Equal(identity, read.Identity);
        Assert.Equal(Scope, Assert.Single(read.Scopes).Scope);
    }

    [Fact]
    public async Task ConcurrentInitialization_ExactIntentReplayCreatesOnlyOneIdentity()
    {
        string connection = await EmptyDatabaseAsync();
        Guid intent = Guid.NewGuid();
        Task<SystemSiteIdentityReadModel>[] tasks = Enumerable.Range(0, 8).Select(async _ =>
        {
            using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
            return await CommitAsync(db, () => SystemSiteIdentityTests.CreateService(db).InitializeSiteIdentityAsync(intent, Scope));
        }).ToArray();
        SystemSiteIdentityReadModel[] results = await Task.WhenAll(tasks);
        Assert.Single(results.Select(result => result.Identity).Distinct());
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connection);
        Assert.Equal(2, await verify.Queryable<SystemConfig>().CountAsync());
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommitAsync(verify, () =>
            SystemSiteIdentityTests.CreateService(verify).InitializeSiteIdentityAsync(Guid.NewGuid(), Scope)));
    }

    [Fact]
    public async Task ReplayChangedInput_AndSupersededIntentRefuse()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await EmptyDatabaseAsync());
        SystemService service = SystemSiteIdentityTests.CreateService(db);
        Guid intent = Guid.NewGuid();
        await CommitAsync(db, () => service.InitializeSiteIdentityAsync(intent, Scope));
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommitAsync(db, () => service.InitializeSiteIdentityAsync(intent, "https://other.example")));
        await CommitAsync(db, () => service.ChangeSiteIdentityScopeAsync(Guid.NewGuid(), 1, 1, "https://alias.example", true));
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommitAsync(db, () => service.InitializeSiteIdentityAsync(intent, Scope)));
        Assert.Equal(3, await db.Queryable<SystemConfig>().CountAsync());
    }

    [Fact]
    public async Task CallerRollback_RemovesIdentityAndPreservesOtherTransactionWork()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await EmptyDatabaseAsync());
        SystemService service = SystemSiteIdentityTests.CreateService(db);
        db.Ado.BeginTran(IsolationLevel.ReadCommitted);
        await service.InitializeSiteIdentityAsync(Guid.NewGuid(), Scope);
        Assert.Equal(SystemSiteIdentityState.Current, (await service.ReadCurrentSiteIdentityAsync()).State);
        db.Ado.RollbackTran();
        Assert.Equal(SystemSiteIdentityState.Absent, (await service.ReadCurrentSiteIdentityAsync()).State);
        db.Ado.BeginTran(IsolationLevel.ReadCommitted);
        await db.Insertable(new SystemConfig { Key = "Seo_Title", Value = "caller-owned" }).ExecuteCommandAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.InitializeSiteIdentityAsync(Guid.NewGuid(), Scope));
        db.Ado.CommitTran();
        Assert.Equal("caller-owned", (await db.Queryable<SystemConfig>().SingleAsync()).Value);
    }

    [Fact]
    public async Task SecondInsertFailure_RollsBackOperationSavepointWithoutCommittingCaller()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await EmptyDatabaseAsync());
        await db.Ado.ExecuteCommandAsync("ALTER TABLE public.sys_systemconfig ADD CONSTRAINT test_reject_scope CHECK (left(key, 19) <> 'SiteIdentity_Scope_')");
        db.Ado.BeginTran(IsolationLevel.ReadCommitted);
        await Assert.ThrowsAnyAsync<DbException>(() => SystemSiteIdentityTests.CreateService(db).InitializeSiteIdentityAsync(Guid.NewGuid(), Scope));
        Assert.Equal(0, await db.Queryable<SystemConfig>().CountAsync());
        await db.Insertable(new SystemConfig { Key = "Seo_Title", Value = "survives" }).ExecuteCommandAsync();
        db.Ado.CommitTran();
        Assert.Equal(1, await db.Queryable<SystemConfig>().CountAsync());
    }

    [Fact]
    public async Task MissingTransactionAndCancellation_AllocateNothing()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await EmptyDatabaseAsync());
        SystemService service = SystemSiteIdentityTests.CreateService(db);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.InitializeSiteIdentityAsync(Guid.NewGuid(), Scope));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => CommitAsync(db, () => service.InitializeSiteIdentityAsync(Guid.NewGuid(), Scope, cancellation.Token)));
        Assert.Equal(0, await db.Queryable<SystemConfig>().CountAsync());
    }

    [Fact]
    public async Task CancellationDuringStorageLock_RestoresCallerSavepointAndAllocatesNothing()
    {
        string connection = await EmptyDatabaseAsync();
        using SqlSugarClient blocker = PostgresSqlSugarTestClient.Create(connection);
        using SqlSugarClient victim = PostgresSqlSugarTestClient.Create(connection);
        blocker.Ado.BeginTran(IsolationLevel.ReadCommitted);
        await blocker.Ado.ExecuteCommandAsync("LOCK TABLE public.sys_systemconfig IN SHARE ROW EXCLUSIVE MODE");
        victim.Ado.BeginTran(IsolationLevel.ReadCommitted);
        int backendPid = ((NpgsqlConnection)victim.Ado.Connection).ProcessID;
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        Task<SystemSiteIdentityReadModel> pending = SystemSiteIdentityTests.CreateService(victim)
            .InitializeSiteIdentityAsync(Guid.NewGuid(), Scope, cancellation.Token);
        bool waiting = false;
        for (int attempt = 0; attempt < 100 && !waiting; attempt++)
        {
            waiting = await blocker.Ado.GetIntAsync($"SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE pid={backendPid} AND wait_event_type='Lock'") == 1;
            if (!waiting)
            {
                await Task.Delay(10);
            }
        }
        try
        {
            Assert.True(waiting, "The original operation must actually wait on the PostgreSQL storage lock.");
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            Assert.Equal(0, await victim.Queryable<SystemConfig>().CountAsync());
            Assert.Equal(1, await victim.Ado.GetIntAsync("SELECT 1"));
        }
        finally
        {
            cancellation.Cancel();
            victim.Ado.RollbackTran();
            blocker.Ado.RollbackTran();
        }
    }

    [Fact]
    public async Task WrongIsolationAndStorageFailure_RefuseWithoutFallback()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await EmptyDatabaseAsync());
        SystemService service = SystemSiteIdentityTests.CreateService(db);
        db.Ado.BeginTran(IsolationLevel.RepeatableRead);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.InitializeSiteIdentityAsync(Guid.NewGuid(), Scope));
        db.Ado.RollbackTran();
        Assert.Equal(0, await db.Queryable<SystemConfig>().CountAsync());
        await db.Ado.ExecuteCommandAsync("DROP TABLE public.sys_systemconfig");
        await Assert.ThrowsAnyAsync<DbException>(() => service.ReadCurrentSiteIdentityAsync());
    }

    [Fact]
    public async Task LegacyConfigurationAndContent_RequireExplicitMigrationInput()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await EmptyDatabaseAsync());
        SystemService service = SystemSiteIdentityTests.CreateService(db);
        await db.Ado.ExecuteCommandAsync("CREATE TABLE public.legacy_fact (scope text); INSERT INTO public.legacy_fact VALUES ('https://historical.example')");
        Assert.Equal(SystemSiteIdentityState.MigrationRequired, (await service.ReadCurrentSiteIdentityAsync()).State);
        Assert.Equal(0, await db.Queryable<SystemConfig>().CountAsync());
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommitAsync(db, () => service.InitializeSiteIdentityAsync(Guid.NewGuid(), Scope)));
        SystemSiteIdentityReadModel migrated = await CommitAsync(db, () => service.MigrateLegacySiteIdentityAsync(Guid.NewGuid(), "https://historical.example"));
        Assert.Equal("https://historical.example", Assert.Single(migrated.Scopes).Scope);
        Assert.Equal("https://historical.example", await db.Ado.GetStringAsync("SELECT scope FROM public.legacy_fact"));
    }

    [Fact]
    public async Task EditableSeoComplianceAndPages_CannotOverwriteIdentityOrMappings()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await EmptyDatabaseAsync());
        PostgresSqlSugarTestClient.InitTables(db, typeof(PageContent));
        SystemService service = SystemSiteIdentityTests.CreateService(db);
        SystemSiteIdentityReadModel original = await CommitAsync(db, () => service.InitializeSiteIdentityAsync(Guid.NewGuid(), Scope));
        Dictionary<string, string> journal = (await db.Queryable<SystemConfig>().ToListAsync()).ToDictionary(row => row.Key, row => row.Value);
        await service.UpdateSeoConfigAsync(new UpdateSeoConfigRequest { Title = "SiteIdentity_Installation_0000000001", BaseUrl = "https://new-url.example" });
        await service.UpdateSiteComplianceConfigAsync(new UpdateSiteComplianceConfigRequest { CopyrightOwner = "fsus-site:forged", Enabled = false });
        await service.UpdatePageContentAsync(new UpdatePageContentRequest { Slug = "about", Content = "SiteIdentity_Scope_0000000001_0000000001" });
        SystemSiteIdentityReadModel current = await service.ReadCurrentSiteIdentityAsync();
        Assert.Equal(original.Identity, current.Identity);
        Assert.Equal(1, current.MappingRevision);
        Assert.Equal(Scope, Assert.Single(current.Scopes).Scope);
        foreach (SystemConfig row in await db.Queryable<SystemConfig>().Where(row => row.Key.StartsWith("SiteIdentity_")).ToListAsync())
        {
            Assert.Equal(journal[row.Key], row.Value);
        }
    }

    [Fact]
    public async Task MappingHistory_RejectsVersionDriftAndKeepsIdentity()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await EmptyDatabaseAsync());
        SystemService service = SystemSiteIdentityTests.CreateService(db);
        SystemSiteIdentityReadModel original = await CommitAsync(db, () => service.InitializeSiteIdentityAsync(Guid.NewGuid(), Scope));
        Guid aliasIntent = Guid.NewGuid();
        SystemSiteIdentityReadModel added = await CommitAsync(db, () => service.ChangeSiteIdentityScopeAsync(aliasIntent, 1, 1, "https://alias.example", true));
        Assert.Equal(added.Identity, (await CommitAsync(db, () => service.ChangeSiteIdentityScopeAsync(aliasIntent, 1, 1, "https://alias.example", true))).Identity);
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommitAsync(db, () => service.ChangeSiteIdentityScopeAsync(Guid.NewGuid(), 1, 1, Scope, false)));
        SystemSiteIdentityReadModel removed = await CommitAsync(db, () => service.ChangeSiteIdentityScopeAsync(Guid.NewGuid(), 1, 2, Scope, false));
        Assert.Equal(original.Identity, removed.Identity);
        Assert.Equal(3, removed.MappingRevision);
        Assert.Equal("https://alias.example", Assert.Single(removed.Scopes).Scope);
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommitAsync(db, () => service.ChangeSiteIdentityScopeAsync(Guid.NewGuid(), 1, 3, "https://alias.example", false)));
        Assert.Equal(4, await db.Queryable<SystemConfig>().CountAsync());
    }

    [Fact]
    public async Task MalformedUnsupportedAndAmbiguousPersistentRecords_RefuseReadAndMutation()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await EmptyDatabaseAsync());
        SystemService service = SystemSiteIdentityTests.CreateService(db);
        await db.Insertable(new SystemConfig { Key = "SiteIdentity_Unknown", Value = "1|orphan" }).ExecuteCommandAsync();
        Assert.Equal(SystemSiteIdentityState.Ambiguous, (await service.ReadCurrentSiteIdentityAsync()).State);
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommitAsync(db, () => service.MigrateLegacySiteIdentityAsync(Guid.NewGuid(), Scope)));
        await db.Updateable<SystemConfig>().SetColumns(row => row.Value == "99|future").Where(row => row.Key == "SiteIdentity_Unknown").ExecuteCommandAsync();
        Assert.Equal(SystemSiteIdentityState.UnsupportedVersion, (await service.ReadCurrentSiteIdentityAsync()).State);
        await Assert.ThrowsAnyAsync<DbException>(() => db.Insertable(new SystemConfig { Key = "SiteIdentity_Oversize", Value = new string('x', 513) }).ExecuteCommandAsync());
        Assert.Equal(1, await db.Queryable<SystemConfig>().CountAsync());
    }

    [Fact]
    public async Task RestoreContinuationAndExplicitIndependentClone_HaveDifferentIdentitySemantics()
    {
        string connection = await EmptyDatabaseAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        SystemService service = SystemSiteIdentityTests.CreateService(db);
        SystemSiteIdentityReadModel original = await CommitAsync(db, () => service.InitializeSiteIdentityAsync(Guid.NewGuid(), Scope));
        await CommitAsync(db, () => service.ChangeSiteIdentityScopeAsync(Guid.NewGuid(), 1, 1, "https://former-alias.example", true));
        SystemConfig[] backup = (await db.Queryable<SystemConfig>().ToListAsync()).ToArray();
        using SqlSugarClient restore = PostgresSqlSugarTestClient.Create(await EmptyDatabaseAsync());
        await restore.Insertable(backup).ExecuteCommandAsync();
        SystemService restored = SystemSiteIdentityTests.CreateService(restore);
        Assert.Equal(original.Identity, (await restored.ReadCurrentSiteIdentityAsync()).Identity);
        Guid cloneIntent = Guid.NewGuid();
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommitAsync(restore, () => restored.CloneSiteIdentityAsync(cloneIntent, 1, 2, Scope, SystemSiteIdentityCloneDisposition.RetainAsForeign)));
        SystemSiteIdentityReadModel clone = await CommitAsync(restore, () => restored.CloneSiteIdentityAsync(cloneIntent, 1, 2, "https://independent.example", SystemSiteIdentityCloneDisposition.RetainAsForeign));
        Assert.NotEqual(original.Identity, clone.Identity);
        Assert.Equal(2, clone.Generation);
        Assert.Equal(1, clone.MappingRevision);
        Assert.Equal(clone.Identity, (await CommitAsync(restore, () => restored.CloneSiteIdentityAsync(cloneIntent, 1, 2, "https://independent.example", SystemSiteIdentityCloneDisposition.RetainAsForeign))).Identity);
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommitAsync(restore, () => restored.ChangeSiteIdentityScopeAsync(Guid.NewGuid(), 2, 1, "https://former-alias.example", true)));
        foreach (SystemConfig row in backup)
        {
            Assert.Equal(row.Value, (await restore.Queryable<SystemConfig>().InSingleAsync(row.Key)).Value);
        }
        Assert.Equal(original.Identity, (await service.ReadCurrentSiteIdentityAsync()).Identity);
    }

    private async Task<string> EmptyDatabaseAsync()
    {
        string connection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        PostgresSqlSugarTestClient.InitTables(db, typeof(SystemConfig));
        return connection;
    }

    private static async Task<SystemSiteIdentityReadModel> CommitAsync(SqlSugarClient db, Func<Task<SystemSiteIdentityReadModel>> operation)
    {
        db.Ado.BeginTran(IsolationLevel.ReadCommitted);
        try
        {
            SystemSiteIdentityReadModel result = await operation();
            db.Ado.CommitTran();
            return result;
        }
        catch
        {
            db.Ado.RollbackTran();
            throw;
        }
    }
}
