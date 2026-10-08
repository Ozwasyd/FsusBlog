using System.Net;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Storage;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Primitives;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests;

public sealed class PublicAssetDeliveryTests(ITestOutputHelper output)
{
    [Fact]
    public async Task AllocationProbe_ComparesRealStaticFilePipelineWithDefaultPublicAdmission()
    {
        await using var server = await AssetServer.StartAsync();
        using var baselineProvider = new PhysicalFileProvider(server.Root);
        var baseline = new ApplicationBuilder(server.ApplicationServices);
        baseline.UseStaticFiles(new StaticFileOptions
        {
            RequestPath = PublicAssetDeliveryPolicy.Default.RoutePrefix,
            FileProvider = baselineProvider,
            OnPrepareResponse = response =>
            {
                foreach ((string name, string value) in PublicAssetDeliveryPolicy.Default.Headers)
                {
                    response.Context.Response.Headers[name] = value;
                }
            }
        });
        var candidate = new ApplicationBuilder(server.ApplicationServices);
        candidate.UseFsusPublicAssets(PublicAssetDeliveryPolicy.Default, new PublicAssetFileProvider(server.Root));
        RequestDelegate baselineHandler = baseline.Build();
        RequestDelegate candidateHandler = candidate.Build();
        async Task<long> Measure(RequestDelegate handler, int count)
        {
            long before = GC.GetTotalAllocatedBytes(precise: true);
            for (int index = 0; index < count; index++)
            {
                var context = new DefaultHttpContext { RequestServices = server.ApplicationServices };
                context.Request.Method = "GET";
                context.Request.Path = "/uploads/illustration/hero.png";
                context.Connection.RemoteIpAddress = IPAddress.Loopback;
                context.Response.Body = Stream.Null;
                await handler(context);
                Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
            }
            return GC.GetTotalAllocatedBytes(precise: true) - before;
        }
        await Measure(baselineHandler, 50);
        await Measure(candidateHandler, 50);
        long baselineBytes = await Measure(baselineHandler, 400);
        long candidateBytes = await Measure(candidateHandler, 400);
        output.WriteLine($"public_asset_allocation_probe iterations=400 baselineBytes={baselineBytes} candidateBytes={candidateBytes} ratio={(double)candidateBytes / baselineBytes:F3}");
        // Retain the measured comparison; platform/performance qualification is
        // separate from HTTP correctness and must not be inferred from exit 0.
    }

