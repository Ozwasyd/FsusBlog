using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

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
        string runtime = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "backend",
            "Infrastructure",
            "PublicReadArtifacts",
            "PublicArticleProjectionStore.cs");

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
        Assert.DoesNotContain("CREATE TABLE", runtime, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("CREATE INDEX", runtime, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ALTER TABLE", runtime, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void DirectReader_IsOnePreparedPrimaryKeyQueryWithBinarySequentialRead()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "backend",
            "Infrastructure",
            "PublicReadArtifacts",
            "PublicArticleProjectionStore.cs");
        string readMethod = Slice(source, "private async Task<PublicArticleProjectionReadResult> ReadCoreAsync", "private async Task ExecuteWriteAsync");

        Assert.Contains("WHERE article_id = $1", PublicArticleProjectionStore.ReadSql, StringComparison.Ordinal);
        Assert.Contains("AND visible = true", PublicArticleProjectionStore.ReadSql, StringComparison.Ordinal);
        Assert.DoesNotContain("JOIN", PublicArticleProjectionStore.ReadSql, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(1, CountOccurrences(readMethod, "PrepareAsync("));
        Assert.Equal(1, CountOccurrences(readMethod, "ExecuteReaderAsync("));
        Assert.Contains("CommandBehavior.SequentialAccess | CommandBehavior.SingleRow", readMethod, StringComparison.Ordinal);
        Assert.Contains("reader.GetInt64(0)", readMethod, StringComparison.Ordinal);
        Assert.Contains("GetFieldValueAsync<byte[]>(1", readMethod, StringComparison.Ordinal);
        Assert.Contains("reader.GetString(2)", readMethod, StringComparison.Ordinal);
        Assert.Contains("reader.GetDateTime(3)", readMethod, StringComparison.Ordinal);
        Assert.Contains("aeds.TryDecode(frame)", source, StringComparison.Ordinal);
        Assert.Contains("etag-mismatch", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ProjectionWrite_IsCriticalOutboxEdgeAndCoversMutationSources()
    {
        string sideEffects = BackendTestPaths.ReadAllTextFromRoot("src", "backend", "Services", "ArticleMutationSideEffects.cs");
        string projector = BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Infrastructure", "PublicReadArtifacts", "ArticleDetailAedsArtifactStore.cs");
        string article = BackendTestPaths.ReadAllTextFromRoot("src", "backend", "Services", "ArticleService.cs");
        string taxonomy = BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Modules", "Endpoints", "Binary", "BinaryEndpoints.Taxonomy.cs");
        string scheduled = BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Services", "Background", "ScheduledPublishWorker.cs");
        string proof = BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Infrastructure", "Integrity", "IntegrityProofPipeline.cs");

        Assert.Contains("ArticleDetailAeds", sideEffects, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationReplayEdges.Required", sideEffects, StringComparison.Ordinal);
        Assert.True(
            sideEffects.IndexOf("articleDetailArtifacts.GenerateAndStoreAsync", StringComparison.Ordinal)
            < sideEffects.IndexOf("ScheduleIntegrityProofIfRequiredEdgesCompleteAsync", StringComparison.Ordinal));
        Assert.True(
            projector.IndexOf("publicProjection.UpsertAsync", StringComparison.Ordinal)
            < projector.IndexOf("store.WriteAsync", StringComparison.Ordinal));
        Assert.Contains("publicProjection.MarkUnavailableAsync", projector, StringComparison.Ordinal);
        foreach (string mutation in new[] { "created", "updated", "deleted", "restored", "permanently-deleted", "trash-cleared" })
        {
            Assert.Contains($"\"{mutation}\"", article, StringComparison.Ordinal);
        }

        Assert.Contains("scheduled-published", scheduled, StringComparison.Ordinal);
        Assert.Contains("category-updated", taxonomy, StringComparison.Ordinal);
        Assert.Contains("tag-updated", taxonomy, StringComparison.Ordinal);
        Assert.Contains("UseTranAsync", taxonomy, StringComparison.Ordinal);
        Assert.Contains("rights-proof-updated", proof, StringComparison.Ordinal);
        Assert.Contains("UseTranAsync", proof, StringComparison.Ordinal);
    }

    [Fact]
    public void RuntimeCutoverAndBackfill_HaveReloadRollbackAndDurablePauseResume()
    {
        string store = BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Infrastructure", "PublicReadArtifacts", "PublicArticleProjectionStore.cs");
        string maintenance = BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Infrastructure", "PublicReadArtifacts", "ArticleDetailAedsArtifactStore.cs");
        string operations = BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Infrastructure", "Operations", "AdminOperationsService.cs");

        Assert.Contains("Database:PublicArticleProjection:Enabled", store, StringComparison.Ordinal);
        Assert.Contains("cutover-disabled", store, StringComparison.Ordinal);
        Assert.Contains("last_article_id", maintenance, StringComparison.Ordinal);
        Assert.Contains("rate_per_second", maintenance, StringComparison.Ordinal);
        Assert.Contains("ResolveBackfillParallelism", maintenance, StringComparison.Ordinal);
        Assert.Contains("ResolveProjectionBackfillBatchSize", maintenance, StringComparison.Ordinal);
        Assert.DoesNotContain("Environment.ProcessorCount", maintenance, StringComparison.Ordinal);
        Assert.Contains("public-article-projection-backfill-pause", operations, StringComparison.Ordinal);
        Assert.Contains("public-article-projection-backfill-resume", operations, StringComparison.Ordinal);
        Assert.Contains("public-article-projection-backfill-status", operations, StringComparison.Ordinal);
        string plan = BackendTestPaths.ReadAllTextFromRoot("tools", "perf", "public-article-projection-plan.sql");
        Assert.Equal(2, CountOccurrences(plan, "EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)"));
        Assert.Contains("FROM public_article_projection", plan, StringComparison.Ordinal);
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

    private static string Slice(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        int endIndex = source.IndexOf(end, startIndex + start.Length, StringComparison.Ordinal);
        Assert.True(startIndex >= 0 && endIndex > startIndex);
        return source[startIndex..endIndex];
    }

    private static int CountOccurrences(string source, string value)
    {
        int count = 0;
        int offset = 0;
        while ((offset = source.IndexOf(value, offset, StringComparison.Ordinal)) >= 0)
        {
            count++;
            offset += value.Length;
        }

        return count;
    }
}
