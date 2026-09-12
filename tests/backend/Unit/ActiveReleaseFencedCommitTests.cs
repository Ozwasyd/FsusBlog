using System.Data;
using System.Data.Common;

using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services.Background;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

public sealed class ActiveReleaseFencedCommitTests
{
    [Fact]
    public async Task Enlist_OutsideBusinessTransaction_IsRejected()
    {
        IActiveReleaseExecutionContextAccessor executionContext = Substitute.For<IActiveReleaseExecutionContextAccessor>();
        executionContext.Current.Returns(Ticket());
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection().Build();
        var guard = new ActiveReleaseTransactionalCommitGuard(
            executionContext,
            configuration,
            HostEnvironment(Environments.Production),
            new ReleaseIdentityProvider(configuration));
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAdo ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.Transaction.Returns((IDbTransaction?)null);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => guard.EnlistAsync(db, "scheduled-publish", "batch-42"));

        Assert.Contains("inside the business PostgreSQL transaction", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Enlist_ReloadablePause_FailsClosedBeforeDatabaseAccess()
    {
        IActiveReleaseExecutionContextAccessor executionContext = Substitute.For<IActiveReleaseExecutionContextAccessor>();
        executionContext.Current.Returns(Ticket());
        IConfigurationRoot configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ActiveReleaseFencedCommit:MutationEnabled"] = "false"
            })
            .Build();
        var guard = new ActiveReleaseTransactionalCommitGuard(
            executionContext,
            configuration,
            HostEnvironment(Environments.Production),
            new ReleaseIdentityProvider(configuration));
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();

        ActiveReleaseFencedCommitPausedException error =
            await Assert.ThrowsAsync<ActiveReleaseFencedCommitPausedException>(
                () => guard.EnlistAsync(db, "article-outbox-complete", "outbox-42"));

