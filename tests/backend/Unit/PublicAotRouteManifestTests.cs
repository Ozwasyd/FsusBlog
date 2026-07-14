using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotRouteManifestTests
{
    [Fact]
    public void DescriptorFactories_ProduceRegistryResolvableRoutes()
    {
        PublicAotRouteDescriptor[] descriptors =
        [
            PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Home, 0),
            PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.About, 10),
            PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Privacy, 11),
            PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Guidelines, 12),
            PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Copyright, 13),
            PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Archive, 20),
            PublicAotRouteManifestProvider.CreateArticleRoute(42, 7, [3, 9], 100),
            PublicAotRouteManifestProvider.CreateCategoryRoute(7, 200),
            PublicAotRouteManifestProvider.CreateTagIdRoute(3, "CSharp", 210)
        ];
        var registry = new PublicAotRouteRegistry();

        foreach (PublicAotRouteDescriptor descriptor in descriptors)
        {
            var context = new DefaultHttpContext();
            context.Request.Path = descriptor.Path;

            Assert.True(registry.TryResolve(context, out PublicAotRouteMatch match));
            Assert.Equal(descriptor.PageId, match.PageId);
            Assert.Equal(descriptor.Kind, match.Kind);
            Assert.Equal(descriptor.RouteKey, match.RouteKey);
            Assert.Equal(descriptor.CanonicalPath, match.CanonicalPath);
            Assert.Contains("seo", descriptor.DependencyKeys);
        }
    }

    [Fact]
    public void ScopeParser_SupportsAllHotAndChangedSince()
    {
        Assert.Equal("all", PublicAotRouteManifestScope.FromQuery(null, null).Scope);

        PublicAotRouteManifestScope hot = PublicAotRouteManifestScope.FromQuery("hot", null);
        Assert.True(hot.IsHot);
        Assert.Equal(64, hot.Limit);

        PublicAotRouteManifestScope changed = PublicAotRouteManifestScope.FromQuery("all", "2026-06-01T00:00:00Z");
        Assert.True(changed.IsChanged);
        Assert.Equal("changed", changed.Scope);
    }

    [Fact]
    public async Task Runtime_ExposesInternalEndpointPublicVisibilityAndOperationalDiagnostic()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.Services.AddRateLimiter(_ => { });
        await using WebApplication app = builder.Build();
        app.MapPublicAotEndpoints();
        RouteEndpoint manifest = FindRoute(app, "/internal/public-aot/manifest");
        RouteEndpoint health = FindRoute(app, "/internal/public-aot/health");
        MethodInfo healthHandler = health.Metadata.GetMetadata<MethodInfo>()!;
        string providerRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(PublicAotRouteManifestProvider),
            "LoadPublicArticlesAsync");
        string invalidationRuntime = RuntimeMetadataInspection.DescribeType(typeof(PublicAotInvalidationService));

        Assert.Equal("internal/public-aot/manifest", manifest.RoutePattern.RawText?.TrimStart('/'));
        Assert.Equal("internal/public-aot/health", health.RoutePattern.RawText?.TrimStart('/'));
        Assert.Contains(healthHandler.GetParameters(), static parameter => parameter.ParameterType == typeof(PublicAotSsrHealthService));
        FieldInfo header = typeof(PublicAotEndpoints).GetField("ManifestTokenHeader", BindingFlags.NonPublic | BindingFlags.Static)!;
        Assert.Equal("X-Fsus-Public-Aot-Token", header.GetRawConstantValue());
        Assert.Contains("Article.get_Status", providerRuntime, StringComparison.Ordinal);
        Assert.Contains("Article.get_PublishedAt", providerRuntime, StringComparison.Ordinal);
        Assert.Contains("Article.get_ScheduledPublishAt", providerRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("Nullable`1.get_HasValue", providerRuntime, StringComparison.Ordinal);
        Assert.Contains("CreateArticleRoute", invalidationRuntime, StringComparison.Ordinal);
        Assert.Contains("public_aot_manifest_pregenerate", invalidationRuntime, StringComparison.Ordinal);

        string request = await RunHealthDiagnosticAsync("manifest-token-runtime");
        Assert.StartsWith("GET /internal/public-aot/health ", request, StringComparison.Ordinal);
        Assert.Contains("X-Fsus-Public-Aot-Token: manifest-token-runtime", request, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Runtime_ManifestAndHealthFailClosedInProductionWhenTokenIsMissing()
    {
        MethodInfo authorize = typeof(PublicAotEndpoints).GetMethod(
            "IsManifestRequestAuthorized",
            BindingFlags.NonPublic | BindingFlags.Static)!;
        var missingToken = new ConfigurationBuilder().Build();
        var configuredToken = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PublicAot:ManifestToken"] = "required-manifest-token"
            })
            .Build();
        var production = new TestEnvironment(Environments.Production);
        var development = new TestEnvironment(Environments.Development);
        var context = new DefaultHttpContext();

        Assert.False((bool)authorize.Invoke(null, [context, missingToken, production])!);
        Assert.True((bool)authorize.Invoke(null, [context, missingToken, development])!);
        Assert.False((bool)authorize.Invoke(null, [context, configuredToken, production])!);
        context.Request.Headers["X-Fsus-Public-Aot-Token"] = "required-manifest-token";
        Assert.True((bool)authorize.Invoke(null, [context, configuredToken, production])!);
        Assert.Contains("PublicAot:ManifestToken", ProductionStartupValidator.CurrentSchema.RequiredSettings);
    }

    private static RouteEndpoint FindRoute(WebApplication app, string route)
        => Assert.Single(((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>(),
            endpoint => string.Equals(
                endpoint.RoutePattern.RawText?.TrimStart('/'),
                route.TrimStart('/'),
                StringComparison.Ordinal));

    private static async Task<string> RunHealthDiagnosticAsync(string token)
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        Task<TcpClient> accept = listener.AcceptTcpClientAsync();
        string script = BackendTestPaths.FromRoot("tools", "operations", "public-aot-health.mjs");
        var startInfo = new ProcessStartInfo("node")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add(script);
        startInfo.ArgumentList.Add($"http://127.0.0.1:{port}");
        startInfo.Environment["FSUSBLOG_PUBLIC_AOT_TOKEN"] = token;
        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Unable to start public AOT health diagnostic.");
        using TcpClient client = await accept.WaitAsync(TimeSpan.FromSeconds(10));
        await using NetworkStream stream = client.GetStream();
        using var reader = new StreamReader(stream, Encoding.ASCII, leaveOpen: true);
        var lines = new List<string>();
        while (await reader.ReadLineAsync() is { } line && line.Length > 0)
        {
            lines.Add(line);
        }
        byte[] body = Encoding.UTF8.GetBytes("{\"status\":\"ok\"}");
        string response = $"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(response));
        await stream.WriteAsync(body);
        await stream.FlushAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        string stderr = await process.StandardError.ReadToEndAsync();
        Assert.True(process.ExitCode == 0, stderr);
        return string.Join("\r\n", lines);
    }

    private sealed class TestEnvironment(string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Tests";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = string.Empty;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = string.Empty;
        public string EnvironmentName { get; set; } = environmentName;
    }
}
