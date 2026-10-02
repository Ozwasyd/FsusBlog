using System.Security.Cryptography;

using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

/// <summary>
/// Real retained-file guards using synthetic tool bytes, not executable/backup evidence.
/// These fixtures never invoke the shell, read credentials or connect a database.
/// </summary>
public sealed class OfflineMigrationShellBackupDrillOwnedInputsTests
{
    [Fact]
    public async Task CompleteExplicitConfigurationHasAUsableOriginalInvocationBinding()
    {
        using var fixture = new InputsFixture();
        OfflineMigrationShellBackupDrillConfiguration configuration = await fixture.ResolveAsync();
        Assert.Same(fixture.Inputs, configuration.OwnedInputs);
        await fixture.VerifyAsync(configuration);
        Assert.False(Directory.Exists(fixture.PrivateRoot));
        Assert.False(File.Exists(fixture.PrivateRoot + ".invocation.stdout"));
    }

    [Theory]
    [InlineData("Backup")]
    [InlineData("Restore")]
    [InlineData("Drill")]
    [InlineData("Bash")]
    [InlineData("Session")]
    [InlineData("DotNet")]
    [InlineData("Migration")]
    public async Task EveryOriginalToolIsRecheckedAfterComposition(string role)
    {
        using var fixture = new InputsFixture();
        OfflineMigrationShellBackupDrillConfiguration configuration = await fixture.ResolveAsync();
        File.AppendAllText(fixture.ToolPaths[role], "changed");
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => fixture.VerifyAsync(configuration));
        Assert.Equal("offline_backup_tool_configuration_original_tool_bytes_changed", error.Message);
        Assert.False(Directory.Exists(fixture.PrivateRoot));
    }

    [Fact]
    public async Task ToolRoleMustReferToTheOriginalCanonicalScript()
    {
        using var fixture = new InputsFixture();
        var inputs = new OfflineMigrationShellBackupDrillOwnedInputs(fixture.Configuration,
            fixture.Tools with { Backup = fixture.Tools.Restore }, fixture.Scope);
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => inputs.CreateConfigurationAsync(default));
        Assert.Equal("offline_backup_tool_configuration_original_tool_identity_required", error.Message);
    }

    [Fact]
    public async Task MutableCallerEnvironmentCannotChangeTheOwnedConfiguration()
    {
        using var fixture = new InputsFixture();
        fixture.Environment["PATH"] = "changed-after-construction";
        OfflineMigrationShellBackupDrillConfiguration configuration = await fixture.ResolveAsync();
        Assert.Equal("/usr/bin:/bin", configuration.ExecutionEnvironment["PATH"]);
        await fixture.VerifyAsync(configuration);
    }

    [Fact]
    public async Task RecordCloneCannotCarryAnOldBindingToChangedCredentials()
    {
        using var fixture = new InputsFixture();
        OfflineMigrationShellBackupDrillConfiguration configuration = await fixture.ResolveAsync();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => fixture.VerifyAsync(configuration with { IdentityFile = fixture.Scope.BackupPackagePath }));
        Assert.Equal("offline_backup_tool_configuration_configuration_changed", error.Message);
    }

    [Fact]
    public async Task DifferentSourceIdentityOrPackageCannotReuseTheOwnedScope()
    {
        using var fixture = new InputsFixture();
        OfflineMigrationShellBackupDrillConfiguration configuration = await fixture.ResolveAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.VerifyAsync(configuration,
            fixture.Options with { ExpectedDatabase = fixture.Scope.ExpectedDatabase with { InstanceId = "other-instance" } }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.VerifyAsync(configuration,
            fixture.Options with { BackupPackagePath = fixture.Scope.EnvironmentFilePath }));
    }

    [Fact]
    public async Task EnvironmentPlanAndOutputPathsStayInTheExplicitScope()
    {
        using var fixture = new InputsFixture();
        OfflineMigrationShellBackupDrillConfiguration configuration = await fixture.ResolveAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.VerifyAsync(configuration,
            fixture.Options with { EnvironmentFilePath = fixture.Scope.RestoreEnvironmentFilePath }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.VerifyAsync(configuration,
            fixture.Options with { RestoreEnvironmentFilePath = fixture.Scope.EnvironmentFilePath }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.VerifyAsync(configuration,
            fixture.Options with { PlanOutputPath = Path.Combine(fixture.Root, "other-plan.json") }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Inputs.VerifyInvocationAsync(configuration,
            fixture.Options, Path.Combine(fixture.Root, "outside-output-parent"), default));
    }

    [Theory]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public async Task SourceObservationCapabilityDoesNotInventBackupCapability(CurrentSchemaProviderKind provider)
    {
        using var fixture = new InputsFixture();
        var inputs = new OfflineMigrationShellBackupDrillOwnedInputs(fixture.Configuration, fixture.Tools,
            fixture.Scope with { ExpectedDatabase = fixture.Scope.ExpectedDatabase with { Provider = provider } });
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => inputs.CreateConfigurationAsync(default));
        Assert.Equal("offline_backup_tool_configuration_provider_capture_capability_missing", error.Message);
    }

    [Fact]
    public async Task SymlinkToolReplacementIsRejectedRatherThanHashedThrough()
    {
        using var fixture = new InputsFixture();
        OfflineMigrationShellBackupDrillConfiguration configuration = await fixture.ResolveAsync();
        File.Delete(fixture.ToolPaths["Drill"]);
        File.CreateSymbolicLink(fixture.ToolPaths["Drill"], fixture.ToolPaths["Backup"]);
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.VerifyAsync(configuration));
    }

    [Fact]
    public async Task CompositionRefusesExecutionEnvironmentOverridesBeforeToolReads()
    {
        using var fixture = new InputsFixture();
        var inputs = new OfflineMigrationShellBackupDrillOwnedInputs(fixture.Configuration with
        {
            ExecutionEnvironment = new Dictionary<string, string> { ["FSUSBLOG_BACKUP_IDENTITY_FILE"] = "ambient" }
        }, fixture.Tools, fixture.Scope);
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => inputs.CreateConfigurationAsync(default));
        Assert.Equal("offline_backup_tool_configuration_execution_environment_override_refused", error.Message);
    }

    [Fact]
    public async Task OriginalSpentBudgetAndCallerCancellationDoNotBecomeANewToolBudget()
    {
        using var fixture = new InputsFixture();
        OfflineMigrationShellBackupDrillConfiguration configuration = await fixture.ResolveAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.VerifyAsync(configuration,
            fixture.Options with { OperationDeadline = null }));
        fixture.Clock.Seconds = 30;
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.VerifyAsync(configuration));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => fixture.Inputs.CreateConfigurationAsync(cancellation.Token));
        Assert.False(Directory.Exists(fixture.PrivateRoot));
    }

    private sealed class InputsFixture : IDisposable
    {
        internal string Root { get; } = Path.Combine(Path.GetTempPath(), "fsusblog-owned-tools-" + Guid.NewGuid().ToString("N"));
        internal string PrivateRoot { get; }
        internal Dictionary<string, string> Environment { get; } = new() { ["PATH"] = "/usr/bin:/bin" };
        internal Dictionary<string, string> ToolPaths { get; } = new(StringComparer.Ordinal);
        internal OfflineMigrationShellBackupDrillConfiguration Configuration { get; }
        internal OfflineMigrationShellBackupDrillTools Tools { get; }
        internal OfflineMigrationShellBackupDrillInputScope Scope { get; }
        internal OfflineMigrationShellBackupDrillOwnedInputs Inputs { get; }
        internal OfflineMigrationPlanCommandOptions Options { get; }
        internal FixtureClock Clock { get; } = new();

        internal InputsFixture()
        {
            Directory.CreateDirectory(Root);
            string repository = Path.Combine(Root, "repository");
            string operations = Path.Combine(repository, "tools", "operations");
            Directory.CreateDirectory(operations);
            ToolPaths["Backup"] = Path.Combine(operations, "backup-site.sh");
            ToolPaths["Restore"] = Path.Combine(operations, "restore-site.sh");
            ToolPaths["Drill"] = Path.Combine(operations, "backup-restore-drill.sh");
            foreach (string role in new[] { "Bash", "Session", "DotNet", "Migration" })
            {
                ToolPaths[role] = Path.Combine(Root, role);
            }
            foreach ((string role, string path) in ToolPaths)
            {
                File.WriteAllText(path, "synthetic non-executable " + role);
            }
            foreach (string role in new[] { "Bash", "Session", "DotNet" })
            {
                File.SetUnixFileMode(ToolPaths[role], UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
            string identity = WriteInput("identity-location");
            string sourceEnvironment = WriteInput("source.env");
            string restoreEnvironment = WriteInput("restore.env");
            string package = WriteInput("encrypted-package-placeholder");
            string outputParent = Path.Combine(Root, "outputs");
            Directory.CreateDirectory(outputParent);
            PrivateRoot = Path.Combine(outputParent, "new-invocation");
            Configuration = new(repository, ToolPaths["Bash"], ToolPaths["Session"], ToolPaths["DotNet"],
                ToolPaths["Migration"], identity, null, Environment, 2, 2);
            Tools = new(Artifact("Backup"), Artifact("Restore"), Artifact("Drill"), Artifact("Bash"),
                Artifact("Session"), Artifact("DotNet"), Artifact("Migration"));
            Scope = new(new(CurrentSchemaProviderKind.PostgreSql, "actual-instance-placeholder", "actual-db-placeholder"),
                sourceEnvironment, restoreEnvironment, package, outputParent, Path.Combine(outputParent, "plan.json"));
            Inputs = new(Configuration, Tools, Scope);
            Options = new(Scope.ExpectedDatabase, sourceEnvironment, package, Path.Combine(PrivateRoot, "package-manifest.json"),
                Path.Combine(PrivateRoot, "backup-restore-drill.json"), restoreEnvironment, Scope.PlanOutputPath, 30)
            {
                OperationDeadline = new(Clock, 30)
            };
        }

        internal Task<OfflineMigrationShellBackupDrillConfiguration> ResolveAsync()
            => Inputs.CreateConfigurationAsync(default);

        internal Task VerifyAsync(OfflineMigrationShellBackupDrillConfiguration configuration,
            OfflineMigrationPlanCommandOptions? options = null)
            => Inputs.VerifyInvocationAsync(configuration, options ?? Options, PrivateRoot, default);

        private CurrentSchemaArtifactReference Artifact(string role)
            => new(ToolPaths[role], Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(ToolPaths[role]))));

        private string WriteInput(string name)
        {
            string path = Path.Combine(Root, name);
            File.WriteAllText(path, "synthetic location, not a credential");
            return path;
        }

        public void Dispose() => Directory.Delete(Root, recursive: true);
    }

    private sealed class FixtureClock : TimeProvider
    {
        internal long Seconds { get; set; }
        public override long TimestampFrequency => 1;
        public override long GetTimestamp() => Seconds;
    }
}
