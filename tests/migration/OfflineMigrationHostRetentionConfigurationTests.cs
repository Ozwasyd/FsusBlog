using NSubstitute;
using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

// Constructor guards only: no fixture supplies real planning/toolchain or database proof.
public sealed class OfflineMigrationHostRetentionConfigurationTests
{
    [Theory]
    [InlineData("planning")]
    [InlineData("backupInputs")]
    [InlineData("artifacts")]
    [InlineData("currentSchema")]
    [InlineData("operations")]
    public async Task MissingOriginalPortRefusesBeforeToolOrNativeObservations(string missing)
    {
        var planning = Substitute.For<IOfflineMigrationPlanningAuthorityReader>();
        var artifacts = Substitute.For<IOfflineMigrationVerificationArtifactReader>();
        var current = Substitute.For<IOfflineMigrationCurrentSchemaObserver>();
        var operations = Substitute.For<IOfflineMigrationApplyOperationRegistry>();
        ArgumentNullException failure = await Assert.ThrowsAsync<ArgumentNullException>(() =>
            OfflineMigrationHostOwnedConfiguration.CreateRetainedAsync(
                missing == "planning" ? null! : planning,
                missing == "backupInputs" ? null! : Inputs(),
                missing == "artifacts" ? null! : artifacts,
                missing == "currentSchema" ? null! : current,
                missing == "operations" ? null! : operations,
                CancellationToken.None));
        Assert.Equal(missing, failure.ParamName);
        Assert.Empty(planning.ReceivedCalls());
        Assert.Empty(artifacts.ReceivedCalls());
        Assert.Empty(current.ReceivedCalls());
        Assert.Empty(operations.ReceivedCalls());
    }

    [Fact]
    public async Task CancellationRefusesBeforeReadingOwnedInputsOrCapturingBackup()
    {
        var planning = Substitute.For<IOfflineMigrationPlanningAuthorityReader>();
        var artifacts = Substitute.For<IOfflineMigrationVerificationArtifactReader>();
        var current = Substitute.For<IOfflineMigrationCurrentSchemaObserver>();
        var operations = Substitute.For<IOfflineMigrationApplyOperationRegistry>();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OfflineMigrationHostOwnedConfiguration.CreateRetainedAsync(planning, Inputs(), artifacts,
                current, operations, cancellation.Token));
        Assert.Empty(planning.ReceivedCalls());
        Assert.Empty(artifacts.ReceivedCalls());
        Assert.Empty(current.ReceivedCalls());
        Assert.Empty(operations.ReceivedCalls());
    }

    private static OfflineMigrationShellBackupDrillOwnedInputs Inputs()
    {
        var configuration = new OfflineMigrationShellBackupDrillConfiguration("/unused/repository", "/unused/bash",
            "/unused/setsid", "/unused/dotnet", "/unused/migration.dll", "/unused/identity", null,
            new Dictionary<string, string>(), 1, 1);
        var artifact = new CurrentSchemaArtifactReference("/unused/tool", new string('a', 64));
        return new(configuration, new(artifact, artifact, artifact, artifact, artifact, artifact, artifact),
            new(new(CurrentSchemaProviderKind.PostgreSql, "unused-instance", "unused-database"),
                "/unused/source.env", "/unused/restore.env", "/unused/package", "/unused/output", "/unused/plan"));
    }
}
