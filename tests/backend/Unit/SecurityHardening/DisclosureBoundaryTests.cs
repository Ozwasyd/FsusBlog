using System.Net;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests.Unit.SecurityHardening;

public sealed class DisclosureBoundaryTests
{
    [Fact]
    public async Task ProductionExceptionResponse_DoesNotExposeMessageStackSqlPathOrType()
    {
        const string Secret = "SELECT password FROM account; /srv/fsus/private; Internal.Namespace.SecretType";
        var middleware = new GlobalExceptionMiddleware(
            _ => throw new InvalidOperationException(Secret),
            NullLogger<GlobalExceptionMiddleware>.Instance,
            new TestHostEnvironment(Environments.Production));
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(context);

        string message = DecodeApiErrorMessage((MemoryStream)context.Response.Body);
        Assert.Equal(StatusCodes.Status500InternalServerError, context.Response.StatusCode);
        Assert.Equal("服务器内部错误，请稍后重试", message);
        Assert.DoesNotContain("SELECT", message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("/srv/", message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("SecretType", message, StringComparison.Ordinal);
        Assert.DoesNotContain("InvalidOperationException", message, StringComparison.Ordinal);
    }

    [Fact]
    public void StartupValidationReport_ContainsRequirementStateButNotConfiguredSecretValues()
    {
        const string SecretMarker = "raw-secret-marker-must-not-appear";
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Jwt:SecretKey"] = SecretMarker,
                ["ConnectionStrings:DefaultConnection"] = $"Host=db;Password={SecretMarker}",
                ["ConnectionStrings:Redis"] = $"redis:6379,password={SecretMarker}"
            })
            .Build();

        ProductionStartupValidationReport report = ProductionStartupValidator.CreateValidationReport(
            configuration,
            enforceProductionRules: true);
        string observable = JsonSerializer.Serialize(report);

        Assert.DoesNotContain(SecretMarker, observable, StringComparison.Ordinal);
        Assert.Contains("Jwt:SecretKey", observable, StringComparison.Ordinal);
        Assert.DoesNotContain("Password=", observable, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task LocalFixtureStatus_ExposesOnlyBooleanStateAndFailsClosedForSecretOrNetworkMismatch()
    {
        var options = new WebApplicationOptions { EnvironmentName = Environments.Development };
        WebApplicationBuilder builder = WebApplication.CreateBuilder(options);
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            [LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey] = "true",
            [LocalAuthFixtureEndpoints.LocalAuthFixtureSecretConfigurationKey] = "fixture-secret-value"
        });
        await using WebApplication app = builder.Build();
        app.Use(async (context, next) =>
        {
            context.Connection.RemoteIpAddress = context.Request.Headers["X-Test-External"] == "1"
                ? IPAddress.Parse("203.0.113.10")
                : IPAddress.Loopback;
            await next();
        });
        app.MapLocalAuthFixtureEndpoints();
        await app.StartAsync();
        using HttpClient client = app.GetTestClient();

        using HttpResponseMessage missingSecret = await client.GetAsync("/api/local/auth-fixture/status");
        Assert.Equal(HttpStatusCode.Unauthorized, missingSecret.StatusCode);
        Assert.DoesNotContain("fixture-secret-value", await missingSecret.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        using var externalRequest = new HttpRequestMessage(HttpMethod.Get, "/api/local/auth-fixture/status");
        externalRequest.Headers.Add("X-Fsus-Local-Auth-Fixture-Secret", "fixture-secret-value");
        externalRequest.Headers.Add("X-Test-External", "1");
        using HttpResponseMessage external = await client.SendAsync(externalRequest);
        Assert.Equal(HttpStatusCode.NotFound, external.StatusCode);

        using var allowedRequest = new HttpRequestMessage(HttpMethod.Get, "/api/local/auth-fixture/status");
        allowedRequest.Headers.Add("X-Fsus-Local-Auth-Fixture-Secret", "fixture-secret-value");
        using HttpResponseMessage allowed = await client.SendAsync(allowedRequest);
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        using JsonDocument document = JsonDocument.Parse(await allowed.Content.ReadAsStringAsync());
        string[] keys = document.RootElement.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(
            new[]
            {
                "hasAccessToken",
                "hasAdminAccessToken",
                "hasAdminSessionId",
                "hasHostAccessToken",
                "hasHostAdminAccessToken",
                "hasSessionId"
            }.Order(StringComparer.Ordinal).ToArray(),
            keys);
        Assert.All(document.RootElement.EnumerateObject(), property => Assert.False(property.Value.GetBoolean()));
    }

    [Fact]
    public async Task StructuredSecurityLogField_IsSanitizedBeforeLoggerReceivesIt()
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-log-boundary-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var logger = new StructuredLogger<FileService>();
            var service = new FileService(new TestWebHostEnvironment(root), logger);

            bool deleted = await service.DeleteImageAsync("/outside\r\nINJECT\u001b[31m");

            Assert.False(deleted);
            IReadOnlyDictionary<string, object?> fields = Assert.Single(logger.Entries);
            string path = Assert.IsType<string>(fields["FullPath"]);
            Assert.DoesNotContain('\r', path);
            Assert.DoesNotContain('\n', path);
            Assert.DoesNotContain('\u001b', path);
            Assert.Contains("\\r\\n", path, StringComparison.Ordinal);
            Assert.Contains("\\u001B", path, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static string DecodeApiErrorMessage(MemoryStream body)
    {
        var encoder = new AedsEncoder();
        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var pod));
        return PodUtf8Codec.FromFixed256(pod.Message);
    }

    private sealed class StructuredLogger<T> : ILogger<T>
    {
        internal List<IReadOnlyDictionary<string, object?>> Entries { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (state is IEnumerable<KeyValuePair<string, object?>> values)
            {
                Entries.Add(values.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal));
            }
        }
    }

    private sealed class TestHostEnvironment(string environmentName) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = environmentName;
        public string ApplicationName { get; set; } = nameof(DisclosureBoundaryTests);
        public string ContentRootPath { get; set; } = Directory.GetCurrentDirectory();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class TestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(DisclosureBoundaryTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = Environments.Production;
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
