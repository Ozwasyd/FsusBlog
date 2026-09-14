using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UserAdminProjectionBoundaryTests
{
    [Fact]
    public void DependencyGraph_AdminProjectionHasNoUserServiceCallback()
    {
        Type[] dependencies = Assert.Single(typeof(UserAdminModerationService).GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();

        Assert.Equal(
            [
                typeof(ISqlSugarClient),
                typeof(ILogger<UserAdminModerationService>),
                typeof(IBanStateProjectionObligationCoordinator),
                typeof(IMessageCommandService),
                typeof(IAccountStateProjectionMutationPublisher),
                typeof(FsusBlog.Server.Services.Security.IUserSessionValidationCache)
            ],
            dependencies);
        Assert.DoesNotContain(typeof(UserService), dependencies);
    }

    [Fact]
    public void RuntimePath_OwnsProjectionAndGuardedStatusMutation()
    {
        string runtime = RuntimeMetadataInspection.DescribeMethods(
            typeof(UserAdminModerationService),
            nameof(UserAdminModerationService.GetAdminUserListAsync),
            "LoadAdminAccountListWindowAsync",
            nameof(UserAdminModerationService.AdminChangeStatusAsync),
            "TryUpdateAdminStatusAsync");

        Assert.Contains("ORDER BY createtime DESC, id DESC", runtime, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("xmin::text = @RowVersion", runtime, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("UserService", runtime, StringComparison.Ordinal);
        Assert.Null(typeof(UserService).GetMethod(nameof(UserAdminModerationService.GetAdminUserListAsync)));
        Assert.Null(typeof(UserService).GetMethod(nameof(UserAdminModerationService.AdminChangeStatusAsync)));
    }

    [Fact]
    public void Composition_RegistersScopedAdminProjection()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices();

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IUserAdminModerationService));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(UserAdminModerationService), descriptor.ImplementationType);
    }
}
