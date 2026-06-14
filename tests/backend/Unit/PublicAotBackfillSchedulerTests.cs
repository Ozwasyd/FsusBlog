using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Services.Background;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using NSubstitute;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotBackfillSchedulerTests
{
    [Fact]
    public void TrySchedule_WhenQueueIsFull_ReturnsFalse_AndDoesNotLeakInFlight()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PublicAot:BackfillQueueCapacity"] = "32"
            })
            .Build();
        var scheduler = new PublicAotBackfillScheduler(configuration);
        for (int i = 0; i < scheduler.QueueCapacity; i++)
        {
            bool queued = scheduler.TrySchedule(new PublicAotBackfillRequest(
                PublicPageKind.Home,
                $"home:{i}",
                "/",
                string.Empty,
                $"cache:{i}"));
            Assert.True(queued);
        }

        bool overflowQueued = scheduler.TrySchedule(new PublicAotBackfillRequest(
            PublicPageKind.ArticleDetail,
            "article:99",
            "/article/99",
            string.Empty,
            "cache:overflow"));

        Assert.False(overflowQueued);
        Assert.Equal(scheduler.QueueCapacity, scheduler.InFlightCount);
        Assert.Equal(32, scheduler.QueueCapacity);
    }

    [Fact]
    public void TrySchedule_DuplicateCacheKey_IsDeduplicated()
    {
        IConfiguration configuration = new ConfigurationBuilder().Build();
        var scheduler = new PublicAotBackfillScheduler(configuration);
        var first = new PublicAotBackfillRequest(PublicPageKind.Home, "home", "/", string.Empty, "cache:dup");
        var second = new PublicAotBackfillRequest(PublicPageKind.Home, "home", "/", string.Empty, "cache:dup");

        bool firstQueued = scheduler.TrySchedule(first);
        bool secondQueued = scheduler.TrySchedule(second);

        Assert.True(firstQueued);
        Assert.False(secondQueued);
        Assert.Equal(1, scheduler.InFlightCount);
    }

    [Theory]
    [InlineData(-1, 1)]
    [InlineData(0, 1)]
    [InlineData(1, 1)]
    [InlineData(4, 4)]
    [InlineData(99, 8)]
    public void NormalizeBackfillConcurrency_ClampsDatabasePressure(int configured, int expected)
    {
        Assert.Equal(expected, PublicAotBackfillWorker.NormalizeBackfillConcurrency(configured));
    }

    [Fact]
    public void PublicAotBackfillWorker_SourceDoesNotMutateSingletonHttpContextAccessor()
    {
        string source = ReadSource("src/backend/Services/Background/PublicAotBackfillWorker.cs");

        Assert.DoesNotContain("IHttpContextAccessor", source, StringComparison.Ordinal);
        Assert.DoesNotContain("DefaultHttpContext", source, StringComparison.Ordinal);
        Assert.DoesNotContain("HttpContext =", source, StringComparison.Ordinal);
        Assert.Contains("BeginScope(request.TestSessionId)", source, StringComparison.Ordinal);
    }

    [Fact]
    public async Task HttpTestSessionKeyScope_BeginScope_FlowsAcrossAwaitsAndRestores()
    {
        var environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns("Test");
        var keyScope = new HttpTestSessionKeyScope(new HttpContextAccessor(), environment);

        Assert.Null(keyScope.SessionId);
        using (keyScope.BeginScope("PW-0"))
        {
            Assert.Equal("pw-0", keyScope.SessionId);
            Assert.Equal("e2e:pw-0:cache:key", keyScope.PrefixKey("cache:key"));
            await Task.Yield();
            Assert.Equal("pw-0", keyScope.SessionId);
        }

        Assert.Null(keyScope.SessionId);
    }

    private static string ReadSource(string relativePath)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            string path = Path.Combine(directory.FullName, relativePath);
            if (File.Exists(path))
            {
                return File.ReadAllText(path);
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException($"Unable to locate {relativePath}.");
    }
}
