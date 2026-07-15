using System.Data;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.VisitLog;
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
            configuration);
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
            configuration);
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
        string source = BackendTestPaths.ReadAllTextFromRoot(
            "src/backend/Infrastructure/Operations/ActiveReleaseFencedCommit.cs");

        Assert.Contains("db.Ado.Transaction is null", source, StringComparison.Ordinal);
        Assert.Contains("pg_advisory_xact_lock_shared(1179862354)", source, StringComparison.Ordinal);
        Assert.Contains("FROM sys_deployment_fence", source, StringComparison.Ordinal);
        Assert.Contains("FOR SHARE", source, StringComparison.Ordinal);
        Assert.Contains("INSERT INTO sys_fenced_commit", source, StringComparison.Ordinal);
        Assert.Contains("clock_timestamp() AT TIME ZONE 'utc'", source, StringComparison.Ordinal);
        Assert.Contains("process_instance_id", source, StringComparison.Ordinal);
        Assert.Contains("FROM matching_fence", source, StringComparison.Ordinal);
        Assert.Contains("ActiveReleaseFenceLostException", source, StringComparison.Ordinal);
        Assert.DoesNotContain("StackExchange.Redis", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AuditWorker_DetectsPostRevokePostSwitchAndImpossibleFutureGenerationCommits()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot(
            "src/backend/Infrastructure/Operations/ActiveReleaseFencedCommit.cs");

        Assert.Contains("committed.generation > fence.generation", source, StringComparison.Ordinal);
        Assert.Contains("fence.status = 'revoked'", source, StringComparison.Ordinal);
        Assert.Contains("committed.generation < fence.generation", source, StringComparison.Ordinal);
        Assert.Contains("fence.activated_at_utc", source, StringComparison.Ordinal);
        Assert.Contains("logger.LogCritical", source, StringComparison.Ordinal);
        Assert.Contains("fsus.active_release_fenced_commit.violations", source, StringComparison.Ordinal);
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
        AssertTransactionalGuard(
            typeof(ScheduledPublishWorker),
            "src/backend/Services/Background/ScheduledPublishWorker.cs",
            "scheduled-publish");
        AssertTransactionalGuard(
            typeof(ArticleMutationOutboxDispatcher),
            "src/backend/Services/Background/ArticleMutationOutboxDispatcher.cs",
            "article-outbox-complete");
        AssertTransactionalGuard(
            typeof(ArticleViewProjectionRepairWorker),
            "src/backend/Services/VisitLog/ArticleViewProjectionRepairWorker.cs",
            "article-view-projection");
        AssertTransactionalGuard(
            typeof(LogCleanupService),
            "src/backend/Services/Background/LogCleanupService.cs",
            "fenced-commit-retention");
    }

    [Fact]
    public void LedgerMigration_IsAdditiveOnlineExpandWithBoundedAuditIndexes()
    {
        const string id = "20260715-post-active-release-fenced-commit-ledger";
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static item => item.MigrationId == id);
        OnlineSchemaMigrationMetadata metadata = new OnlineSchemaMigrationCatalog().GetMetadata()[id];
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

    private static void AssertTransactionalGuard(
        Type workerType,
        string relativeSource,
        string operationScope)
    {
        Assert.Contains(
            workerType.GetConstructors().SelectMany(static constructor => constructor.GetParameters()),
            static parameter => parameter.ParameterType == typeof(IActiveReleaseTransactionalCommitGuard));
        string source = BackendTestPaths.ReadAllTextFromRoot(relativeSource);
        Assert.Contains("IActiveReleaseTransactionalCommitGuard", source, StringComparison.Ordinal);
        Assert.Contains(operationScope, source, StringComparison.Ordinal);
        Assert.True(
            source.Contains("EnlistAsync", StringComparison.Ordinal)
            || source.Contains("ActiveReleaseFencedTransaction.ExecuteAsync", StringComparison.Ordinal));
    }

    private static ActiveReleaseExecutionTicket Ticket()
        => new(
            "20260715080000-0123456789ab",
            "green",
            42,
            $"sha256:{new string('a', 64)}",
            "test-process");
}
