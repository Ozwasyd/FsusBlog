using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Fonts;
using FsusBlog.Server.Infrastructure.Themes;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class FontThemeAdminAedsEndpointTests
{
    [Fact]
    public async Task FontRegistry_UsesFontAdminSnapshotFrame()
    {
        IFontRegistry registry = Substitute.For<IFontRegistry>();
        registry.ReadAsync(Arg.Any<CancellationToken>())
            .Returns(new FontRegistrySnapshot([], []));
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create(
            new EndpointSecurityTestServerOptions
            {
                MapFontAdminEndpoints = true,
                ConfigureServices = services =>
                {
                    services.RemoveAll<IFontRegistry>();
                    services.AddSingleton(registry);
                }
            });

        using HttpResponseMessage response = await SendAdminGetAsync(
            server,
            "/api/binary/author/ops/fonts/registry");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        AedsDecodeResult decoded = await DecodeAsync(response);
        Assert.Equal(AedsFrameType.FontAdminSnapshot, decoded.FrameType);
        using JsonDocument payload = JsonDocument.Parse(decoded.Payload);
        Assert.Empty(payload.RootElement.EnumerateArray());
    }

    [Fact]
    public async Task ThemeRegistry_UsesThemeAdminSnapshotFrame()
    {
        IThemeRegistry registry = Substitute.For<IThemeRegistry>();
        registry.ListThemesAsync(Arg.Any<CancellationToken>())
            .Returns(Array.Empty<ThemeRegistrySnapshot>());
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create(
            new EndpointSecurityTestServerOptions
            {
                MapThemeAdminEndpoints = true,
                ConfigureServices = services =>
                {
                    services.RemoveAll<IThemeRegistry>();
                    services.AddSingleton(registry);
                }
            });

        using HttpResponseMessage response = await SendAdminGetAsync(
            server,
            "/api/binary/author/ops/themes/registry");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        AedsDecodeResult decoded = await DecodeAsync(response);
        Assert.Equal(AedsFrameType.ThemeAdminSnapshot, decoded.FrameType);
        using JsonDocument payload = JsonDocument.Parse(decoded.Payload);
        Assert.Empty(payload.RootElement.EnumerateArray());
    }

    private static async Task<HttpResponseMessage> SendAdminGetAsync(
        EndpointSecurityTestServer server,
        string path)
    {
        using HttpClient client = server.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        EndpointSecurityTestServer.AddAdminPrincipal(request, AdminPermissions.SystemConfig);
        return await client.SendAsync(request);
    }

    private static async Task<AedsDecodeResult> DecodeAsync(HttpResponseMessage response)
    {
        Assert.Equal("application/octet-stream", response.Content.Headers.ContentType?.MediaType);
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(
            await response.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value;
    }
}
