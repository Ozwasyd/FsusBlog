using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UserIdentityCommandBoundaryTests
{
    [Fact]
    public void DependencyGraph_CommandOwnsPersistenceWithoutUserServiceCallback()
    {
        Type[] dependencies = Assert.Single(typeof(UserProfileCommandService).GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();

        Assert.Equal(
            [
                typeof(ISqlSugarClient),
                typeof(ILogger<UserProfileCommandService>),
                typeof(IBanStateProjectionObligationCoordinator),
                typeof(ICacheInvalidationStore),
                typeof(IAccountStateProjectionMutationPublisher),
                typeof(IUserSessionValidationCache)
            ],
            dependencies);
        Assert.DoesNotContain(typeof(UserService), dependencies);
    }

    [Fact]
    public void RuntimePath_OwnsHandleAndRetirementTransactions()
    {
        string runtime = RuntimeMetadataInspection.DescribeMethods(
            typeof(UserProfileCommandService),
            nameof(UserProfileCommandService.UpdatePublicHandleAsync),
            nameof(UserProfileCommandService.DeleteAccountAsync));

        Assert.Contains("NOT EXISTS", runtime, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("account_deleted", runtime, StringComparison.Ordinal);
        Assert.Contains("UseTranAsync", runtime, StringComparison.Ordinal);
        Assert.DoesNotContain("UserService", runtime, StringComparison.Ordinal);
        Assert.Null(typeof(UserService).GetMethod(nameof(UserProfileCommandService.UpdatePublicHandleAsync)));
        Assert.Null(typeof(UserService).GetMethod(nameof(UserProfileCommandService.DeleteAccountAsync)));
    }

    [Fact]
    public void Composition_RegistersScopedIdentityCommand()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices();

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IUserProfileCommandService));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(UserProfileCommandService), descriptor.ImplementationType);
    }
}
