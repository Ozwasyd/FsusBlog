using System.Reflection;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Models.Dtos;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminBackupStatusBoundaryTests
{
    [Fact]
    public void StatusReader_UsesOnlyBackupConfigurationAndFilesystemEvidence()
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-admin-backup-{Guid.NewGuid():N}");
        string backupRoot = Path.Combine(root, "backups");
        string dataRoot = Path.Combine(root, "data");
        string keyRing = Path.Combine(dataRoot, "keys");
        Directory.CreateDirectory(backupRoot);
        Directory.CreateDirectory(keyRing);
        File.WriteAllText(Path.Combine(backupRoot, "database-latest.dump"), "db");
        File.WriteAllText(Path.Combine(backupRoot, "uploads-latest.tar"), "uploads");
        File.WriteAllText(Path.Combine(backupRoot, "config-latest.json"), "{}");
        try
        {
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Operations:BackupRoot"] = backupRoot,
                    ["FSUSBLOG_DATA_ROOT"] = dataRoot,
                    ["DataProtection:KeyRingPath"] = keyRing
                })
                .Build();
            var environment = Substitute.For<IWebHostEnvironment>();
            environment.ContentRootPath.Returns(root);
            var reader = new AdminBackupStatusReader(environment, configuration);

            BackupStatusResponse status = reader.GetStatus();

            Assert.Equal("ok", status.Status);
            Assert.Equal(backupRoot, status.BackupRoot);
            Assert.Contains(status.Artifacts, static artifact => artifact.Kind == "database" && artifact.Status == "ok");
            Assert.Contains(status.Artifacts, static artifact => artifact.Kind == "uploads" && artifact.Status == "ok");
            Assert.Contains(status.Artifacts, static artifact => artifact.Kind == "config" && artifact.Status == "ok");
            Assert.Contains(status.Artifacts, static artifact =>
                artifact.Kind == "data-protection-keyring"
                && artifact.Detail == "live-keyring-not-yet-packaged");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void DependencyGraph_MovesBackupPortsOutOfAdminOperationsWithoutCallback()
    {
        Type[] operationDependencies = Assert.Single(typeof(AdminOperationsService).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Contains(typeof(IAdminBackupStatusReader), operationDependencies);
        Assert.DoesNotContain(typeof(IConfiguration), operationDependencies);
        Assert.DoesNotContain(
            typeof(AdminOperationsService).GetMethods(),
            static method => method.Name == "GetBackupStatus");

        ParameterInfo[] readerDependencies = Assert.Single(typeof(AdminBackupStatusReader).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters();
        Assert.Equal(
            [typeof(IWebHostEnvironment), typeof(IConfiguration)],
            readerDependencies.Select(static parameter => parameter.ParameterType));
        Assert.DoesNotContain(
            readerDependencies,
            static parameter => parameter.ParameterType == typeof(AdminOperationsService));
    }

    [Fact]
    public void Composition_RegistersNarrowSingletonPort()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeInfrastructureServices(new ConfigurationBuilder().Build());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IAdminBackupStatusReader));
        Assert.Equal(ServiceLifetime.Singleton, descriptor.Lifetime);
        Assert.Equal(typeof(AdminBackupStatusReader), descriptor.ImplementationType);
    }
}
