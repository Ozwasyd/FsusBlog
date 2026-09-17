using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UserIdentityQueryBoundaryTests
{
    [Fact]
    public void DependencyGraph_ReaderOwnsProjectionWithoutUserServiceCallback()
    {
        Type[] dependencies = Assert.Single(typeof(UserAccountReader).GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();

        Assert.Equal(
            [
                typeof(ISqlSugarClient),
                typeof(ICacheTypedReader),
                typeof(ICacheRawWriter),
                typeof(ICacheStringReader),
                typeof(ICacheInvalidationStore)
            ],
            dependencies);
        Assert.DoesNotContain(typeof(UserService), dependencies);
    }

    [Fact]
    public void RuntimePath_QueriesOnlyTheAccountSnapshotProjection()
    {
        string runtime = RuntimeMetadataInspection.DescribeMethods(
            typeof(UserAccountReader),
            "GetAccountByIdAsync",
            "LoadAccountSnapshotAsync");

        Assert.Contains("FROM sys_user", runtime, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("account_subject_hash", runtime, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AccountSnapshot", runtime, StringComparison.Ordinal);
        Assert.DoesNotContain("UserService", runtime, StringComparison.Ordinal);
    }

    [Fact]
    public void Composition_RegistersScopedIdentityReader()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices();

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IUserAccountReader));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(UserAccountReader), descriptor.ImplementationType);
    }
}
