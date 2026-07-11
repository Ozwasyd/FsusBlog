using System.Net;
using System.Text;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CrawlerRangeSyncBehaviorTests
{
    private static readonly DateTimeOffset StartTime = DateTimeOffset.Parse("2026-07-11T08:00:00Z");

    [Fact]
    public async Task SynchronizeOnceAsync_FetchesProvidersConcurrentlyAndUsesRemoteThenSnapshotFallback()
    {
        using var root = new TemporaryDirectory();
        WriteSnapshot(root.Path, google: ["192.0.2.0/24"], bing: ["198.51.100.0/24"]);
        var googleStarted = NewSignal();
        var bingStarted = NewSignal();
        var release = NewSignal();
        var handler = new DelegateHttpMessageHandler(async (request, token) =>
        {
            TaskCompletionSource started = request.RequestUri!.Host.Contains("google", StringComparison.Ordinal)
                ? googleStarted
                : bingStarted;
            started.TrySetResult();
            await release.Task.WaitAsync(token);
            if (request.RequestUri.Host.Contains("bing", StringComparison.Ordinal))
            {
                throw new HttpRequestException("bing unavailable");
            }

            return JsonResponse("66.249.64.0/19");
        });
        var clock = new ManualTimeProvider(StartTime);
        await using WorkerFixture fixture = CreateFixture(root.Path, handler, clock);

        Task<CrawlerRangeSyncResponse> pending = fixture.Worker.SynchronizeOnceAsync();
        await googleStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        await bingStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.False(pending.IsCompleted);
        release.TrySetResult();
        CrawlerRangeSyncResponse response = await pending;

        Assert.Equal("degraded", response.Outcome);
        Assert.Equal("remote", response.Status.Source);
        Assert.Equal(1, response.Status.GoogleRanges);
        Assert.Equal(1, response.Status.BingRanges);
        Assert.NotNull(response.Status.LastError);
        Assert.Contains("bing:HttpRequestException", response.Status.LastError, StringComparison.Ordinal);
        Assert.True(await fixture.Detector.IsVerifiedCrawlerAsync("66.249.64.1", "Googlebot"));
        Assert.False(await fixture.Detector.IsVerifiedCrawlerAsync("192.0.2.1", "Googlebot"));
        Assert.True(await fixture.Detector.IsVerifiedCrawlerAsync("198.51.100.1", "bingbot"));
        Assert.Empty(Directory.GetFiles(Path.Combine(root.Path, "security"), "*.tmp"));
    }

    [Fact]
    public async Task SynchronizeOnceAsync_FallsBackToConfigWhenRemoteAndSnapshotAreUnavailable()
    {
        using var root = new TemporaryDirectory();
        Directory.CreateDirectory(Path.Combine(root.Path, "security"));
        File.WriteAllText(SnapshotPath(root.Path), "not-json");
        var handler = new DelegateHttpMessageHandler((_, _) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)));
        await using WorkerFixture fixture = CreateFixture(
            root.Path,
            handler,
            new ManualTimeProvider(StartTime),
            googleConfig: "203.0.113.0/24",
            bingConfig: "2001:db8::/32");

        CrawlerRangeSyncResponse response = await fixture.Worker.SynchronizeOnceAsync();

        Assert.Equal("degraded", response.Outcome);
        Assert.Equal("config", response.Status.Source);
        Assert.True(await fixture.Detector.IsVerifiedCrawlerAsync("203.0.113.7", "Googlebot"));
        Assert.True(await fixture.Detector.IsVerifiedCrawlerAsync("2001:db8::7", "bingbot"));
    }

    [Fact]
    public async Task SynchronizeOnceAsync_RejectsReentryAndPublishesCompleteSuccessStatus()
    {
        using var root = new TemporaryDirectory();
        var googleStarted = NewSignal();
        var bingStarted = NewSignal();
        var release = NewSignal();
        var handler = new DelegateHttpMessageHandler(async (request, token) =>
        {
            (request.RequestUri!.Host.Contains("google", StringComparison.Ordinal) ? googleStarted : bingStarted).TrySetResult();
            await release.Task.WaitAsync(token);
            return JsonResponse(request.RequestUri.Host.Contains("google", StringComparison.Ordinal)
                ? "66.249.64.0/19"
                : "40.77.167.0/24");
        });
        var clock = new ManualTimeProvider(StartTime);
        await using WorkerFixture fixture = CreateFixture(root.Path, handler, clock);

        Task<CrawlerRangeSyncResponse> first = fixture.Worker.SynchronizeOnceAsync();
        await googleStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        await bingStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        CrawlerRangeSyncResponse reentry = await fixture.Worker.SynchronizeOnceAsync();
        Assert.Equal("already_running", reentry.Outcome);
        Assert.True(reentry.Status.Running);

        clock.Advance(TimeSpan.FromSeconds(3));
        release.TrySetResult();
        CrawlerRangeSyncResponse completed = await first;

        Assert.Equal("success", completed.Outcome);
        Assert.False(completed.Status.Running);
        Assert.Equal(StartTime, completed.Status.LastStartedAt);
        Assert.Equal(StartTime.AddSeconds(3), completed.Status.LastFinishedAt);
        Assert.Equal(completed.Status.LastFinishedAt, completed.CompletedAtUtc);
        Assert.Equal("success", fixture.Worker.GetStatus().LastOutcome);
    }

    [Fact]
    public async Task SynchronizeOnceAsync_CancellationPublishesFinishedCanceledStatus()
    {
        using var root = new TemporaryDirectory();
        var requestStarted = NewSignal();
        var handler = new DelegateHttpMessageHandler(async (_, token) =>
        {
            requestStarted.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            return JsonResponse("66.249.64.0/19");
        });
        var clock = new ManualTimeProvider(StartTime);
        await using WorkerFixture fixture = CreateFixture(root.Path, handler, clock);
        using var cancellation = new CancellationTokenSource();

        Task<CrawlerRangeSyncResponse> pending = fixture.Worker.SynchronizeOnceAsync(cancellation.Token);
        await requestStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        clock.Advance(TimeSpan.FromSeconds(5));
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        CrawlerRangesAdminStatus status = fixture.Worker.GetStatus();
        Assert.False(status.Running);
        Assert.Equal("canceled", status.LastOutcome);
        Assert.Equal(StartTime.AddSeconds(5), status.LastFinishedAt);
    }

    [Theory]
    [InlineData("http://developers.google.com/static/search/apis/ipranges/googlebot.json", null)]
    [InlineData("https://169.254.169.254/latest/meta-data/", null)]
    [InlineData(null, "../outside.json")]
    [InlineData(null, "/tmp/outside.json")]
    public async Task SynchronizeOnceAsync_UnsafeUrlOrSnapshotPathFailsClosed(
        string? googleUrl,
        string? snapshotPath)
    {
        using var root = new TemporaryDirectory();
        var handler = new DelegateHttpMessageHandler((_, _) =>
            throw new InvalidOperationException("HTTP must not be reached"));
        var clock = new ManualTimeProvider(StartTime);
        await using WorkerFixture fixture = CreateFixture(
            root.Path,
            handler,
            clock,
            googleUrl: googleUrl,
            snapshotPath: snapshotPath);

        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Worker.SynchronizeOnceAsync());

        CrawlerRangesAdminStatus status = fixture.Worker.GetStatus();
        Assert.False(status.Running);
        Assert.Equal("InvalidOperationException", status.LastOutcome);
        Assert.Equal(StartTime, status.LastFinishedAt);
        Assert.Equal(0, handler.CallCount);
    }

    private static WorkerFixture CreateFixture(
        string dataRoot,
        HttpMessageHandler handler,
        TimeProvider clock,
        string? googleConfig = null,
        string? bingConfig = null,
        string? googleUrl = null,
        string? snapshotPath = null)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["FSUSBLOG_DATA_ROOT"] = dataRoot,
                ["Security:CrawlerCidrs:Google"] = googleConfig,
                ["Security:CrawlerCidrs:Bing"] = bingConfig
            })
            .Build();
        var detector = new CrawlerDetectorService(
            NullLogger<CrawlerDetectorService>.Instance,
            new MemoryCache(new MemoryCacheOptions()),
            configuration);
        ServiceProvider services = new ServiceCollection()
            .AddSingleton(detector)
            .BuildServiceProvider();
        var policy = new FixedPolicyProvider(CreateOptions(googleUrl, snapshotPath));
        var worker = new CrawlerUpdateWorker(
            services,
            configuration,
            new StubHttpClientFactory(handler),
            policy,
            NullLogger<CrawlerUpdateWorker>.Instance,
            new PassThroughWorkerLease(),
            clock);
        return new WorkerFixture(worker, detector, services);
    }

    private static AntiCrawlerPolicyOptions CreateOptions(string? googleUrl, string? snapshotPath)
        => new(
            SecuritySystemModes.Enforce,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            50,
            100,
            200,
            600,
            3,
            100,
            2,
            1000,
            120,
            2,
            1000,
            30,
            30,
            1440,
            0,
            30,
            googleUrl ?? "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
            "https://www.bing.com/toolbox/bingbot.json",
            snapshotPath,
            ["/", "/article/"],
            ["python", "curl"],
            "security.pow");

    private static HttpResponseMessage JsonResponse(string cidr)
    {
        string property = cidr.Contains(':') ? "ipv6Prefix" : "ipv4Prefix";
        string json = $"{{\"prefixes\":[{{\"{property}\":\"{cidr}\"}}]}}";
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                json,
                Encoding.UTF8,
                "application/json")
        };
    }

    private static void WriteSnapshot(string root, IReadOnlyList<string> google, IReadOnlyList<string> bing)
    {
        Directory.CreateDirectory(Path.Combine(root, "security"));
        File.WriteAllText(
            SnapshotPath(root),
            System.Text.Json.JsonSerializer.Serialize(new
            {
                Google = google,
                Bing = bing,
                SavedAt = StartTime.AddDays(-1)
            }));
    }

    private static string SnapshotPath(string root)
        => Path.Combine(root, "security", "crawler-ranges.snapshot.json");

    private static TaskCompletionSource NewSignal()
        => new(TaskCreationOptions.RunContinuationsAsynchronously);

    private sealed class FixedPolicyProvider(AntiCrawlerPolicyOptions options) : IAntiCrawlerPolicyProvider
    {
        public AntiCrawlerPolicySnapshot Current { get; } = new("test", StartTime, "test", "test", options);
    }

    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name)
            => new(handler, disposeHandler: false);
    }

    private sealed class DelegateHttpMessageHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        public int CallCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            CallCount++;
            return send(request, cancellationToken);
        }
    }

    private sealed class PassThroughWorkerLease : IBackgroundWorkerLease
    {
        public async Task<bool> TryRunAsLeaderAsync(
            string workerName,
            Func<CancellationToken, Task> action,
            CancellationToken cancellationToken = default)
        {
            await action(cancellationToken);
            return true;
        }
    }

    private sealed class ManualTimeProvider(DateTimeOffset initial) : TimeProvider
    {
        private long _utcTicks = initial.UtcTicks;

        public override DateTimeOffset GetUtcNow()
            => new(Interlocked.Read(ref _utcTicks), TimeSpan.Zero);

        public void Advance(TimeSpan duration)
            => Interlocked.Add(ref _utcTicks, duration.Ticks);
    }

    private sealed class WorkerFixture(
        CrawlerUpdateWorker worker,
        CrawlerDetectorService detector,
        ServiceProvider services) : IAsyncDisposable
    {
        public CrawlerUpdateWorker Worker { get; } = worker;
        public CrawlerDetectorService Detector { get; } = detector;

        public async ValueTask DisposeAsync()
        {
            Worker.Dispose();
            await services.DisposeAsync();
        }
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"fsus-crawler-sync-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            if (Directory.Exists(Path))
            {
                Directory.Delete(Path, recursive: true);
            }
        }
    }
}
