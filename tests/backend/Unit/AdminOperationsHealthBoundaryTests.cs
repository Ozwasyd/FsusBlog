using System.Reflection;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Models.Dtos;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminOperationsHealthBoundaryTests
{
    [Fact]
    public void DependencyGraph_SeparatesHealthCompositionFromIntegrityOperationsWithoutCallback()
    {
        Type[] integrityDependencies = Assert.Single(typeof(AdminIntegrityOperations).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Equal([typeof(ISqlSugarClient), typeof(ReleaseStoragePaths)], integrityDependencies);
        Assert.DoesNotContain(
            typeof(AdminIntegrityOperations).GetMethods(),
            static method => method.Name == "GetOpsHealthAsync");

        ParameterInfo[] healthDependencies = Assert.Single(typeof(AdminOperationsHealthReader).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters();
        Assert.Contains(
            healthDependencies,
            static parameter => parameter.ParameterType == typeof(IAdminBackupStatusReader));
        Assert.Contains(
            healthDependencies,
            static parameter => parameter.ParameterType == typeof(IAdminCacheDiagnosticsReader));
        Assert.Contains(
            healthDependencies,
            static parameter => parameter.ParameterType == typeof(IReleaseIdentityProvider));
        Assert.DoesNotContain(
            healthDependencies,
            static parameter => parameter.ParameterType == typeof(AdminIntegrityOperations));
    }

    [Fact]
    public void Contract_UsesExplicitCanonicalReleaseIdentityFields()
    {
        PropertyInfo[] properties = typeof(OpsHealthResponse).GetProperties();
        Assert.Contains(properties, static property =>
            property.Name == nameof(OpsHealthResponse.ReleaseIdentity)
            && property.PropertyType == typeof(OpsReleaseIdentityResponse));
        Assert.DoesNotContain(properties, static property => property.Name is "Version" or "Commit");

        Assert.Equal(
            ["ReleaseId", "CommitSha", "ReleaseSlot"],
            typeof(OpsReleaseIdentityResponse).GetProperties().Select(static property => property.Name));
        Assert.DoesNotContain(
            typeof(AdminOperationsHealthReader).GetMethods(BindingFlags.NonPublic | BindingFlags.Static),
            static method => method.Name is "ResolveVersion" or "ResolveCommit");
    }

}
