using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Services;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class PublicHotReadDbAdmissionTests
{
    [Theory]
    [InlineData("public-hot-read-delta")]
    [InlineData("public-hot-read-view-delta")]
    [InlineData("public-hot-read-taxonomy-delta")]
    [InlineData("public-hot-read-rebuild")]
    [InlineData("public-hot-read-refresh")]
    [InlineData("public-article-projection-build")]
    public void BackgroundRefreshOperations_ClassifyAsBackgroundProjection(string operation)
    {
        Assert.Equal(DbWorkloadClass.BackgroundProjection, DbConcurrencyGate.Classify(operation));
        Assert.NotEqual(DbWorkloadClass.PublicShortRead, DbConcurrencyGate.Classify(operation));
    }

    [Theory]
    [InlineData("article-detail")]
    [InlineData("article-list")]
    [InlineData("article-hot-seed")]
    public void PublicServingOperations_ClassifyAsPublicShortRead(string operation)
    {
        Assert.Equal(DbWorkloadClass.PublicShortRead, DbConcurrencyGate.Classify(operation));
    }

    [Theory]
    [InlineData("article-vault-write")]
    [InlineData("article-publication-write")]
    public void WriteOperations_ClassifyAsForegroundWrite(string operation)
    {
        Assert.Equal(DbWorkloadClass.ForegroundWrite, DbConcurrencyGate.Classify(operation));
    }

    [Fact]
    public async Task SaturatedPublicShortRead_DoesNotAdmitUngatedArticleDetailDbLoad()
    {
        DbConcurrencyGate gate = CreateClassifiedGate(publicShortReadLimit: 1, publicQueueLimit: 1, publicWaitMs: 50);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int projectionDbReads = 0;
        int detailDbLoads = 0;

        Task<string> holder = gate.ExecuteClassifiedAsync(
            DbWorkloadClass.PublicShortRead,
            "public-article-projection-read",
            async _ =>
            {
                entered.TrySetResult();
                await release.Task;
                return "held";
            },
            _ => Task.FromResult("holder-timeout"));
        await entered.Task;

        string projection = await gate.ExecuteClassifiedAsync(
            DbWorkloadClass.PublicShortRead,
            "public-article-projection-read",
            _ =>
            {
                Interlocked.Increment(ref projectionDbReads);
                return Task.FromResult("projection-db");
            },
            _ => Task.FromResult("db-gate-timeout"));
        string detail = await gate.ExecuteAsync(
            "article-detail",
            _ =>
            {
                Interlocked.Increment(ref detailDbLoads);
                return Task.FromResult("detail-db");
            },
            _ => Task.FromResult("db-gate-timeout"));
        string delta = await gate.ExecuteAsync(
            "public-hot-read-delta",
            _ => Task.FromResult("delta"),
            _ => Task.FromResult("delta-timeout"));

        Assert.Equal("db-gate-timeout", projection);
        Assert.Equal("db-gate-timeout", detail);
        Assert.Equal(0, projectionDbReads);
        Assert.Equal(0, detailDbLoads);
        Assert.Equal("delta", delta);

        release.TrySetResult();
        Assert.Equal("held", await holder);
    }

    [Fact]
    public async Task SaturatedForegroundWrite_RejectsVaultAndPublicationWritesWithoutDbWork()
    {
        DbConcurrencyGate gate = CreateClassifiedGate(publicShortReadLimit: 1, publicQueueLimit: 1, publicWaitMs: 50);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int vaultDbWork = 0;
        int publicationDbWork = 0;

        Task<string> holder = gate.ExecuteClassifiedAsync(
            DbWorkloadClass.ForegroundWrite,
            "article-vault-write",
            async _ =>
            {
                entered.TrySetResult();
                await release.Task;
                return "held";
            },
            _ => Task.FromResult("holder-timeout"));
        await entered.Task;

        await Assert.ThrowsAsync<TimeoutException>(() =>
            gate.ExecuteClassifiedAsync(
                DbWorkloadClass.ForegroundWrite,
                "article-vault-write",
                _ =>
                {
                    Interlocked.Increment(ref vaultDbWork);
                    return Task.FromResult("vault-db");
                },
                _ => Task.FromException<string>(new TimeoutException("db-gate-timeout:article-vault-write"))));
        await Assert.ThrowsAsync<TimeoutException>(() =>
            gate.ExecuteClassifiedAsync(
                DbWorkloadClass.ForegroundWrite,
                "article-publication-write",
                _ =>
                {
                    Interlocked.Increment(ref publicationDbWork);
                    return Task.FromResult("publication-db");
                },
                _ => Task.FromException<string>(new TimeoutException("db-gate-timeout:article-publication-write"))));

        Assert.Equal(0, vaultDbWork);
        Assert.Equal(0, publicationDbWork);

        release.TrySetResult();
        Assert.Equal("held", await holder);
    }

    [Fact]
    public void PublicDetailFallback_IsGatedAndLeavesNoUngatedCompatPath()
    {
        string getById = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleService),
            nameof(ArticleService.GetByIdAsync),
            "LoadArticleDetailFromDbAsync",
            "TryReadArticleDetailCacheAsync");
        string binaryArticles = File.ReadAllText(BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Articles.cs"));
        string vaultWriter = File.ReadAllText(BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Services",
            "ArticleService.ArticleVaultWriter.cs"));
        string vaultTransaction = File.ReadAllText(BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Services",
            "ArticleService.ArticleVaultTransaction.cs"));

        Assert.Contains("IDbConcurrencyGate.ExecuteAsync", getById, StringComparison.Ordinal);
        Assert.Contains("article-detail", getById, StringComparison.Ordinal);
        Assert.Contains("db-gate-timeout:article-detail", getById, StringComparison.Ordinal);
        Assert.Contains("LoadArticleDetailFromDbAsync", getById, StringComparison.Ordinal);
        Assert.DoesNotContain("compat", getById, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ungated", getById, StringComparison.OrdinalIgnoreCase);

        Assert.Contains("GetPublicArtifactBackedDetailAsync", binaryArticles, StringComparison.Ordinal);
        Assert.Contains("GetByIdAsync", binaryArticles, StringComparison.Ordinal);
        Assert.DoesNotContain("compat", binaryArticles, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("LoadArticleDetailFromDbAsync", binaryArticles, StringComparison.Ordinal);

        Assert.Contains("ExecuteForegroundWriteAsync", vaultWriter, StringComparison.Ordinal);
        Assert.Contains("article-vault-write", vaultWriter, StringComparison.Ordinal);
        Assert.Contains("UseTranAsync", vaultWriter, StringComparison.Ordinal);
        Assert.Contains("DbWorkloadClass.ForegroundWrite", vaultTransaction, StringComparison.Ordinal);
        Assert.Contains("article-publication-write", vaultTransaction, StringComparison.Ordinal);
        Assert.DoesNotContain("compat", vaultWriter, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("compat", vaultTransaction, StringComparison.OrdinalIgnoreCase);
    }

    private static DbConcurrencyGate CreateClassifiedGate(int publicShortReadLimit, int publicQueueLimit, int publicWaitMs)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:DefaultConnection"] = "Host=localhost;Database=fsus;Username=fsus;Password=fsus;Maximum Pool Size=4",
                ["Database:PublicArticleProjection:MaxPoolSize"] = "1",
                ["Database:ConcurrencyGate:PublicShortRead:Limit"] = publicShortReadLimit.ToString(),
                ["Database:ConcurrencyGate:PublicShortRead:QueueLimit"] = publicQueueLimit.ToString(),
                ["Database:ConcurrencyGate:PublicShortRead:WaitTimeoutMs"] = publicWaitMs.ToString(),
                ["Database:ConcurrencyGate:AdminHeavyRead:Limit"] = "1",
                ["Database:ConcurrencyGate:ForegroundWrite:Limit"] = "1",
                ["Database:ConcurrencyGate:ForegroundWrite:QueueLimit"] = "1",
                ["Database:ConcurrencyGate:ForegroundWrite:WaitTimeoutMs"] = publicWaitMs.ToString(),
                ["Database:ConcurrencyGate:BackgroundProjection:Limit"] = "1"
            })
            .Build();
        return new DbConcurrencyGate(configuration, NullLogger<DbConcurrencyGate>.Instance);
    }
}