        Assert.Contains("article-outbox-complete", error.Message, StringComparison.Ordinal);
        _ = db.DidNotReceive().Ado;
    }

    [Fact]
    public void GuardSql_LocksDurableFenceAndPersistsExecutionTicketInSameStatement()
    {
        Assert.Equal("SELECT pg_advisory_xact_lock_shared(1179862354);", ActiveReleaseFencedCommitSql.AdvisoryLock);
        Assert.Contains("FROM sys_deployment_fence", ActiveReleaseFencedCommitSql.Enlist, StringComparison.Ordinal);
        Assert.Contains("FOR SHARE", ActiveReleaseFencedCommitSql.Enlist, StringComparison.Ordinal);
        Assert.Contains("INSERT INTO sys_fenced_commit", ActiveReleaseFencedCommitSql.Enlist, StringComparison.Ordinal);
        Assert.Contains("clock_timestamp() AT TIME ZONE 'utc'", ActiveReleaseFencedCommitSql.Enlist, StringComparison.Ordinal);
        Assert.Contains("process_instance_id", ActiveReleaseFencedCommitSql.Enlist, StringComparison.Ordinal);
        Assert.Contains("FROM matching_fence", ActiveReleaseFencedCommitSql.Enlist, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Enlist_DevelopmentSyntheticLocalFence_DoesNotRequireDurableReleaseRow()
    {
        IActiveReleaseExecutionContextAccessor executionContext = Substitute.For<IActiveReleaseExecutionContextAccessor>();
        var ticket = new ActiveReleaseExecutionTicket(
            "local-unversioned",
            "local",
            1,
            "local-unversioned",
            "test-process");
        executionContext.Current.Returns(ticket);
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [ActiveReleaseFenceAvailabilityPolicy.AllowSyntheticLocalFenceKey] = "true"
            })
            .Build();
        var guard = new ActiveReleaseTransactionalCommitGuard(
            executionContext,
            configuration,
            HostEnvironment(Environments.Development),
            new ReleaseIdentityProvider(configuration));
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAdo ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.Transaction.Returns(Substitute.For<IDbTransaction>());

        ActiveReleaseFencedCommitReceipt receipt = await guard.EnlistAsync(
            db,
            "article-outbox-complete",
            "outbox-42");

        Assert.Equal(ticket.Generation, receipt.Generation);
        Assert.Equal("article-outbox-complete", receipt.OperationScope);
        Assert.Equal("outbox-42", receipt.MutationKey);
        await ado.DidNotReceive().ExecuteCommandAsync(Arg.Any<string>());
        await ado.DidNotReceive().GetDataReaderAsync(
            Arg.Any<string>(),
            Arg.Any<SugarParameter[]>());
    }

    [Fact]
    public async Task Enlist_DevelopmentSyntheticLocalFence_PartialReleaseIdentity_DoesNotRequireDurableReleaseRow()
    {
        IActiveReleaseExecutionContextAccessor executionContext = Substitute.For<IActiveReleaseExecutionContextAccessor>();
        var ticket = new ActiveReleaseExecutionTicket(
            "20260912125730-69b467403020",
            "local",
            1,
            $"sha256:{new string('0', 64)}",
            "test-process");
        executionContext.Current.Returns(ticket);
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [ActiveReleaseFenceAvailabilityPolicy.AllowSyntheticLocalFenceKey] = "true",
                ["FSUSBLOG_RELEASE_ID"] = "20260912125730-69b467403020"
            })
            .Build();
        var guard = new ActiveReleaseTransactionalCommitGuard(
            executionContext,
            configuration,
            HostEnvironment(Environments.Development),
            new ReleaseIdentityProvider(configuration));
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAdo ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.Transaction.Returns(Substitute.For<IDbTransaction>());

        ActiveReleaseFencedCommitReceipt receipt = await guard.EnlistAsync(
            db,
            "article-outbox-complete",
            "outbox-42");

        Assert.Equal(ticket.Generation, receipt.Generation);
        Assert.Equal("article-outbox-complete", receipt.OperationScope);
        Assert.Equal("outbox-42", receipt.MutationKey);
        await ado.DidNotReceive().ExecuteCommandAsync(Arg.Any<string>());
        await ado.DidNotReceive().GetDataReaderAsync(
            Arg.Any<string>(),
            Arg.Any<SugarParameter[]>());
    }

    [Fact]
    public async Task Enlist_DevelopmentSyntheticLocalFence_ForeignTicket_RequiresDurableReleaseRow()
    {
        IActiveReleaseExecutionContextAccessor executionContext = Substitute.For<IActiveReleaseExecutionContextAccessor>();
        executionContext.Current.Returns(new ActiveReleaseExecutionTicket(
            "20260912125730-69b467403020",
            "local",
            1,
            $"sha256:{new string('0', 64)}",
            "test-process"));
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [ActiveReleaseFenceAvailabilityPolicy.AllowSyntheticLocalFenceKey] = "true"
            })
            .Build();
        var guard = new ActiveReleaseTransactionalCommitGuard(
            executionContext,
            configuration,
            HostEnvironment(Environments.Development),
            new ReleaseIdentityProvider(configuration));
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAdo ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.Transaction.Returns(Substitute.For<IDbTransaction>());
        DbDataReader reader = Substitute.For<DbDataReader>();
        reader.ReadAsync(Arg.Any<CancellationToken>()).Returns(false);
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(reader);

        await Assert.ThrowsAsync<ActiveReleaseFenceLostException>(
            () => guard.EnlistAsync(db, "article-outbox-complete", "outbox-42"));
    }

    [Fact]
    public void AuditWorker_DetectsPostRevokePostSwitchAndImpossibleFutureGenerationCommits()
    {
        foreach (string column in new[]
                 {
                     "commit_token",
                     "operation_scope",
                     "mutation_key",
                     "release_id",
                     "slot",
                     "generation",
                     "enlisted_at_utc"
                 })
        {
            Assert.Contains($"committed.{column}", ActiveReleaseFencedCommitSql.Audit, StringComparison.Ordinal);
        }
        Assert.Contains("committed.generation > fence.generation", ActiveReleaseFencedCommitSql.Audit, StringComparison.Ordinal);
        Assert.Contains("fence.status = 'revoked'", ActiveReleaseFencedCommitSql.Audit, StringComparison.Ordinal);
        Assert.Contains("committed.generation < fence.generation", ActiveReleaseFencedCommitSql.Audit, StringComparison.Ordinal);
        Assert.Contains("fence.activated_at_utc", ActiveReleaseFencedCommitSql.Audit, StringComparison.Ordinal);
        Assert.Equal("fsus.active_release_fenced_commit.violations", ActiveReleaseFencedCommitMetricNames.Violations);
    }

    [Fact]
    public async Task Transaction_NoOpMutation_DoesNotCreateAuditOnlyToken()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAdo ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            await call.Arg<Func<Task>>()();
            return new DbResult<bool> { IsSuccess = true };
        });
        IActiveReleaseTransactionalCommitGuard guard =
            Substitute.For<IActiveReleaseTransactionalCommitGuard>();

        int result = await ActiveReleaseFencedTransaction.ExecuteAsync(
            db,
            guard,
            "no-op-probe",
            "empty-batch",
            _ => Task.FromResult(0),
            CancellationToken.None,
            static affectedRows => affectedRows > 0);

        Assert.Equal(0, result);
        await guard.DidNotReceive().EnlistAsync(
            Arg.Any<ISqlSugarClient>(),
            Arg.Any<string>(),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public void CriticalDatabaseWorkers_EnlistTransactionalFenceGuard()
    {
        AssertTransactionalGuard(typeof(ScheduledPublishWorker));
        AssertTransactionalGuard(typeof(ArticleMutationOutboxDispatcher));
        AssertTransactionalGuard(typeof(LogCleanupService));
        Assert.Equal("scheduled-publish", ScheduledPublishWorker.FencedCommitOperationScope);
        Assert.Equal("article-outbox-complete", ArticleMutationOutboxDispatcher.FencedCommitOperationScope);
        Assert.Equal("fenced-commit-retention", LogCleanupService.FencedCommitOperationScope);
    }

    [Fact]
    public void LedgerMigration_IsAdditiveOnlineExpandWithBoundedAuditIndexes()
    {
        const string Id = "20260715-post-active-release-fenced-commit-ledger";
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static item => item.MigrationId == Id);
        OnlineSchemaMigrationMetadata metadata = new OnlineSchemaMigrationCatalog().GetMetadata()[Id];
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.True(descriptor.Transactional);
        Assert.Contains("sys_fenced_commit", fingerprint, StringComparison.Ordinal);
        Assert.Contains("commit_token varchar(32) PRIMARY KEY", fingerprint, StringComparison.Ordinal);
        Assert.Contains("CHECK (generation > 0)", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_sys_fenced_commit_enlisted", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_sys_fenced_commit_generation_time", fingerprint, StringComparison.Ordinal);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, metadata.Phase);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, metadata.RollbackMode);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
    }

    [Fact]
    public void Registration_IncludesTransactionalGuardAndPeriodicAuditor()
    {
        var services = new ServiceCollection();

        services.AddActiveReleaseFencing();

        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(IActiveReleaseTransactionalCommitGuard)
            && descriptor.ImplementationType == typeof(ActiveReleaseTransactionalCommitGuard));
        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(IHostedService)
            && descriptor.ImplementationType == typeof(ActiveReleaseFencedCommitAuditWorker));
    }

    private static void AssertTransactionalGuard(Type workerType)
    {
        Assert.Contains(
            workerType.GetConstructors().SelectMany(static constructor => constructor.GetParameters()),
            static parameter => parameter.ParameterType == typeof(IActiveReleaseTransactionalCommitGuard));
    }

    private static ActiveReleaseExecutionTicket Ticket()
        => new(
            "20260715080000-0123456789ab",
            "green",
            42,
            $"sha256:{new string('a', 64)}",
            "test-process");

    private static IHostEnvironment HostEnvironment(string name)
    {
        IHostEnvironment environment = Substitute.For<IHostEnvironment>();
        environment.EnvironmentName.Returns(name);
        return environment;
    }
}
