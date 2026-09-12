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
    public void RuntimeDomainServices_RegisterOnlyProductionPinMutationAuthorityAndFacade()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices();

        AssertScoped<IAuthorArticlePinStore, AuthorArticlePinStore>(services);
        AssertScoped<SqlAuthorArticlePinPermissionAuthority, SqlAuthorArticlePinPermissionAuthority>(services);
        AssertFactoryScoped<IAuthorArticlePinMutationAuthorizer>(services);
        AssertScoped<IAuthorArticlePinApplicationFacade, AuthorArticlePinApplicationFacade>(services);
        Assert.DoesNotContain(services, static descriptor =>
            descriptor.ServiceType == typeof(IAuthorArticlePinPermissionProjectionProvider)
            || descriptor.ServiceType == typeof(IAuthorArticlePinArticleProjectionSource)
            || descriptor.ServiceType == typeof(IAuthorArticlePinProjectionCache)
            || descriptor.ServiceType == typeof(IAuthorArticlePinReconciliationSink)
            || descriptor.ServiceType == typeof(IAuthorArticlePinProjectionService));
        Assert.DoesNotContain(services, static descriptor =>
            descriptor.ImplementationType == typeof(UnavailableAuthorArticlePinMutationAuthorizer));
    }

    [Fact]
    public async Task Facade_DerivesMutationOwnerFromAuthenticatedPrincipalAndConfiguredSite()
    {
        var store = new CapturingStore();
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
        var facade = new AuthorArticlePinApplicationFacade(store, accessor, configuration);

        await facade.AddAsync(17, 0, Guid.CreateVersion7());

        Assert.Equal(new AuthorArticlePinOwner(42, "configured-site"), store.Owner);
    }

    [Fact]
    public async Task Facade_RejectsMutationWithoutBoundAdministratorSession()
    {
        var identity = new ClaimsIdentity(
        [
            new Claim("identity_kind", "admin_principal"),
            new Claim("admin_id", "42"),
            new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
        ],
        "test");
        var facade = new AuthorArticlePinApplicationFacade(
            new CapturingStore(),
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
            facade.AddAsync(17, 0, Guid.CreateVersion7()));
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

    private sealed class CapturingStore : IAuthorArticlePinStore
    {
        public AuthorArticlePinOwner Owner
        {
            get; private set;
        }

        public Task<AuthorArticlePinWriteReceipt> AddAsync(
            AddAuthorArticlePinCommand command,
            CancellationToken cancellationToken = default)
        {
            Owner = command.Owner;
            return Task.FromResult<AuthorArticlePinWriteReceipt>(null!);
        }

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