    [Fact]
    public async Task RealKestrel_GetHeadAndRefererUseSameImmutableFileWithoutFallback()
    {
        await using var server = await AssetServer.StartAsync();
        foreach (string? referer in new[] { null, "", "https://untrusted.example/image", "https://fsus.blog/article" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, "/uploads/illustration/hero.png");
            if (referer is not null)
                request.Headers.TryAddWithoutValidation("Referer", referer);
            using HttpResponseMessage get = await server.Client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, get.StatusCode);
            Assert.Equal(server.Bytes, await get.Content.ReadAsByteArrayAsync());
            Assert.Equal(server.Bytes.Length, get.Content.Headers.ContentLength);
            Assert.Equal("image/png", get.Content.Headers.ContentType!.MediaType);
            AssertHeaders(get, "public, max-age=31536000, immutable");
        }
        int opened = server.Provider.Opened;
        using HttpResponseMessage head = await server.Client.SendAsync(new HttpRequestMessage(HttpMethod.Head, "/uploads/illustration/hero.png"));
        Assert.Equal(HttpStatusCode.OK, head.StatusCode);
        Assert.Equal(server.Bytes.Length, head.Content.Headers.ContentLength);
        Assert.Empty(await head.Content.ReadAsByteArrayAsync());
        AssertHeaders(head, "public, max-age=31536000, immutable");
        Assert.Equal(opened, server.Provider.Opened);
        Assert.Equal(0, server.FallbackCalls);
        Assert.Equal(0, server.Provider.Enumerated);
        using HttpResponseMessage unrelated = await server.Client.GetAsync("/outside-public-assets");
        Assert.Equal("SPA", await unrelated.Content.ReadAsStringAsync());
        Assert.Equal(1, server.FallbackCalls);
    }

    [Theory]
    [InlineData("GET", "/uploads/illustration/hero.png", "bytes=0-1", 416)]
    [InlineData("POST", "/uploads/illustration/hero.png", null, 405)]
    [InlineData("PUT", "/uploads/illustration/hero.png", null, 405)]
    [InlineData("DELETE", "/uploads/illustration/hero.png", null, 405)]
    [InlineData("GET", "/uploads/illustration/.hidden.png", null, 404)]
    [InlineData("GET", "/uploads/illustration/image.png.tmp", null, 404)]
    [InlineData("GET", "/uploads/illustration/image.svg", null, 404)]
    [InlineData("GET", "/uploads/illustration/missing.png", null, 404)]
    [InlineData("GET", "/uploads/illustration/directory.png", null, 404)]
    [InlineData("GET", "/uploads/illustration/oversized.png", null, 404)]
    [InlineData("GET", "/uploads/private/hero.png", null, 404)]
    [InlineData("GET", "/uploads/illustration/", null, 404)]
    public async Task RealKestrel_RejectionsNeverOpenFileOrFallThrough(string method, string path, string? range, int status)
    {
        await using var server = await AssetServer.StartAsync();
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (range is not null)
            request.Headers.TryAddWithoutValidation("Range", range);
        using HttpResponseMessage response = await server.Client.SendAsync(request);
        Assert.Equal(status, (int)response.StatusCode);
        AssertHeaders(response, "no-store");
        Assert.Empty(await response.Content.ReadAsByteArrayAsync());
        Assert.Equal(0, server.Provider.Opened);
        Assert.Equal(0, server.FallbackCalls);
        if (status is 405 or 416)
            Assert.Equal(0, server.Provider.Lookups);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RealKestrel_ActualDefaultWindowUsesOnlyTrustedClientIpAndRejectsBeforeProvider(bool trustLoopback)
    {
        await using var server = await AssetServer.StartAsync(trustLoopback);
        for (int index = 0; index < PublicAssetDeliveryPolicy.Default.PermitLimit; index++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, "/uploads/illustration/hero.png");
            request.Headers.TryAddWithoutValidation("X-Forwarded-For", "192.0.2.1");
            using HttpResponseMessage accepted = await server.Client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        }
        int lookups = server.Provider.Lookups;
        int opened = server.Provider.Opened;
        using var rejectedRequest = new HttpRequestMessage(HttpMethod.Get, "/uploads/illustration/hero.png");
        rejectedRequest.Headers.TryAddWithoutValidation("X-Forwarded-For", "192.0.2.1");
        using HttpResponseMessage rejected = await server.Client.SendAsync(rejectedRequest);
        Assert.Equal(HttpStatusCode.TooManyRequests, rejected.StatusCode);
        Assert.NotNull(rejected.Headers.RetryAfter);
        AssertHeaders(rejected, "no-store");
        Assert.Equal(lookups, server.Provider.Lookups);
        Assert.Equal(opened, server.Provider.Opened);
        using var changedRequest = new HttpRequestMessage(HttpMethod.Get, "/uploads/illustration/hero.png");
        changedRequest.Headers.TryAddWithoutValidation("X-Forwarded-For", "192.0.2.2");
        using HttpResponseMessage changed = await server.Client.SendAsync(changedRequest);
        Assert.Equal(trustLoopback ? HttpStatusCode.OK : HttpStatusCode.TooManyRequests, changed.StatusCode);
        Assert.Equal(0, server.FallbackCalls);
        Assert.Equal(0, server.Provider.Enumerated);
    }

    [Theory]
    [InlineData("negative-rate")]
    [InlineData("zero-rate")]
    [InlineData("large-burst")]
    [InlineData("unknown-mime")]
    [InlineData("queued")]
    [InlineData("extra-key")]
    public void Policy_RejectsMalformedConfigurationBeforeRequest(string mutation)
    {
        using Stream stream = typeof(PublicAssetDeliveryPolicy).Assembly.GetManifestResourceStream("FsusBlog.PublicAssetDeliveryPolicy.json")!;
        var value = JsonNode.Parse(stream)!;
        switch (mutation)
        {
            case "negative-rate":
                value["gateway"]!["requestsPerSecond"] = -1;
                break;
            case "zero-rate":
                value["gateway"]!["rateBytesPerSecond"] = 0;
                break;
            case "large-burst":
                value["gateway"]!["burst"] = 1001;
                break;
            case "unknown-mime":
                value["mediaTypes"]![".png"] = "text/html";
                break;
            case "queued":
                value["kestrel"]!["queueLimit"] = 1;
                break;
            case "extra-key":
                value["unknown"] = true;
                break;
        }
        Assert.Throws<InvalidOperationException>(() => PublicAssetDeliveryPolicy.Parse(System.Text.Encoding.UTF8.GetBytes(value.ToJsonString())));
    }

    [Fact]
    public void FileProvider_RejectsActualFileAndDirectoryLinksAndLastMomentFileLink()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsus-public-link-" + Guid.NewGuid().ToString("N"));
        string illustration = Path.Combine(root, "illustration");
        string outside = Path.Combine(root, "outside");
        Directory.CreateDirectory(illustration);
        Directory.CreateDirectory(outside);
        try
        {
            File.WriteAllText(Path.Combine(outside, "secret.png"), "isolated outside bytes");
            File.CreateSymbolicLink(Path.Combine(illustration, "linked.png"), Path.Combine(outside, "secret.png"));
            Directory.CreateSymbolicLink(Path.Combine(illustration, "linked-directory"), outside);
            var provider = new PublicAssetFileProvider(illustration);
            Assert.False(provider.GetFileInfo("/linked.png").Exists);
            Assert.False(provider.GetFileInfo("/linked-directory/secret.png").Exists);
            Assert.False(provider.GetDirectoryContents("/").Exists);
            if (OperatingSystem.IsLinux())
            {
                string path = Path.Combine(illustration, "swapped.png");
                File.WriteAllText(path, "isolated original bytes");
                IFileInfo before = provider.GetFileInfo("/swapped.png");
                Assert.True(before.Exists);
                File.Delete(path);
                File.CreateSymbolicLink(path, Path.Combine(outside, "secret.png"));
                Assert.Throws<IOException>(() => before.CreateReadStream());
            }
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ApplicationComposition_PreservesReleaseDrainBeforeAssetsAndAssetsBeforeAuthentication()
    {
        string[] stages = [.. WebApplicationCompositionExtensions.ApplicationPipelineStageIds];
        Assert.True(Array.IndexOf(stages, "forwarded-headers") < Array.IndexOf(stages, "public-assets"));
        Assert.True(Array.IndexOf(stages, "security-headers") < Array.IndexOf(stages, "public-assets"));
        Assert.True(Array.IndexOf(stages, "deployment-request-tracking") < Array.IndexOf(stages, "public-assets"));
        Assert.True(Array.IndexOf(stages, "public-assets") < Array.IndexOf(stages, "endpoint-pipeline"));
    }

    private static void AssertHeaders(HttpResponseMessage response, string cacheControl)
    {
        Assert.Equal(cacheControl, response.Headers.CacheControl!.ToString());
        Assert.Equal("same-origin", Assert.Single(response.Headers.GetValues("Cross-Origin-Resource-Policy")));
        Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
        Assert.Equal("none", Assert.Single(response.Headers.GetValues("Accept-Ranges")));
    }

    private sealed class AssetServer(WebApplication app, string root, CountingProvider provider) : IAsyncDisposable
    {
        internal string Root => root;
        internal IServiceProvider ApplicationServices => app.Services;
        internal byte[] Bytes { get; } = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB14AAAAASUVORK5CYII=");
        internal CountingProvider Provider => provider;
        internal HttpClient Client { get; private set; } = null!;
        internal int FallbackCalls
        {
            get; private set;
        }

        internal static async Task<AssetServer> StartAsync(bool trustLoopback = false)
        {
            string root = Path.Combine(Path.GetTempPath(), "fsus-public-delivery-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
            builder.Logging.ClearProviders();
            builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
            WebApplication app = builder.Build();
            var provider = new CountingProvider(new PublicAssetFileProvider(root));
            var server = new AssetServer(app, root, provider);
            await File.WriteAllBytesAsync(Path.Combine(root, "hero.png"), server.Bytes);
            Directory.CreateDirectory(Path.Combine(root, "directory.png"));
            using (var oversized = File.Create(Path.Combine(root, "oversized.png")))
                oversized.SetLength(PublicAssetDeliveryPolicy.Default.MaxFileBytes + 1);
            var forwarded = new ForwardedHeadersOptions { ForwardedHeaders = ForwardedHeaders.XForwardedFor };
            forwarded.KnownProxies.Clear();
            forwarded.KnownIPNetworks.Clear();
            if (trustLoopback)
                forwarded.KnownProxies.Add(IPAddress.Loopback);
            else
                forwarded.KnownProxies.Add(IPAddress.Parse("192.0.2.254"));
            app.UseForwardedHeaders(forwarded);
            app.UseFsusPublicAssets(PublicAssetDeliveryPolicy.Default, provider);
            app.Run(async context =>
            {
                server.FallbackCalls++;
                await context.Response.WriteAsync("SPA");
            });
            await app.StartAsync();
            string address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            server.Client = new HttpClient(new HttpClientHandler { UseProxy = false }) { BaseAddress = new Uri(address) };
            server.Client.DefaultRequestHeaders.Host = "fsus.blog";
            return server;
        }

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            await app.StopAsync();
            await app.DisposeAsync();
            Directory.Delete(root, recursive: true);
        }
    }

    private sealed class CountingProvider(IFileProvider inner) : IFileProvider
    {
        internal int Lookups
        {
            get; private set;
        }
        internal int Opened
        {
            get; private set;
        }
        internal int Enumerated
        {
            get; private set;
        }
        public IFileInfo GetFileInfo(string subpath)
        {
            Lookups++;
            return new CountingFile(inner.GetFileInfo(subpath), () => Opened++);
        }
        public IDirectoryContents GetDirectoryContents(string subpath)
        {
            Enumerated++;
            return inner.GetDirectoryContents(subpath);
        }
        public IChangeToken Watch(string filter) => inner.Watch(filter);
        private sealed class CountingFile(IFileInfo file, Action opened) : IFileInfo
        {
            public bool Exists => file.Exists;
            public long Length => file.Length;
            public string? PhysicalPath => file.PhysicalPath;
            public string Name => file.Name;
            public DateTimeOffset LastModified => file.LastModified;
            public bool IsDirectory => file.IsDirectory;
            public Stream CreateReadStream()
            {
                opened();
                return file.CreateReadStream();
            }
        }
    }
}
