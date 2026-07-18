using System.Data;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Services;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicArticleProjectionContractTests
{
    [Fact]
    public void Migration_ExpandsProjectionBackfillAndMismatchEvidenceWithoutRuntimeDdl()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static migration => migration.MigrationId == "20260714-post-public-article-projection");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.True(descriptor.Transactional);
        Assert.Contains("public_article_projection_version_seq", fingerprint, StringComparison.Ordinal);
        Assert.Contains("public_article_projection", fingerprint, StringComparison.Ordinal);
        Assert.Contains("aeds_payload bytea", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_public_article_projection_visible_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("public_article_projection_backfill", fingerprint, StringComparison.Ordinal);
        Assert.Contains("state IN ('paused', 'running', 'completed')", fingerprint, StringComparison.Ordinal);
        Assert.Contains("current_setting('max_connections')", fingerprint, StringComparison.Ordinal);
        Assert.Contains("public_article_projection_shadow_mismatch", fingerprint, StringComparison.Ordinal);
        string[] runtimeCommands =
        [
            PublicArticleProjectionStore.ReadSql,
            PublicArticleProjectionStore.UpsertSql,
            PublicArticleProjectionStore.MarkUnavailableSql,
            PublicArticleProjectionStore.RecordShadowMismatchSql,
            PublicArticleProjectionStore.ShadowReadSql
        ];
        Assert.All(runtimeCommands, static command =>
        {
            Assert.DoesNotContain("CREATE TABLE", command, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("CREATE INDEX", command, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("ALTER TABLE", command, StringComparison.OrdinalIgnoreCase);
        });
    }

    [Fact]
    public void DirectReader_IsOnePreparedPrimaryKeyQueryWithBinarySequentialRead()
    {
        Assert.Contains("WHERE article_id = $1", PublicArticleProjectionStore.ReadSql, StringComparison.Ordinal);
        Assert.Contains("AND visible = true", PublicArticleProjectionStore.ReadSql, StringComparison.Ordinal);
        Assert.DoesNotContain("JOIN", PublicArticleProjectionStore.ReadSql, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(
            CommandBehavior.SequentialAccess | CommandBehavior.SingleRow,
            PublicArticleProjectionReadContract.Behavior);
        Assert.Equal(0, PublicArticleProjectionReadContract.VersionOrdinal);
        Assert.Equal(1, PublicArticleProjectionReadContract.FrameOrdinal);
        Assert.Equal(2, PublicArticleProjectionReadContract.ETagOrdinal);
        Assert.Equal(3, PublicArticleProjectionReadContract.UpdatedAtOrdinal);
    }

    [Fact]
    public async Task ProjectionWrite_IsCriticalOutboxEdgeAndCoversMutationSources()
    {
        Assert.Contains(ArticleMutationReplayEdges.ArticleDetailAeds, ArticleMutationReplayEdges.Required);
        Assert.True(ArticleMutationEventTypes.s_supported.SetEquals(
        [
            "created",
            "updated",
            "deleted",
            "restored",
            "permanently-deleted",
            "trash-cleared",
            "scheduled-published",
            "category-updated",
            "tag-updated",
            "rights-proof-updated"
        ]));

        var observed = new List<string>();
        await ArticleDetailProjectionCommitSequence.PublishAsync(
            () => RecordAsync("projection-upsert"),
            () => RecordResultAsync("shadow-verify", true),
            () => RecordAsync("artifact-write"));
        Assert.Equal(["projection-upsert", "shadow-verify", "artifact-write"], observed);

        observed.Clear();
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            ArticleDetailProjectionCommitSequence.PublishAsync(
                () => RecordAsync("projection-upsert"),
                () => RecordResultAsync("shadow-verify", false),
                () => RecordAsync("artifact-write")));
        Assert.Equal(["projection-upsert", "shadow-verify"], observed);

        Task RecordAsync(string value)
        {
            observed.Add(value);
            return Task.CompletedTask;
        }

        async Task<bool> RecordResultAsync(string value, bool result)
        {
            await RecordAsync(value);
            return result;
        }
    }

    [Fact]
    public async Task RuntimeCutoverAndBackfill_HaveReloadRollbackAndDurablePauseResume()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:DefaultConnection"] = "Host=localhost;Database=fsus;Username=fsus;Password=fsus",
                [PublicArticleProjectionReadContract.EnabledConfigurationKey] = "false"
            })
            .Build();
        var runtime = new PublicArticleProjectionRuntimeState();
        await using var dataSources = new PublicArticleProjectionDataSourceProvider(configuration, runtime);
        var store = new PublicArticleProjectionStore(
            dataSources,
            runtime,
            new PublicArticleProjectionNegativeCache(TimeProvider.System),
            Substitute.For<ISqlSugarClient>(),
            Substitute.For<ITestSessionContext>(),
            Substitute.For<IDbConcurrencyGate>(),
            new AedsEncoder(),
            configuration,
            NullLogger<PublicArticleProjectionStore>.Instance);

        PublicArticleProjectionReadResult disabled = await store.TryReadAsync(42);

        Assert.Equal(PublicArticleProjectionReadStatus.Unavailable, disabled.Status);
        Assert.Equal("cutover-disabled", disabled.Error);
        Assert.Equal(0, runtime.Snapshot().Reads);
        Assert.Equal(4, PublicArticleProjectionBackfillPolicy.ResolveParallelism(20, 10, 4));
        Assert.Equal(2, PublicArticleProjectionBackfillPolicy.ResolveParallelism(2, 10, 8));
        Assert.Equal(32, PublicArticleProjectionBackfillPolicy.ResolveBatchSize(1));
        Assert.Equal(512, PublicArticleProjectionBackfillPolicy.ResolveBatchSize(64));
        Assert.Equal("public-article-projection-backfill-status", PublicArticleProjectionAdminActions.Status);
        Assert.Equal("public-article-projection-backfill-pause", PublicArticleProjectionAdminActions.Pause);
        Assert.Equal("public-article-projection-backfill-resume", PublicArticleProjectionAdminActions.Resume);

        var observed = new List<string>();
        await ArticleDetailProjectionCommitSequence.MarkUnavailableAsync(
            () => RecordAsync("projection-unavailable"),
            () => RecordAsync("artifact-remove"));
        Assert.Equal(["projection-unavailable", "artifact-remove"], observed);

        Task RecordAsync(string value)
        {
            observed.Add(value);
            return Task.CompletedTask;
        }
    }

    [Fact]
    public async Task ClassifiedGate_BackgroundSaturationDoesNotStarvePublicRead()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:DefaultConnection"] = "Host=localhost;Database=fsus;Username=fsus;Password=fsus;Maximum Pool Size=8",
                ["Database:PublicArticleProjection:MaxPoolSize"] = "2",
                ["Database:ConcurrencyGate:PublicShortRead:Limit"] = "1",
                ["Database:ConcurrencyGate:PublicShortRead:QueueLimit"] = "2",
                ["Database:ConcurrencyGate:BackgroundProjection:Limit"] = "1",
                ["Database:ConcurrencyGate:BackgroundProjection:QueueLimit"] = "1",
                ["Database:ConcurrencyGate:BackgroundProjection:WaitTimeoutMs"] = "50"
            })
            .Build();
        var gate = new DbConcurrencyGate(configuration, NullLogger<DbConcurrencyGate>.Instance);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<string> background = gate.ExecuteClassifiedAsync(
            DbWorkloadClass.BackgroundProjection,
            "projection-rebuild",
            async _ =>
            {
                entered.TrySetResult();
                await release.Task;
                return "background";
            },
            _ => Task.FromResult("background-timeout"));
        await entered.Task;

        string publicResult = await gate.ExecuteClassifiedAsync(
            DbWorkloadClass.PublicShortRead,
            "public-article-projection-read",
            _ => Task.FromResult("public"),
            _ => Task.FromResult("public-timeout"));

        Assert.Equal("public", publicResult);
        DbConcurrencyGateDiagnostics diagnostics = gate.GetDiagnostics();
        Assert.Equal(8, diagnostics.MainPoolCapacity);
        Assert.Equal(2, diagnostics.PublicProjectionPoolCapacity);
        Assert.Equal(4, diagnostics.Workloads.Count);
        Assert.Equal(1, diagnostics.Workloads["background-projection-rebuild"].InUse);
        release.TrySetResult();
        Assert.Equal("background", await background);
    }

    [Fact]
    public async Task ClassifiedGate_AllFourWorkloadsRunWithIndependentCapacityAndMetrics()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:DefaultConnection"] = "Host=localhost;Database=fsus;Username=fsus;Password=fsus;Maximum Pool Size=6",
                ["Database:PublicArticleProjection:MaxPoolSize"] = "1",
                ["Database:ConcurrencyGate:PublicShortRead:Limit"] = "1",
                ["Database:ConcurrencyGate:AdminHeavyRead:Limit"] = "1",
                ["Database:ConcurrencyGate:ForegroundWrite:Limit"] = "1",
                ["Database:ConcurrencyGate:BackgroundProjection:Limit"] = "1"
            })
            .Build();
        var gate = new DbConcurrencyGate(configuration, NullLogger<DbConcurrencyGate>.Instance);
        var entered = new CountdownEvent(4);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        Task<bool>[] running = Enum.GetValues<DbWorkloadClass>()
            .Select(workload => gate.ExecuteClassifiedAsync(
                workload,
                $"isolation-{workload}",
                async _ =>
                {
                    entered.Signal();
                    await release.Task;
                    return true;
                },
                _ => Task.FromResult(false)))
            .ToArray();

        Assert.True(entered.Wait(TimeSpan.FromSeconds(2)));
        DbConcurrencyGateDiagnostics diagnostics = gate.GetDiagnostics();
        Assert.All(diagnostics.Workloads.Values, static snapshot => Assert.Equal(1, snapshot.InUse));
        Assert.All(diagnostics.Workloads.Values, static snapshot => Assert.Equal(1, snapshot.Limit));

        release.TrySetResult();
        Assert.All(await Task.WhenAll(running), Assert.True);
        Assert.All(gate.GetDiagnostics().Workloads.Values, static snapshot => Assert.Equal(1, snapshot.Completed));
    }

}
