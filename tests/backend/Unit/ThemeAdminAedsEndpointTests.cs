using System.Net;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Themes;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ThemeAdminAedsEndpointTests
{
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

        using HttpResponseMessage response = await AdminAedsEndpointTestSupport.SendAdminGetAsync(
            server,
            "/api/binary/author/ops/themes/registry");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        AedsDecodeResult decoded = await AdminAedsEndpointTestSupport.DecodeAsync(response);
        Assert.Equal(AedsFrameType.ThemeAdminSnapshot, decoded.FrameType);
        using JsonDocument payload = JsonDocument.Parse(decoded.Payload);
        Assert.Empty(payload.RootElement.EnumerateArray());
    }
}
