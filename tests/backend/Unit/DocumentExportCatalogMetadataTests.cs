using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;

using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportCatalogMetadataTests
{
    [Fact]
    public async Task AuthenticatedProjection_UsesCanonicalRegistryProfilesFeaturesBudgetsAndDelivery()
    {
        using var fixture = new Fixture();
        DocumentExportCatalogMetadata metadata = await fixture.Binding.ReadCatalogMetadataAsync(fixture.Context, default);
        Assert.Equal(DocumentExportReadingStyleAuthority.AuthorityId, metadata.ReadingStyleAuthorityId);
        Assert.Equal(DocumentExportReadingStyleAuthority.AuthorityDigest, metadata.ReadingStyleAuthorityDigest);
        Assert.Equal(DocumentExportContractCatalog.FormatIds, metadata.Providers.Select(provider => provider.FormatId));
        Assert.Equal(4, metadata.Providers.Count);
        foreach (DocumentExportCatalogProviderMetadata projection in metadata.Providers)
        {
            DocumentExportProviderContract original = DocumentExportContractCatalog.RequireProvider(projection.FormatId);
            Assert.Equal(original.ProviderId, projection.ProviderId);
            Assert.Equal(original.ProviderVersion, projection.ProviderVersion);
            Assert.Equal(original.OutputMediaType, projection.OutputMediaType);
            Assert.Equal(original.OutputExtension, projection.OutputExtension);
            Assert.Equal(original.ImplementationAvailable, projection.ImplementationDeclared);
            Assert.Same(original.Features, projection.Features);
            Assert.Same(original.Budgets, projection.Budgets);
            Assert.Same(original.Delivery, projection.Delivery);
            Assert.Equal([DocumentExportReadingStyleAuthority.LayoutProfile], projection.LayoutProfiles);
            Assert.Equal([DocumentExportReadingStyleAuthority.LightThemeProfile,
                DocumentExportReadingStyleAuthority.DarkThemeProfile], projection.ThemeProfiles);
        }
        Assert.Empty(fixture.Freezer.ReceivedCalls());
        Assert.Empty(fixture.Requests.ReceivedCalls());
    }

    [Fact]
    public async Task DeclaredImplementationAndPrivateOutputPolicy_DoNotQualifyRuntimeOrSourcePrivacy()
    {
        using var fixture = new Fixture();
        DocumentExportCatalogMetadata metadata = await fixture.Binding.ReadCatalogMetadataAsync(fixture.Context, default);
        Assert.Contains(metadata.Providers, provider => provider.ImplementationDeclared);
        Assert.All(metadata.Providers, provider =>
        {
            Assert.False(provider.RuntimeAvailabilityKnown);
            Assert.False(provider.Available);
            Assert.Equal("runtime-readiness-authority-unavailable", provider.AvailabilityReason);
            Assert.Equal(DocumentExportContractCatalog.RequireProvider(provider.FormatId).Delivery, provider.Delivery);
        });
        Assert.DoesNotContain(typeof(DocumentExportCatalogMetadata).GetProperties(), property =>
            property.Name is "Source" or "PrivateSource" or "SessionId" or "UserId" or "SiteScope");
        Assert.DoesNotContain(typeof(DocumentExportCatalogProviderMetadata).GetProperties(), property =>
            property.Name is "PrivateSource" or "ExecutablePath" or "SourceCoordinate");
    }

    [Theory]
    [InlineData("anonymous")]
    [InlineData("account")]
    [InlineData("owner")]
    [InlineData("session")]
    [InlineData("permission")]
    [InlineData("configuration")]
    public async Task InvalidAuthenticationScopeOrPermission_RejectsBeforeProjection(string mutation)
    {
        using var fixture = new Fixture(mutation);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() =>
            fixture.Binding.ReadCatalogMetadataAsync(fixture.Context, default));
        Assert.Empty(fixture.Freezer.ReceivedCalls());
        Assert.Empty(fixture.Requests.ReceivedCalls());
    }

    [Fact]
    public async Task CancelledMetadataRead_RejectsWithoutBodyFreezeOrToolExecution()
    {
        using var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            fixture.Binding.ReadCatalogMetadataAsync(fixture.Context, cancellation.Token));
        Assert.Empty(fixture.Freezer.ReceivedCalls());
        Assert.Empty(fixture.Requests.ReceivedCalls());
    }

    private sealed class Fixture : IDisposable
    {
        private readonly ServiceProvider _services;
        internal HttpContext Context { get; } = new DefaultHttpContext();
        internal IDocumentExportRequestFreezer Freezer { get; } = Substitute.For<IDocumentExportRequestFreezer>();
        internal IBinaryEndpointRequestContext Requests { get; } = Substitute.For<IBinaryEndpointRequestContext>();
        internal DocumentExportEndpointBinding Binding { get; }

        internal Fixture(string? mutation = null)
        {
            var services = new ServiceCollection();
            if (mutation != "configuration")
            {
                services.AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(
                    new Dictionary<string, string?> { ["SITE_BASEURL"] = "https://export.example/site" }).Build());
            }
            _services = services.BuildServiceProvider();
            Context.RequestServices = _services;
            var claims = new List<Claim>
            {
                new("identity_kind", mutation == "account" ? "account" : "admin_principal"),
                new("admin_id", mutation == "owner" ? "0" : "42")
            };
            if (mutation != "session")
            {
                claims.Add(new("admin_sid", "current-session"));
            }
            if (mutation != "permission")
            {
                claims.Add(new(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite));
            }
            Context.User = mutation == "anonymous" ? new ClaimsPrincipal()
                : new ClaimsPrincipal(new ClaimsIdentity(claims, "controlled-admin"));
            Binding = new(Freezer, Requests);
        }

        public void Dispose() => _services.Dispose();
    }
}
