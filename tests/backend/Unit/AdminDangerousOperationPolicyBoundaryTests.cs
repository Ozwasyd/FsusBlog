using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminDangerousOperationPolicyBoundaryTests
{
    [Fact]
    public void DependencyGraph_UsesStatelessPolicyReaderWithoutIntegrityCallback()
    {
        Assert.Empty(typeof(AdminDangerousOperationPolicyReader).GetConstructors().Single().GetParameters());
        Assert.DoesNotContain(
            typeof(AdminOperationsService).GetMethods(),
            static method => method.Name == "GetDangerousOperationPolicy");
    }

    [Fact]
    public void Composition_RegistersNarrowSingletonPort()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeInfrastructureServices(new ConfigurationBuilder().Build());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IAdminDangerousOperationPolicyReader));
        Assert.Equal(ServiceLifetime.Singleton, descriptor.Lifetime);
        Assert.Equal(typeof(AdminDangerousOperationPolicyReader), descriptor.ImplementationType);
    }
}
