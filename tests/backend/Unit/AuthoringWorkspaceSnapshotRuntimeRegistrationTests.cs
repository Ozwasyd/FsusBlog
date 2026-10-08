using System.Reflection;
using System.Reflection.Emit;
using System.Security.Cryptography;

using FsusBlog.Contracts.AuthoringWorkspace;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.Authoring;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringWorkspaceSnapshotRuntimeRegistrationTests
{
    [Fact]
    public void RuntimeRegistration_UsesOneBuildBoundOwnerAndPerScopePostgresWithoutIo()
    {
        var services = new ServiceCollection();
        ISqlSugarClient database = Substitute.For<ISqlSugarClient>();
        services.AddSingleton(TimeProvider.System);
        services.AddScoped(_ => database);
        services.AddFsusRuntimeDomainServices();
        using ServiceProvider provider = services.BuildServiceProvider();
        using IServiceScope first = provider.CreateScope();
        using IServiceScope second = provider.CreateScope();

        AuthoringWorkspaceSnapshotSourceIdentity identity = first.ServiceProvider
            .GetRequiredService<AuthoringWorkspaceSnapshotSourceIdentity>();
        Assert.Same(identity, second.ServiceProvider.GetRequiredService<AuthoringWorkspaceSnapshotSourceIdentity>());
        Assert.IsType<AuthoringWorkspaceSnapshotPostgresPersistence>(Assert.Single(
            first.ServiceProvider.GetServices<IAuthoringWorkspaceSnapshotPersistence>()));
        AuthoringWorkspaceSnapshotStore store = Assert.Single(first.ServiceProvider.GetServices<AuthoringWorkspaceSnapshotStore>());
        Assert.Same(store, first.ServiceProvider.GetRequiredService<AuthoringWorkspaceSnapshotStore>());
        Assert.NotSame(store, second.ServiceProvider.GetRequiredService<AuthoringWorkspaceSnapshotStore>());
        AuthoringWorkspaceSnapshotTransport transport = Assert.Single(first.ServiceProvider.GetServices<AuthoringWorkspaceSnapshotTransport>());
        Assert.Same(transport, first.ServiceProvider.GetRequiredService<AuthoringWorkspaceSnapshotTransport>());
        Assert.NotSame(transport, second.ServiceProvider.GetRequiredService<AuthoringWorkspaceSnapshotTransport>());
        Assert.Empty(database.ReceivedCalls());
    }

    [Fact]
    public void ProductionSourceDigest_BindsActualServerCommitAndBothCompiledArtifacts()
    {
        Assembly server = typeof(AuthoringWorkspaceSnapshotStore).Assembly;
        Assembly shared = typeof(AuthoringWorkspaceSnapshotContract).Assembly;
        string commit = Assert.Single(server.GetCustomAttributes<AssemblyMetadataAttribute>(),
            static attribute => attribute.Key == "FsusBlog.SourceCommit").Value!;
        string expected = AuthoringWorkspaceSnapshotContract.Digest(new
        {
            SourceContract = AuthoringWorkspaceSnapshotContract.SourceContract,
            SchemaVersion = AuthoringWorkspaceSnapshotContract.SchemaVersion,
            ServerSourceCommit = commit,
            ServerArtifactDigest = ArtifactDigest(server),
            SharedArtifactDigest = ArtifactDigest(shared)
        });
        Assert.Equal(expected, new AuthoringWorkspaceSnapshotSourceIdentity().SourceDigest);
        Assert.NotEqual(expected, AuthoringWorkspaceSnapshotSourceIdentity.Compute(server, typeof(AuthoringWorkspaceSnapshotRuntimeRegistrationTests).Assembly));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("0000000000000000000000000000000000000000")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public void SourceIdentity_RefusesMissingOrUnstampedServer(string? commit)
    {
        Assembly server = DynamicAssembly(commit);
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            AuthoringWorkspaceSnapshotSourceIdentity.Compute(server, typeof(AuthoringWorkspaceSnapshotContract).Assembly));
        Assert.Equal("authoring_workspace_snapshot_build_source_identity_required", error.Message);
    }

    [Fact]
    public void SourceIdentity_RefusesDuplicateSourceMetadata()
    {
        Assembly server = DynamicAssembly(new string('a', 40), duplicate: true);
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            AuthoringWorkspaceSnapshotSourceIdentity.Compute(server, typeof(AuthoringWorkspaceSnapshotContract).Assembly));
        Assert.Equal("authoring_workspace_snapshot_build_source_identity_required", error.Message);
    }

    [Fact]
    public void SourceIdentity_RefusesMissingCompiledArtifact()
    {
        Assembly server = DynamicAssembly(new string('a', 40));
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            AuthoringWorkspaceSnapshotSourceIdentity.Compute(server, typeof(AuthoringWorkspaceSnapshotContract).Assembly));
        Assert.Equal("authoring_workspace_snapshot_build_artifact_required", error.Message);
    }

    private static Assembly DynamicAssembly(string? commit, bool duplicate = false)
    {
        AssemblyBuilder assembly = AssemblyBuilder.DefineDynamicAssembly(
            new AssemblyName($"WorkspaceSnapshotSourceIdentityControl{Guid.NewGuid():N}"), AssemblyBuilderAccess.Run);
        if (commit is not null)
        {
            var attribute = new CustomAttributeBuilder(
                typeof(AssemblyMetadataAttribute).GetConstructor([typeof(string), typeof(string)])!,
                ["FsusBlog.SourceCommit", commit]);
            assembly.SetCustomAttribute(attribute);
            if (duplicate)
            {
                assembly.SetCustomAttribute(attribute);
            }
        }
        return assembly;
    }

    private static string ArtifactDigest(Assembly assembly)
    {
        using FileStream stream = File.OpenRead(assembly.Location);
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }
}
