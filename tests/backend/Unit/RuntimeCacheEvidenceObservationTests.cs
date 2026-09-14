using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Testing;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RuntimeCacheEvidenceObservationTests
{
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
                RuntimeCacheEvidenceObservation.Current!.RecordDatabaseCommand("select * from article where id = 42");
                RuntimeCacheEvidenceObservation.Current.MarkLayerSource("l1-frame");
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
        Assert.Empty(observation.RedisCommands);
        Assert.Null(RuntimeCacheEvidenceObservation.Current);
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
}
