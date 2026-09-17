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
            typeof(AdminIntegrityOperations).GetMethods(),
            static method => method.Name == "GetDangerousOperationPolicy");
    }

}
