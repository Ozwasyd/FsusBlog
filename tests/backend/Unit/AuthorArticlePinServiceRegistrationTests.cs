using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthorArticlePinServiceRegistrationTests
{
    [Fact]
    public void RuntimeDomainServices_RegisterOneProductionPinAuthorityAndFacade()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices();

        AssertScoped<IAuthorArticlePinStore, AuthorArticlePinStore>(services);
        AssertScoped<SqlAuthorArticlePinPermissionAuthority, SqlAuthorArticlePinPermissionAuthority>(services);
        AssertFactoryScoped<IAuthorArticlePinPermissionProjectionProvider>(services);
        AssertFactoryScoped<IAuthorArticlePinMutationAuthorizer>(services);
        AssertScoped<IAuthorArticlePinArticleProjectionSource, SqlAuthorArticlePinArticleProjectionSource>(services);
        AssertSingleton<IAuthorArticlePinProjectionCache, DirectAuthorArticlePinProjectionCache>(services);
        AssertScoped<IAuthorArticlePinReconciliationSink, AuthorArticlePinReconciliationSink>(services);
        AssertScoped<IAuthorArticlePinProjectionService, AuthorArticlePinProjectionService>(services);
        AssertScoped<IAuthorArticlePinApplicationFacade, AuthorArticlePinApplicationFacade>(services);
        Assert.DoesNotContain(services, static descriptor =>
            descriptor.ImplementationType == typeof(UnavailableAuthorArticlePinPermissionProjectionProvider)
            || descriptor.ImplementationType == typeof(UnavailableAuthorArticlePinMutationAuthorizer)
            || descriptor.ImplementationType == typeof(UnavailableAuthorArticlePinReconciliationSink));
    }

    [Fact]
    public async Task Facade_DerivesOwnerFromAuthenticatedPrincipalAndConfiguredSite()
    {
        var projection = new CapturingProjection();
        var identity = new ClaimsIdentity(
        [
            new Claim("identity_kind", "admin_principal"),
            new Claim("admin_id", "42"),
            new Claim("admin_sid", "session-42"),
            new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
        ],
        "test");
        var accessor = new HttpContextAccessor
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(identity)
            }
        };
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["SITE_BASEURL"] = "configured-site"
            })
            .Build();
        var facade = new AuthorArticlePinApplicationFacade(
            new UnusedStore(),
            projection,
            accessor,
            configuration);

        await facade.ReadAsync(new AuthorArticlePinReadOptions(Guid.CreateVersion7()));

        Assert.Equal(new AuthorArticlePinOwner(42, "configured-site"), projection.Owner);
    }

    [Fact]
    public async Task Facade_RejectsPrincipalWithoutBoundAdministratorSession()
    {
        var identity = new ClaimsIdentity(
        [
            new Claim("identity_kind", "admin_principal"),
            new Claim("admin_id", "42"),
            new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
        ],
        "test");
        var facade = new AuthorArticlePinApplicationFacade(
            new UnusedStore(),
            new CapturingProjection(),
            new HttpContextAccessor
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(identity)
                }
            },
            new ConfigurationBuilder().AddInMemoryCollection(
                new Dictionary<string, string?>
                {
                    ["SITE_BASEURL"] = "configured-site"
                }).Build());

        await Assert.ThrowsAsync<AuthorArticlePinAccessDeniedException>(() =>
            facade.ReadAsync(new AuthorArticlePinReadOptions(Guid.CreateVersion7())));
    }

    private static void AssertScoped<TService, TImplementation>(IEnumerable<ServiceDescriptor> services)
    {
        ServiceDescriptor descriptor = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(TService));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(TImplementation), descriptor.ImplementationType);
    }

    private static void AssertFactoryScoped<TService>(IEnumerable<ServiceDescriptor> services)
    {
        ServiceDescriptor descriptor = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(TService));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.NotNull(descriptor.ImplementationFactory);
    }

    private static void AssertSingleton<TService, TImplementation>(IEnumerable<ServiceDescriptor> services)
    {
        ServiceDescriptor descriptor = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(TService));
        Assert.Equal(ServiceLifetime.Singleton, descriptor.Lifetime);
        Assert.Equal(typeof(TImplementation), descriptor.ImplementationType);
    }

    private sealed class CapturingProjection : IAuthorArticlePinProjectionService
    {
        public AuthorArticlePinOwner Owner
        {
            get; private set;
        }

        public Task<AuthorArticlePinProjectionPage> ReadAsync(
            AuthorArticlePinProjectionRequest request,
            CancellationToken cancellationToken = default)
        {
            Owner = request.Owner;
            return Task.FromResult(AuthorArticlePinProjectionPage.Empty(
                AuthorArticlePinProjectionStatus.Unavailable,
                "test"));
        }

        public Task<AuthorArticlePinOpenValidationResult> RevalidateOpenAsync(
            AuthorArticlePinOpenValidationRequest request,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }

    private sealed class UnusedStore : IAuthorArticlePinStore
    {
        public Task<AuthorArticlePinWriteReceipt> AddAsync(
            AddAuthorArticlePinCommand command,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthorArticlePinWriteReceipt> RemoveAsync(
            RemoveAuthorArticlePinCommand command,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthorArticlePinWriteReceipt> ReorderAsync(
            ReorderAuthorArticlePinsCommand command,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthorArticlePinCollectionSnapshot> GetAuthoritySnapshotAsync(
            AuthorArticlePinOwner owner,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthorArticlePinVerificationResult> VerifyAsync(
            AuthorArticlePinOwner owner,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }
}
