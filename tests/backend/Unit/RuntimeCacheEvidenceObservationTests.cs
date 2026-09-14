using System.Security.Cryptography;
using System.Text;
using System.Diagnostics;

using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Testing;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RuntimeCacheEvidenceObservationTests
{
    private static readonly ActivitySource s_npgsqlActivitySource = new("Npgsql");

    [Fact]
    public void SqlFingerprint_NormalizesLiteralValuesAndWhitespace()
    {
        string first = RuntimeCacheEvidenceObservation.FingerprintSql("SELECT *  FROM article WHERE id = 42 AND title = 'first'");
        string second = RuntimeCacheEvidenceObservation.FingerprintSql("select * from article where id=99 and title='second'");

        Assert.Equal(first, second);
        Assert.StartsWith("sha256:", first, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Middleware_CapturesPayloadSqlAndLayerOnlyForAuthenticatedTestRequest()
    {
        const string Secret = "runtime-cache-evidence-contract-secret";
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] = Secret
            })
            .Build();
        var store = new RuntimeCacheEvidenceStore();
        var middleware = new RuntimeCacheEvidenceMiddleware(
            async context =>
            {
                EmitNpgsqlCommand("select * from article where id = 42");
                RuntimeCacheEvidenceObservation.Current!.MarkLayerSource("l1-frame");
                context.Response.StatusCode = StatusCodes.Status200OK;
                await context.Response.WriteAsync("payload");
            },
            configuration,
            new TestHostEnvironment("Test"),
            store);
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/api/binary/article/42.aeds";
        context.Request.Headers[RuntimeCacheEvidenceMiddleware.RequestIdHeader] = "request-0001";
        context.Request.Headers[RuntimeCacheEvidenceMiddleware.SecretHeader] = Secret;

        await middleware.InvokeAsync(context);

        Assert.True(store.TryTake("request-0001", out RuntimeCacheRequestObservation? observation));
        Assert.NotNull(observation);
        Assert.Equal("l1-frame", observation.LayerSource);
        Assert.Equal(200, observation.Status);
        Assert.Equal(
            $"sha256:{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("payload")))}",
            observation.PayloadDigest);
        Assert.Single(observation.DatabaseFingerprints);
        Assert.Equal(1, observation.DatabaseCommandCount);
        Assert.Equal(0, observation.DatabaseDroppedCommandCount);
        Assert.Equal("complete", observation.DatabaseObservationStatus);
        Assert.True(observation.DatabaseAttributionComplete);
        Assert.Empty(observation.RedisCommands);
        Assert.Null(RuntimeCacheEvidenceObservation.Current);
    }

    [Fact]
    public void DatabaseAttribution_IsBoundedAndTruncationFailsClosed()
    {
        using RuntimeCacheEvidenceObservation observation = RuntimeCacheEvidenceObservation.Begin(
            "request-bounded",
            HttpMethods.Get,
            "/bounded",
            new RuntimeCacheDatabaseObservationLimits(
                MaxCommands: 1,
                MaxSqlUtf8Bytes: 1024,
                MaxInFlightCommands: 2));

        EmitNpgsqlCommand("select * from article where id = 1");
        EmitNpgsqlCommand("select * from article where id = 2");
        RuntimeCacheRequestObservation completed = observation.Complete(200, EmptyPayloadDigest());

        Assert.Equal(2, completed.DatabaseCommandCount);
        Assert.Single(completed.DatabaseFingerprints);
        Assert.Equal(1, completed.DatabaseDroppedCommandCount);
        Assert.Equal("truncated", completed.DatabaseObservationStatus);
        Assert.False(completed.DatabaseAttributionComplete);
    }

    [Fact]
    public void DatabaseAttribution_RejectsOversizedOrMissingProviderSql()
    {
        using RuntimeCacheEvidenceObservation observation = RuntimeCacheEvidenceObservation.Begin(
            "request-invalid-provider-data",
            HttpMethods.Get,
            "/invalid-provider-data",
            new RuntimeCacheDatabaseObservationLimits(
                MaxCommands: 4,
                MaxSqlUtf8Bytes: 16,
                MaxInFlightCommands: 2));

        EmitNpgsqlCommand("select repeat('x', 1000)");
        EmitNpgsqlCommand(sql: null);
        RuntimeCacheRequestObservation completed = observation.Complete(200, EmptyPayloadDigest());

        Assert.Equal(2, completed.DatabaseCommandCount);
        Assert.Empty(completed.DatabaseFingerprints);
        Assert.Equal(2, completed.DatabaseDroppedCommandCount);
        Assert.Equal("truncated", completed.DatabaseObservationStatus);
        Assert.False(completed.DatabaseAttributionComplete);
    }

    [Fact]
    public void DatabaseAttribution_RejectsPerRequestInFlightOverflow()
    {
        using RuntimeCacheEvidenceObservation observation = RuntimeCacheEvidenceObservation.Begin(
            "request-in-flight-overflow",
            HttpMethods.Get,
            "/in-flight-overflow",
            new RuntimeCacheDatabaseObservationLimits(
                MaxCommands: 4,
                MaxSqlUtf8Bytes: 1024,
                MaxInFlightCommands: 1));
        using Activity first = StartNpgsqlCommand("select 1");
        using Activity second = StartNpgsqlCommand("select 2");

        second.Stop();
        first.Stop();
        RuntimeCacheRequestObservation completed = observation.Complete(200, EmptyPayloadDigest());

        Assert.Equal(2, completed.DatabaseCommandCount);
        Assert.Single(completed.DatabaseFingerprints);
        Assert.Equal(1, completed.DatabaseDroppedCommandCount);
        Assert.Equal("truncated", completed.DatabaseObservationStatus);
        Assert.False(completed.DatabaseAttributionComplete);
    }

    [Fact]
    public void DatabaseAttribution_LateCompletionUpdatesStoredReceiptAndFailsClosed()
    {
        var store = new RuntimeCacheEvidenceStore();
        using RuntimeCacheEvidenceObservation observation = RuntimeCacheEvidenceObservation.Begin(
            "request-late",
            HttpMethods.Get,
            "/late");
        using Activity activity = StartNpgsqlCommand("select pg_sleep(1)");

        store.Store(observation, 200, EmptyPayloadDigest());
        activity.Stop();

        Assert.True(store.TryTake("request-late", out RuntimeCacheRequestObservation? completed));
        Assert.NotNull(completed);
        Assert.Equal(1, completed.DatabaseCommandCount);
        Assert.Single(completed.DatabaseFingerprints);
        Assert.Equal(1, completed.DatabaseLateCommandCount);
        Assert.Equal("late", completed.DatabaseObservationStatus);
        Assert.False(completed.DatabaseAttributionComplete);
    }

    [Fact]
    public void DatabaseAttribution_IgnoresApplicationOwnedActivities()
    {
        using RuntimeCacheEvidenceObservation observation = RuntimeCacheEvidenceObservation.Begin(
            "request-app-activity",
            HttpMethods.Get,
            "/app-activity");
        using var applicationSource = new ActivitySource("FsusBlog.ApplicationMetric");
        using var applicationListener = new ActivityListener
        {
            ShouldListenTo = source => ReferenceEquals(source, applicationSource),
            Sample = static (ref ActivityCreationOptions<ActivityContext> _) =>
                ActivitySamplingResult.AllDataAndRecorded
        };
        ActivitySource.AddActivityListener(applicationListener);
        using Activity activity = applicationSource.StartActivity("database-command")
            ?? throw new InvalidOperationException("The application test Activity listener was not active.");
        activity.SetTag("db.query.text", "select 1");
        activity.Stop();

        RuntimeCacheRequestObservation completed = observation.Complete(200, EmptyPayloadDigest());

        Assert.Equal(0, completed.DatabaseCommandCount);
        Assert.Empty(completed.DatabaseFingerprints);
        Assert.Equal("complete", completed.DatabaseObservationStatus);
        Assert.True(completed.DatabaseAttributionComplete);
    }

    [Fact]
    public async Task Middleware_DoesNotCreateObservationWithoutExplicitTestSecret()
    {
        var store = new RuntimeCacheEvidenceStore();
        var middleware = new RuntimeCacheEvidenceMiddleware(
            static context => context.Response.WriteAsync("payload"),
            new ConfigurationBuilder().Build(),
            new TestHostEnvironment(Environments.Production),
            store);
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Request.Headers[RuntimeCacheEvidenceMiddleware.RequestIdHeader] = "request-0002";

        await middleware.InvokeAsync(context);

        Assert.False(store.TryTake("request-0002", out _));
    }

    private sealed class TestHostEnvironment(string environmentName) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = environmentName;
        public string ApplicationName { get; set; } = "RuntimeCacheEvidenceTests";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private static void EmitNpgsqlCommand(string? sql)
    {
        using Activity activity = StartNpgsqlCommand(sql);
        activity.Stop();
    }

    private static Activity StartNpgsqlCommand(string? sql)
    {
        Activity activity = s_npgsqlActivitySource.StartActivity("postgresql", ActivityKind.Client)
            ?? throw new InvalidOperationException("The runtime evidence Npgsql Activity listener was not active.");
        if (sql is not null)
        {
            activity.SetTag("db.query.text", sql);
        }
        return activity;
    }

    private static string EmptyPayloadDigest()
        => $"sha256:{Convert.ToHexStringLower(SHA256.HashData([]))}";
}
