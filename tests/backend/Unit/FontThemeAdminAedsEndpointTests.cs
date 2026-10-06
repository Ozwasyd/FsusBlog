using System.Net;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
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
    private static readonly DateTimeOffset s_installedAt = new(2026, 9, 1, 12, 30, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset s_updatedAt = new(2026, 9, 2, 13, 45, 1, TimeSpan.Zero);

    [Theory]
    [InlineData("/api/binary/author/ops/fonts/registry", AedsFrameType.FontRegistryList)]
    [InlineData("/api/binary/author/ops/fonts/registry/font-a", AedsFrameType.FontRegistryDetail)]
    [InlineData("/api/binary/author/ops/fonts/activations", AedsFrameType.FontActivationList)]
    [InlineData("/api/binary/author/ops/themes/registry", AedsFrameType.ThemeRegistryList)]
    [InlineData("/api/binary/author/ops/themes/registry/theme-a", AedsFrameType.ThemeRegistryDetail)]
    [InlineData("/api/binary/author/ops/themes/activations", AedsFrameType.ThemeActivationList)]
    [InlineData("/api/binary/author/ops/themes/activations/public", AedsFrameType.ThemeActivation)]
    [InlineData("/api/binary/author/ops/themes/activations/public/history", AedsFrameType.ThemeActivationHistory)]
    public async Task ProductionGetRoutes_ReturnDistinctTypedAedsFrames(string path, AedsFrameType frameType)
    {
        using EndpointSecurityTestServer server = CreateServer();
        using HttpClient client = server.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        EndpointSecurityTestServer.AddAdminPrincipal(request, AdminPermissions.SystemConfig);

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/octet-stream", response.Content.Headers.ContentType?.MediaType);
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(await response.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(frameType, decoded.Value.FrameType);
        Assert.True(TryDecodeTypedPayload(frameType, decoded.Value.Payload));
    }

    [Fact]
    public async Task Routes_RequireAuthenticatedAdminWithSystemConfigPermission()
    {
        using EndpointSecurityTestServer server = CreateServer();
        using HttpClient client = server.CreateClient();

        using HttpResponseMessage anonymous = await client.GetAsync("/api/binary/author/ops/fonts/registry");
        using var userRequest = new HttpRequestMessage(HttpMethod.Get, "/api/binary/author/ops/themes/registry");
        EndpointSecurityTestServer.AddAdminPrincipal(userRequest);
        using HttpResponseMessage missingPermission = await client.SendAsync(userRequest);

        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, missingPermission.StatusCode);
        await AssertApiErrorAsync(anonymous, HttpStatusCode.Unauthorized);
        await AssertApiErrorAsync(missingPermission, HttpStatusCode.Forbidden);
    }

    [Theory]
    [InlineData("/api/binary/author/ops/fonts/registry")]
    [InlineData("/api/binary/author/ops/fonts/registry/font-a")]
    [InlineData("/api/binary/author/ops/fonts/activations")]
    [InlineData("/api/binary/author/ops/themes/registry")]
    [InlineData("/api/binary/author/ops/themes/registry/theme-a")]
    [InlineData("/api/binary/author/ops/themes/activations")]
    [InlineData("/api/binary/author/ops/themes/activations/public")]
    [InlineData("/api/binary/author/ops/themes/activations/public/history")]
    public async Task EveryRead_RejectsAnonymousAccountAndMissingAdminPermissionAsApiError(string path)
    {
        using EndpointSecurityTestServer server = CreateServer();
        using HttpClient client = server.CreateClient();
        using HttpResponseMessage anonymous = await client.GetAsync(path);
        using var accountRequest = new HttpRequestMessage(HttpMethod.Get, path);
        EndpointSecurityTestServer.AddAnonymousAccount(accountRequest);
        using HttpResponseMessage account = await client.SendAsync(accountRequest);
        using var adminRequest = new HttpRequestMessage(HttpMethod.Get, path);
        EndpointSecurityTestServer.AddAdminPrincipal(adminRequest);
        using HttpResponseMessage missingPermission = await client.SendAsync(adminRequest);

        await AssertApiErrorAsync(anonymous, HttpStatusCode.Unauthorized);
        await AssertApiErrorAsync(account, HttpStatusCode.Forbidden);
        await AssertApiErrorAsync(missingPermission, HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task MissingRegistryDetailAndInvalidScope_ReturnAedsApiErrors()
    {
        using EndpointSecurityTestServer server = CreateServer();
        using HttpClient client = server.CreateClient();

        using HttpResponseMessage missingFont = await SendAdminAsync(client, "/api/binary/author/ops/fonts/registry/missing");
        using HttpResponseMessage missingTheme = await SendAdminAsync(client, "/api/binary/author/ops/themes/registry/missing");
        using HttpResponseMessage invalidScope = await SendAdminAsync(client, "/api/binary/author/ops/themes/activations/not-valid");

        await AssertApiErrorAsync(missingFont, HttpStatusCode.NotFound);
        await AssertApiErrorAsync(missingTheme, HttpStatusCode.NotFound);
        await AssertApiErrorAsync(invalidScope, HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task AdministrationReads_PreserveFixedIpRateLimit()
    {
        using EndpointSecurityTestServer server = CreateServer(fixedIpPermitLimit: 1);
        using HttpClient client = server.CreateClient();
        using HttpResponseMessage first = await SendAdminAsync(client, "/api/binary/author/ops/fonts/registry");
        using HttpResponseMessage second = await SendAdminAsync(client, "/api/binary/author/ops/themes/registry");

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        await AssertApiErrorAsync(second, HttpStatusCode.TooManyRequests);
    }

    private static EndpointSecurityTestServer CreateServer(int fixedIpPermitLimit = 100)
    {
        IFontRegistry fonts = Substitute.For<IFontRegistry>();
        fonts.ReadAsync(Arg.Any<CancellationToken>()).Returns(new FontRegistrySnapshot(
            [FontEntry()],
            [new FontActivation("admin", "font-a", "font-a", "font-code", "font-cjk", "font-emoji", 7, s_updatedAt)]));

        ThemeRegistrySnapshot theme = ThemeSnapshot();
        var activation = new ThemeActivationSnapshot(
            ThemeActivationScope.Public,
            "theme-a",
            "dark",
            s_updatedAt,
            Guid.Parse("01234567-89ab-cdef-0123-456789abcdef"),
            "asset-v1",
            9);
        var history = new ThemeActivationHistorySnapshot(
            Guid.Parse("fedcba98-7654-3210-fedc-ba9876543210"),
            ThemeActivationScope.Public,
            "theme-a",
            null,
            "asset-v1",
            null,
            9,
            null,
            "dark",
            null,
            ThemeActivationStatus.Applied,
            s_installedAt,
            s_updatedAt,
            null,
            "admin@example.test",
            "{}");
        IThemeRegistry themes = Substitute.For<IThemeRegistry>();
        themes.ListThemesAsync(Arg.Any<CancellationToken>()).Returns([theme]);
        themes.GetThemeAsync("theme-a", Arg.Any<CancellationToken>()).Returns(theme);
        themes.ListActivationsAsync(Arg.Any<CancellationToken>()).Returns([activation]);
        themes.GetActivationAsync(ThemeActivationScope.Public, Arg.Any<CancellationToken>()).Returns(activation);
        themes.GetActivationHistoryAsync(ThemeActivationScope.Public, Arg.Any<CancellationToken>()).Returns([history]);

        return EndpointSecurityTestServer.Create(new EndpointSecurityTestServerOptions
        {
            MapFontThemeAdminEndpoints = true,
            FixedIpPermitLimit = fixedIpPermitLimit,
            ConfigureServices = services =>
            {
                services.RemoveAll<IFontRegistry>();
                services.RemoveAll<IThemeRegistry>();
                services.AddSingleton(fonts);
                services.AddSingleton(themes);
            }
        });
    }

    private static async Task<HttpResponseMessage> SendAdminAsync(HttpClient client, string path)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        EndpointSecurityTestServer.AddAdminPrincipal(request, AdminPermissions.SystemConfig);
        return await client.SendAsync(request);
    }

    private static async Task AssertApiErrorAsync(HttpResponseMessage response, HttpStatusCode status)
    {
        Assert.Equal(status, response.StatusCode);
        Assert.Equal("application/octet-stream", response.Content.Headers.ContentType?.MediaType);
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(await response.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var error));
        Assert.Equal((int)status, error.HttpStatus);
    }

    private static bool TryDecodeTypedPayload(AedsFrameType frameType, ReadOnlyMemory<byte> payload)
        => frameType switch
        {
            AedsFrameType.FontRegistryList => PodBinaryCodec.TryDecodeFontRegistryList(payload, out _),
            AedsFrameType.FontRegistryDetail => PodBinaryCodec.TryDecodeFontRegistryDetail(payload, out _),
            AedsFrameType.FontActivationList => PodBinaryCodec.TryDecodeFontActivationList(payload, out _),
            AedsFrameType.ThemeRegistryList => PodBinaryCodec.TryDecodeThemeRegistryList(payload, out _),
            AedsFrameType.ThemeRegistryDetail => PodBinaryCodec.TryDecodeThemeRegistryDetail(payload, out _),
            AedsFrameType.ThemeActivationList => PodBinaryCodec.TryDecodeThemeActivationList(payload, out _),
            AedsFrameType.ThemeActivation => PodBinaryCodec.TryDecodeThemeActivation(payload, out _),
            AedsFrameType.ThemeActivationHistory => PodBinaryCodec.TryDecodeThemeActivationHistory(payload, out _),
            _ => false
        };

    private static FontRegistryEntry FontEntry()
        => new(
            "font-a",
            "Font A",
            "Font Family",
            "sans-serif",
            "1.0.0",
            "{\"id\":\"font-a\"}",
            "OFL",
            "{\"source\":\"bundled\"}",
            FontInstallStates.Installed,
            true,
            false,
            s_installedAt,
            s_updatedAt,
            [new FontRegistryFace(400, "normal", "regular.woff2", "sha256:a", 10, null, true, "swap")]);

    private static ThemeRegistrySnapshot ThemeSnapshot()
        => new(
            new ThemeManifest
            {
                Id = "theme-a",
                Name = "Theme A",
                Version = "1.0.0",
                Fsusblog = "1",
                Author = "FsusBlog",
                Description = "Theme description",
                Type = "visual",
                Entry = new ThemeEntryManifest { Tokens = "tokens.css", Theme = "theme.css" },
                Modes = ["light", "dark"],
                Supports = new ThemeSupportManifest { Public = true, Admin = true },
                Assets = new Dictionary<string, string>(),
                ConfigSchema = "schema.json",
                Permissions = new ThemePermissionManifest(),
                Budgets = new ThemeBudgetManifest { CssBytes = 100, AssetBytes = 200, PreviewBytes = 300 }
            },
            "{\"id\":\"theme-a\"}",
            "{\"type\":\"object\"}",
            "sha256:theme",
            "/themes/theme-a",
            ThemeInstallState.Enabled,
            true,
            s_installedAt,
            s_updatedAt);
}
