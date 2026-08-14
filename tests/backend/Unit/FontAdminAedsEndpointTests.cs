using System.Net;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Fonts;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class FontAdminAedsEndpointTests
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

        using HttpResponseMessage response = await AdminAedsEndpointTestSupport.SendAdminGetAsync(
            server,
            "/api/binary/author/ops/fonts/registry");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        AedsDecodeResult decoded = await AdminAedsEndpointTestSupport.DecodeAsync(response);
        Assert.Equal(AedsFrameType.FontAdminSnapshot, decoded.FrameType);
        using JsonDocument payload = JsonDocument.Parse(decoded.Payload);
        Assert.Empty(payload.RootElement.EnumerateArray());
    }
}
