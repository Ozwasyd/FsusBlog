using System.Reflection;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Storage;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminIntegrityOperationsBoundaryTests
{
    [Fact]
    public void DependencyGraph_UsesOnlyDatabaseAndFilesystemBoundaryWithoutCallbacks()
    {
        ParameterInfo[] dependencies = Assert.Single(typeof(AdminIntegrityOperations).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters();
        Assert.Equal(
            [typeof(ISqlSugarClient), typeof(ReleaseStoragePaths)],
            dependencies.Select(static parameter => parameter.ParameterType));
        Assert.DoesNotContain(typeof(IAdminOperationsHealthReader), dependencies.Select(static item => item.ParameterType));
        Assert.DoesNotContain(typeof(IAdminBackupStatusReader), dependencies.Select(static item => item.ParameterType));
        Assert.DoesNotContain(typeof(IAdminArtifactOperations), dependencies.Select(static item => item.ParameterType));
        Assert.DoesNotContain(typeof(IAdminCacheDiagnosticsReader), dependencies.Select(static item => item.ParameterType));
        Assert.DoesNotContain(typeof(IAdminDangerousOperationPolicyReader), dependencies.Select(static item => item.ParameterType));
    }

}
